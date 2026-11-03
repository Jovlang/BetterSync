import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EncryptionError, base64url, unbase64url, frame} from '../src/crypto';
import {sha256} from '@noble/hashes/sha2.js';
import {SyncFailure} from '../src/types';
import {generateRecoveryCode, importRecoveryCode, createConfiguration, authenticateConfiguration,
  validateConfiguration, EncryptionSetup, type SetupIntent, type SetupStorage, type SecretStore,
  type ConfigurationRemote, type VaultConfiguration} from '../src/encryption-setup';

class Storage implements SetupStorage {
  value: SetupIntent | null = null;
  failPhase?: string;
  async load() { return structuredClone(this.value); }
  async save(value: SetupIntent) {
    if (value.phase === this.failPhase) throw new Error('Synthetic local save failure.');
    this.value = structuredClone(value);
  }
}
class Secrets implements SecretStore {
  entries = new Map<string, string>();
  failWrite = false;
  async get(name: string) { return this.entries.get(name) ?? null; }
  async set(name: string, code: string) { if (!this.failWrite) this.entries.set(name, code); }
}
class Remote implements ConfigurationRemote {
  value: VaultConfiguration | null = null;
  creates = 0;
  foreign = false;
  offline = false;
  loseResponse = false;
  check() { if (this.offline) throw new SyncFailure('temporary', 'Offline.'); }
  async getConfiguration() { this.check(); return structuredClone(this.value); }
  async assertEmpty() { this.check(); if (this.foreign) throw new Error('Foreign data.'); }
  async createConfiguration(value: VaultConfiguration) {
    this.check(); this.creates++;
    if (this.value) throw new SyncFailure('conflict', 'Already configured.');
    this.value = {...structuredClone(value), _rev: '1-config'};
    if (this.loseResponse) throw new SyncFailure('temporary', 'Lost response.');
  }
}
function device(remote = new Remote()) {
  const storage = new Storage(), secrets = new Secrets();
  return {storage, secrets, remote, setup: new EncryptionSetup('server/database', storage, secrets, remote),
    restart: () => new EncryptionSetup('server/database', storage, secrets, remote)};
}
function withWrongKey(code: string): string {
  const [prefix, vault, encoded] = code.split('.') as [string, string, string];
  const bytes = unbase64url(encoded, 32); bytes[0] = bytes[0]! ^ 1;
  const secret = base64url(bytes);
  return `${prefix}.${vault}.${secret}.${base64url(sha256(frame(prefix, vault, secret)).slice(0, 6))}`;
}

test('recovery codes round-trip and reject typos, unsupported versions and noncanonical fields', async () => {
  const code = generateRecoveryCode(), c = await importRecoveryCode(code);
  assert.equal(await c.documentId('test.md'), await (await importRecoveryCode('  ' + code + '\n')).documentId('test.md'));
  assert.notEqual(code, generateRecoveryCode());
  const parts = code.split('.');
  for (const bad of [code + '.extra', code.slice(0, -1), 'x'.repeat(1000), code.replace('draft1', 'draft2'),
    `${parts[0]}.${parts[1]}.${parts[2]}=.${parts[3]}`, `${parts[0]}.${parts[1]}.${parts[2]}.AAAAAAAA`])
    await assert.rejects(() => importRecoveryCode(bad), EncryptionError);
});

test('configuration authenticates key and vault and rejects changed fields and excess data', async () => {
  const code = generateRecoveryCode(), c = await importRecoveryCode(code), doc = await createConfiguration(c);
  assert.deepEqual(await authenticateConfiguration(c, JSON.parse(JSON.stringify(doc))), doc);
  const wrong = await importRecoveryCode(withWrongKey(code));
  await assert.rejects(() => authenticateConfiguration(wrong, doc), EncryptionError);
  const other = await importRecoveryCode(generateRecoveryCode());
  await assert.rejects(() => authenticateConfiguration(other, doc), EncryptionError);
  for (const modified of [{...doc, schema: 3}, {...doc, path: 'should-not-exist'}, {...doc, _id: 'other'},
    {...doc, nonce: base64url(new Uint8Array(12))}, {...doc, ciphertext: doc.ciphertext.slice(1)}])
    await assert.rejects(() => authenticateConfiguration(c, modified), EncryptionError);
  assert.throws(() => validateConfiguration(null), EncryptionError);
});

test('three installations join with separate local secrets and no recovery key in durable metadata', async () => {
  const a = device(), b = device(a.remote), c = device(a.remote), code = generateRecoveryCode();
  await a.setup.createConfirmed(code);
  await b.setup.join(code); await c.setup.join(code);
  assert.equal(a.remote.creates, 1);
  assert.equal(new Set([a, b, c].map(d => d.storage.value!.secretName)).size, 3);
  for (const d of [a, b, c]) {
    assert.equal(d.storage.value!.phase, 'ready');
    assert.equal(d.storage.value!.configuration, undefined);
    const persisted = JSON.stringify({state: d.storage.value, server: d.remote.value});
    assert.ok(!persisted.includes(code)); assert.ok(!persisted.includes(code.split('.')[2]!));
    const resumed = await d.restart().resume();
    assert.equal(resumed.vaultId, d.storage.value!.vault);
  }
});

test('unconfirmed setup has no side effects and missing config cannot be joined', async () => {
  const d = device();
  await assert.rejects(() => d.setup.resume());
  await assert.rejects(() => d.setup.join(generateRecoveryCode()));
  assert.equal(d.remote.creates, 0); assert.equal(d.secrets.entries.size, 0); assert.equal(d.storage.value, null);
});

test('secret readback and prepared-state save must succeed before remote creation', async () => {
  const code = generateRecoveryCode(), a = device();
  a.secrets.failWrite = true;
  await assert.rejects(() => a.setup.createConfirmed(code));
  assert.equal(a.remote.creates, 0); assert.equal(a.storage.value, null);
  const b = device(); b.storage.failPhase = 'prepared';
  await assert.rejects(() => b.setup.createConfirmed(code));
  assert.equal(b.remote.creates, 0); assert.equal(b.storage.value, null);
  await assert.rejects(() => b.restart().resume());
});

test('accepted creation with lost response resumes after restart without another write', async () => {
  const d = device(); d.remote.loseResponse = true;
  await assert.rejects(() => d.setup.createConfirmed(generateRecoveryCode()));
  assert.equal(d.storage.value!.phase, 'prepared'); assert.equal(d.remote.creates, 1);
  await d.restart().resume();
  assert.equal(d.storage.value!.phase, 'ready'); assert.equal(d.remote.creates, 1);
});

test('crash before remote write and failed ready-state save both recover from durable intent', async () => {
  const d = device(), originalSave = d.storage.save.bind(d.storage);
  d.storage.save = async value => { await originalSave(value); if (value.phase === 'prepared') d.remote.offline = true; };
  await assert.rejects(() => d.setup.createConfirmed(generateRecoveryCode()));
  assert.equal(d.remote.creates, 0); assert.equal(d.storage.value!.phase, 'prepared');
  d.remote.offline = false; d.storage.save = originalSave; d.storage.failPhase = 'ready';
  await assert.rejects(() => d.restart().resume());
  assert.equal(d.remote.creates, 1); assert.equal(d.storage.value!.phase, 'prepared');
  d.storage.failPhase = undefined;
  await d.restart().resume(); assert.equal(d.remote.creates, 1); assert.equal(d.storage.value!.phase, 'ready');
});

test('racing creators with different keys cannot replace the winning configuration', async () => {
  const remote = new Remote(), a = device(remote), b = device(remote), c = device(remote);
  const results = await Promise.allSettled([a, b, c].map(d => d.setup.createConfirmed(generateRecoveryCode())));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const winner = structuredClone(remote.value);
  for (let i = 0; i < results.length; i++) if (results[i]!.status === 'rejected') {
    await assert.rejects(() => [a, b, c][i]!.restart().resume());
    assert.deepEqual(remote.value, winner);
  }
});

test('foreign database, wrong code and database rebinding do not mutate server or local setup', async () => {
  const d = device(); d.remote.foreign = true;
  await assert.rejects(() => d.setup.createConfirmed(generateRecoveryCode()));
  assert.equal(d.secrets.entries.size, 0); assert.equal(d.storage.value, null);
  d.remote.foreign = false;
  const code = generateRecoveryCode(); await d.setup.createConfirmed(code);
  const before = structuredClone(d.storage.value), server = structuredClone(d.remote.value);
  await assert.rejects(() => d.setup.join(withWrongKey(code)));
  await assert.rejects(() => new EncryptionSetup('other/database', d.storage, d.secrets, d.remote).resume());
  assert.deepEqual(d.storage.value, before); assert.deepEqual(d.remote.value, server);
  const fresh = device(d.remote);
  await assert.rejects(() => fresh.setup.join(withWrongKey(code)));
  assert.equal(fresh.secrets.entries.size, 0); assert.equal(fresh.storage.value, null);
});

test('missing local key can be restored only by a code authenticated against remote config', async () => {
  const d = device(), code = generateRecoveryCode(); await d.setup.createConfirmed(code);
  d.secrets.entries.clear();
  await assert.rejects(() => d.restart().resume());
  await assert.rejects(() => d.setup.join(withWrongKey(code)));
  assert.equal(d.secrets.entries.size, 0);
  await d.setup.join(code); await d.restart().resume();
  assert.equal(d.remote.creates, 1);
});

test('ready installations never recreate removed config and offline retries preserve state', async () => {
  const d = device(); await d.setup.createConfirmed(generateRecoveryCode());
  const saved = structuredClone(d.storage.value);
  d.remote.offline = true; await assert.rejects(() => d.restart().resume());
  assert.deepEqual(d.storage.value, saved);
  d.remote.offline = false; d.remote.value = null;
  await assert.rejects(() => d.restart().resume(), EncryptionError);
  assert.equal(d.remote.creates, 1); assert.deepEqual(d.storage.value, saved);
});

test('recovery code restores a missing secret during prepared creation without trusting a wrong key', async () => {
  const d = device(), code = generateRecoveryCode(), save = d.storage.save.bind(d.storage);
  d.storage.save = async value => { await save(value); d.remote.offline = true; };
  await assert.rejects(() => d.setup.createConfirmed(code));
  d.storage.save = save; d.remote.offline = false; d.secrets.entries.clear();
  assert.equal(d.remote.value, null);
  await assert.rejects(() => d.restart().join(withWrongKey(code)), EncryptionError);
  assert.equal(d.secrets.entries.size, 0); assert.equal(d.remote.creates, 0);
  await d.restart().join(code);
  assert.equal(d.storage.value!.phase, 'ready'); assert.equal(d.remote.creates, 1);
});

test('secret adapter errors cannot expose recovery codes through setup errors', async () => {
  const d = device(), code = generateRecoveryCode();
  d.secrets.set = async () => { throw new Error('Failed to store ' + code); };
  await assert.rejects(() => d.setup.createConfirmed(code), (e: unknown) => e instanceof Error
    && e.message === 'Could not save the encryption key.' && !e.message.includes(code));
  assert.equal(d.remote.creates, 0);
});

test('three creators sharing one recovery code converge to a single configuration', async () => {
  const remote = new Remote(), clients = [device(remote), device(remote), device(remote)], code = generateRecoveryCode();
  // Force each creator past the initial absent-config read before any can write.
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const get = remote.getConfiguration.bind(remote);
  remote.getConfiguration = async () => {
    if (arrivals < 3) { arrivals++; if (arrivals === 3) release(); await barrier; return null; }
    return get();
  };
  await Promise.all(clients.map(d => d.setup.createConfirmed(code)));
  for (const d of clients) assert.equal(d.storage.value!.phase, 'ready');
  assert.ok(remote.value); await authenticateConfiguration(await importRecoveryCode(code), remote.value);
});
