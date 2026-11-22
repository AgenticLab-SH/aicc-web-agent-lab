import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveWindowsPwsh } from '../src/lib/windows-pwsh.mjs';
import {
  assertWindowsOwnerOnlyPath,
  ensureWindowsOwnerOnlyDirectory,
  protectWindowsOwnerOnlyPath,
  windowsOwnerOnlyPathStatus,
  WindowsOwnerOnlyAclError
} from '../src/lib/windows-owner-only-acl.mjs';

test('owner-only helper protects a Windows directory and inherited file', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-owner-only-acl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  ensureWindowsOwnerOnlyDirectory(directory);
  assert.equal(windowsOwnerOnlyPathStatus(directory, { directory: true }).ok, true);

  const file = path.join(directory, 'result.json');
  fs.writeFileSync(file, '{}\n');
  protectWindowsOwnerOnlyPath(file, { directory: false });
  assert.equal(assertWindowsOwnerOnlyPath(file, { directory: false }).ok, true);
});

test('owner-only helper rejects a broad Windows grant and repairs it one-shot', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-owner-only-acl-broad-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  ensureWindowsOwnerOnlyDirectory(directory);

  // icacls changes only this disposable directory's DACL, not its audit SACL.
  const changed = spawnSync(path.join(process.env.SystemRoot,'System32/icacls.exe'), [directory,'/grant','*S-1-1-0:(OI)(CI)R'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000
  });
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(windowsOwnerOnlyPathStatus(directory, { directory: true }).ok, false);
  assert.throws(
    () => assertWindowsOwnerOnlyPath(directory, { directory: true }),
    error => error instanceof WindowsOwnerOnlyAclError && error.code === 'windows_owner_only_acl_required'
  );
  assert.throws(
    () => ensureWindowsOwnerOnlyDirectory(directory),
    error => error instanceof WindowsOwnerOnlyAclError && error.code === 'windows_owner_only_acl_required'
  );
  protectWindowsOwnerOnlyPath(directory, { directory: true });
  assert.equal(windowsOwnerOnlyPathStatus(directory, { directory: true }).ok, true);
});

test('pinned native helper retains strict status and refuses changed code', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-native-acl-contract-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const executable=path.join(root,'helper.exe');fs.writeFileSync(executable,'fake helper');
  const sha256=crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  let invoked=0;
  const options={platform:'win32',nativeHelper:{executable,sha256},run:(command,args,settings)=>{
    invoked++;assert.equal(command,executable);assert.deepEqual(args,['1','0']);assert.equal(settings.input,root);return{status:31};
  }};
  assert.equal(windowsOwnerOnlyPathStatus(root,options).reason,'owner_mismatch');
  fs.writeFileSync(executable,'changed');
  assert.throws(()=>windowsOwnerOnlyPathStatus(root,options),error=>error.code==='native_acl_helper_changed');
  assert.equal(invoked,1);
});
