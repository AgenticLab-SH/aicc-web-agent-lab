import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { validateOwnerOnlyUnixSocket } from './codex-app-server-daemon.mjs';
import { assertWindowsOwnerOnlyPath } from '../lib/windows-owner-only-acl.mjs';
import { resolveWindowsPwsh } from '../lib/windows-pwsh.mjs';

// Windows AF_UNIX endpoints are IO_REPARSE_TAG_AF_UNIX, which Node lstat
// reports as EACCES. Inspect that exact type without following any link.
export function validateWindowsSharedProxySocket(socketPath, {run=spawnSync}={}) {
  if (!path.isAbsolute(socketPath) || /\p{Cc}/u.test(socketPath)) throw Error('daemon_socket_path_invalid');
  const normalized=path.resolve(socketPath);
  assertWindowsOwnerOnlyPath(path.dirname(normalized), {directory:true});
  const result=run(resolveWindowsPwsh(), ['-NoProfile','-NonInteractive','-Command', String.raw`
$ErrorActionPreference='Stop'
$p=[Console]::In.ReadToEnd()
$i=Get-Item -LiteralPath $p -Force
if($i.PSIsContainer -or $i.LinkType -or -not($i.Attributes -band [IO.FileAttributes]::ReparsePoint)){exit 21}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
$a=Get-Acl -LiteralPath $p
if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){exit 31}
$full=$false
foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
 if($r.AccessControlType -ne 'Allow' -or $r.IdentityReference.Value -notin @($owner.Value,'S-1-5-18')){exit 34}
 if($r.IdentityReference.Value -eq $owner.Value -and ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl){$full=$true}
}
if(-not $full){exit 35}
$probe=& (Join-Path $env:SystemRoot 'System32\fsutil.exe') reparsepoint query $p 2>&1
if($LASTEXITCODE -ne 0 -or ($probe -join "\n") -notmatch '(?i)0x80000023'){exit 21}
exit 0
`], {input:normalized,encoding:'utf8',windowsHide:true,timeout:20000});
  if(result.error || result.status!==0) throw Error('daemon_windows_socket_type_or_owner_unproven');
  return normalized;
}

// A client of an existing daemon only. Never starts, enables, or stops that daemon.
export function validateSharedProxySocket(socketPath) {
  if (process.platform === 'win32') return validateWindowsSharedProxySocket(socketPath);
  const socket = validateOwnerOnlyUnixSocket(socketPath);
  return socket;
}

export function createCodexAppServerProxySpawn({ socketPath, spawnProcess = spawn } = {}) {
  const socket = validateSharedProxySocket(socketPath);
  return (executable, _args, options = {}) => {
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || /\p{Cc}/u.test(executable)) {
      throw new Error('shared_proxy_absolute_executable_required');
    }
    // Recheck the endpoint boundary immediately before connecting. No fallback.
    validateSharedProxySocket(socket);
    return spawnProcess(executable, ['app-server', 'proxy', '--sock', socket], {
      ...options,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  };
}
