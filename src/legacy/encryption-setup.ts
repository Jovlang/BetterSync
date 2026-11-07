/** Draft key setup. Integration with Obsidian and CouchDB is still pending. */
import {sha256} from '@noble/hashes/sha2.js';
import {base64url, unbase64url, randomBytes, VaultCrypto, EncryptionError, CRYPTO_DOMAIN, frame} from './crypto';
import {SyncFailure} from '../types';

const CODE_PREFIX = 'bse-draft1';
export const CONFIGURATION_ID = 'bettersync:configuration';
const payload = new TextEncoder().encode(JSON.stringify({protocol: CRYPTO_DOMAIN, schema: 4}));
export interface VaultConfiguration {
  _id: typeof CONFIGURATION_ID; _rev?: string; protocol: typeof CRYPTO_DOMAIN; schema: 4;
  vault: string; salt: string; nonce: string; ciphertext: string;
}
export function generateRecoveryCode(): string {
  const secret = randomBytes(32);
  try {
    const vault = base64url(randomBytes(16)), encoded = base64url(secret);
    const checksum = base64url(sha256(frame(CODE_PREFIX, vault, encoded)).slice(0, 6));
    return `${CODE_PREFIX}.${vault}.${encoded}.${checksum}`;
  } finally { secret.fill(0); }
}
/** The checksum detects typos; only authenticated configuration verifies the key. */
export async function importRecoveryCode(value: string): Promise<VaultCrypto> {
  if (typeof value !== 'string' || value.length > 128) throw new EncryptionError();
  const parts = value.trim().split('.');
  if (parts.length !== 4 || parts[0] !== CODE_PREFIX) throw new EncryptionError();
  const [, vault, encoded, checksum] = parts as [string, string, string, string];
  unbase64url(vault, 16);
  const secret = unbase64url(encoded, 32);
  try {
    unbase64url(checksum, 6);
    if (base64url(sha256(frame(CODE_PREFIX, vault, encoded)).slice(0, 6)) !== checksum) throw new EncryptionError();
    return await VaultCrypto.create(secret, vault);
  } finally { secret.fill(0); }
}

export async function createConfiguration(crypto: VaultCrypto): Promise<VaultConfiguration> {
  const salt = base64url(randomBytes(32));
  const sealed = await crypto.seal(CONFIGURATION_ID, salt, 'configuration', payload.buffer);
  return {_id: CONFIGURATION_ID, protocol: CRYPTO_DOMAIN, schema: 4, vault: crypto.vaultId,
    salt, nonce: sealed.nonce, ciphertext: base64url(new Uint8Array(sealed.bytes))};
}
export function validateConfiguration(value: unknown): VaultConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EncryptionError();
  const d = value as Record<string, unknown>;
  if (Object.keys(d).some(k => !['_id', '_rev', 'protocol', 'schema', 'vault', 'salt', 'nonce', 'ciphertext'].includes(k))
    || d._id !== CONFIGURATION_ID || d.protocol !== CRYPTO_DOMAIN || d.schema !== 4
    || (d._rev !== undefined && (typeof d._rev !== 'string' || d._rev.length > 256 || !/^[1-9][0-9]*-[A-Za-z0-9]+$/.test(d._rev))))
    throw new EncryptionError();
  unbase64url(d.vault, 16); unbase64url(d.salt, 32); unbase64url(d.nonce, 12);
  unbase64url(d.ciphertext, payload.length + 16);
  return {...d} as unknown as VaultConfiguration;
}
export async function authenticateConfiguration(crypto: VaultCrypto, value: unknown): Promise<VaultConfiguration> {
  const d = validateConfiguration(value);
  if (d.vault !== crypto.vaultId) throw new EncryptionError();
  const bytes = new Uint8Array(await crypto.open(CONFIGURATION_ID, d.salt, 'configuration', d.nonce,
    unbase64url(d.ciphertext, payload.length + 16).buffer));
  if (bytes.length !== payload.length || bytes.some((b, i) => b !== payload[i])) throw new EncryptionError();
  return d;
}

export interface SetupIntent {
  version: 1; binding: string; vault: string; secretName: string;
  phase: 'prepared' | 'ready'; operation: 'create' | 'join';
  configuration?: VaultConfiguration;
}
export interface SetupStorage {
  load(): Promise<SetupIntent | null>;
  save(intent: SetupIntent): Promise<void>;
}
/** Adapter must use Obsidian SecretStorage, never plugin data or a plaintext fallback. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}
export interface ConfigurationRemote {
  getConfiguration(): Promise<unknown | null>;
  /** Reject nonempty/foreign databases. Never clear or convert them. */
  assertEmpty(): Promise<void>;
  /** Create-only PUT without _rev. A lost response can be retried by reading configuration. */
  createConfiguration(configuration: VaultConfiguration): Promise<void>;
}

/** No file transfer is permitted until this coordinator returns successfully.
 * It serializes setup requests; the caller owns the separate upload/download confirmation.
 */
export class EncryptionSetup {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private binding: string, private storage: SetupStorage, private secrets: SecretStore,
    private remote: ConfigurationRemote) {
    if (!binding) throw new Error('Missing database binding.');
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task); this.tail = next.catch(() => {}); return next;
  }
  /** Call only after the user has confirmed saving the generated recovery code. */
  createConfirmed(code: string): Promise<VaultCrypto> { return this.begin(code, 'create'); }
  join(code: string): Promise<VaultCrypto> { return this.begin(code, 'join'); }
  resume(): Promise<VaultCrypto> {
    return this.serial(async () => {
      const intent = await this.storage.load();
      if (!intent) throw new Error('Encryption setup has not been confirmed.');
      return this.finish(intent);
    });
  }
  private begin(code: string, operation: 'create' | 'join'): Promise<VaultCrypto> {
    return this.serial(async () => {
      const crypto = await importRecoveryCode(code);
      const previous = await this.storage.load();
      if (previous) {
        this.validateIntent(previous);
        if (previous.vault !== crypto.vaultId) throw new EncryptionError();
        // A checksum-valid code with the same vault ID may still have the wrong key.
        const existing = await this.readSecret(previous.secretName);
        if (existing !== null && existing.trim() !== code.trim()) throw new EncryptionError();
        const remoteConfiguration = await this.remote.getConfiguration();
        const configuration = remoteConfiguration ?? (previous.phase === 'prepared' && previous.operation === 'create'
          ? previous.configuration : undefined);
        if (!configuration) throw new EncryptionError();
        await authenticateConfiguration(crypto, configuration);
        await this.persistSecret(previous.secretName, code.trim());
        return this.finish(previous);
      }
      const configuration = await this.remote.getConfiguration();
      if (operation === 'join') {
        if (configuration === null) throw new EncryptionError();
        await authenticateConfiguration(crypto, configuration);
      } else {
        if (configuration !== null) throw new Error('This database already has encryption configured. Join it using its recovery code.');
        await this.remote.assertEmpty();
      }
      // Obsidian SecretStorage accepts lowercase alphanumerics and dashes only.
      const secretName = 'bettersync-' + Array.from(randomBytes(16), b => b.toString(16).padStart(2, '0')).join('');
      await this.persistSecret(secretName, code.trim());
      const intent: SetupIntent = {version: 1, binding: this.binding, vault: crypto.vaultId,
        secretName, phase: 'prepared', operation};
      if (operation === 'create') intent.configuration = await createConfiguration(crypto);
      // A failed save leaves no authorization to perform remote writes.
      await this.storage.save(structuredClone(intent));
      return this.finish(intent);
    });
  }
  private async persistSecret(name: string, code: string) {
    try {
      await this.secrets.set(name, code);
      if (await this.secrets.get(name) !== code) throw new Error();
    } catch { throw new Error('Could not save the encryption key.'); }
  }
  private async readSecret(name: string) {
    try { return await this.secrets.get(name); }
    catch { throw new Error('Could not read the encryption key.'); }
  }
  private validateIntent(intent: SetupIntent) {
    if (intent.version !== 1 || intent.binding !== this.binding || !['prepared', 'ready'].includes(intent.phase)
      || !['create', 'join'].includes(intent.operation) || !/^bettersync-[a-f0-9]{32}$/.test(intent.secretName))
      throw new EncryptionError();
    unbase64url(intent.vault, 16);
  }
  private async finish(intent: SetupIntent): Promise<VaultCrypto> {
    this.validateIntent(intent);
    const code = await this.readSecret(intent.secretName);
    if (!code) throw new Error('The encryption key is missing. Import the saved recovery code.');
    const crypto = await importRecoveryCode(code);
    if (crypto.vaultId !== intent.vault) throw new EncryptionError();
    let configuration = await this.remote.getConfiguration();
    if (configuration === null) {
      if (intent.phase !== 'prepared' || intent.operation !== 'create' || !intent.configuration) throw new EncryptionError();
      const prepared = await authenticateConfiguration(crypto, intent.configuration);
      if (prepared._rev !== undefined) throw new EncryptionError();
      await this.remote.assertEmpty();
      try { await this.remote.createConfiguration(prepared); }
      catch (error) {
        if (!(error instanceof SyncFailure) || error.kind !== 'conflict') throw error;
        // A different creator won. Authenticate its configuration; never overwrite it.
      }
      configuration = await this.remote.getConfiguration();
    }
    await authenticateConfiguration(crypto, configuration);
    if (intent.phase !== 'ready') {
      const {configuration: _prepared, ...ready} = intent;
      await this.storage.save({...ready, phase: 'ready'});
    }
    return crypto;
  }
}
