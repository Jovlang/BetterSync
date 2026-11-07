import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EncryptedRemote} from '../src/legacy/encrypted-remote';
import {importRecoveryCode, generateRecoveryCode} from '../src/legacy/encryption-setup';
import {freshState, StateStore} from '../src/local-state';
import {SyncEngine} from '../src/sync-engine';
import {Device, settle} from './helpers';
import {fixture, connection, input} from './encrypted-wire';
import {syncPath} from '../src/paths';

async function three() {
  const f=await fixture();
  const devices:Device[]=[];
  for(let i=0;i<3;i++) {
    const remote=await EncryptedRemote.connect(connection,f.wire.http,await importRecoveryCode(f.code),syncPath);
    devices.push(new Device(remote));
  }
  const [a,b,c]=devices as [Device,Device,Device];
  await a.start();await b.start();await c.start();
  return {...f,a,b,c};
}

test('one engine synchronizes encrypted text, binary and directories with offline conflicts on three clients',async()=>{
  const {a,b,c,wire}=await three();
  await a.vault.edit('note.md','base');await a.vault.edit('file.bin','AP+A');await a.vault.edit('empty/','directory');
  await settle(a,b,c);
  for(const d of [a,b,c]) {assert.equal(await d.vault.read('note.md'),'base');assert.equal(await d.vault.read('file.bin'),'AP+A');assert.equal(await d.vault.read('empty/'),'directory');}
  await a.vault.edit('note.md','remote edit');await settle(a,c);
  await b.vault.edit('note.md','offline edit');await b.restart();await settle(a,b,c);
  for(const d of [a,b,c]) {assert.equal(await d.vault.read('note.md'),'remote edit');assert.ok([...d.vault.files.values()].includes('offline edit'));}
  await c.vault.edit('note.md',null);await settle(a,b,c);await b.restart();await settle(a,b,c);
  for(const d of [a,b,c]) assert.equal(await d.vault.read('note.md'),null);
  assert.ok([...wire.records.values()].every(d=>!('path' in d)&&!('content' in d)));
});

test('encrypted journals contain no note bodies and resume exact-revision writes after restart',async()=>{
  const {a,b,c}=await three();
  b.vault.failPath='private.md';
  await a.vault.edit('private.md','private body canary');await settle(a,b,c);
  assert.ok(b.disk.incoming['private.md']?.doc.encrypted);
  assert.ok(!JSON.stringify(b.disk).includes('private body canary'));
  assert.equal(await b.vault.read('private.md'),null);
  b.vault.failPath=undefined;await b.restart();await settle(a,b,c);
  assert.equal(await b.vault.read('private.md'),'private body canary');assert.equal(Object.keys(b.disk.incoming).length,0);
});

test('failed encrypted journal persistence prevents filesystem effects and checkpoint advancement',async()=>{
  const {a,b,c}=await three();await a.vault.edit('a.md','initial');await settle(a,b,c);
  const sequence=b.disk.lastSequence;
  await a.vault.edit('a.md','new');await settle(a,c);
  b.saveFailure=true;await b.tick();assert.equal(await b.vault.read('a.md'),'initial');assert.equal(b.disk.lastSequence,sequence);
  b.saveFailure=false;await b.restart();await settle(a,b,c);assert.equal(await b.vault.read('a.md'),'new');
});

test('crash after encrypted incoming write before baseline save replays without duplicate conflicts',async()=>{
  const {a,b,c}=await three();await a.vault.edit('a.md','old');await settle(a,b,c);
  await a.vault.edit('a.md','new');await settle(a,c);
  const original=b.vault.compareAndSet.bind(b.vault);
  b.vault.compareAndSet=async(...args)=>{const applied=await original(...args);b.saveFailure=true;return applied;};
  await b.tick();assert.equal(await b.vault.read('a.md'),'new');assert.ok(b.disk.incoming['a.md']);
  b.saveFailure=false;b.vault.compareAndSet=original;await b.restart();await settle(a,b,c);
  assert.equal(Object.keys(b.disk.incoming).length,0);assert.equal([...b.vault.files.keys()].filter(p=>p.includes('sync-conflict')).length,0);
});

test('corrupt encrypted records quarantine identities durably while unrelated records continue',async()=>{
  const {a,b,c,wire,client}=await three();
  const bad=await client.put(input('bad.md','remote'));
  const row=wire.history.get(bad._id)!;row.doc.metadata='corrupt';
  await a.vault.edit('good.md','good');await settle(a,b,c);
  assert.equal(await b.vault.read('good.md'),'good');assert.ok(b.disk.rejected?.[bad._id]);
  await b.vault.edit('bad.md','local kept');await b.restart();
  const before=wire.requests.filter(r=>r.method==='PUT').length;await b.tick();
  assert.equal(wire.requests.filter(r=>r.method==='PUT').length,before);assert.equal(await b.vault.read('bad.md'),'local kept');
  await client.put(input('bad.md','repaired'),bad._rev);await settle(a,b,c);
  assert.equal(b.disk.rejected?.[bad._id],undefined);assert.equal(await b.vault.read('bad.md'),'repaired');
  assert.ok([...b.vault.files.values()].includes('local kept'));
});

test('state cannot cross encryption keys, vault identities or legacy bindings',async()=>{
  const {a,wire,code}=await three();
  const otherKey=await importRecoveryCode(generateRecoveryCode());
  const correct=await importRecoveryCode(code);
  assert.notEqual(await otherKey.stateBinding('database'),await correct.stateBinding('database'));
  assert.notEqual(await correct.stateBinding('database'),await correct.stateBinding('other'));
  const store=new StateStore(freshState('legacy'),async()=>{});
  assert.throws(()=>new SyncEngine(a.vault,a.remote,store,{status:()=>{},notice:()=>{},log:()=>{},confirm:async()=> 'cancel'}));
  assert.ok(wire.records.size===0);
});

test('a corrupt newer change blocks replay of an older pending operation until authenticated repair',async()=>{
  const {a,b,c,wire,client}=await three();b.vault.failPath='held.md';
  await a.vault.edit('held.md','old pending');await settle(a,b,c);
  const old=b.disk.incoming['held.md']!.doc.encrypted!;
  const newer=await client.put(input('held.md','new version'),old._rev);
  wire.history.get(newer._id)!.doc.metadata='invalid';await b.tick();
  assert.ok(b.disk.rejected?.[newer._id]);assert.ok(b.disk.incoming['held.md']);
  b.vault.failPath=undefined;await b.restart();assert.equal(await b.vault.read('held.md'),null);
  await client.put(input('held.md','repaired'),newer._rev);await settle(a,b,c);
  assert.equal(await b.vault.read('held.md'),'repaired');
});

test('encrypted Markdown preserves BOM and multi-page downloads finish before queued uploads',async()=>{
  const {a,b,client}=await three();
  await a.vault.edit('bom.md','\ufeffÆrlig');await settle(a,b);
  assert.equal(await b.vault.read('bom.md'),'\ufeffÆrlig');
  for(let i=0;i<205;i++)await client.put(input(`many/${i}.md`,String(i)));
  await b.tick();assert.equal(await b.vault.read('many/204.md'),'204');
  assert.equal(Object.keys(b.disk.incoming).length,0);
});
