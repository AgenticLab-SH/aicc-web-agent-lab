#requires -Version 7.5
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/MobilePublicRecovery.psm1') -Force
$now=[DateTimeOffset]::UtcNow;$id=[guid]::NewGuid().ToString();$stopId=[guid]::NewGuid().ToString();$hash='a'*64
$plan=@{baselineRuntimeId=$id;baseRoot='C:\fixture';baseManifestSha256=$hash}
$req=@{stoppedOriginal=$true;taskXmlSha256=$hash;stopOperationId=$stopId;runtimePid=123}
$status=@{state='NORMAL_STOPPED';lastStopResult='NORMAL_STOP_ACK';runtimeId=$id;releaseRoot='C:\fixture';releaseManifestSha256=$hash;lastOperationId=$stopId;pid=123;startedAt=$now.AddHours(-1).ToString('o');observedAt=$now.AddSeconds(-20).ToString('o');drain=@{accepted=$true;activeApiRequests=0;mutationBusy=$false;pendingOutcomes=0;deviceTrustPreserved=$true}}
$stop=@{action='drain-and-stop';operationId=$stopId;runtimeId=$id;expectedPid=123;expectedStartedAt=$status.startedAt;releaseManifestSha256=$hash;expiresAt=$now.AddSeconds(-10).ToString('o')}
$claim=@{state='CLAIMED_INPUT_OUTCOME_UNKNOWN';operationId=$stopId;runtimeId=$id;pid=123;requestSha256=$hash;at=$now.AddSeconds(-30).ToString('o')}
function Check($r=$req,$st=$status,$sp=$stop,$cl=$claim,$task=$hash,$process=0,$instances=0,$listen=0,$candidate=$false,$attempt=$false){Assert-MobileStoppedOriginalEvidence $plan $r $st $sp $cl $hash $task $process $instances $listen $candidate $attempt}
$passed=0;Check;$passed++
foreach($key in @('state','lastStopResult','runtimeId','releaseRoot','releaseManifestSha256','lastOperationId','pid','startedAt','observedAt')){$x=$status.Clone();$x[$key]='changed';$denied=$false;try{Check -st $x}catch{$denied=$true};if(-not $denied){throw ('accepted_status_'+$key)};$passed++}
foreach($key in @('operationId','runtimeId','pid','requestSha256','at','state')){$x=$claim.Clone();$x[$key]='changed';$denied=$false;try{Check -cl $x}catch{$denied=$true};if(-not $denied){throw ('accepted_claim_'+$key)};$passed++}
foreach($key in @('action','operationId','runtimeId','expectedPid','expectedStartedAt','releaseManifestSha256','expiresAt')){$x=$stop.Clone();$x[$key]='changed';$denied=$false;try{Check -sp $x}catch{$denied=$true};if(-not $denied){throw ('accepted_request_'+$key)};$passed++}
foreach($args in @(@{process=1},@{instances=1},@{listen=1},@{candidate=$true},@{attempt=$true},@{task=('b'*64)})){$denied=$false;try{Check @args}catch{$denied=$true};if(-not $denied){throw 'unsafe_inventory_accepted'};$passed++}
foreach($key in @('accepted','activeApiRequests','mutationBusy','pendingOutcomes','deviceTrustPreserved')){$x=$status.Clone();$x.drain=$status.drain.Clone();$x.drain[$key]=if($key -in @('activeApiRequests','pendingOutcomes')){1}else{-not $x.drain[$key]};$denied=$false;try{Check -st $x}catch{$denied=$true};if(-not $denied){throw ('unsafe_drain_'+$key)};$passed++}
$r=$req.Clone();$r.stoppedOriginal=$false;$denied=$false;try{Check -r $r}catch{$denied=$true};if(-not $denied){throw 'wrong_mode_accepted'};$passed++
@{state='PASS';passed=$passed;failed=0;scope='stopped-original recovery boundary only; no task/service/request mutation'}|ConvertTo-Json -Compress