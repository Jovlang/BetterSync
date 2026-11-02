/** Real CouchDB wire test. Uses disposable CI database; never a user's vault. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CouchClient,type Http} from '../src/couch-client';
import {Device,settle} from './helpers';
import {SyncFailure} from '../src/types';
import {documentId,decodeBinary,encodeBinary,rawHash} from '../src/paths';
const address=process.env.BETTERSYNC_TEST_SERVER;
if(!address)throw new Error('Set BETTERSYNC_TEST_SERVER to a disposable local CouchDB instance.');
const credentials={username:'bettersync-test',password:'local-ci-only'};
const auth='Basic '+Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
const database='bettersync-test-'+Date.now();
// HTTPS is mandatory in production. CI routes its logical HTTPS endpoint to
// a loopback-only HTTP Docker service through this injected test transport.
const http:Http=async(url,method,headers,body,responseType)=>{
  const remote=new URL(url),base=new URL(address);
  remote.protocol=base.protocol;remote.host=base.host;
  const response=await fetch(remote,{method,headers,body});
  return responseType==='binary'?{status:response.status,arrayBuffer:await response.arrayBuffer()}:{status:response.status,json:await response.json()};
};
const client=()=>new CouchClient({url:'https://couchdb.test',database,...credentials},http);
test('real CouchDB: three clients, conflicts, restart, deletes, Unicode and stale writes',async()=>{
  const response=await fetch(`${address}/${database}`,{method:'PUT',headers:{Authorization:auth}});
  assert.equal(response.status,201);
  try {
    const a=new Device(client()),b=new Device(client()),c=new Device(client());
    await a.start();await b.start();await c.start();
    await a.vault.edit('attachment.bin','AP+A');await a.vault.edit('empty/','directory');await settle(a,b,c);
    for(const d of [a,b,c]) {assert.equal(await d.vault.read('attachment.bin'),'AP+A');assert.equal(await d.vault.read('empty/'),'directory');}
    const binary=await client().getDocument('attachment.bin');assert.ok(binary);
    assert.equal(binary.schema,3);assert.equal(binary.content,undefined);
    assert.equal(binary._attachments?.content.stub,true);assert.equal(binary._attachments?.content.length,3);
    assert.equal('data' in binary._attachments!.content,false);
    const feed=await client().getChanges(0);
    const changed=feed.results.find(row=>row.id===binary._id)!.doc as typeof binary;
    assert.equal(changed.content,undefined);assert.equal(changed._attachments?.content.stub,true);
    assert.equal('data' in changed._attachments!.content,false);
    assert.equal(encodeBinary(await client().getAttachment(changed)),'AP+A');
    // A clean restore downloads attachment bytes through the engine, not inline JSON.
    const restored=new Device(client());await restored.start();await settle(restored);
    assert.equal(await restored.vault.read('attachment.bin'),'AP+A');
    await a.vault.edit('attachment.bin','AQID');await settle(a,b,c);
    // Pin an older revision even after a newer winner exists.
    assert.equal(encodeBinary(await client().getAttachment(binary)),'AP+A');
    await assert.rejects(()=>client().putDocument(binary,decodeBinary('AP+A')),
      (e:unknown)=>e instanceof SyncFailure&&e.kind==='conflict');
    // Existing schema 2 records require no migration, then upgrade on a real edit.
    await client().putDocument({_id:documentId('legacy.bin'),schema:2,path:'legacy.bin',content:'CQ==',mtime:0,deleted:false});
    await settle(a,b,c);assert.equal(await b.vault.read('legacy.bin'),'CQ==');
    await b.vault.edit('legacy.bin','CA==');await settle(a,b,c);
    assert.equal((await client().getDocument('legacy.bin'))?.schema,3);
    await a.vault.edit('attachment.bin',null);await settle(a,b,c);
    const marker=await client().getDocument('attachment.bin');assert.ok(marker?.deleted);
    assert.equal(marker._attachments,undefined);assert.equal(marker.content,'');
    assert.equal('_deleted' in marker,false);
    const compact=await fetch(`${address}/${database}/_compact`,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'}});
    assert.equal(compact.status,202);
    for(let attempt=0;attempt<100;attempt++) {
      const info=await (await fetch(`${address}/${database}`,{headers:{Authorization:auth}})).json() as {compact_running:boolean};
      if(!info.compact_running)break;
      assert.ok(attempt<99,'compaction finished');await new Promise(resolve=>setTimeout(resolve,50));
    }
    await restored.restart();await settle(restored);
    assert.equal(await restored.vault.read('attachment.bin'),null);
    assert.equal((await client().getDocument('attachment.bin'))?.deleted,true);
    // Larger than CouchDB's default JSON document limit; attachment bytes are exempt.
    // Also exercise a valid zero-length MIME attachment.
    for(const size of [0,9*1024*1024]) {
      const data=Uint8Array.from({length:size},(_,i)=>i%256).buffer,path=`wire-${size}.bin`;
      const saved=await client().putDocument({_id:documentId(path),schema:3,path,mtime:0,deleted:false,
        size,hash:rawHash(data),_attachments:{content:{stub:true,content_type:'application/octet-stream',length:size}}},data);
      const page=await client().getChanges(0);
      const record=page.results.find(row=>row.id===saved._id)!.doc as typeof saved;
      assert.equal(record.content,undefined);assert.equal(record._attachments?.content.stub,true);
      assert.ok(JSON.stringify(record).length<1024);
      assert.deepEqual(await client().getAttachment(record),data);
      await client().deleteDocument(saved);
    }
    const path='Norsk/Handleliste æøå 🥰.md';
    await a.vault.edit(path,'base');await settle(a,b,c);
    assert.equal(await b.vault.read(path),'base');assert.equal(await c.vault.read(path),'base');
    const old=await client().getDocument(path);assert.ok(old);
    await a.vault.edit(path,'winner');await settle(a,c);
    await b.vault.edit(path,'offline version');await b.restart();await settle(a,b,c);
    for(const d of [a,b,c]){assert.equal(await d.vault.read(path),'winner');assert.ok([...d.vault.files.values()].includes('offline version'));}
    await assert.rejects(()=>client().putDocument({...old,content:'stale'}),(e:unknown)=>e instanceof SyncFailure&&e.kind==='conflict');
    await c.vault.edit(path,null);await settle(a,b,c);await b.restart();await settle(a,b,c);
    for(const d of [a,b,c])assert.equal(await d.vault.read(path),null);
    assert.equal((await client().getDocument(path))?.deleted,true);
  } finally {await fetch(`${address}/${database}`,{method:'DELETE',headers:{Authorization:auth}});}
});
