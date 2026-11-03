import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

async function plugin() {
  const bundle=await build({entryPoints:['src/main.ts'],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{
    name:'mock-obsidian',setup(b){
      b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));
      b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`export class Plugin{};export class Notice{};export class Modal{};export class PluginSettingTab{};export class Setting{};export class TFolder{};export class TFile{};export class MarkdownView{};export async function requestUrl(){throw new Error('Unexpected HTTP');}`}));
    }
  }]});
  const {default:Plugin}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0]!.text).toString('base64'));
  const p=new Plugin();p.app={};p.statusEl={setText(){}};p.settingsTab={showStatus(){}};
  p.saveData=async()=>{};
  return p;
}
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
