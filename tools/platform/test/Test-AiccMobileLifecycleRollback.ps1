#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath $AiccRoot).Path
# Reuse actual isolated installer output, never real owner/task/runtime files.
$fixtures=& (Join-Path $PSScriptRoot 'Test-AiccMobileLifecycleInstaller.ps1') -AiccRoot $repo|ConvertFrom-Json -AsHashtable
$utf8=[Text.UTF8Encoding]::new($false)
function Json($file){Get-Content -LiteralPath $file -Raw|ConvertFrom-Json -AsHashtable}
function Save($file,$value){New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force|Out-Null;[IO.File]::WriteAllText($file,($value|ConvertTo-Json -Depth 18),$utf8)}
function Hash($file){(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
function TextHash($text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($text))).ToLowerInvariant()}
$passed=0
foreach($caseName in @('register-unknown','success','start-unknown','task-readback-mismatch')){
 $case=Join-Path $fixtures.fixtureRoot $caseName;$owner=Join-Path $case 'owner';$operation=Join-Path $owner 'backups/operation'
 $planFile=Join-Path $operation 'plan.json';$plan=Json $planFile
 $activationFile=Join-Path $operation 'activation-attempt.json';$activation=Json $activationFile
 $rollbackOp=[guid]::NewGuid().ToString();$stopOp=[guid]::NewGuid().ToString()
 $rollback=Join-Path $case 'isolated-rollback.ps1'
 $source=[IO.File]::ReadAllText((Join-Path $repo 'tools/platform/windows/Restore-AiccMobilePublicRuntime.ps1'))
 $source=$source.Replace('$owner=Join-Path ([Environment]::GetFolderPath(''UserProfile'')) ''.ai-control-center''',('$owner='''+$owner.Replace("'","''")+"'"))
 $source=$source.Replace('$scheduler=New-Object -ComObject ''Schedule.Service''','$scheduler=New-FixtureScheduler')
 $source=$source.Replace('$wscript=Regular (Join-Path ([Environment]::GetFolderPath(''Windows'')) ''System32/wscript.exe'')',('$wscript=Regular '''+(Join-Path $case 'fake-wscript.exe').Replace("'","''")+"'"))
 [IO.File]::WriteAllText($rollback,$source,$utf8)
 $plan.lifecycleTransition.rollbackSha256=Hash $rollback;Save $planFile $plan
 # Synthetic fixture rebinding only: no operational receipt is written by this test.
 $activation.planSha256=Hash $planFile;Save $activationFile $activation
 $candidate=Json $plan.futureConfigPath;$previous=Json $plan.runtimeConfig
 $currentXml=[IO.File]::ReadAllText((Join-Path $case 'task.xml'));$currentHash=TextHash $currentXml
 if($caseName -ceq 'task-readback-mismatch'){
  # Preserve the unrelated-task artifact and reconcile the synthetic task to the exact desired XML.
  [IO.File]::WriteAllText((Join-Path $case 'task-unrelated-preserved.xml'),$currentXml,$utf8)
  $currentXml=[IO.File]::ReadAllText((Join-Path $operation 'public-task.activation.xml'))
  [IO.File]::WriteAllText((Join-Path $case 'task.xml'),$currentXml,$utf8);$currentHash=TextHash $currentXml
 }
 $now=[DateTimeOffset]::UtcNow
 $ready=@{schemaVersion=1;status='READY';independent=$true;operationId=$plan.operationId;planSha256=(Hash $planFile);taskXmlSha256=$currentHash;previousConfigSha256=if($activation.startAttempted){$plan.configSha256}else{$plan.runtimeConfigSha256};stopOperationId=if($activation.startAttempted){$stopOp}else{'NOT_STARTED'};target='AgenticLab-AICC-Mobile-Public-Control';recoveryAction='restore-exact-task-after-normal-stop';executorId='synthetic-rollback-executor';observedAt=$now.AddSeconds(-3).ToString('o');expiresAt=$now.AddMinutes(2).ToString('o');rollbackOperationId=$rollbackOp;activationReceiptSha256=(Hash $activationFile)}
 $toolFile=Join-Path $operation 'rollback-tool.json';$readyFile=Join-Path $operation 'rollback-ready.json'
 Save $toolFile $ready;$ready.toolReceiptFile=$toolFile;$ready.toolReceiptSha256=Hash $toolFile;Save $readyFile $ready
 $params=@{PlanFile=$planFile;ExpectedPlanSha256=(Hash $planFile);ExpectedActivationReceiptSha256=(Hash $activationFile);ExpectedCurrentTaskXmlSha256=$currentHash;RollbackOperationId=$rollbackOp;RecoveryReadyFile=$readyFile;ExpectedRecoveryReadySha256=(Hash $readyFile);RestoreStoppedService=$true}
 if($activation.startAttempted){$params.CandidateStopOperationId=$stopOp}
 $paramsFile=Join-Path $case 'rollback-params.json';Save $paramsFile $params
 $harness=[IO.File]::ReadAllText((Join-Path $case 'harness.ps1')).Replace("'params.json'","'rollback-params.json'").Replace("'isolated-installer.ps1'","'isolated-rollback.ps1'").Replace("'calls.txt'","'rollback-calls.txt'")
 $harnessFile=Join-Path $case 'rollback-harness.ps1';[IO.File]::WriteAllText($harnessFile,$harness,$utf8)
 function Run([string]$Mode='success'){
  $script:lastOutput=& (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File $harnessFile -CaseRoot $case -Mode $Mode 2>&1
  $script:lastExit=$LASTEXITCODE
  [IO.File]::WriteAllText((Join-Path $case 'rollback-output.txt'),($script:lastOutput -join "`n"),$utf8)
 }
 function Refused([string]$Expected){
  Run
  if($script:lastExit -eq 0 -or ($script:lastOutput -join "`n") -notmatch [regex]::Escape($Expected) -or (Test-Path -LiteralPath (Join-Path $case 'rollback-calls.txt'))){throw ('rollback_refusal_failed_'+$Expected)}
  $script:passed++
 }
 # All precondition failures precede the durable recovery claim and any task mutation.
 $params.ExpectedCurrentTaskXmlSha256='9'*64;Save $paramsFile $params;Refused 'unrelated_current_task_preserved'
 $params.ExpectedCurrentTaskXmlSha256=$currentHash;Save $paramsFile $params
 $readyOriginal=[IO.File]::ReadAllBytes($readyFile);$toolOriginal=[IO.File]::ReadAllBytes($toolFile)
 $ready.expiresAt=$now.AddSeconds(-1).ToString('o');$expired=$ready.Clone();$expired.Remove('toolReceiptFile');$expired.Remove('toolReceiptSha256');Save $toolFile $expired;$ready.toolReceiptSha256=Hash $toolFile;Save $readyFile $ready;$params.ExpectedRecoveryReadySha256=Hash $readyFile;Save $paramsFile $params
 Refused 'fresh_rollback_recovery_ready_required'
 [IO.File]::WriteAllBytes($readyFile,$readyOriginal);[IO.File]::WriteAllBytes($toolFile,$toolOriginal);$params.ExpectedRecoveryReadySha256=Hash $readyFile;Save $paramsFile $params
 $oldBytes=[IO.File]::ReadAllBytes($plan.runtimeConfig);[IO.File]::AppendAllText($plan.runtimeConfig,' ');Refused 'recovery_configs_changed';[IO.File]::WriteAllBytes($plan.runtimeConfig,$oldBytes)
 if($activation.startAttempted){
  Refused 'candidate_normal_stop_status_required'
  $status=@{schemaVersion=1;controlProtocolVersion=2;runtimeId=$candidate.runtimeId;releaseRoot=$candidate.releaseRoot;releaseManifestSha256=$candidate.releaseManifestSha256;state='NORMAL_STOPPED';lastOperationId=$stopOp;lastStopResult='NORMAL_STOP_ACK';pid=765433;startedAt=$now.AddMinutes(-1).ToString('o');observedAt=$now.AddSeconds(-1).ToString('o');drain=@{accepted=$true;activeApiRequests=0;mutationBusy=$false;pendingOutcomes=0;deviceTrustPreserved=$true}}
  Save $candidate.statusFile $status
  $stopRoot=Join-Path (Split-Path -Parent $plan.futureConfigPath) ('stop-requests/'+$stopOp)
  $requestFile=Join-Path $stopRoot 'request.json'
  Save $requestFile @{action='drain-and-stop';operationId=$stopOp;runtimeId=$candidate.runtimeId;expectedPid=765433;expectedStartedAt=$status.startedAt;releaseManifestSha256=$candidate.releaseManifestSha256;expiresAt=$now.AddSeconds(25).ToString('o')}
  Save (Join-Path $stopRoot 'claim.json') @{schemaVersion=1;operationId=$stopOp;runtimeId=$candidate.runtimeId;pid=765433;requestSha256=(Hash $requestFile);state='CLAIMED_INPUT_OUTCOME_UNKNOWN';at=$now.AddSeconds(-2).ToString('o')}
 }else{
  Save $candidate.statusFile @{state='START_FAILED'};Refused 'candidate_status_present_requires_reconciliation'
  # Keep the unexpected status artifact; move only this known synthetic file aside.
  $syntheticStatus=(Resolve-Path -LiteralPath $candidate.statusFile).Path
  if(-not $syntheticStatus.StartsWith($case+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'fixture_boundary_required'}
  Move-Item -LiteralPath $syntheticStatus -Destination ($syntheticStatus+'.preserved')
 }
 $preserve=@{activation=(Hash $activationFile);config=(Hash $plan.runtimeConfig);manifest=(Hash (Join-Path $plan.baseRoot '.aicc-release.json'))}
 $runMode=switch($caseName){'start-unknown' {'start-unknown'};'task-readback-mismatch' {'register-unknown'};default {'success'}}
 Run $runMode
 $calls=@(Get-Content -LiteralPath (Join-Path $case 'rollback-calls.txt'))
 $expectedCalls=if($caseName -ceq 'task-readback-mismatch'){'register'}else{'register,start'}
 if(($calls -join ',') -cne $expectedCalls -or ($caseName -notin @('start-unknown','task-readback-mismatch') -and $lastExit -ne 0) -or ($caseName -in @('start-unknown','task-readback-mismatch') -and $lastExit -eq 0)){throw ('rollback_dispatch_failed_'+$caseName)}
 $receipt=Json (Join-Path $operation 'rollback-attempt.json')
 if($caseName -ceq 'start-unknown' -and ($receipt.phase -cne 'HOLD_ROLLBACK_NO_AUTOMATIC_REPLAY' -or -not $receipt.startAttempted -or $receipt.startAccepted)){throw 'rollback_unknown_not_preserved'}
 if((Hash $activationFile) -cne $preserve.activation -or (Hash $plan.runtimeConfig) -cne $preserve.config -or (Hash (Join-Path $plan.baseRoot '.aicc-release.json')) -cne $preserve.manifest){throw 'rollback_original_data_changed'}
 $passed++
 $rollbackReceiptHash=Hash (Join-Path $operation 'rollback-attempt.json')
 Run
 if((@(Get-Content -LiteralPath (Join-Path $case 'rollback-calls.txt')) -join ',') -cne $expectedCalls -or $lastExit -eq 0 -or (Hash (Join-Path $operation 'rollback-attempt.json')) -cne $rollbackReceiptHash){throw 'rollback_replayed_or_receipt_changed'}
 $passed++
}
@{passed=$passed;failed=0;installerFixturePassed=$fixtures.passed;synthetic=$true;realTaskChanges=0;realServiceStarts=0;stopRequests=0;externalMessages=0;fixturePreserved=$true}|ConvertTo-Json -Compress
