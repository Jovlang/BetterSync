import type {SetupIntent, SetupStorage} from './encryption-setup';

/** Adapter for the plugin's serialized persistence owner. The update callback
 * must resolve only after saveData succeeds and preserve other saved fields.
 * Keeping this callback under the plugin's existing write queue prevents lost
 * updates between setup, settings and engine checkpoints.
 */
export class PersistentSetupStorage implements SetupStorage {
  private tail: Promise<unknown> = Promise.resolve();
  private committed: SetupIntent | null;
  constructor(initial: SetupIntent | null, private persist: (intent: SetupIntent) => Promise<void>) {
    this.committed = structuredClone(initial);
  }
  async load(): Promise<SetupIntent | null> {
    await this.tail;
    return structuredClone(this.committed);
  }
  save(intent: SetupIntent): Promise<void> {
    const snapshot = structuredClone(intent);
    const operation = this.tail.then(async () => {
      try { await this.persist(structuredClone(snapshot)); }
      catch { throw new Error('Could not save encryption setup. Check available storage and retry.'); }
      this.committed = snapshot;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
