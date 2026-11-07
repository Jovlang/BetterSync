import type {Connection, Http, HttpResponse} from './couch-client';
import {SyncFailure, PendingTransferFailure} from './types';
import {PendingRequestFailure} from './http';

/** Shared portable HTTP boundary for legacy sync and draft encrypted setup. */
export class CouchHttp {
  private base: string;
  private headers: Record<string, string>;
  constructor(connection: Connection, private http: Http) {
    let url: URL;
    try { url = new URL(connection.url); } catch { throw new SyncFailure('configuration', 'Enter a valid HTTPS server address.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !connection.database.trim())
      throw new SyncFailure('configuration', 'Enter an HTTPS server address and database name.');
    this.base = url.href.replace(/\/$/, '') + '/' + encodeURIComponent(connection.database);
    const bytes = new TextEncoder().encode(`${connection.username}:${connection.password}`);
    this.headers = {Authorization: 'Basic ' + btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))};
  }
  async request(path: string, method = 'GET', body?: unknown, contentType = 'application/json', responseType: 'json' | 'binary' = 'json'): Promise<unknown> {
    let response: HttpResponse;
    try {
      response = await this.http(this.base + path, method, {...this.headers, 'Content-Type': contentType},
        body instanceof ArrayBuffer ? body : body === undefined ? undefined : JSON.stringify(body), responseType);
    } catch(error) {
      if(error instanceof PendingRequestFailure)throw new PendingTransferFailure();
      throw new SyncFailure('temporary', 'Offline. Changes will sync when the server is available again.');
    }
    if (response.status === 409) throw new SyncFailure('conflict', 'A record changed on another device.');
    if ([401, 403].includes(response.status)) throw new SyncFailure('configuration', 'Could not sign in to the sync server. Check the server address, username, and password.');
    if (response.status === 404 && responseType === 'binary') throw new SyncFailure('data', 'The queued attachment revision is unavailable. The incoming operation remains queued.');
    if (response.status === 404) throw new SyncFailure('configuration', 'Could not find the sync database. Check the server address and database name.');
    if (response.status >= 500 || [408, 429].includes(response.status)) throw new SyncFailure('temporary', 'The sync server is temporarily unavailable.');
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) throw new SyncFailure('data', 'The sync server could not accept this change.');
    return responseType === 'binary' ? response.arrayBuffer : response.json;
  }
}
