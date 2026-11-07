/** Only an explicitly supplied isolated CouchDB test server may be used. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {device,provision,settle} from './schema5-helpers';
import {MAX_CHUNK_DOCUMENT_BYTES} from '../src/encrypted-protocol';
import type {Http} from '../src/couch-client';
const address=process.env.BETTERSYNC_TEST_SERVER;
if(!address)throw new Error('Set BETTERSYNC_TEST_SERVER to an isolated test server.');
const auth='Basic '+Buffer.from('bettersync-test:local-ci-only').toString('base64');

test('real schema-5 CouchDB: 88 MiB chunks, three clients, restart, lost replies, exact bytes and deletion',async()=>{
  const database='bettersync-test-schema5-'+Date.now(),url=address+'/'+database;
  assert.equal((await fetch(url,{method:'PUT',headers:{Authorization:auth}})).status,201);
  const connection={url:'https://couchdb.test',database,username:'bettersync-test',password:'local-ci-only'};
  let loseChunk=true,loseManifest=true,maxBody=0,chunkWrites=0;
  const http:Http=async(target,method,headers,body)=>{
    assert.equal(body instanceof ArrayBuffer,false);
    maxBody=Math.max(maxBody,typeof body==='string'?Buffer.byteLength(body):0);
    const u=new URL(target),base=new URL(address);u.protocol=base.protocol;u.host=base.host;
    const response=await fetch(u,{method,headers,body}),json=await response.json();
    if(method==='PUT'&&u.pathname.includes('/c5%3A')&&response.status===201){chunkWrites++;if(loseChunk){loseChunk=false;throw new Error('lost chunk acknowledgement');}}
    if(method==='PUT'&&u.pathname.includes('/f5%3A')&&response.status===201&&loseManifest){loseManifest=false;throw new Error('lost manifest acknowledgement');}
    return {status:response.status,json};
  };
  const clients:Awaited<ReturnType<typeof device>>[]=[];
  try {
    const remote=await provision(connection,http);
    for(let i=0;i<3;i++){const d=await device(await remote());clients.push(d);await d.engine.start();}
    const [a,b,c]=clients;
    let bytes:Uint8Array<ArrayBuffer>|undefined=new Uint8Array(88*1024*1024).fill(179);
    const expected=createHash('sha256').update(bytes).digest('hex');await a!.host.seed('large.mov',bytes);bytes=undefined;
    await a!.engine.changed('large.mov');await a!.engine.tick();assert.ok(a!.disk.outgoing?.['large.mov']);
    await new Promise(r=>setTimeout(r,1100));await a!.restart();await new Promise(r=>setTimeout(r,2100));await settle(...clients);
    assert.equal(chunkWrites,352);assert.ok(maxBody<=MAX_CHUNK_DOCUMENT_BYTES);
    for(const d of clients)assert.equal(createHash('sha256').update(await readFile(join(d.host.root,'large.mov'))).digest('hex'),expected);
    const current=await a!.remote.getDocument('large.mov');assert.match(current!._rev!,/^1-/);
    assert.equal((await fetch(url+'/_compact',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'}})).status,202);
    await rm(join(a!.host.root,'large.mov'));await a!.engine.changed('large.mov');await settle(...clients);
    assert.equal((await a!.remote.getDocument('large.mov'))?.deleted,true);
    // Synthetic host models trash below; deletion must not purge shared chunks.
    for(const d of [b!,c!])assert.equal(await d.host.vault.read('large.mov'),null);
    const info=await (await fetch(url,{headers:{Authorization:auth}})).json() as {doc_count:number};assert.equal(info.doc_count,354);
  } finally {for(const d of clients)await d.close();assert.equal((await fetch(url,{method:'DELETE',headers:{Authorization:auth}})).status,200);}
});
