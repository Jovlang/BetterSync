import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

test('plugin bundle excludes legacy crypto/multipart and has only Obsidian runtime imports',async()=>{
  const result=await build({entryPoints:['src/main.ts'],bundle:true,write:false,metafile:true,external:['obsidian'],platform:'browser',format:'cjs',target:'es2020'});
  assert.ok(!Object.keys(result.metafile.inputs).some(p=>p.includes('/legacy/')));
  const imports=Object.values(result.metafile.outputs).flatMap(o=>o.imports);
  assert.ok(imports.length>0);assert.ok(imports.every(i=>i.path==='obsidian'&&i.external));
  const text=result.outputFiles[0]!.text;
  assert.ok(text.includes('bettersync-e2ee-5'));assert.ok(!text.includes('bettersync-e2ee-draft-1'));assert.ok(!text.includes('multipart/related'));
});
