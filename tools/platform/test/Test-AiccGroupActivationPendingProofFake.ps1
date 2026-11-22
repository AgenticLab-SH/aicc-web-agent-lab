#requires -Version 7.5
# Pure function fixture: do not read owner state, task scheduler or CLI.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../windows/CodexContinuityGroupActivation.ps1')
$bundle=@{plan=@{};receipt=@{threadId='fixture-original-group-thread'}}
$passed=0
function Expect([bool]$condition,[string]$label){
 if(-not $condition){throw ('pending_issuer_diagnostic_failed:'+ $label)}
 $script:passed++
}
$historical=@{attempt=$null;queueAttempt=@{state='QUEUE_ACCEPTED'}}
$other=@{attempt=@{state='DISPATCHING'};queueAttempt=$null}
$cfg=@{threads=@{original=$historical;secondary=@{attempt=$null;queueAttempt=$null}}}
$out=GroupActivation-Readiness $bundle $cfg 'fixture-no-real-state'
Expect ($out.state -ceq 'BLOCKED' -and $out.reason -ceq 'HISTORICAL_QUEUE_ACCEPTED_UNSETTLED') 'historical_hold'
Expect ($out.pendingCount -eq 1 -and $out.pendingResolution.historicalQueueAccepted -eq 1 -and $out.pendingResolution.otherPending -eq 0) 'exact_historical_count'
Expect ($out.pendingResolution.status -ceq 'ISSUER_SETTLEMENT_NOT_RECORDED' -and $out.pendingResolution.nextActor -ceq 'ORIGINAL_ISSUER') 'issuer_gate'
Expect ($out.pendingResolution.automaticReplay -ceq $false -and $out.pendingResolution.ownerHandoffChecked -ceq $false -and $out.automaticReplay -ceq $false -and $out.modelRequests -eq 0) 'no_replay_or_owner_claim'
$cfg.threads['other']=$other
$mix=GroupActivation-Readiness $bundle $cfg 'fixture-no-real-state'
Expect ($mix.pendingCount -eq 2 -and $mix.pendingResolution.historicalQueueAccepted -eq 1 -and $mix.pendingResolution.otherPending -eq 1) 'mixed_pending_count'
$cfg.threads.Remove('original')
$plain=GroupActivation-Readiness $bundle $cfg 'fixture-no-real-state'
Expect ($plain.reason -ceq 'GLOBAL_PENDING_DELIVERY_UNSETTLED' -and $plain.pendingResolution.historicalQueueAccepted -eq 0 -and $plain.pendingResolution.otherPending -eq 1) 'non_queue_attempt_guard'
$cfg.threads.Clear()
$clear=GroupActivation-Readiness $bundle $cfg 'fixture-no-real-state'
Expect ($clear.reason -ceq 'STOP_FENCE_OR_EXIT_STATE_CHANGED' -and (-not $clear.ContainsKey('pendingResolution'))) 'zero_pending_preserves_remaining_gate'
Write-Output ('G1_PENDING_ISSUER_DIAGNOSTIC_PASS='+$passed)
