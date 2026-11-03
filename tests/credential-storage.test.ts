import {test} from 'node:test';
import assert from 'node:assert/strict';
import {storeCredential} from '../src/credential-storage';
test('credential replacement creates a verified new reference without changing the old secret',async()=>{
  const values=new Map<string,string>();
  const store={get:async(id:string)=>values.get(id)??null,set:async(id:string,value:string)=>{values.set(id,value);}};
  const first=await storeCredential(store,'synthetic old'),second=await storeCredential(store,'synthetic new');
  assert.notEqual(first,second);assert.match(second,/^bettersync-[a-f0-9]{32}$/);
  assert.equal(values.get(first),'synthetic old');assert.equal(values.get(second),'synthetic new');
});
test('failed secret readback provides no reference and sanitizes secret-store errors',async()=>{
  await assert.rejects(()=>storeCredential({get:async()=>null,set:async()=>{}},'synthetic'));
  await assert.rejects(()=>storeCredential({get:async()=>null,set:async()=>{throw new Error('SECRET');}},'synthetic'),
    e=>e instanceof Error&&!e.message.includes('SECRET'));
});
