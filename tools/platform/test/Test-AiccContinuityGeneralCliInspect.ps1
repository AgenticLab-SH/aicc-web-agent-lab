#requires -Version 7.5
# Synthetic read-only inspection of general shared-HOME CLI. No sender/worker.
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityMaintenance.psm1') -Force
$id='11111111-1111-4111-8111-111111111111'
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-general-cli-inspect-'+[guid]::NewGuid().ToString('N'))
$state=Join-Path $root 'continuity'
$sessions=Join-Path $root 'sessions'
$project=Join-Path $root 'project'
foreach($dir in @($state,$sessions,$project)){$null=New-Item -ItemType Directory -Path $dir -Force}
$rollout=Join-Path $sessions 'rollout-11111111-1111-4111-8111-111111111111.jsonl'
$meta=@{type='session_meta';payload=@{id=$id;cwd=$project;source='cli'}}
$registry=Join-Path $state 'registrations.json'
$cfg=@{schemaVersion=1;protocolVersion=3;excludedThreadIds=@();
 workerStopRequestedAt='2026-11-10T00:00:00Z';threads=@{
  $id=@{threadId=$id;projectRoot=$project;rollout=$rollout;strictAccount=$null;
      enabled=$true;attempt=$null;queueAttempt=$null};
  other=@{threadId='other';queueAttempt=@{state='QUEUE_ACCEPTED';id='historic-unknown'}}}}
$deadline=[DateTimeOffset]::UtcNow.AddHours(1).ToString('o')
$checks=0
function Check($ok,[string]$reason){if(-not $ok){throw ('FAIL:'+ $reason)};$script:checks++}
function Save{
 [IO.File]::WriteAllText($registry,($cfg|ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false))
 [IO.File]::WriteAllText($rollout,($meta|ConvertTo-Json -Depth 9 -Compress)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
}
function Probe($when=$deadline){
 Get-AiccGeneralCliContinuityStatus -StateRoot $state -ThreadId $id -DeadlineUtc $when -SessionsRoot $sessions
}
Save
$r=Probe
Check ($r.state -ceq 'ORIGINAL_ISSUER_CALLBACK_UNAVAILABLE_WORKER_STOPPED' -and
 $r.exactSavedSessionReadback -eq $true -and $r.savedSessionSource -ceq 'cli' -and
 $r.expectedPath -ceq 'official-codex-to-17841-to-nonweb-OCX10101') 'real_general_cli_source_not_direct_10100'
Check (-not $r.namedStrictAccountOverride -and $r.historicalOtherPending -eq 1 -and
 $r.originalPending -eq $false -and $r.maintenanceStopPresent -eq $true) 'null_strict_account_correct_and_other_pending_not_waived'
Check ($r.modelRequests -eq 0 -and $r.dispatchable -eq $false -and
 $r.queueAck -eq $false -and $r.newTurnObserved -eq $false -and
 $r.goalResumed -eq $false -and $r.ownerExitVerified -eq $false) 'inspection_not_original_issuer_or_sender'
# A fake status/receipt inside a cooperative owner record is never trusted.
$cfg.threads[$id].lastStrictRouteReceipt=@{terminal='QUOTA_WAIT';resetAt='2026-11-10T03:00:00Z'}
$cfg.threads[$id].quotaIssuerReceipt=@{issuer='made-up';provider='ocx';errorCode='usage_limit_reached'}
Save
Check ((Probe).upstreamIssuerReceiptVerified -eq $false) 'fake_saved_quota_not_upstream_issuer_authority'
$cfg.threads[$id].attempt=@{state='CLAIMED_NO_ACK'};Save
Check ((Probe).state -ceq 'ORIGINAL_ATTEMPT_UNCERTAIN_NO_REPLAY') 'own_unknown_preserved'
$cfg.threads[$id].attempt=$null
$cfg.threads[$id].strictAccount=2;Save
Check ((Probe).state -ceq 'GENERAL_CLI_ROUTE_OVERRIDE_HOLD') 'forced_web_account2_forbidden'
$cfg.threads[$id].strictAccount=$null
$meta.payload.id='22222222-2222-4222-8222-222222222222';Save
Check ((Probe).state -ceq 'ORIGINAL_SESSION_ID_OR_SOURCE_HOLD') 'changed_saved_conversation_hold'
$meta.payload.id=$id;$meta.payload.source='vscode';Save
Check ((Probe).state -ceq 'ORIGINAL_SESSION_ID_OR_SOURCE_HOLD') 'desktop_origin_not_general_cli'
$meta.payload.source='cli'
$cfg.threads[$id].rollout=Join-Path $root 'outside.jsonl';Save
Check ((Probe).state -ceq 'ORIGINAL_SAVED_SESSION_SCOPE_HOLD') 'no_rollout_outside_original_sessions'
$cfg.threads[$id].rollout=$rollout;Save
$future=[DateTimeOffset]::UtcNow.AddDays(2).ToString('o')
Check ((Probe $future).exactSavedSessionReadback -eq $true) 'future_run_inspectable_without_calendar_cutoff'
$expired=Probe '2000-01-01T00:00:00Z'
Check ($expired.exactSavedSessionReadback -and $expired.deadlineExpired -eq $true -and
 -not $expired.dispatchable -and $expired.modelRequests -eq 0) 'expired_run_inspection_never_grants_dispatch'
$unbounded=Probe ''
Check ($unbounded.exactSavedSessionReadback -and $null -eq $unbounded.deadlineExpired -and
 -not $unbounded.dispatchable -and -not $unbounded.goalResumed) 'no_deadline_readonly_inspection'
Check ((Probe 'invalid-date').state -ceq 'DEADLINE_OR_EXACT_THREAD_HOLD') 'malformed_deadline_still_rejected'
Check ((Probe).deadlineExpired -eq $false) 'future_deadline_reported_without_mutation'
Check ((Get-AiccGeneralCliContinuityStatus -StateRoot $state -ThreadId '00000000-0000-0000-0000-000000000001' -DeadlineUtc $deadline -SessionsRoot $sessions).state -ceq 'ORIGINAL_REGISTERED_THREAD_REQUIRED') 'another_thread_is_not_adopted'
$cfg.threads[$id].rollout=$rollout;$null=$cfg.threads.Remove($id);Save
Check ((Probe).state -ceq 'ORIGINAL_REGISTERED_THREAD_REQUIRED') 'missing_original_thread_hold'
@{status='PASS';checks=$checks;fakeOnly=$true;realModels=0;liveOwnerWrites=0;existingDaemonStarts=0;actualQueueSends=0}|ConvertTo-Json -Compress
