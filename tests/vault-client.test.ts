import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {hash,MAX_FILE_BYTES} from '../src/paths';
import {fileURLToPath} from 'node:url';
import type {App} from 'obsidian';
import type {ObsidianVault as VaultAdapter} from '../src/vault-client';

test('portable adapter inventories hidden files, preserves bytes, defers nonempty directory deletes and skips oversized reads',async()=>{
  const bundle=await build({entryPoints:['src/vault-client.ts'],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{
    name:'mock-obsidian',setup(b){
      b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));
      b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export class TFile{};export class TFolder{};export class MarkdownView{};'}));
    }
  }]});
  const {ObsidianVault}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0]!.text).toString('base64'));
  const entries=new Map<string,ArrayBuffer|null>([['',null],['.obsidian',null],['.obsidian/secret',new ArrayBuffer(1)],['.hidden',null],['.hidden/bytes',Uint8Array.from([0,255]).buffer]]);
  let binaryReads=0;
  const adapter={
    stat:async(p:string)=>entries.has(p)?{type:entries.get(p)===null?'folder':'file',size:p==='huge.bin'?MAX_FILE_BYTES+1:entries.get(p)?.byteLength??0,mtime:1}:null,
    exists:async(p:string)=>entries.has(p),
    list:async(p:string)=>{const children=[...entries.keys()].filter(k=>k!==p && k.startsWith(p?p+'/':'') && !k.slice(p?p.length+1:0).includes('/'));return {files:children.filter(k=>entries.get(k)!==null),folders:children.filter(k=>entries.get(k)===null)};},
    mkdir:async(p:string)=>{entries.set(p,null);},
    readBinary:async(p:string)=>{binaryReads++;return entries.get(p);},
    writeBinary:async(p:string,b:ArrayBuffer)=>{entries.set(p,b);},
    copy:async(from:string,to:string)=>{if(entries.has(to))throw new Error('Exists');entries.set(to,entries.get(from)!);},
    remove:async(p:string)=>{entries.delete(p);},
    rmdir:async(p:string)=>{entries.delete(p);},
    trashLocal:async(p:string)=>{entries.delete(p);}
  };
  const vault=new ObsidianVault({vault:{adapter,getAbstractFileByPath:()=>null}});
  assert.deepEqual(await vault.listFiles(),['.hidden/','.hidden/bytes']);
  assert.equal(await vault.read('.hidden/bytes'),'AP8=');
  await vault.create('empty/','directory');assert.equal(await vault.read('empty/'),'directory');
  await vault.create('empty/attachment.bin','AQID');
  assert.deepEqual(new Uint8Array(entries.get('empty/attachment.bin')!),Uint8Array.from([1,2,3]));
  await assert.rejects(()=>vault.compareAndSet('empty/',hash('directory'),null),/not empty/);
  assert.equal(await vault.compareAndSet('empty/attachment.bin',hash('wrong'),'AAAA'),false);
  assert.equal(await vault.compareAndSet('empty/attachment.bin',hash('AQID'),null),true);
  assert.equal(await vault.compareAndSet('empty/',hash('directory'),null),true);
  entries.set('huge.bin',new ArrayBuffer(0));const reads=binaryReads;
  await assert.rejects(()=>vault.read('huge.bin'),/200 MiB/);assert.equal(binaryReads,reads);
  await vault.scanChanges();entries.delete('.hidden/bytes');
  assert.deepEqual(await vault.scanChanges(),['.hidden/bytes']);
});

// Exercise the actual adapter with only the Obsidian host classes replaced.
// The published obsidian package supplies types, not a Node runtime.
const bundle=await build({
  stdin:{contents:`export {ObsidianVault} from ${JSON.stringify(fileURLToPath(new URL('../src/vault-client.ts',import.meta.url)))}; export {TFile,MarkdownView} from 'obsidian';`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},
  bundle:true,write:false,platform:'node',format:'esm',plugins:[{
    name:'obsidian-test-host',setup(builder){
      builder.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'test-host'}));
      builder.onLoad({filter:/.*/,namespace:'test-host'},()=>({contents:`
        export class TFile { constructor(path) { this.path=path; } }
        export class TFolder {}
        export class MarkdownView {
          constructor(file,value) { this.file=file; this.value=value; this.editor={getValue:()=>this.value}; }
          getMode() { return 'source'; }
        }
      `}));
    }
  }]
});
interface File {path:string}
interface View {file:File;value:string}
const host=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0]!.text).toString('base64')) as {
  ObsidianVault:new(app:App)=>VaultAdapter;
  TFile:new(path:string)=>File;
  MarkdownView:new(file:File,value:string)=>View;
};

for(const deletion of [false,true])for(const pendingFirst of [false,true])test(
  `${deletion?'delete':'replace'} defers for unsaved text in ${pendingFirst?'first':'second'} pane`,async()=>{
    const file=new host.TFile('test.md');
    const saved=new host.MarkdownView(file,'base'),pending=new host.MarkdownView(file,'unsaved text');
    const views=pendingFirst?[pending,saved]:[saved,pending];
    let disk:string|null='base',trashCalls=0;
    const app={
      workspace:{getLeavesOfType:()=>views.map(view=>({view}))},
      vault:{
        getAbstractFileByPath:()=>file,
        read:async()=>disk,
        process:async(_file:File,update:(current:string)=>string)=>{disk=update(disk!);},
        trash:async()=>{trashCalls++;disk=null;}
      }
    } as unknown as App;
    const vault=new host.ObsidianVault(app),desired=deletion?null:'remote';
    assert.equal(await vault.compareAndSet('test.md',hash('base'),desired),false);
    assert.equal(disk,'base');assert.equal(pending.value,'unsaved text');assert.equal(trashCalls,0);
    // Once all panes agree with disk, normal remote application can resume.
    pending.value='base';
    assert.equal(await vault.compareAndSet('test.md',hash('base'),desired),true);
    assert.equal(disk,desired);assert.equal(trashCalls,deletion?1:0);
  }
);
