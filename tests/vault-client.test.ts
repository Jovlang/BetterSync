import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {hash,MAX_FILE_BYTES} from '../src/paths';

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
