/** Schema 5: authenticated manifests and independently authenticated immutable chunks. */
import {VaultCrypto, EncryptionError, CRYPTO_DOMAIN, base64url, unbase64url, base64urlLength, randomBytes} from './crypto';
import {MAX_FILE_BYTES, rawHashAsync, syncPath} from './paths';
export const INLINE_FILE_BYTES=64*1024, CHUNK_BYTES=256*1024, MAX_CHUNKS=MAX_FILE_BYTES/CHUNK_BYTES;
export const MAX_METADATA_BYTES=64*1024, MAX_CHUNK_DOCUMENT_BYTES=384*1024;
export interface LogicalMetadata {
  path:string; kind:'file'|'directory'; deleted:boolean; mtime:number; size:number; hash:string|null;
  version:string|null; chunks:string[]; contentNonce:string|null;
}
export interface EncryptedRecord {
  _id:string; _rev?:string; schema:5; protocol:typeof CRYPTO_DOMAIN; vault:string;
  salt:string; nonce:string; metadata:string; inline?:string;
}
export interface ChunkRecord {_id:string;_rev?:string;schema:5;protocol:typeof CRYPTO_DOMAIN;nonce:string;ciphertext:string}
export interface ChunkContext {fileId:string;salt:string;metadata:LogicalMetadata;index:number}
export interface Outgoing {
  id:string;salt:string;metadata:LogicalMetadata;digest:string|null;base?:string;next:number;prepared?:EncryptedRecord;
}
export interface StagedDownload {id:string;next:number;offset:number;prefixHash:string;complete?:boolean}
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
// Only snapshots validated here are reusable. Freezing both levels prevents
// mutation after validation; JSON/journal reloads must pass validation again.
const validatedMetadata=new WeakSet<object>();
export function invalid():never {throw new EncryptionError();}
export function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value as Record<string,unknown>;
}
export function exact(value:Record<string,unknown>,keys:string[]) {if(Object.keys(value).some(k=>!keys.includes(k)))invalid();}
export function revision(value:unknown):value is string {return typeof value==='string'&&value.length<=256&&/^[1-9][0-9]*-[A-Za-z0-9]+$/.test(value);}
export function fileId(value:unknown):value is string {return typeof value==='string'&&/^f5:[A-Za-z0-9_-]{43}$/.test(value)&&base64urlLength(value.slice(3),32)===32;}
export function chunkId(value:unknown):value is string {return typeof value==='string'&&/^c5:[A-Za-z0-9_-]{22}$/.test(value)&&base64urlLength(value.slice(3),16)===16;}
export function validateMetadata(value:unknown):LogicalMetadata {
  if(value&&typeof value==='object'&&validatedMetadata.has(value))return value as LogicalMetadata;
  const d=object(value);exact(d,['path','kind','deleted','mtime','size','hash','version','chunks','contentNonce']);
  if(typeof d.path!=='string'||!syncPath(d.path)||encoder.encode(d.path).length>4096||decoder.decode(encoder.encode(d.path))!==d.path
    ||!['file','directory'].includes(d.kind as string)||(d.kind==='directory')!==d.path.endsWith('/')||typeof d.deleted!=='boolean'
    ||!Number.isSafeInteger(d.mtime)||(d.mtime as number)<0||!Number.isSafeInteger(d.size)||(d.size as number)<0||(d.size as number)>MAX_FILE_BYTES
    ||!Array.isArray(d.chunks)||d.chunks.length>MAX_CHUNKS)invalid();
  const live=!d.deleted&&d.kind==='file',large=live&&(d.size as number)>INLINE_FILE_BYTES;
  if(!live) {if(d.size!==0||d.hash!==null||d.version!==null||d.contentNonce!==null||d.chunks.length)invalid();}
  else {
    if(typeof d.hash!=='string'||!/^[a-f0-9]{64}$/.test(d.hash))invalid();unbase64url(d.version,32);
    if(large) {
      if(d.contentNonce!==null||d.chunks.length!==Math.ceil((d.size as number)/CHUNK_BYTES)||!d.chunks.every(chunkId)||new Set(d.chunks).size!==d.chunks.length)invalid();
    } else {if(d.chunks.length)invalid();unbase64url(d.contentNonce,12);}
  }
  const result={...d,chunks:[...d.chunks]} as unknown as LogicalMetadata;
  Object.freeze(result.chunks);Object.freeze(result);validatedMetadata.add(result);return result;
}
export function validateEncryptedRecord(value:unknown):EncryptedRecord {
  const d=object(value);exact(d,['_id','_rev','schema','protocol','vault','salt','nonce','metadata','inline']);
  if(d.schema!==5||d.protocol!==CRYPTO_DOMAIN||!fileId(d._id)||(d._rev!==undefined&&!revision(d._rev)))invalid();
  unbase64url(d.vault,16);unbase64url(d.salt,32);unbase64url(d.nonce,12);base64urlLength(d.metadata,16,MAX_METADATA_BYTES+16);
  if(d.inline!==undefined)base64urlLength(d.inline,16,INLINE_FILE_BYTES+16);
  return {...d} as unknown as EncryptedRecord;
}
export async function prepareMetadata(path:string,bytes:ArrayBuffer|undefined,deleted:boolean,mtime:number):Promise<LogicalMetadata> {
  const live=!deleted&&!path.endsWith('/');
  if(live!==(bytes instanceof ArrayBuffer)||(bytes&&bytes.byteLength>MAX_FILE_BYTES))invalid();
  const size=bytes?.byteLength??0,large=live&&size>INLINE_FILE_BYTES;
  return validateMetadata({path,kind:path.endsWith('/')?'directory':'file',deleted,mtime,size,hash:bytes?await rawHashAsync(bytes):null,
    version:live?base64url(randomBytes(32)):null,chunks:large?Array.from({length:Math.ceil(size/CHUNK_BYTES)},()=> 'c5:'+base64url(randomBytes(16))):[],
    contentNonce:live&&!large?base64url(new Uint8Array(12)):null});
}
export async function sealManifest(crypto:VaultCrypto,metadata:LogicalMetadata,salt:string,inline?:ArrayBuffer):Promise<EncryptedRecord> {
  let m=validateMetadata(metadata);const id=await crypto.documentId(m.path);
  let body:string|undefined;
  if(!m.deleted&&m.kind==='file'&&!m.chunks.length) {
    if(!inline||inline.byteLength!==m.size||await rawHashAsync(inline)!==m.hash)invalid();
    const sealed=await crypto.seal(id,salt,'content',inline,[m.version!]);m={...m,contentNonce:sealed.nonce};body=base64url(new Uint8Array(sealed.bytes));
  } else if(inline!==undefined)invalid();
  const encoded=encoder.encode(JSON.stringify(m));if(encoded.byteLength>MAX_METADATA_BYTES)invalid();
  const sealed=await crypto.seal(id,salt,'metadata',encoded);
  return validateEncryptedRecord({_id:id,schema:5,protocol:CRYPTO_DOMAIN,vault:crypto.vaultId,salt,nonce:sealed.nonce,metadata:base64url(new Uint8Array(sealed.bytes)),...(body===undefined?{}:{inline:body})});
}
export async function decryptMetadata(crypto:VaultCrypto,value:unknown,allowed:(path:string)=>boolean):Promise<LogicalMetadata> {
  const r=validateEncryptedRecord(value);if(r.vault!==crypto.vaultId)invalid();
  const bytes=await crypto.open(r._id,r.salt,'metadata',r.nonce,unbase64url(r.metadata,16,MAX_METADATA_BYTES+16).buffer);
  const m=validateMetadata(JSON.parse(decoder.decode(bytes)));
  if(!allowed(m.path)||await crypto.documentId(m.path)!==r._id)invalid();
  const inline=!m.deleted&&m.kind==='file'&&!m.chunks.length;
  if(inline?(r.inline===undefined||base64urlLength(r.inline,16,INLINE_FILE_BYTES+16)!==m.size+16):r.inline!==undefined)invalid();
  return m;
}
export async function openInline(crypto:VaultCrypto,r:EncryptedRecord,m:LogicalMetadata):Promise<ArrayBuffer> {
  if(r.inline===undefined||m.chunks.length||m.contentNonce===null)invalid();
  const bytes=await crypto.open(r._id,r.salt,'content',m.contentNonce,unbase64url(r.inline,16,INLINE_FILE_BYTES+16).buffer,[m.version!]);
  if(bytes.byteLength!==m.size||await rawHashAsync(bytes)!==m.hash)invalid();return bytes;
}
function context(c:ChunkContext):string[] {
  const m=validateMetadata(c.metadata);if(!fileId(c.fileId)||!Number.isInteger(c.index)||c.index<0||c.index>=m.chunks.length)invalid();
  unbase64url(c.salt,32);
  return [m.version!,m.chunks[c.index]!,String(c.index),String(m.chunks.length),String(CHUNK_BYTES),String(chunkLength(c))];
}
export function chunkLength(c:ChunkContext):number {return Math.min(CHUNK_BYTES,c.metadata.size-c.index*CHUNK_BYTES);}
const issued=new WeakSet<EncryptedChunk>();
/** Runtime issuance check prevents accidental plaintext/ID-dependent upload bypasses. */
export class EncryptedChunk {
  private constructor(readonly record:Readonly<ChunkRecord>) {Object.freeze(record);issued.add(this);Object.freeze(this);}
  static isIssued(value:unknown):value is EncryptedChunk {return !!value&&typeof value==='object'&&issued.has(value as EncryptedChunk);}
  static async seal(crypto:VaultCrypto,c:ChunkContext,bytes:Uint8Array<ArrayBuffer>):Promise<EncryptedChunk> {
    const aad=context(c);if(bytes.byteLength!==chunkLength(c)||bytes.byteLength>CHUNK_BYTES)invalid();
    const sealed=await crypto.seal(c.fileId,c.salt,'chunk',bytes,aad);
    const record:ChunkRecord={_id:c.metadata.chunks[c.index]!,schema:5,protocol:CRYPTO_DOMAIN,nonce:sealed.nonce,ciphertext:base64url(new Uint8Array(sealed.bytes))};
    if(encoder.encode(JSON.stringify(record)).length>MAX_CHUNK_DOCUMENT_BYTES)invalid();
    return new EncryptedChunk(record);
  }
}
export async function openChunk(crypto:VaultCrypto,c:ChunkContext,value:unknown):Promise<ArrayBuffer> {
  const aad=context(c),r=object(value);exact(r,['_id','_rev','schema','protocol','nonce','ciphertext']);
  if(r.schema!==5||r.protocol!==CRYPTO_DOMAIN||r._id!==c.metadata.chunks[c.index]||!revision(r._rev)||!r._rev.startsWith('1-'))invalid();
  unbase64url(r.nonce,12);const bytes=unbase64url(r.ciphertext,chunkLength(c)+16).buffer;
  return crypto.open(c.fileId,c.salt,'chunk',r.nonce as string,bytes,aad);
}
