#requires -Version 7.0
[CmdletBinding()]
param(
  [ValidateSet('Preview','Audit','Inspect','Apply')][string]$Mode='Preview',
  [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedInstalledSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Join-Path $env:USERPROFILE '.ai-control-center\oracle-a1-access'
$contractPath=Join-Path $root 'connection.json'
$knownHosts=Join-Path $root 'known_hosts'
$key=Join-Path $root 'id_rsa'
$source=Join-Path $PSScriptRoot 'hub_cycle_watch.py'
$target='/demo/owner/.local/share/aicc-ocx-cycle-watch/hub_cycle_watch.py'
foreach($file in @($contractPath,$knownHosts,$key,$source)){
  if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'required_source_or_pinned_ssh_missing'}
  if((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_file_refused'}
}
$contract=Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json
if($contract.version -ne 1 -or $contract.target -cne 'a1' -or
  $contract.user -cnotmatch '^[a-z_][a-z0-9_-]*$' -or
  $contract.host -notmatch '^\d{1,3}(\.\d{1,3}){3}$'){throw 'invalid_a1_contract'}
if((Get-FileHash -LiteralPath $knownHosts -Algorithm SHA256).Hash.ToLowerInvariant() -cne
  ([string]$contract.knownHostsSha256).ToLowerInvariant()){throw 'host_pin_changed'}
& (Join-Path $PSScriptRoot 'access_key.ps1') -Action status -Target a1 -Root $root | Out-Null
# Some remote shells omit ProgramData; restore only this process's OS-known path.
if([string]::IsNullOrWhiteSpace($env:ProgramData)){
  $env:ProgramData=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
}
function Resolve-OpenSsh([string]$name){
  $git=Get-Command git.exe -ErrorAction SilentlyContinue
  if($git){
    $gitRoot=Split-Path (Split-Path $git.Source -Parent) -Parent
    $candidate=Join-Path $gitRoot ('usr\bin\'+$name+'.exe')
    if(Test-Path -LiteralPath $candidate -PathType Leaf){return $candidate}
  }
  return (Get-Command ($name+'.exe') -ErrorAction Stop).Source
}
$ssh=Resolve-OpenSsh 'ssh'
$scp=Resolve-OpenSsh 'scp'
$remote=([string]$contract.user+'@'+[string]$contract.host)
$common=@('-F','none','-o','BatchMode=yes','-o','IdentitiesOnly=yes',
  '-o','StrictHostKeyChecking=yes','-o',('UserKnownHostsFile='+$knownHosts),
  '-o','HostKeyAlias=aicc-oracle-a1','-o','ConnectTimeout=15','-i',$key)
$sourceSha=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
function Invoke-Pinned([string]$body){
  $raw=$body | & $ssh @common $remote 'bash -s'
  if($LASTEXITCODE -ne 0){throw 'a1_result_unknown_check_current_before_retry'}
  return (($raw|Out-String).Trim())
}
$inspect=@'
set -eu
d=/demo/owner/.local/share/aicc-ocx-cycle-watch/hub_cycle_watch.py
test "$(id -un)" = ubuntu
test -f "$d" && test ! -L "$d"
old=$(sha256sum "$d" | cut -d " " -f 1)
timer=$(systemctl is-active aicc-ocx-cycle-watch.timer)
printf '{"installedSha256":"%s","timer":"%s"}\n' "$old" "$timer"
'@
$current=Invoke-Pinned $inspect | ConvertFrom-Json
$installedHash=([string]$current.installedSha256).Trim().ToLowerInvariant()
$timerState=([string]$current.timer).Trim()
if($installedHash -notmatch '^[a-f0-9]{64}$' -or $timerState -ne 'active'){
  throw ('installed_watcher_unverified_hashvalid_'+($installedHash -match '^[a-f0-9]{64}$')+'_timeractive_'+($timerState -eq 'active'))
}
$current.installedSha256=$installedHash
$current.timer=$timerState
if($Mode -eq 'Inspect'){
  $read=@'
set -eu
python3 -B - <<'PY'
import json
from pathlib import Path
f=Path('/demo/owner/.local/state/aicc-ocx-cycle-watch/state.json')
state=json.loads(f.read_text(encoding='utf-8'))
q=state.get('quotaQuery',{})
pending=q.get('pending',{})
items=sorted(pending.items(), key=lambda pair: float(pair[0]), reverse=True)
safe=[{'ts':ts, 'kind':str(row.get('kind','quota')),
       'sent':bool(row.get('sentAt')), 'sentAt':row.get('sentAt'),
       'replyTs':row.get('replyTs'), 'lastError':str(row.get('lastError',''))[:90]}
      for ts,row in items[:6] if isinstance(row,dict)]
print(json.dumps({'lastCursor':q.get('cursor'), 'lastOwnerObservation':q.get('lastOwnerObservation'), 'recentOwnerCommands':safe,
                  'totalPending':len(items), 'serviceStateAccounts':len(state.get('accounts',{}))}))
cfg=json.loads(Path('/etc/aicc-ocx-cycle-watch/slack.json').read_text(encoding='utf-8'))
print(json.dumps({'botOwnerUserId':cfg.get('recipientUserId'),
                  'botDmChannelId':cfg.get('dmChannelId'),
                  'botTeamId':cfg.get('teamId')}))
PY
systemctl show aicc-ocx-cycle-watch.service -p Result -p ExecMainStatus -p ExecMainExitTimestamp
'@
  $raw=Invoke-Pinned $read
  [pscustomobject]@{ok=$true;phase='INSPECT';observations=$raw;installedSha256=$installedHash;timer=$timerState} | ConvertTo-Json -Compress
  return
}
if($Mode -eq 'Audit'){
  $auditRoot=Join-Path $env:USERPROFILE '.ai-control-center\backups\slack-menu-audit'
  New-Item -ItemType Directory -Path $auditRoot -Force | Out-Null
  $file=Join-Path $auditRoot ('installed-'+$installedHash+'.py')
  if(-not (Test-Path -LiteralPath $file)){
    $temp=$file+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    & $scp @common ($remote+':'+$target) $temp | Out-Null
    if($LASTEXITCODE -ne 0){throw 'a1_audit_copy_failed'}
    if((Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant() -cne $installedHash){
      throw 'a1_audit_copy_changed'
    }
    Move-Item -LiteralPath $temp -Destination $file
  }
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $installedHash){
    throw 'a1_audit_snapshot_mismatch'
  }
  [pscustomobject]@{ok=$true;phase='READ_ONLY_AUDIT';installedSha256=$installedHash;
    candidateSha256=$sourceSha;sourceFile=$source;readOnlySnapshot=$file;timer=$timerState} | ConvertTo-Json -Compress
  return
}
if($Mode -eq 'Preview'){
  [pscustomobject]@{ok=$true;phase='PREVIEW';installedSha256=$current.installedSha256;
    candidateSha256=$sourceSha;same=($current.installedSha256 -ceq $sourceSha);timer=$current.timer} | ConvertTo-Json -Compress
  return
}
if([string]::IsNullOrWhiteSpace($ExpectedInstalledSha256) -or $current.installedSha256 -cne $ExpectedInstalledSha256){throw 'installed_preimage_changed'}
if($sourceSha -ceq $current.installedSha256){
  [pscustomobject]@{ok=$true;phase='ALREADY_APPLIED';installedSha256=$sourceSha} | ConvertTo-Json -Compress
  return
}
$operation=[guid]::NewGuid().ToString('N')
$stage=$target+'.aicc-stage-'+$operation
& $scp @common $source ($remote+':'+$stage) | Out-Null
if($LASTEXITCODE -ne 0){throw 'a1_stage_failed_check_before_retry'}
$apply=@'
set -eu
umask 077
d=/demo/owner/.local/share/aicc-ocx-cycle-watch/hub_cycle_watch.py
state=/demo/owner/.local/state/aicc-ocx-cycle-watch
stage=__STAGE__
expected=__EXPECTED__
candidate=__CANDIDATE__
operation=__OPERATION__
test "$(id -un)" = ubuntu
test -f "$d" && test ! -L "$d"
test -f "$stage" && test ! -L "$stage"
test "$(sha256sum "$d" | cut -d " " -f 1)" = "$expected"
test "$(sha256sum "$stage" | cut -d " " -f 1)" = "$candidate"
python3 -B - "$stage" <<'PY'
import ast, pathlib, sys
ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
PY
backup="$state/backups/slack-menu-$operation"
install -d -m 0700 "$backup"
cp -p "$d" "$backup/hub_cycle_watch.py"
test "$(sha256sum "$backup/hub_cycle_watch.py" | cut -d " " -f 1)" = "$expected"
chmod 0600 "$stage"
mv -T "$stage" "$d"
test "$(sha256sum "$d" | cut -d " " -f 1)" = "$candidate"
timer=$(systemctl is-active aicc-ocx-cycle-watch.timer)
printf '{"phase":"APPLIED","installedSha256":"%s","previousSha256":"%s","timer":"%s","operation":"%s"}\n' "$candidate" "$expected" "$timer" "$operation"
'@
$apply=$apply.Replace('__STAGE__',$stage).Replace('__EXPECTED__',$ExpectedInstalledSha256).
  Replace('__CANDIDATE__',$sourceSha).Replace('__OPERATION__',$operation)
$receipt=Invoke-Pinned $apply | ConvertFrom-Json
if($receipt.phase -ne 'APPLIED' -or $receipt.installedSha256 -cne $sourceSha -or $receipt.timer -ne 'active'){
  throw 'a1_commit_unconfirmed_check_original_operation'
}
$after=Invoke-Pinned $inspect | ConvertFrom-Json
if((([string]$after.installedSha256).Trim().ToLowerInvariant()) -cne $sourceSha -or (([string]$after.timer).Trim()) -ne 'active'){throw 'a1_readback_mismatch'}
[pscustomobject]@{ok=$true;phase='APPLIED_AND_READBACK';installedSha256=$sourceSha;
  previousSha256=$ExpectedInstalledSha256;timer=$after.timer;operation=$operation;
  backupRetained=$true;serviceRestarted=$false;credentialsChanged=$false} | ConvertTo-Json -Compress

