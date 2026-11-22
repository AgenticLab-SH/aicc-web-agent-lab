import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const runner=fileURLToPath(new URL('./ocx-release-closure.test.ps1',import.meta.url));
test('G1 reviewed OCX additions preserve the installed 14/15-member closure and reject unsafe inputs',
  {skip:process.platform!=='win32'},()=>{
    const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',runner],{
      cwd:path.dirname(runner),encoding:'utf8',windowsHide:true,timeout:90000
    });
    assert.equal(result.status,0,result.stderr||result.stdout);
    const proof=JSON.parse(result.stdout);
    assert.equal(proof.status,'PASS');
    assert.equal(proof.checks,36);
    assert.equal(proof.fakeCandidateAdapterFiles,15);
    assert.equal(proof.fixtureOnly,true);
    assert.equal(proof.liveInstall,false);
    assert.ok(proof.names.includes('linked new module'));
    assert.ok(proof.names.includes('installed 15-module baseline accepts exact reviewed reachable addition without activation'));
    assert.ok(proof.names.includes('installed 15-module addition pin drift'));
  });
