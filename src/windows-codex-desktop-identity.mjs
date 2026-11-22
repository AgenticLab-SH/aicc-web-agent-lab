import { spawnSync } from 'node:child_process';

// Read only registered AppX identity and process metadata. Never start, stop,
// inspect credentials, or treat the absence of an app window as task-idle proof.
export function inspectWindowsCodexDesktopIdentity(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') {
    return { ok: false, state: 'UNKNOWN_UNSUPPORTED_PLATFORM', applications: [], observationOnly: true };
  }
  const script = [
    '$ErrorActionPreference="Stop";',
    '$packages=@(Get-AppxPackage -Name OpenAI.Codex);',
    'if($packages.Count -ne 1){throw "registered_package_not_unique"};',
    '$package=$packages[0];',
    '$manifest=Get-AppxPackageManifest -Package $package;',
    '$apps=@($manifest.Package.Applications.Application|Where-Object {$_.Id -eq "App"});',
    'if($apps.Count -ne 1){throw "registered_main_app_not_unique"};',
    '$executable=[IO.Path]::GetFullPath((Join-Path $package.InstallLocation ([string]$apps[0].Executable)));',
    '$rows=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq [IO.Path]::GetFileName($executable)});',
    '$applications=@();$unknown=@();',
    'foreach($row in $rows){',
    'if(-not $row.ExecutablePath -or -not $row.CommandLine){$unknown+=@{pid=$row.ProcessId;reason="process_identity_unreadable"};continue};',
    'if(-not [string]::Equals($row.ExecutablePath,$executable,[StringComparison]::OrdinalIgnoreCase)){continue};',
    'if($row.CommandLine -match "(?:^|\\s)--type="){continue};',
    '$applications+=@{pid=$row.ProcessId;parentPid=$row.ParentProcessId;createdAt=$row.CreationDate.ToUniversalTime().ToString("o");executablePath=$row.ExecutablePath};',
    '};',
    '@{packageName=$package.Name;packageVersion=[string]$package.Version;packageFamily=$package.PackageFamilyName;applicationId=[string]$apps[0].Id;executablePath=$executable;applications=$applications;unknown=$unknown}|ConvertTo-Json -Compress -Depth 5'
  ].join(' ');
  const result = (options.spawnSync ?? spawnSync)(options.windowsPowerShell ?? 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: options.timeoutMs ?? 10_000, maxBuffer: 256 * 1024 });
  if (result.error || result.status !== 0) {
    return { ok: false, state: 'UNKNOWN_REGISTERED_APP_IDENTITY', applications: [], observationOnly: true };
  }
  let identity;
  try { identity = JSON.parse(String(result.stdout ?? '').replace(/^\uFEFF/, '').trim()); }
  catch { return { ok: false, state: 'UNKNOWN_APP_IDENTITY_RESPONSE', applications: [], observationOnly: true }; }
  if (identity?.packageName !== 'OpenAI.Codex' || !identity.packageFamily || (typeof identity.applicationId !== 'string' || identity.applicationId.toLowerCase() !== 'app')
    || !Array.isArray(identity.applications) || !Array.isArray(identity.unknown)) {
    return { ok: false, state: 'UNKNOWN_APP_IDENTITY_RESPONSE', applications: [], observationOnly: true };
  }
  const known = identity.unknown.length === 0;
  return {
    ...identity,
    ok: known,
    state: !known ? 'UNKNOWN_PROCESS_IDENTITY' : identity.applications.length > 0 ? 'REGISTERED_DESKTOP_PROCESS_PRESENT' : 'REGISTERED_DESKTOP_PROCESS_ABSENT',
    taskIdleProved: false,
    applicationLifecycleScope: 'REGISTERED_MAIN_APP_ONLY',
    localCodexWorkGateUnchanged: true,
    observationOnly: true
  };
}
