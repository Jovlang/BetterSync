import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import type {App} from 'obsidian';
import type {ObsidianVault as VaultAdapter} from '../src/vault-client';
import {freshState,StateStore} from '../src/local-state';
import {SyncEngine} from '../src/sync-engine';
import {hash} from '../src/paths';
import type {SyncStatus} from '../src/types';
import {MemoryRemote} from './helpers';

const bundle=await build({entryPoints:['src/vault-client.ts'],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{
  name:'obsidian-host',setup(builder){
    builder.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'host'}));
    builder.onLoad({filter:/.*/,namespace:'host'},()=>({contents:'export class TFile{};export class MarkdownView{};'}));
  }
}]});
const {ObsidianVault}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0]!.text).toString('base64')) as {
  ObsidianVault:new(app:App)=>VaultAdapter;
};

// Model actual filesystem type/parent constraints and the documented no-overwrite
// copy contract. Hooks inject edits or crashes at filesystem operation boundaries.
class Filesystem {
  entries=new Map<string,ArrayBuffer|null>([['',null]]);
  revision=0;
  crashed=false;
  beforeRename?:()=>void;
  afterRename?:()=>void;
  beforeCopy?: (from:string,to:string)=>void;
  afterCopy?: (from:string,to:string)=>void;
  beforeProcess?:()=>void;
  edit(path:string,value:number[]|null){this.entries.set(path,value===null?null:Uint8Array.from(value).buffer);this.revision++;}
  bytes(path:string):ArrayBuffer {
    this.check();
    const value=this.entries.get(path);
    if(!value)throw new Error('Not a file');
    return value;
  }
  parent(path:string){
    const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
    if(this.entries.get(parent)!==null)throw new Error('Missing parent');
  }
  check(){if(this.crashed)throw new Error('Filesystem unavailable until restart');}
  adapter={
    stat:async(path:string)=>{this.check();return this.entries.has(path)?{type:this.entries.get(path)===null?'folder':'file',size:this.entries.get(path)?.byteLength??0,mtime:this.revision}:null;},
    exists:async(path:string)=>{this.check();return this.entries.has(path);},
    list:async(path:string)=>{
      this.check();
      if(this.entries.get(path)!==null)throw new Error('Not a folder');
      const prefix=path?path+'/':'';
      const children=[...this.entries.keys()].filter(p=>p!==path && p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
      return {files:children.filter(p=>this.entries.get(p)!==null),folders:children.filter(p=>this.entries.get(p)===null)};
    },
    mkdir:async(path:string)=>{this.parent(path);if(this.entries.has(path))throw new Error('Exists');this.edit(path,null);},
    readBinary:async(path:string)=>this.bytes(path).slice(0),
    read:async(path:string)=>new TextDecoder().decode(this.bytes(path)),
    writeBinary:async(path:string,value:ArrayBuffer)=>{this.parent(path);this.entries.set(path,value.slice(0));this.revision++;},
    write:async(path:string,value:string)=>{this.parent(path);this.entries.set(path,new TextEncoder().encode(value).buffer);this.revision++;},
    process:async(path:string,update:(value:string)=>string)=>{
      const hook=this.beforeProcess;this.beforeProcess=undefined;hook?.();
      const value=update(new TextDecoder().decode(this.bytes(path)));
      this.entries.set(path,new TextEncoder().encode(value).buffer);this.revision++;return value;
    },
    copy:async(from:string,to:string)=>{
      this.beforeCopy?.(from,to);
      this.parent(to);if(this.entries.has(to))throw new Error('Exists');
      this.entries.set(to,this.bytes(from).slice(0));this.revision++;
      this.afterCopy?.(from,to);
    },
    rename:async(from:string,to:string)=>{
      const before=this.beforeRename;this.beforeRename=undefined;before?.();
      this.parent(to);if(this.entries.has(to))throw new Error('Exists');
      this.entries.set(to,this.bytes(from));this.entries.delete(from);this.revision++;
      const after=this.afterRename;this.afterRename=undefined;after?.();
    },
    remove:async(path:string)=>{this.entries.delete(path);this.revision++;},
    rmdir:async(path:string)=>{
      if([...this.entries.keys()].some(p=>p.startsWith(path+'/')))throw new Error('Not empty');
      this.entries.delete(path);this.revision++;
    },
    trashLocal:async(path:string)=>{this.entries.delete(path);this.revision++;}
  };
}
class Client {
  fs=new Filesystem();
  disk=freshState('test');
  store!:StateStore;
  vault!:VaultAdapter;
  engine!:SyncEngine;
  status:SyncStatus='Synced';
  constructor(readonly remote:MemoryRemote){this.reboot();}
  reboot(){
    this.vault=new ObsidianVault({vault:{adapter:this.fs.adapter,getAbstractFileByPath:()=>null}} as unknown as App);
    this.store=new StateStore(JSON.parse(JSON.stringify(this.disk)),async state=>{this.disk=JSON.parse(JSON.stringify(state));});
    this.engine=new SyncEngine(this.vault,this.remote,this.store,{status:s=>this.status=s,notice:()=>{},log:()=>{},confirm:async d=>d});
  }
  async restart(){await this.engine.stop();this.fs.crashed=false;this.reboot();await this.engine.start();}
}
async function clients(){
  const remote=new MemoryRemote(),a=new Client(remote),b=new Client(remote),c=new Client(remote);
  for(const d of [a,b,c])await d.engine.start();
  return {remote,a,b,c};
}
async function settle(...devices:Client[]){for(let n=0;n<6;n++)for(const d of devices)await d.engine.tick();}

for(const direction of ['directory-to-file','file-to-directory'])test(`${direction} converges through offline replacement and restart`,async()=>{
  const {remote,a,b,c}=await clients();
  const wasDirectory=direction==='directory-to-file';
  a.fs.edit('item',wasDirectory?null:[1]);await settle(a,b,c);
  // B is offline while A replaces the object. C applies the transition live.
  a.fs.edit('item',wasDirectory?[2]:null);
  await a.restart();await settle(a,c);await b.restart();await settle(a,b,c);
  const oldPath=wasDirectory?'item/':'item',newPath=wasDirectory?'item':'item/';
  assert.equal(remote.docs.get(oldPath)?.deleted,true);
  assert.equal(remote.docs.get(newPath)?.deleted,false);
  for(const d of [a,b,c]) {
    assert.equal(await d.vault.read(oldPath),null);
    assert.equal(await d.vault.read(newPath),wasDirectory?'Ag==':'directory');
    assert.deepEqual(Object.keys(d.disk.incoming),[]);
    assert.equal(d.status,'Synced');
  }
});

for(const moment of ['before-move','before-install','after-move-crash','after-install-crash','after-move-crash-remote-present'])test(`binary race recovery ${moment} preserves bytes across three clients`,async()=>{
  const {a,b,c}=await clients();
  a.fs.edit('file.bin',[1]);await settle(a,b,c);
  a.fs.edit('file.bin',[2]);await settle(a,c);
  if(moment==='before-move' || moment.startsWith('after-move-crash'))b.fs.beforeRename=()=>b.fs.edit('file.bin',[9]);
  if(moment.startsWith('after-move-crash'))b.fs.afterRename=()=>{b.fs.crashed=true;throw new Error('Crash after move');};
  if(moment==='before-install')b.fs.beforeCopy=(_from,to)=>{
    if(to==='file.bin'){b.fs.beforeCopy=undefined;b.fs.edit('file.bin',[9]);}
  };
  if(moment==='after-install-crash')b.fs.afterCopy=(_from,to)=>{
    if(to==='file.bin'){b.fs.afterCopy=undefined;b.fs.edit('file.bin',[9]);b.fs.crashed=true;throw new Error('Crash after install');}
  };
  await b.engine.tick();
  if(moment.includes('crash')) {
    assert.ok(b.disk.incoming['file.bin']);
    assert.ok(b.fs.entries.has('.trash/bettersync/'+hash('file.bin')));
  }
  if(moment==='after-move-crash-remote-present')b.fs.edit('file.bin',[2]);
  await b.restart();await settle(a,b,c);
  for(const d of [a,b,c]) {
    assert.equal(await d.vault.read('file.bin'),'Ag==');
    const copies=(await d.vault.listFiles()).filter(p=>p.includes('.sync-conflict-'));
    assert.equal(copies.length,1);
    assert.equal(await d.vault.read(copies[0]!),'CQ==');
    assert.deepEqual(Object.keys(d.disk.incoming),[]);
    assert.equal(d.fs.entries.has('.trash/bettersync/'+hash('file.bin')),false);
  }
});

test('hidden Markdown checks the current contents inside atomic adapter.process',async()=>{
  const {a,b,c}=await clients();
  const path='.hidden.md';
  a.fs.edit(path,[65]);await settle(a,b,c);
  a.fs.edit(path,[66]);await settle(a,c);
  b.fs.beforeProcess=()=>b.fs.edit(path,[67]);
  await b.engine.tick();await settle(a,b,c);
  for(const d of [a,b,c]) {
    assert.equal(await d.vault.read(path),'B');
    const copies=(await d.vault.listFiles()).filter(p=>p.includes('.sync-conflict-'));
    assert.equal(copies.length,1);assert.equal(await d.vault.read(copies[0]!),'C');
  }
});

test('new binary creation refuses a concurrent local file',async()=>{
  const {a,b,c}=await clients();
  a.fs.edit('new.bin',[2]);await settle(a,c);
  b.fs.beforeCopy=(_from,to)=>{if(to==='new.bin'){b.fs.beforeCopy=undefined;b.fs.edit('new.bin',[9]);}};
  await settle(a,b,c);
  for(const d of [a,b,c]) {
    assert.equal(await d.vault.read('new.bin'),'Ag==');
    const copies=(await d.vault.listFiles()).filter(p=>p.includes('.sync-conflict-'));
    assert.equal(copies.length,1);assert.equal(await d.vault.read(copies[0]!),'CQ==');
  }
});
