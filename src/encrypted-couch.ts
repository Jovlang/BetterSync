import type {Connection,Http} from './couch-client';
import {CouchHttp} from './couch-http';
import {CouchConfiguration} from './couch-configuration';
import {authenticateConfiguration,CONFIGURATION_ID} from './encryption-setup';
import {VaultCrypto,CRYPTO_DOMAIN} from './crypto';
import {EncryptedChunk,openChunk,validateEncryptedRecord,decryptMetadata,revision,fileId,chunkId,object,invalid,
  type ChunkContext,type EncryptedRecord} from './encrypted-protocol';
import {SyncFailure,type Sequence} from './types';
import {PendingTransferFailure} from './types';
import {PendingRequestFailure} from './http';
export class EncryptedCouch {
  private transport:CouchHttp;
  private constructor(connection:Connection,private http:Http,readonly crypto:VaultCrypto,readonly allowed:(path:string)=>boolean) {this.transport=new CouchHttp(connection,http);}
  static async connect(connection:Connection,http:Http,crypto:VaultCrypto,allowed:(path:string)=>boolean) {
    await authenticateConfiguration(crypto,await new CouchConfiguration(connection,http).getConfiguration());
    return new EncryptedCouch(connection,http,crypto,allowed);
  }
  assertChunkAvailable() {
    try {(this.http as Http&{assertChunkAvailable?:()=>void}).assertChunkAvailable?.();}
    catch(error) {if(error instanceof PendingRequestFailure)throw new PendingTransferFailure();throw error;}
  }
  usage() {return (this.http as Http&{usage?:()=>{chunks:number;controls:number;bytesHeld:number}}).usage?.();}
  async raw(id:string):Promise<unknown|null> {
    const response=object(await this.transport.request('/_all_docs?include_docs=true&attachments=false','POST',{keys:[id]}));
    if(!Array.isArray(response.rows)||response.rows.length!==1)invalid();const r=object(response.rows[0]);
    if(r.key!==id)invalid();
    if(r.error==='not_found'&&r.doc===undefined&&r.value===undefined)return null;
    const v=object(r.value),d=object(r.doc);
    if(r.id!==id||r.error!==undefined||v.deleted!==undefined||d._id!==id||!revision(d._rev)||v.rev!==d._rev)invalid();
    return d;
  }
  async metadata(value:unknown) {
    const record=validateEncryptedRecord(value);if(!record._rev)invalid();
    return {record,metadata:await decryptMetadata(this.crypto,record,this.allowed)};
  }
  async get(path:string) {
    if(!this.allowed(path))invalid();const raw=await this.raw(await this.crypto.documentId(path));
    return raw===null?null:(await this.metadata(raw)).record;
  }
  async putManifest(value:EncryptedRecord,expected?:string):Promise<EncryptedRecord> {
    const record=validateEncryptedRecord(value);await decryptMetadata(this.crypto,record,this.allowed);
    if(record._rev!==undefined||(expected!==undefined&&!revision(expected)))invalid();
    const r=object(await this.transport.request('/'+encodeURIComponent(record._id),'PUT',{...record,...(expected?{_rev:expected}:{})}));
    if(r.ok!==true||r.id!==record._id||!revision(r.rev))invalid();return {...record,_rev:r.rev};
  }
  async putChunk(sealed:EncryptedChunk,c:ChunkContext,expected:Uint8Array<ArrayBuffer>):Promise<void> {
    if(!EncryptedChunk.isIssued(sealed)||sealed.record._id!==c.metadata.chunks[c.index])invalid();
    this.assertChunkAvailable();
    try {
      const r=object(await this.transport.request('/'+encodeURIComponent(sealed.record._id),'PUT',sealed.record));
      if(r.ok!==true||r.id!==sealed.record._id||!revision(r.rev)||!r.rev.startsWith('1-'))invalid();
    } catch(error) {
      if(!(error instanceof SyncFailure)||error.kind!=='conflict')throw error;
      const actual=new Uint8Array(await this.downloadChunk(c));
      if(actual.length!==expected.length||actual.some((b,i)=>b!==expected[i]))invalid();
    }
  }
  async downloadChunk(c:ChunkContext):Promise<ArrayBuffer> {
    this.assertChunkAvailable();const raw=await this.raw(c.metadata.chunks[c.index]!);
    if(raw===null)throw new SyncFailure('data','A required encrypted part is missing. Pending work is retained.');
    return openChunk(this.crypto,c,raw);
  }
  async changes(since:Sequence) {
    if(!(typeof since==='number'&&Number.isSafeInteger(since)&&since>=0)&&!(typeof since==='string'&&since.length>0&&since.length<=8192))invalid();
    const page=object(await this.transport.request('/_changes?include_docs=false&limit=200&since='+encodeURIComponent(String(since))));
    if(!Array.isArray(page.results)||page.results.length>200||!(typeof page.last_seq==='number'&&Number.isSafeInteger(page.last_seq)&&page.last_seq>=0||typeof page.last_seq==='string'&&page.last_seq.length>0&&page.last_seq.length<=8192))invalid();
    const wanted:{id:string;rev:string}[]=[],results:({id:string;record:EncryptedRecord}|{id:string;rejected:true})[]=[];
    for(const value of page.results) {
      const row=object(value);
      if(!(typeof row.seq==='number'&&Number.isSafeInteger(row.seq)&&row.seq>=0||typeof row.seq==='string'&&row.seq.length>0&&row.seq.length<=8192))invalid();
      if(row.id===CONFIGURATION_ID) {await authenticateConfiguration(this.crypto,await this.raw(CONFIGURATION_ID));continue;}
      if(chunkId(row.id))continue;
      if(!fileId(row.id))throw new SyncFailure('configuration','This database uses an unsupported sync format. Use a fresh schema-5 test database.');
      if(row.deleted||!Array.isArray(row.changes)||row.changes.length!==1||!revision(row.changes[0]?.rev)) {results.push({id:row.id,rejected:true});continue;}
      wanted.push({id:row.id,rev:row.changes[0].rev});
    }
    for(let i=0;i<wanted.length;i+=16) {
      const batch=wanted.slice(i,i+16),response=object(await this.transport.request('/_bulk_get?revs=false&attachments=false','POST',{docs:batch}));
      if(!Array.isArray(response.results)||response.results.length!==batch.length)invalid();
      for(let j=0;j<batch.length;j++) {
        const expected=batch[j]!;
        try {
          const result=object(response.results[j]);if(result.id!==expected.id||!Array.isArray(result.docs)||result.docs.length!==1)invalid();
          const raw=object(result.docs[0]).ok;
          if(raw&&typeof raw==='object'&&('schema' in raw&&raw.schema!==5||'protocol' in raw&&raw.protocol!==CRYPTO_DOMAIN))
            throw new SyncFailure('configuration','This database contains an unsupported sync protocol.');
          const {record}=await this.metadata(raw);
          if(record._id!==expected.id||record._rev!==expected.rev)invalid();results.push({id:record._id,record});
        } catch(error) {if(error instanceof SyncFailure&&error.kind==='configuration')throw error;results.push({id:expected.id,rejected:true});}
      }
    }
    return {results,lastSequence:page.last_seq as Sequence,sourceRows:page.results.length};
  }
}
