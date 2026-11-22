#requires -Version 7.5
# One authorized transition after both official retained-lock preflights. Never retry.
[CmdletBinding()]param(
 [Parameter(Mandatory)][string]$PlanFile,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPlanSha256
)
$ErrorActionPreference='Stop'
function Hash($f){(Get-FileHash -LiteralPath $f).Hash.ToLowerInvariant()}
function WriteNew($f,$v){$stream=[IO.File]::Open($f,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$b=[Text.UTF8Encoding]::new($false).GetBytes(($v|ConvertTo-Json -Depth 12));$stream.Write($b);$stream.Flush($true)}finally{$stream.Dispose()}}
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$planPath=(Resolve-Path -LiteralPath $PlanFile).Path
if(-not $planPath.StartsWith((Join-Path $owner 'backups')+'\',[StringComparison]::OrdinalIgnoreCase) -or (Hash $planPath) -cne $ExpectedPlanSha256){throw 'transition_exact_owned_plan_required'}
$plan=Get-Content -LiteralPath $planPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
$op=Split-Path -Parent $planPath
# A prior invocation, failed commit or start is never replayed.
foreach($name in @('transition-request.json','lifecycle-commit.json','activation-attempt.json','original-recovery-start-attempt.json')){if(Test-Path -LiteralPath (Join-Path $op $name)){throw 'transition_attempt_exists_no_replay'}}
$regFile=Join-Path $owner 'control-plane/mobile-public-recovery/current.json'
$registryHash=Hash $regFile;$reg=Get-Content -LiteralPath $regFile -Raw|ConvertFrom-Json
if((Hash $reg.manifestFile) -cne $reg.manifestSha256){throw 'transition_recovery_registry_changed'}
$release=Split-Path -Parent $reg.manifestFile;$manifest=Get-Content -LiteralPath $reg.manifestFile -Raw|ConvertFrom-Json
foreach($pin in $manifest.files){if((Hash (Join-Path $release $pin.path)) -cne $pin.sha256){throw 'transition_recovery_tool_changed'}}
$recovery=Join-Path $release 'tools/platform/windows/Request-AiccMobilePublicRecovery.ps1'
$stopHelper=Join-Path $plan.candidateRoot 'tools/platform/windows/Request-AiccMobilePublicStop.ps1'
$stopPin=@((Get-Content -LiteralPath (Join-Path $plan.candidateRoot '.aicc-release.json') -Raw|ConvertFrom-Json).files|Where-Object path -CEQ 'tools/platform/windows/Request-AiccMobilePublicStop.ps1')
if($stopPin.Count -ne 1 -or (Hash $stopHelper) -cne $stopPin[0].sha256){throw 'transition_stop_helper_changed'}
foreach($name in @('installer-preflight.json','recovery-preflight.json')){if(-not (Test-Path -LiteralPath (Join-Path $op $name))){throw 'transition_locked_preflights_required'}}
$pre=Get-Content -LiteralPath (Join-Path $op 'installer-preflight.json') -Raw|ConvertFrom-Json
if($pre.planSha256 -cne $ExpectedPlanSha256 -or $pre.operationId -cne $plan.operationId -or -not(Get-Process -Id $pre.installerPid -ErrorAction SilentlyContinue)){throw 'transition_live_installer_required'}
if($pre.taskXmlSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'transition_installer_task_pin_required_no_stop'}
$taskXml=Export-ScheduledTask -InputObject (Get-ScheduledTask -TaskName 'AgenticLab-AICC-Mobile-Public-Control' -TaskPath '\' -ErrorAction Stop) -ErrorAction Stop
$taskHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($taskXml))).ToLowerInvariant()
if($taskHash -cne $pre.taskXmlSha256){throw 'transition_task_changed_no_stop'}
$cfg=Get-Content -LiteralPath $plan.runtimeConfig -Raw|ConvertFrom-Json -AsHashtable -DateKind String
$before=Get-Content -LiteralPath $cfg.statusFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
if($before.state -cne 'LISTENING' -or (Hash $plan.runtimeConfig) -cne $plan.runtimeConfigSha256){throw 'transition_listening_owner_required'}
WriteNew (Join-Path $op 'transition-request.json') @{schemaVersion=1;operationId=$plan.operationId;planSha256=$ExpectedPlanSha256;registrySha256=$registryHash;originalPid=$before.pid;originalStartedAt=$before.startedAt;automaticReplay=$false;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
try{
 $probe=& $recovery -Action StartProbe -PlanFile $planPath -ExpectedPlanSha256 $ExpectedPlanSha256|ConvertFrom-Json -AsHashtable -DateKind String
 WriteNew (Join-Path $op 'transition-probe.json') $probe
 if($probe.state -cne 'PROBE_RESPONSE' -or $probe.mutationCount -ne 0){throw 'transition_independent_probe_required'}
 $request=Get-Content -LiteralPath $probe.requestFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $preview=& $stopHelper -ConfigFile $plan.runtimeConfig -ExpectedConfigSha256 $plan.runtimeConfigSha256 -OperationId $request.stopOperationId|ConvertFrom-Json -AsHashtable -DateKind String
 WriteNew (Join-Path $op 'transition-stop-preview.json') $preview
 if($preview.stopSubmissionSupported -ne $true -or $preview.otherPendingStopRequests -ne 0 -or $preview.pid -ne $before.pid){throw 'transition_stop_gate_hold'}
 $arm=& $recovery -Action Signal -RequestFile $probe.requestFile -ExpectedRequestSha256 $probe.requestSha256 -Signal arm -Sequence 2 -ExpectedTaskXmlSha256 $request.taskXmlSha256|ConvertFrom-Json -AsHashtable -DateKind String
 WriteNew (Join-Path $op 'transition-arm.json') $arm
 if($arm.state -cne 'ARMED_FOR_EXPLICIT_RECOVERY' -or [DateTimeOffset]::Parse($arm.expiresAt) -lt [DateTimeOffset]::UtcNow.AddSeconds(60) -or (Hash $regFile) -cne $registryHash){throw 'transition_fresh_ready_required_no_stop'}
 $status=Get-Content -LiteralPath $cfg.statusFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 if($status.pid -ne $before.pid -or $status.startedAt -cne $before.startedAt -or $status.state -cne 'LISTENING'){throw 'transition_generation_changed_no_stop'}
 $oldProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$status.pid) -ErrorAction Stop
 if(-not $oldProcess){throw 'transition_owner_absent_no_stop'}
 $parentId=$oldProcess.ParentProcessId
 $stop=& $stopHelper -ConfigFile $plan.runtimeConfig -ExpectedConfigSha256 $plan.runtimeConfigSha256 -OperationId $request.stopOperationId -Submit -WaitSeconds 15|ConvertFrom-Json -AsHashtable -DateKind String
 WriteNew (Join-Path $op 'transition-stop-result.json') $stop
 if($stop.normalStopAck -ne $true){throw 'transition_ack_unconfirmed_no_commit'}
 # OS/task inventories can lag the normal ACK. Wait only inside the original
 # READY lifetime, retaining 25 seconds for commit validation; never renew it.
 $deadline=[DateTimeOffset]::UtcNow.AddSeconds(60)
 $readyDeadline=[DateTimeOffset]::Parse($arm.expiresAt).AddSeconds(-25)
 if($readyDeadline -lt $deadline){$deadline=$readyDeadline}
 do{
  $old=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$status.pid+' OR ProcessId='+[int]$parentId) -ErrorAction Stop)
  $task=Get-ScheduledTask -TaskName 'AgenticLab-AICC-Mobile-Public-Control' -TaskPath '\' -ErrorAction Stop
  if($old.Count -eq 0 -and [string]$task.State -ceq 'Ready'){break}
  Start-Sleep -Milliseconds 100
 }while([DateTimeOffset]::UtcNow -lt $deadline)
 if($old.Count -ne 0 -or [string]$task.State -cne 'Ready' -or [DateTimeOffset]::Parse($arm.expiresAt) -le [DateTimeOffset]::UtcNow.AddSeconds(20)){throw 'transition_exit_or_ready_unconfirmed_no_commit'}
 if((Hash $planPath) -cne $ExpectedPlanSha256 -or (Hash $regFile) -cne $registryHash){throw 'transition_fresh_inputs_changed_no_commit'}
 WriteNew (Join-Path $op 'lifecycle-commit.json') @{schemaVersion=1;action='activate-normally-stopped-lifecycle';operationId=$plan.operationId;planSha256=$ExpectedPlanSha256;preflightSha256=Hash (Join-Path $op 'installer-preflight.json');stopOperationId=$request.stopOperationId;recoveryReadyFile=$arm.readyFile;recoveryReadySha256=$arm.readySha256}
 WriteNew (Join-Path $op 'transition-submitted.json') @{state='FRESH_COMMIT_SUBMITTED_OUTCOME_UNOBSERVED';stopOperationId=$request.stopOperationId;originalPid=$status.pid;originalParentPid=$parentId;normalAck=$true;bothExited=$true;automaticReplay=$false;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
 @{state='FRESH_COMMIT_SUBMITTED_OUTCOME_UNOBSERVED';operationId=$plan.operationId;stopOperationId=$request.stopOperationId}|ConvertTo-Json -Compress
}catch{
 $msg=$_.Exception.Message;$reason=if($msg -cmatch '^[a-z][a-z0-9_]+$'){$msg}else{'transition_failed_details_not_logged'}
 WriteNew (Join-Path $op 'transition-failure.json') @{state='HOLD_NO_REPLAY';reason=$reason;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
 throw
}
