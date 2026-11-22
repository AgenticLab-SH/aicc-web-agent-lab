#requires -Version 7.5
[CmdletBinding()]
param(
 [ValidateSet('Status','Watch')][string]$Mode='Status',
 [switch]$MobilePublicRecovery,
 [string]$RequestFile,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedRequestSha256,
 [string]$PlanFile,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPlanSha256,
 [string]$Updater,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedUpdaterSha256,
 [Alias('ExpectedIndependentHostPid')][int]$ExpectedRdcHostPid,
 [Alias('ExpectedIndependentHostCreatedTicks')][string]$ExpectedRdcHostCreatedTicks,
 [Alias('ExpectedIndependentHostCommandSha256')][string]$ExpectedRdcHostCommandSha256
)
$ErrorActionPreference='Stop'
if($MobilePublicRecovery){
 Import-Module (Join-Path $PSScriptRoot '../windows/MobilePublicRecovery.psm1') -Force
 Invoke-AiccMobileRecoveryWorker -RequestFile $RequestFile -ExpectedRequestSha256 $ExpectedRequestSha256 -StatusOnly:($Mode -eq 'Status')
 return
}
if(-not $PlanFile -or -not $ExpectedPlanSha256 -or -not $Updater -or -not $ExpectedUpdaterSha256){throw 'Exact host-runtime recovery inputs required'}
function Get-RecoveryFileDigest([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function Read-RecoveryObject([string]$p){Get-Content -LiteralPath $p -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function Write-RecoveryRecord([string]$p,$v){$s=[IO.File]::Open($p,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$b=[Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 12 -Compress));$s.Write($b);$s.Flush($true)}finally{$s.Dispose()}}
function CmdHash([string]$v){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($v))).ToLowerInvariant()}
$PlanFile=(Resolve-Path -LiteralPath $PlanFile).Path
$Updater=(Resolve-Path -LiteralPath $Updater).Path
$directory=Split-Path $PlanFile -Parent
$allowed=(Join-Path $env:USERPROFILE '.ai-control-center\asset-control').TrimEnd('\')+'\'
if(-not $directory.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Exact registered owner operation required'}
foreach($p in @($PlanFile,$Updater)){if((Get-Item -LiteralPath $p).LinkType){throw 'Linked recovery input refused'}}
if((Get-RecoveryFileDigest $PlanFile) -cne $ExpectedPlanSha256 -or (Get-RecoveryFileDigest $Updater) -cne $ExpectedUpdaterSha256){throw 'Recovery input pin changed'}
$plan=Read-RecoveryObject $PlanFile
if($plan.changeKind -cnotin @('host-runtime-update','workspace-broker-security-update','workspace-runtime-cold-recovery','workspace-patch-parent-update','workspace-owner-environment-update','workspace-store-checkpoint-update','workspace-process-lifecycle-update','workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement') -or $plan.scriptSha256 -cne $ExpectedUpdaterSha256 -or $plan.rollback_ref -cne $directory){throw 'Exact supported runtime recovery scope required'}
if($Mode -eq 'Status'){@{state='READ_ONLY';request_id=$plan.request_id;readyExists=(Test-Path -LiteralPath (Join-Path $directory 'independent-ready.json'))}|ConvertTo-Json -Compress;exit}
$expiry=[DateTimeOffset]::Parse($plan.expires_at)
if($expiry -le [DateTimeOffset]::UtcNow -or $expiry -gt [DateTimeOffset]::UtcNow.AddMinutes(30)){throw 'Bounded current recovery expiry required'}
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
$self=$p;$found=$false
for($i=0;$p -and $i -lt 16;$i++){
 if([int]$p.ProcessId -in @($plan.ownership.processes|ForEach-Object {[int]$_.pid})){throw 'Recovery depends on the replacement runtime'}
 if([int]$p.ProcessId -eq $ExpectedRdcHostPid){
  if($p.CreationDate.ToUniversalTime().Ticks.ToString() -cne $ExpectedRdcHostCreatedTicks -or (CmdHash ([string]$p.CommandLine)) -cne $ExpectedRdcHostCommandSha256){throw 'Registered independent host generation changed'}
  $found=$true;break
 }
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId)
}
if(-not $found){throw 'Exact pinned independent host ancestry required'}
$ready=@{status='READY';independent=$true;owner_task_id=$plan.owner_task_id;request_id=$plan.request_id;challenge=$plan.challenge;target=$plan.target;rollback_ref=$plan.rollback_ref;allowed_recovery=$plan.allowed_recovery;expires_at=$plan.expires_at;plan_sha256=$ExpectedPlanSha256;script_sha256=$ExpectedUpdaterSha256;accepted_at=[DateTimeOffset]::UtcNow.ToString('o');workerPid=$PID;workerCreatedTicks=$self.CreationDate.ToUniversalTime().Ticks.ToString();rdcHostPid=$ExpectedRdcHostPid;independentHostPid=$ExpectedRdcHostPid;execution_path='Exact pinned independent local process, no model route'}
Write-RecoveryRecord (Join-Path $directory 'independent-ready.json') $ready
@{state='READY';request_id=$plan.request_id;workerPid=$PID;expires_at=$plan.expires_at}|ConvertTo-Json -Compress
$signalFile=Join-Path $directory 'recovery-signal.json'
$doneFile=Join-Path $directory 'completion.json'
$recover=$false
while([DateTimeOffset]::UtcNow -lt $expiry){
 if(Test-Path -LiteralPath $doneFile){
  $done=Read-RecoveryObject $doneFile
  if($done.request_id -cne $plan.request_id -or $done.challenge -cne $plan.challenge -or $done.plan_sha256 -cne $ExpectedPlanSha256){throw 'Completion does not match this operation'}
  $journal=Read-RecoveryObject (Join-Path $directory 'journal.json')
  if($done.state -cne 'APPLY_COMMAND_RETURNED' -or $journal.phase -cne 'START_ACCEPTED'){throw 'Installer completion is not established'}
  Write-RecoveryRecord (Join-Path $directory 'independent-closed.json') @{state='CLOSED_AFTER_INSTALLER_RETURN';request_id=$plan.request_id;verification='NOT_RUN'}
  exit
 }
 if(Test-Path -LiteralPath $signalFile){
  $signal=Read-RecoveryObject $signalFile
  if($signal.request_id -cne $plan.request_id -or $signal.challenge -cne $plan.challenge -or $signal.plan_sha256 -cne $ExpectedPlanSha256 -or $signal.action -cne 'rollback'){throw 'Recovery signal does not match scope'}
  $recover=$true;break
 }
 Start-Sleep -Seconds 2
}
if(-not $recover){
 $journal=Read-RecoveryObject (Join-Path $directory 'journal.json')
 if($journal.phase -in @('PREPARED','START_ACCEPTED','ROLLED_BACK_START_ACCEPTED')){
  Write-RecoveryRecord (Join-Path $directory 'independent-closed.json') @{state='EXPIRED_NO_RECOVERY_DISPATCH';request_id=$plan.request_id;installerPhase=$journal.phase}
  exit
 }
 $recover=$true
}
if($recover){
 Write-RecoveryRecord (Join-Path $directory 'independent-rollback.claim.json') @{request_id=$plan.request_id;challenge=$plan.challenge;plan_sha256=$ExpectedPlanSha256;at=[DateTimeOffset]::UtcNow.ToString('o')}
 & $Updater -Mode Rollback -OperationDirectory $directory -ExpectedPlanSha256 $ExpectedPlanSha256
 if($LASTEXITCODE -ne 0){throw 'Rollback command did not complete; preserve original operation'}
}
