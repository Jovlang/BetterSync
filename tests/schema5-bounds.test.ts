import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withTimeout,PendingRequestFailure} from '../src/http';
import {fixture,device,connection,settle} from './schema5-helpers';
import {EncryptedCouch} from '../src/encrypted-couch';
import {EncryptedRemote} from '../src/encrypted-remote';
import {syncPath} from '../src/paths';
import {EncryptedChunk,prepareMetadata,openChunk,validateMetadata,sealManifest,decryptMetadata,CHUNK_BYTES,MAX_METADATA_BYTES} from '../src/encrypted-protocol';
import {base64url,randomBytes} from '../src/crypto';
import type {Http,HttpResponse} from '../src/couch-client';

test('native timeouts retain one chunk and two control slots until actual settlement',async()=>{
  const pending:((r:HttpResponse)=>void)[]=[];
  const native:Http=()=>new Promise(resolve=>pending.push(resolve));
  const wrapped=withTimeout(native,5) as Http&{usage:()=>{chunks:number;controls:number;bytesHeld:number}};
  await assert.rejects(()=>wrapped('https://synthetic/db/c5%3Afirst','PUT',{},'ciphertext'),PendingRequestFailure);
  for(let i=0;i<30;i++)await assert.rejects(()=>wrapped('https://synthetic/db/c5%3A'+i,'PUT',{},'ciphertext'),PendingRequestFailure);
  assert.equal(pending.length,1);assert.equal(wrapped.usage().chunks,1);
  await assert.rejects(()=>wrapped('https://synthetic/db/control1','GET',{}),PendingRequestFailure);
  await assert.rejects(()=>wrapped('https://synthetic/db/control2','GET',{}),PendingRequestFailure);
  await assert.rejects(()=>wrapped('https://synthetic/db/control3','GET',{}),PendingRequestFailure);
  assert.deepEqual(wrapped.usage(),{chunks:1,controls:2,bytesHeld:20});
  for(const resolve of pending)resolve({status:200,json:{}});await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(wrapped.usage(),{chunks:0,controls:0,bytesHeld:0});
  await assert.rejects(()=>wrapped('https://synthetic/db/control','PUT',{},'x'.repeat(524289)),/budget/);
});

test('chunk authentication binds vault, salt, ID, count and expected length; max manifest fits',async()=>{
  const f=await fixture(),g=await fixture(),bytes=new Uint8Array(CHUNK_BYTES+1).fill(11),salt=base64url(randomBytes(32));
  const metadata=await prepareMetadata('synthetic.bin',bytes.buffer,false,0),fileId=await f.key.documentId(metadata.path),c={fileId,salt,metadata,index:0};
  const sealed=await EncryptedChunk.seal(f.key,c,bytes.subarray(0,CHUNK_BYTES)),record={...sealed.record,_rev:'1-original'};
  await assert.rejects(()=>openChunk(g.key,c,record));
  await assert.rejects(()=>openChunk(f.key,{...c,salt:base64url(randomBytes(32))},record));
  const otherId='c5:'+base64url(randomBytes(16));
  await assert.rejects(()=>openChunk(f.key,{...c,metadata:{...metadata,chunks:[otherId,metadata.chunks[1]!]}},{...record,_id:otherId}));
  await assert.rejects(()=>openChunk(f.key,{...c,metadata:{...metadata,size:CHUNK_BYTES,chunks:[metadata.chunks[0]!]}},record));
  await assert.rejects(()=>openChunk(f.key,{...c,index:1},record));
  assert.throws(()=>validateMetadata({...metadata,chunks:[metadata.chunks[0],metadata.chunks[0]]}));
  const maximum={...metadata,path:'x'.repeat(4092)+'.bin',size:200*1048576,chunks:Array.from({length:800},()=> 'c5:'+base64url(randomBytes(16)))};
  assert.ok(new TextEncoder().encode(JSON.stringify(maximum)).length<MAX_METADATA_BYTES);
  const manifest=await sealManifest(f.key,maximum,salt);assert.equal((await decryptMetadata(f.key,manifest,syncPath)).chunks.length,800);
});

test('chunk-only pages stay body-free and future protocol records stop writes',async()=>{
  const f=await fixture();let calls=0;
  for(let i=0;i<401;i++){const id='c5:'+base64url(randomBytes(16));f.wire.history.set(id,{id,seq:++f.wire.seq,changes:[{rev:'1-test'}]});}
  const http:Http=async(...args)=>{calls++;assert.ok(!args[0].includes('_bulk_get'));return f.wire.http(...args);};
  const remote=await EncryptedRemote.connect(connection,http,f.key,syncPath);
  let page=await remote.getChanges(0);assert.equal(page.sourceRows,200);assert.equal(page.results.length,0);
  page=await remote.getChanges(page.last_seq);assert.equal(page.sourceRows,200);
  page=await remote.getChanges(page.last_seq);assert.equal(page.sourceRows,2);assert.equal(calls,5);
  f.wire.history.set('f6:foreign',{id:'f6:foreign',seq:++f.wire.seq,changes:[{rev:'1-future'}]});
  await assert.rejects(()=>remote.getChanges(page.last_seq),/unsupported/);
});

test('unchanged startup inventory performs no per-file remote lookup and offline chunk resumes',async()=>{
  const f=await fixture();let reads=0;
  const http:Http=async(...args)=>{if(args[0].includes('_all_docs'))reads++;return f.wire.http(...args);};
  const a=await device(await EncryptedRemote.connect(connection,http,f.key,syncPath));
  try {
    await a.engine.start();for(let i=0;i<20;i++){await a.host.seed(`note-${i}.md`,new TextEncoder().encode('note'));await a.engine.changed(`note-${i}.md`);}await settle(a);
    reads=0;await a.restart();assert.equal(reads,0);
    await a.host.seed('pending.bin',new Uint8Array(CHUNK_BYTES*2));await a.engine.changed('pending.bin');
    f.wire.afterPut=async d=>{if(d._id.startsWith('c5:'))f.wire.offline=true;};await a.engine.tick();
    assert.ok(a.disk.outgoing?.['pending.bin']);assert.equal(a.disk.transfers?.['pending.bin']?.paused,false);
    f.wire.afterPut=undefined;f.wire.offline=false;await new Promise(r=>setTimeout(r,1100));await settle(a);
    assert.equal(f.wire.chunkPuts,2);assert.equal(a.disk.outgoing?.['pending.bin'],undefined);
  }finally{await a.close();}
});

test('a timed-out native chunk prevents new large reads while unrelated Markdown still syncs',async()=>{
  const f=await fixture();let release:((value:HttpResponse)=>void)|undefined,reads=0;
  const native:Http=async(...args)=>args[0].includes('/c5%3A')?new Promise(resolve=>{release=resolve;}):f.wire.http(...args);
  const http=withTimeout(native,10),a=await device(await EncryptedRemote.connect(connection,http,f.key,syncPath));
  try {
    await a.engine.start();const read=a.host.adapter.readBinary;
    a.host.adapter.readBinary=async p=>{reads++;return read(p);};
    await a.host.seed('first.bin',new Uint8Array(CHUNK_BYTES*2));await a.engine.changed('first.bin');await a.engine.tick();assert.equal(reads,1);
    await a.host.seed('second.bin',new Uint8Array(CHUNK_BYTES*2));await a.engine.changed('second.bin');
    await a.host.seed('usable.md',new TextEncoder().encode('usable'));await a.engine.changed('usable.md');await a.engine.tick();
    assert.equal(reads,1);assert.ok(await a.remote.getDocument('usable.md'));
  }finally{release?.({status:500});await a.close();}
});

test('malformed outgoing checkpoints fail closed without discarding the local source',async()=>{
  const f=await fixture(),a=await device(await f.remote());
  try {
    await a.engine.start();await a.host.seed('pending.bin',new Uint8Array(CHUNK_BYTES*2));await a.engine.changed('pending.bin');
    f.wire.loseChunk=true;await a.engine.tick();const op=a.disk.outgoing?.['pending.bin'];assert.ok(op);op.next=999;
    const writes=f.wire.chunkPuts;await a.restart();await a.engine.retry();assert.equal(f.wire.chunkPuts,writes);
    assert.equal((await a.host.vault.read('pending.bin') as ArrayBuffer).byteLength,CHUNK_BYTES*2);assert.ok(a.disk.outgoing?.['pending.bin']);
    await a.host.seed('unrelated.md',new TextEncoder().encode('safe'));await a.engine.changed('unrelated.md');await a.engine.tick();assert.ok(await a.remote.getDocument('unrelated.md'));
  }finally{await a.close();}
});
