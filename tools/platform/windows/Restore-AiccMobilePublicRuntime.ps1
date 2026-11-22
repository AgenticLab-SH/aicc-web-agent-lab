#requires -Version 7.5
# Explicit recovery of one existing lifecycle activation. Never stops a process or replays activation.
[CmdletBinding(DefaultParameterSetName='Immediate')]
param(
 [Parameter(Mandatory)][string]$PlanFile,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPlanSha256,
 [Parameter(Mandatory,ParameterSetName='Immediate')][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedActivationReceiptSha256,
 [Parameter(Mandatory,ParameterSetName='Immediate')][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedCurrentTaskXmlSha256,
 [Parameter(Mandatory,ParameterSetName='Immediate')][guid]$RollbackOperationId,
 [Parameter(Mandatory,ParameterSetName='Immediate')][string]$RecoveryReadyFile,
 [Parameter(Mandatory,ParameterSetName='Immediate')][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedRecoveryReadySha256,
 [guid]$CandidateStopOperationId,
 [Parameter(Mandatory,ParameterSetName='Immediate')][switch]$RestoreStoppedService,
 [Parameter(Mandatory,ParameterSetName='Deferred')][switch]$AwaitRecoveryCommit,
 [Parameter(Mandatory,ParameterSetName='Deferred')][string]$RecoveryCommitFile,
 [Parameter(ParameterSetName='Deferred')][ValidateRange(1,1800)][int]$CommitWaitSeconds=600
)
$ErrorActionPreference='Stop'
$deferred=$PSCmdlet.ParameterSetName -ceq 'Deferred'
if(-not $RestoreStoppedService -and -not $AwaitRecoveryCommit){throw 'explicit_stopped_recovery_required'}
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$taskName='AgenticLab-AICC-Mobile-Public-Control'
$utf8=[Text.UTF8Encoding]::new($false)
function Within($root,$file){[IO.Path]::GetFullPath($file).StartsWith([IO.Path]::GetFullPath($root)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)}
function Regular($file){
 $absolute=[IO.Path]::GetFullPath($file)
 if($lockedFiles -and $lockedFiles.ContainsKey($absolute)){return $absolute}
 $full=(Resolve-Path -LiteralPath $file).Path
 for($p=$full;;$p=Split-Path -Parent $p){if($lockedDirectories -and $lockedDirectories.ContainsKey($p)){break};$item=Get-Item -LiteralPath $p -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_recovery_path_preserved'};$parent=Split-Path -Parent $p;if(-not $parent -or $parent -eq $p){break}}
 if((Get-Item -LiteralPath $full).PSIsContainer){throw 'regular_recovery_file_required'}
 return $full
}
function Hash($file){(Get-FileHash -LiteralPath (Regular $file)).Hash.ToLowerInvariant()}
function TextHash($text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($text))).ToLowerInvariant()}
function Json($file){Get-Content -LiteralPath (Regular $file) -Raw|ConvertFrom-Json -AsHashtable}
function WriteNew($file,$value){$stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=$utf8.GetBytes(($value|ConvertTo-Json -Depth 12));$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}}
# Same Windows deny-write/delete semantics as the official installer. Handles live
# until the one-use restore returns. Directory handles prevent ancestor replacement.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AiccMobileRestoreDirectoryLock {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
 public static SafeFileHandle Open(string path) {
  var h=CreateFileW(path,0,3,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
  if(h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  return h;
 }
}
"@
$held=[Collections.Generic.List[IDisposable]]::new();$lockedFiles=@{};$lockedDirectories=@{}
function HoldFile($File){
 $full=Regular $File
 if($lockedFiles.ContainsKey($full)){return $lockedFiles[$full]}
 for($parent=Split-Path -Parent $full;$parent;$parent=Split-Path -Parent $parent){
  if(-not $lockedDirectories.ContainsKey($parent)){$h=[AiccMobileRestoreDirectoryLock]::Open($parent);$held.Add($h);$lockedDirectories[$parent]=$true}
 }
 $stream=[IO.File]::Open($full,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 $held.Add($stream);$null=Regular $full;$lockedFiles[$full]=$stream;return $stream
}
function LockedHash($File){$s=HoldFile $File;$s.Position=0;$h=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($s)).ToLowerInvariant();$s.Position=0;return $h}
try {
$planPath=Regular $PlanFile
if(-not (Within (Join-Path $owner 'backups') $planPath) -or (LockedHash $planPath) -cne $ExpectedPlanSha256){throw 'exact_recovery_plan_required'}
$plan=Json $planPath
if($plan.schemaVersion -ne 1 -or $plan.lifecycleTransition.contractVersion -ne 1 -or $plan.state -cne 'ASSEMBLED_NOT_APPLIED'){throw 'lifecycle_recovery_contract_required'}
$module=Regular (Join-Path $PSScriptRoot 'MobilePublicTransition.psm1')
if((LockedHash $PSCommandPath) -cne $plan.lifecycleTransition.rollbackSha256 -or (LockedHash $module) -cne $plan.lifecycleTransition.moduleSha256){throw 'recovery_executor_pin_required'}
Import-Module $module -Force
$operation=Split-Path -Parent $planPath
# Validate both immutable generations ONCE, while the original service may run.
$previousConfig=Regular $plan.runtimeConfig
$preparedConfig=Regular $plan.preparedConfig
if((LockedHash $previousConfig) -cne $plan.runtimeConfigSha256 -or (LockedHash $preparedConfig) -cne $plan.configSha256){throw 'recovery_configs_changed'}
$previous=Json $previousConfig;$candidate=Json $preparedConfig
if(-not (Within (Join-Path $owner 'control-plane/mobile-public-runtime') $previousConfig) -or -not (Within $operation $preparedConfig) -or $previous.runtimeId -cne $plan.baselineRuntimeId -or $previous.releaseRoot -cne $plan.baseRoot -or $previous.releaseManifestSha256 -cne $plan.baseManifestSha256 -or $candidate.releaseRoot -cne $plan.candidateRoot -or $candidate.releaseManifestSha256 -cne $plan.candidateManifestSha256 -or $previous.port -ne 4383 -or $candidate.port -ne 4383 -or $previous.remoteOrigin -cne $candidate.remoteOrigin -or $previous.nodeExecutable -cne $candidate.nodeExecutable -or $previous.nodeSha256 -cne $candidate.nodeSha256){throw 'recovery_generation_scope_changed'}
$releaseSets=[Collections.Generic.List[object]]::new()
function AssertReleaseEntries($set){
 $actual=[IO.Directory]::GetFiles($set.root,'*',[IO.SearchOption]::AllDirectories)
 if($actual.Count -ne $set.seen.Count+1){throw 'recovery_release_file_set_changed'}
 foreach($f in $actual){if($f -ine $set.manifest -and -not $set.seen.Contains($f)){throw 'recovery_release_file_set_changed'}}
}
function CheckRelease($cfg){
 if(-not (Within (Join-Path $owner 'releases/cli') $cfg.releaseRoot)){throw 'managed_recovery_release_required'}
 $mf=Regular (Join-Path $cfg.releaseRoot '.aicc-release.json')
 if((LockedHash $mf) -cne $cfg.releaseManifestSha256){throw 'recovery_manifest_changed'}
 $m=Json $mf
 if($m.schemaVersion -ne 1 -or $m.component -cne 'mobile-public-control' -or -not $m.files.Count){throw 'recovery_release_manifest_required'}
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($pin in $m.files){$f=[IO.Path]::GetFullPath((Join-Path $cfg.releaseRoot $pin.path));if(-not (Within $cfg.releaseRoot $f) -or -not $seen.Add($f) -or (HoldFile $f).Length -ne $pin.size -or (LockedHash $f) -cne $pin.sha256){throw 'recovery_release_file_changed'}}
 if((LockedHash $cfg.nodeExecutable) -cne $cfg.nodeSha256){throw 'recovery_node_pin_changed'}
 $set=@{root=$cfg.releaseRoot;manifest=$mf;seen=$seen};AssertReleaseEntries $set;$releaseSets.Add($set)
}
$null=HoldFile $planPath;$null=HoldFile $PSCommandPath;$null=HoldFile $module
CheckRelease $previous;CheckRelease $candidate
if($deferred){
 $commitPath=[IO.Path]::GetFullPath($RecoveryCommitFile)
 if(-not (Within $operation $commitPath) -or (Test-Path -LiteralPath $commitPath) -or (Test-Path -LiteralPath (Join-Path $operation 'activation-attempt.json'))){throw 'fresh_recovery_prepare_required'}
 $self=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID) -ErrorAction Stop
 $preflight=Join-Path $operation 'recovery-preflight.json'
 WriteNew $preflight @{schemaVersion=1;state='RELEASES_LOCKED_WAITING_FOR_FRESH_RECOVERY';operationId=$plan.operationId;planSha256=$ExpectedPlanSha256;restorePid=$PID;restoreCreatedAt=$self.CreationDate.ToUniversalTime().ToString('o');restoreCommandSha256=TextHash $self.CommandLine;restoreExecutable=$self.ExecutablePath;previousConfigSha256=$plan.runtimeConfigSha256;candidateManifestSha256=$plan.candidateManifestSha256;verifiedFiles=($releaseSets|ForEach-Object {$_.seen.Count}|Measure-Object -Sum).Sum;observedAt=[DateTimeOffset]::UtcNow.ToString('o');commitFile=$commitPath;runtimeChanged=$false}
 $null=HoldFile $preflight
 $deadline=[DateTimeOffset]::UtcNow.AddSeconds($CommitWaitSeconds)
 while(-not (Test-Path -LiteralPath $commitPath)){if([DateTimeOffset]::UtcNow -ge $deadline){throw 'fresh_recovery_commit_timeout'};Start-Sleep -Milliseconds 100}
 $null=HoldFile $commitPath;$commit=Json $commitPath
 if(@($commit.Keys|Where-Object {$_ -notin @('schemaVersion','action','operationId','planSha256','preflightSha256','activationReceiptSha256','taskXmlSha256','rollbackOperationId','candidateStopOperationId','readyFile','readySha256')}).Count -or $commit.schemaVersion -ne 1 -or $commit.action -cne 'restore-exact-stopped-lifecycle' -or $commit.operationId -cne $plan.operationId -or $commit.planSha256 -cne $ExpectedPlanSha256 -or $commit.preflightSha256 -cne (LockedHash $preflight)){throw 'exact_fresh_recovery_commit_required'}
 $ExpectedActivationReceiptSha256=$commit.activationReceiptSha256;$ExpectedCurrentTaskXmlSha256=$commit.taskXmlSha256;$RollbackOperationId=[guid]$commit.rollbackOperationId
 if($commit.candidateStopOperationId){$CandidateStopOperationId=[guid]$commit.candidateStopOperationId}
 $RecoveryReadyFile=$commit.readyFile;$ExpectedRecoveryReadySha256=$commit.readySha256
}
$activationFile=Regular (Join-Path $operation 'activation-attempt.json')
if((Hash $activationFile) -cne $ExpectedActivationReceiptSha256){throw 'activation_receipt_changed'}
$activation=Json $activationFile
if($activation.schemaVersion -ne 1 -or $activation.operationId -cne $plan.operationId -or $activation.mode -cne 'NORMALLY_STOPPED_LIFECYCLE_TRANSITION' -or $activation.planSha256 -cne $ExpectedPlanSha256 -or $activation.startAttempted -isnot [bool] -or $activation.startAccepted -isnot [bool] -or ($activation.startAccepted -and -not $activation.startAttempted) -or $activation.automaticReplay -ne $false){throw 'exact_activation_receipt_required'}
if($activation.phase -notin @('HOLD_NO_AUTOMATIC_REPLAY','TASK_START_ACCEPTED_FUNCTION_UNOBSERVED')){throw 'activation_outcome_not_settled_for_recovery'}
$beforeFile=Regular (Join-Path $operation 'public-task.before.xml')
$desiredFile=Regular (Join-Path $operation 'public-task.activation.xml')
if((Hash $beforeFile) -cne $activation.rollbackTaskXmlSha256 -or (Hash $desiredFile) -cne $activation.desiredTaskXmlSha256 -or $activation.previousTaskXmlSha256 -cne $activation.rollbackTaskXmlSha256){throw 'recovery_task_preimages_changed'}
$beforeXml=[IO.File]::ReadAllText($beforeFile);$desiredXml=[IO.File]::ReadAllText($desiredFile)
if($ExpectedCurrentTaskXmlSha256 -cne $activation.desiredTaskXmlSha256 -and $ExpectedCurrentTaskXmlSha256 -cne $activation.previousTaskXmlSha256){throw 'unrelated_current_task_preserved'}
$previousConfig=Regular $plan.runtimeConfig
$candidateConfig=Regular $plan.futureConfigPath
if(-not (Within (Join-Path $owner 'control-plane/mobile-public-runtime') $previousConfig) -or -not (Within (Join-Path $owner 'control-plane/mobile-public-runtime') $candidateConfig) -or (Hash $previousConfig) -cne $plan.runtimeConfigSha256 -or (Hash $candidateConfig) -cne $plan.configSha256){throw 'recovery_configs_changed'}
$previous=Json $previousConfig;$candidate=Json $candidateConfig
if($previous.runtimeId -cne $plan.baselineRuntimeId -or $previous.releaseRoot -cne $plan.baseRoot -or $previous.releaseManifestSha256 -cne $plan.baseManifestSha256 -or $candidate.releaseRoot -cne $plan.candidateRoot -or $candidate.releaseManifestSha256 -cne $plan.candidateManifestSha256 -or $previous.port -ne 4383 -or $candidate.port -ne 4383 -or $previous.remoteOrigin -cne $candidate.remoteOrigin -or $previous.nodeExecutable -cne $candidate.nodeExecutable -or $previous.nodeSha256 -cne $candidate.nodeSha256){throw 'recovery_generation_scope_changed'}
$readyPath=Regular $RecoveryReadyFile
if(-not (Within (Join-Path $owner 'backups') $readyPath) -or (Hash $readyPath) -cne $ExpectedRecoveryReadySha256){throw 'exact_recovery_ready_pin_required'}
$ready=Json $readyPath
$toolFile=Regular $ready.toolReceiptFile
if(-not (Within (Join-Path $owner 'backups') $toolFile) -or (Hash $toolFile) -cne $ready.toolReceiptSha256){throw 'recovery_tool_receipt_pin_required'}
$tool=Json $toolFile
foreach($key in @('schemaVersion','status','independent','operationId','planSha256','taskXmlSha256','previousConfigSha256','stopOperationId','target','recoveryAction','executorId','observedAt','expiresAt','rollbackOperationId','activationReceiptSha256')){if($ready[$key] -cne $tool[$key]){throw 'recovery_tool_readback_mismatch'}}
$rollbackFile=Join-Path $operation 'rollback-attempt.json'
if(Test-Path -LiteralPath $rollbackFile){throw 'rollback_attempt_exists_do_not_replay'}
function AssertFreshRollbackReady($Ready,$Expected,[DateTimeOffset]$Now=[DateTimeOffset]::UtcNow){
 $observed=[DateTimeOffset]::MinValue;$expires=[DateTimeOffset]::MinValue
 if($Ready.schemaVersion -ne 1 -or $Ready.status -cne 'READY' -or $Ready.independent -ne $true -or $Ready.operationId -cne $Expected.operationId -or $Ready.planSha256 -cne $Expected.planSha256 -or $Ready.taskXmlSha256 -cne $Expected.taskXmlSha256 -or $Ready.rollbackOperationId -cne $Expected.rollbackOperationId -or $Ready.activationReceiptSha256 -cne $Expected.activationReceiptSha256 -or $Ready.target -cne 'AgenticLab-AICC-Mobile-Public-Control' -or $Ready.recoveryAction -cne 'restore-exact-task-after-normal-stop' -or [string]::IsNullOrWhiteSpace($Ready.executorId) -or -not [DateTimeOffset]::TryParse([string]$Ready.observedAt,[ref]$observed) -or $observed -gt $Now -or $observed -lt $Now.AddSeconds(-120) -or -not [DateTimeOffset]::TryParse([string]$Ready.expiresAt,[ref]$expires) -or $expires -le $Now -or $expires -gt $Now.AddMinutes(5)){throw 'fresh_rollback_recovery_ready_required'}
}
function CheckStopped([string]$RequiredTaskHash=$ExpectedCurrentTaskXmlSha256) {
 if((Hash $planPath) -cne $ExpectedPlanSha256 -or (Hash $activationFile) -cne $ExpectedActivationReceiptSha256 -or (Hash $previousConfig) -cne $plan.runtimeConfigSha256 -or (Hash $candidateConfig) -cne $plan.configSha256 -or (Hash $beforeFile) -cne $activation.rollbackTaskXmlSha256 -or (Hash $desiredFile) -cne $activation.desiredTaskXmlSha256 -or (Hash $readyPath) -cne $ExpectedRecoveryReadySha256 -or (Hash $toolFile) -cne $ready.toolReceiptSha256){throw 'recovery_inputs_changed'}
 foreach($set in $releaseSets){AssertReleaseEntries $set}
 $task=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
 $xml=Export-ScheduledTask -InputObject $task -ErrorAction Stop
 if([string]$task.State -cne 'Ready' -or (TextHash $xml) -cne $RequiredTaskHash){throw 'recovery_task_cas_failed'}
 $scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect()
 if($scheduler.GetFolder('\').GetTask($taskName).GetInstances(0).Count -ne 0){throw 'recovery_task_instances_preserved'}
 if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -EQ 4383).Count){throw 'recovery_listener_preserved'}
 $processes=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'pwsh.exe' OR Name = 'powershell.exe' OR Name = 'wscript.exe' OR Name = 'cscript.exe'" -ErrorAction Stop)
 foreach($p in $processes){if($p.ProcessId -eq $PID){continue};if(-not $p.CommandLine){throw 'recovery_process_ownership_unknown'};if($p.CommandLine.Contains('mobile-public-runner.mjs',[StringComparison]::OrdinalIgnoreCase) -or $p.CommandLine.Contains('Start-AiccMobilePublicRuntime.ps1',[StringComparison]::OrdinalIgnoreCase) -or $p.CommandLine.Contains($previousConfig,[StringComparison]::OrdinalIgnoreCase) -or $p.CommandLine.Contains($candidateConfig,[StringComparison]::OrdinalIgnoreCase)){throw 'recovery_runner_or_parent_preserved'}}
 AssertFreshRollbackReady $ready @{operationId=$plan.operationId;planSha256=$ExpectedPlanSha256;taskXmlSha256=$ExpectedCurrentTaskXmlSha256;rollbackOperationId=$RollbackOperationId.ToString();activationReceiptSha256=$ExpectedActivationReceiptSha256}
 $journal=Join-Path $owner 'status-tray/requests'
 if(-not (Test-Path -LiteralPath $journal -PathType Container)){throw 'recovery_journal_inventory_unknown'}
 $null=Regular (Join-Path $owner 'control-plane/mobile-control.json')
 foreach($item in @(Get-ChildItem -LiteralPath $journal -File -ErrorAction Stop|Where-Object Name -Match '^mobile-[a-f0-9]{32}\.json$')){if((Json $item.FullName).state -cne 'COMPLETED'){throw 'recovery_mobile_outcome_unresolved'}}
 if($activation.startAttempted){
  if(-not $CandidateStopOperationId -or $CandidateStopOperationId -eq [guid]::Empty){throw 'candidate_normal_stop_required_for_attempted_start'}
  if(-not (Test-Path -LiteralPath $candidate.statusFile -PathType Leaf)){throw 'candidate_normal_stop_status_required'}
  $statusPath=Regular $candidate.statusFile
  if(-not (Within (Join-Path $owner 'runtime/mobile-public-control') $statusPath)){throw 'owned_candidate_status_required'}
  $status=Json $statusPath
  if(($status.pid -isnot [int] -and $status.pid -isnot [long]) -or $status.pid -le 0){throw 'candidate_normal_stop_pid_required'}
  $running=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[long]$status.pid) -ErrorAction Stop)
  $stopRoot=Join-Path (Split-Path -Parent $candidateConfig) ('stop-requests/'+$CandidateStopOperationId.ToString())
  $request=Regular (Join-Path $stopRoot 'request.json');$claim=Regular (Join-Path $stopRoot 'claim.json')
  $reverse=$plan.Clone();$reverse.baselineRuntimeId=$candidate.runtimeId;$reverse.baseRoot=$candidate.releaseRoot;$reverse.baseManifestSha256=$candidate.releaseManifestSha256;$reverse.runtimeConfigSha256=$plan.configSha256;$reverse.candidateRoot=$previous.releaseRoot;$reverse.candidateManifestSha256=$previous.releaseManifestSha256
  $null=Assert-AiccMobileLifecycleTransition -Plan $reverse -PlanSha256 $ExpectedPlanSha256 -Previous $candidate -Candidate $previous -Status $status -Request (Json $request) -RequestSha256 (Hash $request) -Claim (Json $claim) -StopOperationId $CandidateStopOperationId.ToString() -RecoveryReady $ready -TaskXmlSha256 $ExpectedCurrentTaskXmlSha256 -PreviousProcessPresent ($running.Count -ne 0)
 }else{
  if($ready.stopOperationId -cne 'NOT_STARTED' -or $ready.previousConfigSha256 -cne $plan.runtimeConfigSha256){throw 'never_started_recovery_binding_required'}
  if(Test-Path -LiteralPath $candidate.statusFile){throw 'candidate_status_present_requires_reconciliation'}
 }
 # Restore only the exact old launcher encoded by the original task; no arbitrary shell action.
 $doc=[xml]::new();$doc.XmlResolver=$null;$doc.LoadXml($beforeXml)
 $ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('t',$doc.DocumentElement.NamespaceURI)
 $exec=@($doc.SelectNodes('/t:Task/t:Actions/t:Exec',$ns))
 $wscript=Regular (Join-Path ([Environment]::GetFolderPath('Windows')) 'System32/wscript.exe')
 if($exec.Count -ne 1 -or $exec[0].SelectSingleNode('t:Command',$ns).InnerText -ine $wscript){throw 'exact_original_task_action_required'}
 $match=[regex]::Match($exec[0].SelectSingleNode('t:Arguments',$ns).InnerText,'^/b /nologo "(?<path>[^"\r\n]+\.vbs)"$')
 if(-not $match.Success){throw 'exact_original_task_action_required'}
 $oldLauncher=Regular $match.Groups['path'].Value
 if(-not (Within (Join-Path $owner 'backups') $oldLauncher) -or (Hash $oldLauncher) -cne $activation.previousLauncherSha256){throw 'original_launcher_changed'}
 return @{currentTaskXmlSha256=(TextHash $xml);candidateStartAttempted=$activation.startAttempted;candidateStopOperationId=if($activation.startAttempted){$CandidateStopOperationId.ToString()}else{'NOT_STARTED'};normalStopOrNeverStarted=$true;idleScope='mobile lifecycle/journal only';automaticReplay=$false}
}
$lock=[IO.File]::Open((Join-Path $owner 'control-plane/mobile-public-runtime/activation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$receipt=@{schemaVersion=1;operationId=$plan.operationId;rollbackOperationId=$RollbackOperationId.ToString();activationReceiptSha256=$ExpectedActivationReceiptSha256;phase='PRECONDITIONS';taskRestoreAttempted=$false;taskRestored=$false;startAttempted=$false;startAccepted=$false;automaticReplay=$false;functionalVerification='NOT_RUN';deviceTrustModified=$false}
$claimed=$false
function Record {$temp=$rollbackFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp';WriteNew $temp $receipt;[IO.File]::Move($temp,$rollbackFile,$true)}
try{
 if(Test-Path -LiteralPath $rollbackFile){throw 'rollback_attempt_exists_do_not_replay'}
 $receipt.evidence=CheckStopped
 $receipt.phase='CLAIMED_NO_RUNTIME_CHANGE';WriteNew $rollbackFile $receipt;$claimed=$true
 $null=CheckStopped
 if($ExpectedCurrentTaskXmlSha256 -cne $activation.previousTaskXmlSha256){
  $receipt.phase='TASK_RESTORE_ATTEMPTED_OUTCOME_UNKNOWN';$receipt.taskRestoreAttempted=$true;Record
  $null=Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $beforeXml -Force -ErrorAction Stop
 }
 $readback=Export-ScheduledTask -InputObject (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop) -ErrorAction Stop
 if((TextHash $readback) -cne $activation.previousTaskXmlSha256){throw 'restored_task_readback_mismatch_no_start'}
 $receipt.taskRestored=$true;$receipt.phase='TASK_RESTORED_NOT_STARTED';Record
 # Recheck all gates against the restored exact task before the single start.
 $null=CheckStopped $activation.previousTaskXmlSha256
 $receipt.phase='RESTORED_START_ATTEMPTED_OUTCOME_UNKNOWN';$receipt.startAttempted=$true;Record
 Start-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
 $receipt.startAccepted=$true;$receipt.phase='RESTORED_START_ACCEPTED_FUNCTION_UNOBSERVED';Record
 @{status=$receipt.phase;startAccepted=$true;functionalVerification='NOT_RUN';automaticReplay=$false}|ConvertTo-Json -Compress
}catch{
 $receipt.failureStage=$receipt.phase;$receipt.phase='HOLD_ROLLBACK_NO_AUTOMATIC_REPLAY'
 $message=$_.Exception.Message;$receipt.reason=if($message -cmatch '^[a-z][a-z0-9_]+$'){$message}else{'recovery_failed_details_not_logged'}
 if($claimed){Record}
 @{status=$receipt.phase;reason=$receipt.reason;startAttempted=$receipt.startAttempted;startAccepted=$receipt.startAccepted;automaticReplay=$false}|ConvertTo-Json -Compress
 exit 1
}finally{$lock.Dispose()}
}finally{foreach($h in $held){$h.Dispose()}}
