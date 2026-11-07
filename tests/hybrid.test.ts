import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encryptRecord,decryptRecord,INLINE_FILE_BYTES} from '../src/legacy/encrypted-protocol';
import {generateRecoveryCode,importRecoveryCode} from '../src/legacy/encryption-setup';
import {base64url,unbase64url} from '../src/legacy/crypto';
import {syncPath} from '../src/paths';
for(const size of [0,1,INLINE_FILE_BYTES,INLINE_FILE_BYTES+1])test(`hybrid boundary ${size}: authenticated representation and substitution rejection`,async()=>{
  const key=await importRecoveryCode(generateRecoveryCode()),wrong=await importRecoveryCode(generateRecoveryCode());
  const bytes=new Uint8Array(size).fill(42).buffer;
  for(const path of ['note.md','opaque.bin']) {
    const {record,body}=await encryptRecord(key,{path,bytes,deleted:false,mtime:0});
    assert.equal(record.inline!==undefined,size<=INLINE_FILE_BYTES);
    assert.deepEqual((await decryptRecord(key,record,body,syncPath)).bytes,bytes);
    await assert.rejects(()=>decryptRecord(wrong,record,body,syncPath));
    const ciphertext=record.inline!==undefined?unbase64url(record.inline,16,INLINE_FILE_BYTES+16):new Uint8Array(body!);
    const damaged=ciphertext.slice();damaged[damaged.length-1]=damaged[damaged.length-1]!^1;
    await assert.rejects(()=>decryptRecord(key,record.inline!==undefined?{...record,inline:base64url(damaged)}:record,record.inline!==undefined?undefined:damaged.buffer,syncPath));
    if(record.inline!==undefined) {
      const {inline,...rest}=record;
      await assert.rejects(()=>decryptRecord(key,{...rest,_attachments:{content:{stub:true,content_type:'application/octet-stream',length:ciphertext.length}}},ciphertext.buffer,syncPath));
    }else {
      const {_attachments,...rest}=record;
      await assert.rejects(()=>decryptRecord(key,{...rest,inline:base64url(ciphertext)},undefined,syncPath));
    }
    const other=await encryptRecord(key,{path,bytes,deleted:false,mtime:0});
    await assert.rejects(()=>decryptRecord(key,record.inline!==undefined?{...record,inline:other.record.inline}:record,record.inline!==undefined?undefined:other.body,syncPath));
  }
});
