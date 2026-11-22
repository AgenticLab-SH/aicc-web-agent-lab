#requires -Version 7.5
[CmdletBinding()]
param([string]$ThreadId,[int]$InitialOwnerPid=0,[string[]]$ExcludedThreadIds=@(),[switch]$Upgrade,
 [switch]$UpdateCodexPin,[switch]$ApplyCodexPin,[switch]$PrepareMaintenanceUpgrade,[switch]$ApplyMaintenanceUpgrade,[switch]$InspectMaintenanceUpgrade,[switch]$RollbackMaintenanceUpgrade,[switch]$InspectGeneralCliContinuity,[switch]$PreviewGroupOwner,[switch]$ApplyGroupOwner,[switch]$RollbackGroupOwner,
 [switch]$InspectGroupActivation,[switch]$PreviewGroupActivation,[switch]$ApplyGroupActivation,[switch]$RollbackGroupActivation,[string]$GroupInstallPlanFile,
 [string]$NodePath,[string]$PlanFile,[string]$ExpectedPlanSha256,[string]$ExpectedReceiptSha256,[string]$QuotaDeadlineUtc,[string]$Confirm,
 [string]$TargetRoot,[string]$OwnerRevision,[long]$StopEpoch,[string]$WorkerOperationId,[string]$RecoveredCliEvidenceFile,
 [string]$OldRelease,[string]$NewRelease,[string]$ExpectedOldSha256,[string]$ExpectedNewSha256,[string]$ExpectedSignerThumbprint,[string]$ExpectedOldSignerThumbprint,[string]$ExpectedNewSignerThumbprint)
$ErrorActionPreference='Stop'
# Ordinary general CLI route is separate from the strict OCX10100 launcher.
# No model send, queue claim, account2 binding or owner transfer is supported.
if($InspectGeneralCliContinuity){
 if(-not $ThreadId -or $Upgrade -or
    $UpdateCodexPin -or $ApplyCodexPin -or
    $PrepareMaintenanceUpgrade -or $ApplyMaintenanceUpgrade -or
    $InspectMaintenanceUpgrade -or $RollbackMaintenanceUpgrade -or
    $PreviewGroupOwner -or $ApplyGroupOwner -or $RollbackGroupOwner -or
    $InspectGroupActivation -or $PreviewGroupActivation -or
    $ApplyGroupActivation -or $RollbackGroupActivation -or
    $InitialOwnerPid -or $ExcludedThreadIds.Count -or
    $NodePath -or $PlanFile -or $ExpectedPlanSha256 -or $ExpectedReceiptSha256 -or $Confirm -or
    $TargetRoot -or $OwnerRevision -or $StopEpoch -or $WorkerOperationId -or
    $RecoveredCliEvidenceFile -or $GroupInstallPlanFile -or
    $OldRelease -or $NewRelease -or $ExpectedOldSha256 -or $ExpectedNewSha256 -or
    $ExpectedSignerThumbprint -or $ExpectedOldSignerThumbprint -or $ExpectedNewSignerThumbprint){
  throw 'general_cli_inspect_exact_readonly_action_required'
 }
 $ownerLocal=[Environment]::GetFolderPath('UserProfile')
 $state=Join-Path $ownerLocal '.ai-control-center/control-plane/codex-continuity'
 Import-Module (Join-Path $PSScriptRoot 'CodexContinuityMaintenance.psm1') -Force
 Get-AiccGeneralCliContinuityStatus -StateRoot $state -ThreadId $ThreadId -DeadlineUtc $QuotaDeadlineUtc|ConvertTo-Json -Depth 8
 return
}
if($QuotaDeadlineUtc){throw 'general_cli_deadline_requires_readonly_inspect'}
# Exact read-only reconciliation or stopped rollback only. Never restart a worker.
if($InspectMaintenanceUpgrade -or $RollbackMaintenanceUpgrade){
 if(([int]$InspectMaintenanceUpgrade.IsPresent+[int]$RollbackMaintenanceUpgrade.IsPresent) -ne 1 -or
    $Upgrade -or $UpdateCodexPin -or $ApplyCodexPin -or $PrepareMaintenanceUpgrade -or $ApplyMaintenanceUpgrade -or
    $PreviewGroupOwner -or $ApplyGroupOwner -or $RollbackGroupOwner -or
    $InspectGroupActivation -or $PreviewGroupActivation -or $ApplyGroupActivation -or $RollbackGroupActivation -or
    $ThreadId -or $InitialOwnerPid -or $ExcludedThreadIds.Count -or $NodePath -or $GroupInstallPlanFile -or
    $TargetRoot -or $OwnerRevision -or $StopEpoch -or $WorkerOperationId -or $RecoveredCliEvidenceFile -or
    $OldRelease -or $NewRelease -or $ExpectedOldSha256 -or $ExpectedNewSha256 -or
    $ExpectedSignerThumbprint -or $ExpectedOldSignerThumbprint -or $ExpectedNewSignerThumbprint){
  throw 'maintenance_inspect_rollback_separate_exact_action_required'
 }
 if(-not $PlanFile){throw 'maintenance_exact_plan_required'}
 $ownerHome=[Environment]::GetFolderPath('UserProfile')
 $state=Join-Path $ownerHome '.ai-control-center/control-plane/codex-continuity'
 $plan=Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8|ConvertFrom-Json -AsHashtable -DateKind String
 if([IO.Path]::GetFullPath([string]$plan.stateRoot) -ine [IO.Path]::GetFullPath($state)){
  throw 'owner_local_maintenance_required'
 }
 Import-Module (Join-Path $PSScriptRoot 'CodexContinuityMaintenance.psm1') -Force
 if($InspectMaintenanceUpgrade){
  if($ExpectedPlanSha256 -or $ExpectedReceiptSha256 -or $Confirm){throw 'maintenance_inspect_readonly_only'}
  Get-AiccContinuityMaintenanceStatus -PlanFile $PlanFile|ConvertTo-Json -Depth 10
 }else{
  if(-not $ExpectedPlanSha256 -or -not $ExpectedReceiptSha256 -or -not $Confirm){
   throw 'maintenance_exact_rollback_confirmation_required'
  }
  Undo-AiccContinuityMaintenancePlan -PlanFile $PlanFile -ExpectedPlanSha256 $ExpectedPlanSha256 -ExpectedReceiptSha256 $ExpectedReceiptSha256 -Confirm $Confirm|ConvertTo-Json -Depth 12
 }
 return
}
if($ExpectedReceiptSha256){throw 'maintenance_rollback_separate_exact_action_required'}
if($InspectGroupActivation -or $PreviewGroupActivation -or $ApplyGroupActivation -or $RollbackGroupActivation){
 if(([int]$InspectGroupActivation.IsPresent+[int]$PreviewGroupActivation.IsPresent+[int]$ApplyGroupActivation.IsPresent+[int]$RollbackGroupActivation.IsPresent) -ne 1 -or
    $Upgrade -or $PrepareMaintenanceUpgrade -or $ApplyMaintenanceUpgrade -or $UpdateCodexPin -or $ApplyCodexPin -or
    $PreviewGroupOwner -or $ApplyGroupOwner -or $RollbackGroupOwner -or $ThreadId -or $TargetRoot -or $OwnerRevision -or
    $StopEpoch -or $WorkerOperationId -or $RecoveredCliEvidenceFile -or $NodePath -or $InitialOwnerPid -or $ExcludedThreadIds.Count -or
    $OldRelease -or $NewRelease -or $ExpectedOldSha256 -or $ExpectedNewSha256 -or $ExpectedSignerThumbprint -or
    $ExpectedOldSignerThumbprint -or $ExpectedNewSignerThumbprint){throw 'group_activation_separate_exact_action_required'}
 Import-Module (Join-Path $PSScriptRoot 'CodexContinuityMaintenance.psm1') -Force
 if($InspectGroupActivation){if(-not $GroupInstallPlanFile -or $PlanFile -or $ExpectedPlanSha256 -or $Confirm){throw 'activation_inspect_install_plan_only'};Get-AiccGroupActivationStatus -InstalledPlanFile $GroupInstallPlanFile|ConvertTo-Json -Depth 10}
 elseif($PreviewGroupActivation){if(-not $GroupInstallPlanFile -or -not $PlanFile -or $ExpectedPlanSha256 -or $Confirm){throw 'activation_preview_exact_plans_required'};New-AiccGroupActivationPlan -InstalledPlanFile $GroupInstallPlanFile -PlanFile $PlanFile|ConvertTo-Json -Depth 10}
 elseif($ApplyGroupActivation){if($GroupInstallPlanFile -or -not $PlanFile -or -not $ExpectedPlanSha256 -or -not $Confirm){throw 'activation_apply_exact_confirmation_required'};Invoke-AiccGroupActivationPlan -PlanFile $PlanFile -ExpectedPlanSha256 $ExpectedPlanSha256 -Confirm $Confirm|ConvertTo-Json -Depth 10}
 else{if($GroupInstallPlanFile -or -not $PlanFile -or $ExpectedPlanSha256 -or -not $Confirm){throw 'activation_rollback_exact_confirmation_required'};Undo-AiccGroupActivationPlan -PlanFile $PlanFile -Confirm $Confirm|ConvertTo-Json -Depth 10}
 return
}
if($GroupInstallPlanFile){throw 'activation_install_plan_requires_explicit_action'}
if($PreviewGroupOwner -or $ApplyGroupOwner -or $RollbackGroupOwner){
 if(([int]$PreviewGroupOwner.IsPresent+[int]$ApplyGroupOwner.IsPresent+[int]$RollbackGroupOwner.IsPresent) -ne 1 -or
    $Upgrade -or $PrepareMaintenanceUpgrade -or $ApplyMaintenanceUpgrade -or $UpdateCodexPin -or $ApplyCodexPin -or
    $InitialOwnerPid -or $ExcludedThreadIds.Count -or $OldRelease -or $NewRelease -or
    ($RecoveredCliEvidenceFile -and -not $PreviewGroupOwner)){throw 'group_owner_installer_separate_exact_action_required'}
 $ownerHome=[Environment]::GetFolderPath('UserProfile')
 $state=Join-Path $ownerHome '.ai-control-center/control-plane/codex-continuity'
 Import-Module (Join-Path $PSScriptRoot 'CodexContinuityMaintenance.psm1') -Force
 if($PreviewGroupOwner){
  New-AiccGroupOwnerInstallPlan -StateRoot $state -SourceRoot ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))) -NodePath $NodePath -PlanFile $PlanFile -ThreadId $ThreadId -TargetRoot $TargetRoot -OwnerRevision $OwnerRevision -StopEpoch $StopEpoch -WorkerOperationId $WorkerOperationId -RecoveredCliEvidenceFile $RecoveredCliEvidenceFile|ConvertTo-Json -Depth 12
 }elseif($ApplyGroupOwner){
  Invoke-AiccGroupOwnerInstallPlan -PlanFile $PlanFile -ExpectedPlanSha256 $ExpectedPlanSha256 -Confirm $Confirm|ConvertTo-Json -Depth 12
 }else{
  Undo-AiccGroupOwnerInstallPlan -PlanFile $PlanFile -Confirm $Confirm|ConvertTo-Json -Depth 12
 }
 return
}
if($RecoveredCliEvidenceFile){throw 'recovered_cli_proof_only_for_explicit_group_preview'}
if($PrepareMaintenanceUpgrade -or $ApplyMaintenanceUpgrade){
 if($PrepareMaintenanceUpgrade -and $ApplyMaintenanceUpgrade -or $Upgrade -or $UpdateCodexPin -or $ApplyCodexPin -or $ThreadId -or $InitialOwnerPid -or $ExcludedThreadIds.Count){throw 'maintenance_upgrade_is_separate_action'}
 $ownerHome=[Environment]::GetFolderPath('UserProfile');$state=Join-Path $ownerHome '.ai-control-center/control-plane/codex-continuity'
 Import-Module (Join-Path $PSScriptRoot 'CodexContinuityMaintenance.psm1') -Force
 if($PrepareMaintenanceUpgrade){New-AiccContinuityMaintenancePlan -StateRoot $state -SourceRoot ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))) -NodePath $NodePath -PlanFile $PlanFile|ConvertTo-Json -Depth 15}
 else{
  $p=Get-Content -LiteralPath $PlanFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  if([IO.Path]::GetFullPath($p.stateRoot) -ine [IO.Path]::GetFullPath($state)){throw 'owner_local_maintenance_required'}
  Invoke-AiccContinuityMaintenancePlan -PlanFile $PlanFile -ExpectedPlanSha256 $ExpectedPlanSha256 -Confirm $Confirm|ConvertTo-Json -Depth 15
 };return
}
if($UpdateCodexPin){
 if($Upgrade -or $ThreadId -or $InitialOwnerPid -or $ExcludedThreadIds.Count){throw 'cli_pin_action_is_separate_from_install_upgrade'}
 $ownerHome=[Environment]::GetFolderPath('UserProfile')
 Import-Module (Join-Path $PSScriptRoot 'CodexContinuityCliPin.psm1') -Force
 if($ApplyCodexPin){
  # Fresh preview only; no worker/task/helper installation or restart.
  $plan=Get-Content -LiteralPath $PlanFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  if([IO.Path]::GetFullPath($plan.stateRoot) -ine [IO.Path]::GetFullPath((Join-Path $ownerHome '.ai-control-center/control-plane/codex-continuity')) -or [IO.Path]::GetFullPath($plan.standaloneRoot) -ine [IO.Path]::GetFullPath((Join-Path $ownerHome '.codex/packages/standalone'))){throw 'owner_local_pin_plan_required'}
  Invoke-AiccContinuityCliPinPlan -PlanFile $PlanFile -ExpectedPlanSha256 $ExpectedPlanSha256 -Confirm $Confirm|ConvertTo-Json -Depth 8
 }else{
  New-AiccContinuityCliPinPlan -StateRoot (Join-Path $ownerHome '.ai-control-center/control-plane/codex-continuity') -StandaloneRoot (Join-Path $ownerHome '.codex/packages/standalone') -OldRelease $OldRelease -NewRelease $NewRelease -ExpectedOldSha256 $ExpectedOldSha256 -ExpectedNewSha256 $ExpectedNewSha256 -ExpectedSignerThumbprint $ExpectedSignerThumbprint -ExpectedOldSignerThumbprint $ExpectedOldSignerThumbprint -ExpectedNewSignerThumbprint $ExpectedNewSignerThumbprint -PlanFile $PlanFile|ConvertTo-Json -Depth 8
 }
 return
}
if($ApplyCodexPin -or $PlanFile -or $ExpectedPlanSha256 -or $Confirm -or $OldRelease -or $NewRelease -or $ExpectedOldSha256 -or $ExpectedNewSha256 -or $ExpectedSignerThumbprint -or $ExpectedOldSignerThumbprint -or $ExpectedNewSignerThumbprint){throw 'explicit_update_codex_pin_action_required'}
if($ThreadId -notmatch '^[a-f0-9-]{36}$' -or $ThreadId -in $ExcludedThreadIds){throw 'unprotected_exact_thread_required'}
$ownerHome=[Environment]::GetFolderPath('UserProfile')
$aiccHome=Join-Path $ownerHome '.ai-control-center'
$stateRoot=Join-Path $aiccHome 'control-plane\codex-continuity'
$taskName='AgenticLab-AICC-Codex-Continuity'
$description='AICC owner-local registered Codex thread continuity; OCX only; no request replay'
# Resolve the exact installation anchor before stopping any owned worker. An
# archived or missing anchor is a preflight failure, not a reason to stop service.
$exe=Join-Path $ownerHome '.codex\packages\standalone\current\bin\codex.exe'
$origin=$null
if(-not $Upgrade){
 if($InitialOwnerPid -le 0){throw 'exact_OCX_owner_required'}
 $origin=Get-CimInstance Win32_Process -Filter ('ProcessId='+$InitialOwnerPid)
 if(-not $origin -or $origin.ExecutablePath -ine $exe -or -not $origin.CommandLine.Contains('17841')){throw 'exact_OCX_owner_required'}
}
$rollout=Get-ChildItem -LiteralPath (Join-Path $ownerHome '.codex\sessions') -Recurse -File -Filter ('*'+$ThreadId+'.jsonl')|Select-Object -First 2
if(@($rollout).Count -ne 1){throw 'single_exact_saved_thread_required'}
$stream=[IO.File]::Open($rollout.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
try{$reader=[IO.StreamReader]::new($stream);$meta=$reader.ReadLine()|ConvertFrom-Json}finally{$stream.Dispose()}
if($meta.type -ne 'session_meta' -or $meta.payload.id -ne $ThreadId){throw 'saved_thread_identity_mismatch'}
$projectRoot=(Resolve-Path -LiteralPath $meta.payload.cwd).Path
# Compute immutable helper/toolchain preflight before any worker/task stop.
$helper=Join-Path $PSScriptRoot 'Invoke-AiccCodexContinuity.ps1'
$hash=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
$release=Join-Path $aiccHome ('releases\codex-continuity\'+$hash.Substring(0,16))
$installedHelper=Join-Path $release 'Invoke-AiccCodexContinuity.ps1'
if((Test-Path -LiteralPath $installedHelper) -and (Get-FileHash -LiteralPath $installedHelper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash){throw 'immutable_release_changed_before_stop'}
if(-not(Test-Path -LiteralPath (Join-Path $aiccHome 'toolchain/pwsh-7.6.6/runtime/pwsh.exe') -PathType Leaf)){throw 'registered_portable_powershell_required_before_stop'}
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing -and $existing.Description -ne $description){throw 'unowned_task_preserved'}
if($existing -and ($existing.State -eq 'Running' -or $Upgrade)){
 if(-not $Upgrade){throw 'existing_watcher_preserved_use_tray_controls'}
 $currentFile=Join-Path $stateRoot 'registrations.json'
 # Read the same locked registry as the worker; do not race its replacement.
 $readLock=$null;for($readAttempt=0;$readAttempt -lt 20;$readAttempt++){try{$readLock=[IO.File]::Open($currentFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);break}catch [IO.IOException]{Start-Sleep -Milliseconds 100}}
 if(-not $readLock){throw 'registry_busy_preserved'}
 try{
  $current=Get-Content -LiteralPath $currentFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  # Identity and registered-scope failures are preflight, before stopping anything.
  if($current.schemaVersion -ne 1 -or $current.codexExecutable -ine $exe -or $current.codexSha256 -cne (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -or -not $current.threads.ContainsKey($ThreadId)){throw 'existing_registry_identity_hold_before_stop'}
  if([IO.Path]::GetFullPath($current.threads[$ThreadId].projectRoot) -ine [IO.Path]::GetFullPath($projectRoot) -or $current.threads[$ThreadId].rollout -ine $rollout.FullName){throw 'registered_scope_changed_before_stop'}
  if($current.protocolVersion -ne 3 -or -not $current.helperPath -or (Get-FileHash -LiteralPath $current.helperPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $current.helperSha256){throw 'installed_helper_identity_hold_before_stop'}
  if(-not(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'Invoke-AiccCodexContinuity.ps1') -PathType Leaf) -or -not(Test-Path -LiteralPath (Join-Path $aiccHome 'toolchain/pwsh-7.6.6/runtime/pwsh.exe') -PathType Leaf)){throw 'installation_anchor_missing_before_stop'}
 }finally{$readLock.Dispose()}
 if($current.schemaVersion -ne 1 -or @($current.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt -or $_.state -eq 'RESUMING_OCX'}).Count){throw 'existing_dispatch_preserved'}
 $worker=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$current.worker.pid) -ErrorAction SilentlyContinue
 if($worker){
  $ownedPwsh=Join-Path $aiccHome 'toolchain\pwsh-7.6.6\runtime\pwsh.exe'
  if($worker.ExecutablePath -ine $ownedPwsh -or $worker.CommandLine -notmatch 'Invoke-AiccCodexContinuity\.ps1.*-Action Worker' -or -not $worker.CommandLine.Contains($stateRoot)){throw 'worker_owner_unknown'}
  $ownedProcess=Get-Process -Id $worker.ProcessId -ErrorAction Stop
  # Graceful request is serialized with dispatch. Never kill an active model turn.
  if($current.protocolVersion -ne 3 -or -not $current.helperPath -or (Get-FileHash -LiteralPath $current.helperPath).Hash.ToLowerInvariant() -cne $current.helperSha256){throw 'installed_helper_identity_hold'}
  & $current.helperPath -Action StopWorker -StateRoot $stateRoot|Out-Null
  if(-not $ownedProcess.WaitForExit(30000)){throw 'watcher_normal_exit_pending_preserved'}
 }
 # WScript may still be returning the child's exit code; only the owned task ends.
 Stop-ScheduledTask -TaskName $taskName
}
if((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash){throw 'source_helper_changed_after_preflight'}
New-Item -ItemType Directory -Path $release -Force|Out-Null
$installedHelper=Join-Path $release 'Invoke-AiccCodexContinuity.ps1'
if(Test-Path -LiteralPath $installedHelper){if((Get-FileHash -LiteralPath $installedHelper).Hash.ToLowerInvariant() -ne $hash){throw 'immutable_release_changed'}}else{Copy-Item -LiteralPath $helper -Destination $installedHelper}
New-Item -ItemType Directory -Path $stateRoot -Force|Out-Null
$configFile=Join-Path $stateRoot 'registrations.json'
$registryLock=[IO.File]::Open($configFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$rollbackFile=$null
try{
if(Test-Path -LiteralPath $configFile){
 if(-not $Upgrade){throw 'existing_registry_preserved_use_tray_controls'}
 $config=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 if($Upgrade -and $current -and ($config.helperPath -ine $current.helperPath -or $config.helperSha256 -cne $current.helperSha256)){throw 'installed_generation_changed_preserved'}
 if($config.schemaVersion -ne 1 -or $config.codexExecutable -ine $exe -or $config.codexSha256 -ne (Get-FileHash -LiteralPath $exe).Hash.ToLowerInvariant() -or -not $config.threads.ContainsKey($ThreadId)){throw 'existing_registry_identity_hold'}
 if(@($config.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt -or $_.state -eq 'RESUMING_OCX'}).Count){throw 'existing_dispatch_preserved'}
 if([IO.Path]::GetFullPath($config.threads[$ThreadId].projectRoot) -ine [IO.Path]::GetFullPath($projectRoot) -or $config.threads[$ThreadId].rollout -ine $rollout.FullName){throw 'registered_scope_changed'}
 if($config.worker.pid -and (Get-Process -Id $config.worker.pid -ErrorAction SilentlyContinue)){throw 'old_watcher_exit_unconfirmed'}
 # Preserve the latest registry under the same lock used by all queue writers.
 # The rollback snapshot includes the stop request; restoration needs an owned restart.
 $rollbackRoot=Join-Path $aiccHome ('backups\codex-continuity-upgrade-'+[guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $rollbackRoot|Out-Null
 $rollbackFile=Join-Path $rollbackRoot 'registrations.json'
 Copy-Item -LiteralPath $configFile -Destination $rollbackFile
 $config.workerStopRequestedAt=$null
 $config.excludedThreadIds=@(@($config.excludedThreadIds)+@($ExcludedThreadIds)|Select-Object -Unique)
}else{
 $config=@{schemaVersion=1;codexExecutable=$exe;codexSha256=(Get-FileHash -LiteralPath $exe).Hash.ToLowerInvariant();excludedThreadIds=@($ExcludedThreadIds);maxConcurrent=1;nativeFallback=$false;cycleInitialization='existing-A1-watcher';worker=$null;threads=@{}}
 $config.threads[$ThreadId]=@{threadId=$ThreadId;title='AICC 전체 마감 메인';projectRoot=$projectRoot;rollout=$rollout.FullName;enabled=$true;state='REGISTERED_OWNER_ACTIVE';ownerPid=$origin.ProcessId;ownerCreatedAt=$origin.CreationDate.ToUniversalTime().ToString('o');nextCheckAt=[DateTimeOffset]::UtcNow.ToString('o');attempt=$null;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
}
$config.protocolVersion=3;$config.helperSha256=$hash;$config.helperPath=$installedHelper
$temporary=$configFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($temporary,($config|ConvertTo-Json -Depth 20)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false));[IO.File]::Move($temporary,$configFile,$true)
}finally{$registryLock.Dispose()}
$pwsh=Join-Path $aiccHome 'toolchain\pwsh-7.6.6\runtime\pwsh.exe'
if(-not(Test-Path -LiteralPath $pwsh -PathType Leaf)){throw 'registered_portable_powershell_required'}
# Hide the console at creation while keeping Scheduler attached to the child.
$hiddenLauncher=Join-Path $release 'worker.hidden.vbs'
$workerCommand='"'+$pwsh+'" -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$installedHelper+'" -Action Worker -StateRoot "'+$stateRoot+'"'
$vbs='Option Explicit'+[Environment]::NewLine+'Dim shell, result'+[Environment]::NewLine+'Set shell = CreateObject("WScript.Shell")'+[Environment]::NewLine+'result = shell.Run("'+$workerCommand.Replace('"','""')+'", 0, True)'+[Environment]::NewLine+'WScript.Quit result'+[Environment]::NewLine
[IO.File]::WriteAllText($hiddenLauncher,$vbs,[Text.UTF8Encoding]::new($false))
$wscript=Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\wscript.exe'
$taskAction=New-ScheduledTaskAction -Execute $wscript -Argument ('/b /nologo "'+$hiddenLauncher+'"') -WorkingDirectory $release
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $sid;$trigger.Delay='PT30S'
$recoveryTrigger=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval ([TimeSpan]::FromMinutes(2))
$principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($trigger,$recoveryTrigger) -Principal $principal -Settings $settings -Description $description -Force|Out-Null
Start-ScheduledTask -TaskName $taskName
$receipt=@{schemaVersion=1;at=[DateTimeOffset]::UtcNow.ToString('o');taskName=$taskName;startRequested=$true;threadId=$ThreadId;enabled=$config.threads[$ThreadId].enabled;initialOwnerPid=$InitialOwnerPid;releaseHash=$hash;releaseRoot=$release;stateRoot=$stateRoot;excludedThreadCount=$config.excludedThreadIds.Count;verification='NOT_RUN';rollbackRegistry=$rollbackFile;rollbackMode='owned-normal-stop-and-locked-registry-restore-not-blind-copy';restartPolicy='three-failure-restarts-plus-two-minute-singleton-recovery';recovery='No service restart; no Native fallback; exact-thread continuation only after original owner releases'}
New-Item -ItemType Directory -Path (Join-Path $aiccHome 'receipts') -Force|Out-Null
[IO.File]::WriteAllText((Join-Path $aiccHome ('receipts\codex-continuity-install-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json')),($receipt|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$receipt|ConvertTo-Json -Depth 8
