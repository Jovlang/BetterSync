import type {Connection, Http} from './couch-client';
import {CouchHttp} from './couch-http';
import {CONFIGURATION_ID, validateConfiguration, type ConfigurationRemote, type VaultConfiguration} from './encryption-setup';
import {SyncFailure} from './types';

function unreadable(): never { throw new SyncFailure('data', 'The server returned an unreadable encryption configuration.'); }
export class CouchConfiguration implements ConfigurationRemote {
  private transport: CouchHttp;
  constructor(connection: Connection, http: Http) { this.transport = new CouchHttp(connection, http); }

  async getConfiguration(): Promise<VaultConfiguration | null> {
    // Avoid interpreting a missing database or native tombstone as a new vault.
    const response = await this.transport.request('/_all_docs?include_docs=true', 'POST', {keys: [CONFIGURATION_ID]}) as
      {rows?: {key?: unknown; id?: unknown; error?: unknown; value?: {rev?: unknown; deleted?: unknown}; doc?: unknown}[]} | null;
    if (!response || !Array.isArray(response.rows) || response.rows.length !== 1) unreadable();
    const row = response.rows[0]!;
    if (!row || row.key !== CONFIGURATION_ID) unreadable();
    if (row.error === 'not_found' && row.doc === undefined && row.value === undefined && row.id === undefined) return null;
    if (row.error !== undefined || row.id !== CONFIGURATION_ID || !row.value || row.value.deleted !== undefined) unreadable();
    const doc = validateConfiguration(row.doc);
    if (!doc._rev || doc._rev !== row.value.rev) unreadable();
    return doc;
  }

  async assertEmpty(): Promise<void> {
    // Tombstones make a database non-fresh, even though _all_docs omits them.
    const info = await this.transport.request('') as {doc_count?: unknown; doc_del_count?: unknown} | null;
    if (!info || !Number.isSafeInteger(info.doc_count) || !Number.isSafeInteger(info.doc_del_count)
      || (info.doc_count as number) < 0 || (info.doc_del_count as number) < 0) unreadable();
    if (info.doc_count !== 0 || info.doc_del_count !== 0)
      throw new SyncFailure('configuration', 'Encryption setup requires a fresh, empty database.');
  }

  async createConfiguration(value: VaultConfiguration): Promise<void> {
    const doc = validateConfiguration(value);
    if (doc._rev !== undefined) throw new SyncFailure('data', 'Encryption configuration can only be created once.');
    const result = await this.transport.request('/' + encodeURIComponent(CONFIGURATION_ID), 'PUT', doc) as
      {ok?: unknown; id?: unknown; rev?: unknown} | null;
    if (!result || result.ok !== true || result.id !== CONFIGURATION_ID || typeof result.rev !== 'string'
      || !/^1-[A-Za-z0-9]+$/.test(result.rev) || result.rev.length > 256) unreadable();
  }
}
