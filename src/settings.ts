import {Modal, PluginSettingTab, Setting, type App} from 'obsidian';
import type BetterSync from './main';
import type {Connection} from './couch-client';
import type {SetupChoice, SyncStatus} from './types';
export interface Settings extends Connection { enabled:boolean; passwordSecret?:string }
export const defaults:Settings={url:'',database:'',username:'',password:'',enabled:false};
export function encryptionCode(app:App, generated?:string):Promise<string|null> {
  return new Promise(resolve=>{
    class CodeModal extends Modal {
      private result:string|null=null;
      onOpen() {
        this.contentEl.createEl('h2',{text:generated?'Save your recovery code':'Enter your recovery code'});
        this.contentEl.createEl('p',{text:generated?'Keep this code outside your vault. It is required on other devices and cannot be reset by the server. This is a draft test protocol; use disposable vaults only.':'Enter the recovery code for this encrypted vault.'});
        let value=generated??'',confirmed=false;
        new Setting(this.contentEl).addTextArea(t=>{
          t.setValue(value).onChange(v=>{value=v;});t.inputEl.readOnly=!!generated;t.inputEl.spellcheck=false;
          t.inputEl.autocomplete='off';t.inputEl.rows=4;
        });
        if(generated)new Setting(this.contentEl).setName('I saved this code outside the vault').addToggle(t=>t.onChange(v=>{confirmed=v;}));
        new Setting(this.contentEl).addButton(b=>b.setButtonText('Cancel').onClick(()=>this.close()))
          .addButton(b=>b.setButtonText('Continue').setCta().onClick(()=>{
            if(!value.trim() || (generated&&!confirmed))return;
            this.result=value.trim();this.close();
          }));
      }
      onClose(){this.contentEl.empty();resolve(this.result);this.result=null;}
    }
    new CodeModal(app).open();
  });
}
export function confirmSetup(app:App,direction:'upload'|'download'):Promise<SetupChoice> {
  return new Promise(resolve=>{
    class Confirm extends Modal {
      private choice:SetupChoice='cancel';
      onOpen():void {
        this.contentEl.createEl('h2',{text:direction==='upload'?'Upload this vault?':'Download this vault?'});
        this.contentEl.createEl('p',{text:direction==='upload'?'This sync database is empty. Upload this vault?':'Download the files and directories from this sync database?'});
        new Setting(this.contentEl)
          .addButton(b=>b.setButtonText('Cancel').onClick(()=>this.close()))
          .addButton(b=>b.setButtonText(direction==='upload'?'Upload':'Download').setCta().onClick(()=>{this.choice=direction;this.close();}));
      }
      onClose():void {this.contentEl.empty();resolve(this.choice);}
    }
    new Confirm(app).open();
  });
}
export class BetterSyncSettings extends PluginSettingTab {
  private statusEl?:HTMLElement;
  constructor(app:App,private plugin:BetterSync) {super(app,plugin);}
  showStatus(status:SyncStatus):void {this.statusEl?.setText(status);}
  display():void {
    const {containerEl}=this;containerEl.empty();
    containerEl.createEl('h2',{text:'BetterSync'});
    const fields:[keyof Connection,string,string][]=[['url','Server','https://sync.example.com'],['database','Database','my-vault'],['username','Username',''],['password','Password','']];
    for(const [key,label,placeholder] of fields) {
      new Setting(containerEl).setName(label).addText(text=>{
        text.setPlaceholder(placeholder).setValue(this.plugin.settings[key]);
        if(key==='password') text.inputEl.type='password';
        text.inputEl.autocomplete='off';text.inputEl.spellcheck=false;
        // Persist on blur, not on every keystroke; never reconfigure in flight.
        text.inputEl.addEventListener('change',()=>void this.plugin.configure({[key]:text.getValue()}).then(()=>this.display()));
      });
    }
    new Setting(containerEl).addButton(button=>button.setButtonText('Test connection').onClick(async()=>{
      button.setDisabled(true);try{await this.plugin.testConnection();}finally{button.setDisabled(false);}
    }));
    new Setting(containerEl).setName('Sync').addToggle(toggle=>toggle.setValue(this.plugin.settings.enabled).onChange(async enabled=>{
      await this.plugin.configure({enabled});this.display();
    }));
    new Setting(containerEl).setName('Encryption').setDesc('Set up a fresh encrypted test vault or restore its recovery code.')
      .addButton(b=>b.setButtonText('Set up encryption').onClick(async()=>{b.setDisabled(true);try{await this.plugin.setupEncryption();}finally{b.setDisabled(false);this.display();}}));
    new Setting(containerEl).addButton(b=>b.setButtonText('Show recovery code').onClick(()=>void this.plugin.showRecoveryCode()));
    this.statusEl=new Setting(containerEl).setName('Status').descEl;this.showStatus(this.plugin.status);
    new Setting(containerEl).addButton(button=>button.setButtonText('Retry').onClick(()=>void this.plugin.retry()));
  }
}
