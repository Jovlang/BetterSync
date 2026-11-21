import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {hash} from '../src/paths';
import type {App} from 'obsidian';
import type {ObsidianVault as VaultAdapter} from '../src/vault-client';

interface NativeFsState {
  loads:number;
  calls:string[];
  rmdir:(path:string)=>Promise<void>;
}
declare global {
  var directoryDeletionNativeFs:NativeFsState;
}

const bundle=await build({
  stdin:{contents:`
    export {ObsidianVault} from ${JSON.stringify(fileURLToPath(new URL('../src/vault-client.ts',import.meta.url)))};
    export {FileSystemAdapter,Platform} from 'obsidian';
  `,resolveDir:fileURLToPath(new URL('..',import.meta.url))},
  bundle:true,write:false,platform:'node',format:'esm',plugins:[{
    name:'directory-deletion-host',setup(builder){
      builder.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'test-host'}));
      builder.onLoad({filter:/.*/,namespace:'test-host'},()=>({contents:`
        export class FileSystemAdapter {
          constructor(root='/vault') { this.root=root; }
          getFullPath(path) { return this.root+'/'+path; }
        }
        export const Platform={isDesktopApp:true};
        export class TFile {}
        export class MarkdownView {}
      `}));
      builder.onResolve({filter:/^node:fs\/promises$/},()=>({path:'native-fs',namespace:'test-native'}));
      builder.onLoad({filter:/.*/,namespace:'test-native'},()=>({contents:`
        globalThis.directoryDeletionNativeFs.loads++;
        export async function rmdir(path) {
          globalThis.directoryDeletionNativeFs.calls.push(path);
          await globalThis.directoryDeletionNativeFs.rmdir(path);
        }
      `}));
    }
  }]
});

globalThis.directoryDeletionNativeFs={loads:0,calls:[],rmdir:async()=>{}};
const host=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0]!.text).toString('base64')) as {
  ObsidianVault:new(app:App)=>VaultAdapter;
  FileSystemAdapter:new(root?:string)=>Record<string,unknown>;
  Platform:{isDesktopApp:boolean};
};

function resetNativeFs() {
  globalThis.directoryDeletionNativeFs.calls=[];
  globalThis.directoryDeletionNativeFs.rmdir=async()=>{};
  host.Platform.isDesktopApp=true;
}
function directoryAdapter(filesystemAdapter:boolean,adapterRmdir:(path:string,recursive:boolean)=>Promise<void>) {
  const adapter=filesystemAdapter?new host.FileSystemAdapter('/native-vault'):{};
  return Object.assign(adapter,{
    stat:async()=>({type:'folder',size:0,mtime:1}),
    exists:async()=>true,
    list:async()=>({files:[],folders:[]}),
    rmdir:adapterRmdir
  });
}
async function remove(adapter:Record<string,unknown>) {
  const vault=new host.ObsidianVault({vault:{adapter,getAbstractFileByPath:()=>null}} as unknown as App);
  return vault.compareAndSet('empty/',hash('directory'),null);
}
function codedError(code:string) {return Object.assign(new Error(code),{code});}

test('empty-directory removal uses the normal non-recursive adapter path without loading native fs',async()=>{
  resetNativeFs();let recursive:boolean|undefined;
  const adapter=directoryAdapter(true,async(_path,value)=>{recursive=value;});
  assert.equal(await remove(adapter),true);
  assert.equal(recursive,false);
  assert.equal(globalThis.directoryDeletionNativeFs.loads,0);
  assert.deepEqual(globalThis.directoryDeletionNativeFs.calls,[]);
});

test('unrelated adapter errors propagate without loading native fs',async()=>{
  resetNativeFs();
  const adapter=directoryAdapter(true,async()=>{throw codedError('EACCES');});
  await assert.rejects(()=>remove(adapter),(error:unknown)=>(error as NodeJS.ErrnoException).code==='EACCES');
  assert.equal(globalThis.directoryDeletionNativeFs.loads,0);
  assert.deepEqual(globalThis.directoryDeletionNativeFs.calls,[]);
});

test('mobile and non-filesystem adapters never load native fs',async()=>{
  for(const scenario of ['mobile','non-filesystem']) {
    resetNativeFs();
    host.Platform.isDesktopApp=scenario!=='mobile';
    const adapter=directoryAdapter(scenario!=='non-filesystem',async()=>{throw codedError('ERR_FS_EISDIR');});
    await assert.rejects(()=>remove(adapter),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ERR_FS_EISDIR');
    assert.equal(globalThis.directoryDeletionNativeFs.loads,0,scenario);
    assert.deepEqual(globalThis.directoryDeletionNativeFs.calls,[],scenario);
  }
});

for(const code of ['ERR_FS_EISDIR','EPERM'])test(`desktop ${code} falls back to native rmdir`,async()=>{
  resetNativeFs();
  const adapter=directoryAdapter(true,async(_path,recursive)=>{assert.equal(recursive,false);throw codedError(code);});
  assert.equal(await remove(adapter),true);
  assert.equal(globalThis.directoryDeletionNativeFs.loads,1);
  assert.deepEqual(globalThis.directoryDeletionNativeFs.calls,['/native-vault/empty']);
});

test('native rmdir preserves a child that appears after the empty listing',async()=>{
  resetNativeFs();const entries=new Set(['empty']);let recursive:boolean|undefined;
  const adapter=directoryAdapter(true,async(_path,value)=>{recursive=value;throw codedError('ERR_FS_EISDIR');});
  Object.assign(adapter,{list:async()=>({files:[],folders:[]})});
  globalThis.directoryDeletionNativeFs.rmdir=async()=>{entries.add('empty/unsynced.md');throw codedError('ENOTEMPTY');};
  await assert.rejects(()=>remove(adapter),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOTEMPTY');
  assert.equal(recursive,false);
  assert.equal(entries.has('empty/unsynced.md'),true);
  assert.deepEqual(globalThis.directoryDeletionNativeFs.calls,['/native-vault/empty']);
});

test('native ENOENT means the requested deletion is already satisfied',async()=>{
  resetNativeFs();
  const adapter=directoryAdapter(true,async()=>{throw codedError('EPERM');});
  globalThis.directoryDeletionNativeFs.rmdir=async()=>{throw codedError('ENOENT');};
  assert.equal(await remove(adapter),true);
  assert.deepEqual(globalThis.directoryDeletionNativeFs.calls,['/native-vault/empty']);
});
