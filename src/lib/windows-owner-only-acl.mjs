import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveWindowsPwsh } from './windows-pwsh.mjs';

const STATUS = Object.freeze({
  0: 'ok',
  20: 'path_type_mismatch',
  21: 'path_type_mismatch',
  31: 'owner_mismatch',
  32: 'inheritance_not_protected',
  33: 'unexpected_deny_or_rule_type',
  34: 'broad_access_rule',
  35: 'full_control_missing'
});

const POLICY_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$p=[Console]::In.ReadToEnd()
$directory=$env:AICC_OWNER_ONLY_DIRECTORY -eq '1'
$apply=$env:AICC_OWNER_ONLY_APPLY -eq '1'
$item=Get-Item -LiteralPath $p -Force
if($directory -and -not $item.PSIsContainer){exit 20}
if((-not $directory) -and $item.PSIsContainer){exit 21}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
function Test-OwnerOnlyAcl($acl,$directory,$owner,$system){
  $ownerSid=$owner.Value
  $systemSid=$system.Value
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid){return 31}
  if($directory -and -not $acl.AreAccessRulesProtected){return 32}
  $ownerFull=$false
  $systemFull=$false
  foreach($rule in $acl.Access){
    $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){return 33}
    if($sid -notin @($ownerSid,$systemSid)){return 34}
    $full=($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl
    if($sid -eq $ownerSid -and $full){$ownerFull=$true}
    if($sid -eq $systemSid -and $full){$systemFull=$true}
  }
  if(-not $ownerFull -or -not $systemFull){return 35}
  return 0
}
$acl=Get-Acl -LiteralPath $p
$code=Test-OwnerOnlyAcl $acl $directory $owner $system
if($code -eq 0){exit 0}
if(-not $apply){exit $code}
if($directory){$restricted=[Security.AccessControl.DirectorySecurity]::new()}
else{$restricted=[Security.AccessControl.FileSecurity]::new()}
$restricted.SetSecurityDescriptorSddlForm($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Access,Owner'),[Security.AccessControl.AccessControlSections]'Access,Owner')
$acl=$restricted
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true,$false)
foreach($rule in @($acl.Access)){$null=$acl.RemoveAccessRuleSpecific($rule)}
if($directory){
  $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
}else{
  $inherit=[Security.AccessControl.InheritanceFlags]::None
}
$prop=[Security.AccessControl.PropagationFlags]::None
foreach($sid in @($owner,$system)){
  $rule=[Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inherit,
    $prop,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
}
if($directory){[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($p),$acl)}
else{[IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($p),$acl)}
$after=Get-Acl -LiteralPath $p
exit (Test-OwnerOnlyAcl $after $directory $owner $system)
`;

export class WindowsOwnerOnlyAclError extends Error {
  constructor(code, message = code, data = null) {
    super(message);
    this.name = 'WindowsOwnerOnlyAclError';
    this.code = code;
    this.data = data;
  }
}

function targetStat(target, directory) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new WindowsOwnerOnlyAclError('owner_only_path_type_invalid');
  }
  return stat;
}

function runPolicy(target, {
  directory = true,
  apply = false,
  platform = process.platform,
  run = spawnSync,
  nativeHelper,
  pwsh = resolveWindowsPwsh()
} = {}) {
  targetStat(target, directory);
  if (platform !== 'win32') throw new WindowsOwnerOnlyAclError('windows_required');
  let command = pwsh;
  let args = ['-NoProfile', '-NonInteractive', '-Command', POLICY_SCRIPT];
  if (nativeHelper) {
    const { executable, sha256 } = nativeHelper;
    if (!path.isAbsolute(executable ?? '') || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) {
      throw new WindowsOwnerOnlyAclError('native_acl_helper_invalid');
    }
    targetStat(executable, false);
    if (crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') !== sha256) {
      throw new WindowsOwnerOnlyAclError('native_acl_helper_changed');
    }
    command = executable;
    args = [directory ? '1' : '0', apply ? '1' : '0'];
  }
  const result = run(command, args, {
    input: target,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: {
      ...process.env,
      AICC_OWNER_ONLY_DIRECTORY: directory ? '1' : '0',
      AICC_OWNER_ONLY_APPLY: apply ? '1' : '0'
    }
  });
  const status = Number.isInteger(result.status) ? result.status : -1;
  return Object.freeze({
    ok: status === 0 && !result.error,
    status,
    reason: STATUS[status] ?? (result.error ? 'acl_probe_failed' : 'acl_policy_failed')
  });
}

export function windowsOwnerOnlyPathStatus(target, options = {}) {
  return runPolicy(target, { ...options, apply: false });
}

export function assertWindowsOwnerOnlyPath(target, options = {}) {
  const status = windowsOwnerOnlyPathStatus(target, options);
  if (!status.ok) {
    throw new WindowsOwnerOnlyAclError('windows_owner_only_acl_required', status.reason, status);
  }
  return status;
}

export function protectWindowsOwnerOnlyPath(target, options = {}) {
  const status = runPolicy(target, { ...options, apply: true });
  if (!status.ok) {
    throw new WindowsOwnerOnlyAclError('windows_owner_only_acl_apply_failed', status.reason, status);
  }
  return status;
}

export function ensureWindowsOwnerOnlyDirectory(directory, options = {}) {
  const existed = fs.existsSync(directory);
  if (existed) {
    targetStat(directory, true);
    if ((options.platform ?? process.platform) !== 'win32') {
      const stat = fs.lstatSync(directory);
      if ((stat.mode & 0o077) !== 0) throw new WindowsOwnerOnlyAclError('owner_only_posix_mode_required');
      return Object.freeze({ ok: true, platform: 'posix', created: false });
    }
    return Object.freeze({ ...assertWindowsOwnerOnlyPath(directory, { ...options, directory: true }), created: false });
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  targetStat(directory, true);
  if ((options.platform ?? process.platform) !== 'win32') {
    fs.chmodSync(directory, 0o700);
    const stat = fs.lstatSync(directory);
    if ((stat.mode & 0o077) !== 0) throw new WindowsOwnerOnlyAclError('owner_only_posix_mode_required');
    return Object.freeze({ ok: true, platform: 'posix', created: true });
  }
  return Object.freeze({ ...protectWindowsOwnerOnlyPath(directory, { ...options, directory: true }), created: true });
}
