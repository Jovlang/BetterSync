import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PersistentSetupStorage} from '../src/legacy/setup-storage';
import type {SetupIntent} from '../src/legacy/encryption-setup';

const intent: SetupIntent = {version:1,binding:'synthetic',vault:'synthetic',secretName:'synthetic',phase:'prepared',operation:'join'};
test('failed setup saves never become visible and later retries succeed',async()=>{
  let fail=true;
  const storage=new PersistentSetupStorage(null,async()=>{if(fail)throw new Error('sensitive adapter detail');});
  await assert.rejects(()=>storage.save(intent),e=>e instanceof Error&&!e.message.includes('sensitive'));
  assert.equal(await storage.load(),null);
  fail=false;await storage.save(intent);assert.deepEqual(await storage.load(),intent);
});
test('setup writes serialize and snapshot both caller and persistence ownership',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const phases:string[]=[];
  const storage=new PersistentSetupStorage(null,async snapshot=>{
    phases.push(snapshot.phase);if(snapshot.phase==='prepared')await gate;
    snapshot.binding='mutated by persistence adapter';
  });
  const first={...intent},a=storage.save(first);first.binding='mutated by caller';
  const b=storage.save({...intent,phase:'ready'});
  await Promise.resolve();assert.deepEqual(phases,['prepared']);
  release();await Promise.all([a,b]);
  assert.deepEqual(phases,['prepared','ready']);
  const loaded=(await storage.load())!;assert.equal(loaded.binding,'synthetic');assert.equal(loaded.phase,'ready');
  loaded.binding='mutated reader';assert.equal((await storage.load())!.binding,'synthetic');
});
