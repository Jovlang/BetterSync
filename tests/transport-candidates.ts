import {base64url,unbase64url} from '../src/legacy/crypto';
/** Isolated representation experiment. No production protocol/settings changes. */
import {randomUUID} from 'node:crypto';
import {generateRecoveryCode,importRecoveryCode} from '../src/legacy/encryption-setup';
import {encryptRecord,decryptRecord} from '../src/legacy/encrypted-protocol';
import {smallNotes} from './benchmark-fixtures';
import {syncPath} from '../src/paths';
const base=new URL(process.env.BETTERSYNC_TEST_SERVER??'http://invalid');
if(!['localhost','127.0.0.1'].includes(base.hostname)||base.pathname!=='/')throw new Error('Isolated loopback CouchDB required.');
const auth='Basic '+Buffer.from('bettersync-test:local-ci-only').toString('base64');
const headers={Authorization:auth,'Content-Type':'application/json'};
const crypto=await importRecoveryCode(generateRecoveryCode());
const records=[];
for(const fixture of smallNotes(1000)){const encrypted=await encryptRecord(crypto,{...fixture,mtime:0,deleted:false});records.push({fixture,...encrypted,body:encrypted.body??unbase64url(encrypted.record.inline!,16,65552).buffer});}
for(const threshold of (process.argv.length>2?process.argv.slice(2).map(Number):[-1,0,16384,65536,262144])) {
  if(![-1,0,16384,65536,262144].includes(threshold))throw new Error('Invalid candidate');
  const db='bettersync-candidates-'+randomUUID(),root=new URL(db+'/',base);
  const create=await fetch(new URL(db,base),{method:'PUT',headers});if(!create.ok)throw new Error('Create failed');
  try {
    // Seed without injected latency; this experiment measures initial download only.
    for(let start=0;start<records.length;start+=100) {
      const docs=records.slice(start,start+100).map(({record,body,fixture})=>{
        const {_attachments,inline,...metadata}=record;
        if(threshold===-1)return {_id:record._id,schema:1,path:fixture.path,content:new TextDecoder().decode(fixture.bytes),mtime:0,deleted:false};
        return threshold>0&&fixture.bytes.byteLength<=threshold
          ? {...metadata,inline:Buffer.from(body!).toString('base64')}
          : {...metadata,_attachments:{content:{content_type:'application/octet-stream',data:Buffer.from(body!).toString('base64')}}};
      });
      const response=await fetch(new URL('_bulk_docs',root),{method:'POST',headers,body:JSON.stringify({docs})});
      const result=await response.json() as {error?:string}[];
      if(!response.ok||result.some(r=>r.error))throw new Error('Seed failed');
    }
    for(const count of [20,200,1000])for(const latency of [0,50,100]) {
      let requests=0,totalBytes=0,maxPageBytes=0,cryptoMs=0;
      const start=performance.now();
      const request=async(url:URL,body?:string)=>{
        requests++;if(latency)await new Promise(r=>setTimeout(r,latency));
        const response=await fetch(url,{headers,method:body?'POST':'GET',body});if(!response.ok)throw new Error('Read failed');
        const bytes=await response.arrayBuffer();totalBytes+=bytes.byteLength;return bytes;
      };
      // Keyed all_docs has the same inline/stub payload shape as include_docs changes.
      // Sorted IDs do not preserve fixture order; explicitly request fixture keys.
      for(let offset=0;offset<count;offset+=200) {
        const selected=records.slice(offset,Math.min(offset+200,count));
        const url=new URL('_all_docs',root);url.searchParams.set('include_docs','true');url.searchParams.set('attachments','false');
        const keys=JSON.stringify({keys:selected.map(r=>r.record._id)});
        const page=await request(url,keys);maxPageBytes=Math.max(maxPageBytes,page.byteLength);
        const rows=JSON.parse(Buffer.from(page).toString()).rows;
        for(let i=0;i<rows.length;i++) {
          const doc=rows[i].doc,expected=selected[i]!;
          if(threshold===-1){if(doc.content!==new TextDecoder().decode(expected.fixture.bytes))throw new Error('Mismatch');continue;}
          const body=doc.inline?new Uint8Array(Buffer.from(doc.inline,'base64')).buffer
            :await request(new URL(encodeURIComponent(doc._id)+'/content?rev='+encodeURIComponent(doc._rev),root));
          const begin=performance.now();
          const opened=await decryptRecord(crypto,{...expected.record,_rev:doc._rev,...(expected.record.inline!==undefined?{inline:base64url(new Uint8Array(body))}:{})},expected.record.inline!==undefined?undefined:body,syncPath);
          cryptoMs+=performance.now()-begin;
          if(!Buffer.from(opened.bytes!).equals(Buffer.from(expected.fixture.bytes)))throw new Error('Mismatch');
        }
      }
      console.log(JSON.stringify({threshold,count,addedRttMs:latency,requests,totalBytes,maxPageBytes,cryptoMs,elapsedMs:performance.now()-start,rss:process.memoryUsage().rss}));
    }
  }finally{await fetch(new URL(db,base),{method:'DELETE',headers});}
}
