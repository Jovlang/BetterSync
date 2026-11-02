import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeBinary,decodeBinary,syncPath,validateContent,MAX_FILE_BYTES} from '../src/paths';
import {three,settle} from './helpers';

test('binary encoding preserves every byte and chunk boundaries',()=>{
  const bytes=Uint8Array.from({length:100003},(_,i)=>i%256);
  const encoded=encodeBinary(bytes.buffer);
  assert.equal(encoded,Buffer.from(bytes).toString('base64'));
  assert.deepEqual(new Uint8Array(decodeBinary(encoded)),bytes);
  validateContent('image.png',encoded);
  assert.equal(MAX_FILE_BYTES,209715200);
  for(const value of ['a','!!!!','AA=A'])assert.throws(()=>validateContent('file.bin',value));
  assert.throws(()=>validateContent('empty/',''));
  assert.equal(syncPath('.hidden/config'),true);
  assert.equal(syncPath('folder/.obsidian/config'),false);
});

test('three clients sync binary, Canvas, hidden files and empty directories through offline restart',async()=>{
  const {a,b,c}=await three();
  const content=encodeBinary(Uint8Array.from([0,255,128,13,10]).buffer);
  for(const path of ['image.png','board.canvas','.hidden/config','LICENSE'])await a.vault.edit(path,content);
  await a.vault.edit('empty/','directory');await settle(a,b,c);
  for(const d of [a,b,c]) {assert.equal(await d.vault.read('image.png'),content);assert.equal(await d.vault.read('empty/'),'directory');}
  const revised=encodeBinary(Uint8Array.from([1,2,3]).buffer);
  await a.vault.edit('image.png',revised);await settle(a,c);
  await b.vault.edit('image.png',encodeBinary(Uint8Array.from([9,8,7]).buffer));await b.restart();await settle(a,b,c);
  for(const d of [a,b,c]) {
    assert.equal(await d.vault.read('image.png'),revised);
    assert.ok([...d.vault.files.keys()].some(p=>p.includes('.sync-conflict-')&&p.endsWith('.png')));
  }
  await a.vault.edit('empty/',null);await a.vault.edit('LICENSE',null);await settle(a,c);await b.restart();await settle(a,b,c);
  for(const d of [a,b,c]) {assert.equal(await d.vault.read('empty/'),null);assert.equal(await d.vault.read('LICENSE'),null);}
});

test('binary incoming journal survives crash before and after local application',async()=>{
  for(const afterWrite of [false,true]) {
    const {a,b,c}=await three();
    const content=encodeBinary(Uint8Array.from([0,255,1]).buffer);
    await a.vault.edit('file.bin',content);await a.tick();
    if(afterWrite)b.vault.beforeCAS=async()=>{b.saveFailure=true;};
    else b.vault.failPath='file.bin';
    await b.tick();b.saveFailure=false;b.vault.failPath=undefined;
    await b.restart();await settle(a,b,c);
    assert.equal(await b.vault.read('file.bin'),content);
    assert.equal(b.vault.files.size,1);
  }
});
