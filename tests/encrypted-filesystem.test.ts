import {test} from 'node:test';
import {fixture,connection} from './encrypted-wire';
import {EncryptedRemote} from '../src/encrypted-remote';
import {importRecoveryCode} from '../src/encryption-setup';
import {syncPath} from '../src/paths';
import {freshEncryptedTree} from './encrypted-filesystem';

for(const interrupted of [false,'poll','restart'] as const)test(`fresh encrypted mixed-file tree through actual vault adapter, interrupted=${interrupted}`,async()=>{
  const f=await fixture();
  await freshEncryptedTree(async()=>EncryptedRemote.connect(connection,f.wire.http,await importRecoveryCode(f.code),syncPath),interrupted);
});
