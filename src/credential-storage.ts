import type {SecretStore} from './encryption-setup';
import {randomBytes} from './crypto';
export function secretReference():string {
  return 'bettersync-'+Array.from(randomBytes(16),b=>b.toString(16).padStart(2,'0')).join('');
}
/** Return a reference only after readback succeeds. The caller must commit it
 * before removing a previously persisted plaintext credential. */
export async function storeCredential(secrets:SecretStore,value:string):Promise<string> {
  const reference=secretReference();
  try {
    await secrets.set(reference,value);
    if(await secrets.get(reference)!==value)throw new Error();
    return reference;
  }catch{throw new Error('Could not save the database password.');}
}
