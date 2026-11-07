/** Synthetic disk-backed host for the real ObsidianVault and encrypted engine. */
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, readFile, writeFile, appendFile, stat, copyFile, rm, rename, utimes} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {build} from 'esbuild';
import type {App} from 'obsidian';
import type {ObsidianVault} from '../src/vault-client';
import {EncryptedRemote} from '../src/legacy/encrypted-remote';
import {freshState, StateStore} from '../src/local-state';
import {SyncEngine} from '../src/sync-engine';
import type {LocalSyncState, SyncStatus} from '../src/types';

export async function diskHost() {
  const bundle=await build({entryPoints:['src/vault-client.ts'],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{
    name:'synthetic-host',setup(b){
      b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));
      b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export class TFile{};export class MarkdownView{};'}));
    }
  }]});
  const Host=(await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0]!.text).toString('base64'))).ObsidianVault as new(app:App)=>ObsidianVault;
  const root=await mkdtemp(join(tmpdir(),'bettersync-synthetic-'));
  const operations:{kind:string;path:string}[]=[];
  let failBinaryCreate=false;
  const adapter={
    stat:async(p:string)=>{try{const s=await stat(join(root,p));return {type:s.isDirectory()?'folder':'file',size:s.size,mtime:s.mtimeMs};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}},
    exists:async(p:string)=>!!await adapter.stat(p),
    list:async(p:string)=>{const entries=await readdir(join(root,p),{withFileTypes:true});return {
      files:entries.filter(e=>e.isFile()).map(e=>p?p+'/'+e.name:e.name),
      folders:entries.filter(e=>e.isDirectory()).map(e=>p?p+'/'+e.name:e.name)};},
    mkdir:async(p:string)=>{operations.push({kind:'mkdir',path:p});await mkdir(join(root,p));},
    read:async(p:string)=>readFile(join(root,p),'utf8'),
    readBinary:async(p:string)=>new Uint8Array(await readFile(join(root,p))).buffer,
    write:async(p:string,data:string)=>{operations.push({kind:'write',path:p});await writeFile(join(root,p),data);},
    writeBinary:async(p:string,data:ArrayBuffer)=>{operations.push({kind:'writeBinary',path:p});await writeFile(join(root,p),new Uint8Array(data));},
    appendBinary:async(p:string,data:ArrayBuffer,options?:{mtime?:number})=>{operations.push({kind:'appendBinary',path:p});await appendFile(join(root,p),new Uint8Array(data));if(options?.mtime!==undefined)await utimes(join(root,p),new Date(),new Date(options.mtime));},
    copy:async(from:string,to:string)=>{operations.push({kind:'copy',path:to});if(failBinaryCreate)throw Object.assign(new Error('private synthetic payload must not be logged'),{code:'EBUSY'});await copyFile(join(root,from),join(root,to),constants.COPYFILE_EXCL);},
    remove:async(p:string)=>rm(join(root,p)),
    trashLocal:async(p:string)=>{const dir=join(root,'.trash','synthetic-trash');await mkdir(dir,{recursive:true});await rename(join(root,p),join(dir,Date.now()+'-'+Math.random().toString(16).slice(2)));},
    rmdir:async(p:string)=>rm(join(root,p),{recursive:true}),
    rename:async(from:string,to:string)=>rename(join(root,from),join(root,to)),
    process:async(p:string,update:(current:string)=>string)=>{const next=update(await adapter.read(p));await adapter.write(p,next);return next;}
  };
  const createFile=async(p:string,data:string|Uint8Array,options?:{mtime?:number})=>{
    operations.push({kind:'create',path:p});
    if(failBinaryCreate && typeof data!=='string')throw Object.assign(new Error('private synthetic payload must not be logged'),{code:'EBUSY'});
    const target=join(root,p);
    await writeFile(target,data,{flag:'wx'});
    if(options?.mtime!==undefined)await utimes(target,new Date(),new Date(options.mtime));
  };
  const vault=new Host({vault:{adapter,configDir:'.obsidian',getAbstractFileByPath:()=>null,
    create:createFile,createBinary:(p:string,data:ArrayBuffer,options?:{mtime?:number})=>createFile(p,new Uint8Array(data),options)},workspace:{getLeavesOfType:()=>[]}} as unknown as App);
  return {root,vault,adapter,operations,setFailBinaryCreate:(value:boolean)=>{failBinaryCreate=value;},
    seed:async(p:string,bytes:Uint8Array)=>{await mkdir(dirname(join(root,p)),{recursive:true});await writeFile(join(root,p),bytes);},
    cleanup:()=>rm(root,{recursive:true,force:true})};
}

/** No extension-specific handling: fixtures exercise both representations and parents. */
export async function freshEncryptedTree(remote:()=>Promise<EncryptedRemote>, interrupt:false|'poll'|'restart'=false) {
  const source=await diskHost(),destination=await diskHost();
  const bytes=new Uint8Array(96*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
  bytes.set([255,216,255,224]);bytes.set([255,217],bytes.length-2);
  const fixtures=new Map<string,Uint8Array>([
    ['note.md',new TextEncoder().encode('# Synthetic note\n')],
    ['BetterDraw/nested/drawing.svg',new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>')],
    ['arbitrary.unknown',new Uint8Array([0,255,128,192,175,10,13])],
    ['hero.jpg',bytes]
  ]);
  let engine:SyncEngine|undefined;
  const mtime=new Date('2020-05-06T12:34:56.000Z');
  try {
    for(const [path,data] of fixtures) {
      await source.seed(path,data);
      await utimes(join(source.root,path),mtime,mtime);
    }
    await mkdir(join(source.root,'empty'));
    await source.seed('.obsidian/excluded',new Uint8Array([1]));
    const expected=[...fixtures.keys(),'BetterDraw/','BetterDraw/nested/','empty/'].sort();
    assert.deepEqual((await source.vault.listFiles()).sort(),expected);
    const make=(vault:ObsidianVault,r:EncryptedRemote,disk:LocalSyncState)=>{
      let persisted=structuredClone(disk),status:SyncStatus='Synced';
      const journals=new Set<string>();
      const logs:string[]=[];
      const store=new StateStore(structuredClone(disk),async value=>{persisted=structuredClone(value);for(const p of Object.keys(value.incoming))journals.add(p);});
      const e=new SyncEngine(vault,r,store,{status:s=>{status=s;},notice:()=>{},log:event=>{logs.push(event);},confirm:async d=>d});
      return {engine:e,store,journals,logs,disk:()=>persisted,status:()=>status};
    };
    const uploadRemote=await remote(),a=make(source.vault,uploadRemote,freshState(uploadRemote.stateBinding));
    await a.engine.start();await a.engine.stop();
    assert.equal(a.status(),'Synced');assert.deepEqual(Object.keys(a.disk().files).sort(),expected);
    const page=await uploadRemote.getChanges(0);
    const docs=await Promise.all(page.results.map(r=>uploadRemote.validateIncoming(r.doc)));
    assert.deepEqual(docs.map(doc=>doc.path).sort(),expected);
    for(const doc of docs) {
      const record=doc.encrypted!;
      assert.equal(record.schema,4);
      if(doc.path.endsWith('/'))assert.equal(record.inline,undefined);
      else assert.equal(record.inline!==undefined,fixtures.get(doc.path)!.byteLength<=65536);
      assert.equal(!!record._attachments,doc.path==='hero.jpg');
      if(fixtures.has(doc.path))assert.equal(doc.mtime,mtime.getTime(),doc.path);
    }
    const downloadRemote=await remote();
    let b=make(destination.vault,downloadRemote,freshState(downloadRemote.stateBinding));engine=b.engine;
    destination.setFailBinaryCreate(!!interrupt);await engine.start();
    if(interrupt){
      assert.equal(b.status(),'Sync error');
      assert.ok(b.logs.includes('incoming local-write failed (operation EBUSY)'));
      assert.ok(!b.logs.join('\n').includes('private synthetic payload'));
      for(const path of fixtures.keys())assert.ok(!b.logs.join('\n').includes(path));
      for(const p of fixtures.keys())if(p!=='note.md')assert.ok(b.disk().incoming[p]?.doc.encrypted);
      const saved=JSON.parse(JSON.stringify(b.disk())) as LocalSyncState;
      destination.setFailBinaryCreate(false);
      if(interrupt==='restart') {
        await engine.stop();
        b=make(destination.vault,downloadRemote,saved);engine=b.engine;await engine.start();
      }
    }
    await engine.tick();
    assert.equal(b.status(),'Synced');assert.equal(Object.keys(b.disk().incoming).length,0);
    assert.deepEqual((await destination.vault.listFiles()).sort(),expected);
    for(const [path,data] of fixtures)assert.deepEqual(new Uint8Array(await readFile(join(destination.root,path))),data,path);
    for(const path of fixtures.keys())assert.equal(await destination.vault.modificationTime(path),mtime.getTime(),path);
    if(!interrupt)for(const p of expected)assert.ok(b.journals.has(p),p+' must be durably journaled');
  } finally {await engine?.stop();await source.cleanup();await destination.cleanup();}
}
