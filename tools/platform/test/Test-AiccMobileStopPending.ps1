#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$file=Join-Path $AiccRoot 'tools/platform/windows/Request-AiccMobilePublicStop.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
if(@($errors).Count){throw 'source_parse_failed'}
$function=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-ExistingStopRequestGate'},$true)
if(-not $function){throw 'gate_missing'}
. ([scriptblock]::Create($function.Extent.Text))
foreach($name in @('Assert-CurrentStopStatusBinding','Read-ExactStopResult','Read-StopOperationOutcome')){
 $function=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 if(-not $function){throw 'result_reader_missing'}
 . ([scriptblock]::Create($function.Extent.Text))
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-stop-pending-'+[guid]::NewGuid().ToString('N'))
$runtime=[guid]::NewGuid().ToString();$original=[guid]::NewGuid().ToString();$next=[guid]::NewGuid().ToString()
$status=@{state='LISTENING';lastOperationId=$null;lastStopResult=$null;pid=12345;startedAt='2026-01-01T00:00:00.410Z';releaseManifestSha256=('a'*64)}
$pass=0
function Check($ok,$reason){if(-not $ok){throw $reason};$script:pass++}
$r=Get-ExistingStopRequestGate $root $runtime $next $status
Check ($r.supported -and $r.pending -eq 0) 'empty_root'
$dir=Join-Path $root $original;New-Item -ItemType Directory -Path $dir -Force|Out-Null
$request=Join-Path $dir 'request.json';$claim=Join-Path $dir 'claim.json'
$body=@{action='drain-and-stop';runtimeId=$runtime;operationId=$original;expiresAt='2020-01-01T00:00:00Z';expectedPid=$status.pid;expectedStartedAt=$status.startedAt;releaseManifestSha256=$status.releaseManifestSha256}
[IO.File]::WriteAllText($request,($body|ConvertTo-Json -Compress))
$originalRequestBytes=[IO.File]::ReadAllBytes($request)
$initialClaim=@{schemaVersion=1;operationId=$original;runtimeId=$runtime;pid=$status.pid;requestSha256=(Get-FileHash -LiteralPath $request).Hash.ToLowerInvariant();state='CLAIMED_INPUT_OUTCOME_UNKNOWN'}
[IO.File]::WriteAllText($claim,($initialClaim|ConvertTo-Json -Compress))
$before=(Get-FileHash -LiteralPath $request).Hash;$claimBefore=(Get-FileHash -LiteralPath $claim).Hash
$r=Get-ExistingStopRequestGate $root $runtime $next $status
Check (-not $r.supported -and $r.reason -ceq 'EXISTING_STOP_OUTCOME_UNCONFIRMED' -and $r.pending -eq 1) 'expired_claim_is_not_settlement'
$r=Get-ExistingStopRequestGate $root $runtime $original $status
Check ($r.supported -and $r.pending -eq 0) 'original_operation_readable'
$status.lastOperationId=$original;$status.lastStopResult='NORMAL_STOP_ACK'
Check (-not (Get-ExistingStopRequestGate $root $runtime $next $status).supported) 'listening_with_ack_is_not_terminal'
$status.state='NORMAL_STOPPED'
Check ((Get-ExistingStopRequestGate $root $runtime $next $status).supported) 'exact_terminal_ack'
$status.state='LISTENING';$status.lastStopResult='WORK_PRESERVED'
Check ((Get-ExistingStopRequestGate $root $runtime $next $status).supported) 'exact_refusal'
$status.lastOperationId=$next
Check (-not (Get-ExistingStopRequestGate $root $runtime $next $status).supported) 'different_operation_cannot_settle'
$body.runtimeId=[guid]::NewGuid().ToString();[IO.File]::WriteAllText($request,($body|ConvertTo-Json -Compress))
Check ((Get-ExistingStopRequestGate $root $runtime $next $status).reason -ceq 'EXISTING_STOP_INVENTORY_UNKNOWN') 'generation_mismatch'
$body.runtimeId=$runtime;[IO.File]::WriteAllBytes($request,$originalRequestBytes)
[IO.File]::WriteAllText((Join-Path $root 'submission.lock'),'')
Check ((Get-ExistingStopRequestGate $root $runtime $next $status).pending -eq 1) 'lock_is_not_a_request'
Check ((Get-FileHash -LiteralPath $request).Hash -ceq $before -and (Get-FileHash -LiteralPath $claim).Hash -ceq $claimBefore) 'original_bytes_preserved'
# A later result in status must not hide a prior exact refusal receipt.
$status.pid=12345;$status.startedAt='2026-01-01T00:00:00.410Z';$status.releaseManifestSha256='a'*64
$body.expectedPid=$status.pid;$body.expectedStartedAt=$status.startedAt;$body.releaseManifestSha256=$status.releaseManifestSha256
[IO.File]::WriteAllText($request,($body|ConvertTo-Json -Compress))
$requestHash=(Get-FileHash -LiteralPath $request).Hash.ToLowerInvariant()
$claimBody=@{schemaVersion=1;operationId=$original;runtimeId=$runtime;pid=$status.pid;requestSha256=$requestHash;state='CLAIMED_INPUT_OUTCOME_UNKNOWN'}
[IO.File]::WriteAllText($claim,($claimBody|ConvertTo-Json -Compress))
$resultPath=Join-Path $dir 'result.json'
$result=@{schemaVersion=1;kind='aicc-mobile-stop-result/v1';operationId=$original;runtimeId=$runtime;pid=$status.pid;startedAt=$status.startedAt;releaseManifestSha256=$status.releaseManifestSha256;requestSha256=$requestHash;state='LISTENING';lastStopResult='WORK_PRESERVED';automaticReplay=$false}
[IO.File]::WriteAllText($resultPath,($result|ConvertTo-Json -Compress))
Check ((Get-ExistingStopRequestGate $root $runtime $next $status).supported) 'earlier_refusal_retained_after_later_status'
$outcome=Read-StopOperationOutcome $dir $runtime $original $status
Check ($outcome.resultSource -ceq 'EXACT_OPERATION_RECEIPT' -and $outcome.lastStopResult -ceq 'WORK_PRESERVED' -and -not $outcome.currentNormalStopAck) 'exact_earlier_operation_query'
$result.state='NORMAL_STOPPED';$result.lastStopResult='NORMAL_STOP_ACK'
[IO.File]::WriteAllText($resultPath,($result|ConvertTo-Json -Compress))
Check ((Get-ExistingStopRequestGate $root $runtime $next $status).supported) 'earlier_normal_ack_retained'
$outcome=Read-StopOperationOutcome $dir $runtime $original $status
Check ($outcome.normalStopAck -and -not $outcome.currentNormalStopAck) 'historical_ack_is_not_current_transition_permission'
Check ($outcome.resultSource -ceq 'HISTORICAL_ACK_CURRENT_STATUS_UNCONFIRMED') 'historical_ack_distinct_source'
$currentStatus=$status.Clone();$currentStatus.lastOperationId=$original;$currentStatus.lastStopResult='NORMAL_STOP_ACK';$currentStatus.state='NORMAL_STOPPED'
$outcome=Read-StopOperationOutcome $dir $runtime $original $currentStatus
Check ($outcome.normalStopAck -and $outcome.currentNormalStopAck -and $outcome.resultSource -ceq 'EXACT_OPERATION_RECEIPT') 'exact_current_generation_ack'
$missing=Join-Path $root ([guid]::NewGuid().ToString())
$outcome=Read-StopOperationOutcome $missing $runtime $next $status
Check ($outcome.resultSource -ceq 'UNCONFIRMED' -and -not $outcome.normalStopAck) 'missing_original_query_no_ack'
# A current status without result.json still needs its original request/claim.
$receiptBytes=[IO.File]::ReadAllBytes($resultPath)
$receiptArchive=$root+'-fixture-receipt-preserved.json'
Move-Item -LiteralPath $resultPath -Destination $receiptArchive
foreach($field in @('expectedPid','expectedStartedAt','releaseManifestSha256')){
 $badBody=$body.Clone();$badBody[$field]=if($field -eq 'expectedPid'){54321}elseif($field -eq 'releaseManifestSha256'){'b'*64}else{'2026-01-01T00:00:00.41Z'}
 [IO.File]::WriteAllText($request,($badBody|ConvertTo-Json -Compress))
 $outcome=Read-StopOperationOutcome $dir $runtime $original $currentStatus
 Check ($outcome.resultSource -ceq 'RESULT_BINDING_UNKNOWN' -and -not $outcome.normalStopAck -and -not $outcome.currentNormalStopAck) ('status_cannot_override_request_'+$field)
 Check ((Get-ExistingStopRequestGate $root $runtime $next $currentStatus).reason -ceq 'EXISTING_STOP_INVENTORY_UNKNOWN') ('status_gate_rejects_request_'+$field)
}
[IO.File]::WriteAllText($request,($body|ConvertTo-Json -Compress))
foreach($field in @('operationId','runtimeId','pid','requestSha256','state')){
 $badClaim=$claimBody.Clone();$badClaim[$field]=if($field -eq 'pid'){54321}else{'wrong'}
 [IO.File]::WriteAllText($claim,($badClaim|ConvertTo-Json -Compress))
 $outcome=Read-StopOperationOutcome $dir $runtime $original $currentStatus
 Check ($outcome.resultSource -ceq 'RESULT_BINDING_UNKNOWN' -and -not $outcome.currentNormalStopAck) ('status_rejects_claim_'+$field)
}
[IO.File]::WriteAllText($claim,($claimBody|ConvertTo-Json -Compress))
$outcome=Read-StopOperationOutcome $dir $runtime $original $currentStatus
Check ($outcome.resultSource -ceq 'CURRENT_STATUS' -and $outcome.currentNormalStopAck) 'bound_legacy_status_remains_queryable'
Move-Item -LiteralPath $receiptArchive -Destination $resultPath
Check ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($resultPath))) -ceq [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($receiptBytes))) 'fixture_receipt_restored_exactly'
$result.state='LISTENING';$result.lastStopResult='WORK_PRESERVED'
foreach($field in @('operationId','runtimeId','pid','startedAt','releaseManifestSha256','requestSha256','automaticReplay')){
 $bad=$result.Clone();$bad[$field]=if($field -eq 'pid'){99999}elseif($field -eq 'automaticReplay'){$true}else{'wrong'}
 [IO.File]::WriteAllText($resultPath,($bad|ConvertTo-Json -Compress))
 Check ((Get-ExistingStopRequestGate $root $runtime $next $status).reason -ceq 'EXISTING_STOP_INVENTORY_UNKNOWN') ('tampered_result_'+$field)
 $outcome=Read-StopOperationOutcome $dir $runtime $original $status
 Check ($outcome.resultSource -ceq 'RESULT_BINDING_UNKNOWN' -and -not $outcome.normalStopAck -and -not $outcome.currentNormalStopAck) ('query_rejects_'+$field)
 $outcome=Read-StopOperationOutcome $dir $runtime $original $currentStatus
 Check ($outcome.resultSource -ceq 'RESULT_BINDING_UNKNOWN' -and -not $outcome.currentNormalStopAck) ('current_status_cannot_override_bad_receipt_'+$field)
}
$result.state='DRAINING';$result.lastStopResult='UNKNOWN'
[IO.File]::WriteAllText($resultPath,($result|ConvertTo-Json -Compress))
Check (-not (Get-ExistingStopRequestGate $root $runtime $next $status).supported) 'unknown_result_never_settles'
$result.state='LISTENING';$result.lastStopResult='WORK_PRESERVED'
[IO.File]::WriteAllText($resultPath,($result|ConvertTo-Json -Compress))
$claimBody.requestSha256='0'*64
[IO.File]::WriteAllText($claim,($claimBody|ConvertTo-Json -Compress))
Check ((Get-ExistingStopRequestGate $root $runtime $next $status).reason -ceq 'EXISTING_STOP_INVENTORY_UNKNOWN') 'wrong_claim_not_settlement'
$outcome=Read-StopOperationOutcome $dir $runtime $original $status
Check ($outcome.resultSource -ceq 'RESULT_BINDING_UNKNOWN') 'exact_query_wrong_claim_preserved'
$claimBody.requestSha256=$requestHash
[IO.File]::WriteAllText($claim,($claimBody|ConvertTo-Json -Compress))
$orphan=Join-Path $root ([guid]::NewGuid().ToString());New-Item -ItemType Directory -Path $orphan|Out-Null
[IO.File]::WriteAllText((Join-Path $orphan 'claim.json'),'{}')
Check ((Get-ExistingStopRequestGate $root $runtime $next $status).reason -ceq 'EXISTING_STOP_INVENTORY_UNKNOWN') 'orphan_claim'
@{passed=$pass;failed=0;runtimeMutations=0;modelRequests=0;fixtureRoot=$root}|ConvertTo-Json -Compress
