import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = fs.readFileSync(new URL('../tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function Regular('), source.indexOf('$OperationDirectory=[IO.Path]::GetFullPath'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('owner command approval requires exact user decision, task, candidate and bounded expiry', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-owner-approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const approvalFile = path.join(root, 'approval.json'), candidateFile = path.join(root, 'candidate.json');
  const approval = { kind: 'workspace-owner-command-approval/v1', source: 'explicit-user-message', owner_task_id: 'test-owner', permission: 'owner-unrestricted-windows', githubBackup: 'DEFERRED_BY_USER', baseline: 'old', backend: 'new', configBeforeSHA256: 'a'.repeat(64), configDesiredSHA256: 'b'.repeat(64), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const candidate = { kind: 'workspace-patch-parent-update', baseline: 'old', backend: 'new', configBeforeSHA256: approval.configBeforeSHA256, configDesiredSHA256: approval.configDesiredSHA256, ownerCommandApprovalFile: approvalFile };
  const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const refresh = () => { put(approvalFile, approval); candidate.ownerCommandApprovalSHA256 = hash(approvalFile); put(candidateFile, candidate); };
  const script = path.join(root, 'check.ps1');
  fs.writeFileSync(script, `param($CandidateReceipt,$Check='approval')\n$ErrorActionPreference='Stop'\n$env:CODEX_THREAD_ID='test-owner'\n${helpers}\n$c=Read $CandidateReceipt\nif($Check -eq 'backup'){Assert-ChangeBackupPolicy $c @{kind='workspace-owner-approved-local-backup/v1';githubStatus='VERIFIED';localStatus='PREPARED'}}else{$null=Assert-OwnerCommandApproval $c}\n`);
  const run = check => spawnSync('pwsh', ['-NoProfile', '-File', script, candidateFile, check ?? 'approval'], { encoding: 'utf8', windowsHide: true });
  refresh(); let result = run(); assert.equal(result.status, 0, result.stderr);
  for (const [key, bad] of [['source', 'inferred'], ['owner_task_id', 'other-owner'], ['permission', 'admin'], ['githubBackup', 'VERIFIED'], ['baseline', 'other'], ['configDesiredSHA256', 'c'.repeat(64)], ['expiresAt', new Date(Date.now() - 10000).toISOString()], ['expiresAt', new Date(Date.now() + 10800000).toISOString()]]) {
    const previous = approval[key]; approval[key] = bad; refresh(); result = run(); assert.notEqual(result.status, 0, key); approval[key] = previous;
  }
  refresh(); result = run('backup'); assert.notEqual(result.status, 0); assert.match(result.stderr, /user-deferred GitHub/);
  candidate.kind = 'workspace-broker-security-update'; refresh(); result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /explicit owner command approval/);
  candidate.kind = 'workspace-patch-parent-update'; refresh(); fs.appendFileSync(approvalFile, ' '); result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /explicit owner command approval/);
});
