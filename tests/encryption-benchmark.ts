/** Codec microbenchmark only: no HTTP, CouchDB, Obsidian or iPhone measurements. */
import {VaultCrypto, randomBytes, base64url} from '../src/legacy/crypto';
import {encryptRecord, decryptRecord} from '../src/legacy/encrypted-protocol';
import {rawHash, syncPath, documentId} from '../src/paths';
import {smallNotes} from './benchmark-fixtures';

const count = Number(process.argv[2] ?? 100);
if (![20, 100, 1000, 10000].includes(count)) throw new Error('Use 20, 100, 1000 or 10000 notes.');
const secret = randomBytes(32), vaultId = base64url(randomBytes(16));
const sender = await VaultCrypto.create(secret, vaultId), receiver = await VaultCrypto.create(secret, vaultId);
secret.fill(0);
let plaintextBytes = 0, encryptedBytes = 0, legacyJsonBytes = 0, encryptMs = 0, decryptMs = 0;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const start = performance.now();
for (const fixture of smallNotes(count)) {
  plaintextBytes += fixture.bytes.byteLength;
  legacyJsonBytes += encoder.encode(JSON.stringify({_id: documentId(fixture.path), schema: 1,
    path: fixture.path, content: decoder.decode(fixture.bytes), mtime: 0, deleted: false})).length;
  let tick = performance.now();
  const encrypted = await encryptRecord(sender, {...fixture, deleted: false, mtime: 0});
  encryptMs += performance.now() - tick;
  encryptedBytes += encoder.encode(JSON.stringify(encrypted.record)).length + (encrypted.body?.byteLength??0);
  tick = performance.now();
  const restored = await decryptRecord(receiver, encrypted.record, encrypted.body, syncPath);
  decryptMs += performance.now() - tick;
  if (rawHash(restored.bytes!) !== rawHash(fixture.bytes)) throw new Error('Fixture mismatch.');
}
console.log(JSON.stringify({scope: 'Node codec microbenchmark; NOT initial sync or iPhone memory',
  runtime: process.version, platform: process.platform, files: count, plaintextBytes,
  legacyJsonBytes, encryptedEnvelopeAndBodyBytes: encryptedBytes,
  note: 'Sizes exclude HTTP/multipart/revisions. Timings include validation and hashing. No latency simulation.',
  encryptMs, decryptMs, elapsedMs: performance.now() - start}, null, 2));
