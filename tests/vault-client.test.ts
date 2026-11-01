import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import type {App} from 'obsidian';
import type {ObsidianVault as VaultAdapter} from '../src/vault-client';
import {hash} from '../src/paths';

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
