import {PersistenceFailure} from './local-state';
import {PendingTransferFailure, SyncFailure, type TransferAttempt} from './types';

export type ActivityDirection = 'upload' | 'download' | 'apply';
type Work = {path: string; direction: ActivityDirection; applying?: boolean; checking?: boolean; deleting?: boolean; percent?: number};
export type ActivityEvent =
  | ({type:'start'} & Work)
  | {type:'stage';path:string}
  | {type:'send';path:string;deleted:boolean}
  | {type:'progress';path:string;done:number;total:number}
  | ({type:'end';completed?:boolean;failure?:string;pending?:boolean} & Work)
  | {type:'issue';scope:'setup'|'cycle'|'records';failure?:string};

export function activityFailure(error:unknown, attempt?:TransferAttempt):string {
  const cause=error instanceof Error && error.cause!==undefined ? error.cause : error;
  if(cause instanceof Error && cause.message==='File exceeds 200 MiB.') return 'File exceeds the 200 MiB sync limit. It stays on this device.';
  if(attempt?.paused) return attempt.reason==='interrupted'
    ? 'Transfer interrupted. Select Retry to resume.'
    : 'Transfer paused after repeated failures. Select Retry to try again.';
  if(error instanceof PersistenceFailure) return 'Could not save sync progress. Check available storage, then select Retry.';
  if(cause instanceof PendingTransferFailure) return 'The transfer timed out. BetterSync will try again.';
  if(cause instanceof SyncFailure && cause.kind==='temporary') return 'Could not reach the sync server. BetterSync will try again.';
  if(cause instanceof SyncFailure && cause.kind==='configuration') return 'Sync needs attention. Check the connection and setup, then select Retry.';
  const code=cause && typeof cause==='object' && 'code' in cause ? cause.code : undefined;
  if(code==='ENOSPC') return 'This device is out of storage. Free space, then select Retry.';
  if(code==='EACCES'||code==='EPERM') return 'This device denied access. Check file permissions, then select Retry.';
  if(code==='EBUSY') return 'The file or folder is in use. BetterSync will try again.';
  return 'The change could not be synced. BetterSync will try again.';
}

export function activityLabel(work:Work):string {
  if(work.checking)return 'Checking: '+work.path;
  if(work.deleting)return 'Send deletion: '+work.path;
  const direction=work.applying?'apply':work.direction;
  return ({upload:'Upload',download:'Download',apply:'Apply change'})[direction]+': '+work.path;
}

type Issue = {label:string;failure:string};
type History = {at:number;label:string;failure?:string};
const scopes = {setup:'Sync setup',cycle:'Sync check',records:'Incoming changes'};

/** In-memory only: paths and activity are never persisted, synced or sent to console logs. */
export class SyncActivity {
  readonly active:Work[]=[];
  readonly failures=new Map<string,Issue>();
  readonly recent:History[]=[];
  revision=0;
  constructor(private now=Date.now,private historyLimit=50) {}
  private remember(label:string,failure?:string) {
    this.recent.unshift({at:this.now(),label,failure});
    this.recent.length=Math.min(this.recent.length,this.historyLimit);
  }
  private issue(key:string,label:string,failure?:string) {
    if(!failure) {if(this.failures.delete(key))this.revision++;return;}
    if(this.failures.get(key)?.failure===failure)return;
    this.failures.set(key,{label,failure});
    this.remember(label,failure);
    this.revision++;
  }
  accept(event:ActivityEvent) {
    if(event.type==='issue') {this.issue(event.scope,scopes[event.scope],event.failure);return;}
    if(event.type==='start') {
      this.active.push({path:event.path,direction:event.direction,checking:event.checking});
      this.revision++;return;
    }
    let index=this.active.length-1;
    for(;index>=0;index--) {
      const candidate=this.active[index]!;
      if(candidate.path===event.path&&(event.type!=='end'||candidate.direction===event.direction)
        &&(event.type!=='send'||candidate.direction==='upload'))break;
    }
    const work=this.active[index];
    if(event.type==='end') {
      if(work) {this.active.splice(index,1);this.revision++;}
      const key=event.direction+'\0'+event.path;
      const label=activityLabel(work??event);
      if(event.failure) this.issue(key,label,event.failure);
      else if(!event.pending) {
        this.issue(key,label);
        if(event.completed) {this.remember(label);this.revision++;}
      }
    } else if(work && event.type==='send' && (work.checking||work.deleting!==event.deleted)) {
      work.checking=false;work.deleting=event.deleted;this.revision++;
    } else if(work && event.type==='stage' && work.direction==='download' && !work.applying) {
      work.applying=true;this.revision++;
    } else if(work && event.type==='progress' && event.total>0) {
      const percent=Math.floor(Math.max(0,Math.min(100,event.done/event.total*100)));
      if(work.percent!==percent) {work.percent=percent;this.revision++;}
    }
  }
}
