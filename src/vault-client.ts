import {TFile, TFolder, MarkdownView, type App} from 'obsidian';
import {hash, markdown} from './paths';
import type {VaultClient} from './types';
export class ObsidianVault implements VaultClient {
  constructor(private app:App) {}
  private hasPendingEditorChanges(path:string,disk:string):boolean {
    for(const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view=leaf.view;
      if(view instanceof MarkdownView && view.file?.path===path && view.getMode()==='source' && view.editor.getValue()!==disk) return true;
    }
    return false;
  }
  listMarkdownFiles():string[] {return this.app.vault.getMarkdownFiles().map(f=>f.path).filter(markdown);}
  async read(path:string):Promise<string|null> {
    const file=this.app.vault.getAbstractFileByPath(path);
    if(file instanceof TFile) return this.app.vault.read(file);
    if(file) throw new Error('A folder occupies this note path.');
    return null;
  }
  private async parents(path:string):Promise<void> {
    const parts=path.split('/');parts.pop();let current='';
    for(const part of parts) {
      current=current?current+'/'+part:part;
      const existing=this.app.vault.getAbstractFileByPath(current);
      if(existing && !(existing instanceof TFolder)) throw new Error('A note occupies a required folder path.');
      if(!existing) {
        try {await this.app.vault.createFolder(current);}
        catch(error) {if(!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;}
      }
    }
  }
  async create(path:string,content:string):Promise<void> {
    if(!markdown(path)) throw new Error('Unsupported note path.');
    await this.parents(path);await this.app.vault.create(path,content);
  }
  async compareAndSet(path:string,expected:string|null,content:string|null):Promise<boolean> {
    if(!markdown(path)) throw new Error('Unsupported note path.');
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
