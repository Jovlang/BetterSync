import type {LocalSyncState} from './types';
import {hash} from './paths';

export type StateReference=Pick<LocalSyncState,'clientId'|'binding'>;
type Storage={
  exists(path:string):Promise<boolean>;
  read(path:string):Promise<string>;
  write(path:string,data:string):Promise<void>;
};
export class StateRecoveryRequired extends Error {}
type Snapshot={generation:number;state:LocalSyncState;raw:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const identity=(v:unknown):v is string=>typeof v==='string'&&v.length>0;
const matches=(a:StateReference,b:StateReference)=>a.binding===b.binding&&a.clientId===b.clientId;
export function stateReference({binding,clientId}:StateReference):StateReference {return {binding,clientId};}
export function validState(v:unknown):v is LocalSyncState {
  return object(v)&&v.version===1&&identity(v.binding)&&identity(v.clientId)&&typeof v.initialized==='boolean'
    &&(v.setup===undefined||v.setup==='upload'||v.setup==='download')
    &&(typeof v.lastSequence==='string'||Number.isFinite(v.lastSequence))
    &&object(v.files)&&Object.values(v.files).every(b=>object(b)&&identity(b.rev)&&(b.hash===null||typeof b.hash==='string'))
    &&object(v.incoming)&&Object.values(v.incoming).every(i=>object(i)&&object(i.doc)&&(i.expected===null||typeof i.expected==='string'))
    &&['outgoing','transfers','rejected'].every(k=>v[k]===undefined||object(v[k]));
}
const fresh=(s:LocalSyncState)=>!s.initialized&&!s.setup&&s.lastSequence===0
  &&[s.files,s.incoming,s.outgoing,s.transfers,s.rejected].every(map=>!map||Object.keys(map).length===0);

function decode(raw:string):Snapshot|null {
  try {
    const {format,generation,state,digest}=JSON.parse(raw);
    if(format!==1||!Number.isSafeInteger(generation)||generation<1||!validState(state)
      ||digest!==hash(JSON.stringify([generation,state])))return null;
    return {generation,state,raw};
  }catch{return null;}
}

/** Portable Obsidian adapters do not promise atomic replacement or fsync.
 * Keep a verified previous generation before touching the primary. Never
 * replay a potentially stale backup automatically: the vault or server may
 * already reflect operations the backup does not contain. StateStore is the
 * sole writer while the engine runs; startup/migration run before it starts. */
export class StateFiles {
  private readonly primary:string;
  private readonly backup:string;
  private current?:Snapshot;
  private backedUp?:string;
  constructor(private adapter:Storage,dir:string) {
    this.primary=dir+'/sync-state.json';
    this.backup=dir+'/sync-state.backup.json';
  }
  async hasArtifacts():Promise<boolean> {
    return await this.adapter.exists(this.primary)||await this.adapter.exists(this.backup);
  }
  private async inspect(path:string) {
    if(!await this.adapter.exists(path))return {exists:false,snapshot:null};
    return {exists:true,snapshot:decode(await this.adapter.read(path))};
  }
  private async verifiedWrite(path:string,raw:string) {
    await this.adapter.write(path,raw);
    if(await this.adapter.read(path)!==raw)throw new Error('Sync progress could not be verified after writing.');
  }
  async load(ref?:StateReference):Promise<LocalSyncState|undefined> {
    this.current=undefined;this.backedUp=undefined;
    if(ref!==undefined&&(!ref||!identity(ref.binding)||!identity(ref.clientId)))throw new StateRecoveryRequired('Sync paused: the local progress reference is invalid.');
    const {exists,snapshot}=await this.inspect(this.primary).catch(()=>{throw new StateRecoveryRequired('Sync paused: could not read saved progress. Check local storage and retry.');});
    // A damaged or temporarily unreadable backup must not hide a valid primary.
    const backup=await this.inspect(this.backup).catch(()=>({exists:true,snapshot:null}));
    const prior=backup.snapshot;
    if(snapshot&&(
      ref ? matches(snapshot.state,ref)
        && (!prior || !matches(prior.state,ref) || prior.generation<snapshot.generation
          || (prior.generation===snapshot.generation&&prior.raw===snapshot.raw))
        // A crash before writing the configuration reference can only leave a
        // pristine snapshot here; no engine has been allowed to use it yet.
        : snapshot.generation===1&&!backup.exists&&fresh(snapshot.state)
    )){
      this.current=snapshot;
      return snapshot.state;
    }
    if(!ref&&!exists&&!backup.exists)return undefined;
    throw new StateRecoveryRequired(ref&&prior&&matches(prior.state,ref)
      ? 'Sync paused: saved progress is missing or damaged. An older backup is available; keep both files for recovery.'
      : 'Sync paused: saved progress is missing, damaged, or belongs to another installation.');
  }
  async migrate(state:LocalSyncState):Promise<void> {
    // While the legacy copy is still in data.json it is authoritative. A
    // crash here leaves it intact and a restart can repeat the migration.
    this.current=undefined;this.backedUp=undefined;
    await this.save(state);
  }
  async save(state:LocalSyncState):Promise<void> {
    const previous=this.current;
    if(!validState(state)||(previous&&!matches(previous.state,state)))throw new Error('Invalid sync progress.');
    const generation=(previous?.generation??0)+1;
    if(!Number.isSafeInteger(generation))throw new Error('Sync progress generation exhausted.');
    const raw=JSON.stringify({format:1,generation,state,digest:hash(JSON.stringify([generation,state]))});
    const snapshot=decode(raw);
    if(!snapshot)throw new Error('Could not encode sync progress.');
    if(previous&&this.backedUp!==previous.raw) {
      await this.verifiedWrite(this.backup,previous.raw);
      // If the primary write tears, retry must not rewrite the only good copy.
      this.backedUp=previous.raw;
    }
    await this.verifiedWrite(this.primary,raw);
    // Do not alias the engine's mutable in-memory state.
    this.current=snapshot;
  }
}
