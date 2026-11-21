import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

test('plugin bundle excludes legacy crypto/multipart and has only declared host runtime imports',async()=>{
  const result=await build({entryPoints:['src/main.ts'],bundle:true,write:false,metafile:true,external:['obsidian','node:fs/promises'],platform:'browser',format:'cjs',target:'es2020'});
  assert.ok(!Object.keys(result.metafile.inputs).some(p=>p.includes('/legacy/')));
  const imports=Object.values(result.metafile.outputs).flatMap(o=>o.imports);
  assert.deepEqual(new Set(imports.map(i=>i.path)),new Set(['obsidian','node:fs/promises']));
  assert.ok(imports.every(i=>i.external));
  assert.equal(imports.find(i=>i.path==='node:fs/promises')?.kind,'dynamic-import');
  const text=result.outputFiles[0]!.text;
  assert.ok(text.includes('bettersync-e2ee-5'));assert.ok(!text.includes('bettersync-e2ee-draft-1'));assert.ok(!text.includes('multipart/related'));
});
