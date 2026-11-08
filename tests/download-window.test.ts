import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withTimeout,PendingRequestFailure} from '../src/http';
import {fixture,device,connection,settle} from './schema5-helpers';
import {EncryptedRemote} from '../src/encrypted-remote';
import {syncPath} from '../src/paths';
import {CHUNK_BYTES} from '../src/encrypted-protocol';
import type {Http,HttpResponse} from '../src/couch-client';

test('two native downloads stay bounded after timeout; controls work and uploads remain exclusive',async()=>{
  const pending:((r:HttpResponse)=>void)[]=[];
  const wrapped=withTimeout(()=>new Promise(resolve=>pending.push(resolve)),10);
  const get=(id:string)=>wrapped('https://test.invalid/db/_all_docs','POST',{},JSON.stringify({keys:['c5:'+id]}));
  const first=assert.rejects(get('first'),PendingRequestFailure),second=assert.rejects(get('second'),PendingRequestFailure);
  await assert.rejects(get('third'),PendingRequestFailure);
  await Promise.all([first,second]);assert.equal(pending.length,2);
  pending[0]!({status:200});await new Promise(r=>setTimeout(r,0));
  await assert.rejects(get('third'),PendingRequestFailure); // one free slot, one expired native read
  await assert.rejects(wrapped('https://test.invalid/db/c5%3Aupload','PUT',{},'{}'),PendingRequestFailure);
  const control=assert.rejects(wrapped('https://test.invalid/db/control','GET',{}),PendingRequestFailure);
  await control;assert.equal(pending.length,3);
  pending[1]!({status:200});pending[2]!({status:200});await new Promise(r=>setTimeout(r,0));
  const upload=assert.rejects(wrapped('https://test.invalid/db/c5%3Aupload','PUT',{},'{}'),PendingRequestFailure);
  await assert.rejects(get('third'),PendingRequestFailure);
  await upload;assert.equal(pending.length,4);pending[3]!({status:200});
});

test('append failure between paired chunks resumes an odd prefix and checkpoints four new chunks',async()=>{
  const f=await fixture(),a=await device(await f.remote()),b=await device(await f.remote()),c=await device(await f.remote());
  try {
    await a.engine.start();await b.engine.start();await c.engine.start();
    const bytes=new Uint8Array(CHUNK_BYTES*7).fill(19);
    await a.host.seed('resume.bin',bytes);await a.engine.changed('resume.bin');await a.engine.tick();
    const append=b.host.adapter.appendBinary;let appends=0;
    b.host.adapter.appendBinary=async(...args)=>{if(++appends===2)throw new Error('synthetic disk interruption');return append(...args);};
    await b.engine.tick();assert.equal(b.disk.incoming['resume.bin']?.staged?.next,1);
    assert.equal(await b.host.vault.read('resume.bin'),null);
    const checkpoints:number[]=[];
    b.failSave(state=>{const next=state.incoming['resume.bin']?.staged?.next;if(next!==undefined)checkpoints.push(next);return false;});
    await b.restart();assert.ok(checkpoints.includes(5));
    await settle(a,b,c);
    for(const d of [b,c])assert.deepEqual(new Uint8Array(await d.host.vault.read('resume.bin') as ArrayBuffer),bytes);
  }finally{await a.close();await b.close();await c.close();}
});

for(const failure of ['none','offline','corrupt'] as const)test(`download pair orders reversed replies and recovers rejected pair: ${failure}`,async()=>{
  const f=await fixture(),a=await device(await f.remote());
  let active=0,peak=0,calls=0,firstRelease:(()=>void)|undefined,fail=failure!=='none';
  const http:Http=async(...args)=>{
    const body=typeof args[3]==='string'?JSON.parse(args[3]):undefined;
    if(!body?.keys?.[0]?.startsWith('c5:'))return f.wire.http(...args);
    const n=++calls;active++;peak=Math.max(peak,active);
    try {
      if(n%2===1&&n<5)await new Promise<void>(resolve=>{firstRelease=resolve;});
      else if(n%2===0){
        const release=firstRelease;setTimeout(()=>release?.(),10);
        if(fail){
          fail=false;
          if(failure==='offline')throw new Error('synthetic offline');
          const response=structuredClone(await f.wire.http(...args));
          const row=(response.json as {rows:{doc:{ciphertext:string}}[]}).rows[0]!;
          row.doc.ciphertext=(row.doc.ciphertext[0]==='A'?'B':'A')+row.doc.ciphertext.slice(1);
          return response;
        }
      }
      return await f.wire.http(...args);
    }finally{active--;}
  };
  const b=await device(await EncryptedRemote.connect(connection,withTimeout(http),f.key,syncPath)),c=await device(await f.remote());
  try {
    await a.engine.start();await b.engine.start();await c.engine.start();
    const bytes=new Uint8Array(CHUNK_BYTES*4+17);for(let i=0;i<bytes.length;i++)bytes[i]=(i>>>18)+1;
    await a.host.seed('window.bin',bytes);await a.engine.changed('window.bin');await a.engine.tick();
    await b.engine.tick();assert.equal(peak,2);assert.equal(active,0);
    if(failure!=='none'){
      assert.equal(calls,2);assert.equal(b.disk.incoming['window.bin']?.staged?.next,0);
      assert.equal(await b.host.vault.read('window.bin'),null);
      // Restart with an offline pair retained, then explicitly retry its prefix.
      await b.restart();await b.engine.retry();
    }
    await settle(a,b,c);
    for(const d of [b,c])assert.deepEqual(new Uint8Array(await d.host.vault.read('window.bin') as ArrayBuffer),bytes);
    assert.equal(peak,2);
  }finally{firstRelease?.();await a.close();await b.close();await c.close();}
});
