import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Device,MemoryRemote,three,settle} from './helpers';
import {documentId,hash,markdown} from '../src/paths';

for(const author of ['a','b','c'] as const) test(`create, edit, rename and delete from device ${author}`,async()=>{
  const all=await three(),d=all[author];const clients=[all.a,all.b,all.c];
  await d.vault.edit('Notater/Blåbær 🥰.md','første');await settle(...clients);
  for(const client of clients)assert.equal(await client.vault.read('Notater/Blåbær 🥰.md'),'første');
  await d.vault.edit('Notater/Blåbær 🥰.md','andre');await settle(...clients);
  for(const client of clients)assert.equal(await client.vault.read('Notater/Blåbær 🥰.md'),'andre');
  await d.vault.edit('Ny.md',await d.vault.read('Notater/Blåbær 🥰.md'));
  await d.vault.edit('Notater/Blåbær 🥰.md',null);await settle(...clients);
  for(const client of clients){assert.equal(await client.vault.read('Ny.md'),'andre');assert.equal(await client.vault.read('Notater/Blåbær 🥰.md'),null);}
  await d.vault.edit('Ny.md',null);await settle(...clients);
  for(const client of clients)assert.equal(await client.vault.read('Ny.md'),null);
});
for(const offline of ['a','b','c'] as const)test(`offline conflict preserves and distributes ${offline}'s version`,async()=>{
  const all=await three(),devices=[all.a,all.b,all.c],stale=all[offline],active=devices.filter(d=>d!==stale);
  await all.a.vault.edit('test.md','base');await settle(...devices);
  await active[0]!.vault.edit('test.md','new main');await settle(...active);
  await stale.vault.edit('test.md','offline version');await stale.restart();await settle(...devices);
  for(const d of devices){assert.equal(await d.vault.read('test.md'),'new main');assert.ok([...d.vault.files.values()].includes('offline version'));assert.equal(d.vault.files.size,2);}
});
test('sequential three-way editing creates no conflict copies or upload loops',async()=>{
  const {a,b,c,remote}=await three();
  for(const [d,text] of [[a,'a'],[b,'b'],[c,'c']] as const){await d.vault.edit('test.md',text);await settle(a,b,c);for(const x of [a,b,c])assert.equal(await x.vault.read('test.md'),text);}
  assert.equal(remote.seq,3);for(const x of [a,b,c])assert.equal(x.vault.files.size,1);
});
test('outage, offline edits, server recovery and all client restarts',async()=>{
  const {a,b,c,remote}=await three();remote.offline=true;
  await a.vault.edit('a.md','offline a');await b.vault.edit('b.md','offline b');
  await settle(a,b,c);assert.equal(a.status,'Offline');await a.restart();await b.restart();
  remote.offline=false;await settle(a,b,c);await c.restart();
  for(const d of [a,b,c]){assert.equal(await d.vault.read('a.md'),'offline a');assert.equal(await d.vault.read('b.md'),'offline b');assert.equal(d.status,'Synced');}
});
test('offline unchanged copies cannot resurrect deletes after restart',async()=>{
  const {a,b,c}=await three();await a.vault.edit('test.md','base');await settle(a,b,c);
  await a.vault.edit('test.md',null);await settle(a,c);await b.restart();await settle(a,b,c);
  for(const d of [a,b,c])assert.equal(await d.vault.read('test.md'),null);
});
test('delete versus offline edit preserves edit in a conflict copy, main stays deleted',async()=>{
  const {a,b,c}=await three();await a.vault.edit('test.md','base');await settle(a,b,c);
  await a.vault.edit('test.md',null);await settle(a,c);await b.vault.edit('test.md','offline');await settle(a,b,c);
  for(const d of [a,b,c]){assert.equal(await d.vault.read('test.md'),null);assert.deepEqual([...d.vault.files.values()],['offline']);}
});
test('offline delete versus newer remote edit preserves the remote edit',async()=>{
  const {a,b,c}=await three();await a.vault.edit('test.md','base');await settle(a,b,c);
  await a.vault.edit('test.md','new');await settle(a,c);await b.vault.edit('test.md',null);await settle(a,b,c);
  for(const d of [a,b,c])assert.equal(await d.vault.read('test.md'),'new');assert.ok(b.notices.some(n=>n.includes('conflict')));
});
test('a learned deletion permits intentional recreation',async()=>{
  const {a,b,c}=await three();await a.vault.edit('test.md','base');await settle(a,b,c);
  await a.vault.edit('test.md',null);await settle(a,b,c);await b.vault.edit('test.md','recreated');await settle(a,b,c);
  for(const d of [a,b,c])assert.equal(await d.vault.read('test.md'),'recreated');
});
test('409 race refetches and preserves the losing content',async()=>{
  const {a,b,c,remote}=await three();await a.vault.edit('test.md','base');await settle(a,b,c);
  await a.vault.edit('test.md','winner');await b.vault.edit('test.md','loser');
  remote.beforePut=async()=>{await a.tick();};await b.tick();await settle(a,b,c);
  for(const d of [a,b,c]){assert.equal(await d.vault.read('test.md'),'winner');assert.ok([...d.vault.files.values()].includes('loser'));}
});
test('edit during HTTP upload remains pending and is eventually uploaded',async()=>{
  const {a,b,c,remote}=await three();await a.vault.edit('test.md','first');
  remote.beforePut=async()=>{await a.vault.edit('test.md','second');};await a.tick();await settle(a,b,c);
  for(const d of [a,b,c])assert.equal(await d.vault.read('test.md'),'second');
});
test('compare-and-set protects edits made while applying a remote file',async()=>{
  const {a,b,c}=await three();await a.vault.edit('test.md','base');await settle(a,b,c);
  await a.vault.edit('test.md','remote');await a.tick();
  b.vault.beforeCAS=async()=>{await b.vault.edit('test.md','typed during write');};await settle(a,b,c);
  assert.equal(await b.vault.read('test.md'),'remote');assert.ok([...b.vault.files.values()].includes('typed during write'));
});
test('startup finds file edits and deletes made while plugin was closed',async()=>{
  const {a,b,c}=await three();await a.vault.edit('test.md','base');await settle(a,b,c);
  a.vault.files.set('test.md','external');await a.restart();await settle(a,b,c);assert.equal(await b.vault.read('test.md'),'external');
  a.vault.files.delete('test.md');await a.restart();await settle(a,b,c);assert.equal(await c.vault.read('test.md'),null);
});
test('first setup upload, download, cancellation and ambiguous refusal',async()=>{
  const r=new MemoryRemote(),a=new Device(r);a.vault.files.set('local.md','local');a.choice='cancel';await a.start();assert.equal(r.seq,0);
  a.choice='upload';await a.engine.retry();assert.equal(r.seq,1);
  const b=new Device(r);await b.start();assert.equal(await b.vault.read('local.md'),'local');
  const c=new Device(r);c.vault.files.set('other.md','other');await c.start();assert.equal(c.status,'Sync error');assert.equal(c.disk.initialized,false);assert.equal(c.vault.files.size,1);
});
test('crash after journal save before write resumes without extra conflicts',async()=>{
  const {a,b,c}=await three();await a.vault.edit('test.md','base');await settle(a,b,c);
  await a.vault.edit('test.md','remote');await a.tick();b.vault.failPath='test.md';await b.tick();
  assert.ok(b.disk.incoming['test.md']);b.vault.failPath=undefined;await b.restart();await settle(a,b,c);
  assert.equal(await b.vault.read('test.md'),'remote');assert.equal(b.vault.files.size,1);
});
for(const deletion of [false,true])test(`failed incoming journal save blocks ${deletion?'deletion':'replacement'} until durable, including after restart`,async()=>{
  const {a,b,c}=await three();await a.vault.edit('test.md','base');await settle(a,b,c);
  await a.vault.edit('test.md',deletion?null:'remote');await a.tick();
  b.saveFailure=true;await b.tick();
  assert.ok(b.store.state.incoming['test.md']);assert.equal(b.disk.incoming['test.md'],undefined);
  // Repeated polls must not use the unpersisted in-memory journal.
  await b.tick();await b.tick();
  assert.equal(await b.vault.read('test.md'),'base');assert.equal(b.status,'Sync error');
  b.saveFailure=false;
  // The retry must save the journal before entering the filesystem operation.
  b.vault.beforeCAS=async()=>{
    assert.ok(b.disk.incoming['test.md']);
    b.saveFailure=true;
    throw new Error('Simulated crash before filesystem write');
  };
  await b.tick();assert.ok(b.disk.incoming['test.md']);assert.equal(await b.vault.read('test.md'),'base');
  b.saveFailure=false;await b.restart();await settle(a,b,c);
  for(const d of [a,b,c])assert.equal(await d.vault.read('test.md'),deletion?null:'remote');
  assert.equal(b.disk.incoming['test.md'],undefined);
  assert.equal(b.vault.files.size,deletion?0:1);
});
test('crash after local write before baseline save replays safely',async()=>{
  const {a,b,c}=await three();await a.vault.edit('test.md','base');await settle(a,b,c);
  await a.vault.edit('test.md','new');await a.tick();
  b.vault.beforeCAS=async()=>{b.saveFailure=true;};await b.tick();assert.equal(await b.vault.read('test.md'),'new');
  b.saveFailure=false;await b.restart();await settle(a,b,c);assert.equal(b.vault.files.size,1);assert.equal(await c.vault.read('test.md'),'new');
});
test('one failing note does not stop unrelated remote or local notes',async()=>{
  const {a,b,c}=await three();await a.vault.edit('bad.md','bad');await a.vault.edit('good.md','good');await a.tick();
  b.vault.failPath='bad.md';await b.vault.edit('local.md','local');await b.tick();
  assert.equal(await b.vault.read('good.md'),'good');assert.equal((await a.remote.getDocument('local.md'))?.content,'local');
  await b.tick();assert.equal(await b.vault.read('good.md'),'good');
  b.vault.failPath=undefined;await settle(a,b,c);assert.equal(await b.vault.read('bad.md'),'bad');
});
test('paged bootstrap handles more than a thousand Markdown files',async()=>{
  const {a,b,c}=await three();for(let i=0;i<1050;i++)await a.vault.edit(`folder/${i}.md`,`note ${i}`);
  await settle(a,b,c);assert.equal(b.vault.files.size,1050);assert.equal(c.vault.files.size,1050);
});
test('non-Markdown and internal or traversal paths are excluded',async()=>{
  const {a,remote}=await three();for(const p of ['image.png','.obsidian/secret.md','../outside.md','a//b.md','/absolute.md','x.canvas','a/./b.md']){assert.equal(markdown(p),false);await a.vault.edit(p,'excluded');}
  await a.tick();assert.equal(remote.seq,0);assert.equal(markdown('Norsk/Æ ø å.md'),true);
  assert.equal(documentId('Norsk/Æ ø å.md'),'file:'+Buffer.from('Norsk/Æ ø å.md').toString('base64url'));
  assert.notEqual(hash(''),hash(null));
});
test('all three simultaneously creating the same path retain all three contents',async()=>{
  const {a,b,c}=await three();await a.vault.edit('same.md','A');await b.vault.edit('same.md','B');await c.vault.edit('same.md','C');
  await Promise.all([a.tick(),b.tick(),c.tick()]);await settle(a,b,c);
  for(const d of [a,b,c])assert.deepEqual(new Set(d.vault.files.values()),new Set(['A','B','C']));
});
test('an accepted upload with a lost response is recovered after restart',async()=>{
  const {a,b,c,remote}=await three();await a.vault.edit('lost.md','valuable');
  const put=remote.putDocument.bind(remote);let lose=true;
  remote.putDocument=async doc=>{const saved=await put(doc);if(lose){lose=false;throw new Error('Connection closed after commit');}return saved;};
  await a.tick();await a.restart();await settle(a,b,c);
  for(const d of [a,b,c]){assert.equal(await d.vault.read('lost.md'),'valuable');assert.equal(d.vault.files.size,1);}
});
test('failed first page note cannot block later pages or later local edits',async()=>{
  const {a,b,c}=await three();
  for(let i=0;i<230;i++)await a.vault.edit(`${i}.md`,`${i}`);await a.tick();
  b.vault.failPath='0.md';await b.tick();assert.equal(await b.vault.read('229.md'),'229');
  await a.vault.edit('later.md','later');await a.tick();await b.vault.edit('local-later.md','local later');await b.tick();
  assert.equal(await b.vault.read('later.md'),'later');assert.equal((await a.remote.getDocument('local-later.md'))?.content,'local later');
  b.vault.failPath=undefined;await settle(a,b,c);
});
test('malformed remote records are quarantined while valid records continue',async()=>{
  const {a,b,c,remote}=await three();
  remote.history.push({seq:++remote.seq,id:'file:malformed',doc:{_id:'file:malformed',_rev:'1-x',path:'../escape.md',schema:1,content:'bad',mtime:0,deleted:false}});
  await a.vault.edit('valid.md','valid');await a.tick();await settle(a,b,c);
  assert.equal(await b.vault.read('valid.md'),'valid');assert.equal(await b.vault.read('../escape.md'),null);assert.ok(b.disk.rejected?.['file:malformed']);assert.equal(b.status,'Sync error');
});
for(let seed=1;seed<=4;seed++)test(`convergence under randomized offline edits, deletes and restarts (seed ${seed})`,async()=>{
  const {a,b,c}=await three(),ds=[a,b,c];let value=seed;
  const random=()=>{value=(value*1664525+1013904223)>>>0;return value/4294967296;};
  for(let i=0;i<60;i++){
    const d=ds[Math.floor(random()*3)]!,path=`note-${Math.floor(random()*5)}.md`;
    await d.vault.edit(path,random()<0.2?null:`seed ${seed} edit ${i}`);
    for(const device of ds)if(random()<0.35)await device.tick();
    if(random()<0.1)await d.restart();
  }
  await settle(a,b,c);await a.restart();await b.restart();await c.restart();await settle(a,b,c);
  assert.deepEqual([...a.vault.files].sort(),[...b.vault.files].sort());assert.deepEqual([...a.vault.files].sort(),[...c.vault.files].sort());
});
