import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EncryptedCouch} from '../src/encrypted-couch';
import {createConfiguration, generateRecoveryCode, importRecoveryCode, CONFIGURATION_ID, type VaultConfiguration} from '../src/encryption-setup';
import {type EncryptedRecord, encryptRecord} from '../src/encrypted-protocol';
import type {Http} from '../src/couch-client';
import {SyncFailure} from '../src/types';
import {syncPath} from '../src/paths';

import {fixture, connection, input} from './encrypted-wire';

test('three clients exchange encrypted multipart Markdown and bytes without plaintext HTTP metadata', async () => {
  const {wire, client: a, connect, code} = await fixture(), b = await connect(), c = await connect();
  const source = input(undefined, 'synthetic confidential contents'.repeat(3000)), saved = await a.put(source);
  for (const client of [b, c]) {
    const record = await client.get(source.path); assert.ok(record);
    assert.deepEqual((await client.download(record)).bytes, source.bytes);
  }
  const put = wire.requests.find(r => r.method === 'PUT')!;
  const raw = Buffer.from(put.body as ArrayBuffer).toString('utf8');
  for (const canary of [source.path, 'synthetic confidential contents', code.split('.')[2]!, '123456']) assert.ok(!raw.includes(canary));
  assert.ok(!put.url.includes(encodeURIComponent(source.path)));
  assert.ok(saved._attachments); assert.equal(saved._attachments.content.length, source.bytes.byteLength + 16);
});

test('zero-byte files use encrypted attachments; directories and deletion markers do not', async () => {
  const {client, wire} = await fixture();
  const empty = await client.put(input('empty.md', ''));
  assert.equal(empty._attachments, undefined); assert.ok(empty.inline);
  assert.equal((await client.download(empty)).bytes!.byteLength, 0);
  const directory = await client.put({path: 'empty/', deleted: false, mtime: 0});
  assert.equal(directory._attachments, undefined);
  assert.equal((await client.download(directory)).metadata.kind, 'directory');
  const deleted = await client.put({path: 'empty.md', deleted: true, mtime: 0}, empty._rev);
  const lastPut = wire.requests.filter(r => r.method === 'PUT').at(-1)!;
  assert.equal(typeof lastPut.body, 'string'); assert.ok(!('_deleted' in JSON.parse(lastPut.body as string)));
  assert.equal(deleted._attachments, undefined);
  assert.equal((await client.download(deleted)).metadata.deleted, true);
});

test('409 never triggers refetch or overwrite; accepted lost response is recovered by reading', async () => {
  const {client, wire, connect} = await fixture();
  const first = await client.put(input());
  await client.put(input(undefined, 'new version'), first._rev);
  const before = wire.requests.length;
  await assert.rejects(() => client.put(input(undefined, 'stale'), first._rev), (e: unknown) => e instanceof SyncFailure && e.kind === 'conflict');
  assert.equal(wire.requests.length, before + 1);
  wire.loseResponse = true;
  await assert.rejects(() => client.put(input('lost.md')));
  const resumed = await connect(), recovered = await resumed.get('lost.md'); assert.ok(recovered);
  assert.deepEqual((await resumed.download(recovered)).bytes, input().bytes);
});

test('serialized envelopes pin exact revisions across offline restart and reject unavailable or corrupted bytes', async () => {
  const {client, wire, connect} = await fixture();
  const large = input(undefined,'large'.repeat(15000));
  const saved = await client.put(large), journal = JSON.parse(JSON.stringify(saved));
  await client.put(input(undefined, 'later bytes'), saved._rev);
  wire.offline = true; await assert.rejects(() => client.download(journal)); wire.offline = false;
  const restarted = await connect();
  assert.deepEqual((await restarted.download(journal)).bytes, large.bytes);
  wire.corruptBody = true; await assert.rejects(() => restarted.download(journal)); wire.corruptBody = false;
  wire.bodies.delete(saved._id + '@' + saved._rev);
  const before = wire.requests.length;
  await assert.rejects(() => restarted.download(journal), (e: unknown) => e instanceof SyncFailure && e.kind === 'data');
  assert.equal(wire.requests.length, before + 1); // Never fetch latest as a substitute.
});

test('changes preserve opaque checkpoints and quarantine bad rows while retaining valid records', async () => {
  const {client, wire, crypto} = await fixture();
  const good = await client.put(input());
  const bad = await encryptRecord(crypto, input('bad.md'));
  wire.feed = {results: [
    {id: bad.record._id, seq: 1, doc: {...bad.record, _rev: '1-bad', metadata: 'invalid'}, changes: [{rev: '1-bad'}]},
    {id: good._id, seq: 2, doc: good, changes: [{rev: good._rev}]},
  ], last_seq: 'opaque+/='};
  const page = await client.changes('previous+/=');
  assert.equal(page.sourceRows, 2); assert.equal(page.lastSequence, 'opaque+/=');
  assert.deepEqual(page.results[0], {id: bad.record._id, revision: '1-bad', rejected: 'invalid-record'});
  assert.deepEqual(page.results[1], {id: good._id, record: good});
  const url = new URL(wire.requests.at(-1)!.url);
  assert.equal(url.searchParams.get('since'), 'previous+/='); assert.equal(url.searchParams.get('attachments'), 'false');
});

test('wrong-key connection and forbidden uploads fail before writes; foreign protocols block the page', async () => {
  const {wire, client} = await fixture();
  const wrong = await importRecoveryCode(generateRecoveryCode());
  await assert.rejects(() => EncryptedCouch.connect(connection, wire.http, wrong, syncPath));
  let before = wire.requests.length;
  await assert.rejects(() => client.put(input('.obsidian/private.md')));
  await assert.rejects(() => client.put(input(), 'invalid-revision'));
  assert.equal(wire.requests.length, before);
  wire.feed = {results: [{id: 'file:plaintext', seq: 1, doc: {schema: 1}}], last_seq: 1};
  await assert.rejects(() => client.changes(0), (e: unknown) => e instanceof SyncFailure && e.kind === 'configuration');
});

test('native deletion is quarantined, but deleted or replaced vault configuration blocks the page', async () => {
  const {client, wire} = await fixture();
  const saved = await client.put(input());
  wire.feed = {results: [{id: saved._id, seq: 1, deleted: true, doc: {_id: saved._id, _deleted: true}, changes: [{rev: '2-deleted'}]}], last_seq: 1};
  assert.deepEqual((await client.changes(0)).results, [{id: saved._id, revision: '2-deleted', rejected: 'invalid-record'}]);
  wire.feed = {results: [{id: CONFIGURATION_ID, seq: 1, deleted: true}], last_seq: 1};
  await assert.rejects(() => client.changes(0));
  const other = await createConfiguration(await importRecoveryCode(generateRecoveryCode()));
  wire.feed = {results: [{id: CONFIGURATION_ID, seq: 1, doc: other}], last_seq: 1};
  await assert.rejects(() => client.changes(0));
});
