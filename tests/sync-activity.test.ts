import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityFailure, activityLabel, SyncActivity} from '../src/sync-activity';
import {SyncEngine} from '../src/sync-engine';
import {freshState, StateStore} from '../src/local-state';
import {SyncFailure, type SyncStatus} from '../src/types';
import {MemoryRemote, MemoryVault} from './helpers';
import {documentId} from '../src/paths';

test('activity tracks nested work and progress without clearing a failure while retrying',()=>{
  const activity=new SyncActivity(()=>42,2);
  activity.accept({type:'start',direction:'upload',path:'clip.mov'});
  activity.accept({type:'progress',path:'clip.mov',done:1,total:4});
  activity.accept({type:'start',direction:'download',path:'note.md'});
  activity.accept({type:'stage',path:'note.md'});
  assert.equal(activity.active[0]?.percent,25);
  assert.equal(activityLabel(activity.active[1]!), 'Apply change: note.md');
  for(let i=0;i<3;i++)activity.accept({type:'end',direction:'download',path:'note.md',failure:'Will retry.'});
  assert.equal(activity.recent.length,1);
  activity.accept({type:'start',direction:'download',path:'note.md'});
  assert.equal(activity.failures.size,1);
  activity.accept({type:'end',direction:'download',path:'note.md',pending:true});
  assert.equal(activity.failures.size,1);
  activity.accept({type:'end',direction:'download',path:'note.md',completed:true});
  activity.accept({type:'end',direction:'upload',path:'clip.mov',completed:true});
  assert.equal(activity.failures.size,0);
  assert.equal(activity.active.length,0);
  assert.deepEqual(activity.recent.map(item=>[item.at,item.label,item.failure]),[
    [42,'Upload: clip.mov',undefined],[42,'Download: note.md',undefined]
  ]);
});

test('failure summaries do not expose raw exception text',()=>{
  const secret='raw server response with password and recovery code';
  for(const error of [new Error(secret),new SyncFailure('configuration',secret),new SyncFailure('temporary',secret)]) {
    assert.ok(!activityFailure(error).includes(secret));
  }
  assert.match(activityFailure(new Error('File exceeds 200 MiB.')), /200 MiB/);
});

test('engine reports active uploads, failed local application and recovery without logging unchanged files',async()=>{
  const remote=new MemoryRemote(),vault=new MemoryVault(),activity=new SyncActivity();
  const store=new StateStore(freshState('test'),async()=>{});
  const engine=new SyncEngine(vault,remote,store,{
    activity:event=>activity.accept(event),status:()=>{},notice:()=>{},log:()=>{},confirm:async direction=>direction
  });
  vault.onChange=path=>engine.changed(path);
  await engine.start();
  await vault.edit('outgoing.md','private note');
  remote.beforePut=async()=>assert.equal(activityLabel(activity.active[0]!), 'Upload: outgoing.md');
  await engine.tick();
  assert.equal(activity.recent.length,1);
  await engine.changed('outgoing.md');await engine.tick();
  assert.equal(activity.recent.length,1);
  await remote.putDocument({_id:documentId('incoming.md'),schema:1,path:'incoming.md',mtime:0,deleted:false,content:'private note'});
  vault.failPath='incoming.md';
  await engine.tick();await engine.tick();
  assert.equal(activity.active.length,0);
  assert.equal(activity.failures.size,1);
  assert.match(activity.recent[0]?.label??'',/incoming.md/);
  assert.equal(activity.recent.length,2);
  vault.failPath=undefined;
  await engine.retry();
  assert.equal(activity.failures.size,0);
  assert.equal(await vault.read('incoming.md'),'private note');
  assert.ok(!JSON.stringify(activity.recent).includes('private note'));
});

test('offline is reported without assigning an unknown failure to a file',async()=>{
  const remote=new MemoryRemote(),activity=new SyncActivity();
  const statuses:SyncStatus[]=[];
  const engine=new SyncEngine(new MemoryVault(),remote,new StateStore(freshState('test'),async()=>{}),{
    activity:event=>activity.accept(event),status:status=>statuses.push(status),notice:()=>{},log:()=>{},confirm:async d=>d
  });
  await engine.start();
  remote.offline=true;await engine.tick();
  assert.equal(statuses.at(-1),'Offline');
  assert.equal(activity.failures.get('cycle')?.label,'Sync check');
  remote.offline=false;await engine.tick();
  assert.equal(statuses.at(-1),'Synced');
  assert.equal(activity.failures.size,0);
});

test('startup creates no activity for a locally absent tombstone',async()=>{
  const path='deleted/node_modules/old.js';
  const remote=new MemoryRemote(),vault=new MemoryVault(),activity=new SyncActivity(),labels:string[]=[];
  const doc=await remote.putDocument({_id:documentId(path),schema:2,path,mtime:0,deleted:true});
  const state=freshState('test');state.initialized=true;state.lastSequence=1;
  state.files[path]={rev:doc._rev!,hash:null};
  const engine=new SyncEngine(vault,remote,new StateStore(state,async()=>{}),{
    activity:event=>{activity.accept(event);for(const work of activity.active)labels.push(activityLabel(work));},
    status:()=>{},notice:()=>{},log:()=>{},confirm:async d=>d
  });
  let sent=false;remote.beforePut=async()=>{sent=true;};
  await engine.start();
  assert.deepEqual(labels,[]);
  assert.equal(sent,false);
  assert.deepEqual(activity.recent,[]);
});

test('a new local deletion is labeled as sending a deletion, not uploading the file',async()=>{
  const path='note.md',remote=new MemoryRemote(),vault=new MemoryVault(),activity=new SyncActivity();
  const engine=new SyncEngine(vault,remote,new StateStore(freshState('test'),async()=>{}),{
    activity:event=>activity.accept(event),status:()=>{},notice:()=>{},log:()=>{},confirm:async d=>d
  });
  vault.onChange=p=>engine.changed(p);
  await engine.start();
  await vault.edit(path,'content');await engine.tick();
  await vault.edit(path,null);
  remote.beforePut=async()=>assert.equal(activityLabel(activity.active[0]!), 'Send deletion: '+path);
  await engine.tick();
  assert.equal(activity.recent[0]?.label,'Send deletion: '+path);
});
