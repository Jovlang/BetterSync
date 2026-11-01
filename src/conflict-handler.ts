import {hash} from './paths';
import type {VaultClient} from './types';
/** Content-addressed names make crash retries idempotent. Never overwrite a copy. */
export async function preserveConflict(vault:VaultClient, path:string, content:string, clientId:string):Promise<string> {
  const stem = path.slice(0,-3);
  const name = `${stem}.sync-conflict-${clientId.slice(0,8)}-${hash(content)!.slice(0,24)}.md`;
  for (let suffix=0; suffix<100; suffix++) {
    const candidate = suffix ? name.slice(0,-3)+`-${suffix}.md` : name;
    const existing = await vault.read(candidate);
    if (existing === content) return candidate;
    if (existing === null) {
      try { await vault.create(candidate,content); return candidate; }
      catch (error) { if (await vault.read(candidate) === null) throw error; }
    }
  }
  throw new Error('Could not preserve the conflicting note.');
}
