#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OperationDirectory)
$ErrorActionPreference='Stop'
$root=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$OperationDirectory=[IO.Path]::GetFullPath($OperationDirectory)
if(-not $OperationDirectory.StartsWith((Join-Path $root 'backups')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Owner operation directory required'}
$review=Split-Path $OperationDirectory -Parent
$planFile=Join-Path $OperationDirectory 'plan.json'
$journalFile=Join-Path $OperationDirectory 'journal.json'
$registryFile=Join-Path $root 'runtime\components.json'
$utf8=[Text.UTF8Encoding]::new($false)
function Read([string]$f){Get-Content -LiteralPath $f -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function Hash([string]$f){(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant()}
function Json($v){ConvertTo-Json -InputObject $v -Depth 60}
function Atomic([string]$f,[string]$s){$tmp=$f+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($tmp,$s,$utf8);Move-Item -LiteralPath $tmp -Destination $f -Force}
function Same($a,$b){(Json $a) -ceq (Json $b)}
function Require-NoLease {
 foreach($relative in @('jobs\state.json','read-sessions\business-full\state.json')){
  $f=Join-Path $root $relative
  if(Test-Path -LiteralPath $f){
   $state=Read $f
   foreach($lease in $state.remoteLeases.Values){if($lease.state -ceq 'leased' -and [DateTimeOffset]::Parse($lease.expiresAt) -gt [DateTimeOffset]::UtcNow){throw ('Active Workspace lease; maintenance not allowed: '+$lease.mode+' / '+$lease.correlationId+' / '+$lease.expiresAt)}}
  }
 }
}
. (Join-Path $PSScriptRoot 'Stop-WorkspaceOwnedRuntime.ps1')
$maintenance=Join-Path $PSScriptRoot '..\windows\Invoke-AiccUnifiedMaintenance.ps1'
$plan=Read $planFile
if($plan.status -cne 'PREPARED' -or (Test-Path -LiteralPath $journalFile)){throw 'Prior application must be reconciled; no replay'}
$gatewayArgs=Read (Join-Path $review 'gateway-maintenance-args.json')
if([DateTimeOffset]::Parse($gatewayArgs.OperationExpiresAt) -le [DateTimeOffset]::UtcNow){throw 'Operation expired; prepare a fresh operation without replaying any task'}
function Maintenance([string]$action,[string]$snapshot=''){
 $call=@{};foreach($key in $gatewayArgs.Keys){$call[$key]=$gatewayArgs[$key]}
 if($snapshot){$call.ReadySnapshotSha256=$snapshot}
 $raw=& $maintenance -Action $action @call
 if(-not $raw){throw ('Maintenance response absent: '+$action)}
 $result=($raw -join "`n")|ConvertFrom-Json -AsHashtable
 Atomic (Join-Path $OperationDirectory ('gateway-'+$action+'.json')) (Json $result)
 if($result.response.ok -cne $true){throw ('Maintenance refused: '+$action+' '+$result.response.error)}
 return $result.response
}
$lock=[IO.File]::Open($registryFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$profileLock=$null;$begun=$false;$disabled=$false;$stopped=$false;$startAttempted=$false;$beforeRegistry=$null
try {
 $profileLock=[IO.File]::Open($plan.profile+'.codex-cli-cutover.lock',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 $beforeRegistry=Read $registryFile
 if(-not(Same $beforeRegistry.components.workspace $plan.beforeWorkspace) -or -not(Same $beforeRegistry.components['unified-mcp'] $plan.beforeGateway)){throw 'Runtime component owner changed'}
 if((Hash $plan.config) -cne $plan.configBeforeSha256 -or (Hash $plan.profile) -cne $plan.profileBeforeSha256 -or (Hash $plan.desiredConfig) -cne $plan.desiredConfigSha256){throw 'Activation preimage changed'}
 if((Export-ScheduledTask -TaskName $plan.task).Trim() -cne ([IO.File]::ReadAllText((Join-Path $OperationDirectory 'task.before.xml'))).Trim()){throw 'Scheduled task changed'}
 Require-NoLease
 $owned=Get-WorkspaceOwnedRuntime business-full
 $all=@(Get-CimInstance Win32_Process);$byPid=@{};foreach($p in $all){$byPid[[int]$p.ProcessId]=$p}
 $ancestry=@();$cursor=[int]$PID
 while($cursor -gt 0 -and $cursor -notin $ancestry){$ancestry+=$cursor;$cursor=if($byPid.ContainsKey($cursor)){[int]$byPid[$cursor].ParentProcessId}else{0}}
 if(@($owned.processes.pid|Where-Object {$_ -in $ancestry}).Count){throw 'Current local executor depends on target; independent rescue READY is required'}
 $ownershipFile=Join-Path $OperationDirectory 'ownership.before-stop.json'
 Atomic $ownershipFile (Json $owned)
 Atomic (Join-Path $OperationDirectory 'execution-independence.json') (Json @{currentProcessAncestry=$ancestry;targetPids=@($owned.processes.pid);modelAndDesktopRoutesChanged=$false;scope='remote Workspace connector only';standbyServiceClaimed=$false})
 $journal=@{status='BEGIN_INTENT';startAttempts=0;rollbackStartAttempts=0;verification='NOT_RUN';operationId=$plan.operationId}
 Atomic $journalFile (Json $journal)
 $ready=Maintenance begin;$begun=$true
 if($ready.ready -cne $true -or $ready.providers.workspace.active -cne 0 -or $ready.providers.workspace.unknown -cne 0 -or $ready.providers.native.active -cne 0 -or $ready.providers.native.unknown -cne 0){throw 'Gateway has active or unknown work; no stop'}
 $consumed=Maintenance consume $ready.readySnapshotSha256
 if($consumed.consumedSnapshotSha256 -cne $ready.readySnapshotSha256){throw 'Exact gateway readiness was not consumed'}
 Require-NoLease
 $fresh=Get-WorkspaceOwnedRuntime business-full
 if(-not(Same $fresh $owned)){throw 'Owned process tree changed after drain'}
 if((Hash $plan.config) -cne $plan.configBeforeSha256 -or (Hash $plan.profile) -cne $plan.profileBeforeSha256){throw 'Preimage changed after drain'}
 $journal.status='PLANNED_MAINTENANCE_STOP_INTENT';Atomic $journalFile (Json $journal)
 Disable-ScheduledTask -TaskName $plan.task|Out-Null;$disabled=$true
 $stop=Stop-WorkspaceOwnedRuntime $owned
 if($stop.stopped -cne $true){throw 'Owned process stop result is unknown'}
 $stopped=$true;Stop-ScheduledTask -TaskName $plan.task
 $journal.status='STOPPED';Atomic $journalFile (Json $journal)
 $registry=Read $registryFile
 if(-not(Same $registry.components.workspace $plan.beforeWorkspace) -or -not(Same $registry.components['unified-mcp'] $plan.beforeGateway)){throw 'Component changed during stop'}
 $registry.components.workspace=@{entry=(Join-Path $plan.workspaceCandidate 'bin\aicc');runtime=$plan.beforeWorkspace.runtime;location='managed';releaseRoot=$plan.workspaceCandidate;previousRelease=$plan.beforeWorkspace.releaseRoot;recovery=$OperationDirectory}
 $registry.components['unified-mcp']=@{entry=(Join-Path $plan.gatewayCandidate 'gateway.cjs');entryHash=$plan.gatewayEntryHash;runtime=$plan.beforeGateway.runtime;location='managed';releaseRoot=$plan.gatewayCandidate;previousRelease=$plan.beforeGateway.releaseRoot;recovery=$OperationDirectory}
 $journal.status='APPLY_INTENT';Atomic $journalFile (Json $journal)
 Atomic $plan.config ([IO.File]::ReadAllText($plan.desiredConfig))
 Atomic $registryFile (Json $registry)
 Atomic $plan.profile ([IO.File]::ReadAllText((Join-Path $OperationDirectory 'profile.after.yaml')))
 $journal.status='START_INTENT';$journal.startAttempts=1;Atomic $journalFile (Json $journal);$startAttempted=$true
 Enable-ScheduledTask -TaskName $plan.task|Out-Null;Start-ScheduledTask -TaskName $plan.task
 $journal.status='START_ACCEPTED_RUNTIME_UNOBSERVED';Atomic $journalFile (Json $journal)
 $plan.status=$journal.status;Atomic $planFile (Json $plan)
 @{status=$journal.status;workspace=$plan.workspaceCandidate;gateway=$plan.gatewayCandidate;modelServicesRestarted=0;verification='NOT_RUN'}|ConvertTo-Json -Compress
}catch {
 $failure=$_.Exception.Message
 if($startAttempted){
  $journal.status='START_OUTCOME_UNKNOWN_RECONCILE';$journal.failure=$failure;Atomic $journalFile (Json $journal)
  throw ('Start was attempted once; reconcile this exact operation: '+$failure)
 }
 if($stopped){
  $registry=Read $registryFile
  foreach($name in @('workspace','unified-mcp')){$registry.components[$name]=$beforeRegistry.components[$name]}
  Atomic $plan.config ([IO.File]::ReadAllText((Join-Path $OperationDirectory 'config.before.json')))
  Atomic $registryFile (Json $registry)
  Atomic $plan.profile ([IO.File]::ReadAllText((Join-Path $OperationDirectory 'profile.before.yaml')))
  $journal.status='ROLLBACK_START_INTENT';$journal.rollbackStartAttempts=1;Atomic $journalFile (Json $journal)
  Enable-ScheduledTask -TaskName $plan.task|Out-Null;Start-ScheduledTask -TaskName $plan.task
  $journal.status='ROLLBACK_START_ACCEPTED_RUNTIME_UNOBSERVED';$journal.failure=$failure;Atomic $journalFile (Json $journal)
 }else{
  if($disabled){Enable-ScheduledTask -TaskName $plan.task|Out-Null}
  if($begun){$null=Maintenance resume}
  if($journal){$journal.status='NOT_APPLIED';$journal.failure=$failure;Atomic $journalFile (Json $journal)}
 }
 throw
}finally{
 if($profileLock){$profileLock.Dispose();Remove-Item -LiteralPath ($plan.profile+'.codex-cli-cutover.lock') -Force}
 $lock.Dispose()
}