import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {__testing as api} from '../components/workspace-mcp/server.mjs';
test('patch errors preserve the failing stage without claiming a permission cause',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-patch-diagnostics-'));
  const cases=[
    ['rename from ok\nrename to next\n','PATCH_FORMAT_UNSUPPORTED','format'],
    ['--- /dev/null\n+++ b/../escape\n','PATCH_PATH_CHECK_FAILED','path-check'],
    ['--- /dev/null\n+++ b/proof.txt\n@@ -0,0 +1,2 @@\n+only-one-line\n','PATCH_PREFLIGHT_FAILED','preflight']
  ];
  for(const [patch,code,stage] of cases){
    assert.throws(()=>api.runPatch(root,root,patch,false),error=>{
      const result=api.safeError(error);
      assert.equal(result.isError,true);
      assert.deepEqual(result.structuredContent.diagnostics,{code,stage,writeState:'NOT_STARTED'});
      assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
      return true;
    });
  }
  assert.equal(fs.existsSync(path.join(root,'proof.txt')),false);
  assert.equal(api.safeError(Object.assign(new Error('unclassified'),{code:'ACCESS_DENIED',lease:'secret'})).structuredContent.diagnostics,undefined);
});
test('nested text patch creates confined parents and applies the file',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-patch-parent-'));
  const diff='--- /dev/null\n+++ b/new/child/proof.txt\n@@ -0,0 +1 @@\n+hello\n';
  assert.equal(api.runPatch(root,root,diff,false).ok,true);
  assert.equal(fs.readFileSync(path.join(root,'new/child/proof.txt'),'utf8'),'hello\n');
  assert.throws(()=>api.validatePatchPaths(root,'--- /dev/null\n+++ b/../escape\n'),/벗어|Unsafe/);
  assert.throws(()=>api.ensurePatchParents(root,['x:stream/file.txt']),/Unsafe/);
  assert.throws(()=>api.validatePatchPaths(root,'--- /dev/null\n+++ b/proof.txt:stream\n'),/Unsafe/);
  assert.throws(()=>api.runPatch(root,root,'rename from ok\nrename to .env\n',false),/unified/);
});
test('Windows invocation requires AppContainer policy and a clean environment', {skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-broker-invocation-'));
  assert.throws(()=>api.sandboxInvocation(root,root,'echo ok',true,'unspecified'),/isolation/);
  assert.throws(()=>api.sandboxInvocation(root,root,'echo ok',false,'owner-unrestricted-windows'),/network deny/);
  const owner=api.sandboxInvocation(root,root,'Write-Output ok',true,'owner-unrestricted-windows');
  assert.ok(owner.env.PATHEXT.includes('.EXE;.BAT;.CMD'));
  const invocation=api.sandboxInvocation(root,root,'Write-Output ok',false,'appcontainer-windows');
  assert.ok(invocation.args.some(value=>value.endsWith('Invoke-AiccWorkspaceSandbox.ps1')));
  assert.equal(invocation.env.OPENCODEX_API_AUTH_TOKEN,undefined);
  assert.equal(invocation.args.at(-1),'Disabled');
});
