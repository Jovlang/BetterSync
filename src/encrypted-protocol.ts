/** Provisional attachment candidate. No network or filesystem effects. */
import {base64url, unbase64url, randomBytes, VaultCrypto, EncryptionError, CRYPTO_DOMAIN} from './crypto';
import {MAX_FILE_BYTES, rawHash, syncPath} from './paths';

export const MAX_METADATA_BYTES = 16 * 1024;
export const INLINE_FILE_BYTES = 64 * 1024;
export const MAX_PATH_BYTES = 4096; // Provisional bound, subject to schema review.
export interface LogicalMetadata {
  path: string; kind: 'file' | 'directory'; deleted: boolean; mtime: number;
  size: number; hash: string | null; contentNonce: string | null;
}
export interface EncryptedRecord {
  _id: string; _rev?: string; schema: 4; protocol: typeof CRYPTO_DOMAIN; vault: string;
  salt: string; nonce: string; metadata: string;
  inline?: string;
  _attachments?: {content: {stub: true; content_type: 'application/octet-stream'; length: number}};
}
export interface RecordInput {path: string; deleted: boolean; mtime: number; bytes?: ArrayBuffer}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
function fail(): never { throw new EncryptionError(); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) fail();
}
function validateMetadata(value: unknown): LogicalMetadata {
  const d = object(value);
  keys(d, ['path', 'kind', 'deleted', 'mtime', 'size', 'hash', 'contentNonce']);
  if (typeof d.path !== 'string' || !syncPath(d.path) || encoder.encode(d.path).length > MAX_PATH_BYTES
    || decoder.decode(encoder.encode(d.path)) !== d.path || !['file', 'directory'].includes(d.kind as string)
    || (d.kind === 'directory') !== d.path.endsWith('/') || typeof d.deleted !== 'boolean'
    || typeof d.mtime !== 'number' || !Number.isSafeInteger(d.mtime) || d.mtime < 0
    || typeof d.size !== 'number' || !Number.isSafeInteger(d.size) || d.size < 0 || d.size > MAX_FILE_BYTES) fail();
  if (d.deleted || d.kind === 'directory') {
    if (d.size !== 0 || d.hash !== null || d.contentNonce !== null) fail();
  } else {
    if (typeof d.hash !== 'string' || !/^[a-f0-9]{64}$/.test(d.hash)) fail();
    unbase64url(d.contentNonce, 12);
  }
  return d as unknown as LogicalMetadata;
}

/** Produces a bounded owned snapshot, never returns the caller's mutable object. */
export function validateEncryptedRecord(value: unknown): EncryptedRecord {
  const d = object(value);
  keys(d, ['_id', '_rev', 'schema', 'protocol', 'vault', 'salt', 'nonce', 'metadata', 'inline', '_attachments']);
  if (d.schema !== 4 || d.protocol !== CRYPTO_DOMAIN || typeof d._id !== 'string' || !d._id.startsWith('e4:')) fail();
  unbase64url(d._id.slice(3), 32);
  if (d._rev !== undefined && (typeof d._rev !== 'string' || !/^[1-9][0-9]*-[A-Za-z0-9]+$/.test(d._rev) || d._rev.length > 256)) fail();
  unbase64url(d.vault, 16); unbase64url(d.salt, 32); unbase64url(d.nonce, 12);
  unbase64url(d.metadata, 16, MAX_METADATA_BYTES + 16);
  const result: EncryptedRecord = {_id: d._id, schema: 4, protocol: CRYPTO_DOMAIN, vault: d.vault as string,
    salt: d.salt as string, nonce: d.nonce as string, metadata: d.metadata as string};
  if (d._rev !== undefined) result._rev = d._rev as string;
  if(d.inline!==undefined) {
    if(d._attachments!==undefined)fail();
    unbase64url(d.inline,16,INLINE_FILE_BYTES+16);result.inline=d.inline as string;
  }
  if (d._attachments !== undefined) {
    const attachments = object(d._attachments); keys(attachments, ['content']);
    const a = object(attachments.content); keys(a, ['stub', 'content_type', 'length', 'digest', 'revpos']);
    if (a.stub !== true || a.content_type !== 'application/octet-stream' || typeof a.length !== 'number'
      || !Number.isSafeInteger(a.length) || a.length < 16 || a.length > MAX_FILE_BYTES + 16) fail();
    result._attachments = {content: {stub: true, content_type: 'application/octet-stream', length: a.length}};
  }
  return result;
}

export async function encryptRecord(crypto: VaultCrypto, input: RecordInput): Promise<{record: EncryptedRecord; body?: ArrayBuffer}> {
  const {path, deleted, mtime, bytes} = input;
  const liveFile = !deleted && !path.endsWith('/');
  if (liveFile !== (bytes instanceof ArrayBuffer) || (bytes && bytes.byteLength > MAX_FILE_BYTES)) fail();
  // Caller retains ownership of bytes and must not mutate them until this promise resolves.
  const metadata = validateMetadata({path, kind: path.endsWith('/') ? 'directory' : 'file', deleted, mtime,
    size: bytes?.byteLength ?? 0, hash: bytes ? rawHash(bytes) : null,
    contentNonce: liveFile ? base64url(new Uint8Array(12)) : null});
  const id = await crypto.documentId(path), salt = base64url(randomBytes(32));
  let body: ArrayBuffer | undefined;
  if (bytes) {
    const sealed = await crypto.seal(id, salt, 'content', bytes);
    body = sealed.bytes; metadata.contentNonce = sealed.nonce;
  }
  const sealed = await crypto.seal(id, salt, 'metadata', encoder.encode(JSON.stringify(metadata)).buffer);
  const record: EncryptedRecord = {_id: id, schema: 4, protocol: CRYPTO_DOMAIN, vault: crypto.vaultId,
    salt, nonce: sealed.nonce, metadata: base64url(new Uint8Array(sealed.bytes))};
  if(body && bytes!.byteLength<=INLINE_FILE_BYTES) {record.inline=base64url(new Uint8Array(body));body=undefined;}
  else if (body) record._attachments = {content: {stub: true, content_type: 'application/octet-stream', length: body.byteLength}};
  return {record: validateEncryptedRecord(record), body};
}

export async function decryptMetadata(crypto: VaultCrypto, value: unknown, allowedPath: (path: string) => boolean): Promise<LogicalMetadata> {
  try {
    const record = validateEncryptedRecord(value);
    if (record.vault !== crypto.vaultId) fail();
    const bytes = await crypto.open(record._id, record.salt, 'metadata', record.nonce, unbase64url(record.metadata, 16, MAX_METADATA_BYTES + 16).buffer);
    const metadata = validateMetadata(JSON.parse(decoder.decode(bytes)));
    if (!allowedPath(metadata.path) || await crypto.documentId(metadata.path) !== record._id) fail();
    const hasBody = metadata.kind === 'file' && !metadata.deleted;
    // The authenticated plaintext size deterministically selects representation.
    // Moving ciphertext between representations therefore cannot bypass authentication.
    if(hasBody && metadata.size<=INLINE_FILE_BYTES) {
      if(record.inline===undefined||record._attachments||unbase64url(record.inline,16,INLINE_FILE_BYTES+16).length!==metadata.size+16)fail();
    } else if(hasBody) {
      if(record.inline!==undefined||!record._attachments||record._attachments.content.length!==metadata.size+16)fail();
    } else if(record.inline!==undefined||record._attachments)fail();
    return metadata;
  } catch { throw new EncryptionError(); }
}

/** Authenticate everything again at the byte boundary; no trusted-metadata bypass. */
export async function decryptRecord(crypto: VaultCrypto, value: unknown, body: ArrayBuffer | undefined,
  allowedPath: (path: string) => boolean): Promise<{metadata: LogicalMetadata; bytes?: ArrayBuffer}> {
  const record = validateEncryptedRecord(value);
  const metadata = await decryptMetadata(crypto, record, allowedPath);
  if(record.inline!==undefined) {
    if(body!==undefined)fail();
    const bytes=await crypto.open(record._id,record.salt,'content',metadata.contentNonce!,unbase64url(record.inline,16,INLINE_FILE_BYTES+16).buffer);
    if(bytes.byteLength!==metadata.size||rawHash(bytes)!==metadata.hash)fail();
    return {metadata,bytes};
  }
  if (record._attachments) {
    if (!(body instanceof ArrayBuffer) || body.byteLength !== record._attachments.content.length) fail();
    const bytes = await crypto.open(record._id, record.salt, 'content', metadata.contentNonce!, body);
    if (bytes.byteLength !== metadata.size || rawHash(bytes) !== metadata.hash) fail();
    return {metadata, bytes};
  }
  if (body !== undefined) fail();
  return {metadata};
}
