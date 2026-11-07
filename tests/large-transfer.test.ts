import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EncryptedRemote} from '../src/encrypted-remote';
import {importRecoveryCode} from '../src/encryption-setup';
import {freshState, StateStore} from '../src/local-state';
import {SyncEngine} from '../src/sync-engine';
import {hash, hashAsync, rawHashAsync, syncPath} from '../src/paths';
import {decryptRecord} from '../src/encrypted-protocol';
import type {Content, LocalSyncState, VaultClient, SyncStatus} from '../src/types';
import type {Http} from '../src/couch-client';
import {fixture, connection} from './encrypted-wire';

class BinaryVault implements VaultClient {
  files=new Map<string,Content>();reads=0;
  listFiles(){return [...this.files.keys()];}
  async fileSize(path:string) {const v=this.files.get(path);return v===undefined?null:typeof v==='string'?new TextEncoder().encode(v).length:v.byteLength;}
  async read(path:string){this.reads++;return this.files.get(path)??null;}
  async create(path:string,content:Content){assert.equal(this.files.has(path),false);this.files.set(path,content);}
  async compareAndSet(path:string,expected:string|null,content:Content|null){
    if(await hashAsync(this.files.get(path)??null)!==expected)return false;
    if(content===null)this.files.delete(path);else this.files.set(path,content);return true;
  }
}
async function clients(http?: (wire:Http)=>Http) {
  const f=await fixture();
  // Do not retain every full multipart request in the test's HTTP recorder.
  const transport:Http=async(...args)=>{try{return await (http?http(f.wire.http):f.wire.http)(...args);}finally{f.wire.requests.length=0;}};
  const devices=[];
  for(let i=0;i<3;i++) {
    const remote=await EncryptedRemote.connect(connection,transport,await importRecoveryCode(f.code),syncPath);
    const vault=new BinaryVault();let disk=freshState(remote.stateBinding),engine:SyncEngine;
    let failSave:((s:LocalSyncState)=>boolean)|undefined,status:SyncStatus='Synced';
    const logs:string[]=[],notices:string[]=[];
    const boot=()=>{engine=new SyncEngine(vault,remote,new StateStore(structuredClone(disk),async s=>{
      if(failSave?.(s))throw new Error('simulated termination');disk=structuredClone(s);
    }),{status:s=>{status=s;},notice:s=>notices.push(s),log:s=>logs.push(s),confirm:async d=>d});};
    boot();
    devices.push({vault,remote,logs,notices,get disk(){return disk;},get status(){return status;},get engine(){return engine;},
      failSave:(f:typeof failSave)=>{failSave=f;},restart:async()=>{await engine.stop();boot();await engine.start();}});
    await engine!.start();
  }
  return {...f,devices};
}
async function settle(devices:Awaited<ReturnType<typeof clients>>['devices']) {
  for(let i=0;i<3;i++)for(const d of devices)await d.engine.tick();
}

test('88 MiB real AES-GCM/multipart pipeline survives accepted upload interruption, restart and explicit retry on three clients',async()=>{
  const {devices,wire,crypto}=await clients();const [a,b,c]=devices;
  const path='private-video.mov',bytes=new Uint8Array(88*1024*1024);
  for(let i=0;i<bytes.length;i+=65536)bytes[i]=(i/65536)%251;
  const expected=createHash('sha256').update(bytes).digest('hex');
  a!.vault.files.set(path,bytes.buffer);await a!.engine.changed(path);
  a!.failSave(s=>!!s.files[path]&&s.transfers?.[path]?.stage==='baseline-save');
  await a!.engine.tick();
  assert.equal(wire.records.size,1);assert.equal(a!.disk.transfers?.[path]?.active,true);
  assert.equal(a!.disk.transfers?.[path]?.stage,'attachment-upload');
  assert.ok(JSON.stringify(a!.disk).length<5000,'journal never contains the large body');
  a!.failSave(undefined);a!.vault.reads=0;await a!.restart();
  assert.equal(a!.disk.transfers?.[path]?.paused,true);assert.equal(a!.vault.reads,0);
  a!.vault.files.set('unrelated.md','still usable');await a!.engine.changed('unrelated.md');
  await a!.engine.tick();assert.ok(await a!.remote.getDocument('unrelated.md'));
  assert.equal(a!.status,'Sync error');
  await a!.engine.retry();await settle(devices);
  for(const d of [a!,b!,c!]) {
    const result=await d.vault.read(path);assert.ok(result instanceof ArrayBuffer);
    assert.equal(result.byteLength,bytes.length);assert.equal(await rawHashAsync(result),expected);
    assert.equal(Object.keys(d.disk.incoming).length,0);assert.equal(Object.keys(d.disk.transfers??{}).length,0);
  }
  const record=await a!.remote.getDocument(path);
  assert.equal(record?._rev,'1-saved','lost acknowledgement must not create another revision');
  const encrypted=record!.encrypted!,body=wire.bodies.get(encrypted._id+'@'+encrypted._rev)!;
  assert.equal(encrypted.inline,undefined);assert.equal(body.byteLength,bytes.length+16);
  await assert.rejects(()=>decryptRecord(crypto,encrypted,body.slice(0,-1),syncPath));
  const corrupt=new Uint8Array(body);corrupt[0]=corrupt[0]!^1;
  await assert.rejects(()=>decryptRecord(crypto,encrypted,body,syncPath));
  assert.ok(a!.logs.some(s=>s.includes('content-encryption')));
  assert.ok(a!.logs.every(s=>!s.includes(path)));
});

test('repeated binary failure pauses only that file, survives restart, and local deletion clears pending upload without reading it',async()=>{
  let rejectedId='';
  const {devices,crypto,wire}=await clients(next=>async(...args)=>{
    if(args[1]==='PUT'&&decodeURIComponent(args[0]).endsWith(rejectedId)&&rejectedId)return {status:400};
    return next(...args);
  });
  const [a]=devices;rejectedId=await crypto.documentId('bad.mov');
  a!.vault.files.set('bad.mov',new Uint8Array(256*1024).buffer);
  a!.vault.files.set('good.md','good');a!.vault.files.set('good.bin',new Uint8Array([1,2,3]).buffer);
  for(const p of a!.vault.files.keys())await a!.engine.changed(p);
  await settle(devices);
  assert.equal(a!.disk.transfers?.['bad.mov']?.paused,true);
  for(const d of devices) {assert.equal(await d.vault.read('good.md'),'good');assert.ok(await d.vault.read('good.bin'));}
  a!.vault.reads=0;await a!.restart();const reads=a!.vault.reads;
  await a!.engine.tick();assert.equal(a!.vault.reads,reads);
  a!.vault.files.delete('bad.mov');await a!.engine.changed('bad.mov');await a!.engine.tick();
  assert.equal(a!.disk.transfers?.['bad.mov'],undefined);assert.equal(wire.records.has(rejectedId),false);
});

test('ordinary offline upload resumes automatically when connectivity returns, without duplicate remote revisions',async()=>{
  let offline=true,id='';
  const {devices,crypto,wire}=await clients(next=>async(...args)=>{
    if(offline&&args[1]==='PUT'&&id&&decodeURIComponent(args[0]).endsWith(id))throw new Error('offline');
    return next(...args);
  });const [a]=devices;id=await crypto.documentId('offline.bin');
  a!.vault.files.set('offline.bin',new Uint8Array(128*1024).buffer);await a!.engine.changed('offline.bin');
  await a!.engine.tick();await a!.restart();await a!.engine.tick();
  assert.equal(a!.disk.transfers?.['offline.bin']?.paused,false);
  offline=false;await settle(devices);
  assert.equal(wire.records.get(id)?._rev,'1-saved');
  for(const d of devices)assert.equal((await d.vault.read('offline.bin') as ArrayBuffer).byteLength,128*1024);
});

test('interruption before multipart upload leaves no remote record and deleting source while closed clears the durable marker',async()=>{
  const {devices,wire}=await clients();const [a]=devices;
  a!.vault.files.set('pending.mov',new Uint8Array(1024*1024).buffer);
  await a!.engine.changed('pending.mov');
  a!.failSave(s=>s.transfers?.['pending.mov']?.stage==='multipart-allocation');
  await a!.engine.tick();assert.equal(wire.records.size,0);
  assert.equal(a!.disk.transfers?.['pending.mov']?.active,true);
  a!.vault.files.delete('pending.mov');a!.failSave(undefined);await a!.restart();
  assert.equal(a!.disk.transfers?.['pending.mov'],undefined);assert.equal(wire.records.size,0);
});

test('failed binary transfer can be retried explicitly after repair without resetting other sync state',async()=>{
  let reject=true;
  const {devices,wire}=await clients(next=>async(...args)=>reject&&args[1]==='PUT'?{status:400}:next(...args));
  const [a]=devices;a!.vault.files.set('repair.bin',new Uint8Array(128*1024).buffer);
  await a!.engine.changed('repair.bin');await a!.engine.tick();await a!.engine.tick();
  assert.equal(a!.disk.transfers?.['repair.bin']?.paused,true);
  reject=false;await a!.engine.retry();await settle(devices);
  assert.equal(wire.records.size,1);
  for(const d of devices)assert.equal((await d.vault.read('repair.bin') as ArrayBuffer).byteLength,128*1024);
});

test('event bursts never read binaries; failed marker persistence prevents a read; incremental digest preserves baseline compatibility',async()=>{
  const {devices}=await clients();const [a]=devices;
  const bytes=new Uint8Array(1024*1024+2);bytes.fill(213);
  a!.vault.files.set('event.bin',bytes.buffer);a!.vault.reads=0;
  await Promise.all(Array.from({length:50},()=>a!.engine.changed('event.bin')));
  assert.equal(a!.vault.reads,0);
  a!.failSave(s=>s.transfers?.['event.bin']?.active===true);
  await a!.engine.tick();assert.equal(a!.vault.reads,0);
  let yielded=false;const timer=setTimeout(()=>{yielded=true;},0);
  assert.equal(await hashAsync(bytes.buffer),hash(bytes.buffer));
  clearTimeout(timer);assert.ok(yielded);
});
