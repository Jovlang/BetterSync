/** Experimental E2EE primitives. Not connected to the sync transport yet. */
import {syncPath} from './paths';

export class EncryptionError extends Error {
  constructor() { super('Could not authenticate encrypted sync data.'); }
}
const encoder = new TextEncoder();
export const CRYPTO_DOMAIN = 'bettersync-e2ee-draft-1';
export function frame(...parts: string[]): Uint8Array<ArrayBuffer> {
  const encoded = parts.map(p => encoder.encode(p));
  const bytes = new Uint8Array(encoded.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const part of encoded) {
    view.setUint32(offset, part.length, false); offset += 4;
    bytes.set(part, offset); offset += part.length;
  }
  return bytes;
}
export function base64url(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Bounds checked before allocation, and noncanonical encodings rejected. */
export function unbase64url(value: unknown, min: number, max = min): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3)
    || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new EncryptionError();
  try {
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    if (raw.length < min || raw.length > max) throw new EncryptionError();
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    if (base64url(bytes) !== value) throw new EncryptionError();
    return bytes;
  } catch { throw new EncryptionError(); }
}
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  try { return globalThis.crypto.getRandomValues(new Uint8Array(length)); }
  catch { throw new Error('Secure randomness is unavailable. Sync cannot start.'); }
}
type Purpose = 'metadata' | 'content' | 'configuration';
export interface Sealed { nonce: string; bytes: ArrayBuffer }

export class VaultCrypto {
  private constructor(readonly vaultId: string, private root: CryptoKey, private ids: CryptoKey) {}

  static async create(secret: Uint8Array, vaultId: string): Promise<VaultCrypto> {
    unbase64url(vaultId, 16);
    if (secret.length !== 32) throw new EncryptionError();
    const copy = new Uint8Array(secret);
    try {
      const subtle = globalThis.crypto.subtle;
      const root = await subtle.importKey('raw', copy, 'HKDF', false, ['deriveKey']);
      const ids = await subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: unbase64url(vaultId, 16),
        info: frame(CRYPTO_DOMAIN, 'path-id')}, root, {name: 'HMAC', hash: 'SHA-256', length: 256}, false, ['sign']);
      return new VaultCrypto(vaultId, root, ids);
    } catch { throw new Error('Required encryption capabilities are unavailable. Sync cannot start.'); }
    finally { copy.fill(0); }
  }

  async documentId(path: string): Promise<string> {
    if (!syncPath(path) || new TextDecoder('utf-8', {fatal: true}).decode(encoder.encode(path)) !== path)
      throw new EncryptionError();
    return 'e4:' + base64url(new Uint8Array(await crypto.subtle.sign('HMAC', this.ids, frame(CRYPTO_DOMAIN, 'path', path))));
  }

  private async parameters(id: string, salt: string, purpose: Purpose) {
    if (!/^e4:[A-Za-z0-9_-]{43}$/.test(id) && !(id === 'bettersync:configuration' && purpose === 'configuration'))
      throw new EncryptionError();
    const key = await crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: unbase64url(salt, 32),
      info: frame(CRYPTO_DOMAIN, this.vaultId, id, purpose)}, this.root,
    {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    return {key, additionalData: frame(CRYPTO_DOMAIN, '4', this.vaultId, id, salt, purpose)};
  }

  async seal(id: string, salt: string, purpose: Purpose, plaintext: ArrayBuffer): Promise<Sealed> {
    const {key, additionalData} = await this.parameters(id, salt, purpose);
    const iv = randomBytes(12);
    const bytes = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData, tagLength: 128}, key, plaintext);
    return {nonce: base64url(iv), bytes};
  }

  async open(id: string, salt: string, purpose: Purpose, nonce: string, ciphertext: ArrayBuffer): Promise<ArrayBuffer> {
    try {
      if (ciphertext.byteLength < 16) throw new EncryptionError();
      const iv = unbase64url(nonce, 12);
      const {key, additionalData} = await this.parameters(id, salt, purpose);
      return await crypto.subtle.decrypt({name: 'AES-GCM', iv, additionalData, tagLength: 128}, key, ciphertext);
    } catch { throw new EncryptionError(); }
  }
}
