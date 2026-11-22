#requires -Version 7.5
# Pure local fixture. Task functions are mocked in the imported module; no Task
# Scheduler, owner registry, service, Codex process, or model is contacted.
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityMaintenance.psm1') -Force
$m=Get-Module CodexContinuityMaintenance
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-activation-fake-'+[guid]::NewGuid().ToString('N'))
$state=Join-Path $root 'control-plane/codex-continuity'
$plans=Join-Path $state 'plans'
$release=Join-Path $root 'group-owner-release'
$thread='11111111-1111-4111-8111-111111111111'
$workerOp='22222222-2222-4222-8222-222222222222'
$ownerRev='a'*64
$event='b'*64
$success=0
$global:fakeTaskXml=$null
$global:fakeOwnerAlive=$false
$global:fakeQuotaHold=$false
$global:fakeWrongIssuer=$false
$global:fakeFailTask=$false
$global:fakeFailStart=$false
$global:fakeTamperTask=$false
$global:fakeTaskWrites=0
$global:fakeStarts=0
function Put([string]$path,[string]$text){$dir=Split-Path -Parent $path;if(-not(Test-Path -LiteralPath $dir)){New-Item -ItemType Directory -Path $dir -Force|Out-Null};[IO.File]::WriteAllText($path,$text,[Text.UTF8Encoding]::new($false))}
function HashFile([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Json($data){$data|ConvertTo-Json -Depth 25}
function ReadCfg{Get-Content -LiteralPath $registry -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function SaveCfg($c){Put $registry (Json $c)}
function Pass([string]$label,[bool]$ok){if(-not $ok){throw ('activation_fake_failed:'+ $label)};$script:success++}
function Refuse([string]$label,[scriptblock]$test,[string]$reason){
 $hit=$null;try{& $test}catch{$hit=$_.Exception.Message}
 Pass $label ([bool]$hit -and $hit -like ('*'+$reason+'*'))
}
function CleanActivation([string]$tag){
 foreach($ext in @('','.claimed','.before-registry.json','.before-task.xml','.receipt.json','.partial.json','.start.json','.start-hold.json','.rollback.claimed','.rollback.json')){
  $path=$previewFile+$ext
  if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Force}
 }
 $global:fakeTaskXml=$stoppedXml
 SaveCfg $original
 $global:fakeOwnerAlive=$false;$global:fakeQuotaHold=$false;$global:fakeWrongIssuer=$false;$global:fakeFailTask=$false;$global:fakeFailStart=$false;$global:fakeTamperTask=$false
}
try{
 New-Item -ItemType Directory -Path $plans -Force|Out-Null
 foreach($name in @('registrations.json.lock','worker.lock')){Put (Join-Path $state $name) ''}
 $relative=@('tools/platform/windows/Invoke-AiccCodexContinuity.ps1',
  'tools/platform/windows/CodexContinuityGroupOwner.ps1',
  'src/codex-strict-continuity-bridge.mjs','src/codex-cli-routes.mjs')
 $files=@{}
 foreach($item in $relative){$path=Join-Path $release $item;Put $path ('fake immutable '+$item);$files[$item]=HashFile $path}
 $vbs=Join-Path $release 'worker.hidden.vbs';Put $vbs 'fake exact registered task'
 $node=Join-Path $root 'node.exe';$pwsh=Join-Path $root 'pwsh.exe';$codex=Join-Path $root 'codex.exe'
 foreach($f in @($node,$pwsh,$codex)){Put $f ('fake signed '+$f)}
 $originalRoot=Join-Path $root 'project';New-Item -ItemType Directory -Path $originalRoot|Out-Null
 $rollout=Join-Path $root 'original-rollout.jsonl';Put $rollout '{"type":"session_meta"}'
 $stoppedXml='<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><Enabled>false</Enabled></Settings><Actions><Exec><Command>C:\Windows\System32\wscript.exe</Command><Arguments>/b /nologo "'+$vbs+'"</Arguments><WorkingDirectory>'+$release+'</WorkingDirectory></Exec></Actions></Task>'
 $global:fakeTaskXml=$stoppedXml
 $installFile=Join-Path $plans 'groupowner-installed.json'
 $install=@{schemaVersion=1;kind='aicc-group-owner-installer';action='InstallGroupOwnerStopped';
  operationId='33333333-3333-4333-8333-333333333333';stateRoot=$state;releaseRoot=$release;
  thread=@{threadId=$thread;projectRoot=$originalRoot;rollout=$rollout};
  ownerRevision=$ownerRev;stopEpoch=7;workerOperationId=$workerOp;
  files=$files;nodePath=$node;nodeSha256=HashFile $node;pwshPath=$pwsh;pwshSha256=HashFile $pwsh}
 Put $installFile (Json $install)
 $registry=Join-Path $state 'registrations.json'
 $entry=@{threadId=$thread;projectRoot=$originalRoot;rollout=$rollout;groupOwnerOnly=$true;strictAccount=2;
   groupOwnerRevision=$ownerRev;groupStopEpoch=7;groupWorkerOperationId=$workerOp;
   enabled=$false;state='DISABLED';attempt=$null;queueAttempt=$null;groupEvent=$null}
 $original=@{schemaVersion=1;protocolVersion=3;nativeFallback=$false;
  helperPath=(Join-Path $release $relative[0]);helperSha256=$files[$relative[0]];
  codexExecutable=$codex;codexSha256=HashFile $codex;workerStopRequestedAt='2026-11-07T00:00:00Z';
  worker=@{pid=2147483647;state='STOPPED_FOR_MAINTENANCE'};
  strictRouteLauncher=@{releaseRoot=$release;codexSha256=HashFile $codex;files=$files};
  groupOwner=@{threadId=$thread;eventId=$event;ownerRevision=$ownerRev;stopEpoch=7;workerOperationId=$workerOp};
  excludedThreadIds=@();threads=@{$thread=$entry}}
 SaveCfg $original
 $receipt=@{schemaVersion=1;kind='aicc-group-owner-install-receipt';state='INSTALLED_STOPPED';
  operationId=$install.operationId;planSha256=HashFile $installFile;threadId=$thread;
  helperSha256=$files[$relative[0]];releaseRoot=$release;stopFencePreserved=$true;
  workerStarted=$false;afterRegistrySha256=HashFile $registry;afterTaskSha256=$null;taskName='AgenticLab-AICC-Codex-Continuity'}
 $receipt.afterTaskSha256=& $m {param($text)GroupInstall-HashText $text} $stoppedXml
 Put ($installFile+'.receipt.json') (Json $receipt)
 $previewFile=Join-Path $plans 'activation-fake-preview.json'
 & $m {
  function script:GroupInstall-RequireOwner([string]$StateRoot){
   if(-not ([IO.Path]::GetFullPath($StateRoot)).StartsWith([IO.Path]::GetFullPath($global:fakeSandboxRoot),[StringComparison]::OrdinalIgnoreCase)){throw 'fake_owner_scope_changed'}
  }
  function script:GroupInstall-TaskSnapshot([string]$StateRoot){
   $xml=$global:fakeTaskXml;$doc=[xml]$xml
   $node=$doc.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="Settings"]/*[local-name()="Enabled"]')
   $argsNode=$doc.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="Actions"]/*[local-name()="Exec"]/*[local-name()="Arguments"]')
   $match=[regex]::Match($argsNode.InnerText,'^/b /nologo "(?<p>.+worker\.hidden\.vbs)"$')
   if(-not $match.Success){throw 'fake_task_identity_changed'}
   $vbs=$match.Groups['p'].Value
   @{taskName='AgenticLab-AICC-Codex-Continuity';xml=$xml;xmlSha256=(GroupInstall-HashText $xml);
     oldVbs=$vbs;oldVbsSha256=(Maintenance-Hash $vbs);
     oldTaskState=if($node.InnerText -ceq 'true'){'Ready'}else{'Disabled'}}
  }
  function script:GroupActivation-OwnerProof($cfg,[string]$StateRoot){
   if($global:fakeOwnerAlive){return @{state='ORIGINAL_WRITER_NOT_RELEASED'}}
   if($global:fakeQuotaHold){return @{state='STRICT_QUOTA_WAIT'}}
   if($global:fakeWrongIssuer){return @{state='GROUP_OWNER_EVIDENCE_HOLD'}}
   @{state='READY';quotaFresh=$true;writerReleased=$true;issuer='aicc-owner-controller'}
  }
  function script:Register-ScheduledTask{
   param([string]$TaskName,[string]$Xml,[switch]$Force)
   if($TaskName -cne 'AgenticLab-AICC-Codex-Continuity' -or -not $Force){throw 'fake_wrong_task'}
   $global:fakeTaskWrites++
   if($global:fakeFailTask){throw 'fake_task_registration_failure'}
   if($global:fakeTamperTask){
    $doc=[xml]$Xml
    $marker=$doc.CreateElement('ForeignInjected',$doc.DocumentElement.NamespaceURI)
    $marker.InnerText='other'
    $null=$doc.DocumentElement.AppendChild($marker)
    $global:fakeTaskXml=$doc.OuterXml
   }else{$global:fakeTaskXml=$Xml}
   @{TaskName=$TaskName}
  }
  function script:Start-ScheduledTask{
   param([string]$TaskName)
   if($TaskName -cne 'AgenticLab-AICC-Codex-Continuity'){throw 'fake_wrong_start'}
   $global:fakeStarts++
   if($global:fakeFailStart){throw 'fake_task_start_error'}
  }
 }
 $global:fakeSandboxRoot=$root
 $beforeSha=HashFile $registry
 # Pending is the first check; even a pre-authorized owner must not bypass it.
 $a=ReadCfg;$a.threads[$thread].queueAttempt=@{id='ce9a8a2b-1111-4111-8111-111111111111';state='QUEUE_ACCEPTED'};SaveCfg $a
 $held=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 Pass 'historical pending preview precise HOLD' ($held.state -ceq 'BLOCKED' -and $held.reason -ceq 'HISTORICAL_QUEUE_ACCEPTED_UNSETTLED' -and -not(Test-Path -LiteralPath $previewFile))
 Pass 'historical pending never mutates task or worker' ($global:fakeTaskXml -ceq $stoppedXml -and (ReadCfg).workerStopRequestedAt)
 CleanActivation 'historical'
 $a=ReadCfg;$a.groupOwner=$null;SaveCfg $a
 $held=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 Pass 'authorization not inferred from install' ($held.reason -ceq 'FRESH_OWNER_AUTHORISATION_REQUIRED')
 CleanActivation 'authorization'
 $global:fakeOwnerAlive=$true
 $held=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 Pass 'original CLI still alive has no official transfer' ($held.reason -ceq 'ORIGINAL_OWNER_ALIVE_NO_OFFICIAL_HANDOFF')
 CleanActivation 'owner'
 $global:fakeQuotaHold=$true
 $held=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 Pass 'strict account quota WAIT' ($held.reason -ceq 'STRICT_QUOTA_WAIT')
 CleanActivation 'quota'
 $global:fakeWrongIssuer=$true
 $held=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 Pass 'foreign issuer not accepted' ($held.reason -ceq 'GROUP_OWNER_EVIDENCE_HOLD')
 CleanActivation 'issuer'
 $a=ReadCfg;$a.threads[$thread].strictAccount=1;SaveCfg $a
 $held=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 Pass 'different strict account blocks' ($held.reason -ceq 'GROUP_THREAD_OR_STOP_EPOCH_CHANGED')
 CleanActivation 'account'
 $a=ReadCfg;$a.threads[$thread].groupStopEpoch=8;SaveCfg $a
 $held=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 Pass 'stop generation changed blocks' ($held.reason -ceq 'GROUP_THREAD_OR_STOP_EPOCH_CHANGED')
 CleanActivation 'epoch'
 $a=ReadCfg;$a.threads[$thread].projectRoot=Join-Path $root 'foreign-root';SaveCfg $a
 $held=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 Pass 'registered root changed blocks' ($held.reason -ceq 'GROUP_THREAD_OR_STOP_EPOCH_CHANGED')
 CleanActivation 'root'
 $a=ReadCfg;$a.threads[$thread].enabled=$true;SaveCfg $a
 $held=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 Pass 'busy/other enabled holds' ($held.reason -ceq 'GROUP_THREAD_OR_STOP_EPOCH_CHANGED')
 CleanActivation 'enabled'
 $workerLock=[IO.File]::Open((Join-Path $state 'worker.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{Refuse 'worker lock busy blocks preview' {New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile|Out-Null} 'being used'}finally{$workerLock.Dispose()}
 CleanActivation 'busy'
 $preview=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 Pass 'real preview writes one immutable plan' ($preview.state -ceq 'PREPARED' -and (HashFile $registry) -ceq $beforeSha -and $global:fakeTaskXml -ceq $stoppedXml)
 $a=ReadCfg;$a.threads[$thread].queueAttempt=@{id='ce9a8a2b-1111-4111-8111-111111111111';state='QUEUE_ACCEPTED'};SaveCfg $a
 Refuse 'pending appeared after preview blocks apply' {Invoke-AiccGroupActivationPlan -PlanFile $previewFile -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirm|Out-Null} 'activation_blocked:HISTORICAL_QUEUE_ACCEPTED_UNSETTLED'
 Pass 'pending apply cannot claim or modify Task' (-not(Test-Path -LiteralPath ($previewFile+'.claimed')) -and $global:fakeTaskXml -ceq $stoppedXml)
 CleanActivation 'pending-after-preview'
 $preview=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 $a=ReadCfg;$a.worker.heartbeatAt='changed';SaveCfg $a
 Refuse 'registry CAS changed blocks apply' {Invoke-AiccGroupActivationPlan -PlanFile $previewFile -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirm|Out-Null} 'activation_preview_cas_changed'
 CleanActivation 'registry-cas'
 $preview=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 $global:fakeFailTask=$true
 Refuse 'Task registration error never clears stop fence' {Invoke-AiccGroupActivationPlan -PlanFile $previewFile -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirm|Out-Null} 'fake_task_registration_failure'
 Pass 'Task failure precommit leaves exact stopped state' ((ReadCfg).workerStopRequestedAt -and $global:fakeTaskXml -ceq $stoppedXml -and (Test-Path -LiteralPath ($previewFile+'.partial.json')))
 CleanActivation 'task-error'
 $preview=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 $global:fakeTamperTask=$true
 Refuse 'Task unexpected field after registration rejected' {Invoke-AiccGroupActivationPlan -PlanFile $previewFile -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirm|Out-Null} 'activation_task_unexpected_fields_changed'
 Pass 'Task mutation leaves fence and partial receipt' ((ReadCfg).workerStopRequestedAt -and (Test-Path -LiteralPath ($previewFile+'.partial.json')))
 CleanActivation 'task-mutation'
 $preview=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 $activated=Invoke-AiccGroupActivationPlan -PlanFile $previewFile -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirm
 $post=ReadCfg
 Pass 'apply enables existing Task and releases fence' ($activated.state -ceq 'ACTIVATION_START_SUBMITTED' -and -not $post.workerStopRequestedAt -and $post.worker.state -ceq 'ACTIVATION_START_PENDING' -and $global:fakeTaskXml -cne $stoppedXml)
 Pass 'apply does not create event or model turn' ($null -eq $post.threads[$thread].groupEvent -and $null -eq $post.threads[$thread].attempt -and $activated.modelRequests -eq 0 -and $global:fakeStarts -gt 0)
 Refuse 'apply once only' {Invoke-AiccGroupActivationPlan -PlanFile $previewFile -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirm|Out-Null} 'activation_worker_exit_unproven'
 $receiptApply=Get-Content -LiteralPath ($previewFile+'.receipt.json') -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $rollback=Undo-AiccGroupActivationPlan -PlanFile $previewFile -Confirm ('ROLLBACK GROUP ACTIVATION '+$receiptApply.afterRegistrySha256)
 Pass 'rollback exact Task and registry preimage' ($rollback.state -ceq 'ROLLED_BACK_STOPPED' -and $global:fakeTaskXml -ceq $stoppedXml -and (HashFile $registry) -ceq $beforeSha -and (ReadCfg).workerStopRequestedAt)
 CleanActivation 'rollback'
 $preview=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 $activated=Invoke-AiccGroupActivationPlan -PlanFile $previewFile -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirm
 $receiptApply=Get-Content -LiteralPath ($previewFile+'.receipt.json') -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $a=ReadCfg;$a.threads[$thread].groupStopEpoch=8;SaveCfg $a
 Refuse 'rollback cannot revive revoked stop epoch' {Undo-AiccGroupActivationPlan -PlanFile $previewFile -Confirm ('ROLLBACK GROUP ACTIVATION '+$receiptApply.afterRegistrySha256)|Out-Null} 'activation_rollback_worker_or_registry_cas_changed'
 CleanActivation 'rollback-epoch'
 $preview=New-AiccGroupActivationPlan -InstalledPlanFile $installFile -PlanFile $previewFile
 $global:fakeFailStart=$true
 $partial=Invoke-AiccGroupActivationPlan -PlanFile $previewFile -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirm
 Pass 'Task start failure reports partial not active' ($partial.state -ceq 'PARTIAL_HOLD' -and (Test-Path -LiteralPath ($previewFile+'.start-hold.json')) -and $partial.modelRequests -eq 0)
 CleanActivation 'start-error'
 Write-Output (@{terminal='PASS';checks=$success;realRuntimeChanged=$false;modelRequests=0}|ConvertTo-Json -Compress)
}finally{
 if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}
}
