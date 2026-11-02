import {documentId, syncPath, validateContent, MAX_FILE_BYTES, rawHash} from './paths';
import {SyncFailure, type FileDocument, type Remote, type RemoteChanges, type Sequence} from './types';
export interface Connection {url:string; database:string; username:string; password:string}
export interface HttpResponse {status:number; json?:unknown; arrayBuffer?:ArrayBuffer}
export type Http = (url:string, method:string, headers:Record<string,string>, body?:string|ArrayBuffer, responseType?:'json'|'binary') => Promise<HttpResponse>;
export function validateDocument(value: unknown): FileDocument {
  const d = value as Partial<FileDocument> | null;
  if (!d || (d.schema !== 1 && d.schema !== 2 && d.schema !== 3) || typeof d.path !== 'string' || !syncPath(d.path)
    || d._id !== documentId(d.path) || typeof d._rev !== 'string'
    || typeof d.deleted !== 'boolean' || !Number.isFinite(d.mtime))
    throw new SyncFailure('data', 'The server contains an unreadable note.');
  if(d.schema===1 && !d.path!.endsWith('.md')) throw new SyncFailure('data','Unsupported legacy record.');
  if(d.schema===3) {
    const attachment=d._attachments?.content;
    if(d.path.endsWith('/') || d.path.endsWith('.md') || d.content!==undefined
      || !Number.isSafeInteger(d.size) || d.size!<0 || d.size!>MAX_FILE_BYTES
      || typeof d.hash!=='string' || !/^[a-f0-9]{64}$/.test(d.hash)
      || (d.deleted ? d._attachments!==undefined : !attachment || attachment.stub!==true
        || attachment.length!==d.size || attachment.content_type!=='application/octet-stream'
        || Object.keys(d._attachments!).length!==1 || 'data' in attachment || 'follows' in attachment))
      throw new SyncFailure('data','Invalid binary attachment metadata.');
  } else {
    if(typeof d.content!=='string')throw new SyncFailure('data','Missing content.');
    if(!d.deleted) validateContent(d.path!,d.content);
  }
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
  private async request(path:string, method='GET', body?:unknown, contentType='application/json', responseType:'json'|'binary'='json'): Promise<unknown> {
    let response: HttpResponse;
    try { response = await this.http(this.base+path,method,{...this.headers,'Content-Type':contentType},body instanceof ArrayBuffer ? body : body === undefined ? undefined : JSON.stringify(body),responseType); }
    catch { throw new SyncFailure('temporary','Offline. Changes will sync when the server is available again.'); }
    if (response.status === 409) throw new SyncFailure('conflict','A note changed on another device.');
    if ([401,403].includes(response.status)) throw new SyncFailure('configuration','Could not sign in to the sync server. Check the server address, username, and password.');
    if (response.status === 404 && responseType==='binary') throw new SyncFailure('data','The queued attachment revision is unavailable. The incoming operation remains queued.');
    if (response.status === 404) throw new SyncFailure('configuration','Could not find the sync database. Check the server address and database name.');
    if (response.status >= 500 || [408,429].includes(response.status)) throw new SyncFailure('temporary','The sync server is temporarily unavailable.');
    if (response.status < 200 || response.status >= 300) throw new SyncFailure('data','The sync server could not accept this change.');
    return responseType==='binary'?response.arrayBuffer:response.json;
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
  async getAttachment(doc:FileDocument):Promise<ArrayBuffer> {
    validateDocument(doc);
    if(doc.schema!==3 || doc.deleted)throw new SyncFailure('data','No binary attachment.');
    const bytes=await this.request('/'+encodeURIComponent(doc._id)+'/content?rev='+encodeURIComponent(doc._rev!), 'GET',undefined,'application/octet-stream','binary');
    if(!(bytes instanceof ArrayBuffer) || bytes.byteLength!==doc.size || rawHash(bytes)!==doc.hash)
      throw new SyncFailure('data','Binary attachment integrity check failed.');
    return bytes;
  }
  async putDocument(doc: FileDocument, bytes?:ArrayBuffer): Promise<FileDocument> {
    let body:unknown=doc, contentType='application/json';
    if(doc.schema===3 && !doc.deleted) {
      validateDocument({...doc,_rev:doc._rev??'new'});
      if(!bytes || bytes.byteLength!==doc.size || rawHash(bytes)!==doc.hash)
        throw new SyncFailure('data','Binary attachment integrity check failed.');
      // One revision-checked PUT: no observable metadata-only intermediate revision.
      const boundary='bettersync-'+Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join('');
      const metadata={...doc,_attachments:{content:{content_type:'application/octet-stream',length:bytes.byteLength,follows:true}}};
      const encoder=new TextEncoder();
      const head=encoder.encode('--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="content"\r\n\r\n');
      const tail=encoder.encode('\r\n--'+boundary+'--\r\n');
      const multipart=new Uint8Array(head.length+bytes.byteLength+tail.length);
      multipart.set(head);multipart.set(new Uint8Array(bytes),head.length);multipart.set(tail,head.length+bytes.byteLength);
      body=multipart.buffer;contentType='multipart/related; boundary="'+boundary+'"';
    }
    const result = await this.request('/'+encodeURIComponent(doc._id),'PUT',body,contentType) as {rev:string};
    if (typeof result.rev !== 'string') throw new SyncFailure('data','The server returned an unreadable response.');
    return {...doc,_rev:result.rev};
  }
  async deleteDocument(doc:FileDocument):Promise<FileDocument> { const {_attachments,size,hash,...marker}=doc; return this.putDocument({...marker,schema:doc.path.endsWith('.md')?1:2,deleted:true,content:''}); }
  async getChanges(since:Sequence):Promise<RemoteChanges> {
    const result = await this.request('/_changes?include_docs=true&attachments=false&limit=200&since='+encodeURIComponent(String(since))) as RemoteChanges;
    if (!Array.isArray(result.results) || result.last_seq === undefined) throw new SyncFailure('data','The server returned an unreadable response.');
    return result;
  }
}
