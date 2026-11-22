# Pure transition contract. Callers obtain files/OS observations; no I/O or dispatch here.
function Assert-AiccMobileLifecycleTransition {
 [CmdletBinding()]
 param(
  [Parameter(Mandatory)][hashtable]$Plan,
  [Parameter(Mandatory)][string]$PlanSha256,
  [Parameter(Mandatory)][hashtable]$Previous,
  [Parameter(Mandatory)][hashtable]$Candidate,
  [Parameter(Mandatory)][hashtable]$Status,
  [Parameter(Mandatory)][hashtable]$Request,
  [Parameter(Mandatory)][string]$RequestSha256,
  [Parameter(Mandatory)][hashtable]$Claim,
  [Parameter(Mandatory)][string]$StopOperationId,
  [Parameter(Mandatory)][hashtable]$RecoveryReady,
  [Parameter(Mandatory)][string]$TaskXmlSha256,
  [Parameter(Mandatory)][bool]$PreviousProcessPresent,
  [DateTimeOffset]$Now=[DateTimeOffset]::UtcNow
 )
 $uuid='^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 $sha='^[a-f0-9]{64}$'
 if($Plan.schemaVersion -ne 1 -or $Plan.operationId -cnotmatch $uuid -or $Plan.state -cne 'ASSEMBLED_NOT_APPLIED' -or $Plan.runtimeApplied -ne $false -or $Plan.validation -cne 'STATIC_DEPENDENCIES_PASS_NOT_RUNTIME' -or $Plan.lifecycleTransition.contractVersion -ne 1 -or $PlanSha256 -cnotmatch $sha -or $TaskXmlSha256 -cnotmatch $sha){throw 'lifecycle_transition_contract_required'}
 if($Previous.schemaVersion -ne 1 -or $Candidate.schemaVersion -ne 1 -or $Previous.runtimeId -cnotmatch $uuid -or $Candidate.runtimeId -cnotmatch $uuid -or $Candidate.runtimeId -ceq $Previous.runtimeId -or $Previous.runtimeId -cne $Plan.baselineRuntimeId -or $Previous.releaseRoot -cne $Plan.baseRoot -or $Previous.releaseManifestSha256 -cne $Plan.baseManifestSha256 -or $Candidate.releaseRoot -cne $Plan.candidateRoot -or $Candidate.releaseManifestSha256 -cne $Plan.candidateManifestSha256){throw 'lifecycle_generation_binding_required'}
 if($Previous.port -ne 4383 -or $Candidate.port -ne 4383 -or $Previous.remoteOrigin -cne $Candidate.remoteOrigin -or $Previous.nodeExecutable -cne $Candidate.nodeExecutable -or $Previous.nodeSha256 -cne $Candidate.nodeSha256 -or $Candidate.nodeSha256 -cnotmatch $sha -or $Candidate.controlNonce -cnotmatch $sha -or $Previous.controlNonce -ceq $Candidate.controlNonce){throw 'lifecycle_scope_must_be_preserved'}
 $origin=$null
 if(-not [uri]::TryCreate($Candidate.remoteOrigin,[UriKind]::Absolute,[ref]$origin) -or $origin.Scheme -cne 'https' -or $origin.UserInfo -or $origin.GetLeftPart([UriPartial]::Authority) -cne $Candidate.remoteOrigin){throw 'existing_https_origin_required'}
 if($StopOperationId -cnotmatch $uuid -or $Status.schemaVersion -ne 1 -or $Status.controlProtocolVersion -ne 2 -or $Status.runtimeId -cne $Previous.runtimeId -or $Status.releaseRoot -cne $Previous.releaseRoot -or $Status.releaseManifestSha256 -cne $Previous.releaseManifestSha256 -or $Status.state -cne 'NORMAL_STOPPED' -or $Status.lastOperationId -cne $StopOperationId -or $Status.lastStopResult -cne 'NORMAL_STOP_ACK' -or ($Status.pid -isnot [long] -and $Status.pid -isnot [int]) -or $Status.pid -le 0){throw 'exact_normal_stop_ack_required'}
 $observed=[DateTimeOffset]::MinValue
 if(-not [DateTimeOffset]::TryParse([string]$Status.observedAt,[ref]$observed) -or $observed -gt $Now -or $observed -lt $Now.AddSeconds(-120)){throw 'fresh_normal_stop_ack_required'}
 if($Request.action -cne 'drain-and-stop' -or $Request.operationId -cne $StopOperationId -or $Request.runtimeId -cne $Previous.runtimeId -or $Request.expectedPid -ne $Status.pid -or $Request.expectedStartedAt -cne $Status.startedAt -or $Request.releaseManifestSha256 -cne $Previous.releaseManifestSha256 -or $RequestSha256 -cnotmatch $sha -or $Claim.schemaVersion -ne 1 -or $Claim.operationId -cne $StopOperationId -or $Claim.runtimeId -cne $Previous.runtimeId -or $Claim.pid -ne $Status.pid -or $Claim.requestSha256 -cne $RequestSha256 -or $Claim.state -cne 'CLAIMED_INPUT_OUTCOME_UNKNOWN'){throw 'exact_stop_request_claim_required'}
 $started=[DateTimeOffset]::MinValue;$claimed=[DateTimeOffset]::MinValue;$deadline=[DateTimeOffset]::MinValue
 if(-not [DateTimeOffset]::TryParse([string]$Status.startedAt,[ref]$started) -or $started -ge $observed -or -not [DateTimeOffset]::TryParse([string]$Claim.at,[ref]$claimed) -or -not [DateTimeOffset]::TryParse([string]$Request.expiresAt,[ref]$deadline) -or $claimed -lt $started -or $claimed -gt $observed -or $claimed -gt $deadline -or $claimed -lt $deadline.AddSeconds(-60) -or $observed -gt $deadline.AddSeconds(30)){throw 'stop_request_time_binding_required'}
 if($Status.drain.accepted -ne $true -or $Status.drain.activeApiRequests -ne 0 -or $Status.drain.mutationBusy -ne $false -or $Status.drain.pendingOutcomes -ne 0 -or $Status.drain.deviceTrustPreserved -ne $true){throw 'exact_idle_drain_required'}
 if($PreviousProcessPresent){throw 'normal_stop_process_exit_required'}
 # This contract consumes an already authenticated owner-local recovery acknowledgement.
 # It never creates READY and does not infer independent execution from a label alone.
 $expires=[DateTimeOffset]::MinValue;$readyAt=[DateTimeOffset]::MinValue
 if($RecoveryReady.schemaVersion -ne 1 -or $RecoveryReady.status -cne 'READY' -or $RecoveryReady.independent -ne $true -or $RecoveryReady.operationId -cne $Plan.operationId -or $RecoveryReady.planSha256 -cne $PlanSha256 -or $RecoveryReady.taskXmlSha256 -cne $TaskXmlSha256 -or $RecoveryReady.previousConfigSha256 -cne $Plan.runtimeConfigSha256 -or $RecoveryReady.stopOperationId -cne $StopOperationId -or $RecoveryReady.target -cne 'AgenticLab-AICC-Mobile-Public-Control' -or $RecoveryReady.recoveryAction -cne 'restore-exact-task-after-normal-stop' -or $RecoveryReady.toolReceiptSha256 -cnotmatch $sha -or [string]::IsNullOrWhiteSpace($RecoveryReady.executorId) -or -not [DateTimeOffset]::TryParse([string]$RecoveryReady.observedAt,[ref]$readyAt) -or $readyAt -gt $Now -or $readyAt -lt $Now.AddSeconds(-120) -or -not [DateTimeOffset]::TryParse([string]$RecoveryReady.expiresAt,[ref]$expires) -or $expires -le $Now -or $expires -gt $Now.AddMinutes(5)){throw 'fresh_independent_recovery_receipt_required'}
 return @{contractVersion=1;normalStopOperationId=$StopOperationId;normalStopPid=$Status.pid;normalStopAck=$true;processExitObserved=$true;idleScope='mobile drain only; not global UNKNOWN=0';recoveryExecutorId=$RecoveryReady.executorId;recoveryToolReceiptSha256=$RecoveryReady.toolReceiptSha256;automaticReplay=$false}
}
Export-ModuleMember -Function Assert-AiccMobileLifecycleTransition
