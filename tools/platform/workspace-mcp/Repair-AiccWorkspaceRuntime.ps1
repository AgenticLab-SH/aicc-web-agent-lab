#requires -Version 7.5
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidateSet('Prepare','Apply','Rollback')][string]$Mode,
 [Parameter(Mandatory)][string]$OperationDirectory,
 [string]$ExpectedUnknownCallId,
 [string]$ExpectedUnknownRequestHash,
 [switch]$EmptyDrained,
 [string]$FailedInstallDirectory,
 [string]$QueueDeploymentDirectory,
 [string]$ExpectedPlanSha256,
 [string]$ReadyFile
)
$ErrorActionPreference='Stop'
$stateRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$taskName='AgenticLab-AICC-Workspace-Tunnel'
. (Join-Path $PSScriptRoot 'Stop-WorkspaceOwnedRuntime.ps1')
function Hash([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function Read([string]$p){Get-Content -LiteralPath $p -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function Json($v){ConvertTo-Json -InputObject $v -Depth 30 -Compress}
function Same($a,$b){if($a -is [Collections.IDictionary] -and $b -is [Collections.IDictionary]){if($a.Count -ne $b.Count){return $false};foreach($k in $a.Keys){if(!$b.Contains($k) -or !(Same $a[$k] $b[$k])){return $false}};return $true};if($a -is [array] -or $b -is [array]){if(@($a).Count -ne @($b).Count){return $false};for($j=0;$j -lt @($a).Count;$j++){if(!(Same @($a)[$j] @($b)[$j])){return $false}};return $true};return $a -ceq $b}
function Plain([string]$p,[bool]$directory=$false){$i=Get-Item -LiteralPath ([IO.Path]::GetFullPath($p)) -Force;if($i.LinkType -or $i.PSIsContainer -ne $directory){throw 'Exact regular recovery input required'};$ancestor=if($i.PSIsContainer){$i}else{$i.Directory};for($a=$ancestor;$a;$a=$a.Parent){if($a.LinkType){throw 'Linked recovery input refused'}};return $i.FullName}
function Write-New([string]$p,$v){$stream=[IO.File]::Open($p,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$bytes=[Text.Encoding]::UTF8.GetBytes((Json $v));$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}}
function Save([string]$p,$v){$tmp=$p+'.'+[guid]::NewGuid().ToString('N')+'.tmp';Write-New $tmp $v;Move-Item -LiteralPath $tmp -Destination $p -Force}
function Assert-FrozenUnknown($s,[string]$callId,[string]$requestHash){
 if(!$s.initialized -or !$s.closed -or $s.phase -notin @('DRAINING','EXPIRED') -or $s.fault){throw 'Only a known closed, initialized failed generation may be recovered'}
 if((@($s.providers.Keys|Sort-Object)-join ',') -cne 'host,native,workspace'){throw 'Exact provider set required'}
 foreach($key in $s.providers.Keys){$v=$s.providers[$key];foreach($field in @('active','unknown','reconnecting')){if($v[$field] -isnot [int] -and $v[$field] -isnot [long]){throw 'Known counters required'}};if($v.active -ne 0 -or $v.reconnecting -ne 0 -or $v.unknown -ne $(if($key -eq 'workspace'){1}else{0})){throw 'Active, reconnecting or additional unknown work must be preserved; recovery refused'}}
 $calls=@($s.calls);$unknown=@($s.unknown)
 if($calls.Count -ne 1 -or $unknown.Count -ne 1 -or !(Same $calls[0] $unknown[0])){throw 'One exact original unresolved write required'}
 $c=$unknown[0]
 if($c.callId -cne $callId -or $c.requestHash -cne $requestHash -or $c.provider -cne 'workspace' -or $c.tool -cne 'aicc_workspace_apply_patch' -or $c.phase -cne 'unknown' -or $c.readOnly -cne $false){throw 'Original unknown identity differs'}
 return $c
}
function Assert-Pins($plan){foreach($pin in $plan.pins){if((Hash (Plain $pin.path)) -cne $pin.sha256){throw 'Installed files changed; no recovery dispatch'}};if((Export-ScheduledTask -TaskName $taskName).Trim() -cne ([IO.File]::ReadAllText((Join-Path $plan.rollback_ref 'task.before.xml'))).Trim()){throw 'Task definition changed'}}
function Assert-EmptyRecoveryState($s,$plan=$null){
 if(!$s.initialized -or $s.fault -or (@($s.providers.Keys|Sort-Object)-join ',') -cne 'host,native,workspace' -or @($s.calls).Count -ne 0 -or @($s.unknown).Count -ne 0){throw 'Known initialized empty three-provider state required'}
 foreach($v in $s.providers.Values){foreach($key in @('active','unknown','reconnecting')){if(($v[$key] -isnot [int] -and $v[$key] -isnot [long]) -or $v[$key] -ne 0){throw 'Active or uncertain work prevents empty recovery'}}}
 if($null -eq $plan){if($s.closed -or $s.phase -cne 'OPEN' -or $s.operation){throw 'Unclaimed open generation required before preparation'}}else{
  if(!$s.closed -or $s.phase -cne 'CONSUMED' -or $s.expired -or $s.consumedSnapshotSha256 -cnotmatch '^[a-f0-9]{64}$' -or $s.operation.operationId -cne $plan.request_id -or $s.operation.nonce -cne $plan.challenge -or $s.operation.operationExpiresAt -cne $plan.expires_at -or !(Same $s.identity $plan.gatewayIdentity)){throw 'Fresh exact consumed maintenance drain required'}
 }
}
function Assert-NoLiveWriteLease([string]$root){
 $node=$script:recoveryNode
 $module=$script:recoveryStoreModule.Replace('\','/')
 $code='import {DurableJobStore} from '+(Json ('file:///'+$module))+';const s=new DurableJobStore({root:process.argv[1],create:false}).read().state;console.log(JSON.stringify(Object.values(s.remoteLeases).filter(x=>x.state==="leased"&&x.mode==="write"&&Date.parse(x.expiresAt)>Date.now()).length));'
 $count=& $node --input-type=module -e $code (Join-Path $root 'jobs')
 if($LASTEXITCODE -ne 0 -or "$count" -cne '0'){throw 'Live or unreadable writer lease prevents runtime restart'}
}
function Assert-UnchangedConsumedInstall($state,$failedPlan,$journal,$failure){
 # A rejected queue owner check can occur after the external drain was consumed,
 # but before the updater touches any installed bytes. Recover the identical
 # installed graph only; this never accepts the rejected queue candidate.
 $hostRefusal=$failedPlan.changeKind -ceq 'host-runtime-update' -and $failure.error -ceq 'Runtime ownership changed'
 $queueRefusal=$failedPlan.changeKind -cin @('workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement') -and
   $failure.error -ceq 'QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN'
 if((-not $hostRefusal -and -not $queueRefusal) -or $journal.phase -cne 'PREPARED' -or
    $journal.startAttempts -ne 0 -or $journal.rollbackStartAttempts -ne 0 -or
    $failure.phase -cne 'PREPARED'){
  throw 'Only a proven unchanged supported pre-mutation install refusal may recover a consumed drain'
 }
 $binding=@{request_id=$failedPlan.request_id;challenge=$failedPlan.challenge;
  expires_at=$state.operation.operationExpiresAt;gatewayIdentity=$state.identity}
 if([DateTimeOffset]::Parse($state.operation.operationExpiresAt) -gt [DateTimeOffset]::Parse($failedPlan.expires_at) -or [DateTimeOffset]::Parse($state.operation.operationExpiresAt) -le [DateTimeOffset]::UtcNow){throw 'Failed install drain expiry exceeds plan or expired'}
 Assert-EmptyRecoveryState $state $binding
 if(@($failedPlan.ownership.processes|Where-Object pid -eq $state.identity.gateway.pid).Count -ne 1){throw 'Failed install gateway ownership differs'}
}
function Assert-FailedInstallPreimages([string]$directory,$state){
 $directory=Plain $directory $true
 if((Split-Path $directory -Parent) -ine (Join-Path $stateRoot 'asset-control')){throw 'Exact failed owner installation required'}
 $failed=Read (Join-Path $directory 'plan.json')
 $argsProof=Read (Join-Path $directory 'maintenance-args.json')
 if($argsProof.OperationId -cne $state.operation.operationId -or $argsProof.Nonce -cne $state.operation.nonce -or $argsProof.OperationExpiresAt -cne $state.operation.operationExpiresAt -or $argsProof.ExpectedGatewayPid -ne $state.identity.gateway.pid){throw 'Original consumed request binding differs'}
 Assert-UnchangedConsumedInstall $state $failed (Read (Join-Path $directory 'journal.json')) (Read (Join-Path $directory 'apply-error.json'))
 if($failed.owner_task_id -cne $env:CODEX_THREAD_ID -or $failed.rollback_ref -cne $directory){throw 'Failed installation owner differs'}
 foreach($pair in @(@('registry',(Join-Path $stateRoot 'runtime/components.json')),@('config',(Join-Path $stateRoot 'workspace-mcp/config.json')),@('profile',(Join-Path $stateRoot 'workspace-mcp/tunnel/profiles/aicc-workspace.yaml')),@('receipt',(Join-Path $stateRoot ('backups/workspace-tunnel-windows-task/'+$taskName+'.install.json'))),@('launcher',(Join-Path $stateRoot 'workspace-mcp/runtime/aicc-workspace.hidden.ps1')))){
  if((Hash (Plain $pair[1])) -cne (Hash (Plain (Join-Path $directory ($pair[0]+'.before'))))){throw 'Failed installation changed owner files'}
 }
 if((Export-ScheduledTask -TaskName $taskName).Trim() -cne ([IO.File]::ReadAllText((Join-Path $directory 'task.before.xml'))).Trim()){throw 'Failed installation changed task'}
 return $failed
}
function Assert-QueueConsumedBinding($state,$deployment,$enginePlan,$applied){
 if($deployment.kind -cne 'webgpt-queue-native-deployment/v1' -or $deployment.ownerTaskId -cne $env:CODEX_THREAD_ID -or
    $applied.status -cne 'APPLIED_RUNTIME_UNOBSERVED' -or $applied.ledgerPreserved -cne $true -or
    $applied.planSha256 -cne $deployment.enginePlanSha256 -or $applied.operationId -cne $enginePlan.operationId -or
    $enginePlan.before.ledgerSha256 -cne $applied.after.ledgerSha256 -or
    $enginePlan.before.configSha256 -cne $applied.after.configSha256 -or
    $enginePlan.candidateSha256 -cne $applied.after.executableSha256 -or
    [DateTimeOffset]::Parse($deployment.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'Exact successful native queue deployment required'}
 Assert-EmptyRecoveryState $state @{request_id=$deployment.operationId;challenge=$deployment.challenge;expires_at=$deployment.expiresAt;gatewayIdentity=$state.identity}
}
function Assert-QueueConsumedFiles([string]$directory,$state){
 $directory=Plain $directory $true
 $deployment=Read (Plain (Join-Path $directory 'deployment.json'))
 $engine=Read (Plain $deployment.enginePlanFile)
 if((Plain $deployment.enginePlanFile) -ine (Join-Path $directory 'plan.json') -or
    (Hash $deployment.enginePlanFile) -cne $deployment.enginePlanSha256){throw 'Queue engine plan changed'}
 $applied=Read (Plain (Join-Path $directory 'applied.json'))
 Assert-QueueConsumedBinding $state $deployment $engine $applied
 $registry='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.agenticfabworks.webgpt_queue'
 if([string](Get-ItemProperty -LiteralPath $registry).'(default)' -cne $applied.after.manifestPath){throw 'Queue registered release changed'}
 foreach($pair in @(@('manifestPath','manifestSha256'),@('executable','executableSha256'),@('configPath','configSha256'),@('ledgerPath','ledgerSha256'))){
  if((Hash (Plain $applied.after[$pair[0]])) -cne $applied.after[$pair[1]]){throw 'Queue installed graph changed'}
 }
 return $deployment
}
$OperationDirectory=[IO.Path]::GetFullPath($OperationDirectory)
$boundary=(Join-Path $stateRoot 'asset-control').TrimEnd('\')+'\'
if(!$OperationDirectory.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase)){throw 'Existing owner operation boundary required'}
if($Mode -eq 'Prepare'){
 if(!$env:CODEX_THREAD_ID -or (!$EmptyDrained -and ($ExpectedUnknownCallId -notmatch '^[a-f0-9-]{36}$' -or $ExpectedUnknownRequestHash -notmatch '^[a-f0-9]{64}$')) -or ($EmptyDrained -and ($ExpectedUnknownCallId -or $ExpectedUnknownRequestHash)) -or ($QueueDeploymentDirectory -and (!$EmptyDrained -or $FailedInstallDirectory))){throw 'Explicit owner and one exact recovery mode required'}
 if(Test-Path -LiteralPath $OperationDirectory){throw 'Existing operation must be reconciled'}
 $registryFile=Join-Path $stateRoot 'runtime/components.json';$registry=Read $registryFile
 $ownership=Get-WorkspaceOwnedRuntime 'business-full';$marker=Read (Join-Path $stateRoot 'workspace-mcp/runtime/remote-authority-status.json')
 $instances=@(Get-ChildItem -LiteralPath (Join-Path $stateRoot 'runtime/unified-mcp-maintenance') -Directory|Where-Object {$_.Name.StartsWith([string]$marker.supervisor.pid+'-')})
 if($instances.Count -ne 1){throw 'One exact current gateway generation required'}
 $instance=Plain $instances[0].FullName $true;$identity=Read (Join-Path $instance 'identity.json');$state=Read (Join-Path $instance 'state.json')
 if(!(Same $identity $state.identity) -or $identity.gateway.pid -ne $marker.supervisor.pid -or @($ownership.processes|Where-Object pid -eq $identity.gateway.pid).Count -ne 1 -or (Plain $identity.configPath) -ine (Plain (Join-Path $registry.components.'unified-mcp'.releaseRoot 'config.json'))){throw 'Frozen gateway is not the currently owned runtime'}
 $script:recoveryNode=$registry.components.workspace.runtime
 $script:recoveryStoreModule=Join-Path $registry.components.workspace.releaseRoot 'src/jobs/durable-store.mjs'
 if($FailedInstallDirectory -and -not $EmptyDrained){throw 'Failed installation recovery requires empty mode'}
 if($EmptyDrained){if($FailedInstallDirectory){$null=Assert-FailedInstallPreimages $FailedInstallDirectory $state}elseif($QueueDeploymentDirectory){$queueDeployment=Assert-QueueConsumedFiles $QueueDeploymentDirectory $state}else{Assert-EmptyRecoveryState $state};Assert-NoLiveWriteLease $stateRoot;$call=$null}else{$call=Assert-FrozenUnknown $state $ExpectedUnknownCallId $ExpectedUnknownRequestHash}
 $task=Get-ScheduledTask -TaskName $taskName;if($task.State -cne 'Running' -or !$task.Settings.Enabled){throw 'Enabled original Task required'}
 $paths=@($registryFile,$identity.configPath,(Join-Path $registry.components.'unified-mcp'.releaseRoot 'gateway.cjs'),(Join-Path $stateRoot 'workspace-mcp/config.json'),(Join-Path $stateRoot 'workspace-mcp/tunnel/profiles/aicc-workspace.yaml'),(Join-Path $stateRoot 'workspace-mcp/runtime/aicc-workspace.hidden.ps1'),(Join-Path $PSScriptRoot 'Stop-WorkspaceOwnedRuntime.ps1'))
 foreach($provider in (Read $identity.configPath).providers){$paths+=@($provider.files.path)}
 $pins=@($paths|Sort-Object -Unique|ForEach-Object {@{path=(Plain $_);sha256=(Hash $_)}})
 [IO.Directory]::CreateDirectory($OperationDirectory)|Out-Null
 foreach($name in @('identity.json','state.json','journal.jsonl')){Copy-Item -LiteralPath (Join-Path $instance $name) -Destination (Join-Path $OperationDirectory ('old-gateway.'+$name))}
 [IO.File]::WriteAllText((Join-Path $OperationDirectory 'task.before.xml'),(Export-ScheduledTask -TaskName $taskName),[Text.UTF8Encoding]::new($false))
 $plan=@{schemaVersion=1;changeKind='workspace-runtime-cold-recovery';owner_task_id=$env:CODEX_THREAD_ID;request_id=('workspace-recovery-'+[guid]::NewGuid().ToString('N'));challenge=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant();target=$taskName;rollback_ref=$OperationDirectory;expires_at=[DateTimeOffset]::UtcNow.AddMinutes(25).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");scriptSha256=(Hash $PSCommandPath);ownership=$ownership;pins=$pins;oldStateFile=(Join-Path $instance 'state.json');oldStateSha256=(Hash (Join-Path $instance 'state.json'));originalUnknown=$call;historicalUnknownCount=1;originalOutcome='UNKNOWN_PRESERVED';stopMode='planned-maintenance-stop';allowed_recovery=@('stop-exact-owned-failed-generation','start-identical-original-task-once');userAuthorization='Recover the broken Workspace connection and finish approved plugin installation; preserve the original UNKNOWN, do not replay it, do not alter updater admission conditions'}
 if($EmptyDrained){$plan.emptyDrained=$true;$plan.gatewayIdentity=$identity;$plan.historicalUnknownCount=0;$plan.originalOutcome='NO_CURRENT_UNKNOWN';$plan.allowed_recovery=@('stop-exact-owned-empty-consumed-generation','start-identical-original-task-once')}
 if($FailedInstallDirectory){$plan.failedInstallDirectory=(Plain $FailedInstallDirectory $true);$plan.failedInstallPins=@('plan.json','journal.json','apply-error.json','maintenance-args.json','registry.before','config.before','profile.before','receipt.before','launcher.before','task.before.xml'|ForEach-Object {@{path=(Join-Path $plan.failedInstallDirectory $_);sha256=(Hash (Join-Path $plan.failedInstallDirectory $_))}})}
 if($QueueDeploymentDirectory){
  $plan.queueDeploymentDirectory=Plain $QueueDeploymentDirectory $true
  $plan.queueDeploymentPins=@('deployment.json','plan.json','applied.json'|ForEach-Object{@{path=(Join-Path $plan.queueDeploymentDirectory $_);sha256=(Hash (Join-Path $plan.queueDeploymentDirectory $_))}})
  $plan.request_id=$queueDeployment.operationId;$plan.challenge=$queueDeployment.challenge;$plan.expires_at=$queueDeployment.expiresAt
 }
 Write-New (Join-Path $OperationDirectory 'plan.json') $plan;Write-New (Join-Path $OperationDirectory 'journal.json') @{phase='PREPARED';startAttempts=0;rollbackStartAttempts=0;historicalUnknownCount=$plan.historicalUnknownCount;originalOutcome=$plan.originalOutcome}
 @{status='PREPARED';planSha256=(Hash (Join-Path $OperationDirectory 'plan.json'));request_id=$plan.request_id;expires_at=$plan.expires_at}|ConvertTo-Json -Compress;return
}
$planFile=Plain (Join-Path $OperationDirectory 'plan.json');if((Hash $planFile) -cne $ExpectedPlanSha256){throw 'Exact recovery plan required'};$plan=Read $planFile
if($plan.scriptSha256 -cne (Hash $PSCommandPath) -or $plan.rollback_ref -cne $OperationDirectory){throw 'Recovery implementation or scope changed'}
$lock=[IO.File]::Open((Join-Path $OperationDirectory 'operation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
 $journalFile=Join-Path $OperationDirectory 'journal.json';$journal=Read $journalFile
 if($Mode -eq 'Rollback'){
  if($journal.phase -in @('PREPARED','START_ACCEPTED','ROLLED_BACK_START_ACCEPTED')){return}
  foreach($expected in $plan.ownership.processes){$live=Get-CimInstance Win32_Process -Filter ('ProcessId='+$expected.pid);if($live -and $live.CreationDate.ToUniversalTime().Ticks.ToString() -ceq $expected.created){throw 'Old process remains; no duplicate Task start'}}
  foreach($pin in $plan.pins){if((Hash $pin.path) -cne $pin.sha256){throw 'Recovery pins changed; rollback refused'}}
  if($journal.rollbackStartAttempts -ne 0 -or $journal.startAttempts -ne 0){throw 'An original start was already attempted; reconcile it instead of repeating'}
  $journal.rollbackStartAttempts=1;$journal.phase='ROLLBACK_START_INTENT';Save $journalFile $journal
  Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
  $journal.phase='ROLLED_BACK_START_ACCEPTED';Save $journalFile $journal;return
 }
 if($journal.phase -cne 'PREPARED' -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($plan.expires_at)){throw 'Fresh unused recovery plan required'}
 $ready=Read (Plain $ReadyFile)
 foreach($key in @('owner_task_id','request_id','challenge','target','rollback_ref')){if($ready[$key] -cne $plan[$key]){throw 'Independent READY binding mismatch'}}
 if($ready.status -cne 'READY' -or $ready.independent -cne $true -or $ready.plan_sha256 -cne $ExpectedPlanSha256 -or $ready.script_sha256 -cne $plan.scriptSha256 -or !(Same $ready.allowed_recovery $plan.allowed_recovery) -or [DateTimeOffset]::Parse($ready.expires_at) -ne [DateTimeOffset]::Parse($plan.expires_at)){throw 'Fresh exact independent READY required'}
 $worker=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ready.workerPid);if(!$worker -or $worker.CreationDate.ToUniversalTime().Ticks.ToString() -cne $ready.workerCreatedTicks -or @($plan.ownership.processes|Where-Object pid -eq $ready.workerPid).Count){throw 'Independent worker is absent or dependent'}
 Assert-Pins $plan
 if(!(Same (Get-WorkspaceOwnedRuntime 'business-full') $plan.ownership)){throw 'Original process ownership changed'}
 if($plan.emptyDrained){$component=(Read (Join-Path $stateRoot 'runtime/components.json')).components.workspace;$script:recoveryNode=$component.runtime;$script:recoveryStoreModule=Join-Path $component.releaseRoot 'src/jobs/durable-store.mjs';if($plan.failedInstallDirectory){foreach($pin in $plan.failedInstallPins){if((Hash (Plain $pin.path)) -cne $pin.sha256){throw 'Failed installation evidence changed'}};$null=Assert-FailedInstallPreimages $plan.failedInstallDirectory (Read $plan.oldStateFile)}elseif($plan.queueDeploymentDirectory){foreach($pin in $plan.queueDeploymentPins){if((Hash (Plain $pin.path)) -cne $pin.sha256){throw 'Queue deployment evidence changed'}};$null=Assert-QueueConsumedFiles $plan.queueDeploymentDirectory (Read $plan.oldStateFile)}else{Assert-EmptyRecoveryState (Read $plan.oldStateFile) $plan};Assert-NoLiveWriteLease $stateRoot}else{
  if((Hash $plan.oldStateFile) -cne $plan.oldStateSha256){throw 'Original state changed'}
  $null=Assert-FrozenUnknown (Read $plan.oldStateFile) $plan.originalUnknown.callId $plan.originalUnknown.requestHash
 }
 $journal.phase='MAINTENANCE_STOP_INTENT';Save $journalFile $journal
 Disable-ScheduledTask -TaskName $taskName|Out-Null
 $stopped=Stop-WorkspaceOwnedRuntime $plan.ownership;if(!$stopped.stopped){throw 'Original process exit unconfirmed'}
 Stop-ScheduledTask -TaskName $taskName;$journal.phase='STOPPED';Save $journalFile $journal
 $closed=Read $plan.oldStateFile
 if($plan.emptyDrained){if(@($closed.unknown).Count -ne 0 -or @($closed.calls).Count -ne 0){throw 'Unexpected work after empty drain; preserve and inspect'}}elseif(@($closed.unknown).Count -ne 1 -or !(Same $closed.unknown[0] $plan.originalUnknown)){throw 'Original unknown record changed; preserve and inspect'}
 Copy-Item -LiteralPath $plan.oldStateFile -Destination (Join-Path $OperationDirectory 'old-gateway.after-stop.state.json')
 foreach($pin in $plan.pins){if((Hash $pin.path) -cne $pin.sha256){throw 'Original installed graph changed during recovery'}}
 Write-New (Join-Path $OperationDirectory 'unresolved-operation.json') @{schemaVersion=1;status=$(if($plan.emptyDrained){'EMPTY_CONSUMED_GENERATION_STOPPED'}else{'UNKNOWN_PRESERVED_OLD_GENERATION_STOPPED'});originalOutcome=$plan.originalOutcome;originalUnknown=$plan.originalUnknown;oldStateFile=$plan.oldStateFile;oldStateSha256=(Hash $plan.oldStateFile);stopReceipt=$stopped;replayed=$false;historicalUnknownCount=$plan.historicalUnknownCount;currentGenerationCountsMustBeReadSeparately=$true;owner_task_id=$plan.owner_task_id;request_id=$plan.request_id}
 $journal.phase='START_INTENT';$journal.startAttempts=1;Save $journalFile $journal
 Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
 $journal.phase='START_ACCEPTED';Save $journalFile $journal
 @{status='START_ACCEPTED_RUNTIME_UNOBSERVED';historicalUnknownCount=$plan.historicalUnknownCount;originalOutcome=$plan.originalOutcome;installedFilesChanged=0;request_id=$plan.request_id;recovery=$OperationDirectory}|ConvertTo-Json -Compress
}finally{$lock.Dispose()}
