import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeWorkspaceCommand,
  catastrophicWorkspaceCommandReason
} from '../components/workspace-mcp/destructive-command-guard.mjs';

const env = {
  SystemDrive: 'C:',
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  USERPROFILE: 'C:\\demo\\owner'
};

test('blocks system shutdown, restart and session logoff without blocking service builds', () => {
  for (const command of ['shutdown /s /t 0', 'shutdown.exe /r /t 0', 'Restart-Computer -Force', 'Stop-Computer', 'logoff.exe', 'reboot']) {
    assert.match(catastrophicWorkspaceCommandReason(command, { env }), /shutdown, reboot/);
  }
  assert.equal(catastrophicWorkspaceCommandReason('npm run build', { env }), null);
  assert.equal(catastrophicWorkspaceCommandReason('Get-Process', { env }), null);
});

const options = {
  env,
  home: 'C:\\demo\\owner',
  stateRoot: 'C:\\demo\\owner\\.ai-control-center\\workspace-mcp',
  workspaceRoot: 'C:\\demo\\projects\\demo'
};

test('blocks disk and encoded PowerShell destructive surfaces', () => {
  assert.match(catastrophicWorkspaceCommandReason('Clear-Disk -Number 0 -RemoveData', options), /Disk or volume/);
  assert.match(catastrophicWorkspaceCommandReason('pwsh -EncodedCommand AAAA', options), /Encoded PowerShell/);
});

test('blocks exact protected roots and workspace root deletion', () => {
  assert.match(catastrophicWorkspaceCommandReason('Remove-Item -LiteralPath C:\\ -Recurse -Force', options), /protected root/);
  assert.match(catastrophicWorkspaceCommandReason('Remove-Item -LiteralPath C:\\demo\\owner -Recurse -Force', options), /protected root/);
  assert.match(catastrophicWorkspaceCommandReason('Remove-Item -LiteralPath C:\\demo\\projects\\demo -Recurse -Force', options), /protected root/);
});

test('resolves simple PowerShell variable bindings before destructive checks', () => {
  const command = "$root='C:\\demo\\open-AICC'; Remove-Item -LiteralPath $root -Recurse -Force";
  assert.match(catastrophicWorkspaceCommandReason(command, options), /protected root/);
});

test('blocks destructive git while allowing bounded ordinary cleanup', () => {
  assert.match(catastrophicWorkspaceCommandReason('git reset --hard HEAD', options), /reset --hard/);
  assert.match(catastrophicWorkspaceCommandReason('git clean -fd', options), /git clean/);
  assert.equal(catastrophicWorkspaceCommandReason('Remove-Item -LiteralPath C:\\demo\\projects\\demo\\.tmp-test -Recurse -Force', options), null);
  assert.equal(catastrophicWorkspaceCommandReason('git status --short', options), null);
  assert.equal(catastrophicWorkspaceCommandReason('npm test', options), null);
});

test('throws a typed error before execution', () => {
  assert.throws(
    () => assertSafeWorkspaceCommand('Remove-Item C:\\ -Recurse -Force', options),
    error => error?.code === 'workspace_command_destructive_blocked'
  );
});
