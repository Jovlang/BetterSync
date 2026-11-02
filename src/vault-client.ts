import {TFile, MarkdownView, type App} from 'obsidian';
import {hash, markdown, syncPath, MAX_FILE_BYTES, encodeBinary, decodeBinary, validateContent} from './paths';
import type {VaultClient} from './types';
export class ObsidianVault implements VaultClient {
  private inventory=new Map<string,string>();
  constructor(private app:App) {}
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
      for(const file of listing.files) if(syncPath(file)) result.push(file);
      for(const folder of listing.folders) if(syncPath(folder)) {result.push(folder+'/');await walk(folder);}
    };
    await walk('');return result;
  }
  async read(path:string):Promise<string|null> {
    if(!syncPath(path)) throw new Error('Unsupported path.');
    const diskPath=path.endsWith('/')?path.slice(0,-1):path;
    const stat=await this.app.vault.adapter.stat(diskPath);
    if(!stat)return null;
    // Records distinguish file and directory identities at the same OS path.
    // Replacing one type deletes the old identity; it does not delete the new one.
    if(path.endsWith('/')) return stat.type==='folder'?'directory':null;
    if(stat.type!=='file')return null;
    if(stat.size>MAX_FILE_BYTES)throw new Error('File exceeds 200 MiB.');
    if(!markdown(path))return encodeBinary(await this.app.vault.adapter.readBinary(path));
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
  private async createUnindexed(path:string,content:string):Promise<void> {
    const adapter=this.app.vault.adapter;
    const nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
    const staging='.trash/bettersync/stage-'+nonce;
    await this.parents(staging);
    try {
      if(markdown(path))await adapter.write(staging,content);
      else await adapter.writeBinary(staging,decodeBinary(content));
      await adapter.copy(staging,path);
    } finally {if(await adapter.exists(staging))await adapter.remove(staging);}
  }
  async recoverIncoming(path:string,expected:string|null,preserve:(content:string)=>Promise<void>):Promise<void> {
    if(path.endsWith('/') || markdown(path))return;
    const adapter=this.app.vault.adapter,backup=this.recoveryPath(path);
    if(!await adapter.exists(backup))return;
    const content=encodeBinary(await adapter.readBinary(backup));
    // A write just before the rename is now in the recovery file. Preserve it
    // before clearing that file, even if the remote version is already installed.
    if(hash(content)!==expected)await preserve(content);
    if(!await adapter.exists(path)) {
      try {await adapter.copy(backup,path);}
      catch(error) {if(!await adapter.exists(path))throw error;}
    }
    await adapter.remove(backup);
  }
  async create(path:string,content:string):Promise<void> {
    if(!syncPath(path)) throw new Error('Unsupported path.');
    validateContent(path,content);
    const target=path.endsWith('/')?path.slice(0,-1):path;
    if(await this.app.vault.adapter.exists(target))throw new Error('Path exists.');
    await this.parents(target);
    if(path.endsWith('/')) {await this.app.vault.adapter.mkdir(target);return;}
    if(markdown(path) && !path.split('/').some(p=>p.startsWith('.')))await this.app.vault.create(path,content);
    else await this.createUnindexed(path,content);
  }
  async compareAndSet(path:string,expected:string|null,content:string|null):Promise<boolean> {
    if(!syncPath(path)) throw new Error('Unsupported path.');
    if(content!==null)validateContent(path,content);
    if(path.endsWith('/') || !markdown(path) || !this.app.vault.getAbstractFileByPath(path)) {
      if(hash(await this.read(path))!==expected)return false;
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
      } else if(expected===null)await this.create(path,content);
      else if(!path.endsWith('/')) {
        const adapter=this.app.vault.adapter;
        if(markdown(path)) {
          let matched=false;
          await adapter.process(path,current=>{
            if(hash(current)!==expected)return current;
            matched=true;return content;
          });
          return matched;
        }
        const backup=this.recoveryPath(path);
        await this.parents(backup);
        if(await adapter.exists(backup))throw new Error('Binary recovery must finish before replacement.');
        await adapter.rename(path,backup);
        // The rename captures the actual bytes, including edits since the check.
        // Leave them journaled for recovery on mismatch, failure or a crash.
        if(hash(encodeBinary(await adapter.readBinary(backup)))!==expected)return false;
        try {await this.createUnindexed(path,content);}
        catch(error) {if(await adapter.exists(path))return false;throw error;}
        await adapter.remove(backup);
      }
      return true;
    }
    const file=this.app.vault.getAbstractFileByPath(path);
    if(!file) {
      if(expected!==null) return false;
      if(content===null) return true;
      try {await this.create(path,content);return true;}
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
      matched=true;return content;
    });
    return matched;
  }
}
