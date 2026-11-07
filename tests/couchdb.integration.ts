/** Real CouchDB wire test. Uses disposable CI database; never a user's vault. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CouchClient,type Http} from '../src/couch-client';
import {Device,settle} from './helpers';
import {SyncFailure} from '../src/types';
import {documentId,decodeBinary,encodeBinary,rawHash} from '../src/paths';
import {CouchConfiguration} from '../src/couch-configuration';
import {EncryptedCouch} from '../src/encrypted-couch';
import {EncryptedRemote} from '../src/encrypted-remote';
import {syncPath} from '../src/paths';
import {EncryptionSetup, generateRecoveryCode, createConfiguration, importRecoveryCode, CONFIGURATION_ID, type SetupIntent} from '../src/encryption-setup';
import {freshEncryptedTree} from './encrypted-filesystem';
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

test('real CouchDB: 88 MiB encrypted attachment is atomic after lost upload acknowledgement and validates exact bytes',async()=>{
  const db=database+'-large',url=`${address}/${db}`;
  assert.equal((await fetch(url,{method:'PUT',headers:{Authorization:auth}})).status,201);
  try {
    const connection={url:'https://couchdb.test',database:db,...credentials};
    const key=await importRecoveryCode(generateRecoveryCode());
    await new CouchConfiguration(connection,http).createConfiguration(await createConfiguration(key));
    let lose=true;
    const lossy:Http=async(...args)=>{
      const response=await http(...args);
      if(lose&&args[1]==='PUT'&&args[3] instanceof ArrayBuffer){lose=false;throw new Error('lost acknowledgement');}
      return response;
    };
    const remote=await EncryptedCouch.connect(connection,lossy,key,syncPath);
    const bytes=new Uint8Array(88*1024*1024);bytes.fill(173);
    const expected=createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(()=>remote.put({path:'synthetic.mov',bytes:bytes.buffer,deleted:false,mtime:1}));
    const record=await remote.get('synthetic.mov');assert.ok(record?._attachments);
    assert.match(record._rev!,/^1-/);assert.equal(record._attachments.content.length,bytes.length+16);
    const restored=await remote.download(record);assert.ok(restored.bytes);
    assert.equal(restored.bytes.byteLength,bytes.length);
    assert.equal(createHash('sha256').update(new Uint8Array(restored.bytes)).digest('hex'),expected);
    assert.equal(restored.metadata.hash,expected);
    assert.equal((await remote.changes(0)).results.length,1);
  } finally {assert.equal((await fetch(url,{method:'DELETE',headers:{Authorization:auth}})).status,200);}
});

test('real CouchDB: fresh mixed-file encrypted upload/download materializes identical disk trees',async()=>{
  for(const interrupted of [false,'poll','restart'] as const) {
    const db:string=database+'-mixed-'+interrupted;
    const url:string=`${address}/${db}`;
    assert.equal((await fetch(url,{method:'PUT',headers:{Authorization:auth}})).status,201);
    try {
      const connection={url:'https://couchdb.test',database:db,...credentials};
      const code=generateRecoveryCode(),key=await importRecoveryCode(code);
      await new CouchConfiguration(connection,http).createConfiguration(await createConfiguration(key));
      let attachmentReads=0;
      const traced:Http=async(...args)=>{
        if(args[4]==='binary') {assert.match(args[0],/\/content\?rev=/);attachmentReads++;}
        return http(...args);
      };
      await freshEncryptedTree(async()=>EncryptedRemote.connect(connection,traced,await importRecoveryCode(code),syncPath),interrupted);
      assert.ok(attachmentReads>0);
    } finally {assert.equal((await fetch(url,{method:'DELETE',headers:{Authorization:auth}})).status,200);}
  }
});

test('real CouchDB: encrypted setup, lost response, three clients and native tombstone refusal', async () => {
  const setupDatabase = database + '-encryption';
  const url = `${address}/${setupDatabase}`;
  assert.equal((await fetch(url, {method: 'PUT', headers: {Authorization: auth}})).status, 201);
  try {
    let loseResponse = true, creates = 0;
    const lossy: Http = async (target, method, headers, body, responseType) => {
      const response = await http(target, method, headers, body, responseType);
      if (method === 'PUT') {
        creates++;
        if (loseResponse && response.status === 201) { loseResponse = false; throw new Error('Synthetic lost response.'); }
      }
      return response;
    };
    const connection = {url: 'https://couchdb.test', database: setupDatabase, ...credentials};
    const remote = new CouchConfiguration(connection, lossy);
    await remote.assertEmpty(); assert.equal(await remote.getConfiguration(), null);
    function installation() {
      let intent: SetupIntent | null = null;
      const values = new Map<string, string>();
      const storage = {load: async () => structuredClone(intent), save: async (v: SetupIntent) => { intent = structuredClone(v); }};
      const secrets = {get: async (id: string) => values.get(id) ?? null, set: async (id: string, code: string) => {values.set(id, code);}};
      return {restart: () => new EncryptionSetup('wire-test', storage, secrets, remote), storage};
    }
    const a = installation(), b = installation(), c = installation(), code = generateRecoveryCode();
    await assert.rejects(() => a.restart().createConfirmed(code));
    assert.equal((await a.storage.load())?.phase, 'prepared');
    await a.restart().resume(); await b.restart().join(code); await c.restart().join(code);
    assert.equal(creates, 1);
    const current = await remote.getConfiguration(); assert.ok(current?._rev);
    assert.ok(!JSON.stringify(current).includes(code.split('.')[2]!));
    await assert.rejects(() => remote.assertEmpty());
    const other = await createConfiguration(await importRecoveryCode(generateRecoveryCode()));
    await assert.rejects(() => remote.createConfiguration(other), (e: unknown) => e instanceof SyncFailure && e.kind === 'conflict');
    assert.deepEqual(await remote.getConfiguration(), current);
    const encryptedClients = await Promise.all([0, 1, 2].map(async () => EncryptedCouch.connect(connection, http,
      await importRecoveryCode(code), syncPath)));
    const first = encryptedClients[0]!, path = 'Private Æ/encrypted.md';
    const bytes = new TextEncoder().encode('synthetic wire encryption canary').buffer;
    const saved = await first.put({path, bytes, deleted: false, mtime: 0});
    for (const encrypted of encryptedClients) {
      const fetched = await encrypted.get(path); assert.ok(fetched);
      assert.deepEqual((await encrypted.download(fetched)).bytes, bytes);
    }
    const page = await first.changes(0);
    assert.ok(page.sourceRows >= 2); // Configuration counts toward pagination.
    assert.ok(page.results.some(row => 'record' in row && row.id === saved._id));
    assert.ok(!JSON.stringify(page).includes(path));
    assert.ok(!JSON.stringify(page).includes('synthetic wire encryption canary'));
    const updated = await first.put({path, bytes: new Uint8Array([0, 255, 128]).buffer, deleted: false, mtime: 1}, saved._rev);
    assert.deepEqual((await first.download(saved)).bytes, bytes); // Old revision, not latest bytes.
    await assert.rejects(() => first.put({path, bytes, deleted: false, mtime: 2}, saved._rev),
      (e: unknown) => e instanceof SyncFailure && e.kind === 'conflict');
    const empty = await first.put({path: 'empty.md', bytes: new ArrayBuffer(0), deleted: false, mtime: 0});
    assert.equal((await first.download(empty)).bytes!.byteLength, 0);
    const marker = await first.put({path, deleted: true, mtime: 3}, updated._rev);
    assert.equal(marker._attachments, undefined); assert.equal((await first.download(marker)).metadata.deleted, true);
    const restored = await EncryptedCouch.connect(connection, http, await importRecoveryCode(code), syncPath);
    const restoredMarker = await restored.get(path); assert.ok(restoredMarker);
    assert.equal((await restored.download(restoredMarker)).metadata.deleted, true);
    const engineClients = await Promise.all([0,1,2].map(async()=>new Device(await EncryptedRemote.connect(connection,http,
      await importRecoveryCode(code),syncPath))));
    const [ea,eb,ec]=engineClients as [Device,Device,Device];
    await ea.start();await eb.start();await ec.start();
    await ea.vault.edit('engine.md','base');await settle(ea,eb,ec);
    await ea.vault.edit('engine.md','remote edit');await settle(ea,ec);
    await eb.vault.edit('engine.md','offline edit');await eb.restart();await settle(ea,eb,ec);
    for(const d of engineClients) {assert.equal(await d.vault.read('engine.md'),'remote edit');assert.ok([...d.vault.files.values()].includes('offline edit'));}
    await ec.vault.edit('engine.md',null);await settle(ea,eb,ec);await eb.restart();await settle(ea,eb,ec);
    for(const d of engineClients)assert.equal(await d.vault.read('engine.md'),null);
    // Native deletion is deliberately unsupported: never silently recreate config.
    assert.equal((await fetch(`${url}/${encodeURIComponent(CONFIGURATION_ID)}?rev=${encodeURIComponent(current._rev)}`,
      {method: 'DELETE', headers: {Authorization: auth}})).status, 200);
    await assert.rejects(() => remote.getConfiguration());
    await assert.rejects(() => remote.assertEmpty());
    await assert.rejects(() => a.restart().resume());
  } finally {
    assert.equal((await fetch(url, {method: 'DELETE', headers: {Authorization: auth}})).status, 200);
  }
});
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
