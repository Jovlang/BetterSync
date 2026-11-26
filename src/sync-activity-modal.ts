import {Modal, Setting, type App} from 'obsidian';
import {activityLabel, type SyncActivity} from './sync-activity';

export class SyncActivityModal extends Modal {
  private timer?:number;
  constructor(app:App,private activity:SyncActivity,private status:()=>string,private retry:()=>Promise<void>) {super(app);}
  onOpen() {
    this.titleEl.setText('Sync activity');
    const status=this.contentEl.createEl('p');
    new Setting(this.contentEl).addButton(button=>button.setButtonText('Retry').onClick(async()=>{
      button.setDisabled(true);
      try {await this.retry();} finally {button.setDisabled(false);}
    }));
    const list=(heading:string)=>{
      this.contentEl.createEl('h3',{text:heading});
      return this.contentEl.createEl('ul');
    };
    const active=list('Syncing now'),failed=list('Unresolved failures'),recent=list('Recent activity');
    this.contentEl.createEl('p',{text:'Activity stays on this device and is cleared when BetterSync reloads.'});
    let revision=-1;
    const render=()=>{
      const current=this.status();
      if(status.textContent!==current)status.setText(current);
      if(revision===this.activity.revision)return;
      revision=this.activity.revision;
      for(const section of [active,failed,recent])section.empty();
      for(const item of this.activity.active) {
        active.createEl('li',{text:activityLabel(item)+(item.percent===undefined||item.applying?'':` — ${item.percent}% transferred`)});
      }
      for(const item of this.activity.failures.values())failed.createEl('li',{text:`${item.label} — ${item.failure}`});
      for(const item of this.activity.recent) {
        recent.createEl('li',{text:`${new Date(item.at).toLocaleString()} — ${item.label} — ${item.failure??'Completed'}`});
      }
      if(!active.childElementCount)active.createEl('li',{text:'No file transfer in progress.'});
      if(!failed.childElementCount)failed.createEl('li',{text:'No unresolved failures.'});
      if(!recent.childElementCount)recent.createEl('li',{text:'No recent activity.'});
    };
    render();this.timer=window.setInterval(render,250);
  }
  onClose() {
    if(this.timer!==undefined)window.clearInterval(this.timer);
    this.contentEl.empty();
  }
}
