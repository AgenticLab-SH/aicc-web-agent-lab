import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../Start-AiccCdpChromeSlot.ps1', import.meta.url));

function runFixture({ offline = false, mismatch = false, extensionFailure = false, action = 'Ensure', flags = '' } = {}) {
  const command = `
$global:fixtureOnline = $${!offline}
$global:fixtureMismatch = $${mismatch}
function Test-Path { return $true }
function Get-Content {
  '[browser]'
  'cdp_slot1_port = 9222'
  'cdp_slot1_usage = "manual_login_pending"'
  'cdp_slot1_profile_dir = "' + (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center/browser-profiles/chrome/9222/UserData') + '"'
}
function pwsh {
  $global:LASTEXITCODE = 0
  $arguments = @($args)
  $file = $arguments[$arguments.IndexOf('-File') + 1]
  if ($file -match 'Assert-CdpEndpointIdentity') {
    if ($global:fixtureMismatch) { return '{"ok":false,"reasons":["wrong_browser_profile"]}' }
    if ($global:fixtureOnline) { return '{"ok":true,"reasons":[]}' }
    return '{"ok":false,"reasons":["cdp_endpoint_unavailable"]}'
  }
  if ($file -match 'Manage-AiccChromeExtensions') {
    if ($${extensionFailure}) {
      $global:LASTEXITCODE = 1
      return '{"ok":false,"error":"pinned_extension_source_verification_failed","extension_key":"webgpt-queue"}'
    }
    $requested = $arguments[$arguments.IndexOf('-Action') + 1]
    if ('-NoStart' -notin $arguments) { throw 'Missing NoStart' }
    if ('-DryRun' -in $arguments) { [Console]::WriteLine('CALL preview') }
    else { [Console]::WriteLine('CALL ' + $requested) }
    return '{"ok":true}'
  }
  if ($file -match 'Start-CdpChromeSlot') {
    [Console]::WriteLine('CALL base')
    $global:fixtureOnline = $true
    return
  }
  throw 'Unexpected external command'
}
& '${launcher.replaceAll("'", "''")}' -Port 9222 -Action ${action} ${flags}
`;
  return spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
}

test('online Ensure does not invoke base or create another tab', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(!result.stdout.includes('CALL base'));
  assert.match(result.stdout, /CALL preview[\s\S]*CALL Ensure[\s\S]*CALL Status/);
  assert.match(result.stdout, /"started":false/);
});

test('extension pin failure names the stage and key before any browser start', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ offline: true, extensionFailure: true });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.error, 'pinned_extension_source_verification_failed');
  assert.equal(report.phase, 'extension_preview');
  assert.equal(report.extension_key, 'webgpt-queue');
  assert.ok(!result.stdout.includes('CALL base'));
  assert.ok(!result.stdout.includes('CALL Ensure'));
});

test('offline one-shot start has preview and post-status', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ offline: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.match(/CALL base/g)?.length, 1);
  assert.match(result.stdout, /CALL preview[\s\S]*CALL base[\s\S]*CALL Ensure[\s\S]*CALL Status/);
});

test('Status, DryRun, NoStart and identity mismatch cannot start a browser', { skip: process.platform !== 'win32' }, () => {
  for (const fixture of [{ offline: true, action: 'Status' }, { offline: true, flags: '-DryRun' }, { offline: true, flags: '-NoStart' }, { mismatch: true }]) {
    const result = runFixture(fixture);
    assert.ok(!result.stdout.includes('CALL base'));
    assert.ok(!result.stdout.includes('CALL Ensure'));
    if (fixture.flags !== '-DryRun') assert.equal(result.status, 1);
    else assert.equal(result.status, 0, result.stderr + result.stdout);
  }
});
