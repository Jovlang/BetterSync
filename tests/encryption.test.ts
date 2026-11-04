import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hkdfSync, createHmac, createDecipheriv} from 'node:crypto';
import {VaultCrypto, base64url, unbase64url, frame, EncryptionError, CRYPTO_DOMAIN} from '../src/crypto';
import {encryptRecord, decryptRecord, decryptMetadata, validateEncryptedRecord, MAX_METADATA_BYTES, type RecordInput} from '../src/encrypted-protocol';
import {syncPath} from '../src/paths';

// Public synthetic test material only; never use these keys for a real vault.
const root = new Uint8Array(32).fill(7), vaultId = base64url(new Uint8Array(16).fill(3));
const context = () => VaultCrypto.create(root, vaultId);
const text = (value: string) => new TextEncoder().encode(value).buffer;
const input = (path = 'Norsk/Ærlig.md') => ({path, deleted: false, mtime: 42, bytes: text('synthetic note canary'.repeat(4000))});
function referenceFrame(...parts: string[]): Buffer {
  return Buffer.concat(parts.flatMap(part => {const b = Buffer.from(part); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return [n, b];}));
}

test('framing is unambiguous, UTF-8 and big endian', () => {
  assert.equal(Buffer.from(frame('a', 'ø')).toString('hex'), '000000016100000002c3b8');
  assert.notDeepEqual(frame('ab', 'c'), frame('a', 'bc'));
});

test('canonical bounded base64url rejects malformed and oversized input', () => {
  assert.deepEqual(unbase64url('AA', 1), new Uint8Array([0]));
  for (const value of ['AB', 'AA=', 'AA\n', 'A', '+/', 'AAAA', null, {}])
    assert.throws(() => unbase64url(value, 1), EncryptionError);
});

test('path IDs match independent Node HKDF/HMAC and separate vaults, types and Unicode', async () => {
  const c = await context();
  const key = hkdfSync('sha256', root, Buffer.from(vaultId, 'base64url'), referenceFrame(CRYPTO_DOMAIN, 'path-id'), 32);
  const expected = 'e4:' + createHmac('sha256', Buffer.from(key)).update(referenceFrame(CRYPTO_DOMAIN, 'path', 'Æ.md')).digest('base64url');
  assert.equal(await c.documentId('Æ.md'), expected);
  const paths = ['a', 'a/', 'A', 'é.md', 'e\u0301.md', '__proto__', 'constructor'];
  assert.equal(new Set(await Promise.all(paths.map(p => c.documentId(p)))).size, paths.length);
  const other = await VaultCrypto.create(root, base64url(new Uint8Array(16).fill(4)));
  assert.notEqual(await c.documentId('a'), await other.documentId('a'));
  await assert.rejects(() => c.documentId('bad\ud800.md'));
});

test('AES-GCM envelope decrypts independently with exact AAD and 128-bit tag', async () => {
  const c = await context(), id = await c.documentId('a.md'), salt = base64url(new Uint8Array(32).fill(5));
  const sealed = await c.seal(id, salt, 'content', text('independent vector'));
  const key = hkdfSync('sha256', root, Buffer.from(salt, 'base64url'), referenceFrame(CRYPTO_DOMAIN, vaultId, id, 'content'), 32);
  const bytes = Buffer.from(sealed.bytes);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(sealed.nonce, 'base64url'));
  decipher.setAAD(referenceFrame(CRYPTO_DOMAIN, '4', vaultId, id, salt, 'content'));
  decipher.setAuthTag(bytes.subarray(-16));
  assert.equal(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(), 'independent vector');
  await assert.rejects(() => c.open(id, salt, 'metadata', sealed.nonce, sealed.bytes), EncryptionError);
});

test('three independent key contexts exchange files, directories and durable deletion metadata', async () => {
  const clients = await Promise.all([context(), context(), context()]);
  const records: RecordInput[] = [input(), {...input('empty.md'), bytes: new ArrayBuffer(0)},
    {...input('image.bin'), bytes: new Uint8Array([0, 255, 128, 1]).buffer},
    {path: 'empty/', deleted: false, mtime: 0}, {path: 'gone.md', deleted: true, mtime: 2}];
  for (const record of records) {
    const encrypted = await encryptRecord(clients[0]!, record);
    const snapshot = JSON.parse(JSON.stringify(encrypted.record));
    for (const client of clients.slice(1)) {
      const opened = await decryptRecord(client, snapshot, encrypted.body, syncPath);
      assert.equal(opened.metadata.path, record.path);
      assert.deepEqual(opened.bytes, record.bytes);
      assert.equal(opened.metadata.deleted, record.deleted);
    }
    const wire = JSON.stringify(snapshot);
    assert.ok(!wire.includes(record.path));
    assert.ok(!wire.includes('synthetic note canary'));
    assert.ok(!wire.includes(base64url(root)));
  }
});

test('fresh encryption attempts have distinct salts and ciphertext with stable identity', async () => {
  const c = await context(), a = await encryptRecord(c, input()), b = await encryptRecord(c, input());
  assert.equal(a.record._id, b.record._id);
  assert.notEqual(a.record.salt, b.record.salt); assert.notEqual(a.record.nonce, b.record.nonce);
  assert.notDeepEqual(a.body, b.body);
  await assert.rejects(() => decryptRecord(c, a.record, b.body, syncPath), EncryptionError);
});

test('wrong key, vault, excluded custom config directory and modified metadata fail closed', async () => {
  const c = await context(), {record, body} = await encryptRecord(c, input());
  const wrong = await VaultCrypto.create(new Uint8Array(32).fill(8), vaultId);
  await assert.rejects(() => decryptRecord(wrong, record, body, syncPath), EncryptionError);
  await assert.rejects(() => decryptMetadata(c, record, () => false), EncryptionError);
  for (const changed of [
    {...record, vault: base64url(new Uint8Array(16).fill(4))},
    {...record, salt: base64url(new Uint8Array(32).fill(6))},
    {...record, nonce: base64url(new Uint8Array(12))},
    {...record, _id: await c.documentId('other.md')},
    {...record, schema: 3}, {...record, protocol: 'future'}, {...record, path: 'leak.md'},
    {...record, metadata: base64url(new Uint8Array(MAX_METADATA_BYTES + 17))},
    {...record, _attachments: undefined},
  ]) await assert.rejects(() => decryptRecord(c, changed, body, syncPath), EncryptionError);
  const config = await encryptRecord(c, input('custom-config/settings.md'));
  await assert.rejects(() => decryptMetadata(c, config.record, p => !p.startsWith('custom-config/')), EncryptionError);
});

test('every metadata and content ciphertext byte is authenticated; truncated bodies rejected', async () => {
  const c = await context(), {record, body} = await encryptRecord(c, input());
  const metadata = unbase64url(record.metadata, 16, MAX_METADATA_BYTES + 16);
  for (let i = 0; i < metadata.length; i++) {
    const altered = metadata.slice(); altered[i] = altered[i]! ^ 1;
    await assert.rejects(() => decryptMetadata(c, {...record, metadata: base64url(altered)}, syncPath), EncryptionError);
  }
  for (let i = 0; i < body!.byteLength; i += 4093) {
    const altered = new Uint8Array(body!.slice(0)); altered[i] = altered[i]! ^ 1;
    await assert.rejects(() => decryptRecord(c, record, altered.buffer, syncPath), EncryptionError);
  }
  await assert.rejects(() => decryptRecord(c, record, body!.slice(0, -1), syncPath), EncryptionError);
});

test('replayed immutable envelope survives serialization and remains bound to its original bytes', async () => {
  const c = await context(), a = await encryptRecord(c, input());
  const journal = JSON.parse(JSON.stringify({...a.record, _rev: '1-original'}));
  const restarted = await context();
  assert.deepEqual((await decryptRecord(restarted, journal, a.body, syncPath)).bytes, input().bytes);
  const newer = await encryptRecord(c, {...input(), bytes: text('later offline edit')});
  await assert.rejects(() => decryptRecord(restarted, journal, newer.body, syncPath), EncryptionError);
});

test('wire parser snapshots metadata and rejects plaintext, oversized and unexpected attachments', async () => {
  const {record} = await encryptRecord(await context(), input());
  const snapshot = validateEncryptedRecord(record);
  record._attachments!.content.length++;
  assert.notEqual(snapshot._attachments!.content.length, record._attachments!.content.length);
  for (const value of [null, [], {schema: 1, path: 'a.md', content: 'plain'},
    {...snapshot, _attachments: {extra: {}}}, {...snapshot, _attachments: {content: {...snapshot._attachments!.content, data: 'inline'}}}])
    assert.throws(() => validateEncryptedRecord(value), EncryptionError);
});

test('unsafe paths and invalid logical shapes cannot be encrypted', async () => {
  const c = await context();
  for (const path of ['../escape.md', '.obsidian/x.md', '.trash/a', '/root', 'a\\b', 'x'.repeat(4097), 'bad\ud800.md'])
    await assert.rejects(() => encryptRecord(c, input(path)), EncryptionError);
  await assert.rejects(() => encryptRecord(c, {...input(), deleted: true}), EncryptionError);
  await assert.rejects(() => encryptRecord(c, {...input(), bytes: undefined}), EncryptionError);
});
