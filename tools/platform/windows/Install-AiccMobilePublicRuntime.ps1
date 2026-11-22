#requires -Version 7.5
[CmdletBinding(DefaultParameterSetName='Legacy')]
param(
 [Parameter(Mandatory)][string]$PlanFile,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPlanSha256,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedTaskXmlSha256,
 [Parameter(Mandatory,ParameterSetName='Legacy')][switch]$ActivateStoppedService,
 [Parameter(Mandatory,ParameterSetName='Lifecycle')][switch]$ActivateNormallyStoppedLifecycle,
 [Parameter(Mandatory,ParameterSetName='DeferredLifecycle')][switch]$AwaitLifecycleCommit,
 [Parameter(Mandatory,ParameterSetName='DeferredLifecycle')][string]$CommitFile,
 [Parameter(ParameterSetName='DeferredLifecycle')][ValidateRange(1,1800)][int]$CommitWaitSeconds=600,
 [Parameter(Mandatory,ParameterSetName='Lifecycle')][guid]$StopOperationId,
 [Parameter(Mandatory,ParameterSetName='Lifecycle')][string]$RecoveryReadyFile,
 [Parameter(Mandatory,ParameterSetName='Lifecycle')][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedRecoveryReadySha256
)
$ErrorActionPreference='Stop'
$deferred=$PSCmdlet.ParameterSetName -ceq 'DeferredLifecycle'
$lifecycle=$deferred -or $PSCmdlet.ParameterSetName -ceq 'Lifecycle'
if(($lifecycle -and -not $ActivateNormallyStoppedLifecycle -and -not $AwaitLifecycleCommit) -or (-not $lifecycle -and -not $ActivateStoppedService)){throw 'explicit_stopped_service_activation_required'}
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$taskName='AgenticLab-AICC-Mobile-Public-Control'
$utf8=[Text.UTF8Encoding]::new($false)
function HashText([string]$Text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($Text))).ToLowerInvariant()}
function FileHash([string]$File){(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
function Within([string]$Root,[string]$File){[IO.Path]::GetFullPath($File).StartsWith([IO.Path]::GetFullPath($Root)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)}
function Regular([string]$File){
 $absolute=[IO.Path]::GetFullPath($File)
 if($lockedFiles -and $lockedFiles.ContainsKey($absolute)){return $absolute}
 $full=(Resolve-Path -LiteralPath $File).Path
 for($p=$full;;$p=Split-Path -Parent $p){
  if($lockedDirectories -and $lockedDirectories.ContainsKey($p)){break}
  $item=Get-Item -LiteralPath $p -Force
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_activation_path_preserved'}
  $parent=Split-Path -Parent $p
  if(-not $parent -or $parent -eq $p){break}
 }
 if((Get-Item -LiteralPath $full).PSIsContainer){throw 'regular_activation_file_required'}
 return $full
}
function WriteNew([string]$File,[string]$Text){
 $stream=[IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=$utf8.GetBytes($Text);$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
# Windows handles deny writes/delete on each verified file and deletion of ancestors.
# Keep them alive across the handoff and commit; no cached hash authorizes mutation.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AiccMobileInstallDirectoryLock {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
 public static SafeFileHandle Open(string path) {
  var h=CreateFileW(path,0,3,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
  if(h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  return h;
 }
}
"@
$held=[Collections.Generic.List[IDisposable]]::new()
$lockedFiles=@{};$lockedDirectories=@{}
function HoldFile([string]$File){
 $full=Regular $File
 if($lockedFiles.ContainsKey($full)){return $lockedFiles[$full]}
 for($parent=Split-Path -Parent $full;$parent;$parent=Split-Path -Parent $parent){
  if(-not $lockedDirectories.ContainsKey($parent)){
   $h=[AiccMobileInstallDirectoryLock]::Open($parent);$held.Add($h);$lockedDirectories[$parent]=$true
  }
 }
 $stream=[IO.File]::Open($full,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 $held.Add($stream);$null=Regular $full;$lockedFiles[$full]=$stream
 return $stream
}
function LockedHash([string]$File){
 $stream=HoldFile $File;$stream.Position=0
 $value=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
 $stream.Position=0;return $value
}
try {
$planPath=Regular $PlanFile
if(-not (Within (Join-Path $owner 'backups') $planPath) -or (LockedHash $planPath) -cne $ExpectedPlanSha256){throw 'exact_owned_activation_plan_required'}
$plan=Get-Content -LiteralPath $planPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
if($plan.state -cne 'ASSEMBLED_NOT_APPLIED' -or ($lifecycle -and $plan.lifecycleTransition.contractVersion -ne 1) -or (-not $lifecycle -and $plan.stoppedServiceActivation.contractVersion -ne 1)){throw 'stopped_service_candidate_contract_required'}
$operation=Split-Path -Parent $planPath
$attemptFile=Join-Path $operation 'activation-attempt.json'
if(Test-Path -LiteralPath $attemptFile){throw 'activation_attempt_exists_do_not_replay'}
if($lifecycle){
 $transitionModule=Regular (Join-Path $PSScriptRoot 'MobilePublicTransition.psm1')
 if((LockedHash $PSCommandPath) -cne $plan.lifecycleTransition.installerSha256 -or (LockedHash $transitionModule) -cne $plan.lifecycleTransition.moduleSha256){throw 'transition_executor_pin_required'}
 Import-Module $transitionModule -Force
 $previousConfig=Regular $plan.runtimeConfig
 if(-not (Within (Join-Path $owner 'control-plane\mobile-public-runtime') $previousConfig) -or (LockedHash $previousConfig) -cne $plan.runtimeConfigSha256){throw 'previous_runtime_config_changed'}
 $previous=Get-Content -LiteralPath $previousConfig -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $baselineManifest=Regular (Join-Path $plan.baseRoot '.aicc-release.json')
 if(-not (Within (Join-Path $owner 'releases\cli') $plan.baseRoot) -or (LockedHash $baselineManifest) -cne $plan.baseManifestSha256){throw 'baseline_manifest_changed'}
 $entry=$previousConfig
 $legacyVbs=$null;$legacyPs=$null
}else{
$entry=Regular $plan.publicEntry
if(-not (Within (Join-Path $owner 'backups') $entry) -or (FileHash $entry) -cne $plan.publicEntrySha256){throw 'legacy_entry_changed'}
$legacyVbs=[IO.Path]::ChangeExtension($entry,'hidden.vbs')
$legacyPs=Join-Path (Split-Path -Parent $entry) 'Start-MobilePublicControl.ps1'
foreach($file in @($legacyVbs,$legacyPs)){
 $path=Regular $file
 $relative=[IO.Path]::GetRelativePath((Split-Path -Parent $entry),$path)
 $pin=@($plan.legacyLaunchers|Where-Object path -CEQ $relative)
 if($pin.Count -ne 1 -or (FileHash $path) -cne $pin[0].sha256){throw 'legacy_launcher_pin_required'}
}
}
$release=[IO.Path]::GetFullPath($plan.candidateRoot)
if(-not (Within (Join-Path $owner 'releases\cli') $release)){throw 'managed_candidate_required'}
$manifestFile=Regular (Join-Path $release '.aicc-release.json')
if((LockedHash $manifestFile) -cne $plan.candidateManifestSha256){throw 'candidate_manifest_changed'}
$manifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
if($manifest.component -cne 'mobile-public-control' -or $manifest.operationId -cne $plan.operationId){throw 'candidate_operation_mismatch'}
$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($pin in $manifest.files){
 $file=[IO.Path]::GetFullPath((Join-Path $release $pin.path))
 if(-not (Within $release $file) -or -not $seen.Add($file)){throw 'invalid_candidate_pin_path'}
 $file=Regular $file
 if((HoldFile $file).Length -ne $pin.size -or (LockedHash $file) -cne $pin.sha256){throw 'candidate_file_changed'}
}
$preparedConfig=Regular $plan.preparedConfig
if(-not (Within $operation $preparedConfig) -or (LockedHash $preparedConfig) -cne $plan.configSha256){throw 'prepared_config_changed'}
$cfg=Get-Content -LiteralPath $preparedConfig -Raw|ConvertFrom-Json -AsHashtable -DateKind String
$configPath=[IO.Path]::GetFullPath($plan.futureConfigPath)
if(-not (Within (Join-Path $owner 'control-plane\mobile-public-runtime') $configPath) -or (Test-Path -LiteralPath (Split-Path -Parent $configPath)) -or $cfg.releaseRoot -cne $release -or $cfg.releaseManifestSha256 -cne $plan.candidateManifestSha256 -or $cfg.port -ne 4383 -or ($lifecycle -and $cfg.remoteOrigin -cne $previous.remoteOrigin) -or (-not $lifecycle -and $cfg.remoteOrigin -cne 'https://aicc.example.invalid')){throw 'fresh_scoped_runtime_config_required'}
$supervisor=Regular (Join-Path $release 'tools\platform\windows\Start-AiccMobilePublicRuntime.ps1')
$pwsh=Regular (Join-Path $PSHOME 'pwsh.exe')
$wscript=Regular (Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\wscript.exe')
$launcher=Join-Path $operation 'mobile-public-runtime.hidden.vbs'
if(@($pwsh,$supervisor,$configPath,$launcher)|Where-Object {$_ -match '["\r\n]'}){throw 'unsafe_launcher_argument'}
function AssertCandidateEntries {
 $actual=[IO.Directory]::GetFiles($release,'*',[IO.SearchOption]::AllDirectories)
 if($actual.Length -ne $manifest.files.Count+1){throw 'candidate_file_set_changed'}
 foreach($file in $actual){if($file -ine $manifestFile -and -not $seen.Contains($file)){throw 'candidate_file_set_changed'}}
}
AssertCandidateEntries
function AssertLifecycleLauncher($Task){
 if(@($Task.Actions).Count -ne 1 -or $Task.Actions[0].Execute -ine $wscript){throw 'exact_lifecycle_task_owner_required'}
 $match=[regex]::Match([string]$Task.Actions[0].Arguments,'^/b /nologo "(?<path>[^"\r\n]+\.vbs)"$')
 if(-not $match.Success){throw 'exact_lifecycle_task_owner_required'}
 $oldLauncher=Regular $match.Groups['path'].Value
 if(-not (Within (Join-Path $owner 'backups') $oldLauncher)){throw 'exact_lifecycle_launcher_required'}
 $oldSupervisor=Regular (Join-Path $previous.releaseRoot 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1')
 $oldCommand='"'+$pwsh+'" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$oldSupervisor+'" -ConfigFile "'+$previousConfig+'" -ExpectedConfigSha256 '+$plan.runtimeConfigSha256
 $oldText=[IO.File]::ReadAllText($oldLauncher)
 $compactLauncher="Option Explicit`r`nDim shell`r`nSet shell = CreateObject(""WScript.Shell"")`r`nWScript.Quit shell.Run("""+$oldCommand.Replace('"','""')+""",0,True)`r`n"
 $spacedLauncher="Option Explicit`r`nDim shell`r`nSet shell = CreateObject(""WScript.Shell"")`r`nWScript.Quit shell.Run("""+$oldCommand.Replace('"','""')+""", 0, True)`r`n"
 if(@($compactLauncher,$spacedLauncher) -cnotcontains $oldText){throw 'exact_lifecycle_launcher_required'}
 # Retain the exact launcher across READY, normal stop and the final CAS.
 $null=HoldFile $oldLauncher
}
if($deferred){
 # Same exporter as the final CAS: reject a wrong caller pin BEFORE stopping service.
 $preflightTask=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
 $preflightTaskXml=Export-ScheduledTask -InputObject $preflightTask -ErrorAction Stop
 if((HashText $preflightTaskXml) -cne $ExpectedTaskXmlSha256){throw 'public_task_definition_changed_before_stop'}
 AssertLifecycleLauncher $preflightTask
 $commitPath=[IO.Path]::GetFullPath($CommitFile)
 if(-not (Within $operation $commitPath) -or (Test-Path -LiteralPath $commitPath)){throw 'fresh_owned_commit_path_required'}
 $preflightFile=Join-Path $operation 'installer-preflight.json'
 $preflightAt=[DateTimeOffset]::UtcNow
 WriteNew $preflightFile (@{schemaVersion=1;state='CANDIDATE_LOCKED_WAITING_FOR_FRESH_COMMIT';operationId=$plan.operationId;planSha256=$ExpectedPlanSha256;candidateManifestSha256=$plan.candidateManifestSha256;taskXmlSha256=$ExpectedTaskXmlSha256;verifiedFiles=$manifest.files.Count;installerPid=$PID;observedAt=$preflightAt.ToString('o');commitFile=$commitPath;stopRequested=$false;runtimeChanged=$false;automaticReplay=$false}|ConvertTo-Json)
 $null=HoldFile $preflightFile
 # This process never stops the old service or creates stop/READY evidence.
 # Existing owner publishes a new one-use command only AFTER this preflight.
 $deadline=[DateTimeOffset]::UtcNow.AddSeconds($CommitWaitSeconds)
 while(-not (Test-Path -LiteralPath $commitPath -PathType Leaf)){
  if([DateTimeOffset]::UtcNow -ge $deadline){throw 'fresh_lifecycle_commit_timeout'}
  Start-Sleep -Milliseconds 100
 }
 $null=HoldFile $commitPath
 $commit=Get-Content -LiteralPath $commitPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 if(@($commit.Keys|Where-Object {$_ -notin @('schemaVersion','action','operationId','planSha256','preflightSha256','stopOperationId','recoveryReadyFile','recoveryReadySha256')}).Count -or $commit.schemaVersion -ne 1 -or $commit.action -cne 'activate-normally-stopped-lifecycle' -or $commit.operationId -cne $plan.operationId -or $commit.planSha256 -cne $ExpectedPlanSha256 -or $commit.preflightSha256 -cne (LockedHash $preflightFile) -or $commit.stopOperationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $commit.recoveryReadySha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'exact_fresh_lifecycle_commit_required'}
 $StopOperationId=[guid]$commit.stopOperationId
 $RecoveryReadyFile=[string]$commit.recoveryReadyFile
 $ExpectedRecoveryReadySha256=[string]$commit.recoveryReadySha256
}
if($lifecycle){
 $readyPath=Regular $RecoveryReadyFile
 if(-not (Within (Join-Path $owner 'backups') $readyPath) -or (FileHash $readyPath) -cne $ExpectedRecoveryReadySha256){throw 'exact_recovery_ready_pin_required'}
 $ready=Get-Content -LiteralPath $readyPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $toolReceiptPath=Regular $ready.toolReceiptFile
 if(-not (Within (Join-Path $owner 'backups') $toolReceiptPath) -or (FileHash $toolReceiptPath) -cne $ready.toolReceiptSha256){throw 'recovery_tool_receipt_pin_required'}
 $toolReceipt=Get-Content -LiteralPath $toolReceiptPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 foreach($key in @('schemaVersion','status','independent','operationId','planSha256','taskXmlSha256','previousConfigSha256','stopOperationId','target','recoveryAction','executorId','observedAt','expiresAt')){if($toolReceipt[$key] -cne $ready[$key]){throw 'recovery_tool_readback_mismatch'}}
}
$journalRoot=Join-Path $owner 'status-tray\requests'
function StoppedEvidence {
 $task=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
 if([string]$task.State -cne 'Ready'){throw 'public_task_not_stopped_ready'}
 $xml=Export-ScheduledTask -InputObject $task -ErrorAction Stop
 if((HashText $xml) -cne $ExpectedTaskXmlSha256){throw 'public_task_definition_changed'}
 if($lifecycle){
  if(@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $wscript){throw 'exact_lifecycle_task_owner_required'}
  $match=[regex]::Match([string]$task.Actions[0].Arguments,'^/b /nologo "(?<path>[^"\r\n]+\.vbs)"$')
  if(-not $match.Success){throw 'exact_lifecycle_task_owner_required'}
  $oldLauncher=Regular $match.Groups['path'].Value
  if(-not (Within (Join-Path $owner 'backups') $oldLauncher)){throw 'exact_lifecycle_launcher_required'}
  $oldSupervisor=Regular (Join-Path $previous.releaseRoot 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1')
  $oldCommand='"'+$pwsh+'" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$oldSupervisor+'" -ConfigFile "'+$previousConfig+'" -ExpectedConfigSha256 '+$plan.runtimeConfigSha256
  $oldText=[IO.File]::ReadAllText($oldLauncher)
  $compactLauncher="Option Explicit`r`nDim shell`r`nSet shell = CreateObject(""WScript.Shell"")`r`nWScript.Quit shell.Run("""+$oldCommand.Replace('"','""')+""",0,True)`r`n"
  $spacedLauncher="Option Explicit`r`nDim shell`r`nSet shell = CreateObject(""WScript.Shell"")`r`nWScript.Quit shell.Run("""+$oldCommand.Replace('"','""')+""", 0, True)`r`n"
  if(@($compactLauncher,$spacedLauncher) -cnotcontains $oldText){throw 'exact_lifecycle_launcher_required'}
  if((LockedHash $previousConfig) -cne $plan.runtimeConfigSha256 -or (LockedHash $baselineManifest) -cne $plan.baseManifestSha256 -or (FileHash $readyPath) -cne $ExpectedRecoveryReadySha256 -or (FileHash $toolReceiptPath) -cne $ready.toolReceiptSha256){throw 'lifecycle_transition_inputs_changed'}
  $statusPath=Regular $previous.statusFile
  if(-not (Within (Join-Path $owner 'runtime\mobile-public-control') $statusPath)){throw 'owned_previous_status_required'}
  $stopRoot=Join-Path (Split-Path -Parent $previousConfig) ('stop-requests/'+$StopOperationId.ToString())
  $requestPath=Regular (Join-Path $stopRoot 'request.json');$claimPath=Regular (Join-Path $stopRoot 'claim.json')
  $status=Get-Content -LiteralPath $statusPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  $claim=Get-Content -LiteralPath $claimPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  if($deferred){
   foreach($at in @($status.observedAt,$claim.at,$ready.observedAt)){
    $time=[DateTimeOffset]::MinValue
    if(-not [DateTimeOffset]::TryParse([string]$at,[ref]$time) -or $time -lt $preflightAt){throw 'stop_and_recovery_must_follow_preflight'}
   }
  }
  if($status.pid -isnot [int] -and $status.pid -isnot [long] -or $status.pid -le 0){throw 'exact_normal_stop_ack_required'}
  $previousProcess=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[long]$status.pid) -ErrorAction Stop)
  $transition=Assert-AiccMobileLifecycleTransition -Plan $plan -PlanSha256 $ExpectedPlanSha256 -Previous $previous -Candidate $cfg -Status $status -Request (Get-Content -LiteralPath $requestPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String) -RequestSha256 (FileHash $requestPath) -Claim $claim -StopOperationId $StopOperationId.ToString() -RecoveryReady $ready -TaskXmlSha256 $ExpectedTaskXmlSha256 -PreviousProcessPresent ($previousProcess.Count -ne 0)
 }elseif(@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $wscript -or $task.Actions[0].Arguments -cne ('/b /nologo "'+$legacyVbs+'"')){throw 'exact_legacy_task_owner_required'}
 $scheduler=New-Object -ComObject 'Schedule.Service'
 $scheduler.Connect()
 $registered=$scheduler.GetFolder('\').GetTask($taskName)
 if($registered.GetInstances(0).Count -ne 0){throw 'public_task_instances_preserved'}
 # Inventory failure is UNKNOWN. Empty results must come from successful inventories.
 $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop)
 if(@($listeners|Where-Object LocalPort -EQ 4383).Count){throw 'public_listener_preserved'}
 $processes=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'pwsh.exe' OR Name = 'powershell.exe' OR Name = 'wscript.exe' OR Name = 'cscript.exe'" -ErrorAction Stop)
 foreach($process in $processes){
  if(-not $process.CommandLine){throw 'relevant_process_ownership_unknown'}
  $command=[string]$process.CommandLine
  if($process.ProcessId -eq $PID){continue}
  if($command.Contains($entry,[StringComparison]::OrdinalIgnoreCase) -or (-not $lifecycle -and ($command.Contains($legacyVbs,[StringComparison]::OrdinalIgnoreCase) -or $command.Contains($legacyPs,[StringComparison]::OrdinalIgnoreCase))) -or ($command.Contains('mobile-public-runner.mjs',[StringComparison]::OrdinalIgnoreCase)) -or ($command.Contains('Start-AiccMobilePublicRuntime.ps1',[StringComparison]::OrdinalIgnoreCase))){throw 'public_runner_or_parent_preserved'}
 }
 if(-not (Test-Path -LiteralPath $journalRoot -PathType Container)){throw 'mobile_journal_inventory_unknown'}
 $journalParent=Regular (Join-Path $journalRoot '..\..\control-plane\mobile-control.json')
 $count=0
 foreach($item in @(Get-ChildItem -LiteralPath $journalRoot -File -ErrorAction Stop|Where-Object Name -Match '^mobile-[a-f0-9]{32}\.json$')){
  $file=Regular $item.FullName
  $record=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  if($record.state -cne 'COMPLETED'){throw 'mobile_outcome_requires_reconciliation'}
  $count++
 }
 return @{observedAt=[DateTimeOffset]::UtcNow.ToString('o');taskState='Ready';runningTaskInstances=0;exactRunnerAndParentProcesses=0;listener4383='ABSENT';mobileJournalCompleted=$count;mobileJournalUnresolved=0;scope='Exact durable mobile journal only; not global unknown=0';historicalNormalStopAck=if($lifecycle){'GENERATION_BOUND_ACK_AND_EXIT'}else{'UNAVAILABLE_NOT_SYNTHESIZED'};transition=$transition;previousLauncherSha256=if($lifecycle){FileHash $oldLauncher}else{FileHash $legacyVbs};taskXml=$xml}
}
$lockRoot=Join-Path $owner 'control-plane\mobile-public-runtime'
New-Item -ItemType Directory -Path $lockRoot -Force|Out-Null
$lock=[IO.File]::Open((Join-Path $lockRoot 'activation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$receipt=@{schemaVersion=1;operationId=$plan.operationId;mode='STOPPED_SERVICE_ACTIVATION';phase='PRECONDITIONS';historicalNormalStopAck='UNAVAILABLE_NOT_SYNTHESIZED';taskUpdated=$false;startAttempted=$false;startAccepted=$false;functionalVerification='NOT_RUN';deviceTrustModified=$false;cloudflareModified=$false;modelRouteModified=$false;automaticReplay=$false}
$receipt.planSha256=$ExpectedPlanSha256;$receipt.previousTaskXmlSha256=$ExpectedTaskXmlSha256
$claimed=$false
if($lifecycle){$receipt.mode='NORMALLY_STOPPED_LIFECYCLE_TRANSITION';$receipt.historicalNormalStopAck='GENERATION_BOUND_ACK_AND_EXIT'}
function Record {
 $temp=$attemptFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 WriteNew $temp ($receipt|ConvertTo-Json -Depth 8)
 [IO.File]::Move($temp,$attemptFile,$true)
}
try {
 AssertCandidateEntries
 $evidence=StoppedEvidence
 $beforeXml=$evidence.taskXml;$evidence.Remove('taskXml')
 $receipt.evidence=$evidence
 $receipt.previousLauncherSha256=$evidence.previousLauncherSha256
 $receipt.phase='CLAIMED_NO_RUNTIME_CHANGE'
 WriteNew $attemptFile ($receipt|ConvertTo-Json -Depth 8)
 $claimed=$true
 $rollback=Join-Path $operation 'public-task.before.xml'
 WriteNew $rollback $beforeXml
 $receipt.rollbackTaskXml=$rollback
 $receipt.rollbackTaskXmlSha256=FileHash $rollback
 $receipt.rollback='Original task/entry/release preserved. Before any restoration reconcile start outcome; a started candidate needs its supported normal drain and actual exit. Never restore device-store snapshots.'
 $launchCommand='"'+$pwsh+'" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$supervisor+'" -ConfigFile "'+$configPath+'" -ExpectedConfigSha256 '+$plan.configSha256
 $vbs="Option Explicit`r`nDim shell`r`nSet shell = CreateObject(""WScript.Shell"")`r`nWScript.Quit shell.Run("""+ $launchCommand.Replace('"','""') +""", 0, True)`r`n"
 WriteNew $launcher $vbs
 $receipt.launcherSha256=FileHash $launcher
 $configDir=Split-Path -Parent $configPath
 New-Item -ItemType Directory -Path $configDir|Out-Null
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $acl=[Security.AccessControl.DirectorySecurity]::new()
 $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
 $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule);Set-Acl -LiteralPath $configDir -AclObject $acl
 $bytes=[IO.File]::ReadAllBytes($preparedConfig)
 $stream=[IO.File]::Open($configPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
 $receipt.configInstalled=$true;$receipt.configSha256=$plan.configSha256
 $document=[xml]::new();$document.XmlResolver=$null;$document.LoadXml($beforeXml)
 $ns=[Xml.XmlNamespaceManager]::new($document.NameTable);$ns.AddNamespace('t',$document.DocumentElement.NamespaceURI)
 $exec=$document.SelectSingleNode('/t:Task/t:Actions/t:Exec',$ns)
 if(-not $exec){throw 'existing_single_exec_required'}
 $exec.SelectSingleNode('t:Command',$ns).InnerText=$wscript
 $exec.SelectSingleNode('t:Arguments',$ns).InnerText='/b /nologo "'+$launcher+'"'
 $working=$exec.SelectSingleNode('t:WorkingDirectory',$ns)
 if(-not $working){$working=$document.CreateElement('WorkingDirectory',$document.DocumentElement.NamespaceURI);[void]$exec.AppendChild($working)}
 $working.InnerText=$operation
 $preparedXml=$document.OuterXml
 WriteNew (Join-Path $operation 'public-task.activation.xml') $preparedXml
 $receipt.desiredTaskXmlSha256=HashText $preparedXml
 # Last fresh compare-and-swap boundary before updating this existing task.
 AssertCandidateEntries
 $fresh=StoppedEvidence
 if((LockedHash $planPath) -cne $ExpectedPlanSha256 -or (LockedHash $preparedConfig) -cne $plan.configSha256 -or (FileHash $launcher) -cne $receipt.launcherSha256){throw 'activation_inputs_changed'}
 $receipt.phase='TASK_UPDATE_ATTEMPTED_OUTCOME_UNKNOWN';Record
 $null=Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $preparedXml -Force -ErrorAction Stop
 $receipt.taskUpdated=$true;$receipt.phase='TASK_UPDATED_READBACK_PENDING';Record
 $readback=Export-ScheduledTask -InputObject (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop) -ErrorAction Stop
 $readDoc=[xml]::new();$readDoc.XmlResolver=$null;$readDoc.LoadXml($readback)
 if($readDoc.DocumentElement.OuterXml -cne $document.DocumentElement.OuterXml){throw 'task_update_readback_mismatch_no_start'}
 if((FileHash $configPath) -cne $plan.configSha256 -or (LockedHash $manifestFile) -cne $plan.candidateManifestSha256 -or (FileHash $launcher) -cne $receipt.launcherSha256){throw 'installed_inputs_changed_no_start'}
 AssertCandidateEntries
 $receipt.taskUpdated=$true;$receipt.phase='START_ATTEMPTED_OUTCOME_UNKNOWN';$receipt.startAttempted=$true;Record
 Start-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
 $receipt.startAccepted=$true;$receipt.phase='TASK_START_ACCEPTED_FUNCTION_UNOBSERVED';$receipt.completedAt=[DateTimeOffset]::UtcNow.ToString('o');Record
 [pscustomobject]@{status=$receipt.phase;receipt=$attemptFile;taskUpdated=$true;startAccepted=$true;functionalVerification='NOT_RUN';historicalNormalStopAck=$receipt.historicalNormalStopAck}|ConvertTo-Json -Compress
}catch{
 $receipt.failureStage=$receipt.phase;$receipt.phase='HOLD_NO_AUTOMATIC_REPLAY'
 $receipt.errorType=$_.Exception.GetType().Name
 $message=$_.Exception.Message
 $receipt.reason=if($message -cmatch '^[a-z][a-z0-9_]+$'){$message}else{'operation_failed_details_not_logged'}
 if($claimed){Record}
 [pscustomobject]@{status=$receipt.phase;stage=$receipt.failureStage;reason=$receipt.reason;receipt=$attemptFile;startAttempted=$receipt.startAttempted;startAccepted=$receipt.startAccepted;functionalVerification='NOT_RUN'}|ConvertTo-Json -Compress
 exit 1
}finally{$lock.Dispose()}

} finally { foreach($resource in $held){$resource.Dispose()} }
