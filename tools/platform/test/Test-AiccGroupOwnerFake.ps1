#requires -Version 7.5
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../windows/CodexContinuityGroupOwner.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-g1-group-owner-'+[guid]::NewGuid().ToString('N'))
$ownerHome=Join-Path $root 'home'
$StateRoot=Join-Path $ownerHome '.ai-control-center/control-plane/codex-continuity'
$sourceRoot=Join-Path $root 'source'
foreach($folder in @($StateRoot,(Join-Path $StateRoot 'group-inbox'),$sourceRoot)){New-Item -ItemType Directory -Path $folder -Force|Out-Null}
$thread='11111111-1111-4111-8111-111111111111'
$operation='22222222-2222-4222-8222-222222222222'
$revision='a'*64
$sourceId='g2'
$checks=0
$script:ownerStatus='RELEASED'
$script:quotaStatus='STRICT_ACCOUNT_READY'
$script:terminalHash='c'*64
function Check($v,[string]$reason){if(-not $v){throw ('fake_case_failed:'+ $reason)};$script:checks++}
function Write-Fixture($file,$object){
 [IO.File]::WriteAllText($file,($object|ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false))
}
function Sha($file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function Read-Json($file){Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json -AsHashtable -DateKind String}
function Thread-Availability($e){@{state='ACTIVE'}}
function Thread-Owner($e){$script:ownerStatus}
function Terminal-Evidence($e){@{state='TERMINAL';sha256=$script:terminalHash}}
function Get-StrictRouteLauncher($cfg){@{route='command-route-r2'}}
function Get-StrictAccountReadiness($number){@{state=$script:quotaStatus;quotaFresh=($script:quotaStatus -eq 'STRICT_ACCOUNT_READY')}}
$resultFile=Join-Path $sourceRoot 'result.json'
Write-Fixture $resultFile @{status='COMPLETED';verified=$true}
$resultSha=Sha $resultFile
$eidBytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($thread,$sourceId,$resultSha) -Compress))
$EventId=[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($eidBytes))
$receiptFile=Join-Path $sourceRoot 'returned.json'
Write-Fixture $receiptFile @{schemaVersion=1;kind='aicc-source-writer-return';threadId=$thread;sourceId=$sourceId;resultSha256=$resultSha;
 ownerRevision=$revision;stopEpoch=7;workerOperationId=$operation;returned=$true;closed=$true}
$receiptSha=Sha $receiptFile
$regFile=Join-Path $sourceRoot 'group-registration.json'
Write-Fixture $regFile @{schemaVersion=1;enabled=$true;targetThreadId=$thread;targetRoot=$sourceRoot;accountNumber=2;route='command-route-r2';
 ownerRevision=$revision;stopEpoch=7;workerOperationId=$operation;strictContinuity=@{eventId=$EventId}}
$regSha=Sha $regFile
$eventFile=Join-Path $StateRoot ('group-inbox/'+$EventId+'.json')
$event=@{
 schemaVersion=1;kind='aicc-owner-group-event';issuer='aicc-owner-controller';threadId=$thread;eventId=$EventId;
 projectRoot=$sourceRoot;sourceRoot=$sourceRoot;accountNumber=2;route='command-route-r2';
 ownerRevision=$revision;stopEpoch=7;workerOperationId=$operation;sourceId=$sourceId;resultFile=$resultFile;resultSha256=$resultSha;
 expectedStatus='COMPLETED';sourceWriterReceiptFile=$receiptFile;sourceWriterReceiptSha256=$receiptSha;
 registrationFile=$regFile;registrationSha256=$regSha;terminalSha256=$script:terminalHash;
 callbackPending=$false;queuePending=$false;originalPending=$false;writerReleased=$true;sourceWriterReturned=$true;
 stopRequested=$false;authorityFresh=$true;observedAt=[DateTimeOffset]::UtcNow.ToString('o')
}
Write-Fixture $eventFile $event
$ExpectedEventSha256=Sha $eventFile
$ExpectedResultSha256=$resultSha
$StrictAccountNumber=2
$ThreadId=$thread
$Confirm='AUTHORIZE GROUP EVENT '+$ExpectedEventSha256
$entry=@{threadId=$thread;projectRoot=$sourceRoot;rollout=(Join-Path $sourceRoot 'rollout.jsonl');
 enabled=$false;state='DISABLED';strictAccount=2;groupOwnerOnly=$true;groupOwnerRevision=$revision;groupStopEpoch=7;groupWorkerOperationId=$operation;
 attempt=$null;queueAttempt=$null;groupEvent=$null}
$cfg=@{schemaVersion=1;excludedThreadIds=@();workerStopRequestedAt=$null;threads=@{$thread=$entry};groupOwner=$null}
$oldObservedAt=$event.observedAt
$event.observedAt=[DateTimeOffset]::UtcNow.AddMinutes(-3).ToString('o')
Write-Fixture $eventFile $event
$staleSha=Sha $eventFile
$staleRejected=$false
try{Register-GroupOwnerEvidence $cfg $ThreadId $StrictAccountNumber $EventId $staleSha $StateRoot ('AUTHORIZE GROUP EVENT '+$staleSha)|Out-Null}catch{$staleRejected=$true}
Check ($staleRejected -and -not $cfg.groupOwner) 'expired source event never accepted'
$event.observedAt=[DateTimeOffset]::UtcNow.ToString('o')
Write-Fixture $eventFile $event
$ExpectedEventSha256=Sha $eventFile;$Confirm='AUTHORIZE GROUP EVENT '+$ExpectedEventSha256
$r=Register-GroupOwnerEvidence $cfg $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $StateRoot $Confirm
Check ($r.state -ceq 'OWNER_EVENT_REGISTERED_NOT_ENQUEUED' -and -not $entry.enabled) 'owner authorised without dispatch'
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'READY') 'exact owner event proof ready'
$script:quotaStatus='STRICT_QUOTA_WAIT'
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'STRICT_QUOTA_WAIT') 'selected quota wait'
$script:quotaStatus='STRICT_ACCOUNT_READY'
$script:ownerStatus='REGISTERED_OWNER_ACTIVE'
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'ORIGINAL_WRITER_NOT_RELEASED') 'active original never launches'
$script:ownerStatus='RELEASED'
$script:terminalHash='f'*64
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'ORIGINAL_TERMINAL_CHANGED_HOLD') 'stale terminal'
$script:terminalHash='c'*64
$cfg.workerStopRequestedAt='stopped'
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'WORKER_STOP_HOLD') 'maintenance stop fence'
$cfg.workerStopRequestedAt=$null
$cfg.threads['33333333-3333-4333-8333-333333333333']=@{attempt=@{id='unknown'}}
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'PENDING_DELIVERY_HOLD') 'other thread pending conserved'
$cfg.threads.Remove('33333333-3333-4333-8333-333333333333')
$cfg.threads['33333333-3333-4333-8333-333333333333']=@{queueAttempt=@{state='QUEUE_ACCEPTED'}}
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'PENDING_DELIVERY_HOLD') 'historical pending Desktop queue preserved'
$cfg.threads.Remove('33333333-3333-4333-8333-333333333333')
$StrictAccountNumber=1
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'GROUP_OWNER_BINDING_HOLD') 'wrong account'
$StrictAccountNumber=2
$ExpectedResultSha256='d'*64
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'GROUP_OWNER_BINDING_HOLD') 'wrong result SHA'
$ExpectedResultSha256=$resultSha
$ThreadId='33333333-3333-4333-8333-333333333333'
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'GROUP_OWNER_BINDING_HOLD') 'wrong original thread'
$ThreadId=$thread
$originalRoot=$StateRoot;$StateRoot=Join-Path $root 'foreign'
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'GROUP_OWNER_ROOT_REQUIRED') 'wrong owner root'
$StateRoot=$originalRoot
$entry.groupStopEpoch=8
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'GROUP_OWNER_GENERATION_HOLD') 'stale stop epoch rejected'
$entry.groupStopEpoch=7
$intent=Add-GroupOwnerEvent $cfg $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot
Check ($intent.state -ceq 'STRICT_INTENT_RECORDED' -and $entry.groupEvent.state -ceq 'ENQUEUED' -and -not $intent.dispatched) 'one event accepted not executed'
Check ((Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot).state -ceq 'GROUP_EVENT_ALREADY_RECORDED') 'duplicate enqueue held'
Check (-not(Confirm-GroupOwnerClaim $cfg $entry $StateRoot '44444444-4444-4444-8444-444444444444')) 'different worker operation cannot claim'
Check (Confirm-GroupOwnerClaim $cfg $entry $StateRoot $operation) 'existing worker create-once claim'
Check ((Test-Path -LiteralPath (Join-Path $StateRoot ('group-claims/'+$EventId+'.json'))) -and $entry.groupEvent.state -ceq 'CLAIMED') 'durable claim marker before model'
Check (-not(Confirm-GroupOwnerClaim $cfg $entry $StateRoot $operation)) 'lost ACK cannot replay claim'
@{terminal='PASS';checks=$checks;modelRequests=0;workerStarted=$false;fixture=$root}|ConvertTo-Json -Compress
