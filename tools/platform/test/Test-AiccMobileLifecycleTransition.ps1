#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath $AiccRoot).Path
Import-Module (Join-Path $repo 'tools/platform/windows/MobilePublicTransition.psm1') -Force
$now=[DateTimeOffset]::UtcNow
$op=[guid]::NewGuid().ToString();$stop=[guid]::NewGuid().ToString();$oldId=[guid]::NewGuid().ToString();$nextId=[guid]::NewGuid().ToString()
$base='C:\synthetic\releases\before';$release='C:\synthetic\releases\after'
$plan=@{schemaVersion=1;operationId=$op;state='ASSEMBLED_NOT_APPLIED';runtimeApplied=$false;validation='STATIC_DEPENDENCIES_PASS_NOT_RUNTIME';lifecycleTransition=@{contractVersion=1};baselineRuntimeId=$oldId;baseRoot=$base;baseManifestSha256=('a'*64);candidateRoot=$release;candidateManifestSha256=('b'*64);runtimeConfigSha256=('c'*64)}
$previous=@{schemaVersion=1;runtimeId=$oldId;releaseRoot=$base;releaseManifestSha256=('a'*64);port=4383;remoteOrigin='https://synthetic.invalid';nodeExecutable='C:\synthetic\node.exe';nodeSha256=('d'*64);controlNonce=('e'*64)}
$candidate=$previous.Clone();$candidate.runtimeId=$nextId;$candidate.releaseRoot=$release;$candidate.releaseManifestSha256='b'*64;$candidate.controlNonce='f'*64
$status=@{schemaVersion=1;controlProtocolVersion=2;runtimeId=$oldId;releaseRoot=$base;releaseManifestSha256=('a'*64);state='NORMAL_STOPPED';lastOperationId=$stop;lastStopResult='NORMAL_STOP_ACK';pid=12345;startedAt=$now.AddHours(-1).ToString('o');observedAt=$now.AddSeconds(-1).ToString('o');drain=@{accepted=$true;activeApiRequests=0;mutationBusy=$false;pendingOutcomes=0;deviceTrustPreserved=$true}}
$request=@{action='drain-and-stop';operationId=$stop;runtimeId=$oldId;expectedPid=12345;expectedStartedAt=$status.startedAt;releaseManifestSha256=('a'*64);expiresAt=$now.AddSeconds(20).ToString('o')}
$claim=@{schemaVersion=1;operationId=$stop;runtimeId=$oldId;pid=12345;requestSha256=('1'*64);state='CLAIMED_INPUT_OUTCOME_UNKNOWN';at=$now.AddSeconds(-2).ToString('o')}
$ready=@{schemaVersion=1;status='READY';independent=$true;operationId=$op;planSha256=('2'*64);taskXmlSha256=('3'*64);previousConfigSha256=('c'*64);stopOperationId=$stop;target='AgenticLab-AICC-Mobile-Public-Control';recoveryAction='restore-exact-task-after-normal-stop';toolReceiptSha256=('4'*64);executorId='synthetic-independent-executor';observedAt=$now.AddSeconds(-5).ToString('o');expiresAt=$now.AddMinutes(2).ToString('o')}
$inputValues=@{Plan=$plan;PlanSha256=('2'*64);Previous=$previous;Candidate=$candidate;Status=$status;Request=$request;RequestSha256=('1'*64);Claim=$claim;StopOperationId=$stop;RecoveryReady=$ready;TaskXmlSha256=('3'*64);PreviousProcessPresent=$false;Now=$now}
function Clone($value){$value|ConvertTo-Json -Depth 15|ConvertFrom-Json -AsHashtable}
$before=$inputValues|ConvertTo-Json -Depth 15 -Compress
$pass=0
$result=Assert-AiccMobileLifecycleTransition @inputValues
if(-not $result.normalStopAck -or -not $result.processExitObserved -or $result.automaticReplay){throw 'valid_transition_contract_failed'}
$pass++
function Refuse([string]$Expected,[scriptblock]$Change){
 $values=Clone $inputValues
 & $Change $values
 try{$null=Assert-AiccMobileLifecycleTransition @values;throw 'unexpected_transition_success'}catch{if($_.Exception.Message -cne $Expected){throw};$script:pass++}
}
Refuse 'lifecycle_transition_contract_required' {param($v)$v.Plan.lifecycleTransition.contractVersion=0}
Refuse 'lifecycle_generation_binding_required' {param($v)$v.Candidate.runtimeId=$oldId}
Refuse 'lifecycle_scope_must_be_preserved' {param($v)$v.Candidate.nodeSha256='9'*64}
Refuse 'lifecycle_scope_must_be_preserved' {param($v)$v.Candidate.remoteOrigin='https://other.invalid'}
Refuse 'exact_normal_stop_ack_required' {param($v)$v.Status.state='DRAINING'}
Refuse 'exact_normal_stop_ack_required' {param($v)$v.Status.lastOperationId=[guid]::NewGuid().ToString()}
Refuse 'fresh_normal_stop_ack_required' {param($v)$v.Status.observedAt=$now.AddSeconds(-121).ToString('o')}
Refuse 'fresh_normal_stop_ack_required' {param($v)$v.Status.observedAt=$now.AddSeconds(1).ToString('o')}
Refuse 'exact_stop_request_claim_required' {param($v)$v.Claim.requestSha256='0'*64}
Refuse 'stop_request_time_binding_required' {param($v)$v.Claim.at=$now.AddSeconds(21).ToString('o')}
Refuse 'exact_idle_drain_required' {param($v)$v.Status.drain.pendingOutcomes=$null}
Refuse 'exact_idle_drain_required' {param($v)$v.Status.drain.pendingOutcomes=1}
Refuse 'exact_idle_drain_required' {param($v)$v.Status.drain.accepted=$false}
Refuse 'normal_stop_process_exit_required' {param($v)$v.PreviousProcessPresent=$true}
Refuse 'fresh_independent_recovery_receipt_required' {param($v)$v.RecoveryReady.independent=$false}
Refuse 'fresh_independent_recovery_receipt_required' {param($v)$v.RecoveryReady.planSha256='5'*64}
Refuse 'fresh_independent_recovery_receipt_required' {param($v)$v.RecoveryReady.taskXmlSha256='5'*64}
Refuse 'fresh_independent_recovery_receipt_required' {param($v)$v.RecoveryReady.expiresAt=$now.AddSeconds(-1).ToString('o')}
Refuse 'fresh_independent_recovery_receipt_required' {param($v)$v.RecoveryReady.observedAt=$now.AddMinutes(-3).ToString('o')}
if(($inputValues|ConvertTo-Json -Depth 15 -Compress) -cne $before){throw 'pure_contract_mutated_inputs'}
$pass++
# Parse/static boundary checks never execute the installer or a task API.
$installer=[IO.File]::ReadAllText((Join-Path $repo 'tools/platform/windows/Install-AiccMobilePublicRuntime.ps1'))
if($installer.Contains('Start-Process') -or $installer.Contains('Stop-Process') -or $installer.Contains('-Submit') -or -not $installer.Contains('Assert-AiccMobileLifecycleTransition') -or -not $installer.Contains('activation_attempt_exists_do_not_replay') -or -not $installer.Contains('task_update_readback_mismatch_no_start')){throw 'installer_dispatch_fence_regressed'}
$pass++
@{passed=$pass;failed=0;synthetic=$true;taskChanges=0;serviceStarts=0;stopRequests=0;externalMessages=0;fixtureReadyIsNotOperational=$true}|ConvertTo-Json -Compress
