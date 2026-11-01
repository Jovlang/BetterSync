import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export function hash(content: string | null): string | null {
  return content === null ? null : bytesToHex(sha256(new TextEncoder().encode(content)));
}
export function markdown(path: string): boolean {
  return path.endsWith('.md') && !path.includes('\\') && !path.includes('\0') && !/[\u0000-\u001f]/.test(path)
    && path.split('/').every(p => !!p && p !== '.' && p !== '..' && !p.startsWith('.'));
}
export function documentId(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return 'file:' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
