import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StateFiles, stateReference} from '../src/state-files';
import {freshState, StateStore} from '../src/local-state';

const dir='obsidian-profile/plugins/bettersync';
const primary=dir+'/sync-state.json',backup=dir+'/sync-state.backup.json';
function fixture() {
  const files=new Map<string,string>(),writes:string[]=[];
  let fail:string|undefined, unreadable:string|undefined;
  const adapter={
    exists:async(path:string)=>files.has(path),
    read:async(path:string)=>unreadable===path?'':files.get(path)!,
    write:async(path:string,value:string)=>{
      writes.push(path);
      if(fail===path){files.set(path,value.slice(0,30));throw new Error('interrupted write');}
      files.set(path,value);
    }
  };
  return {files,writes,open:()=>new StateFiles(adapter,dir),fail:(p?:string)=>{fail=p;},
    unreadable:(p?:string)=>{unreadable=p;}};
}
test('serial state saves retain the previous verified snapshot and round-trip journals',async()=>{
  const f=fixture(), storage=f.open(), state=freshState('target');
  await storage.save(state);
  const store=new StateStore(state,s=>storage.save(s));
  state.initialized=true;
  state.files['Bear.md']={rev:'1-a',hash:null};
  const one=store.save();
  state.files['Bear.md']={rev:'2-b',hash:null};
  state.incoming['Other.md']={doc:{_id:'file:Other',schema:1,path:'Other.md',mtime:0,deleted:true},expected:null};
  const two=store.save();
  await Promise.all([one,two]);
  assert.deepEqual(f.writes,[primary,backup,primary,backup,primary]);
  assert.equal(JSON.parse(f.files.get(backup)!).state.files['Bear.md'].rev,'1-a');
  const loaded=await f.open().load(stateReference(state));
  assert.equal(loaded?.files['Bear.md']?.rev,'2-b');
  assert.deepEqual(loaded?.incoming['Other.md'],state.incoming['Other.md']);
});
test('interruption writing the backup leaves the previous primary usable',async()=>{
  const f=fixture(), store=f.open(), state=freshState('target');
  await store.save(state);
  f.fail(backup);state.lastSequence=12;
  await assert.rejects(store.save(state),/interrupted/);
  assert.equal((await f.open().load(stateReference(state)))?.lastSequence,0);
});
test('interruption replacing the primary pauses on restart; retry does not rewrite the only good copy',async()=>{
  const f=fixture(), store=f.open(), state=freshState('target'),ref=stateReference(state);
  await store.save(state);
  const prior=f.files.get(primary);
  f.fail(primary);state.lastSequence=12;
  await assert.rejects(store.save(state),/interrupted/);
  assert.equal(f.files.get(backup),prior);
  await assert.rejects(f.open().load(ref),/older backup is available/);
  f.fail(backup);
  await store.save(state);
  assert.equal(f.files.get(backup),prior);
  assert.equal((await f.open().load(ref))?.lastSequence,12);
});
test('missing or wrong-installation state cannot be treated as an empty baseline',async()=>{
  const f=fixture(), state=freshState('target');
  assert.equal(await f.open().load(),undefined);
  await assert.rejects(f.open().load(stateReference(state)),/Sync paused/);
  await f.open().save(state);
  assert.equal((await f.open().load())?.clientId,state.clientId); // unclaimed pristine snapshot
  await assert.rejects(f.open().load({...stateReference(state),binding:'other-target'}),/Sync paused/);
  const writer=f.open();
  await writer.load(stateReference(state));
  state.initialized=true;await writer.save(state);
  await assert.rejects(f.open().load(),/Sync paused/);
  // Even well-formed JSON may have changed since it was written.
  f.files.set(primary,f.files.get(primary)!.replace('"initialized":true','"initialized":false'));
  await assert.rejects(f.open().load(stateReference(state)),/older backup/);
});
test('legacy data can be migrated again if the configuration commit was interrupted',async()=>{
  const f=fixture(),state=freshState('target');
  state.initialized=true;state.lastSequence='100-g1';
  const writer=f.open();f.unreadable(primary);
  await assert.rejects(writer.migrate(state),/verified/);
  f.unreadable();
  await f.open().migrate(state);
  assert.equal((await f.open().load(stateReference(state)))?.lastSequence,'100-g1');
});
