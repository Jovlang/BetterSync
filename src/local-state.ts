import type {LocalSyncState} from './types';
export function freshState(binding: string): LocalSyncState {
  const clientId=typeof crypto.randomUUID==='function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  return {version:1, clientId, binding, initialized:false, lastSequence:0, files:{}, incoming:{}};
}
export class PersistenceFailure extends Error {}
/** Serial persistence: an older save can never finish after a newer save. */
export class StateStore {
  private tail: Promise<void> = Promise.resolve();
  constructor(public state: LocalSyncState, private write: (state: LocalSyncState) => Promise<void>) {}
  save(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const next = this.tail.then(() => this.write(snapshot)).catch(() => {throw new PersistenceFailure('Could not save sync progress. Check available storage and retry.');});
    this.tail = next.catch(() => {});
    return next;
  }
}
