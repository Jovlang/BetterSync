/** Synthetic HTTP + real crypto/engine/disk adapter; never an iPhone RSS claim. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,device,connection} from './schema5-helpers';
import {EncryptedRemote} from '../src/encrypted-remote';
import {syncPath} from '../src/paths';
import {CHUNK_BYTES,MAX_CHUNK_DOCUMENT_BYTES} from '../src/encrypted-protocol';
import type {Http} from '../src/couch-client';
const mode=process.argv[2]??'all';
if(!['all','large','notes','latency'].includes(mode))throw new Error('Use all, large, notes or latency.');
const cases=mode==='latency'?[{size:88*1048576,rtt:50},{size:88*1048576,rtt:100}]:[8*1048576,32*1048576,88000000,88*1048576,200*1048576].map(size=>({size,rtt:0}));
if(mode!=='notes')for(const {size,rtt} of cases) {
  const f=await fixture();let requests=0;
  const http:Http=async(...args)=>{requests++;if(rtt)await new Promise(r=>setTimeout(r,rtt));return f.wire.http(...args);};
  const remote=()=>EncryptedRemote.connect(connection,http,f.key,syncPath);
  const a=await device(await remote()),b=await device(await remote());
  let peakRss=0;const sampler=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},20);
  try {
    await a.engine.start();await b.engine.start();
    let source:Uint8Array<ArrayBuffer>|undefined=new Uint8Array(size);
    // Deterministic nonconstant bytes; encryption/transport do not compress them.
    for(let i=0;i<source.length;i++)source[i]=(i*31+(i>>>8))&255;
    const expected=createHash('sha256').update(source).digest('hex');await a.host.seed('benchmark.mov',source);source=undefined;
    requests=0;await a.engine.changed('benchmark.mov');const start=performance.now();await a.engine.tick();const uploadMs=performance.now()-start,uploadRequests=requests;
    requests=0;const download=performance.now();await b.engine.tick();const downloadMs=performance.now()-download;
    assert.equal(createHash('sha256').update(await readFile(join(b.host.root,'benchmark.mov'))).digest('hex'),expected);
    assert.equal(f.wire.chunkPuts,Math.ceil(size/CHUNK_BYTES));assert.ok(f.wire.maxBody<=MAX_CHUNK_DOCUMENT_BYTES);
    assert.equal(a.remote.diagnostics.peakSourceBytes,size);assert.equal(a.remote.diagnostics.sourceBytes,0);
    console.log(JSON.stringify({kind:'large',size,addedRttMs:rtt,uploadMs,downloadMs,uploadRequests,downloadRequests:requests,chunkPuts:f.wire.chunkPuts,maxBody:f.wire.maxBody,
      sourceLeasePeak:a.remote.diagnostics.peakSourceBytes,chunkBytes:a.remote.diagnostics.maxChunkBytes,
      finalJournalBytes:JSON.stringify(a.disk).length,syntheticProcessPeakRss:peakRss}));
  } finally {clearInterval(sampler);await a.close();await b.close();}
}
if(mode==='all'||mode==='notes')for(const rtt of [0,50,100]) {
  const f=await fixture();let delay=0,requests=0,bulkGets=0;
  const http:Http=async(...args)=>{requests++;if(args[0].includes('/_bulk_get'))bulkGets++;if(delay)await new Promise(r=>setTimeout(r,delay));return f.wire.http(...args);};
  const remote=()=>EncryptedRemote.connect(connection,http,f.key,syncPath);
  const a=await device(await remote());let b:Awaited<ReturnType<typeof device>>|undefined;
  try {
    await a.engine.start();for(let i=0;i<1000;i++){const path=`note-${i}.md`;await a.host.seed(path,new TextEncoder().encode('# Synthetic '+i+'\n'+('text '.repeat(100))));await a.engine.changed(path);}
    delay=rtt;requests=0;let start=performance.now();await a.engine.tick();const uploadMs=performance.now()-start,uploadRequests=requests;
    await a.engine.tick();b=await device(await remote());requests=0;bulkGets=0;start=performance.now();await b.engine.start();const downloadMs=performance.now()-start;
    assert.equal((await b.host.vault.listFiles()).length,1000);assert.equal(Object.keys(b.disk.incoming).length,0);
    assert.equal(await readFile(join(b.host.root,'note-999.md'),'utf8'),'# Synthetic 999\n'+('text '.repeat(100)));
    console.log(JSON.stringify({kind:'notes',count:1000,addedRttMs:rtt,uploadMs,uploadRequests,downloadMs,downloadRequests:requests,bulkGets}));
  } finally {await a.close();await b?.close();}
}
