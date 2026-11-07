/** Draft hybrid transport used by the encrypted remote adapter. */
import type {Connection, Http} from '../couch-client';
import {CouchHttp} from '../couch-http';
import {CouchConfiguration} from './couch-configuration';
import {authenticateConfiguration, CONFIGURATION_ID} from './encryption-setup';
import {VaultCrypto, base64url, randomBytes, unbase64url, CRYPTO_DOMAIN} from './crypto';
import {encryptRecord, decryptRecord, decryptMetadata, validateEncryptedRecord,
  type EncryptedRecord, type RecordInput, type TransferObserver} from './encrypted-protocol';
import {SyncFailure, type Sequence} from '../types';

export type EncryptedChange = {id: string; record: EncryptedRecord} | {id: string; revision?: string; rejected: 'invalid-record'};
export interface EncryptedPage {results: EncryptedChange[]; lastSequence: Sequence; sourceRows: number}
function invalid(): never { throw new SyncFailure('data', 'The server returned unreadable encrypted sync data.'); }
function revision(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^[1-9][0-9]*-[A-Za-z0-9]+$/.test(value);
}
function sequence(value: unknown): value is Sequence {
  return (typeof value === 'string' && value.length > 0 && value.length <= 8192)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
function opaqueId(id: unknown): id is string {
  if (typeof id !== 'string' || !id.startsWith('e4:')) return false;
  try { unbase64url(id.slice(3), 32); return true; } catch { return false; }
}

export class EncryptedCouch {
  observe?:TransferObserver;
  private constructor(private transport: CouchHttp, private crypto: VaultCrypto, private allowedPath: (path: string) => boolean) {}
  static async connect(connection: Connection, http: Http, crypto: VaultCrypto, allowedPath: (path: string) => boolean): Promise<EncryptedCouch> {
    // A wrong/missing key or missing configuration cannot obtain a writable client.
    await authenticateConfiguration(crypto, await new CouchConfiguration(connection, http).getConfiguration());
    return new EncryptedCouch(new CouchHttp(connection, http), crypto, allowedPath);
  }
  private async inspect(value: unknown): Promise<EncryptedRecord> {
    const record = validateEncryptedRecord(value);
    if (!record._rev) invalid();
    await decryptMetadata(this.crypto, record, this.allowedPath);
    return record;
  }
  async metadata(value: unknown) {
    const record = validateEncryptedRecord(value);
    if (!record._rev) invalid();
    return {record, metadata: await decryptMetadata(this.crypto, record, this.allowedPath)};
  }
  async get(path: string): Promise<EncryptedRecord | null> {
    if (!this.allowedPath(path)) invalid();
    const id = await this.crypto.documentId(path);
    const response = await this.transport.request('/_all_docs?include_docs=true&attachments=false', 'POST', {keys: [id]}) as
      {rows?: {key?: unknown; id?: unknown; error?: unknown; doc?: unknown; value?: {rev?: unknown; deleted?: unknown}}[]} | null;
    if (!response || !Array.isArray(response.rows) || response.rows.length !== 1) invalid();
    const row = response.rows[0];
    if (!row || row.key !== id) invalid();
    if (row.error === 'not_found' && row.doc === undefined && row.value === undefined && row.id === undefined) return null;
    if (row.error !== undefined || row.id !== id || !row.value || row.value.deleted !== undefined) invalid();
    const record = await this.inspect(row.doc);
    if (record._id !== id || record._rev !== row.value.rev) invalid();
    return record;
  }
  /** Caller must persist this envelope and its exact revision before filesystem effects. */
  async download(value: unknown) {
    const record = await this.inspect(value);
    let body: ArrayBuffer | undefined;
    if (record._attachments) {
      await this.observe?.('attachment-download',record._attachments.content.length-16);
      const response = await this.transport.request('/' + encodeURIComponent(record._id) + '/content?rev=' + encodeURIComponent(record._rev!),
        'GET', undefined, 'application/octet-stream', 'binary');
      if (!(response instanceof ArrayBuffer) || response.byteLength !== record._attachments.content.length) invalid();
      body = response;
    }
    await this.observe?.('content-decryption');
    return decryptRecord(this.crypto, record, body, this.allowedPath);
  }
  /** One encryption attempt and one revision-checked PUT. No automatic conflict retry.
   * Input bytes are borrowed until completion and must remain unchanged.
   */
  async put(input: RecordInput, expectedRevision?: string): Promise<EncryptedRecord> {
    if (!this.allowedPath(input.path) || (expectedRevision !== undefined && !revision(expectedRevision))) invalid();
    const {record, body} = await encryptRecord(this.crypto, input, this.observe);
    if (expectedRevision !== undefined) record._rev = expectedRevision;
    let wire: unknown = record, contentType = 'application/json';
    if (body) {
      await this.observe?.('multipart-allocation');
      const boundary = 'bettersync-' + base64url(randomBytes(24));
      const metadata = {...record, _attachments: {content: {content_type: 'application/octet-stream', follows: true, length: body.byteLength}}};
      const encoder = new TextEncoder();
      const head = encoder.encode('--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(metadata)
        + '\r\n--' + boundary + '\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="content"\r\n\r\n');
      const tail = encoder.encode('\r\n--' + boundary + '--\r\n');
      const multipart = new Uint8Array(head.length + body.byteLength + tail.length);
      multipart.set(head); multipart.set(new Uint8Array(body), head.length); multipart.set(tail, head.length + body.byteLength);
      wire = multipart.buffer; contentType = 'multipart/related; boundary="' + boundary + '"';
    }
    await this.observe?.('attachment-upload');
    const response = await this.transport.request('/' + encodeURIComponent(record._id), 'PUT', wire, contentType) as
      {ok?: unknown; id?: unknown; rev?: unknown} | null;
    if (!response || response.ok !== true || response.id !== record._id || !revision(response.rev)) invalid();
    return {...record, _rev: response.rev};
  }
  /** Bounded rejection descriptors let the engine quarantine one corrupt record
   * without retaining hostile payloads or losing later valid changes. No checkpoint is persisted here.
   */
  async changes(since: Sequence): Promise<EncryptedPage> {
    if (!sequence(since)) invalid();
    const response = await this.transport.request('/_changes?include_docs=true&attachments=false&limit=200&since=' + encodeURIComponent(String(since))) as
      {results?: {id?: unknown; seq?: unknown; doc?: unknown; deleted?: unknown; changes?: {rev?: unknown}[]}[]; last_seq?: unknown} | null;
    if (!response || !Array.isArray(response.results) || response.results.length > 200 || !sequence(response.last_seq)) invalid();
    const results: EncryptedChange[] = [];
    for (const row of response.results) {
      if (!row || !sequence(row.seq)) invalid();
      if (row.id === CONFIGURATION_ID) {
        if (row.deleted) invalid();
        await authenticateConfiguration(this.crypto, row.doc);
        continue;
      }
      if (!opaqueId(row.id)) throw new SyncFailure('configuration', 'This database contains unsupported sync records.');
      // A future/plaintext protocol is a database-level stop, not a per-file retry.
      const schema = row.doc && typeof row.doc === 'object' ? (row.doc as {schema?: unknown}).schema : undefined;
      if (schema !== undefined && schema !== 4) throw new SyncFailure('configuration', 'This database contains an unsupported sync protocol.');
      const protocol = row.doc && typeof row.doc === 'object' ? (row.doc as {protocol?: unknown}).protocol : undefined;
      if (protocol !== undefined && protocol !== CRYPTO_DOMAIN) throw new SyncFailure('configuration', 'This database contains an unsupported sync protocol.');
      try {
        if (row.deleted) invalid();
        const record = await this.inspect(row.doc);
        if (record._id !== row.id || !Array.isArray(row.changes) || row.changes.length !== 1 || row.changes[0]?.rev !== record._rev) invalid();
        results.push({id: row.id, record});
      } catch {
        const rev = Array.isArray(row.changes) && row.changes.length === 1 ? row.changes[0]?.rev : undefined;
        results.push({id: row.id, ...(revision(rev) ? {revision: rev} : {}), rejected: 'invalid-record'});
      }
    }
    return {results, lastSequence: response.last_seq, sourceRows: response.results.length};
  }
}
