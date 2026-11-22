#requires -Version 7.5
# Owner-local lifecycle manager, not part of the already installed immutable worker.
# Nothing here settles historical requests, transfers a live CLI owner, or sends a model turn.
function GroupActivation-LoadInstall([string]$InstalledPlanFile){
 $p=Maintenance-Read $InstalledPlanFile
 if($p.schemaVersion -ne 1 -or $p.kind -cne 'aicc-group-owner-installer' -or
    $p.action -cne 'InstallGroupOwnerStopped'){throw 'activation_exact_group_install_required'}
 GroupInstall-RequireOwner $p.stateRoot
 GroupInstall-PlanScope $p.stateRoot $InstalledPlanFile
 $receiptFile=$InstalledPlanFile+'.receipt.json'
 $r=Maintenance-Read $receiptFile
 if($r.schemaVersion -ne 1 -or $r.kind -cne 'aicc-group-owner-install-receipt' -or
    $r.state -cne 'INSTALLED_STOPPED' -or $r.operationId -cne $p.operationId -or
    $r.planSha256 -cne (Maintenance-Hash $InstalledPlanFile) -or
    $r.threadId -cne $p.thread.threadId -or $r.helperSha256 -cne $p.files['tools/platform/windows/Invoke-AiccCodexContinuity.ps1'] -or
    [IO.Path]::GetFullPath([string]$r.releaseRoot) -ine [IO.Path]::GetFullPath([string]$p.releaseRoot) -or
    $r.stopFencePreserved -cne $true -or $r.workerStarted -cne $false -or
    $r.afterRegistrySha256 -cnotmatch '^[a-f0-9]{64}$' -or $r.afterTaskSha256 -cnotmatch '^[a-f0-9]{64}$'){
  throw 'activation_installed_receipt_mismatch'
 }
 @{plan=$p;receipt=$r;installPlanFile=[IO.Path]::GetFullPath($InstalledPlanFile);installPlanSha256=(Maintenance-Hash $InstalledPlanFile);installReceiptSha256=(Maintenance-Hash $receiptFile)}
}
function GroupActivation-AssertBundle($bundle,$cfg){
 $p=$bundle.plan;$r=$bundle.receipt
 if($cfg.protocolVersion -ne 3 -or $cfg.nativeFallback -cne $false -or
    $cfg.helperSha256 -cne $r.helperSha256 -or
    [IO.Path]::GetFullPath([string]$cfg.helperPath) -ine [IO.Path]::GetFullPath((Join-Path $p.releaseRoot 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1')) -or
    $cfg.codexSha256 -cne $cfg.strictRouteLauncher.codexSha256 -or
    [IO.Path]::GetFullPath([string]$cfg.strictRouteLauncher.releaseRoot) -ine [IO.Path]::GetFullPath([string]$p.releaseRoot)){
  throw 'activation_installed_route_or_helper_changed'
 }
 if($p.files.Count -lt 4 -or $cfg.strictRouteLauncher.files.Count -ne $p.files.Count){throw 'activation_closure_incomplete'}
 foreach($relative in $p.files.Keys){
  if([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':') -or $relative -match '(^|[\\/])\.\.([\\/]|$)' -or
     $cfg.strictRouteLauncher.files[$relative] -cne $p.files[$relative]){throw 'activation_closure_pin_changed'}
  $file=[IO.Path]::GetFullPath((Join-Path $p.releaseRoot $relative))
  GroupInstall-SafeFile $file $p.releaseRoot $p.files[$relative]
 }
 if((Maintenance-Hash $cfg.codexExecutable) -cne $cfg.codexSha256 -or
    (Maintenance-Hash $p.nodePath) -cne $p.nodeSha256 -or (Maintenance-Hash $p.pwshPath) -cne $p.pwshSha256){
  throw 'activation_current_runtime_pin_changed'
 }
}
function GroupActivation-OwnerProof($cfg,[string]$StateRoot){
 # Use the pinned installed helper's exact terminal, recovered-CLI, source
 # writer, issuer, strict quota, route and freshness checks without dispatch.
 . $cfg.helperPath -Action Status -StateRoot $StateRoot
 $script:registry=$cfg
 $clone=($cfg|ConvertTo-Json -Depth 30 -Compress)|ConvertFrom-Json -AsHashtable -DateKind String
 $clone.workerStopRequestedAt=$null # preview-only copy; never update live registry
 $g=$clone.groupOwner
 Get-GroupOwnerProof $clone $false $g.threadId 2 $g.eventId $g.eventSha256 $g.resultSha256 $StateRoot
}
function GroupActivation-TaskXml([string]$PriorXml,[bool]$Enabled){
 $doc=[xml]$PriorXml
 $node=$doc.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="Settings"]/*[local-name()="Enabled"]')
 if(-not $node -or [string]$node.InnerText -cnotin @('true','false')){throw 'activation_exact_task_enabled_element_required'}
 if($Enabled -and $node.InnerText -cne 'false'){throw 'activation_task_already_enabled'}
 if(-not $Enabled -and $node.InnerText -cne 'true'){throw 'activation_task_not_enabled'}
 $node.InnerText=if($Enabled){'true'}else{'false'}
 $doc.OuterXml
}
function GroupActivation-TaskGuardedShape([string]$Text){
 $doc=[xml]$Text
 $enabled=$doc.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="Settings"]/*[local-name()="Enabled"]')
 if(-not $enabled -or [string]$enabled.InnerText -cnotin @('true','false')){throw 'activation_task_shape_unknown'}
 $enabled.InnerText='false'
 $doc.OuterXml
}
function GroupActivation-Readiness($bundle,$cfg,[string]$StateRoot){
 $p=$bundle.plan;$r=$bundle.receipt
 $out=@{schemaVersion=1;kind='aicc-group-activation-status';state='BLOCKED';reason='UNVERIFIED';
  activationSupported=$true;installedState='INSTALLED_STOPPED';workerState='STOPPED_FOR_MAINTENANCE';
  threadId=$r.threadId;ownerTransferSupported=$false;automaticReplay=$false;modelRequests=0;pendingCount=0}
 # Global pending must be resolved by the original issuer, never exempted.
 $pending=@($cfg.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt})
 $out.pendingCount=$pending.Count
 if($pending.Count){
  $historical=@($pending|Where-Object {$_.queueAttempt -and $_.queueAttempt.state -ceq 'QUEUE_ACCEPTED'}).Count
  $out.reason=if($historical){'HISTORICAL_QUEUE_ACCEPTED_UNSETTLED'}else{'GLOBAL_PENDING_DELIVERY_UNSETTLED'}
  # Read-only original-issuer checklist; no implicit settlement or owner handoff.
  $out.pendingResolution=@{status='ISSUER_SETTLEMENT_NOT_RECORDED';
   historicalQueueAccepted=$historical;otherPending=($pending.Count-$historical);
   nextActor='ORIGINAL_ISSUER';officialOriginalResultRequired=$true;
   ownerHandoffChecked=$false;automaticReplay=$false}
  return $out
 }
 if(-not $cfg.workerStopRequestedAt -or $cfg.worker.state -cne 'STOPPED_FOR_MAINTENANCE'){
  $out.reason='STOP_FENCE_OR_EXIT_STATE_CHANGED';return $out
 }
 $e=$cfg.threads[$r.threadId];$g=$cfg.groupOwner
 if(-not $e -or $e.groupOwnerOnly -cne $true -or $e.strictAccount -ne 2 -or
    $e.threadId -cne $p.thread.threadId -or
    [IO.Path]::GetFullPath([string]$e.projectRoot) -ine [IO.Path]::GetFullPath([string]$p.thread.projectRoot) -or
    [IO.Path]::GetFullPath([string]$e.rollout) -ine [IO.Path]::GetFullPath([string]$p.thread.rollout) -or
    $e.groupOwnerRevision -cne $p.ownerRevision -or [string]$e.groupStopEpoch -cne [string]$p.stopEpoch -or
    $e.groupWorkerOperationId -cne $p.workerOperationId -or $e.groupStopRevokedAt -or
    $e.enabled -cne $false -or $e.groupEvent -or $e.holdReason -or $e.state -match 'UNKNOWN|UNCERTAIN|HOLD|COMPLETE|RESUMING_OCX'){
  $out.reason='GROUP_THREAD_OR_STOP_EPOCH_CHANGED';return $out
 }
 if(@($cfg.threads.Values|Where-Object {$_.enabled -eq $true}).Count){$out.reason='OTHER_ENABLED_THREAD_HOLD';return $out}
 if(-not $g){$out.reason='FRESH_OWNER_AUTHORISATION_REQUIRED';return $out}
 if($g.threadId -cne $r.threadId -or $g.ownerRevision -cne $p.ownerRevision -or
    [string]$g.stopEpoch -cne [string]$p.stopEpoch -or $g.workerOperationId -cne $p.workerOperationId){
  $out.reason='OWNER_GENERATION_OR_ISSUER_CHANGED';return $out
 }
 try{
  GroupInstall-AssertNoGroupMarkers $StateRoot
  GroupActivation-AssertBundle $bundle $cfg
  $task=GroupInstall-TaskSnapshot $StateRoot
  $expectedVbs=Join-Path $p.releaseRoot 'worker.hidden.vbs'
  if($task.oldTaskState -cne 'Disabled' -or $task.xmlSha256 -cne $r.afterTaskSha256 -or
     [IO.Path]::GetFullPath([string]$task.oldVbs) -ine [IO.Path]::GetFullPath($expectedVbs) -or
     $task.oldVbsSha256 -cne (Maintenance-Hash $expectedVbs) -or $task.taskName -cne $r.taskName){
   $out.reason='INSTALLED_DISABLED_TASK_CAS_CHANGED';return $out
  }
  $proof=GroupActivation-OwnerProof $cfg $StateRoot
  if($proof.state -cne 'READY'){
   $out.reason=if($proof.state -ceq 'ORIGINAL_WRITER_NOT_RELEASED'){'ORIGINAL_OWNER_ALIVE_NO_OFFICIAL_HANDOFF'}else{[string]$proof.state}
   return $out
  }
  $out.state='READY_FOR_ACTIVATION';$out.reason='EXACT_PREVIEW_NO_DISPATCH'
  $out.registrySha256=Maintenance-Hash (Join-Path $StateRoot 'registrations.json')
  $out.taskSha256=$task.xmlSha256
  $out.eventId=$g.eventId
  $out.ownerRevision=$g.ownerRevision
  $out.stopEpoch=$g.stopEpoch
  $out.workerOperationId=$g.workerOperationId
  $out.proofDigest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $proof
  return $out
 }catch{
  $out.reason='ACTIVATION_PROOF_UNVERIFIED'
  $out.errorCode=$_.Exception.Message
  return $out
 }
}
function Get-AiccGroupActivationStatus{
 param([string]$InstalledPlanFile)
 $out=@{schemaVersion=1;kind='aicc-group-activation-status';activationSupported=$true;
  state='BLOCKED';reason='INSTALL_NOT_VERIFIED';automaticReplay=$false;modelRequests=0}
 try{
  $bundle=GroupActivation-LoadInstall $InstalledPlanFile
  $file=Join-Path $bundle.plan.stateRoot 'registrations.json'
  $cfg=Maintenance-Read $file
  if(-not $cfg.workerStopRequestedAt){
   $out.state='ACTIVATION_STARTED_UNVERIFIED'
   $out.reason='LIVE_WORKER_READBACK_REQUIRED'
   $out.installedState='INSTALLED_STOPPED_THEN_ACTIVATION_ATTEMPTED'
   $out.workerState=[string]$cfg.worker.state
   $out.threadId=$bundle.receipt.threadId
   if($cfg.worker.state -ceq 'WATCHING' -and $cfg.worker.pid -gt 0){
    $out.state='WORKER_RUNNING_UNVERIFIED'
    $out.reason='TASK_AND_PROCESS_IDENTITY_READBACK_REQUIRED'
   }
   return $out
  }
  $lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $bundle.plan.stateRoot
  $fence=$null
  try{
   $cfg=Maintenance-Read $file
   $fence=& $script:PinModule {param($c,$s)Enter-PinMaintenanceFence $c $s} $cfg $bundle.plan.stateRoot
   if(-not $fence){throw 'stopped_worker_exclusion_unconfirmed'}
   return GroupActivation-Readiness $bundle $cfg $bundle.plan.stateRoot
  }finally{if($fence){$fence.Dispose()};$lock.Dispose()}
 }catch{$out.reason=$_.Exception.Message;return $out}
}
function New-AiccGroupActivationPlan{
 param([string]$InstalledPlanFile,[string]$PlanFile)
 $bundle=GroupActivation-LoadInstall $InstalledPlanFile
 GroupInstall-PlanScope $bundle.plan.stateRoot $PlanFile
 if([IO.Path]::GetFullPath($InstalledPlanFile) -ieq [IO.Path]::GetFullPath($PlanFile)){throw 'new_activation_plan_required'}
 $state=$bundle.plan.stateRoot;$registry=Join-Path $state 'registrations.json'
 $lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $state
 $fence=$null
 try{
  $cfg=Maintenance-Read $registry
  if(-not $cfg.workerStopRequestedAt){
   return @{state='BLOCKED';reason='STOP_FENCE_NOT_PRESENT';activationSupported=$true;modelRequests=0}
  }
  $fence=& $script:PinModule {param($c,$s)Enter-PinMaintenanceFence $c $s} $cfg $state
  if(-not $fence){throw 'worker_exit_unproven'}
  $status=GroupActivation-Readiness $bundle $cfg $state
  if($status.state -cne 'READY_FOR_ACTIVATION'){return $status}
  $plan=@{schemaVersion=1;kind='aicc-group-activation-plan';action='ActivateStoppedGroupOwner';
   operationId=[guid]::NewGuid().ToString();installedPlanFile=$bundle.installPlanFile;
   installedPlanSha256=$bundle.installPlanSha256;installedReceiptSha256=$bundle.installReceiptSha256;
   stateRoot=$state;registrySha256=$status.registrySha256;taskSha256=$status.taskSha256;
   proofDigest=$status.proofDigest;threadId=$status.threadId;eventId=$status.eventId;
   ownerRevision=$status.ownerRevision;stopEpoch=$status.stopEpoch;workerOperationId=$status.workerOperationId;
   expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(90).ToString('o')}
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($plan|ConvertTo-Json -Depth 12)+[Environment]::NewLine)
  $stream=[IO.File]::Open($PlanFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
  @{state='PREPARED';activationSupported=$true;planFile=$PlanFile;planSha256=(Maintenance-Hash $PlanFile);
    confirm='ACTIVATE GROUP OWNER '+(Maintenance-Hash $PlanFile);stopFenceCleared=$false;
    taskChanged=$false;workerStarted=$false;modelRequests=0}
 }finally{if($fence){$fence.Dispose()};$lock.Dispose()}
}
function GroupActivation-RequirePlan([string]$PlanFile,[string]$ExpectedSha,[string]$Confirm){
 if($ExpectedSha -cnotmatch '^[a-f0-9]{64}$' -or (Maintenance-Hash $PlanFile) -cne $ExpectedSha -or
    $Confirm -cne ('ACTIVATE GROUP OWNER '+$ExpectedSha)){throw 'activation_exact_preview_confirmation_required'}
 $plan=Maintenance-Read $PlanFile
 if($plan.schemaVersion -ne 1 -or $plan.kind -cne 'aicc-group-activation-plan' -or
    $plan.action -cne 'ActivateStoppedGroupOwner' -or
    $plan.operationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    [DateTimeOffset]::Parse([string]$plan.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'activation_plan_expired_or_changed'}
 GroupInstall-RequireOwner $plan.stateRoot
 GroupInstall-PlanScope $plan.stateRoot $PlanFile
 $bundle=GroupActivation-LoadInstall $plan.installedPlanFile
 if($bundle.installPlanSha256 -cne $plan.installedPlanSha256 -or
    $bundle.installReceiptSha256 -cne $plan.installedReceiptSha256 -or
    [IO.Path]::GetFullPath([string]$bundle.plan.stateRoot) -ine [IO.Path]::GetFullPath([string]$plan.stateRoot)){
  throw 'activation_installed_receipt_cas_changed'
 }
 @{plan=$plan;bundle=$bundle}
}
function Invoke-AiccGroupActivationPlan{
 param([string]$PlanFile,[string]$ExpectedPlanSha256,[string]$Confirm)
 $input=GroupActivation-RequirePlan $PlanFile $ExpectedPlanSha256 $Confirm
 $p=$input.plan;$bundle=$input.bundle;$state=$p.stateRoot;$registry=Join-Path $state 'registrations.json'
 $lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $state
 $fence=$null;$taskMutation=$false;$postTask=$null;$committed=$false
 $beforeTask=$null;$receipt=$null
 try{
  $cfg=Maintenance-Read $registry
  $fence=& $script:PinModule {param($c,$s)Enter-PinMaintenanceFence $c $s} $cfg $state
  if(-not $fence){throw 'activation_worker_exit_unproven'}
  $ready=GroupActivation-Readiness $bundle $cfg $state
  if($ready.state -cne 'READY_FOR_ACTIVATION'){throw ('activation_blocked:'+ $ready.reason)}
  foreach($k in @('registrySha256','taskSha256','proofDigest','threadId','eventId','ownerRevision','stopEpoch','workerOperationId')){
   if([string]$ready[$k] -cne [string]$p[$k]){throw ('activation_preview_cas_changed:'+ $k)}
  }
  $task=GroupInstall-TaskSnapshot $state
  $claim=[IO.File]::Open($PlanFile+'.claimed',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $claim.Dispose()
  $beforeRegistry=$PlanFile+'.before-registry.json'
  $backup=[IO.File]::Open($beforeRegistry,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$bytes=[IO.File]::ReadAllBytes($registry);$backup.Write($bytes);$backup.Flush($true)}finally{$backup.Dispose()}
  if((Maintenance-Hash $beforeRegistry) -cne $p.registrySha256){throw 'activation_registry_backup_changed'}
  $beforeTask=$PlanFile+'.before-task.xml'
  $taskStream=[IO.File]::Open($beforeTask,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$taskBytes=[Text.UTF8Encoding]::new($false).GetBytes($task.xml);$taskStream.Write($taskBytes);$taskStream.Flush($true)}finally{$taskStream.Dispose()}
  if((GroupInstall-HashText ([IO.File]::ReadAllText($beforeTask))) -cne $p.taskSha256){throw 'activation_task_backup_changed'}
  $enabled=GroupActivation-TaskXml $task.xml $true
  $taskMutation=$true
  Register-ScheduledTask -TaskName $bundle.receipt.taskName -Xml $enabled -Force -ErrorAction Stop|Out-Null
  $postTask=GroupInstall-TaskSnapshot $state
  if($postTask.oldTaskState -cne 'Ready' -or $postTask.oldVbs -ine $task.oldVbs -or
     $postTask.oldVbsSha256 -cne $task.oldVbsSha256){throw 'activation_task_readback_changed'}
  if((GroupActivation-TaskGuardedShape $postTask.xml) -cne (GroupActivation-TaskGuardedShape $task.xml)){
   throw 'activation_task_unexpected_fields_changed'}
  if((Maintenance-Hash $registry) -cne $p.registrySha256){throw 'activation_registry_cas_changed'}
  $cfg.workerStopRequestedAt=$null
  $cfg.worker=@{pid=0;state='ACTIVATION_START_PENDING';noNative=$true;operationId=$p.operationId}
  $temp=$registry+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temp,($cfg|ConvertTo-Json -Depth 30)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temp,$registry,$true)
  $committed=$true
  $afterSha=Maintenance-Hash $registry
  $postCfg=Maintenance-Read $registry
  if($postCfg.workerStopRequestedAt -or $postCfg.worker.state -cne 'ACTIVATION_START_PENDING' -or
     [string]$postCfg.threads[$p.threadId].groupStopEpoch -cne [string]$p.stopEpoch){throw 'activation_commit_readback_hold'}
  $receipt=@{schemaVersion=1;kind='aicc-group-activation-receipt';state='ACTIVATED_PRESTART';
   operationId=$p.operationId;planSha256=$ExpectedPlanSha256;
   beforeRegistrySha256=$p.registrySha256;afterRegistrySha256=$afterSha;
   beforeTaskSha256=$p.taskSha256;afterTaskSha256=$postTask.xmlSha256;
   beforeRegistryFile=$beforeRegistry;beforeTaskFile=$beforeTask;stopEpoch=$p.stopEpoch;
   taskName=$bundle.receipt.taskName;threadId=$p.threadId;eventId=$p.eventId;
   modelRequests=0;workerStartConfirmed=$false;automaticReplay=$false}
  [IO.File]::WriteAllText($PlanFile+'.receipt.json',($receipt|ConvertTo-Json -Depth 10)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
 }catch{
  $failure=$_.Exception.Message
  $partial=@{state='PARTIAL_HOLD';failure=$failure;registryCommitted=$committed;taskMutation=$taskMutation;modelRequests=0;selfRestore='NOT_ATTEMPTED'}
  if($taskMutation -and -not $committed -and $beforeTask -and
     (Maintenance-Hash $registry) -ceq $p.registrySha256){
   try{
    $current=GroupInstall-TaskSnapshot $state
    if($current.xmlSha256 -ceq $p.taskSha256){$partial.selfRestore='ORIGINAL_TASK_UNCHANGED'}
    elseif($postTask -and $current.xmlSha256 -ceq $postTask.xmlSha256 -and $current.oldTaskState -ceq 'Ready'){
     Register-ScheduledTask -TaskName $bundle.receipt.taskName -Xml ([IO.File]::ReadAllText($beforeTask)) -Force -ErrorAction Stop|Out-Null
     $restored=GroupInstall-TaskSnapshot $state
     if($restored.xmlSha256 -cne $p.taskSha256 -or $restored.oldTaskState -cne 'Disabled'){throw 'activation_partial_task_restore_unverified'}
     $partial.selfRestore='EXACT_TASK_RESTORED'
    }else{$partial.selfRestore='TASK_CAS_UNKNOWN'}
   }catch{$partial.selfRestore='TASK_RESTORE_HOLD'}
  }
  try{
   $s=[IO.File]::Open($PlanFile+'.partial.json',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
   try{$b=[Text.UTF8Encoding]::new($false).GetBytes(($partial|ConvertTo-Json -Depth 7)+[Environment]::NewLine);$s.Write($b);$s.Flush($true)}finally{$s.Dispose()}
  }catch{}
  throw
 }finally{if($fence){$fence.Dispose()};$lock.Dispose()}
 # Starting while holding worker.lock would silently discard the new worker.
 # A second exact readback prevents starting a task after an intervening stop.
 try{
  if((Maintenance-Hash $registry) -cne $receipt.afterRegistrySha256){throw 'activation_post_commit_registry_changed'}
  $task=GroupInstall-TaskSnapshot $state
  if($task.xmlSha256 -cne $receipt.afterTaskSha256 -or $task.oldTaskState -cne 'Ready'){throw 'activation_post_commit_task_changed'}
  Start-ScheduledTask -TaskName $receipt.taskName -ErrorAction Stop
  $start=@{state='ACTIVATION_START_SUBMITTED';operationId=$p.operationId;
   taskEnabled=$true;stopFenceCleared=$true;workerStartConfirmed=$false;
   groupEventEnqueued=$false;modelRequests=0;automaticReplay=$false;
   next='InspectGroupActivation and verify exact running worker before GroupEnqueue'}
  [IO.File]::WriteAllText($PlanFile+'.start.json',($start|ConvertTo-Json -Depth 8)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  return $start
 }catch{
  $failure=@{state='PARTIAL_HOLD';reason='ACTIVATION_TASK_START_OR_READBACK_UNVERIFIED';
   errorCode=$_.Exception.Message;operationId=$p.operationId;
   registryMayBeActive=$true;taskMayBeActive=$true;modelRequests=0;automaticReplay=$false;
   next='Inspect exact Task, worker and registry; do not replay apply'}
  try{[IO.File]::WriteAllText($PlanFile+'.start-hold.json',($failure|ConvertTo-Json -Depth 8)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))}catch{}
  return $failure
 }
}
function Undo-AiccGroupActivationPlan{
 param([string]$PlanFile,[string]$Confirm)
 $p=Maintenance-Read $PlanFile
 GroupInstall-RequireOwner $p.stateRoot
 GroupInstall-PlanScope $p.stateRoot $PlanFile
 $r=Maintenance-Read ($PlanFile+'.receipt.json')
 if($p.kind -cne 'aicc-group-activation-plan' -or $r.kind -cne 'aicc-group-activation-receipt' -or
    $r.planSha256 -cne (Maintenance-Hash $PlanFile) -or $r.operationId -cne $p.operationId -or
    $Confirm -cne ('ROLLBACK GROUP ACTIVATION '+$r.afterRegistrySha256) -or
    (Test-Path -LiteralPath ($PlanFile+'.rollback.json'))){throw 'activation_rollback_exact_receipt_required'}
 $state=$p.stateRoot;$registry=Join-Path $state 'registrations.json'
 $lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $state
 $fence=$null
 try{
  $fence=[IO.File]::Open((Join-Path $state 'worker.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $cfg=Maintenance-Read $registry
  if((Maintenance-Hash $registry) -cne $r.afterRegistrySha256 -or $cfg.workerStopRequestedAt -or
     $cfg.worker.state -cne 'ACTIVATION_START_PENDING' -or [int]$cfg.worker.pid -ne 0 -or
     $cfg.threads[$p.threadId].groupStopRevokedAt -or
     [string]$cfg.threads[$p.threadId].groupStopEpoch -cne [string]$p.stopEpoch -or
     @($cfg.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt -or $_.groupEvent}).Count){
   throw 'activation_rollback_worker_or_registry_cas_changed'
  }
  GroupInstall-AssertNoGroupMarkers $state
  $task=GroupInstall-TaskSnapshot $state
  if($task.xmlSha256 -cne $r.afterTaskSha256 -or $task.oldTaskState -cne 'Ready'){throw 'activation_rollback_task_or_running_worker_hold'}
  if((Maintenance-Hash $r.beforeRegistryFile) -cne $r.beforeRegistrySha256 -or
     (GroupInstall-HashText ([IO.File]::ReadAllText($r.beforeTaskFile))) -cne $r.beforeTaskSha256){throw 'activation_rollback_preimages_changed'}
  $pre=Maintenance-Read $r.beforeRegistryFile
  if(-not $pre.workerStopRequestedAt -or $pre.worker.state -cne 'STOPPED_FOR_MAINTENANCE' -or
     [string]$pre.threads[$p.threadId].groupStopEpoch -cne [string]$p.stopEpoch){throw 'activation_rollback_stop_epoch_changed'}
  $claim=[IO.File]::Open($PlanFile+'.rollback.claimed',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $claim.Dispose()
  Register-ScheduledTask -TaskName $r.taskName -Xml ([IO.File]::ReadAllText($r.beforeTaskFile)) -Force -ErrorAction Stop|Out-Null
  $disabled=GroupInstall-TaskSnapshot $state
  if($disabled.xmlSha256 -cne $r.beforeTaskSha256 -or $disabled.oldTaskState -cne 'Disabled'){throw 'activation_rollback_task_readback_hold'}
  if((Maintenance-Hash $registry) -cne $r.afterRegistrySha256){throw 'activation_rollback_registry_changed_after_task'}
  $temp=$registry+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllBytes($temp,[IO.File]::ReadAllBytes($r.beforeRegistryFile))
  [IO.File]::Move($temp,$registry,$true)
  if((Maintenance-Hash $registry) -cne $r.beforeRegistrySha256){throw 'activation_rollback_registry_readback_hold'}
  $result=@{state='ROLLED_BACK_STOPPED';taskRestored=$true;registryRestored=$true;
   stopFencePreserved=$true;stopEpochUnchanged=$true;workerStarted=$false;
   modelRequests=0;automaticReplay=$false}
  [IO.File]::WriteAllText($PlanFile+'.rollback.json',($result|ConvertTo-Json -Depth 8)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  return $result
 }finally{if($fence){$fence.Dispose()};$lock.Dispose()}
}
