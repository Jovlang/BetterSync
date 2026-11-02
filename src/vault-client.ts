import {TFile, TFolder, MarkdownView, type App} from 'obsidian';
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
  private editingBuffer(path:string):string|undefined {
    for(const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view=leaf.view;
      if(view instanceof MarkdownView && view.file?.path===path && view.getMode()==='source') return view.editor.getValue();
    }
    return undefined;
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
    if(path.endsWith('/')) {if(stat.type!=='folder')throw new Error('File occupies directory path.');return 'directory';}
    if(stat.type!=='file')throw new Error('Folder occupies file path.');
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
  async create(path:string,content:string):Promise<void> {
    if(!syncPath(path)) throw new Error('Unsupported path.');
    validateContent(path,content);
    const target=path.endsWith('/')?path.slice(0,-1):path;
    if(await this.app.vault.adapter.exists(target))throw new Error('Path exists.');
    await this.parents(target);
    if(path.endsWith('/')) {await this.app.vault.adapter.mkdir(target);return;}
    if(markdown(path) && !path.split('/').some(p=>p.startsWith('.')))await this.app.vault.create(path,content);
    else if(markdown(path))await this.app.vault.adapter.write(path,content);
    else await this.app.vault.adapter.writeBinary(path,decodeBinary(content));
  }
  async compareAndSet(path:string,expected:string|null,content:string|null):Promise<boolean> {
    if(!syncPath(path)) throw new Error('Unsupported path.');
    if(content!==null)validateContent(path,content);
    if(path.endsWith('/') || !markdown(path) || !this.app.vault.getAbstractFileByPath(path)) {
      if(hash(await this.read(path))!==expected)return false;
      const target=path.endsWith('/')?path.slice(0,-1):path;
      if(content===null) {
        if(!await this.app.vault.adapter.exists(target))return true;
        if(path.endsWith('/')) {const children=await this.app.vault.adapter.list(target);if(children.files.length||children.folders.length)throw new Error('Directory is not empty.');await this.app.vault.adapter.rmdir(target,false);}
        else await this.app.vault.adapter.trashLocal(target);
      } else if(expected===null)await this.create(path,content);
      else if(!path.endsWith('/')) {
        if(markdown(path))await this.app.vault.adapter.write(path,content);
        else await this.app.vault.adapter.writeBinary(path,decodeBinary(content));
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
      if(hash(disk)!==expected || (this.editingBuffer(path)??disk)!==disk) return false;
      // Obsidian has no atomic compare-and-trash API. Retain deleted notes in
      // the vault trash as a final recovery layer; never permanently delete.
      await this.app.vault.trash(file,false);return true;
    }
    let matched=false;
    await this.app.vault.process(file,current=>{
      if(hash(current)!==expected || (this.editingBuffer(path)??current)!==current) return current;
      matched=true;return content;
    });
    return matched;
  }
}
