import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomFillSync} from 'node:crypto';
import {hash,hashAsync} from '../src/paths';
import {validateMetadata,prepareMetadata,EncryptedChunk,openChunk,CHUNK_BYTES} from '../src/encrypted-protocol';
import {base64url,randomBytes} from '../src/crypto';
import {fixture,device,settle} from './schema5-helpers';

function reference(buffer:ArrayBuffer) {
  const digest=createHash('sha256');
  // Independent Node base64 encoder; block length is divisible by three.
  for(let offset=0;offset<buffer.byteLength;offset+=49152)
    digest.update(Buffer.from(buffer,offset,Math.min(49152,buffer.byteLength-offset)).toString('base64'),'ascii');
  return digest.digest('hex');
}
test('binary baseline digests remain exactly compatible across padding and block boundaries',async()=>{
  const sizes=[...Array.from({length:100},(_,i)=>i),32764,32765,32766,32767,32768,65531,65532,65533,65535,65536,65537,262143,262144,262145];
  for(const size of sizes) {
    const bytes=randomFillSync(new Uint8Array(size)),expected=reference(bytes.buffer);
    assert.equal(hash(bytes.buffer),expected,`sync ${size}`);assert.equal(await hashAsync(bytes.buffer),expected,`async ${size}`);
  }
  for(const text of ['', '\ufeffÆrlig\n🥰', 'directory',null])assert.equal(await hashAsync(text),hash(text));
});
test('88 MiB baseline hash matches independent encoding and yields without shared scratch corruption',async()=>{
  const bytes=new Uint8Array(88*1048576);for(let i=0;i<bytes.length;i++)bytes[i]=(i*31+(i>>>8))&255;
  const expected=reference(bytes.buffer);let yielded=false;
  const timer=setTimeout(()=>{yielded=true;},0);
  try {
    const other=randomFillSync(new Uint8Array(65537));
    const [large,small]=await Promise.all([hashAsync(bytes.buffer),hashAsync(other.buffer)]);
    assert.equal(large,expected);assert.equal(small,reference(other.buffer));assert.ok(yielded);
    assert.equal(hash(bytes.buffer),expected);
  }finally{clearTimeout(timer);}
});
test('validated chunk metadata is immutable, untrusted copies are revalidated, and AAD checks remain active',async()=>{
  const f=await fixture(),bytes=new Uint8Array(CHUNK_BYTES+1).fill(19);
  const m=await prepareMetadata('private.bin',bytes.buffer,false,0);
  assert.equal(validateMetadata(m),m);assert.ok(Object.isFrozen(m));assert.ok(Object.isFrozen(m.chunks));
  assert.throws(()=>{m.size=1;},TypeError);assert.throws(()=>{m.chunks[0]=m.chunks[1]!;},TypeError);
  const copy=structuredClone(m);assert.notEqual(validateMetadata(copy),copy);
  copy.chunks[0]=copy.chunks[1]!;assert.throws(()=>validateMetadata(copy));
  assert.throws(()=>validateMetadata(Object.freeze({...m,size:1})));
  const c={fileId:await f.key.documentId(m.path),salt:base64url(randomBytes(32)),metadata:m,index:0};
  const sealed=await EncryptedChunk.seal(f.key,c,bytes.subarray(0,CHUNK_BYTES)),record={...sealed.record,_rev:'1-test'};
  assert.equal((await openChunk(f.key,c,record)).byteLength,CHUNK_BYTES);
  await assert.rejects(()=>openChunk(f.key,{...c,index:1},record));
  const another=await f.key.documentId('another.bin');
  await assert.rejects(()=>openChunk(f.key,{...c,fileId:another},record));
});
test('unchanged Markdown inventory avoids per-file journal writes',async()=>{
  const f=await fixture(),a=await device(await f.remote());
  try {
    await a.engine.start();
    for(let i=0;i<24;i++){const path=`note-${i}.md`;await a.host.seed(path,new TextEncoder().encode('unchanged'));await a.engine.changed(path);}
    await settle(a);let saves=0;a.failSave(()=>{saves++;return false;});
    for(let i=0;i<24;i++)await a.engine.changed(`note-${i}.md`);
    await a.engine.tick();assert.equal(saves,1,'only the changes-feed checkpoint is written');assert.equal(a.status,'Synced');
  }finally{await a.close();}
});
