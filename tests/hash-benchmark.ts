/** Paired baseline-hash timing; historical 0.5 algorithm, not a second runtime path. */
import assert from 'node:assert/strict';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {hashAsync} from '../src/paths';
async function previous(buffer:ArrayBuffer) {
  const digest=sha256.create(),bytes=new Uint8Array(buffer),encoder=new TextEncoder();let deadline=performance.now()+8;
  for(let i=0;i<bytes.length;i+=32766) {
    digest.update(encoder.encode(btoa(String.fromCharCode(...bytes.subarray(i,i+32766)))));
    if(performance.now()>=deadline){await new Promise(resolve=>setTimeout(resolve,0));deadline=performance.now()+8;}
  }
  return bytesToHex(digest.digest());
}
const bytes=new Uint8Array(88*1048576);for(let i=0;i<bytes.length;i++)bytes[i]=(i*31+(i>>>8))&255;
let expected:string|null|undefined;
for(let run=0;run<3;run++)for(const name of run%2?['optimized','previous']:['previous','optimized']) {
  const start=performance.now(),digest=await (name==='previous'?previous:hashAsync)(bytes.buffer),ms=performance.now()-start;
  expected??=digest;assert.equal(digest,expected);
  console.log(JSON.stringify({run,algorithm:name,size:bytes.length,ms,exactDigestMatch:true}));
}
