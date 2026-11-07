import assert from 'node:assert/strict';
import {createConfiguration,generateRecoveryCode,importRecoveryCode,CONFIGURATION_ID} from '../src/encryption-setup';
import {EncryptedRemote} from '../src/encrypted-remote';
import {CouchConfiguration} from '../src/couch-configuration';
import {diskHost} from './encrypted-filesystem';
import {SyncEngine} from '../src/sync-engine';
import {freshState,StateStore} from '../src/local-state';
import {syncPath} from '../src/paths';
import type {Http,Connection} from '../src/couch-client';
import type {LocalSyncState,SyncStatus} from '../src/types';
export const connection={url:'https://schema5.invalid',database:'synthetic',username:'synthetic',password:'synthetic'};
type Doc={_id:string;_rev?:string;[key:string]:unknown};
export class Schema5Wire {
  records=new Map<string,Doc>();versions=new Map<string,Doc>();history=new Map<string,{id:string;seq:number;changes:{rev:string}[]}>();seq=0;
  offline=false;loseChunk=false;loseManifest=false;deny='';maxBody=0;chunkPuts=0;manifestPuts=0;feedChunkBodies=0;
  beforePut?:(doc:Doc)=>Promise<void>;afterPut?:(doc:Doc)=>Promise<void>;
  http:Http=async(url,method,headers,body)=>{
    if(this.offline)throw new Error('offline');const u=new URL(url),id=decodeURIComponent(u.pathname.split('/').at(-1)!);
    assert.equal(body instanceof ArrayBuffer,false,'schema 5 never sends full multipart or raw file bodies');
    const value=body?JSON.parse(body as string):undefined;
    this.maxBody=Math.max(this.maxBody,typeof body==='string'?Buffer.byteLength(body):0);
    if(id==='_all_docs') {
      return {status:200,json:{rows:value.keys.map((key:string)=>{const doc=this.records.get(key);return doc?{id:key,key,value:{rev:doc._rev},doc}: {key,error:'not_found'};})}};
    }
    if(id==='_bulk_get')return {status:200,json:{results:value.docs.map((d:{id:string;rev:string})=>({id:d.id,docs:[this.versions.has(d.id+'@'+d.rev)?{ok:this.versions.get(d.id+'@'+d.rev)}:{error:'not_found'}]}))}};
    if(id==='_changes') {
      assert.equal(u.searchParams.get('include_docs'),'false');
      const rows=[...this.history.values()].filter(x=>x.seq>Number(u.searchParams.get('since'))).sort((a,b)=>a.seq-b.seq).slice(0,200);
      return {status:200,json:{results:rows,last_seq:rows.at(-1)?.seq??this.seq}};
    }
    if(method==='GET'&&id==='synthetic')return {status:200,json:{doc_count:this.records.size,doc_del_count:0}};
    assert.equal(method,'PUT');const doc=value as Doc;assert.equal(id,doc._id);
    await this.beforePut?.(doc);if(this.deny&&id===this.deny)return {status:400};
    const old=this.records.get(id);if(old?._rev!==doc._rev)return {status:409};
    const rev=`${old?Number(old._rev!.split('-')[0])+1:1}-saved`,saved={...doc,_rev:rev};
    this.records.set(id,saved);this.versions.set(id+'@'+rev,structuredClone(saved));this.history.set(id,{id,seq:++this.seq,changes:[{rev}]});
    if(id.startsWith('c5:'))this.chunkPuts++;if(id.startsWith('f5:'))this.manifestPuts++;
    await this.afterPut?.(saved);
    if(id.startsWith('c5:')&&this.loseChunk){this.loseChunk=false;throw new Error('lost acknowledgement');}
    if(id.startsWith('f5:')&&this.loseManifest){this.loseManifest=false;throw new Error('lost acknowledgement');}
    return {status:201,json:{ok:true,id,rev}};
  };
}
export async function fixture() {
  const code=generateRecoveryCode(),key=await importRecoveryCode(code),wire=new Schema5Wire();
  await new CouchConfiguration(connection,wire.http).createConfiguration(await createConfiguration(key));
  return {code,key,wire,remote:()=>EncryptedRemote.connect(connection,wire.http,key,syncPath)};
}
export async function device(remote:EncryptedRemote) {
  const host=await diskHost();let disk=freshState(remote.stateBinding),engine:SyncEngine,status:SyncStatus='Synced';
  let failSave:((state:LocalSyncState)=>boolean)|undefined;const logs:string[]=[],notices:string[]=[];
  const boot=()=>{engine=new SyncEngine(host.vault,remote,new StateStore(structuredClone(disk),async s=>{
    if(failSave?.(s))throw new Error('simulated durable write failure');disk=structuredClone(s);
  }),{status:s=>{status=s;},notice:s=>notices.push(s),log:s=>logs.push(s),confirm:async d=>d});};boot();
  return {host,remote,logs,notices,get disk(){return disk;},get engine(){return engine;},get status(){return status;},
    failSave:(f:typeof failSave)=>{failSave=f;},restart:async()=>{await engine.stop();boot();await engine.start();},
    close:async()=>{await engine.stop();await host.cleanup();}};
}
export async function settle(...devices:Awaited<ReturnType<typeof device>>[]) {for(let i=0;i<3;i++)for(const d of devices)await d.engine.tick();}
export async function provision(c:Connection,http:Http) {
  const key=await importRecoveryCode(generateRecoveryCode());
  await new CouchConfiguration(c,http).createConfiguration(await createConfiguration(key));
  return ()=>EncryptedRemote.connect(c,http,key,syncPath);
}
