import {TFile, MarkdownView, type App} from 'obsidian';
import {hash, hashAsync, rawHashAsync, markdown, syncPath, MAX_FILE_BYTES, decodeBinary, validateContent} from './paths';
import type {VaultClient, Content, BinaryStaging, FileInspection} from './types';
export class ObsidianVault implements VaultClient {
  private inventory=new Map<string,string>();
  constructor(private app:App) {}
  assertStagingSupport():void {
    if(typeof this.app.vault.adapter.appendBinary!=='function')throw new Error('BetterSync requires Obsidian 1.12.3 or later for safe attachment transfers.');
  }
  private stagePath(id:string):string {
    if(!/^[A-Za-z0-9_-]{43}$/.test(id))throw new Error('Invalid staging identity.');
    return '.trash/bettersync/stage5-'+id;
  }
  private async inspectDisk(path:string):Promise<FileInspection> {
    const stat=await this.app.vault.adapter.stat(path);
    if(!stat||stat.type!=='file'||stat.size>MAX_FILE_BYTES)throw new Error('Missing or oversized staged file.');
    const bytes=await this.app.vault.adapter.readBinary(path);
    if(bytes.byteLength>MAX_FILE_BYTES)throw new Error('File exceeds 200 MiB.');
    return {size:bytes.byteLength,raw:await rawHashAsync(bytes),digest:(await hashAsync(bytes))!};
  }
  readonly staging:BinaryStaging={
    reset:async id=>{this.assertStagingSupport();const p=this.stagePath(id);await this.parents(p);await this.app.vault.adapter.writeBinary(p,new ArrayBuffer(0));},
    append:async(id,bytes)=>{this.assertStagingSupport();if(bytes.byteLength>256*1024)throw new Error('Oversized staging append.');await this.app.vault.adapter.appendBinary(this.stagePath(id),bytes);},
    read:async id=>{const p=this.stagePath(id),s=await this.app.vault.adapter.stat(p);if(!s||s.size>MAX_FILE_BYTES)throw new Error('Invalid stage.');return this.app.vault.adapter.readBinary(p);},
    readText:async id=>this.app.vault.adapter.read(this.stagePath(id)),
    size:async id=>(await this.app.vault.adapter.stat(this.stagePath(id)))?.size??null,
    inspect:async id=>this.inspectDisk(this.stagePath(id)),
    remove:async id=>{const p=this.stagePath(id);if(await this.app.vault.adapter.exists(p))await this.app.vault.adapter.remove(p);},
    install:async(path,id,expected,digest,mtime,client)=>this.installStaged(path,id,expected,digest,mtime,client),
    deleteLocal:async(path,expected,client)=>this.deleteStaged(path,expected,client)
  };
  private async preserveDisk(path:string,source:string,digest:string,client:string):Promise<string> {
    const dot=path.lastIndexOf('.'),ext=dot>path.lastIndexOf('/')?path.slice(dot):'',stem=ext?path.slice(0,-ext.length):path;
    const name=stem+'.sync-conflict-'+client.slice(0,8)+'-'+digest.slice(0,24);
    for(let i=0;i<100;i++) {
      const candidate=name+(i?'-'+i:'')+ext;
      if(await this.app.vault.adapter.exists(candidate)) {if((await this.inspectDisk(candidate)).digest===digest)return candidate;continue;}
      await this.parents(candidate);
      try {await this.app.vault.adapter.copy(source,candidate);}
      catch(error) {if(await this.app.vault.adapter.exists(candidate))continue;throw error;}
      if((await this.inspectDisk(candidate)).digest!==digest)throw new Error('Conflict copy verification failed.');return candidate;
    }
    throw new Error('Could not preserve conflict.');
  }
  private async installStaged(path:string,id:string,expected:string|null,digest:string,mtime:number,client:string) {
    if(!this.allowed(path)||markdown(path)||path.endsWith('/'))throw new Error('Unsupported staged destination.');
    const a=this.app.vault.adapter,backup=this.recoveryPath(path),conflicts:string[]=[];
    await this.parents(path);await this.parents(backup);
    // Recover the captured original before inspecting/accepting the destination.
    if(await a.exists(backup)) {
      const old=await this.inspectDisk(backup);
      if(old.digest!==expected)conflicts.push(await this.preserveDisk(path,backup,old.digest,client));
      if(!await a.exists(path))await a.copy(backup,path);
      await a.remove(backup);
    }
    const stat=await a.stat(path);
    if(stat&&stat.type!=='file')throw new Error('A folder occupies the destination.');
    if(stat&&(await this.inspectDisk(path)).digest===digest)return {matched:true,conflicts};
    if(stat) {
      await a.rename(path,backup);
      const captured=await this.inspectDisk(backup);
      if(captured.digest!==expected)conflicts.push(await this.preserveDisk(path,backup,captured.digest,client));
    }
    try {await a.copy(this.stagePath(id),path);}
    catch(error) {if(error&&typeof error==='object'&&'code' in error&&error.code==='EEXIST')return {matched:false,conflicts};throw error;}
    await a.appendBinary(path,new ArrayBuffer(0),{mtime});
    if((await this.inspectDisk(path)).digest!==digest)return {matched:false,conflicts};
    if(await a.exists(backup))await a.remove(backup);
    return {matched:true,conflicts};
  }
  private async deleteStaged(path:string,expected:string|null,client:string):Promise<string[]> {
    if(!this.allowed(path)||markdown(path)||path.endsWith('/'))throw new Error('Unsupported staged deletion.');
    const a=this.app.vault.adapter,backup=this.recoveryPath(path),conflicts:string[]=[];
    await this.parents(backup);
    // A previous replacement or deletion may have captured edits before termination.
    if(await a.exists(backup)) {
      const captured=await this.inspectDisk(backup);
      if(captured.digest!==expected)conflicts.push(await this.preserveDisk(path,backup,captured.digest,client));
      await a.trashLocal(backup);
    }
    const stat=await a.stat(path);
    // A file tombstone must not remove a replacement directory.
    if(!stat||stat.type!=='file')return conflicts;
    await a.rename(path,backup);
    const captured=await this.inspectDisk(backup);
    if(captured.digest!==expected)conflicts.push(await this.preserveDisk(path,backup,captured.digest,client));
    await a.trashLocal(backup);
    // Any new file created at the original path stays dirty for the next cycle.
    return conflicts;
  }
  async fileSize(path:string):Promise<number|null> {
    if(!this.allowed(path))throw new Error('Unsupported path.');
    const stat=await this.app.vault.adapter.stat(path);
    return stat?.type==='file'?stat.size:null;
  }
  allowed(path:string):boolean {
    const config=(this.app.vault.configDir??'.obsidian').normalize('NFC').toLowerCase().replace(/\/$/,'');
    const target=path.normalize('NFC').toLowerCase().replace(/\/$/,'');
    return syncPath(path) && target!==config && !target.startsWith(config+'/');
  }
  async scanChanges():Promise<string[]> {
    const next=new Map<string,string>();const changed:string[]=[];
    for(const path of await this.listFiles()) {
      const stat=await this.app.vault.adapter.stat(path.endsWith('/')?path.slice(0,-1):path);
      if(!stat)continue;
      const signature=path.endsWith('/')?'directory':stat.mtime+':'+stat.size;
      next.set(path,signature);
      if(this.inventory.get(path)!==signature)changed.push(path);
    }
    for(const path of this.inventory.keys())if(!next.has(path))changed.push(path);
    this.inventory=next;return changed;
  }
  private hasPendingEditorChanges(path:string,disk:string):boolean {
    for(const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view=leaf.view;
      if(view instanceof MarkdownView && view.file?.path===path && view.getMode()==='source' && view.editor.getValue()!==disk) return true;
    }
    return false;
  }
  async listFiles():Promise<string[]> {
    const result:string[]=[];
    const walk=async(path:string):Promise<void>=>{
      const listing=await this.app.vault.adapter.list(path);
      for(const file of listing.files) if(this.allowed(file)) result.push(file);
      for(const folder of listing.folders) if(this.allowed(folder)) {result.push(folder+'/');await walk(folder);}
    };
    await walk('');return result;
  }
  async modificationTime(path:string):Promise<number|undefined> {
    if(!this.allowed(path)) throw new Error('Unsupported path.');
    const stat=await this.app.vault.adapter.stat(path);
    return stat?.type==='file' ? Math.trunc(stat.mtime) : undefined;
  }
  async read(path:string):Promise<Content|null> {
    if(!this.allowed(path)) throw new Error('Unsupported path.');
    const diskPath=path.endsWith('/')?path.slice(0,-1):path;
    const stat=await this.app.vault.adapter.stat(diskPath);
    if(!stat)return null;
    // Records distinguish file and directory identities at the same OS path.
    // Replacing one type deletes the old identity; it does not delete the new one.
    if(path.endsWith('/')) return stat.type==='folder'?'directory':null;
    if(stat.type!=='file')return null;
    if(stat.size>MAX_FILE_BYTES)throw new Error('File exceeds 200 MiB.');
    if(!markdown(path))return this.app.vault.adapter.readBinary(path);
    const file=this.app.vault.getAbstractFileByPath(path);
    if(!file)return this.app.vault.adapter.read(path);
    if(file instanceof TFile) return this.app.vault.read(file);
    if(file) throw new Error('A folder occupies this note path.');
    return null;
  }
  private async parents(path:string):Promise<void> {
    const parts=path.split('/');parts.pop();let current='';
    for(const part of parts) {
      current=current?current+'/'+part:part;
      const existing=await this.app.vault.adapter.stat(current);
      if(existing && existing.type!=='folder') throw new Error('A file occupies a required folder path.');
      if(!existing) {
        try {await this.app.vault.adapter.mkdir(current);}
        catch(error) {if((await this.app.vault.adapter.stat(current))?.type!=='folder') throw error;}
      }
    }
  }
  private recoveryPath(path:string):string {return '.trash/bettersync/'+hash(path);}
  /** copy refuses an existing destination, unlike an asynchronous raw write. */
  private async createUnindexed(path:string,content:Content):Promise<void> {
    const adapter=this.app.vault.adapter;
    const nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
    const staging='.trash/bettersync/stage-'+nonce;
    await this.parents(staging);
    try {
      if(markdown(path))await adapter.write(staging,content as string);
      else await adapter.writeBinary(staging,typeof content==='string'?decodeBinary(content):content);
      await adapter.copy(staging,path);
    } finally {if(await adapter.exists(staging))await adapter.remove(staging);}
  }
  async recoverIncoming(path:string,expected:string|null,preserve:(content:Content)=>Promise<void>):Promise<void> {
    if(!this.allowed(path)) throw new Error('Unsupported path.');
    if(path.endsWith('/') || markdown(path))return;
    const adapter=this.app.vault.adapter,backup=this.recoveryPath(path);
    if(!await adapter.exists(backup))return;
    const content=await adapter.readBinary(backup);
    // A write just before the rename is now in the recovery file. Preserve it
    // before clearing that file, even if the remote version is already installed.
    if(await hashAsync(content)!==expected)await preserve(content);
    if(!await adapter.exists(path)) {
      try {await adapter.copy(backup,path);}
      catch(error) {if(!await adapter.exists(path))throw error;}
    }
    await adapter.remove(backup);
  }
  async create(path:string,content:Content,mtime?:number):Promise<void> {
    if(!this.allowed(path)) throw new Error('Unsupported path.');
    validateContent(path,content);
    const target=path.endsWith('/')?path.slice(0,-1):path;
    if(await this.app.vault.adapter.exists(target))throw new Error('Path exists.');
    await this.parents(target);
    if(path.endsWith('/')) {await this.app.vault.adapter.mkdir(target);return;}
    if(mtime!==undefined) {await this.createTimestampedFile(path,content,mtime);return;}
    if(markdown(path) && !path.split('/').some(p=>p.startsWith('.')))await this.app.vault.create(path,content as string);
    else await this.createUnindexed(path,content);
  }
  private async createTimestampedFile(path:string,content:Content,mtime:number):Promise<void> {
    // Vault creation supports write options and rejects existing destinations.
    if(markdown(path))await this.app.vault.create(path,content as string,{mtime});
    else await this.app.vault.createBinary(path,typeof content==='string'?decodeBinary(content):content,{mtime});
  }
  async compareAndSet(path:string,expected:string|null,content:Content|null,mtime?:number):Promise<boolean> {
    if(!this.allowed(path)) throw new Error('Unsupported path.');
    if(content!==null)validateContent(path,content);
    if(path.endsWith('/') || !markdown(path) || !this.app.vault.getAbstractFileByPath(path)) {
      if(await hashAsync(await this.read(path))!==expected)return false;
      const target=path.endsWith('/')?path.slice(0,-1):path;
      const stat=await this.app.vault.adapter.stat(target);
      if(stat && (stat.type==='folder')!==path.endsWith('/')) {
        // A tombstone for the previous type must leave its replacement alone.
        return content===null;
      }
      if(content===null) {
        if(!await this.app.vault.adapter.exists(target))return true;
        if(path.endsWith('/')) {const children=await this.app.vault.adapter.list(target);if(children.files.length||children.folders.length)throw new Error('Directory is not empty.');await this.app.vault.adapter.rmdir(target,false);}
        else await this.app.vault.adapter.trashLocal(target);
      } else if(expected===null)await this.create(path,content,mtime);
      else if(!path.endsWith('/')) {
        const adapter=this.app.vault.adapter;
        if(markdown(path)) {
          let matched=false;
          await adapter.process(path,current=>{
            if(hash(current)!==expected)return current;
            matched=true;return content as string;
          },mtime===undefined?undefined:{mtime});
          return matched;
        }
        const backup=this.recoveryPath(path);
        await this.parents(backup);
        if(await adapter.exists(backup))throw new Error('Binary recovery must finish before replacement.');
        await adapter.rename(path,backup);
        // The rename captures the actual bytes, including edits since the check.
        // Leave them journaled for recovery on mismatch, failure or a crash.
        if(await hashAsync(await adapter.readBinary(backup))!==expected)return false;
        try {
          if(mtime===undefined)await this.createUnindexed(path,content);
          else await this.createTimestampedFile(path,content,mtime);
        }
        catch(error) {if(await adapter.exists(path))return false;throw error;}
        await adapter.remove(backup);
      }
      return true;
    }
    const file=this.app.vault.getAbstractFileByPath(path);
    if(!file) {
      if(expected!==null) return false;
      if(content===null) return true;
      try {await this.create(path,content,mtime);return true;}
      catch(error) {if(this.app.vault.getAbstractFileByPath(path)) return false;throw error;}
    }
    if(!(file instanceof TFile)) throw new Error('A folder occupies this note path.');
    if(content===null) {
      const disk=await this.app.vault.read(file);
      if(hash(disk)!==expected || this.hasPendingEditorChanges(path,disk)) return false;
      // Obsidian has no atomic compare-and-trash API. Retain deleted notes in
      // the vault trash as a final recovery layer; never permanently delete.
      await this.app.vault.trash(file,false);return true;
    }
    let matched=false;
    await this.app.vault.process(file,current=>{
      if(hash(current)!==expected || this.hasPendingEditorChanges(path,current)) return current;
      matched=true;return content as string;
    },mtime===undefined?undefined:{mtime});
    return matched;
  }
}
