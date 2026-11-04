import type {Connection, Http} from './couch-client';
import {EncryptedCouch} from './encrypted-couch';
import {VaultCrypto} from './crypto';
import {decodeBinary, validateContent} from './paths';
import {SyncFailure, type Remote, type FileDocument, type Content, type Sequence, type RemoteChanges} from './types';

/** Adapts authenticated records to the existing single serial engine.
 * Journals contain the ciphertext envelope plus local metadata, never file bodies.
 */
export class EncryptedRemote implements Remote {
  private constructor(private wire: EncryptedCouch, private crypto: VaultCrypto, readonly stateBinding: string) {}
  static async connect(connection: Connection, http: Http, crypto: VaultCrypto, allowedPath: (path: string) => boolean) {
    const wire = await EncryptedCouch.connect(connection, http, crypto, allowedPath);
    const databaseIdentity = JSON.stringify([new URL(connection.url).href.replace(/\/$/, ''), connection.database]);
    return new EncryptedRemote(wire, crypto, await crypto.stateBinding(databaseIdentity));
  }
  ownsRecord(id: string) { return id.startsWith('e4:'); }
  identity(path: string) { return this.crypto.documentId(path); }
  async testConnection() { await this.wire.changes(0); }
  private async logical(value: unknown): Promise<FileDocument> {
    const {record, metadata} = await this.wire.metadata(value);
    return {_id: record._id, _rev: record._rev, schema: 3, path: metadata.path,
      mtime: metadata.mtime, deleted: metadata.deleted, encrypted: record};
  }
  async validateIncoming(value: unknown): Promise<FileDocument> {
    const supplied = value as Partial<FileDocument> | null;
    if (!supplied?.encrypted) throw new SyncFailure(supplied ? 'configuration' : 'data', 'Missing encrypted record.');
    const doc = await this.logical(supplied.encrypted);
    if (supplied.path !== doc.path || supplied._id !== doc._id || supplied._rev !== doc._rev
      || supplied.deleted !== doc.deleted || supplied.mtime !== doc.mtime || supplied.schema !== 3
      || Object.keys(supplied).some(k => !['_id', '_rev', 'schema', 'path', 'mtime', 'deleted', 'encrypted'].includes(k)))
      throw new SyncFailure('data', 'The encrypted journal is inconsistent.');
    return doc;
  }
  async getDocument(path: string) {
    const record = await this.wire.get(path);
    return record ? this.logical(record) : null;
  }
  async readContent(value: FileDocument): Promise<Content | null> {
    const doc = await this.validateIncoming(value);
    const opened = await this.wire.download(doc.encrypted);
    if (opened.metadata.deleted) return null;
    if (opened.metadata.kind === 'directory') return 'directory';
    if (!opened.bytes) throw new SyncFailure('data', 'Missing encrypted file bytes.');
    return doc.path.endsWith('.md') ? new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(opened.bytes) : opened.bytes;
  }
  async writeContent(path: string, content: Content | null, rev?: string, mtime = Date.now()): Promise<FileDocument> {
    if (content !== null) validateContent(path, content);
    const bytes = content === null || path.endsWith('/') ? undefined : content instanceof ArrayBuffer ? content
      : path.endsWith('.md') ? new TextEncoder().encode(content).buffer : decodeBinary(content);
    return this.logical(await this.wire.put({path, bytes, deleted: content === null, mtime}, rev));
  }
  async getChanges(since: Sequence): Promise<RemoteChanges> {
    const page = await this.wire.changes(since);
    const results: RemoteChanges['results'] = [];
    for (const change of page.results) results.push({seq: page.lastSequence, id: change.id,
      ...('record' in change ? {doc: await this.logical(change.record)} : {})});
    return {results, last_seq: page.lastSequence, sourceRows: page.sourceRows};
  }
  // Prevent accidental use of a plaintext serializer or attachment bypass.
  async getAttachment(_doc: FileDocument): Promise<ArrayBuffer> { throw new SyncFailure('data', 'Use authenticated content reads.'); }
  async putDocument(_doc: FileDocument, _bytes?: ArrayBuffer): Promise<FileDocument> { throw new SyncFailure('data', 'Use encrypted content writes.'); }
  async deleteDocument(_doc: FileDocument): Promise<FileDocument> { throw new SyncFailure('data', 'Use encrypted deletion writes.'); }
}
