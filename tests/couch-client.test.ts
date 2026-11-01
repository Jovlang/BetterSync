import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CouchClient,validateDocument,type Http} from '../src/couch-client';
import {documentId} from '../src/paths';
import {SyncFailure} from '../src/types';
const connection={url:'https://example.com/couch',database:'vault',username:'jöv',password:'påss'};
const doc={_id:documentId('Æ/Test.md'),_rev:'1-a',schema:1 as const,path:'Æ/Test.md',content:'note',mtime:0,deleted:false};
test('HTTPS, credentials and query-bearing endpoints are validated',()=>{
  for(const url of ['http://example.com','ftp://example.com','https://user:pass@example.com','https://example.com?x=1','nonsense'])
    assert.throws(()=>new CouchClient({...connection,url},async()=>({status:200,json:{}})),SyncFailure);
});
test('UTF-8 basic auth, subpath, database and document URLs are encoded correctly',async()=>{
  const requests:{url:string;method:string;headers:Record<string,string>;body?:string}[]=[];
  const http:Http=async(url,method,headers,body)=>{requests.push({url,method,headers,body});return {status:201,json:{rev:'2-b'}};};
  const client=new CouchClient({...connection,database:'vault name'},http);await client.putDocument(doc);
  assert.equal(requests[0]?.url,`https://example.com/couch/vault%20name/${encodeURIComponent(doc._id)}`);
  assert.equal(requests[0]?.headers.Authorization,'Basic '+Buffer.from('jöv:påss').toString('base64'));
  assert.equal(JSON.parse(requests[0]!.body!).content,'note');
});
for(const [status,kind] of [[401,'configuration'],[403,'configuration'],[404,'configuration'],[409,'conflict'],[429,'temporary'],[503,'temporary'],[400,'data']] as const)
  test(`HTTP ${status} is classified as ${kind}`,async()=>{
    const client=new CouchClient(connection,async()=>({status,json:{}}));
    await assert.rejects(()=>client.testConnection(),(e:unknown)=>e instanceof SyncFailure&&e.kind===kind);
  });
test('missing note is distinct from a missing database',async()=>{
  const client=new CouchClient(connection,async()=>({status:200,json:{rows:[{key:doc._id,error:'not_found'}]}}));
  assert.equal(await client.getDocument(doc.path),null);
});
test('deletion remains a normal durable document with empty content',async()=>{
  let body='';const client=new CouchClient(connection,async(_u,_m,_h,b)=>{body=b!;return {status:201,json:{rev:'2-a'}};});
  await client.deleteDocument(doc);const sent=JSON.parse(body);assert.equal(sent.deleted,true);assert.equal(sent.content,'');assert.equal(sent._deleted,undefined);
});
test('opaque CouchDB checkpoints are round-tripped without parsing',async()=>{
  const seq='7-g1AAA+++///';let url='';
  const client=new CouchClient(connection,async(u)=>{url=u;return {status:200,json:{results:[],last_seq:seq}};});
  assert.equal((await client.getChanges(seq)).last_seq,seq);assert.equal(new URL(url).searchParams.get('since'),seq);
});
test('untrusted server paths and identity mismatches cannot reach the vault',()=>{
  for(const path of ['../escape.md','/root.md','.obsidian/config.md','folder\\bad.md','a//b.md'])assert.throws(()=>validateDocument({...doc,path,_id:documentId(path)}));
  assert.throws(()=>validateDocument({...doc,_id:'file:wrong'}));assert.deepEqual(validateDocument(doc),doc);
});
test('network exceptions expose no request or credential details',async()=>{
  const client=new CouchClient(connection,async()=>{throw new Error('Authorization: secret');});
  await assert.rejects(()=>client.testConnection(),(e:unknown)=>e instanceof SyncFailure&&e.kind==='temporary'&&!e.message.includes('secret'));
});
test('HTTP timeout releases the engine even if the underlying request hangs',async()=>{
  const {withTimeout}=await import('../src/http');
  const client=new CouchClient(connection,withTimeout(async()=>new Promise(()=>{}),5));
  await assert.rejects(()=>client.testConnection(),(e:unknown)=>e instanceof SyncFailure&&e.kind==='temporary');
});
