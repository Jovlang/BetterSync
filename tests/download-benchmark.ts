/** Download-only sensitivity experiment. Synthetic delays are not iPhone measurements. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,device,connection} from './schema5-helpers';
import {diskHost} from './encrypted-filesystem';
import {EncryptedRemote} from '../src/encrypted-remote';
import {StateStore,freshState} from '../src/local-state';
import {SyncEngine} from '../src/sync-engine';
import {syncPath} from '../src/paths';
import {withTimeout} from '../src/http';
import type {Http} from '../src/couch-client';
import type {SyncStatus} from '../src/types';

const size=83_000_000;
const pause=(ms:number)=>ms?new Promise<void>(resolve=>setTimeout(resolve,ms)):Promise.resolve();
const f=await fixture(),source=await device(await f.remote());
try {
  await source.engine.start();
  const bytes=new Uint8Array(size);
  for(let i=0;i<size;i++)bytes[i]=(i*31+(i>>>8))&255;
  const expected=createHash('sha256').update(bytes).digest('hex');
  await source.host.seed('synthetic-video.mkv',bytes);
  await source.engine.changed('synthetic-video.mkv');await source.engine.tick();
  assert.ok(await source.remote.getDocument('synthetic-video.mkv'));
  for(const [rttMs,saveMs] of [[0,0],[100,0],[0,100],[100,100]]) {
    const host=await diskHost();
    let enabled=false,requests=0,networkMs=0,reads=0,readBytes=0,readMs=0,appendCalls=0,appendMs=0,maxSavedBytes=0;
    const http:Http=async(...args)=>{
      const start=performance.now();if(enabled){requests++;await pause(rttMs!);}
      try{return await f.wire.http(...args);}finally{if(enabled)networkMs+=performance.now()-start;}
    };
    const remote=await EncryptedRemote.connect(connection,withTimeout(http),f.key,syncPath);
    const store=new StateStore(freshState(remote.stateBinding),async state=>{
      if(enabled)await pause(saveMs!);
      // Model serialization as well as save latency, retaining no note bodies.
      maxSavedBytes=Math.max(maxSavedBytes,Buffer.byteLength(JSON.stringify(state)));
    });
    const read=host.adapter.readBinary;
    host.adapter.readBinary=async path=>{
      const start=performance.now(),result=await read(path);
      if(enabled){reads++;readBytes+=result.byteLength;readMs+=performance.now()-start;}return result;
    };
    const append=host.adapter.appendBinary;
    host.adapter.appendBinary=async(...args)=>{
      const start=performance.now();await append(...args);
      if(enabled){appendCalls++;appendMs+=performance.now()-start;}
    };
    let status:SyncStatus='Syncing…';
    const engine=new SyncEngine(host.vault,remote,store,{status:s=>{status=s;},notice:()=>{},log:()=>{},confirm:async d=>d});
    try {
      enabled=true;const start=performance.now();await engine.start();
      const firstCycleMs=performance.now()-start,firstStatus=String(status);
      const firstReads=reads,firstReadBytes=readBytes;
      let extraCycles=0;
      // Poll scheduling is excluded; report extra cycles explicitly instead.
      while(String(status)!=='Synced'&&extraCycles<5){extraCycles++;await engine.tick();}
      const syncedMs=performance.now()-start;
      assert.equal(status,'Synced');assert.equal(Object.keys(store.state.incoming).length,0);
      assert.equal(createHash('sha256').update(await readFile(join(host.root,'synthetic-video.mkv'))).digest('hex'),expected);
      console.log(JSON.stringify({size,addedRttMs:rttMs,addedSaveMs:saveMs,firstCycleMs,firstStatus,syncedMs,extraCycles,
        requests,networkMs,reads,readBytes,readMs,firstReads,firstReadBytes,appendCalls,appendMs,maxSavedBytes,
        journal:store.diagnostics,timings:remote.timings}));
    }finally{await engine.stop();await host.cleanup();}
  }
}finally{await source.close();}
