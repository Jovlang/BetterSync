import type {Connection,Http} from './couch-client';
import {EncryptedCouch} from './encrypted-couch';
import {VaultCrypto,base64url,randomBytes,unbase64url} from './crypto';
import {CHUNK_BYTES,INLINE_FILE_BYTES,EncryptedChunk,prepareMetadata,sealManifest,decryptMetadata,openInline,validateMetadata,validateEncryptedRecord,revision,invalid,
  type Outgoing,type LogicalMetadata} from './encrypted-protocol';
import {decodeBinary,hashAsync,rawHashAsync,validateContent} from './paths';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {preserveConflict} from './conflict-handler';
import {SyncFailure,type Remote,type FileDocument,type Content,type Sequence,type TransferContext,type Baseline,type UploadResult,type Incoming} from './types';
type TimedStage='read'|'baselineHash'|'metadata'|'encrypt'|'uploadRequest'|'downloadRequest'|'append'|'verify'|'install';

export class EncryptedRemote implements Remote {
  private context?:TransferContext;
  readonly diagnostics={sourceBytes:0,peakSourceBytes:0,maxChunkBytes:0,uploadedChunks:0,downloadedChunks:0};
  readonly timings:Partial<Record<TimedStage,{calls:number;ms:number}>>={};
  private async timed<T>(stage:TimedStage,operation:()=>Promise<T>):Promise<T> {
    const start=performance.now();
    try {return await operation();}finally{const total=this.timings[stage]??={calls:0,ms:0};total.calls++;total.ms+=performance.now()-start;}
  }
  private report(direction:'upload'|'download',size:number) {
    if(!Number.isSafeInteger(size)||size<=INLINE_FILE_BYTES)return;
    const stages=Object.entries(this.timings).map(([name,t])=>`${name}_ms=${Math.round(t.ms)} ${name}_calls=${t.calls}`).join(' ');
    const journal=this.ctx().store.diagnostics;
    this.ctx().log(`transfer performance scope=session direction=${direction} bytes=${size} ${stages} journal_saves=${journal.saves} journal_clone_ms=${Math.round(journal.cloneMs)} journal_write_ms=${Math.round(journal.writeMs)}`);
  }
  private constructor(private wire:EncryptedCouch,private crypto:VaultCrypto,readonly stateBinding:string) {}
  static async connect(connection:Connection,http:Http,crypto:VaultCrypto,allowed:(p:string)=>boolean) {
    const wire=await EncryptedCouch.connect(connection,http,crypto,allowed);
    return new EncryptedRemote(wire,crypto,await crypto.stateBinding(JSON.stringify([new URL(connection.url).href.replace(/\/$/,''),connection.database])));
  }
  bindTransfer(context:TransferContext) {this.context=context;}
  release() {this.diagnostics.sourceBytes=0;}
  private ctx() {if(!this.context)throw new Error('Transfer coordinator is not attached.');return this.context;}
  ownsRecord(id:string) {return id.startsWith('f5:');}
  identity(path:string) {return this.crypto.documentId(path);}
  async testConnection() {await this.wire.changes(0);}
  private async logical(value:unknown):Promise<FileDocument> {
    const {record,metadata:m}=await this.wire.metadata(value);
    return {_id:record._id,_rev:record._rev,schema:3,path:m.path,mtime:m.mtime,deleted:m.deleted,size:m.size,manifest:record};
  }
  async validateIncoming(value:unknown):Promise<FileDocument> {
    if(!value||typeof value!=='object')invalid();const supplied=value as FileDocument;
    const doc=await this.logical(supplied.manifest);
    if(Object.keys(supplied).some(k=>!['_id','_rev','schema','path','mtime','deleted','size','manifest'].includes(k))
      ||['_id','_rev','schema','path','mtime','deleted','size'].some(k=>supplied[k as keyof FileDocument]!==doc[k as keyof FileDocument]))invalid();return doc;
  }
  async getDocument(path:string) {const r=await this.wire.get(path);return r?this.logical(r):null;}
  async readContent(value:FileDocument):Promise<Content|null> {
    const doc=await this.validateIncoming(value),r=doc.manifest!,m=await decryptMetadata(this.crypto,r,this.wire.allowed);
    if(m.deleted)return null;if(m.kind==='directory')return 'directory';
    if(m.chunks.length)throw new SyncFailure('data','Large files require staged authenticated reads.');
    const bytes=await openInline(this.crypto,r,m);
    return doc.path.endsWith('.md')?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes):bytes;
  }
  async getChanges(since:Sequence) {
    const page=await this.wire.changes(since),results=[];
    for(const row of page.results)results.push({seq:page.lastSequence,id:row.id,...('record' in row?{doc:await this.logical(row.record)}:{})});
    return {results,last_seq:page.lastSequence,sourceRows:page.sourceRows};
  }
  private async validateOutgoing(path:string,op:Outgoing) {
    const m=validateMetadata(op.metadata);unbase64url(op.salt,32);
    if(m.path!==path||op.id!==await this.identity(path)||!Number.isInteger(op.next)||op.next<0||op.next>m.chunks.length
      ||op.base!==undefined&&!revision(op.base)||!(op.digest===null||typeof op.digest==='string'&&/^[a-f0-9]{64}$/.test(op.digest)))invalid();
    if(op.prepared) {
      const r=validateEncryptedRecord(op.prepared),prepared=await decryptMetadata(this.crypto,r,this.wire.allowed);
      if(r._rev!==undefined||r._id!==op.id||r.salt!==op.salt||!this.sameVersion(prepared,m))invalid();
    }
    op.metadata=m;
  }
  private sameVersion(a:LogicalMetadata,b:LogicalMetadata) {
    return a.path===b.path&&a.kind===b.kind&&a.deleted===b.deleted&&a.version===b.version&&a.mtime===b.mtime&&a.size===b.size&&a.hash===b.hash&&JSON.stringify(a.chunks)===JSON.stringify(b.chunks);
  }
  async reconcileIncoming(doc:FileDocument) {
    const op=this.ctx().store.state.outgoing?.[doc.path];
    if(!op?.prepared)return undefined;
    await this.validateOutgoing(doc.path,op);
    const m=await decryptMetadata(this.crypto,doc.manifest!,this.wire.allowed);
    return doc.manifest!.salt===op.salt&&this.sameVersion(m,op.metadata)?{digest:op.digest}:undefined;
  }
  async uploadLocal(path:string,base?:Baseline):Promise<UploadResult> {
    const ctx=this.ctx(),outgoing=ctx.store.state.outgoing??=Object.create(null);
    let op=outgoing[path];if(op)await this.validateOutgoing(path,op);
    // Reconcile a committed snapshot before requiring its possibly deleted source.
    let latest=op?await this.wire.get(path):undefined;
    if(op?.prepared&&latest) {
      const m=await decryptMetadata(this.crypto,latest,this.wire.allowed);
      if(latest.salt===op.salt&&this.sameVersion(m,op.metadata))return {kind:'accepted',doc:await this.logical(latest),digest:op.digest};
    }
    if((await ctx.vault.fileSize?.(path)??0)>INLINE_FILE_BYTES)this.wire.assertChunkAvailable();
    await ctx.stage(path,'local-read');
    let content=await this.timed('read',()=>ctx.vault.read(path));
    if(content!==null)validateContent(path,content);
    await ctx.stage(path,'source-hash',content instanceof ArrayBuffer?content.byteLength:undefined);
    const digest=await this.timed('baselineHash',()=>hashAsync(content));
    if(digest===(base?.hash??null)) {if(op){delete outgoing[path];await ctx.store.save();}return {kind:'unchanged'};}
    // Unchanged inventory must not cost a network request per file.
    if(latest===undefined)latest=await this.wire.get(path);
    if(latest&&latest._rev!==base?.rev) {delete outgoing[path];await ctx.store.save();return {kind:'conflict',doc:await this.logical(latest)};}
    if(!latest&&base)throw new SyncFailure('data','A synced file is missing from the server.');
    let bytes:ArrayBuffer|undefined=content===null||path.endsWith('/')?undefined:content instanceof ArrayBuffer?content:
      path.endsWith('.md')?new TextEncoder().encode(content).buffer:decodeBinary(content);
    const deleted=content===null;content=null;
    const sourceSize=bytes?.byteLength??0;
    const mtime=await ctx.vault.modificationTime?.(path)??Date.now();
    try {
      this.diagnostics.sourceBytes=bytes?.byteLength??0;this.diagnostics.peakSourceBytes=Math.max(this.diagnostics.peakSourceBytes,this.diagnostics.sourceBytes);
      if(!op||op.digest!==digest||op.base!==base?.rev||op.metadata.size!==(bytes?.byteLength??0)||op.metadata.hash!==(bytes?await rawHashAsync(bytes):null)) {
        const metadata=await this.timed('metadata',()=>prepareMetadata(path,bytes,deleted,mtime));
        op={id:await this.identity(path),salt:base64url(randomBytes(32)),metadata,digest,base:base?.rev,next:0};outgoing[path]=op;
        if(!metadata.chunks.length)op.prepared=await sealManifest(this.crypto,metadata,op.salt,bytes);
        await ctx.store.save();
      }
      if(op.metadata.chunks.length) {
        if(!bytes)invalid();
        await ctx.stage(path,'chunk-network',bytes.byteLength);
        let checkpoint=performance.now();
        for(let i=op.next;i<op.metadata.chunks.length;i++) {
          if(ctx.stopped()) {await ctx.store.save();return {kind:'changed'};}
          this.wire.assertChunkAvailable();
          await this.sendChunk(op,i,bytes);
          op.next=i+1;this.diagnostics.uploadedChunks++;
          ctx.log(`transfer upload stage=chunk-confirmed bytes=${op.metadata.size} chunk=${op.next}/${op.metadata.chunks.length}`);
          if(op.next%4===0||performance.now()-checkpoint>=1000||op.next===op.metadata.chunks.length) {
            await ctx.store.save();await ctx.cooperate(path);checkpoint=performance.now();
          }
        }
        // Drop all source references before reading the live source again.
        bytes=undefined;this.release();await ctx.stage(path,'source-recheck');
        if(await this.currentDigest(path)!==digest) {delete outgoing[path];await ctx.store.save();return {kind:'changed'};}
        if(!op.prepared) {op.prepared=await sealManifest(this.crypto,op.metadata,op.salt);await ctx.store.save();}
      }
      bytes=undefined;this.release();await ctx.stage(path,'manifest-commit');
      try {return {kind:'accepted',doc:await this.logical(await this.wire.putManifest(op.prepared!,base?.rev)),digest};}
      catch(error) {
        if(error instanceof SyncFailure&&error.kind==='conflict') {
          const current=await this.wire.get(path);if(current)return {kind:'conflict',doc:await this.logical(current)};
        }
        throw error;
      }
    } finally {bytes=undefined;this.release();this.report('upload',sourceSize);}
  }
  private async currentDigest(path:string) {
    const content=await this.timed('read',()=>this.ctx().vault.read(path));
    return this.timed('baselineHash',()=>hashAsync(content));
  }
  private async sendChunk(op:Outgoing,index:number,source:ArrayBuffer) {
    const c={fileId:op.id,salt:op.salt,metadata:op.metadata,index};
    const bytes=new Uint8Array(source,index*CHUNK_BYTES,Math.min(CHUNK_BYTES,source.byteLength-index*CHUNK_BYTES));
    this.diagnostics.maxChunkBytes=Math.max(this.diagnostics.maxChunkBytes,bytes.byteLength);
    const ctx=this.ctx();ctx.log(`transfer upload stage=chunk-encrypt bytes=${op.metadata.size} chunk=${index+1}/${op.metadata.chunks.length} source-live=${this.diagnostics.sourceBytes}`);
    const sealed=await this.timed('encrypt',()=>EncryptedChunk.seal(this.crypto,c,bytes));
    const usage=this.wire.usage();
    ctx.log(`transfer upload stage=chunk-request bytes=${op.metadata.size} chunk=${index+1}/${op.metadata.chunks.length} pending=${usage?usage.chunks+usage.controls:'unavailable'} held=${usage?.bytesHeld??'unavailable'}`);
    await this.timed('uploadRequest',()=>this.wire.putChunk(sealed,c,bytes));
  }
  private async restorePrefix(operation:Incoming) {
    const ctx=this.ctx(),stage=ctx.vault.staging!,s=operation.staged!;
    const h=sha256.create();
    if(await stage.size(s.id)!==s.offset)return null;
    const bytes=new Uint8Array(await stage.read(s.id));
    if(bytes.byteLength!==s.offset)return null;
    for(let i=0;i<bytes.length;i+=CHUNK_BYTES) {h.update(bytes.subarray(i,i+CHUNK_BYTES));await new Promise(resolve=>setTimeout(resolve,0));}
    if(bytesToHex(h.clone().digest())!==s.prefixHash)return null;return h;
  }
  async applyLocal(value:FileDocument,operation:Incoming):Promise<{digest:string|null;conflicts:string[]}|undefined> {
    try {return await this.applyLocalMeasured(value,operation);}finally{this.report('download',value.size??0);}
  }
  private async applyLocalMeasured(value:FileDocument,operation:Incoming):Promise<{digest:string|null;conflicts:string[]}|undefined> {
    const doc=await this.validateIncoming(value),r=doc.manifest!,m=await decryptMetadata(this.crypto,r,this.wire.allowed);
    const binary=m.kind==='file'&&!doc.path.endsWith('.md');
    if(!m.chunks.length&&!binary)return undefined;
    const ctx=this.ctx(),stage=ctx.vault.staging;
    if(!stage)throw new SyncFailure('configuration','Safe attachment staging is unavailable. Update Obsidian to 1.12.3 or later.');
    if(m.deleted) {
      await ctx.stage(doc.path,'local-write');
      return {digest:null,conflicts:await stage.deleteLocal(doc.path,operation.expected,ctx.store.state.clientId)};
    }
    let s=operation.staged;
    if(s&&(s.id!==m.version||!Number.isInteger(s.next)||s.next<0||s.next>m.chunks.length||
      (m.chunks.length?s.offset!==Math.min(s.next*CHUNK_BYTES,m.size):s.offset!==0&&s.offset!==m.size)||typeof s.prefixHash!=='string'||!/^[a-f0-9]{64}$/.test(s.prefixHash)))invalid();
    await ctx.stage(doc.path,'stage-verification',m.size);
    let h=s?await this.timed('verify',()=>this.restorePrefix(operation)):null;
    if(!s||!h) {
      s={id:m.version!,next:0,offset:0,prefixHash:bytesToHex(sha256(new Uint8Array()))};operation.staged=s;
      await ctx.store.save();await stage.reset(s.id);h=sha256.create();
    }
    if(!m.chunks.length) {
      // Inline remote contents may replace a huge local binary. Use disk-to-disk
      // preservation here too, never the buffer-based legacy compare-and-set.
      const bytes=await openInline(this.crypto,r,m);await stage.reset(s.id);await stage.append(s.id,bytes);
      h=sha256.create().update(new Uint8Array(bytes));s.offset=m.size;s.prefixHash=bytesToHex(h.clone().digest());await ctx.store.save();
    }
    await ctx.stage(doc.path,'chunk-network',m.size);
    let checkpoint=performance.now(),checkpointNext=s.next;
    for(let first=s.next;first<m.chunks.length;first+=2) {
      if(ctx.stopped())throw new SyncFailure('temporary','Transfer suspended.');
      // A fixed pair bounds response/plaintext retention. Settle both before
      // writing or yielding to other work; never leave an unobserved rejection
      // or let an out-of-order result advance the durable contiguous prefix.
      const pair=await Promise.allSettled(Array.from({length:Math.min(2,m.chunks.length-first)},(_,offset)=>
        this.timed('downloadRequest',()=>this.wire.downloadChunk({fileId:r._id,salt:r.salt,metadata:m,index:first+offset}))));
      for(const result of pair)if(result.status==='rejected')throw result.reason;
      for(const result of pair) {
        if(ctx.stopped())throw new SyncFailure('temporary','Transfer suspended.');
        if(result.status!=='fulfilled')invalid();
        const bytes=result.value,stageId=s.id;
        await this.timed('append',()=>stage.append(stageId,bytes));h.update(new Uint8Array(bytes));
        s.next++;s.offset+=bytes.byteLength;s.prefixHash=bytesToHex(h.clone().digest());
        this.diagnostics.downloadedChunks++;ctx.log(`transfer download stage=chunk-staged bytes=${m.size} chunk=${s.next}/${m.chunks.length}`);
      }
      if(s.next-checkpointNext>=4||performance.now()-checkpoint>=1000||s.next===m.chunks.length) {await ctx.store.save();await ctx.cooperate(doc.path);checkpoint=performance.now();checkpointNext=s.next;}
    }
    if(s.offset!==m.size||bytesToHex(h.digest())!==m.hash)invalid();
    await ctx.stage(doc.path,'stage-verification',m.size);
    const stageId=s.id;
    const verified=await this.timed('verify',()=>stage.inspect(stageId));if(verified.size!==m.size||verified.raw!==m.hash)invalid();
    s.complete=true;await ctx.store.save();await ctx.stage(doc.path,'local-write',m.size);
    const conflicts:string[]=[];
    if(doc.path.endsWith('.md')) {
      const desired=await stage.readText(s.id),digest=await hashAsync(desired);
      if(await rawHashAsync(new TextEncoder().encode(desired).buffer)!==m.hash)invalid();
      for(let i=0;i<8;i++) {
        const local=await ctx.vault.read(doc.path),current=await hashAsync(local);
        if(current===digest)return {digest:digest!,conflicts};
        if(current!==operation.expected&&local!==null)conflicts.push(await preserveConflict(ctx.vault,doc.path,local,ctx.store.state.clientId));
        if(await ctx.vault.compareAndSet(doc.path,current,desired,m.mtime))return {digest:digest!,conflicts};
      }
    } else {
      for(let i=0;i<8;i++) {
        const result=await this.timed('install',()=>stage.install(doc.path,stageId,operation.expected,verified.digest,m.mtime,ctx.store.state.clientId));conflicts.push(...result.conflicts);
        if(result.matched)return {digest:verified.digest,conflicts};
      }
    }
    throw new SyncFailure('data','The file is changing too quickly. Pending work is retained.');
  }
  async finishLocal(doc:FileDocument) {
    const m=await decryptMetadata(this.crypto,doc.manifest!,this.wire.allowed);
    if(m.version&&(m.chunks.length||!doc.path.endsWith('.md')))await this.ctx().vault.staging?.remove(m.version);
  }
  async getAttachment(_doc:FileDocument):Promise<ArrayBuffer> {throw new SyncFailure('data','Use authenticated staging.');}
  async putDocument(_doc:FileDocument,_bytes?:ArrayBuffer):Promise<FileDocument> {throw new SyncFailure('data','Use encrypted local transfers.');}
  async deleteDocument(_doc:FileDocument):Promise<FileDocument> {throw new SyncFailure('data','Use encrypted local transfers.');}
}
