import type {LocalSyncState} from './types';
export function freshState(binding: string): LocalSyncState {
  const clientId=typeof crypto.randomUUID==='function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  return {version:1, clientId, binding, initialized:false, lastSequence:0, files:Object.create(null), incoming:Object.create(null)};
}
export class PersistenceFailure extends Error {}
/** Serial persistence: an older save can never finish after a newer save. */
export class StateStore {
  private tail: Promise<void> = Promise.resolve();
  readonly diagnostics={saves:0,cloneMs:0,writeMs:0};
  constructor(public state: LocalSyncState, private write: (state: LocalSyncState) => Promise<void>) {
    // JSON and structuredClone restore ordinary prototypes. Normalize every
    // loaded state, retaining own entries such as a file named __proto__.
    Object.setPrototypeOf(state.files,null);
    Object.setPrototypeOf(state.incoming,null);
    if(state.rejected) Object.setPrototypeOf(state.rejected,null);
    if(state.transfers) Object.setPrototypeOf(state.transfers,null);
    if(state.outgoing) Object.setPrototypeOf(state.outgoing,null);
  }
  save(): Promise<void> {
    const start=performance.now();
    const snapshot = structuredClone(this.state);
    this.diagnostics.saves++;this.diagnostics.cloneMs+=performance.now()-start;
    const next = this.tail.then(async() => {
      const started=performance.now();
      try {await this.write(snapshot);}finally{this.diagnostics.writeMs+=performance.now()-started;}
    }).catch(() => {throw new PersistenceFailure('Could not save sync progress. Check available storage and retry.');});
    this.tail = next.catch(() => {});
    return next;
  }
}
