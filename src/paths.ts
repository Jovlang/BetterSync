import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
// Multiples of three keep padding confined to the final block. Feed base64
// ASCII straight to SHA-256: no spread, UTF-16 strings or TextEncoder copies.
const BASE64_BLOCK=32766;
const BASE64_ASCII=new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
function base64Block(bytes:Uint8Array,start:number,out:Uint8Array):Uint8Array {
  const end=Math.min(start+BASE64_BLOCK,bytes.length);let n=0;
  for(let i=start;i<end;i+=3) {
    const a=bytes[i]!,b=i+1<end?bytes[i+1]!:0,c=i+2<end?bytes[i+2]!:0;
    out[n++]=BASE64_ASCII[a>>>2]!;
    out[n++]=BASE64_ASCII[((a&3)<<4)|(b>>>4)]!;
    out[n++]=i+1<end?BASE64_ASCII[((b&15)<<2)|(c>>>6)]!:61;
    out[n++]=i+2<end?BASE64_ASCII[c&63]!:61;
  }
  return out.subarray(0,n);
}
export function hash(content: string | ArrayBuffer | null): string | null {
  if(content instanceof ArrayBuffer) {
    // Retain legacy baseline/conflict digests without allocating a full base64 string.
    const digest=sha256.create(), bytes=new Uint8Array(content),scratch=new Uint8Array(Math.ceil(Math.min(bytes.length,BASE64_BLOCK)/3)*4);
    for(let i=0;i<bytes.length;i+=BASE64_BLOCK) digest.update(base64Block(bytes,i,scratch));
    return bytesToHex(digest.digest());
  }
  return content === null ? null : bytesToHex(sha256(new TextEncoder().encode(content)));
}
export function markdown(path: string): boolean {
  return syncPath(path) && path.endsWith('.md');
}
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export function syncPath(path:string):boolean {
  if(path.endsWith('/')) path=path.slice(0,-1);
  return !!path && !/[\\\u0000-\u001f:]/.test(path)
    && path.split('/').every(p=>!!p && p!=='.' && p!=='..' && p.toLowerCase()!=='.obsidian' && p.toLowerCase()!=='.trash');
}
export function encodeBinary(buffer:ArrayBuffer):string {
  const bytes=new Uint8Array(buffer);let result='';
  for(let i=0;i<bytes.length;i+=32766) result+=btoa(String.fromCharCode(...bytes.subarray(i,i+32766)));
  return result;
}
export function decodeBinary(content:string):ArrayBuffer {
  const bytes=new Uint8Array(content.length/4*3-(content.endsWith('==')?2:content.endsWith('=')?1:0));let offset=0;
  for(let i=0;i<content.length;i+=32768) {const part=atob(content.slice(i,i+32768));for(let j=0;j<part.length;j++)bytes[offset++]=part.charCodeAt(j);}
  return bytes.buffer;
}
export function rawHash(bytes:ArrayBuffer):string {return bytesToHex(sha256(new Uint8Array(bytes)));}
/** Incremental CPU work with bounded scratch space; the adapter still owns a whole-file buffer.
 * Preserve the legacy base64 digest used by baselines and conflict names exactly.
 */
export async function hashAsync(content:string|ArrayBuffer|null):Promise<string|null> {
  if(!(content instanceof ArrayBuffer))return hash(content);
  const digest=sha256.create(),bytes=new Uint8Array(content),scratch=new Uint8Array(Math.ceil(Math.min(bytes.length,BASE64_BLOCK)/3)*4);
  let deadline=performance.now()+8;
  for(let i=0;i<bytes.length;i+=BASE64_BLOCK) {
    digest.update(base64Block(bytes,i,scratch));
    if(performance.now()>=deadline) {await new Promise(resolve=>setTimeout(resolve,0));deadline=performance.now()+8;}
  }
  return bytesToHex(digest.digest());
}
export async function rawHashAsync(buffer:ArrayBuffer):Promise<string> {
  const digest=sha256.create(),bytes=new Uint8Array(buffer);
  let deadline=performance.now()+8;
  for(let i=0;i<bytes.length;i+=65536) {
    digest.update(bytes.subarray(i,i+65536));
    if(performance.now()>=deadline) {await new Promise(resolve=>setTimeout(resolve,0));deadline=performance.now()+8;}
  }
  return bytesToHex(digest.digest());
}
export function validateContent(path:string,content:string|ArrayBuffer):void {
  if(content instanceof ArrayBuffer) {
    if(markdown(path)||path.endsWith('/'))throw new Error('Unexpected binary content.');
    if(content.byteLength>MAX_FILE_BYTES)throw new Error('File exceeds 200 MiB.');
    return;
  }
  if(path.endsWith('/')) {if(content!=='directory')throw new Error('Invalid directory record.');return;}
  if(markdown(path)) {if(new TextEncoder().encode(content).length>MAX_FILE_BYTES)throw new Error('File exceeds 200 MiB.');return;}
  if(content.length>Math.ceil(MAX_FILE_BYTES/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length%4!==0)throw new Error('Invalid or oversized binary file.');
  const size=content.length/4*3-(content.endsWith('==')?2:content.endsWith('=')?1:0);
  if(size>MAX_FILE_BYTES)throw new Error('File exceeds 200 MiB.');
}
export function documentId(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return 'file:' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
