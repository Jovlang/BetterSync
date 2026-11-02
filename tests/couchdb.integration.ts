/** Real CouchDB wire test. Uses disposable CI database; never a user's vault. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CouchClient,type Http} from '../src/couch-client';
import {Device,settle} from './helpers';
import {SyncFailure} from '../src/types';
const address=process.env.BETTERSYNC_TEST_SERVER;
if(!address)throw new Error('Set BETTERSYNC_TEST_SERVER to a disposable local CouchDB instance.');
const credentials={username:'bettersync-test',password:'local-ci-only'};
const auth='Basic '+Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
const database='bettersync-test-'+Date.now();
// HTTPS is mandatory in production. CI routes its logical HTTPS endpoint to
// a loopback-only HTTP Docker service through this injected test transport.
const http:Http=async(url,method,headers,body)=>{
  const remote=new URL(url),base=new URL(address);
  remote.protocol=base.protocol;remote.host=base.host;
  const response=await fetch(remote,{method,headers,body});
  return {status:response.status,json:await response.json()};
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
