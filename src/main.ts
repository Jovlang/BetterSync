import {Notice, Modal, Plugin, requestUrl, TFolder} from 'obsidian';
import {CouchClient} from './couch-client';
import {withTimeout} from './http';
import {freshState, StateStore} from './local-state';
import {hash} from './paths';
import {defaults, BetterSyncSettings, confirmSetup, encryptionCode, type Settings} from './settings';
import {SyncEngine} from './sync-engine';
import {ObsidianVault} from './vault-client';
import type {LocalSyncState, SyncStatus} from './types';
import {PersistentSetupStorage} from './setup-storage';
import {EncryptionSetup,generateRecoveryCode,type SetupIntent} from './encryption-setup';
import {ObsidianSecrets} from './obsidian-secrets';
import {CouchConfiguration} from './couch-configuration';
import {EncryptedRemote} from './encrypted-remote';
import {storeCredential} from './credential-storage';
interface Saved {settings:Settings; state?:LocalSyncState; encryptionSetup?:SetupIntent}
export default class BetterSync extends Plugin {
  settings:Settings={...defaults};
  status:SyncStatus='Synced';
  private state?:LocalSyncState;
  private encryptionSetup?:SetupIntent;
  private setupStorage!:PersistentSetupStorage;
  private engine?:SyncEngine;
  private settingsTab!:BetterSyncSettings;
  private statusEl!:HTMLElement;
  private timer?:number;
  private writes:Promise<void>=Promise.resolve();
  private config:Promise<void>=Promise.resolve();
  private unloaded=false;
  async onload():Promise<void> {
    const saved=await this.loadData() as Saved|null;
    this.settings={...defaults,...saved?.settings};this.state=saved?.state;
    this.encryptionSetup=saved?.encryptionSetup;
    this.setupStorage=new PersistentSetupStorage(this.encryptionSetup??null,intent=>this.persist(intent));
    this.statusEl=this.addStatusBarItem();this.settingsTab=new BetterSyncSettings(this.app,this);this.addSettingTab(this.settingsTab);
    this.addCommand({id:'retry-sync',name:'Retry sync',callback:()=>void this.retry()});
    const change=(path:string)=>{void this.engine?.changed(path).catch(()=>this.setStatus('Sync error'));};
    const entry=(file:{path:string})=>file.path+(file instanceof TFolder?'/':'');
    this.registerEvent(this.app.vault.on('create',file=>change(entry(file))));
    this.registerEvent(this.app.vault.on('modify',file=>change(file.path)));
    this.registerEvent(this.app.vault.on('delete',file=>{
      change(entry(file));
      for(const path of Object.keys(this.state?.files??{})) if(path.startsWith(file.path+'/')) change(path);
    }));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{
      change(oldPath+(file instanceof TFolder?'/':''));change(entry(file));
      // A folder rename changes the paths of its descendant notes without
      // necessarily emitting one event for each child on every platform.
      for(const path of Object.keys(this.state?.files??{})) if(path.startsWith(oldPath+'/')) change(path);
      for(const note of this.app.vault.getAllLoadedFiles()) if(note.path.startsWith(file.path+'/')) change(entry(note));
    }));
    this.registerDomEvent(document,'visibilitychange',()=>{if(!document.hidden) void this.retry();});
    this.registerDomEvent(window,'online',()=>void this.retry());
    this.app.workspace.onLayoutReady(()=>{if(!this.unloaded) void this.configure(this.settings);});
  }
  private setStatus(status:SyncStatus):void {
    this.status=status;this.statusEl.setText(this.settings.enabled?`BetterSync: ${status}`:'');this.settingsTab.showStatus(status);
  }
  private persist(setup?:SetupIntent):Promise<void> {
    const snapshot=JSON.parse(JSON.stringify({settings:this.settings,state:this.state})) as Saved;
    // Passwords are runtime-only once a verified secret reference exists.
    if(snapshot.settings.passwordSecret)snapshot.settings.password='';
    const setupSnapshot=setup?structuredClone(setup):undefined;
    const next=this.writes.then(async()=>{
      // Resolve setup at execution time: a settings save queued before a setup
      // commit must not subsequently erase the newly committed intent.
      const intent=setupSnapshot??this.encryptionSetup;
      if(intent) snapshot.encryptionSetup=structuredClone(intent);
      await this.saveData(snapshot);
      if(setupSnapshot) this.encryptionSetup=setupSnapshot;
    });this.writes=next.catch(()=>{});return next;
  }
  async showRecoveryCode():Promise<void> {
    await this.config;
    try {
      if(!this.encryptionSetup)throw new Error();
      const code=await new ObsidianSecrets(this.app).get(this.encryptionSetup.secretName);
      if(!code)throw new Error();
      const modal=new Modal(this.app);
      modal.onOpen=()=>{
        modal.contentEl.createEl('h2',{text:'Recovery code'});
        modal.contentEl.createEl('p',{text:'Keep this code private. Anyone with it and database access can read your synced files.'});
        const field=modal.contentEl.createEl('textarea');field.value=code;field.readOnly=true;field.spellcheck=false;field.rows=4;
      };
      modal.onClose=()=>modal.contentEl.empty();modal.open();
    }catch{new Notice('The recovery code is unavailable. Restore it from your saved copy.');}
  }
  private client():CouchClient {
    return new CouchClient(this.settings,this.http());
  }
  private http() {
    return withTimeout(async(url,method,headers,body,responseType)=>{
      const response=await requestUrl({url,method,headers,body,throw:false});
      if(responseType==='binary')return {status:response.status,arrayBuffer:response.arrayBuffer};
      let json:unknown;try{json=response.json;}catch{json=null;}
      return {status:response.status,json};
    });
  }
  async setupEncryption():Promise<void> {
    const operation=this.config.then(async()=>{
      if(this.unloaded)return;
      if(!this.encryptionSetup && this.state && (this.state.initialized||this.state.setup)) {
        new Notice('Use a fresh local vault and empty database to move from plaintext sync to encryption.');return;
      }
      if(this.timer!==undefined){window.clearInterval(this.timer);this.timer=undefined;}
      await this.engine?.stop();this.engine=undefined;
      try {
        const secrets=new ObsidianSecrets(this.app),remote=new CouchConfiguration(this.settings,this.http());
        const binding=hash(this.settings.url.replace(/\/$/,'')+'\n'+this.settings.database)!;
        const setup=new EncryptionSetup(binding,this.setupStorage,secrets,remote);
        const existing=await remote.getConfiguration();
        const joining=!!existing||!!this.encryptionSetup;
        if(!joining)await remote.assertEmpty();
        const code=await encryptionCode(this.app,joining?undefined:generateRecoveryCode());
        if(!code||this.unloaded)return;
        if(joining)await setup.join(code);else await setup.createConfirmed(code);
        new Notice('Encryption setup saved. Enable Sync to transfer files.');
      }catch{this.setStatus('Sync error');new Notice('Could not complete encryption setup. Check the connection and recovery code, then retry.');}
    });
    this.config=operation.catch(()=>this.setStatus('Sync error'));
    await this.config;
    if(this.settings.enabled&&!this.unloaded)await this.configure({});
  }
  configure(patch:Partial<Settings>):Promise<void> {
    const operation=this.config.then(async()=>{
      if(this.unloaded) return;
      const settings={...this.settings,...patch};
      // Disable must always stop network activity, even if the secret store is
      // unavailable. Never require a key read to honor the user's stop request.
      if(!settings.enabled) {
        if(this.timer!==undefined){window.clearInterval(this.timer);this.timer=undefined;}
        await this.engine?.stop();this.engine=undefined;
      }
      try {
        const needsSecret=settings.enabled || Object.hasOwn(patch,'password') || (!settings.passwordSecret&&!!settings.password);
        const secrets=needsSecret?new ObsidianSecrets(this.app):undefined;
        if((Object.hasOwn(patch,'password') && patch.password!==this.settings.password) || (!settings.passwordSecret && !!settings.password)) {
          settings.passwordSecret=await storeCredential(secrets!,settings.password);
        } else if(settings.passwordSecret&&secrets) {
          const password=await secrets.get(settings.passwordSecret);
          if(password===null)throw new Error();
          settings.password=password;
        }
      }catch{this.setStatus('Sync error');new Notice('Could not access the database password. Check Obsidian secret storage or enter the password again.');return;}
      // A client baseline must never be reused against a different database.
      const binding=hash(settings.url.replace(/\/$/,'')+'\n'+settings.database)!;
      if(this.encryptionSetup && this.encryptionSetup.binding!==binding) {
        new Notice('Encryption setup belongs to another database. Keep the same server and database for this vault.');return;
      }
      if(!this.encryptionSetup && this.state && this.state.binding!==binding && (this.state.initialized || this.state.setup)) {
        new Notice('This installation is already connected to another sync database. Keep the same server and database for this vault.');return;
      }
      if(this.timer!==undefined) {window.clearInterval(this.timer);this.timer=undefined;}
      await this.engine?.stop();this.engine=undefined;
      const previousSettings=this.settings;this.settings={...settings};
      try {await this.persist();} catch(error) {this.settings=previousSettings;throw error;}
      if(!settings.enabled) {this.setStatus('Synced');return;}
      // Encrypted setup is mandatory; there is no plaintext fallback.
      if(!this.encryptionSetup) {
        this.setStatus('Sync error');new Notice('Set up encryption before enabling Sync. Existing plaintext vaults require a fresh vault and database.');return;
      }
      try {
        const setup=new EncryptionSetup(binding,this.setupStorage,new ObsidianSecrets(this.app),new CouchConfiguration(this.settings,this.http()));
        const crypto=await setup.resume();
        if(this.unloaded)return;
        const vault=new ObsidianVault(this.app);
        const remote=await EncryptedRemote.connect(this.settings,this.http(),crypto,p=>vault.allowed(p));
        if(this.unloaded)return;
        if(this.state&&this.state.binding!==remote.stateBinding)throw new Error('Existing sync progress cannot be reused with this encrypted vault.');
        const state=this.state??freshState(remote.stateBinding);this.state=state;
        await this.persist();
        const store=new StateStore(state,async snapshot=>{this.state=snapshot;await this.persist();});
        this.engine=new SyncEngine(vault,remote,store,{
          status:s=>this.setStatus(s),notice:m=>{new Notice(m,8000);},
          confirm:direction=>confirmSetup(this.app,direction),
          log:(event,path)=>console.debug('[BetterSync]',event,path??'')
        });
        await this.engine.start();
        if(!this.unloaded) this.timer=window.setInterval(()=>void this.engine?.tick(),3000);
      }catch(error){this.setStatus('Sync error');new Notice(error instanceof Error?error.message:'Could not start sync.');}
    });
    this.config=operation.catch(()=>{this.setStatus('Sync error');});return this.config;
  }
  async testConnection():Promise<void> {
    await this.config;
    try {await this.client().testConnection();new Notice('Connected to the sync server.');}
    catch(error){new Notice(error instanceof Error?error.message:'Could not connect to the sync server.');}
  }
  async retry():Promise<void> {if(this.settings.enabled) {if(this.engine)await this.engine.retry();else await this.configure({});}}
  onunload():void {
    this.unloaded=true;if(this.timer!==undefined) window.clearInterval(this.timer);void this.engine?.stop();
  }
}
