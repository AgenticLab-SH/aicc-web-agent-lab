#requires -Version 7.5
# Transaction-only fake. Cryptography/goal/issuer gates have independent Node
# fixtures; this never connects to the user's live server, Task or registry.
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityMaintenance.psm1') -Force
$m=Get-Module CodexContinuityMaintenance
$sandbox=Join-Path ([IO.Path]::GetTempPath()) ('aicc-callback-transaction-'+[guid]::NewGuid().ToString('N'))
$state=Join-Path $sandbox 'continuity';$plans=Join-Path $state 'plans'
$null=New-Item -ItemType Directory -Path $plans -Force
$registry=Join-Path $state 'registrations.json';$null=[IO.File]::WriteAllBytes((Join-Path $state 'registrations.json.lock'),[byte[]]@())
$global:callbackTestRoot=$sandbox
$realInspect=& $m { (Get-Item Function:Callback-Inspect).ScriptBlock }
& $m {
 function script:GroupInstall-RequireOwner([string]$StateRoot){
  if([IO.Path]::GetFullPath($StateRoot) -ine (Join-Path $global:callbackTestRoot 'continuity')){throw 'fake_owner_scope_required'}
 }
 function script:Callback-Inspect($p){
  if((Maintenance-Hash (Join-Path $p.stateRoot 'registrations.json')) -cne $p.registrySha256){throw 'callback_registry_cas_changed'}
  if($global:callbackTestHold){throw 'fake_original_issuer_hold'}
  @{state='PREPARED_ORIGINAL_CALLBACK_REGISTRATION_REQUIRES_OWNER_CAS';callbackPin=@{kind='aicc-original-cli-issuer-callback-pin/v1';receiptFile='fake-owner-callback';receiptSha256=('c'*64)}}
 }
}
$id='11111111-1111-4111-8111-111111111111';$checks=0
function Check($ok,$name){if(-not $ok){throw ('FAIL '+$name)};$script:checks++}
function Hash($file){(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
function Put($file,$v){[IO.File]::WriteAllText($file,($v|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))}
function Base {
 @{schemaVersion=1;protocolVersion=3;workerStopRequestedAt='kept';worker=@{state='STOPPED_FOR_MAINTENANCE'};
  threads=@{$id=@{threadId=$id;enabled=$true};other=@{queueAttempt=@{id='original-unknown';state='QUEUE_ACCEPTED'}}}}
}
function Plan($name){
 $p=@{schemaVersion=1;action='RegisterOriginalIssuerCallback';stateRoot=$state;threadId=$id;registrySha256=(Hash $registry);operationId=[guid]::NewGuid().ToString();expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(60).ToString('o');callbackFile='fake-owner-callback';callbackSha256=('c'*64)}
 $file=Join-Path $plans ($name+'.json');Put $file $p;return $file
}
function Apply($file){$sha=Hash $file;Invoke-AiccOriginalIssuerCallbackPlan -PlanFile $file -ExpectedPlanSha256 $sha -Confirm ('REGISTER ORIGINAL CALLBACK '+$sha)}
$actualSource=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$fakeRuntime=Join-Path $sandbox 'preview-runtime.bin';[IO.File]::WriteAllText($fakeRuntime,'fake-never-run')
Put $registry (Base);$registryBefore=Hash $registry
$previewFile=Join-Path $plans 'explicit-callback-preview.json'
$preview=New-AiccOriginalIssuerCallbackPlan -StateRoot $state -SourceRoot $actualSource -NodePath $fakeRuntime -ManifestFile $fakeRuntime -ExpectedManifestSha256 (Hash $fakeRuntime) -ThreadId $id -ProjectRoot $sandbox -ExpectedGoalSha256 ('a'*64) -HandoffFile 'fake-handoff' -ExpectedHandoffSha256 ('b'*64) -CallbackFile 'fake-owner-callback' -ExpectedCallbackSha256 ('c'*64) -PlanFile $previewFile
Check ($preview.state -ceq 'PREPARED_ORIGINAL_CALLBACK_REGISTRATION' -and (Hash $registry) -ceq $registryBefore) 'preview creates plan without registry mutation'
Check ($preview.confirmation -ceq ('REGISTER ORIGINAL CALLBACK '+(Hash $previewFile)) -and -not $preview.workerStarted) 'exact preview confirmation'
$failed=$false
try{New-AiccOriginalIssuerCallbackPlan -StateRoot $state -SourceRoot $actualSource -NodePath $fakeRuntime -ManifestFile $fakeRuntime -ThreadId $id -PlanFile $previewFile}catch{$failed=$true}
Check ($failed -and (Hash $registry) -ceq $registryBefore) 'existing preview not overwritten'
# Exercise the production pre-network gates separately from the transaction
# fake: no original pending/stop/absent issuer may reach the external runner.
$sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$nodeFile=Join-Path $sandbox 'node-pin.bin';[IO.File]::WriteAllText($nodeFile,'fake-runtime-never-run')
$sourcePins=@{}
foreach($relative in @('src/codex-goal-resume.mjs','tools/platform/codex/inspect-original-issuer-callback.mjs','tools/platform/windows/CodexContinuityMaintenance.psm1','src/adapters/codex-app-server.mjs','src/adapters/codex-app-server-proxy.mjs','src/adapters/codex-app-server-daemon.mjs','src/lib/windows-owner-only-acl.mjs','src/lib/windows-pwsh.mjs')){$sourcePins[$relative]=Hash (Join-Path $sourceRoot $relative)}
foreach($mode in @('pending','stop','producer')){
 $v=Base
 if($mode -ne 'pending'){$v.threads.Remove('other')}
 if($mode -eq 'producer'){$v.workerStopRequestedAt=$null;$v.worker.state='STOPPED_BUT_UNRELEASED'}
 Put $registry $v
 $p=@{sourcePins=$sourcePins;sourceRoot=$sourceRoot;stateRoot=$state;threadId=$id;registrySha256=(Hash $registry);nodePath=$nodeFile;nodeSha256=(Hash $nodeFile);manifestFile=$nodeFile;manifestSha256=(Hash $nodeFile)}
 $reason=$null
 try{& $m $realInspect $p}catch{$reason=$_.Exception.Message}
 $expected=@{pending='callback_original_or_historical_pending_unsettled_hold';stop='callback_maintenance_stop_preserved_hold';producer='callback_independent_original_producer_not_registered_hold'}[$mode]
 Check ($reason -ceq $expected) ('production pre-network '+$mode)
}
Put $registry (Base);$original=[IO.File]::ReadAllBytes($registry);$file=Plan 'valid-callback-plan'
$r=Apply $file
Check ($r.state -ceq 'REGISTERED_ORIGINAL_CALLBACK_SENDER_INACTIVE' -and -not $r.workerStarted -and -not $r.dispatchable) 'source registration does not activate sender'
$after=Get-Content -LiteralPath $registry -Raw|ConvertFrom-Json -AsHashtable
Check ($after.workerStopRequestedAt -ceq 'kept' -and $after.threads.other.queueAttempt.id -ceq 'original-unknown') 'unrelated stop and pending preserved by transaction'
Check ([Convert]::ToHexString([IO.File]::ReadAllBytes($file+'.registry.before')) -ceq [Convert]::ToHexString($original)) 'exact backup'
Check ((Test-Path -LiteralPath ($file+'.receipt.json')) -and (Test-Path -LiteralPath ($file+'.claimed'))) 'durable claim and receipt'
try{Apply $file;throw 'unexpected success'}catch{Check ($_.Exception.Message -match 'cas_changed|already_registered') 'duplicate refused'}
foreach($mode in @('drift','expired','bad-confirm','issuer-hold','claimed')){
 Put $registry (Base);$file=Plan ('callback-'+$mode+'-plan');$before=Hash $registry
 if($mode -eq 'drift'){$v=Base;$v.workerStopRequestedAt='new-stop';Put $registry $v;$before=Hash $registry}
 if($mode -eq 'expired'){$p=Get-Content -Raw -LiteralPath $file|ConvertFrom-Json -AsHashtable;$p.expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o');Put $file $p}
 if($mode -eq 'issuer-hold'){$global:callbackTestHold=$true}
 if($mode -eq 'claimed'){[IO.File]::WriteAllText($file+'.claimed','previous-attempt')}
 $failed=$false
 try{if($mode -eq 'bad-confirm'){Invoke-AiccOriginalIssuerCallbackPlan -PlanFile $file -ExpectedPlanSha256 (Hash $file) -Confirm 'wrong'}else{Apply $file}}catch{$failed=$true}
 $global:callbackTestHold=$false
 Check ($failed -and (Hash $registry) -ceq $before) ('no mutation on '+$mode)
}
@{status='PASS';checks=$checks;liveStateChanged=$false;modelRequests=0;fixture=$sandbox}|ConvertTo-Json -Compress
