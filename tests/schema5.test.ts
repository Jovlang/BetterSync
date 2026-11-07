import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hkdfSync,createDecipheriv,createHash} from 'node:crypto';
import {readFile,rm,utimes,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,device,settle,connection} from './schema5-helpers';
import {EncryptedCouch} from '../src/encrypted-couch';
import {EncryptedRemote} from '../src/encrypted-remote';
import {prepareMetadata,sealManifest,decryptMetadata,EncryptedChunk,openChunk,CHUNK_BYTES,INLINE_FILE_BYTES,MAX_CHUNK_DOCUMENT_BYTES} from '../src/encrypted-protocol';
import {base64url,randomBytes,frame,CRYPTO_DOMAIN} from '../src/crypto';
import {syncPath,MAX_FILE_BYTES} from '../src/paths';
import {authenticateConfiguration} from '../src/encryption-setup';
import {PersistenceFailure} from '../src/local-state';
import {createConfiguration as oldConfiguration,importRecoveryCode as oldKey,generateRecoveryCode as oldCode} from '../src/legacy/encryption-setup';

test('schema 5 independent AES-GCM decoding, bounded view, context substitution and plaintext-bypass rejection',async()=>{
  const {key,code,wire}=await fixture(),bytes=new Uint8Array(CHUNK_BYTES+17).fill(171),salt=base64url(randomBytes(32));
  const m=await prepareMetadata('private.mov',bytes.buffer,false,1),fileId=await key.documentId(m.path),index=1;
  const c={fileId,salt,metadata:m,index},sealed=await EncryptedChunk.seal(key,c,bytes.subarray(CHUNK_BYTES));
  assert.ok(JSON.stringify(sealed.record).length<1024,'a 17-byte view cannot encrypt its whole backing buffer');
  const ctx=[m.version!,m.chunks[index]!,String(index),String(m.chunks.length),String(CHUNK_BYTES),'17'];
  const derived=hkdfSync('sha256',Buffer.from(code.split('.')[2]!,'base64url'),Buffer.from(salt,'base64url'),frame(CRYPTO_DOMAIN,key.vaultId,fileId,'chunk',...ctx),32);
  const raw=Buffer.from(sealed.record.ciphertext,'base64url'),dec=createDecipheriv('aes-256-gcm',Buffer.from(derived),Buffer.from(sealed.record.nonce,'base64url'));
  dec.setAAD(frame(CRYPTO_DOMAIN,'5',key.vaultId,fileId,salt,'chunk',...ctx));dec.setAuthTag(raw.subarray(-16));
  assert.deepEqual(Buffer.concat([dec.update(raw.subarray(0,-16)),dec.final()]),Buffer.from(bytes.subarray(CHUNK_BYTES)));
  const record={...sealed.record,_rev:'1-test'};assert.equal((await openChunk(key,c,record)).byteLength,17);
  for(const altered of [{...c,index:0},{...c,fileId:await key.documentId('other.mov')},{...c,metadata:{...m,version:base64url(randomBytes(32))}}])
    await assert.rejects(()=>openChunk(key,altered,record));
  await assert.rejects(()=>openChunk(key,c,{...record,_rev:'2-test'}));
  await assert.rejects(()=>openChunk(key,c,{...record,data:'plaintext'}));
  const couch=await EncryptedCouch.connect(connection,wire.http,key,syncPath);
  await assert.rejects(()=>couch.putChunk({record:sealed.record} as EncryptedChunk,c,bytes.subarray(CHUNK_BYTES)));
  const manifest=await sealManifest(key,m,salt);assert.equal((await decryptMetadata(key,manifest,syncPath)).chunks.length,2);
  await assert.rejects(()=>authenticateConfiguration(key,awaitOld()));
  function awaitOld(){return {schema:4};}
  const legacy=await oldConfiguration(await oldKey(oldCode()));await assert.rejects(()=>authenticateConfiguration(key,legacy));
});

for(const size of [0,1,INLINE_FILE_BYTES-1,INLINE_FILE_BYTES,INLINE_FILE_BYTES+1,CHUNK_BYTES-1,CHUNK_BYTES,CHUNK_BYTES+1]) {
  test(`schema 5 actual encrypted disk roundtrip size ${size}`,async()=>{
    const f=await fixture(),a=await device(await f.remote()),b=await device(await f.remote());
    try {
      await a.engine.start();await b.engine.start();const bytes=new Uint8Array(size).fill(209);
      await a.host.seed('fixture.bin',bytes);await a.engine.changed('fixture.bin');await settle(a,b);
      assert.deepEqual(await readFile(join(b.host.root,'fixture.bin')),Buffer.from(bytes));
      assert.equal(a.status,'Synced');assert.equal(b.status,'Synced');
      assert.equal(f.wire.chunkPuts,size>INLINE_FILE_BYTES?Math.ceil(size/CHUNK_BYTES):0);
      assert.ok(f.wire.maxBody<=MAX_CHUNK_DOCUMENT_BYTES);assert.equal(a.remote.diagnostics.maxChunkBytes,Math.min(size>INLINE_FILE_BYTES?size:0,CHUNK_BYTES));
    } finally {await a.close();await b.close();}
  });
}

test('88 MiB uses real chunks and staged three-client recovery, lost acknowledgements, and small-file fairness',async()=>{
  const f=await fixture(),a=await device(await f.remote()),b=await device(await f.remote()),c=await device(await f.remote());
  try {
    for(const d of [a,b,c])await d.engine.start();
    let bytes:Uint8Array<ArrayBuffer>|undefined=new Uint8Array(88*1024*1024);for(let i=0;i<bytes.length;i+=65536)bytes[i]=(i/65536)%251;
    const expected=createHash('sha256').update(bytes).digest('hex');await a.host.seed('video.mov',bytes);bytes=undefined;
    let smallBeforeManifest=false;
    f.wire.afterPut=async doc=>{
      if(doc._id.startsWith('c5:')&&f.wire.chunkPuts===2){await a.host.seed('during.md',new TextEncoder().encode('usable'));await a.engine.changed('during.md');}
      if(doc._id===await f.key.documentId('during.md'))smallBeforeManifest=!f.wire.records.has(await f.key.documentId('video.mov'));
    };
    f.wire.loseChunk=true;await a.engine.changed('video.mov');await a.engine.tick();
    const version=a.disk.outgoing?.['video.mov']?.metadata.version;assert.ok(version);
    f.wire.loseManifest=true;await new Promise(r=>setTimeout(r,1100));await a.restart();await new Promise(r=>setTimeout(r,2100));await settle(a,b,c);
    assert.ok(smallBeforeManifest);assert.equal(f.wire.chunkPuts,352);assert.equal(f.wire.manifestPuts,2);
    for(const d of [a,b,c]) {
      assert.equal(createHash('sha256').update(await readFile(join(d.host.root,'video.mov'))).digest('hex'),expected);
      assert.equal(await readFile(join(d.host.root,'during.md'),'utf8'),'usable');
      assert.equal(Object.keys(d.disk.incoming).length,0);assert.equal(Object.keys(d.disk.outgoing??{}).length,0);
      assert.ok(JSON.stringify(d.disk).length<20000);assert.ok(d.logs.every(s=>!s.includes('video.mov')));
    }
    assert.equal(a.remote.diagnostics.peakSourceBytes,88*1024*1024);assert.equal(a.remote.diagnostics.sourceBytes,0);
    assert.ok(f.wire.maxBody<=MAX_CHUNK_DOCUMENT_BYTES);
  } finally {await a.close();await b.close();await c.close();}
});

test('changed same-size source gets a new version; deleted pending source never publishes a manifest',async()=>{
  const f=await fixture(),a=await device(await f.remote());
  try {
    await a.engine.start();const path='pending.mov';await a.host.seed(path,new Uint8Array(CHUNK_BYTES*2).fill(1));
    f.wire.loseChunk=true;await a.engine.changed(path);await a.engine.tick();const first=a.disk.outgoing![path]!.metadata.version;
    await a.host.seed(path,new Uint8Array(CHUNK_BYTES*2).fill(2));await new Promise(r=>setTimeout(r,1100));await a.restart();await settle(a);
    const record=await a.remote.getDocument(path),m=await decryptMetadata(f.key,record!.manifest!,syncPath);
    assert.notEqual(m.version,first);assert.equal(m.hash,createHash('sha256').update(new Uint8Array(CHUNK_BYTES*2).fill(2)).digest('hex'));
    await a.host.seed('deleted.mov',new Uint8Array(CHUNK_BYTES*2));f.wire.loseChunk=true;
    await a.engine.changed('deleted.mov');await a.engine.tick();await rm(join(a.host.root,'deleted.mov'));await a.restart();await settle(a);
    assert.equal(await a.remote.getDocument('deleted.mov'),null);assert.equal(a.disk.outgoing?.['deleted.mov'],undefined);
  } finally {await a.close();}
});

test('staging partial append rebuilds safely, conflicting local binary survives, repeated error cannot block unrelated files',async()=>{
  const f=await fixture(),a=await device(await f.remote()),b=await device(await f.remote()),c=await device(await f.remote());
  try {
    for(const d of [a,b,c])await d.engine.start();
    const path='conflict.mov',original=new Uint8Array(CHUNK_BYTES+9).fill(1),remote=new Uint8Array(CHUNK_BYTES+9).fill(2);
    await a.host.seed(path,original);await a.engine.changed(path);await settle(a,b,c);
    await a.host.seed(path,remote);await a.engine.changed(path);await settle(a,c);
    await b.host.seed(path,new Uint8Array(CHUNK_BYTES+9).fill(3));
    const append=b.host.vault.staging.append;let broken=true;
    b.host.vault.staging.append=async(id,data)=>{if(broken){await append(id,data.slice(0,7));throw new Error('interrupted append');}await append(id,data);};
    await b.engine.tick();await b.engine.tick();assert.ok(b.disk.transfers?.[path]?.paused);
    await b.host.seed('unrelated.md',new TextEncoder().encode('continues'));await b.engine.changed('unrelated.md');await b.engine.tick();
    assert.ok(await b.remote.getDocument('unrelated.md'));broken=false;await b.engine.retry();await settle(a,b,c);
    assert.equal(createHash('sha256').update(await readFile(join(b.host.root,path))).digest('hex'),createHash('sha256').update(remote).digest('hex'));
    const copies=(await b.host.vault.listFiles()).filter(p=>p.includes('.sync-conflict-'));
    assert.equal(copies.length,1);assert.equal((await readFile(join(b.host.root,copies[0]!)))[0],3);
  } finally {await a.close();await b.close();await c.close();}
});

test('schema-5 read interruption pauses before another startup read; oversize rejects before read',async()=>{
  const f=await fixture(),a=await device(await f.remote());
  try {
    await a.engine.start();await a.host.seed('read.mov',new Uint8Array(CHUNK_BYTES));await a.engine.changed('read.mov');
    a.failSave(s=>s.outgoing?.['read.mov']!==undefined);await a.engine.tick();a.failSave(undefined);
    let reads=0;const read=a.host.vault.read.bind(a.host.vault);a.host.vault.read=async p=>{reads++;return read(p);};
    await a.restart();assert.equal(reads,0);assert.equal(a.disk.transfers?.['read.mov']?.paused,true);
    await a.engine.retry();assert.ok(await a.remote.getDocument('read.mov'));
    const stat=a.host.adapter.stat;a.host.adapter.stat=async p=>p==='large.mov'?{type:'file',mtime:1,size:MAX_FILE_BYTES+1}:stat(p);
    let readBinary=false;const rb=a.host.adapter.readBinary;a.host.adapter.readBinary=async p=>{if(p==='large.mov')readBinary=true;return rb(p);};
    await a.engine.changed('large.mov');await a.engine.tick();assert.equal(readBinary,false);
  } finally {await a.close();}
});

test('lost manifest acknowledgement followed by local deletion is reconciled without resurrecting the local file',async()=>{
  const f=await fixture(),a=await device(await f.remote());
  try {
    await a.engine.start();await a.host.seed('gone.mov',new Uint8Array(CHUNK_BYTES+1));f.wire.loseManifest=true;
    await a.engine.changed('gone.mov');await a.engine.tick();assert.ok(a.disk.outgoing?.['gone.mov']?.prepared);
    await rm(join(a.host.root,'gone.mov'));await a.restart();await settle(a);
    assert.equal(await a.host.vault.read('gone.mov'),null);assert.equal((await a.remote.getDocument('gone.mov'))?.deleted,true);
    assert.equal(f.wire.manifestPuts,2);assert.equal(a.disk.outgoing?.['gone.mov'],undefined);
  } finally {await a.close();}
});

test('a second interrupted chunk recovery pauses durably; explicit retry uses original immutable IDs',async()=>{
  const f=await fixture(),a=await device(await f.remote());
  try {
    await a.engine.start();await a.host.seed('restart.mov',new Uint8Array(CHUNK_BYTES*6));await a.engine.changed('restart.mov');
    a.failSave(s=>(s.outgoing?.['restart.mov']?.next??0)>=4);await a.engine.tick();
    const version=a.disk.outgoing!['restart.mov']!.metadata.version,ids=a.disk.outgoing!['restart.mov']!.metadata.chunks;
    assert.equal(f.wire.chunkPuts,4);await a.restart();assert.equal(f.wire.chunkPuts,4);
    a.failSave(undefined);await a.restart();assert.equal(a.disk.transfers?.['restart.mov']?.paused,true);
    await a.host.seed('ok.md',new TextEncoder().encode('available'));await a.engine.changed('ok.md');await a.engine.tick();
    assert.ok(await a.remote.getDocument('ok.md'));await a.engine.retry();await settle(a);
    const m=await decryptMetadata(f.key,(await a.remote.getDocument('restart.mov'))!.manifest!,syncPath);
    assert.equal(m.version,version);assert.deepEqual(m.chunks,ids);assert.equal(f.wire.chunkPuts,6);
  } finally {await a.close();}
});

for(const failure of ['missing','corrupt','digest'] as const)test(`schema 5 ${failure} content never installs or advances a baseline`,async()=>{
  const f=await fixture(),a=await device(await f.remote()),b=await device(await f.remote());
  try {
    await a.engine.start();await b.engine.start();await a.host.seed('bad.mov',new Uint8Array(CHUNK_BYTES+17).fill(217));await a.engine.changed('bad.mov');await settle(a);
    const doc=(await a.remote.getDocument('bad.mov'))!,r=doc.manifest!,m=await decryptMetadata(f.key,r,syncPath);
    if(failure==='missing')f.wire.records.delete(m.chunks[1]!);
    if(failure==='corrupt') {const chunk=f.wire.records.get(m.chunks[1]!)!;const raw=Buffer.from(chunk.ciphertext as string,'base64url');raw[0]=raw[0]!^1;chunk.ciphertext=raw.toString('base64url');}
    if(failure==='digest') {
      const couch=await EncryptedCouch.connect(connection,f.wire.http,f.key,syncPath);
      await couch.putManifest(await sealManifest(f.key,{...m,hash:'0'.repeat(64)},r.salt),r._rev);
    }
    await b.engine.tick();assert.equal(await b.host.vault.read('bad.mov'),null);assert.equal(b.disk.files['bad.mov'],undefined);
    assert.ok(b.disk.incoming['bad.mov']);
  } finally {await a.close();await b.close();}
});

for(const boundary of ['captured','installed'] as const)test(`staged installation crash after ${boundary} preserves captured local edits`,async()=>{
  const f=await fixture(),a=await device(await f.remote()),b=await device(await f.remote());
  try {
    await a.engine.start();await b.engine.start();await a.host.seed('race.bin',new Uint8Array(CHUNK_BYTES+4).fill(1));await a.engine.changed('race.bin');await settle(a,b);
    await a.host.seed('race.bin',new Uint8Array(CHUNK_BYTES+4).fill(2));await a.engine.changed('race.bin');await settle(a);
    await b.host.seed('race.bin',new Uint8Array(CHUNK_BYTES+4).fill(3));let crashed=false;
    const rename=b.host.adapter.rename,copy=b.host.adapter.copy;
    b.host.adapter.rename=async(from,to)=>{await rename(from,to);if(boundary==='captured'&&!crashed){crashed=true;throw new PersistenceFailure('simulated crash');}};
    b.host.adapter.copy=async(from,to)=>{await copy(from,to);if(boundary==='installed'&&to==='race.bin'&&!crashed){crashed=true;throw new PersistenceFailure('simulated crash');}};
    await b.engine.tick();await b.restart();await b.engine.retry();await settle(a,b);
    assert.equal((await readFile(join(b.host.root,'race.bin')))[0],2);
    const copies=(await b.host.vault.listFiles()).filter(p=>p.includes('.sync-conflict-'));
    assert.ok(copies.length>=1);assert.ok((await Promise.all(copies.map(p=>readFile(join(b.host.root,p))))).some(v=>v[0]===3));
  } finally {await a.close();await b.close();}
});

test('large Markdown retains text semantics and exact bytes through staged transfer',async()=>{
  const f=await fixture(),a=await device(await f.remote()),b=await device(await f.remote());
  try {
    await a.engine.start();await b.engine.start();const text='\ufeff# Ærlig\n'.repeat(40000);
    await a.host.seed('large.md',new TextEncoder().encode(text));await a.engine.changed('large.md');await settle(a,b);
    assert.equal(await readFile(join(b.host.root,'large.md'),'utf8'),text);
  } finally {await a.close();await b.close();}
});

for(const deletion of [false,true])test(`large local binary uses disk preservation for remote ${deletion?'deletion':'inline replacement'}`,async()=>{
  const f=await fixture(),a=await device(await f.remote()),b=await device(await f.remote()),c=await device(await f.remote());
  try {
    for(const d of [a,b,c])await d.engine.start();
    await a.host.seed('replace.bin',new Uint8Array(CHUNK_BYTES+7).fill(1));await a.engine.changed('replace.bin');await settle(a,b,c);
    await b.host.seed('replace.bin',new Uint8Array(CHUNK_BYTES+7).fill(3));
    if(deletion)await rm(join(a.host.root,'replace.bin'));else await a.host.seed('replace.bin',new Uint8Array([2]));
    await a.engine.changed('replace.bin');await settle(a);
    // The ordinary buffer-based compare-and-set must not see this binary.
    const original=b.host.vault.compareAndSet.bind(b.host.vault);
    b.host.vault.compareAndSet=async(...args)=>{assert.notEqual(args[0],'replace.bin');return original(...args);};
    await settle(b,a,c);
    for(const d of [a,b,c]) {
      const local=await d.host.vault.read('replace.bin');if(deletion)assert.equal(local,null);else assert.equal(new Uint8Array(local as ArrayBuffer)[0],2);
      const conflict=(await d.host.vault.listFiles()).find(p=>p.includes('.sync-conflict-'));
      assert.ok(conflict);assert.equal((await readFile(join(d.host.root,conflict)))[0],3);
    }
  }finally{await a.close();await b.close();await c.close();}
});

test('schema 5 keeps directories, hidden files, Canvas, renames and three-client Markdown conflicts',async()=>{
  const f=await fixture(),a=await device(await f.remote()),b=await device(await f.remote()),c=await device(await f.remote());
  try {
    for(const d of [a,b,c])await d.engine.start();
    await mkdir(join(a.host.root,'empty'));await a.engine.changed('empty/');
    for(const [path,text]of [['.hidden','hidden'],['map.canvas','{"nodes":[]}'],['note.md','original']]) {await a.host.seed(path!,new TextEncoder().encode(text));await a.engine.changed(path!);}
    await settle(a,b,c);
    for(const d of [a,b,c])assert.ok((await d.host.vault.listFiles()).includes('empty/'));
    await a.host.seed('note.md',new TextEncoder().encode('server'));await a.engine.changed('note.md');await settle(a,c);
    await b.host.seed('note.md',new TextEncoder().encode('offline'));await b.engine.changed('note.md');await settle(b,a,c);
    for(const d of [a,b,c]) {assert.equal(await readFile(join(d.host.root,'note.md'),'utf8'),'server');const p=(await d.host.vault.listFiles()).find(p=>p.includes('.sync-conflict-'));assert.ok(p);assert.equal(await readFile(join(d.host.root,p),'utf8'),'offline');}
    await a.host.adapter.rename('.hidden','.renamed');await a.engine.changed('.hidden');await a.engine.changed('.renamed');await settle(a,b,c);
    for(const d of [a,b,c]){assert.equal(await d.host.vault.read('.hidden'),null);assert.equal(await readFile(join(d.host.root,'.renamed'),'utf8'),'hidden');}
  }finally{await a.close();await b.close();await c.close();}
});
