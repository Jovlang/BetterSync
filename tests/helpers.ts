import {hash} from '../src/paths';
import {freshState,StateStore} from '../src/local-state';
import {SyncEngine} from '../src/sync-engine';
import {SyncFailure,type Remote,type FileDocument,type RemoteChanges,type Sequence,type VaultClient,type LocalSyncState,type SyncStatus} from '../src/types';
export class MemoryRemote implements Remote {
  docs=new Map<string,FileDocument>(); seq=0; offline=false;
  history:{seq:number;id:string;doc:FileDocument}[]=[];
  beforePut?:()=>Promise<void>;
  check(){if(this.offline) throw new SyncFailure('temporary','Offline');}
  async testConnection(){this.check();}
  async getDocument(path:string){this.check();return structuredClone(this.docs.get(path)??null);}
  async putDocument(doc:FileDocument):Promise<FileDocument>{
    this.check();if(this.beforePut){const f=this.beforePut;this.beforePut=undefined;await f();}
    const current=this.docs.get(doc.path);
    if(current?._rev!==doc._rev) throw new SyncFailure('conflict','Changed');
    const saved={...doc,_rev:`${++this.seq}-server`};this.docs.set(doc.path,saved);
    this.history.push({seq:this.seq,id:saved._id,doc:structuredClone(saved)});return saved;
  }
  deleteDocument(doc:FileDocument){return this.putDocument({...doc,deleted:true,content:''});}
  async getChanges(since:Sequence):Promise<RemoteChanges>{
    this.check();const last=new Map<string,typeof this.history[number]>();
    for(const h of this.history) if(h.seq>Number(since)) last.set(h.id,h);
    const results=[...last.values()].sort((a,b)=>a.seq-b.seq).slice(0,200);
    return {results:structuredClone(results),last_seq:results.at(-1)?.seq??this.seq};
  }
}
export class MemoryVault implements VaultClient {
  files=new Map<string,string>();onChange?:(path:string)=>Promise<void>;
  beforeCAS?:()=>Promise<void>; failPath?:string;
  listFiles(){return [...this.files.keys()];}
  async read(path:string){return this.files.get(path)??null;}
  async create(path:string,content:string){if(this.files.has(path)) throw new Error('Exists');this.files.set(path,content);await this.onChange?.(path);}
  async edit(path:string,content:string|null){if(content===null)this.files.delete(path);else this.files.set(path,content);await this.onChange?.(path);}
  async compareAndSet(path:string,expected:string|null,content:string|null){
    if(this.failPath===path)throw new Error('Write failure');
    if(this.beforeCAS){const f=this.beforeCAS;this.beforeCAS=undefined;await f();}
    if(hash(await this.read(path))!==expected)return false;
    await this.edit(path,content);return true;
  }
}
export class Device {
  vault=new MemoryVault();engine!:SyncEngine;store!:StateStore;
  disk!:LocalSyncState;status:SyncStatus='Synced';notices:string[]=[];
  choice:'upload'|'download'|'cancel'|undefined; saveFailure=false;
  constructor(public remote:Remote){this.disk=freshState('test');this.reboot();}
  reboot(){
    this.store=new StateStore(structuredClone(this.disk),async s=>{if(this.saveFailure)throw new Error('Disk full');this.disk=structuredClone(s);});
    this.engine=new SyncEngine(this.vault,this.remote,this.store,{
      status:s=>this.status=s,notice:m=>this.notices.push(m),log:()=>{},confirm:async d=>this.choice??d
    });this.vault.onChange=p=>this.engine.changed(p);
  }
  start(){return this.engine.start();}
  tick(){return this.engine.tick();}
  async restart(){await this.engine.stop();this.reboot();await this.start();}
}
export async function three(){const remote=new MemoryRemote();const a=new Device(remote),b=new Device(remote),c=new Device(remote);await a.start();await b.start();await c.start();return {remote,a,b,c};}
export async function settle(...devices:Device[]){for(let i=0;i<4;i++)for(const d of devices)await d.tick();}
