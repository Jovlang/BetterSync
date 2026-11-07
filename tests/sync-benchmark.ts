/** Real CouchDB HTTP + simulated vaults. Never a real-device benchmark. */
import {randomUUID} from 'node:crypto';
import {CouchClient,type Http} from '../src/couch-client';
import {CouchConfiguration} from '../src/legacy/couch-configuration';
import {createConfiguration,generateRecoveryCode,importRecoveryCode} from '../src/legacy/encryption-setup';
import {EncryptedRemote} from '../src/legacy/encrypted-remote';
import {Device} from './helpers';
import {smallNotes} from './benchmark-fixtures';
import {syncPath} from '../src/paths';

const endpoint=new URL(process.env.BETTERSYNC_TEST_SERVER??'http://invalid');
if(!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.pathname!=='/'||endpoint.search||endpoint.username||endpoint.password)
  throw new Error('Set BETTERSYNC_TEST_SERVER to an isolated loopback CouchDB server root.');
const count=Number(process.argv[2]??20),rtt=Number(process.argv[3]??0),runs=Number(process.argv[4]??10);
if(![20,100,1000,10000].includes(count)||![0,50,150].includes(rtt)||!Number.isInteger(runs)||runs<1||runs>30)
  throw new Error('Arguments: notes (20/100/1000/10000), added RTT (0/50/150), runs (1–30).');
const credentials={username:'bettersync-test',password:'local-ci-only'};
const auth='Basic '+Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
const admin=async(database:string,method:string)=>{
  const response=await fetch(new URL(database,endpoint),{method,headers:{Authorization:auth}});
  if(!response.ok)throw new Error('Could not create/remove isolated benchmark database.');
};
const results:unknown[]=[];
for(let run=0;run<runs;run++)for(const encrypted of run%2?[true,false]:[false,true]) {
  const database='bettersync-benchmark-'+randomUUID();await admin(database,'PUT');
  let requests=0;
  const http:Http=async(url,method,headers,body,responseType)=>{
    requests++;
    if(rtt)await new Promise(resolve=>setTimeout(resolve,rtt));
    const target=new URL(url);target.protocol=endpoint.protocol;target.host=endpoint.host;
    const response=await fetch(target,{method,headers,body});
    return responseType==='binary'?{status:response.status,arrayBuffer:await response.arrayBuffer()}:{status:response.status,json:await response.json()};
  };
  const connection={url:'https://benchmark.test',database,...credentials};
  const devices:Device[]=[];
  try {
    const crypto=await importRecoveryCode(generateRecoveryCode());
    if(encrypted)await new CouchConfiguration(connection,http).createConfiguration(await createConfiguration(crypto));
    const remote=()=>encrypted?EncryptedRemote.connect(connection,http,crypto,syncPath):Promise.resolve(new CouchClient(connection,http));
    const source=new Device(await remote());devices.push(source);
    for(const fixture of smallNotes(count))source.vault.files.set(fixture.path,new TextDecoder().decode(fixture.bytes));
    requests=0;const uploadStart=performance.now();await source.start();
    for(let i=0;source.status==='Syncing…'&&i<100;i++)await source.tick();
    if(source.status!=='Synced')throw new Error('Upload did not converge.');
    const uploadMs=performance.now()-uploadStart,uploadRequests=requests;
    const target=new Device(await remote());devices.push(target);
    let firstFileMs:number|null=null;
    const original=target.vault.compareAndSet.bind(target.vault);
    let downloadStart=0;
    target.vault.compareAndSet=async(...args)=>{
      const result=await original(...args);
      if(result&&firstFileMs===null)firstFileMs=performance.now()-downloadStart;
      return result;
    };
    requests=0;downloadStart=performance.now();await target.start();
    for(let i=0;target.status==='Syncing…'&&i<100;i++)await target.tick();
    if(target.status!=='Synced'||target.vault.files.size!==count)throw new Error('Download did not converge.');
    for(const [path,contents]of source.vault.files)if(target.vault.files.get(path)!==contents)throw new Error('Fixture mismatch.');
    const row={run,encrypted,notes:count,addedRttMs:rtt,uploadMs,uploadRequests,firstFileMs,
      completeDownloadMs:performance.now()-downloadStart,downloadRequests:requests};
    results.push(row);console.log(JSON.stringify(row));
  } finally {for(const d of devices)await d.engine.stop();await admin(database,'DELETE');}
}
console.log(JSON.stringify({scope:'Real CouchDB + Node HTTP + simulated vaults; NOT Obsidian/UI/iPhone memory',runtime:process.version,results}));
