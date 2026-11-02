import {documentId, hash, syncPath, validateContent} from './paths';
import {preserveConflict} from './conflict-handler';
import {validateDocument} from './couch-client';
import {StateStore, PersistenceFailure} from './local-state';
import {SyncFailure, type FileDocument, type Remote, type VaultClient, type EngineUI} from './types';

export class SyncEngine {
  private dirty = new Set<string>();
  private expectedRemoteWrites = new Map<string,string|null>();
  private running?: Promise<void>;
  private stopped = false;
  private blocked = false;
  private hadConflict = false;
  constructor(private vault:VaultClient, private remote:Remote, private store:StateStore, private ui:EngineUI) {}
  /** A one-time inventory also recovers edits/deletions whose events were missed while closed. */
  async start():Promise<void> {
    this.stopped = false;
    for (const p of [...(await this.vault.listFiles()),...Object.keys(this.store.state.files)]) if(syncPath(p)) this.dirty.add(p);
    await this.tick();
  }
  async stop():Promise<void> { this.stopped=true; await this.running; }
  async changed(path:string):Promise<void> {
    if (!syncPath(path) || this.stopped) return;
    const actual = hash(await this.vault.read(path));
    if (this.expectedRemoteWrites.has(path) && this.expectedRemoteWrites.get(path) === actual) {
      this.expectedRemoteWrites.delete(path); this.ui.log('remote write ignored as expected local event',path); return;
    }
    this.expectedRemoteWrites.delete(path);
    this.dirty.add(path);
  }
  retry():Promise<void> { this.blocked=false; return this.tick(); }
  tick():Promise<void> {
    if(this.running) return this.running;
    if(this.stopped || this.blocked) return Promise.resolve();
    this.running=this.cycle().finally(()=>{this.running=undefined;});
    return this.running;
  }
  private async cycle():Promise<void> {
    this.ui.status('Syncing…');
    try {
      for(const path of await this.vault.scanChanges?.()??[])this.dirty.add(path);
      if(!this.store.state.initialized) {
        if(!await this.initialize()) return;
      }
      // A failed journal save leaves the operation in memory. Re-establish
      // durability before replay so a later poll cannot bypass that failure.
      if(Object.keys(this.store.state.incoming).length) await this.store.save();
      // A persisted incoming operation is completed before advancing any checkpoint.
      let failed=false;
      for(const p of Object.keys(this.store.state.incoming)) {
        try {await this.finishIncoming(p);}
        catch(error) {if(error instanceof PersistenceFailure) throw error;failed=true;this.ui.log('could not apply queued note',p);}
      }
      // Incoming operations are durably queued before application. A failed file
      // stays queued while the checkpoint and unrelated files continue forward.
      for(let page=0;page<20 && !this.stopped;page++) {
        const changes=await this.remote.getChanges(this.store.state.lastSequence);
        for(const change of changes.results) {
          if(this.stopped) return;
          if(!change.id.startsWith('file:')) continue;
          try {
            if(change.deleted) throw new SyncFailure('data','A note was removed outside BetterSync.');
            const doc=validateDocument(change.doc);
            if(this.store.state.rejected) delete this.store.state.rejected[change.id];
            await this.receive(doc);
          } catch(error) {
            if(error instanceof PersistenceFailure || (error instanceof SyncFailure && ['temporary','configuration'].includes(error.kind))) throw error;
            // Invalid server records remain recorded for diagnostics; valid files
            // that could not be written already have a persistent incoming entry.
            if(!Object.values(this.store.state.incoming).some(op=>op.doc._id===change.id)) {
              (this.store.state.rejected??={})[change.id]=change;
              await this.store.save();
            }
            failed=true; this.ui.log('could not apply remote note',change.id);
          }
        }
        this.store.state.lastSequence=changes.last_seq;
        await this.store.save();
        if(changes.results.length<200) break;
      }
      for(const path of [...this.dirty]) {
        if(this.stopped) return;
        if(this.store.state.incoming[path]) continue;
        this.dirty.delete(path);
        try {await this.push(path);}
        catch(error) {
          this.dirty.add(path);
          if(error instanceof PersistenceFailure || (error instanceof SyncFailure && ['temporary','configuration'].includes(error.kind))) throw error;
          failed=true; if(error instanceof Error && error.message.includes('200 MiB'))this.ui.notice('File exceeds the 200 MiB sync limit: '+path);
          this.ui.log('could not upload local note',path);
        }
      }
      this.ui.status(failed || Object.keys(this.store.state.rejected??{}).length ? 'Sync error' : this.hadConflict ? 'Conflict' : this.dirty.size ? 'Syncing…' : 'Synced');
    } catch(error) {
      const failure=error instanceof SyncFailure ? error : new SyncFailure('data','Could not sync changes. Retry to continue.');
      if(failure.kind==='configuration') {this.blocked=true;this.ui.notice(failure.message);}
      this.ui.status(failure.kind==='temporary'?'Offline':'Sync error');
      this.ui.log('sync attempt failed');
    }
  }
  private async initialize():Promise<boolean> {
    await this.remote.testConnection();
    const state=this.store.state;
    if(!state.setup) {
      let probe:import('./types').Sequence=0;
      let hasRemote=false;
      for(;;) {
        const page=await this.remote.getChanges(probe);
        hasRemote=page.results.some(c=>c.id.startsWith('file:'));
        if(hasRemote || page.results.length<200) break;
        if(page.last_seq===probe) throw new SyncFailure('data','Could not read the sync database.');
        probe=page.last_seq;
        if(this.stopped) return false;
      }
      const local=(await this.vault.listFiles()).filter(syncPath);
      if(local.length && hasRemote) {
        this.blocked=true;this.ui.status('Sync error');
        this.ui.notice('This device and the server both already contain files. Automatic first-time merging is not supported yet.');return false;
      }
      if(local.length || hasRemote) {
        const direction=local.length?'upload':'download';
        const choice=await this.ui.confirm(direction);
        if(choice!==direction || this.stopped) {this.blocked=true;this.ui.status('Sync error');return false;}
        state.setup=direction;
        await this.store.save();
      }
    }
    // Persist setup before any file transfer. Interrupted setup resumes conservatively.
    state.initialized=true;
    await this.store.save();
    return true;
  }
  private async receive(doc:FileDocument):Promise<void> {
    const state=this.store.state;
    const base=state.files[doc.path];
    if(base?.rev===doc._rev) return;
    state.incoming[doc.path]={doc,expected:base?.hash ?? null};
    await this.store.save();
    await this.finishIncoming(doc.path);
  }
  private async finishIncoming(path:string):Promise<void> {
    const state=this.store.state;
    const operation=state.incoming[path];
    if(!operation) return;
    const {doc,expected}=operation;
    const desired=doc.deleted ? null : doc.content;
    for(let attempt=0;attempt<8;attempt++) {
      const local=await this.vault.read(path), current=hash(local);
      if(current===hash(desired)) {await this.accept(doc);return;}
      if(current!==expected) {
        if(local!==null) {
          const copy=await preserveConflict(this.vault,path,local,state.clientId);
          this.dirty.add(copy);
        }
        this.hadConflict=true;
        this.ui.notice(`Sync conflict in ${path}. Both versions were kept.`);
        this.ui.log('conflict detected',path);
      }
      this.expectedRemoteWrites.set(path,hash(desired));
      if(await this.vault.compareAndSet(path,current,desired)) {
        await this.accept(doc);this.ui.log('remote write applied',path);return;
      }
      this.expectedRemoteWrites.delete(path);
    }
    throw new SyncFailure('data','This note is changing too quickly. Sync will retry.');
  }
  private async accept(doc:FileDocument):Promise<void> {
    this.store.state.files[doc.path]={rev:doc._rev!,hash:hash(doc.deleted?null:doc.content)};
    delete this.store.state.incoming[doc.path];
    await this.store.save();
  }
  private async push(path:string):Promise<void> {
    const base=this.store.state.files[path];
    const content=await this.vault.read(path), digest=hash(content);
    if(digest===(base?.hash ?? null)) return;
    if(content!==null) validateContent(path,content);
    const remote=await this.remote.getDocument(path);
    if(remote && remote._rev!==base?.rev) {await this.receive(remote);return;}
    if(!remote && base) throw new SyncFailure('data','A synced note is missing from the server.');
    const doc:FileDocument={_id:documentId(path),schema:path.endsWith('.md')?1:2,path,content:content??'',deleted:content===null,mtime:Date.now()};
    if(base) doc._rev=base.rev;
    try {
      const saved=content===null?await this.remote.deleteDocument(doc):await this.remote.putDocument(doc);
      // Record exactly what was uploaded, never a newer local edit made during HTTP.
      this.store.state.files[path]={rev:saved._rev!,hash:digest};
      await this.store.save();
      if(hash(await this.vault.read(path))!==digest) this.dirty.add(path);
      this.ui.log('remote document updated',path);
    } catch(error) {
      if(error instanceof SyncFailure && error.kind==='conflict') {
        const current=await this.remote.getDocument(path);
        if(current) {await this.receive(current);return;}
      }
      throw error;
    }
  }
}
