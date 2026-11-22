#requires -Version 7.5
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidateSet('Prepare','Apply','Rollback')][string]$Mode,
 [Parameter(Mandatory)][string]$OperationDirectory,
 [string]$CandidateReceipt,
 [string]$ExpectedHelperSha256,
 [string]$ReadyFile,
 [string]$ExpectedPlanSha256,
 [switch]$UserConfirmedNoOtherWork
)
$ErrorActionPreference='Stop'
$stateRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$taskName='AgenticLab-AICC-Workspace-Tunnel'
$registryFile=Join-Path $stateRoot 'runtime\components.json'
$launcherFile=Join-Path $stateRoot 'workspace-mcp\runtime\aicc-workspace.hidden.ps1'
$receiptFile=Join-Path $stateRoot ('backups\workspace-tunnel-windows-task\'+$taskName+'.install.json')
. (Join-Path $PSScriptRoot '..\workspace-mcp\Stop-WorkspaceOwnedRuntime.ps1')
function Regular([string]$Path){
 $full=[IO.Path]::GetFullPath($Path);$item=Get-Item -LiteralPath $full -Force
 if($item.PSIsContainer -or $item.LinkType){throw 'A regular non-linked file is required'}
 for($parent=$item.Directory;$parent;$parent=$parent.Parent){if($parent.LinkType){throw 'Linked ancestor refused'}}
 return $full
}
function Hash([string]$Path){(Get-FileHash -LiteralPath (Regular $Path) -Algorithm SHA256).Hash.ToLowerInvariant()}
function Json($Value){ConvertTo-Json -InputObject $Value -Depth 60 -Compress}
function Read([string]$Path){Get-Content -LiteralPath (Regular $Path) -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function Same($Left,$Right){
 if($null -eq $Left -or $null -eq $Right){return ($null -eq $Left -and $null -eq $Right)}
 if($Left -is [Collections.IDictionary] -and $Right -is [Collections.IDictionary]){if($Left.Count -ne $Right.Count){return $false};foreach($key in $Left.Keys){if(-not $Right.Contains($key) -or -not (Same $Left[$key] $Right[$key])){return $false}};return $true}
 if($Left -is [array] -and $Right -is [array]){if($Left.Count -ne $Right.Count){return $false};for($i=0;$i -lt $Left.Count;$i++){if(-not (Same $Left[$i] $Right[$i])){return $false}};return $true}
 return (Json $Left) -ceq (Json $Right)
}
function New-Text([string]$Path,[string]$Text){$stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes($Text);$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}}
function Atomic([string]$Path,[string]$Text){$null=Regular $Path;$temp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp';New-Text $temp $Text;Move-Item -LiteralPath $temp -Destination $Path -Force}
$OperationDirectory=[IO.Path]::GetFullPath($OperationDirectory)
$allowedParent=(Join-Path $stateRoot 'asset-control').TrimEnd('\')+'\'
if(-not $OperationDirectory.StartsWith($allowedParent,[StringComparison]::OrdinalIgnoreCase)){throw 'Operation must stay within the existing asset-control owner directory'}
if($Mode -eq 'Prepare'){
 if(Test-Path -LiteralPath $OperationDirectory){throw 'Operation directory already exists; reconcile it'}
 if(-not $UserConfirmedNoOtherWork -or -not $env:CODEX_THREAD_ID){throw 'Current task and explicit no-other-work confirmation required'}
 $candidate=Read $CandidateReceipt;$registry=Read $registryFile;$beforeHost=$registry.components['workspace-host']
 $candidateRoot=[IO.Path]::GetFullPath($candidate.host);$hosts=(Join-Path $stateRoot 'releases\workspace-host').TrimEnd('\')+'\'
 if(-not $candidateRoot.StartsWith($hosts,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $candidateRoot).LinkType){throw 'Unowned candidate host'}
 $entryRelative='tools\platform\workspace-mcp\windows-tunnel-secret.mjs'
 $entry=Join-Path $candidateRoot $entryRelative
 if((Hash $entry) -cne $ExpectedHelperSha256 -or (Hash $beforeHost.entry) -cne $beforeHost.entryHash){throw 'Helper fingerprint differs'}
 $beforeKeys=@($beforeHost.sourceHashes.Keys|ForEach-Object {$_.Replace('/','\')}|Sort-Object)
 $afterKeys=@($candidate.sourceHashes.Keys|ForEach-Object {$_.Replace('/','\')}|Sort-Object)
 if(-not (Same $beforeKeys $afterKeys)){throw 'Helper dependency set differs'}
 foreach($key in $candidate.sourceHashes.Keys){
  $relative=$key.Replace('/','\');$oldKey=@($beforeHost.sourceHashes.Keys|Where-Object {$_.Replace('/','\') -ceq $relative})[0]
  $next=[IO.Path]::GetFullPath((Join-Path $candidateRoot $relative));$old=[IO.Path]::GetFullPath((Join-Path $beforeHost.releaseRoot $relative))
  if(-not $next.StartsWith($candidateRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $old.StartsWith($beforeHost.releaseRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Helper dependency outside its host'}
  if((Hash $next) -cne $candidate.sourceHashes[$key] -or (Hash $old) -cne $beforeHost.sourceHashes[$oldKey]){throw 'Helper dependency fingerprint differs'}
  if($relative -cne $entryRelative -and $candidate.sourceHashes[$key] -cne $beforeHost.sourceHashes[$oldKey]){throw 'Changes outside the helper are refused'}
 }
 $task=Get-ScheduledTask -TaskName $taskName
 if(-not $task.Settings.Enabled -or $task.State -ne 'Running'){throw 'Expected enabled, running Task required'}
 $ownership=Get-WorkspaceOwnedRuntime 'business-full'
 $beforeLauncher=[IO.File]::ReadAllText((Regular $launcherFile))
 if($beforeLauncher.Split($beforeHost.entry,[StringSplitOptions]::None).Count -ne 2){throw 'Exact helper launcher reference required'}
 $beforeReceipt=Read $receiptFile
 if($beforeReceipt.helperSha256 -cne $beforeHost.entryHash -or $beforeReceipt.launcherSha256 -cne (Hash $launcherFile)){throw 'Install receipt differs'}
 $null=New-Item -ItemType Directory -Path $OperationDirectory
 foreach($pair in @(@('registry',$registryFile),@('launcher',$launcherFile),@('task-receipt',$receiptFile))){Copy-Item -LiteralPath $pair[1] -Destination (Join-Path $OperationDirectory ($pair[0]+'.before'))}
 New-Text (Join-Path $OperationDirectory 'task.before.xml') (Export-ScheduledTask -TaskName $taskName)
 $afterHost=Read (Join-Path $OperationDirectory 'registry.before');$afterHost=$afterHost.components['workspace-host']
 $afterHost.releaseRoot=$candidateRoot;$afterHost.entry=$entry;$afterHost.entryHash=$ExpectedHelperSha256;$afterHost.sourceHashes=$candidate.sourceHashes;$afterHost.recovery=$OperationDirectory
 $plan=@{schemaVersion=1;owner_task_id=$env:CODEX_THREAD_ID;request_id='workspace-helper-'+[guid]::NewGuid().ToString('N');challenge=[guid]::NewGuid().ToString('N');target=$taskName;expires_at=[DateTimeOffset]::UtcNow.AddMinutes(30).ToString('o');allowed_recovery=@('restore-helper-preimages-with-component-cas','restore-original-task-enabled-state','start-original-task-once-after-owned-runtime-stopped');rollback_ref=$OperationDirectory;scriptSha256=(Hash $PSCommandPath);ownership=$ownership;activeCount=$null;unknownCount=$null;lastResult='UNCONFIRMED_PRESERVED';userConfirmation='현재 실행 중인 작업 없음';stopMode='planned-maintenance-stop';beforeHost=$beforeHost;afterHost=$afterHost;candidateReceipt=(Regular $CandidateReceipt);candidateReceiptSha256=(Hash $CandidateReceipt);files=@{registry=$registryFile;launcher=$launcherFile;receipt=$receiptFile};beforeHashes=@{registry=(Hash $registryFile);launcher=(Hash $launcherFile);receipt=(Hash $receiptFile)};taskEnabled=$true;taskXmlSha256=(Hash (Join-Path $OperationDirectory 'task.before.xml'))}
 New-Text (Join-Path $OperationDirectory 'plan.json') (Json $plan)
 New-Text (Join-Path $OperationDirectory 'journal.json') (Json @{phase='PREPARED';request_id=$plan.request_id;startAttempts=0;rollbackStartAttempts=0})
 @{status='PREPARED_NOT_APPLIED';planFile=(Join-Path $OperationDirectory 'plan.json');planSha256=(Hash (Join-Path $OperationDirectory 'plan.json'));request_id=$plan.request_id;challenge=$plan.challenge;expires_at=$plan.expires_at}|ConvertTo-Json -Compress
 exit
}
$null=Regular (Join-Path $OperationDirectory 'plan.json')
$lock=[IO.File]::Open((Join-Path $OperationDirectory 'operation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
 $plan=Read (Join-Path $OperationDirectory 'plan.json');$journalFile=Join-Path $OperationDirectory 'journal.json';$journal=Read $journalFile
 if((Hash (Join-Path $OperationDirectory 'plan.json')) -cne $ExpectedPlanSha256 -or (Hash $PSCommandPath) -cne $plan.scriptSha256){throw 'Prepared operation changed'}
 if($Mode -eq 'Rollback'){
  if($journal.phase -in @('PREPARED','ROLLED_BACK','ROLLBACK_START_INTENT')){throw 'Rollback is not applicable or its start result requires reconciliation'}
  Disable-ScheduledTask -TaskName $taskName|Out-Null
  $running=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -and ($_.CommandLine.Contains($plan.afterHost.entry) -or $_.CommandLine.Contains($plan.beforeHost.entry))})
  if($running.Count){throw 'A helper is running; read ownership and request a separate exact stop before rollback'}
  $ownedIds=@($plan.ownership.processes.pid)
  if(@(Get-CimInstance Win32_Process|Where-Object {$_.ProcessId -in $ownedIds -and $_.CreationDate.ToUniversalTime().Ticks.ToString() -in @($plan.ownership.processes.created)}).Count){throw 'Original runtime is still running'}
  $registry=Read $registryFile
  if(-not (Same $registry.components['workspace-host'] $plan.afterHost) -and -not (Same $registry.components['workspace-host'] $plan.beforeHost)){throw 'Host changed outside this operation'}
  $registry.components['workspace-host']=$plan.beforeHost
  $launcher=[IO.File]::ReadAllText((Regular $launcherFile));$before=[IO.File]::ReadAllText((Regular (Join-Path $OperationDirectory 'launcher.before')));$after=$before.Replace($plan.beforeHost.entry,$plan.afterHost.entry)
  if($launcher -cne $before -and $launcher -cne $after){throw 'Launcher changed outside this operation'}
  $receipt=Read $receiptFile;$original=Read (Join-Path $OperationDirectory 'task-receipt.before')
  if($receipt.helperSha256 -cnotin @($plan.beforeHost.entryHash,$plan.afterHost.entryHash)){throw 'Task receipt changed outside this operation'}
  $receipt.helperSha256=$original.helperSha256;$receipt.launcherSha256=$original.launcherSha256
  Atomic $registryFile (Json $registry);Atomic $launcherFile $before;Atomic $receiptFile (Json $receipt)
  Stop-ScheduledTask -TaskName $taskName
  if($journal.rollbackStartAttempts -ne 0){throw 'Rollback start already attempted; reconcile instead of replay'}
  $journal.phase='ROLLBACK_START_INTENT';$journal.rollbackStartAttempts=1;Atomic $journalFile (Json $journal)
  Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
  $journal.phase='ROLLED_BACK_START_ACCEPTED';Atomic $journalFile (Json $journal)
  @{status='ROLLED_BACK_START_ACCEPTED';request_id=$plan.request_id}|ConvertTo-Json -Compress
  exit
 }
 if($journal.phase -cne 'PREPARED'){throw 'Apply already attempted; reconcile instead of replay'}
 if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($plan.expires_at)){throw 'Plan expired'}
 $ready=Read $ReadyFile
 foreach($key in @('owner_task_id','request_id','challenge','target','rollback_ref')){if($ready[$key] -cne $plan[$key]){throw ('Independent READY mismatch: '+$key)}}
 if($ready.status -cne 'READY' -or -not (Same $ready.allowed_recovery $plan.allowed_recovery) -or $ready.independent -cne $true -or [DateTimeOffset]::Parse($ready.expires_at) -gt [DateTimeOffset]::Parse($plan.expires_at) -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($ready.expires_at)){throw 'Independent READY is absent or expired'}
 if((Hash $plan.candidateReceipt) -cne $plan.candidateReceiptSha256 -or (Hash $plan.afterHost.entry) -cne $plan.afterHost.entryHash){throw 'Candidate changed'}
 foreach($key in @('registry','launcher','receipt')){if((Hash $plan.files[$key]) -cne $plan.beforeHashes[$key]){throw ('Live preimage changed: '+$key)}}
 foreach($pair in @(@('registry',$registryFile),@('launcher',$launcherFile),@('task-receipt',$receiptFile))){if((Hash (Join-Path $OperationDirectory ($pair[0]+'.before'))) -cne (Hash $pair[1])){throw 'Recovery preimage differs'}}
 if((Export-ScheduledTask -TaskName $taskName).Trim() -cne ([IO.File]::ReadAllText((Regular (Join-Path $OperationDirectory 'task.before.xml')))).Trim()){throw 'Task definition changed'}
 $fresh=Get-WorkspaceOwnedRuntime 'business-full';if(-not (Same $fresh $plan.ownership)){throw 'Runtime ownership changed; prepare a new operation'}
 $journal.phase='MAINTENANCE_STOP_INTENT';Atomic $journalFile (Json $journal)
 Disable-ScheduledTask -TaskName $taskName|Out-Null
 $stopped=Stop-WorkspaceOwnedRuntime $plan.ownership
 if($stopped.stopped -cne $true){throw 'Owned runtime stop was not confirmed'}
 Stop-ScheduledTask -TaskName $taskName
 $journal.phase='STOPPED';Atomic $journalFile (Json $journal)
 foreach($key in @('registry','launcher','receipt')){if((Hash $plan.files[$key]) -cne $plan.beforeHashes[$key]){throw 'Preimage changed during stop'}}
 $registry=Read $registryFile;$registry.components['workspace-host']=$plan.afterHost
 $launcher=[IO.File]::ReadAllText((Regular $launcherFile)).Replace($plan.beforeHost.entry,$plan.afterHost.entry)
 $receipt=Read $receiptFile;$receipt.helperSha256=$plan.afterHost.entryHash
 $receipt.launcherSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($launcher))).ToLowerInvariant()
 $journal.phase='APPLY_INTENT';Atomic $journalFile (Json $journal)
 Atomic $registryFile (Json $registry);Atomic $launcherFile $launcher;Atomic $receiptFile (Json $receipt)
 $journal.phase='START_INTENT';$journal.startAttempts=1;Atomic $journalFile (Json $journal)
 Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
 $journal.phase='START_ACCEPTED';Atomic $journalFile (Json $journal)
 @{status='START_ACCEPTED_RUNTIME_UNOBSERVED';request_id=$plan.request_id;host=$plan.afterHost.releaseRoot;recovery=$OperationDirectory}|ConvertTo-Json -Compress
}finally{$lock.Dispose()}