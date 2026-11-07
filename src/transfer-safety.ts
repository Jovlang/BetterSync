import {StateStore, PersistenceFailure} from './local-state';
import {SyncFailure, PendingTransferFailure, type EngineUI} from './types';

/** Body-free write-ahead markers. A process kill cannot run a catch/finally block. */
export class TransferSafety {
  private current?:string;
  constructor(private store:StateStore, private ui:EngineUI) {}
  async recover():Promise<void> {
    let changed=false;
    for(const attempt of Object.values(this.store.state.transfers??{})) {
      if(!attempt.active)continue;
      attempt.active=false;attempt.paused=true;attempt.reason='interrupted';changed=true;
      this.ui.log(`transfer interrupted stage=${attempt.stage} bytes=${attempt.size??'unknown'}`);
    }
    if(changed)await this.store.save();
    if(Object.values(this.store.state.transfers??{}).some(attempt=>attempt.paused))this.notice();
  }
  private notice() {this.ui.notice('An attachment transfer is paused after failure or interruption. Your local files are kept. Use Retry to try it again. Other files can continue syncing.');}
  async retry():Promise<string[]> {
    const paths=Object.keys(this.store.state.transfers??{});
    for(const attempt of Object.values(this.store.state.transfers??{})) {
      attempt.paused=false;attempt.active=false;attempt.failures=0;delete attempt.reason;
    }
    await this.store.save();return paths;
  }
  async stage(stage:string,size?:number):Promise<void> {
    if(!this.current)return;
    const attempt=this.store.state.transfers![this.current]!;
    attempt.stage=stage;if(size!==undefined)attempt.size=size;
    // No path, identity, key, body or arbitrary exception in diagnostics.
    this.ui.log(`transfer ${attempt.direction} stage=${stage} bytes=${attempt.size??'unknown'}`);
    await this.store.save();
  }
  async run(path:string,direction:'upload'|'download',operation:()=>Promise<void>,size?:number|null):Promise<void> {
    // The engine is serial. A conflict can invoke incoming work within a push.
    if(this.current || path.endsWith('.md') || path.endsWith('/'))return operation();
    const transfers=this.store.state.transfers??=Object.create(null);
    // A deleted local source must not remain stuck behind its old upload marker.
    if(direction==='upload' && size===null)delete transfers[path];
    if(transfers[path]?.paused)throw new SyncFailure('data','Attachment transfer is paused. Use Retry.');
    const attempt=transfers[path]??{direction,stage:'start',active:false,failures:0,paused:false};
    transfers[path]=attempt;attempt.direction=direction;attempt.active=true;
    this.current=path;
    try {
      await this.stage(direction==='upload'?'local-read':'incoming-read',size??undefined);
      await operation();
      delete transfers[path];await this.store.save();
    } catch(error) {
      // Keep the durable active marker if persistence itself is broken.
      if(error instanceof PersistenceFailure)throw error;
      attempt.active=false;
      // An ordinary offline response completed cleanly; reconnect should resume it.
      // Native timeouts with a still-live request are classified separately.
      if(!(error instanceof SyncFailure && error.kind==='temporary' && !(error instanceof PendingTransferFailure)))attempt.failures++;
      attempt.paused=attempt.failures>=2;
      attempt.reason=error instanceof PendingTransferFailure?'native-request-pending':error instanceof SyncFailure?error.kind:'operation';
      this.ui.log(`transfer failed stage=${attempt.stage} reason=${attempt.reason} attempts=${attempt.failures}`);
      await this.store.save();
      if(attempt.paused)this.notice();
      if(error instanceof SyncFailure && error.kind==='configuration')throw error;
      // A per-attachment failure must not abort unrelated uploads or feed rows.
      throw new SyncFailure('data','Attachment transfer failed. Pending work is retained.');
    } finally {this.current=undefined;}
  }
}
