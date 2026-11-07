import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {App} from 'obsidian';
import {ObsidianSecrets} from '../src/obsidian-secrets';
import {CouchConfiguration} from '../src/legacy/couch-configuration';
import {generateRecoveryCode, importRecoveryCode, createConfiguration, EncryptionSetup, CONFIGURATION_ID, type SetupIntent} from '../src/legacy/encryption-setup';
import {SyncFailure} from '../src/types';
import type {Http} from '../src/couch-client';

const connection = {url: 'https://example.test/proxy', database: 'test vault', username: 'test', password: 'synthetic'};
const appWith = (storage: unknown) => ({secretStorage: storage}) as Pick<App, 'secretStorage'>;
const name = 'bettersync-' + 'ab'.repeat(16);
function secretAdapter() {
  const values = new Map<string, string>();
  return new ObsidianSecrets(appWith({getSecret(id: string) { return values.get(id) ?? null; },
    setSecret(id: string, value: string) { assert.match(id, /^[a-z0-9-]+$/); values.set(id, value); }}));
}

test('Obsidian adapter preserves method receiver, checks readback and rejects unsupported clients', async () => {
  const secrets = secretAdapter();
  assert.equal(await secrets.get(name), null); await secrets.set(name, 'synthetic key');
  assert.equal(await secrets.get(name), 'synthetic key');
  const storage = {value: '', getSecret() { return this.value || null; }, setSecret(_id: string, v: string) { this.value = v; }};
  await new ObsidianSecrets(appWith(storage)).set(name, 'receiver works');
  assert.equal(storage.value, 'receiver works');
  for (const unsupported of [undefined, {}, {getSecret() { return null; }}]) assert.throws(() => new ObsidianSecrets(appWith(unsupported)));
  for (const invalid of ['Other-plugin', 'bettersync-Ab_cd', '../escape', '']) await assert.rejects(() => secrets.set(invalid, 'x'));
});

test('secret read/write failures are sanitized and failed readback never succeeds', async () => {
  const adapter = new ObsidianSecrets(appWith({getSecret() { throw new Error('SECRET'); }, setSecret() { throw new Error('SECRET'); }}));
  for (const op of [() => adapter.get(name), () => adapter.set(name, 'SECRET')])
    await assert.rejects(op, (e: unknown) => e instanceof Error && !e.message.includes('SECRET'));
  const lost = new ObsidianSecrets(appWith({getSecret() { return null; }, setSecret() {}}));
  await assert.rejects(() => lost.set(name, 'synthetic'));
});

test('configuration lookup uses keyed all_docs, distinguishing absent, deleted and missing database', async () => {
  let requestUrl = '', requestBody = '';
  const missing = new CouchConfiguration(connection, async (url, method, _headers, body) => {
    requestUrl = url; requestBody = body as string; assert.equal(method, 'POST');
    return {status: 200, json: {rows: [{key: CONFIGURATION_ID, error: 'not_found'}]}};
  });
  assert.equal(await missing.getConfiguration(), null);
  assert.equal(requestUrl, 'https://example.test/proxy/test%20vault/_all_docs?include_docs=true');
  assert.deepEqual(JSON.parse(requestBody), {keys: [CONFIGURATION_ID]});
  await assert.rejects(() => new CouchConfiguration(connection, async () => ({status: 404})).getConfiguration(),
    (e: unknown) => e instanceof SyncFailure && e.kind === 'configuration');
  for (const rows of [[], [null], [{key: 'other', error: 'not_found'}],
    [{key: CONFIGURATION_ID, id: CONFIGURATION_ID, value: {rev: '2-deleted', deleted: true}, doc: null}]])
    await assert.rejects(() => new CouchConfiguration(connection, async () => ({status: 200, json: {rows}})).getConfiguration());
});

test('empty-database check rejects documents, design documents, tombstones and malformed info', async () => {
  await new CouchConfiguration(connection, async () => ({status: 200, json: {doc_count: 0, doc_del_count: 0}})).assertEmpty();
  for (const info of [null, {}, {doc_count: 1, doc_del_count: 0}, {doc_count: 0, doc_del_count: 1},
    {doc_count: -1, doc_del_count: 0}, {doc_count: 0, doc_del_count: '0'}])
    await assert.rejects(() => new CouchConfiguration(connection, async () => ({status: 200, json: info})).assertEmpty());
});

test('create-only configuration sends ciphertext and never retries 409 or writes a revision', async () => {
  const code = generateRecoveryCode(), configuration = await createConfiguration(await importRecoveryCode(code));
  let writes = 0;
  const remote = new CouchConfiguration(connection, async (url, method, _headers, body) => {
    writes++; assert.equal(method, 'PUT'); assert.ok(url.endsWith('/bettersync%3Aconfiguration'));
    const serialized = body as string; assert.deepEqual(JSON.parse(serialized), configuration);
    assert.ok(!serialized.includes(code.split('.')[2]!));
    return {status: 409};
  });
  await assert.rejects(() => remote.createConfiguration(configuration), (e: unknown) => e instanceof SyncFailure && e.kind === 'conflict');
  assert.equal(writes, 1);
  await assert.rejects(() => remote.createConfiguration({...configuration, _rev: '1-existing'}));
  assert.equal(writes, 1);
});

test('three adapter-backed installations recover lost responses and join without further configuration writes', async () => {
  let saved: Record<string, unknown> | null = null, loseResponse = true, offline = false, writes = 0;
  const http: Http = async (_url, method) => {
    if (offline) throw new Error('synthetic offline');
    if (method === 'GET') return {status: 200, json: {doc_count: saved ? 1 : 0, doc_del_count: 0}};
    if (method === 'POST') return {status: 200, json: {rows: [saved
      ? {key: CONFIGURATION_ID, id: CONFIGURATION_ID, value: {rev: saved._rev}, doc: saved}
      : {key: CONFIGURATION_ID, error: 'not_found'}]}};
    throw new Error('PUT handled below');
  };
  const wire: Http = async (url, method, headers, body, type) => {
    if (method !== 'PUT') return http(url, method, headers, body, type);
    writes++; if (saved) return {status: 409};
    saved = {...JSON.parse(body as string), _rev: '1-created'};
    if (loseResponse) { loseResponse = false; throw new Error('lost accepted response'); }
    return {status: 201, json: {ok: true, id: CONFIGURATION_ID, rev: '1-created'}};
  };
  const remote = new CouchConfiguration(connection, wire);
  function device() {
    let intent: SetupIntent | null = null;
    const storage = {load: async () => structuredClone(intent), save: async (v: SetupIntent) => {intent = structuredClone(v);}};
    const secrets = secretAdapter();
    return {setup: () => new EncryptionSetup('binding', storage, secrets, remote), storage};
  }
  const [a, b, c] = [device(), device(), device()] as const, code = generateRecoveryCode();
  await assert.rejects(() => a.setup().createConfirmed(code));
  assert.equal((await a.storage.load())?.phase, 'prepared');
  offline = true; await assert.rejects(() => a.setup().resume()); offline = false;
  await a.setup().resume(); await b.setup().join(code); await c.setup().join(code);
  assert.equal(writes, 1);
  for (const d of [a, b, c]) assert.equal((await d.storage.load())?.phase, 'ready');
});
