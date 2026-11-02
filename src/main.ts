import {Notice, Plugin, requestUrl, TFolder} from 'obsidian';
import {CouchClient} from './couch-client';
import {withTimeout} from './http';
import {freshState, StateStore} from './local-state';
import {hash} from './paths';
import {defaults, BetterSyncSettings, confirmSetup, type Settings} from './settings';
import {SyncEngine} from './sync-engine';
import {ObsidianVault} from './vault-client';
import type {LocalSyncState, SyncStatus} from './types';
interface Saved {settings:Settings; state?:LocalSyncState}
export default class BetterSync extends Plugin {
  settings:Settings={...defaults};
  status:SyncStatus='Synced';
  private state?:LocalSyncState;
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
  private persist():Promise<void> {
    const snapshot=JSON.parse(JSON.stringify({settings:this.settings,state:this.state})) as Saved;
    const next=this.writes.then(()=>this.saveData(snapshot));this.writes=next.catch(()=>{});return next;
  }
  private client():CouchClient {
    return new CouchClient(this.settings,withTimeout(async(url,method,headers,body,responseType)=>{
      const response=await requestUrl({url,method,headers,body,throw:false});
      if(responseType==='binary')return {status:response.status,arrayBuffer:response.arrayBuffer};
      let json:unknown;try{json=response.json;}catch{json=null;}
      return {status:response.status,json};
    }));
  }
  configure(patch:Partial<Settings>):Promise<void> {
    const operation=this.config.then(async()=>{
      if(this.unloaded) return;
      const settings={...this.settings,...patch};
      // A client baseline must never be reused against a different database.
      const binding=hash(settings.url.replace(/\/$/,'')+'\n'+settings.database)!;
      if(this.state && this.state.binding!==binding && (this.state.initialized || this.state.setup)) {
        new Notice('This installation is already connected to another sync database. Keep the same server and database for this vault.');return;
      }
      if(this.timer!==undefined) {window.clearInterval(this.timer);this.timer=undefined;}
      await this.engine?.stop();this.engine=undefined;this.settings={...settings};
      await this.persist();
      if(!settings.enabled) {this.setStatus('Synced');return;}
      try {
        const remote=this.client();
        const state=this.state?.binding===binding?this.state:freshState(binding);this.state=state;
        await this.persist();
        const store=new StateStore(state,async snapshot=>{this.state=snapshot;await this.persist();});
        this.engine=new SyncEngine(new ObsidianVault(this.app),remote,store,{
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
  async retry():Promise<void> {if(this.settings.enabled) await this.engine?.retry();}
  onunload():void {
    this.unloaded=true;if(this.timer!==undefined) window.clearInterval(this.timer);void this.engine?.stop();
  }
}
