import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

async function plugin() {
  const bundle=await build({entryPoints:['src/main.ts'],bundle:true,write:false,format:'esm',platform:'browser',external:['node:fs/promises'],plugins:[{
    name:'mock-obsidian',setup(b){
      b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));
      b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`export class Plugin{};export class Notice{};export class Modal{};export class PluginSettingTab{};export class Setting{};export class FileSystemAdapter{};export class TFolder{};export class TFile{};export class MarkdownView{};export const Platform={isDesktopApp:false};export async function requestUrl(){throw new Error('Unexpected HTTP');}`}));
    }
  }]});
  const {default:Plugin}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0]!.text).toString('base64'));
  const p=new Plugin();p.app={};p.statusEl={};p.statusButton={setText(){}};p.settingsTab={showStatus(){}};
  p.saveData=async()=>{};
  return p;
}

test('startup stops before registering setup or writing when configuration needs recovery',async()=>{
  const dir='test-profile/plugins/bettersync';
  const cases=[
    {file:'sync-state.json',raw:null},
    {file:'sync-state.backup.json',raw:null},
    {file:'data.json',raw:null},
    {raw:{}},
    {raw:{settings:{url:'',database:'',username:'',password:'',enabled:'false'}}},
    {raw:{settings:{url:'',database:'',username:'',password:'',enabled:false},stateReference:{binding:'test'}}},
    {raw:null,probeFails:true},
    {raw:null,loadFails:true},
  ];
  const p=await plugin();
  p.manifest={id:'bettersync',dir};
  p.addStatusBarItem=()=>assert.fail('Startup must not register normal setup UI');
  p.saveData=async()=>assert.fail('Startup must not overwrite configuration');
  for(const {file,raw,probeFails,loadFails} of cases) {
    p.app.vault={adapter:{exists:async(path:string)=>{
      if(probeFails)throw new Error('I/O error');
      return path===dir+'/'+file;
    }}};
    p.loadData=async()=>{
      if(loadFails)throw new SyntaxError('Invalid JSON');
      return raw;
    };
    p.status='Synced';
    await p.onload();
    assert.equal(p.status,'Sync error');
  }
});

test('startup accepts a fresh installation and valid saved configuration',async()=>{
  const p=await plugin();
  p.manifest={id:'bettersync'};
  p.app.vault={configDir:'custom-profile',adapter:{exists:async(path:string)=>{
    assert.ok(path.startsWith('custom-profile/plugins/bettersync/'));return false;
  }}};
  const uiReached=new Error('normal startup reached');
  p.addStatusBarItem=()=>{throw uiReached;};
  for(const raw of [null,{settings:{...p.settings,url:'https://test.invalid'}}]) {
    p.loadData=async()=>raw;
    await assert.rejects(p.onload(),error=>error===uiReached);
  }
  assert.equal(p.settings.url,'https://test.invalid');
});
test('disabling sync stops the engine without accessing an unavailable secret store',async()=>{
  const p=await plugin();let stopped=0;
  p.settings={url:'https://test.invalid',database:'test',username:'test',password:'',passwordSecret:'bettersync-'+'a'.repeat(32),enabled:true};
  p.engine={stop:async()=>{stopped++;}};
  await p.configure({enabled:false});
  assert.equal(stopped,1);assert.equal(p.settings.enabled,false);assert.equal(p.engine,undefined);
});
test('failed credential-reference persistence restores the previously committed settings',async()=>{
  const p=await plugin();const values=new Map<string,string>();
  p.app.secretStorage={setSecret:(k:string,v:string)=>values.set(k,v),getSecret:(k:string)=>values.get(k)??null};
  p.settings={url:'https://test.invalid',database:'test',username:'test',password:'old synthetic',enabled:false};
  p.saveData=async()=>{throw new Error('disk full');};
  await p.configure({password:'new synthetic'});
  assert.equal(p.settings.password,'old synthetic');assert.equal(p.settings.passwordSecret,undefined);
});
test('successful migration persists a reference and omits plaintext while retaining runtime credentials',async()=>{
  const p=await plugin();const values=new Map<string,string>();let saved:any;
  p.app.secretStorage={setSecret:(k:string,v:string)=>values.set(k,v),getSecret:(k:string)=>values.get(k)??null};
  p.settings={url:'https://test.invalid',database:'test',username:'test',password:'synthetic credential',enabled:false};
  p.saveData=async(value:unknown)=>{saved=value;};await p.configure({});
  assert.equal(saved.settings.password,'');assert.equal(values.get(saved.settings.passwordSecret),'synthetic credential');
  assert.equal(p.settings.password,'synthetic credential');
});

test('legacy state must verify before saving configuration, and migration is repeatable',async()=>{
  const p=await plugin();
  const state={version:1,clientId:'test-client',binding:'test-target',initialized:true,lastSequence:14,files:{},incoming:{}};
  const files=new Map<string,string>();
  const dir='test-profile/plugins/bettersync';
  const primary=dir+'/sync-state.json';
  p.manifest={id:'bettersync',dir};
  let unreadable=true,configFailure=true;
  p.app.vault={adapter:{
    exists:async(path:string)=>files.has(path),
    read:async(path:string)=>unreadable?'':files.get(path),
    write:async(path:string,value:string)=>{files.set(path,value);}
  }};
  p.settings={...p.settings,url:'https://test.invalid',enabled:false};
  p.legacyState=state;
  let attempts=0,saved:any={settings:p.settings,state};
  p.saveData=async(value:unknown)=>{
    attempts++;assert.equal(JSON.parse(files.get(primary)!).state.lastSequence,14);
    if(configFailure)throw new Error('configuration commit failed');
    saved=value;
  };
  await p.configure({});
  assert.equal(attempts,0);assert.equal(saved.state,state);
  unreadable=false;
  await p.configure({});
  assert.equal(attempts,1);assert.equal(saved.state,state);
  configFailure=false;
  await p.configure({});
  assert.equal(attempts,2);assert.equal(saved.state,undefined);assert.equal(p.legacyState,undefined);
  assert.deepEqual(saved.stateReference,{binding:state.binding,clientId:state.clientId});
  await p.configure({});
  await p.progressFiles().save({...state,lastSequence:15});
  assert.equal(attempts,2);assert.equal(saved.settings.url,'https://test.invalid');
});
