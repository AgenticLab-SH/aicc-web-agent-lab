#requires -Version 7.5
# Isolated fake-only checks; never inspect the real owner, quota service, Task or model.
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '../windows/Invoke-AiccCodexContinuity.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ('source_parse_failed:'+ $errors[0].Message)}
foreach($name in @('Get-StrictFiveHourQuotaTerminal','Test-ExactFiveHourQuotaPreflight')){
 $found=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($found.Count -ne 1){throw ('quota_function_missing:'+ $name)}
 Invoke-Expression $found[0].Extent.Text
}
$checks=0
function Check($condition,[string]$label){if(-not $condition){throw ('FAIL:'+ $label)};$script:checks++}
function Digest-Text([string]$text){[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text)))}
$script:ThreadId='11111111-1111-4111-8111-111111111111'
$script:StrictAccountNumber=2
$priorTurn='22222222-2222-4222-8222-222222222222'
$now=[DateTimeOffset]::Parse('2026-11-10T00:00:00Z')
$deadline='2026-11-10T06:00:00Z'
$event=@{
 type='turn.failed';turn_id=$priorTurn
 error=@{code='usage_limit_reached';quota=@{
  provider='ocx';window='five_hour';resetAt=$now.AddMinutes(10).ToString('o')
 }}
}
$raw=($event|ConvertTo-Json -Depth 7 -Compress)
$receipt=Get-StrictFiveHourQuotaTerminal $event $script:ThreadId $priorTurn $raw $now
Check ($receipt.kind -ceq 'aicc-original-strict-five-hour-quota-terminal' -and
 $receipt.resetAt -ceq $now.AddMinutes(10).ToString('o') -and
 $receipt.rawEventSha256 -ceq (Digest-Text $raw)) 'official_exact_five_hour_terminal_bounded'
$case=$event.Clone()
$case.error=@{message='quota exceeded, try later'}
Check ($null -eq (Get-StrictFiveHourQuotaTerminal $case $script:ThreadId $priorTurn $raw $now)) 'generic_text_not_quota_proof'
$case.error=@{code='usage_limit_reached';quota=@{provider='ocx';window='weekly';resetAt=$now.AddMinutes(10).ToString('o')}}
Check ($null -eq (Get-StrictFiveHourQuotaTerminal $case $script:ThreadId $priorTurn $raw $now)) 'weekly_not_five_hour'
$case.error.quota.window='five_hour'
$case.error.quota.provider='native'
Check ($null -eq (Get-StrictFiveHourQuotaTerminal $case $script:ThreadId $priorTurn $raw $now)) 'native_forbidden'
$case.error.quota.provider='ocx'
Check ($null -eq (Get-StrictFiveHourQuotaTerminal $case $script:ThreadId '33333333-3333-4333-8333-333333333333' $raw $now)) 'other_turn_refused'
$case.error.quota.resetAt=$now.AddHours(8).ToString('o')
Check ($null -eq (Get-StrictFiveHourQuotaTerminal $case $script:ThreadId $priorTurn $raw $now)) 'unbounded_reset_refused'
$entry=@{
 threadId=$script:ThreadId;strictAccount=2;enabled=$true;groupOwnerOnly=$false
 projectRoot='C:\synthetic-owner-work';rollout='C:\synthetic-owner-work\fake.jsonl'
 lastTerminal='turn.failed';failureKind='QUOTA_WAIT';attempt=$null;queueAttempt=$null
 lastContinuityAttempt=@{id='44444444-4444-4444-8444-444444444444';
  routeMode='strict';accountNumber=2;executionRoute='command-route-r2';selectorSha256=('f'*64)}
 lastStrictRouteReceipt=@{
  attemptId='44444444-4444-4444-8444-444444444444';route='command-route-r2';threadId=$script:ThreadId
  threadStartedObserved=$true;foreignThreadObserved=$false;terminalEvent='turn.failed'
  acknowledged=$true;quotaTerminal=$receipt
 }
}
$cfg=@{
 threads=@{$script:ThreadId=$entry};excludedThreadIds=@()
 workerStopRequestedAt=$null
}
$script:fakeOwner='RELEASED'
$script:fakeQuota=@{state='STRICT_ACCOUNT_READY';quotaFresh=$true}
function Thread-Availability {param($e)@{state='ACTIVE'}}
function Thread-Owner {param($e)$script:fakeOwner}
function Get-StrictRouteLauncher {param($c)@{route='command-route-r2'}}
function Get-StrictAccountReadiness {param([int]$Number)if($Number -ne 2){throw 'other_account_called'};$script:fakeQuota}
$initial=Test-ExactFiveHourQuotaPreflight $cfg $deadline $now
Check ($initial.state -ceq 'FIVE_HOUR_QUOTA_WAIT' -and -not $initial.dispatched -and $initial.modelRequests -eq 0) 'reset_time_not_readiness'
$entry.lastStrictRouteReceipt.quotaTerminal.resetAt=$now.AddMinutes(-1).ToString('o')
$entry.lastStrictRouteReceipt.quotaTerminal.observedAt=$now.AddMinutes(-3).ToString('o')
$preview=Test-ExactFiveHourQuotaPreflight $cfg $deadline $now
Check ($preview.state -ceq 'EXACT_ADMISSION_PROVEN_SENDER_CLAIM_STILL_REQUIRED' -and
 $preview.dispatchable -eq $false -and $preview.goalContinued -eq $false -and
 $preview.queueAck -eq $false) 'admitted_still_not_claimed_or_sent'
$script:fakeOwner='ACTIVE'
Check ((Test-ExactFiveHourQuotaPreflight $cfg $deadline $now).state -ceq 'ORIGINAL_WRITER_NOT_RELEASED') 'active_same_cli_owner_hold'
$script:fakeOwner='RELEASED'
$script:fakeQuota=@{state='STRICT_QUOTA_STALE';quotaFresh=$false}
Check ((Test-ExactFiveHourQuotaPreflight $cfg $deadline $now).state -ceq 'FRESH_SAME_ACCOUNT_QUOTA_ADMISSION_HOLD') 'fresh_quota_required'
$script:fakeQuota=@{state='STRICT_ACCOUNT_READY';quotaFresh=$true}
$cfg.workerStopRequestedAt=$now.AddMinutes(-2).ToString('o')
Check ((Test-ExactFiveHourQuotaPreflight $cfg $deadline $now).state -ceq 'WORKER_STOP_HOLD') 'maintenance_stop_preserved'
$cfg.workerStopRequestedAt=$null
$cfg.threads['ce9a-synthetic-pending']=@{threadId='ce9a-synthetic-pending';queueAttempt=@{state='QUEUE_ACCEPTED'}}
$pending=Test-ExactFiveHourQuotaPreflight $cfg $deadline $now
Check ($pending.state -ceq 'UNRELATED_PENDING_WORKER_GATE_HOLD' -and $pending.ownAttemptPending -eq $false -and
 $pending.unrelatedPendingCount -eq 1) 'historical_pending_not_relabelled_as_original_target'
$null=$cfg.threads.Remove('ce9a-synthetic-pending')
$entry.lastContinuityAttempt.id='55555555-5555-4555-8555-555555555555'
Check ((Test-ExactFiveHourQuotaPreflight $cfg $deadline $now).state -ceq 'ORIGINAL_ATTEMPT_ACCOUNT_AND_ROUTE_UNPROVEN') 'foreign_attempt_cannot_adopt_original_failure'
$entry.lastContinuityAttempt.id='44444444-4444-4444-8444-444444444444'
$entry.lastStrictRouteReceipt=$null
Check ((Test-ExactFiveHourQuotaPreflight $cfg $deadline $now).state -ceq 'ORIGINAL_ISSUER_FIVE_HOUR_TERMINAL_NOT_PROVEN') 'missing_actual_original_quota_receipt_hold'
$entry.lastStrictRouteReceipt=@{attemptId='44444444-4444-4444-8444-444444444444';route='command-route-r2';threadId=$script:ThreadId;threadStartedObserved=$true;foreignThreadObserved=$false;terminalEvent='turn.failed';acknowledged=$true;quotaTerminal=$receipt}
$entry.attempt=@{state='UNKNOWN'}
Check ((Test-ExactFiveHourQuotaPreflight $cfg $deadline $now).state -ceq 'ORIGINAL_TARGET_PENDING_HOLD') 'own_unknown_not_replayed'
$entry.attempt=$null
Check ((Test-ExactFiveHourQuotaPreflight $cfg $deadline $now.AddHours(7)).state -ceq 'DEADLINE_EXPIRED_OR_UNAPPROVED') 'after_deadline_never_send'
Check (($ast.Extent.Text -match 'QuotaPreflight' -and
 $ast.Extent.Text -match 'Get-StrictFiveHourQuotaTerminal \$ev \$runningId \$runningTurnStartedId \$line' -and
 $ast.Extent.Text -match 'lastStrictRouteReceipt' -and
 $ast.Extent.Text -match 'workerStopRequestedAt')) 'existing_worker_only_not_new_sender'
@{status='PASS';checks=$checks;fakeOnly=$true;modelCalls=0;realRegistryWrites=0;workerStarts=0;attempts=0}|ConvertTo-Json -Compress
