import {documentId, syncPath, validateContent} from './paths';
import {SyncFailure, type FileDocument, type Remote, type RemoteChanges, type Sequence} from './types';
export interface Connection {url:string; database:string; username:string; password:string}
export interface HttpResponse {status:number; json:unknown}
export type Http = (url:string, method:string, headers:Record<string,string>, body?:string) => Promise<HttpResponse>;
export function validateDocument(value: unknown): FileDocument {
  const d = value as Partial<FileDocument> | null;
  if (!d || (d.schema !== 1 && d.schema !== 2) || typeof d.path !== 'string' || !syncPath(d.path)
    || d._id !== documentId(d.path) || typeof d._rev !== 'string'
    || typeof d.content !== 'string' || typeof d.deleted !== 'boolean' || !Number.isFinite(d.mtime))
    throw new SyncFailure('data', 'The server contains an unreadable note.');
  if(d.schema===1 && !d.path!.endsWith('.md')) throw new SyncFailure('data','Unsupported legacy record.');
  if(!d.deleted) validateContent(d.path!,d.content!);
  return d as FileDocument;
}
export class CouchClient implements Remote {
  private base: string;
  private headers: Record<string,string>;
  constructor(connection: Connection, private http: Http) {
    let url: URL;
    try { url = new URL(connection.url); } catch { throw new SyncFailure('configuration','Enter a valid HTTPS server address.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !connection.database.trim())
      throw new SyncFailure('configuration','Enter an HTTPS server address and database name.');
    this.base = url.href.replace(/\/$/, '') + '/' + encodeURIComponent(connection.database);
    const bytes = new TextEncoder().encode(`${connection.username}:${connection.password}`);
    this.headers = {'Authorization':'Basic '+btoa(Array.from(bytes,b=>String.fromCharCode(b)).join('')), 'Content-Type':'application/json'};
  }
  private async request(path:string, method='GET', body?:unknown): Promise<unknown> {
    let response: HttpResponse;
    try { response = await this.http(this.base+path,method,this.headers,body === undefined ? undefined : JSON.stringify(body)); }
    catch { throw new SyncFailure('temporary','Offline. Changes will sync when the server is available again.'); }
    if (response.status === 409) throw new SyncFailure('conflict','A note changed on another device.');
    if ([401,403].includes(response.status)) throw new SyncFailure('configuration','Could not sign in to the sync server. Check the server address, username, and password.');
    if (response.status === 404) throw new SyncFailure('configuration','Could not find the sync database. Check the server address and database name.');
    if (response.status >= 500 || [408,429].includes(response.status)) throw new SyncFailure('temporary','The sync server is temporarily unavailable.');
    if (response.status < 200 || response.status >= 300) throw new SyncFailure('data','The sync server could not accept this change.');
    return response.json;
  }
  async testConnection(): Promise<void> { await this.request(''); }
  async getDocument(path:string): Promise<FileDocument | null> {
    // _all_docs distinguishes a missing document from a missing database (both GET 404).
    const result = await this.request('/_all_docs?include_docs=true','POST',{keys:[documentId(path)]}) as {rows:{doc?:unknown;error?:string;value?:{deleted?:boolean}}[]};
    const row = result.rows?.[0];
    if (!row) throw new SyncFailure('data','The server returned an unreadable response.');
    if (row.error === 'not_found') return null;
    if (!row.doc) throw new SyncFailure('data','A note was removed outside BetterSync. Restore it on the server before retrying.');
    return validateDocument(row.doc);
  }
  async putDocument(doc: FileDocument): Promise<FileDocument> {
    const result = await this.request('/'+encodeURIComponent(doc._id),'PUT',doc) as {rev:string};
    if (typeof result.rev !== 'string') throw new SyncFailure('data','The server returned an unreadable response.');
    return {...doc,_rev:result.rev};
  }
  async deleteDocument(doc:FileDocument):Promise<FileDocument> { return this.putDocument({...doc,deleted:true,content:''}); }
  async getChanges(since:Sequence):Promise<RemoteChanges> {
    const result = await this.request('/_changes?include_docs=true&limit=200&since='+encodeURIComponent(String(since))) as RemoteChanges;
    if (!Array.isArray(result.results) || result.last_seq === undefined) throw new SyncFailure('data','The server returned an unreadable response.');
    return result;
  }
}
