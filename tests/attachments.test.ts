import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CouchClient,validateDocument,type Http} from '../src/couch-client';
import {decodeBinary,documentId,encodeBinary,hash,MAX_FILE_BYTES,rawHash} from '../src/paths';
import {SyncFailure,type FileDocument} from '../src/types';
import {Device,settle,three} from './helpers';

const connection={url:'https://example.test',database:'vault',username:'test',password:'test'};
const bytes=Uint8Array.from([0,255,128,13,10,1]).buffer;
function metadata(data=bytes):FileDocument {
  return {_id:documentId('file.bin'),_rev:'1-old',schema:3,path:'file.bin',mtime:0,deleted:false,
    size:data.byteLength,hash:rawHash(data),_attachments:{content:{stub:true,content_type:'application/octet-stream',length:data.byteLength}}};
}
test('schema 3 accepts only bounded binary metadata with a single content stub',()=>{
  assert.deepEqual(validateDocument(metadata()),metadata());
  const bad:unknown[]=[{content:encodeBinary(bytes)},{size:-1},{size:1.5},{size:MAX_FILE_BYTES+1},{hash:'invalid'},
    {_attachments:undefined},{_attachments:{content:{stub:true,length:1,content_type:'application/octet-stream'}}},
    {_attachments:{content:{...metadata()._attachments!.content,data:'AA=='}}},
    {_attachments:{content:{...metadata()._attachments!.content,follows:true}}},
    {path:'file.md',_id:documentId('file.md')},{path:'folder/',_id:documentId('folder/')}];
  for(const patch of bad)assert.throws(()=>validateDocument({...metadata(),...patch as object}));
  assert.equal(validateDocument(metadata(new ArrayBuffer(0))).size,0);
});
test('multipart upload carries raw bytes and expected revision in one PUT',async()=>{
  let calls=0;
  const http:Http=async(url,method,headers,body,responseType)=>{
    calls++;assert.equal(method,'PUT');assert.equal(responseType,'json');
    assert.ok(url.endsWith(encodeURIComponent(metadata()._id)));
    assert.ok(body instanceof ArrayBuffer);
    const boundary=/boundary="([^"]+)"/.exec(headers['Content-Type']!)![1]!;
    const wire=Buffer.from(body), separator=Buffer.from('\r\n\r\n');
    const jsonStart=wire.indexOf(separator)+4,jsonEnd=wire.indexOf(Buffer.from('\r\n--'+boundary),jsonStart);
    const doc=JSON.parse(wire.subarray(jsonStart,jsonEnd).toString());
    assert.equal(doc.schema,3);assert.equal(doc._rev,'1-old');assert.equal(doc.content,undefined);
    assert.equal(doc._attachments.content.follows,true);assert.equal(doc._attachments.content.data,undefined);
    const binaryStart=wire.indexOf(separator,jsonEnd)+4;
    assert.deepEqual(wire.subarray(binaryStart,binaryStart+bytes.byteLength),Buffer.from(bytes));
    assert.equal(wire.subarray(binaryStart+bytes.byteLength).toString(),'\r\n--'+boundary+'--\r\n');
    return {status:201,json:{rev:'2-new'}};
  };
  assert.equal((await new CouchClient(connection,http).putDocument(metadata(),bytes))._rev,'2-new');
  assert.equal(calls,1);
});
test('changes provide stubs; raw download is separate and revision-qualified',async()=>{
  const requests:string[]=[];
  const client=new CouchClient(connection,async(url,_method,_headers,body,responseType)=>{
    requests.push(url);assert.equal(body,undefined);
    const u=new URL(url);
    if(u.pathname.endsWith('_changes')) {
      assert.equal(u.searchParams.get('attachments'),'false');
      return {status:200,json:{results:[{seq:1,id:metadata()._id,doc:metadata()}],last_seq:1}};
    }
    assert.equal(u.pathname.split('/').at(-1),'content');assert.equal(u.searchParams.get('rev'),'1-old');
    assert.equal(responseType,'binary');return {status:200,arrayBuffer:bytes};
  });
  const page=await client.getChanges(0);assert.equal(requests.length,1);
  assert.deepEqual(await client.getAttachment(validateDocument(page.results[0]!.doc)),bytes);
  assert.equal(requests.length,2);
});
for(const corrupted of [new ArrayBuffer(1),new ArrayBuffer(bytes.byteLength)])test(`integrity mismatch (${corrupted.byteLength} bytes) leaves journal, baseline and vault intact`,async()=>{
  const client=new CouchClient(connection,async(url)=>url.includes('_changes')
    ? {status:200,json:{results:[{seq:1,id:metadata()._id,doc:metadata()}],last_seq:1}}
    : {status:200,arrayBuffer:corrupted,json:{}});
  const d=new Device(client);d.store.state.initialized=true;
  d.vault.files.set('file.bin','CQ==');
  await d.start();
  assert.equal(await d.vault.read('file.bin'),'CQ==');assert.equal(d.disk.files['file.bin'],undefined);
  assert.equal(d.disk.incoming['file.bin']?.doc._rev,'1-old');
  assert.equal(d.disk.incoming['file.bin']?.doc.content,undefined);
  assert.equal(d.status,'Sync error');
});
test('attachment upload 409 is surfaced without refetch or retry',async()=>{
  let calls=0;const client=new CouchClient(connection,async()=>{calls++;return {status:409};});
  await assert.rejects(()=>client.putDocument(metadata(),bytes),(e:unknown)=>e instanceof SyncFailure&&e.kind==='conflict');
  assert.equal(calls,1);
});
test('unavailable attachment revision is a per-file failure, not a configuration block',async()=>{
  const client=new CouchClient(connection,async()=>({status:404}));
  await assert.rejects(()=>client.getAttachment(metadata()),(e:unknown)=>e instanceof SyncFailure&&e.kind==='data');
});
test('invalid upload bytes are rejected before any HTTP request',async()=>{
  const client=new CouchClient(connection,async()=>{assert.fail('must not send invalid content');});
  for(const data of [undefined,new ArrayBuffer(1),new ArrayBuffer(bytes.byteLength)])
    await assert.rejects(()=>client.putDocument(metadata(),data),/integrity/);
});
test('binary deletion drops attachment and stays a normal deletion marker',async()=>{
  const client=new CouchClient(connection,async(_u,_m,_h,body)=>{
    assert.equal(typeof body,'string');const sent=JSON.parse(body as string);
    assert.equal(sent.deleted,true);assert.equal(sent.content,'');assert.equal(sent._rev,'1-old');
    for(const key of ['_deleted','_attachments','size','hash'])assert.equal(sent[key],undefined);
    return {status:201,json:{rev:'2-deleted'}};
  });
  await client.deleteDocument(metadata());
});
test('schema 2 binary remains readable and upgrades only on later modification',async()=>{
  const {a,b,c,remote}=await three();
  const legacy:FileDocument={_id:documentId('file.bin'),schema:2,path:'file.bin',mtime:0,deleted:false,content:encodeBinary(bytes)};
  await remote.putDocument(legacy);await settle(a,b,c);
  for(const d of [a,b,c])assert.equal(await d.vault.read('file.bin'),legacy.content);
  assert.equal(remote.docs.get('file.bin')?.schema,2);
  await a.vault.edit('file.bin','CQ==');await settle(a,b,c);
  assert.equal(remote.docs.get('file.bin')?.schema,3);assert.equal(remote.docs.get('file.bin')?.content,undefined);
  for(const d of [a,b,c])assert.equal(await d.vault.read('file.bin'),'CQ==');
});
test('binary 409 upload race preserves and distributes losing bytes across three clients',async()=>{
  const {a,b,c,remote}=await three();await a.vault.edit('file.bin','AA==');await settle(a,b,c);
  await a.vault.edit('file.bin','AQ==');await b.vault.edit('file.bin','Ag==');
  remote.beforePut=async()=>{await a.tick();};await b.tick();await settle(a,b,c);
  for(const d of [a,b,c]) {
    assert.equal(await d.vault.read('file.bin'),'AQ==');
    assert.ok([...d.vault.files].some(([path,content])=>path.includes('.sync-conflict-')&&content==='Ag=='));
  }
});
test('raw buffers retain existing baseline and conflict digests across chunk boundaries',()=>{
  for(const size of [0,1,2,3,32765,32766,32767,100003]) {
    const data=Uint8Array.from({length:size},(_,i)=>i%256).buffer;
    assert.equal(hash(data),hash(encodeBinary(data)));
    assert.deepEqual(decodeBinary(encodeBinary(data)),data);
  }
});
test('download interruption retains metadata-only journal and resumes after offline restart',async()=>{
  const {a,b,c,remote}=await three();
  await a.vault.edit('file.bin','AQID');await a.tick();
  const download=remote.getAttachment.bind(remote);
  remote.getAttachment=async()=>{throw new SyncFailure('temporary','Interrupted download');};
  await b.tick();
  assert.equal(await b.vault.read('file.bin'),null);assert.equal(b.disk.files['file.bin'],undefined);
  assert.equal(b.disk.incoming['file.bin']?.doc.schema,3);
  assert.equal(b.disk.incoming['file.bin']?.doc.content,undefined);
  remote.offline=true;await b.restart();
  assert.ok(b.disk.incoming['file.bin']);
  remote.offline=false;remote.getAttachment=download;await settle(a,b,c);
  for(const d of [a,b,c])assert.equal(await d.vault.read('file.bin'),'AQID');
  assert.deepEqual(Object.keys(b.disk.incoming),[]);
});
