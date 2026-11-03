import type {App, SecretStorage} from 'obsidian';
import type {SecretStore} from './encryption-setup';

/** No Node/Electron APIs and no plugin-data fallback. Capability checked at runtime. */
export class ObsidianSecrets implements SecretStore {
  private storage: Pick<SecretStorage, 'getSecret' | 'setSecret'>;
  constructor(app: Pick<App, 'secretStorage'>) {
    const storage = app.secretStorage;
    if (!storage || typeof storage.getSecret !== 'function' || typeof storage.setSecret !== 'function')
      throw new Error('Encryption requires Obsidian secret storage (1.11.4 or later).');
    this.storage = storage;
  }
  private validate(name: string) {
    if (!/^bettersync-[a-f0-9]{32}$/.test(name)) throw new Error('Invalid encryption secret reference.');
  }
  async get(name: string): Promise<string | null> {
    this.validate(name);
    try {
      const value = this.storage.getSecret(name);
      if (value !== null && typeof value !== 'string') throw new Error();
      return value;
    } catch { throw new Error('Could not read the encryption key.'); }
  }
  async set(name: string, value: string): Promise<void> {
    this.validate(name);
    try {
      this.storage.setSecret(name, value);
      if (this.storage.getSecret(name) !== value) throw new Error();
    } catch { throw new Error('Could not save the encryption key.'); }
  }
}
