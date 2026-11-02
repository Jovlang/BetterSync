import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export function hash(content: string | ArrayBuffer | null): string | null {
  if(content instanceof ArrayBuffer) {
    // Retain legacy baseline/conflict digests without allocating a full base64 string.
    const digest=sha256.create(), bytes=new Uint8Array(content), encoder=new TextEncoder();
    for(let i=0;i<bytes.length;i+=32766) digest.update(encoder.encode(btoa(String.fromCharCode(...bytes.subarray(i,i+32766)))));
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
