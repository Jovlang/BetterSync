import {hash} from './paths';
import type {VaultClient, Content} from './types';
/** Content-addressed names make crash retries idempotent. Never overwrite a copy. */
export async function preserveConflict(vault:VaultClient, path:string, content:Content, clientId:string):Promise<string> {
  if(path.endsWith('/')) throw new Error('A directory conflict remains queued for retry.');
  const dot=path.lastIndexOf('.');
  const extension=dot>path.lastIndexOf('/')?path.slice(dot):'';
  const stem=extension?path.slice(0,-extension.length):path;
  const name = `${stem}.sync-conflict-${clientId.slice(0,8)}-${hash(content)!.slice(0,24)}${extension}`;
  for (let suffix=0; suffix<100; suffix++) {
    const candidate = suffix ? (extension?name.slice(0,-extension.length):name)+`-${suffix}${extension}` : name;
    const existing = await vault.read(candidate);
    if (hash(existing) === hash(content)) return candidate;
    if (existing === null) {
      try { await vault.create(candidate,content); return candidate; }
      catch (error) { if (await vault.read(candidate) === null) throw error; }
    }
  }
  throw new Error('Could not preserve the conflicting note.');
}
