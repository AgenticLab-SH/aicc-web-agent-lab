#requires -Version 7.5
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityCliPin.psm1') -Force
$module=Get-Module CodexContinuityCliPin
& $module {
 function script:Get-AuthenticodeSignature {
  param([string]$LiteralPath)
  $side=if($LiteralPath -match '[\\/]old[\\/]'){'old'}else{'new'}
  @{Status=$script:fakeSignatures[$side].status;SignerCertificate=@{Subject=$script:fakeSignatures[$side].subject;Thumbprint=$script:fakeSignatures[$side].thumb}}
 }
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-stable-observation-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory $root|Out-Null
$checks=0
function Check($ok,$label){if(-not $ok){throw ('FAIL: '+$label)};$script:checks++}
function Reject($block,$pattern,$label){try{& $block;throw 'expected_rejection_missing'}catch{Check ($_.Exception.Message -match $pattern) $label}}
function Setup($name){
 $r=Join-Path $root $name;$state=Join-Path $r 'state';$base=Join-Path $r 'standalone';$old=Join-Path $base 'releases/old';$new=Join-Path $base 'releases/new'
 foreach($d in @($state,(Join-Path $old 'bin'),(Join-Path $new 'bin'))){New-Item -ItemType Directory $d -Force|Out-Null}
 [IO.File]::WriteAllText((Join-Path $old 'bin/codex.exe'),'old');[IO.File]::WriteAllText((Join-Path $new 'bin/codex.exe'),'new')
 New-Item -ItemType Junction -Path (Join-Path $base 'current') -Target $new|Out-Null
 $helper=Join-Path $r 'helper.ps1';[IO.File]::WriteAllText($helper,'fixture only')
 $oldHash=(Get-FileHash (Join-Path $old 'bin/codex.exe')).Hash.ToLowerInvariant();$newHash=(Get-FileHash (Join-Path $new 'bin/codex.exe')).Hash.ToLowerInvariant()
 $cfg=@{schemaVersion=1;protocolVersion=3;nativeFallback=$false;codexExecutable=[IO.Path]::GetFullPath((Join-Path $base 'current/bin/codex.exe'));codexSha256=$oldHash;helperPath=$helper;helperSha256=(Get-FileHash $helper).Hash.ToLowerInvariant();worker=@{state='WATCHING';heartbeatAt='before'};workerStopRequestedAt=$null;threads=@{}}
 $file=Join-Path $state 'registrations.json';[IO.File]::WriteAllText($file,($cfg|ConvertTo-Json -Depth 10));[IO.File]::WriteAllText(($file+'.lock'),'')
 & $module {$script:fakeSignatures=@{old=@{status='Valid';subject='O="OpenAI OpCo, LLC", C=US';thumb=('A'*40)};new=@{status='Valid';subject='O="OpenAI OpCo, LLC", C=US';thumb=('B'*40)}}}
 @{StateRoot=$state;StandaloneRoot=$base;OldRelease=$old;NewRelease=$new;ExpectedOldSha256=$oldHash;ExpectedNewSha256=$newHash;ExpectedOldSignerThumbprint=('A'*40);ExpectedNewSignerThumbprint=('B'*40);PlanFile=(Join-Path $r 'plan.json')}
}

function Fixture($name){
 $a=Setup $name;$file=Join-Path $a.StateRoot 'registrations.json';$cfg=Get-Content $file -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $stamp='2026-10-25T01:00:00.0000000+00:00';$cfg.apiToken='fixture-secret-do-not-serialize'
 $cfg.excludedThreadIds=@();$cfg.threads.desktop=@{threadId='desktop';enabled=$true;state='DESKTOP_QUEUE_WAIT';executionSurface='desktop';attempt=$null;queueAttempt=$null;holdReason=$null;ownerPid=12;ownerCreatedAt=$stamp;observedAt=$stamp;nextCheckAt=$stamp}
 $cfg.threads.archived=@{threadId='archived';enabled=$true;state='ARCHIVED_THREAD_HOLD';availabilityState='ARCHIVED_THREAD_HOLD';attempt=$null;queueAttempt=$null;observedAt=$stamp;nextCheckAt=$stamp}
 $cfg.threads.cli=@{threadId='cli';enabled=$true;state='REQUIRED_ACTION_HOLD';executionSurface='cli';holdReason='EXACT_HOLD';attempt=$null;queueAttempt=$null;observedAt=$stamp;nextCheckAt=$stamp}
 $id='11111111-1111-4111-8111-111111111111';$op='22222222-2222-4222-8222-222222222222'
 $q=@{id=$op;threadId=$id;transport='codex-queue';state='QUEUE_ACCEPTED';queuedMessageId='33333333-3333-4333-8333-333333333333';binarySource='signed-desktop-transport';binarySha256=('c'*64);automaticReplay=$false;exitCode=0;marker=('AICC_QUEUE_ATTEMPT:'+$op)}
 $cfg.threads[$id]=@{threadId=$id;enabled=$false;state='DISABLED';attempt=$null;queueAttempt=$q;observedAt=$stamp;nextCheckAt=$stamp}
 & $module {param($h)$script:DesktopQueueDependencyHelperSha256=$h} $cfg.helperSha256
 New-Item -ItemType Directory (Join-Path $a.StateRoot 'requests')|Out-Null
 $receipt=Join-Path $a.StateRoot ('requests/'+$op+'.json');[IO.File]::WriteAllText($receipt,($q|ConvertTo-Json -Depth 10))
 [IO.File]::WriteAllText($file,($cfg|ConvertTo-Json -Depth 20))
 @{args=$a;cfg=$cfg;file=$file;receipt=$receipt;queueId=$id}
}
function Save($s){[IO.File]::WriteAllText($s.file,($s.cfg|ConvertTo-Json -Depth 20))}
function Plan($s){$a=$s.args;New-AiccContinuityCliPinPlan @a}
function Apply($s,$p){Invoke-AiccContinuityCliPinPlan -PlanFile $s.args.PlanFile -ExpectedPlanSha256 $p.planSha256 -Confirm $p.confirmation}
$s=Fixture 'observations';$p=Plan $s;$plan=Get-Content $s.args.PlanFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
Check ($plan.scopeContract -ceq 'pin-stable-v2' -and $plan.stableScope.fields.ContainsKey('/threads/desktop/state')) 'plan seals stable per-field digest structure'
Check (-not ([IO.File]::ReadAllText($s.args.PlanFile).Contains('fixture-secret-do-not-serialize'))) 'stable scope contains no plaintext config secret'
Check ($plan.stableScope.ignoredTelemetry.Count -eq 5) 'only worker heartbeat and two exact non-dispatch observation timestamp pairs excluded'
$s.cfg.worker.heartbeatAt='new-heartbeat';foreach($id in @('desktop','archived')){$s.cfg.threads[$id].observedAt='2026-10-25T01:00:30.0000000+00:00';$s.cfg.threads[$id].nextCheckAt='2026-10-25T01:02:30.0000000+00:00'}
Save $s;$latest=[IO.File]::ReadAllText($s.file);$receipt=[IO.File]::ReadAllText($s.receipt);$r=Apply $s $p
Check ($r.state -ceq 'APPLIED' -and [IO.File]::ReadAllText($s.file) -ceq $latest.Replace($s.args.ExpectedOldSha256,$s.args.ExpectedNewSha256)) 'latest locked raw observation bytes retained while only CLI pin changes'
Check ([IO.File]::ReadAllText($s.receipt) -ceq $receipt -and $r.preservedQueues.Count -eq 1) 'old independent queue and original receipt preserved with observation drift'
foreach($kind in @('enabled','hold','state','owner-pid','owner-created','config','excluded','helper','cli-next','cli-observed','queue-timestamp','queue-binary','attempt','invalid-timestamp')){
 $s=Fixture $kind;$p=Plan $s
 switch($kind){
  'enabled' {$s.cfg.threads.desktop.enabled=$false}
  'hold' {$s.cfg.threads.desktop.holdReason='REQUIRES_ACTION'}
  'state' {$s.cfg.threads.desktop.state='REQUIRED_ACTION_HOLD'}
  'owner-pid' {$s.cfg.threads.desktop.ownerPid=99}
  'owner-created' {$s.cfg.threads.desktop.ownerCreatedAt='changed'}
  'config' {$s.cfg.apiToken='different-secret-do-not-output'}
  'excluded' {$s.cfg.excludedThreadIds=@('desktop')}
  'helper' {$s.cfg.helperSha256=('e'*64)}
  'cli-next' {$s.cfg.threads.cli.nextCheckAt='2026-10-25T01:03:00.0000000+00:00'}
  'cli-observed' {$s.cfg.threads.cli.observedAt='2026-10-25T01:03:00.0000000+00:00'}
  'queue-timestamp' {$s.cfg.threads[$s.queueId].observedAt='2026-10-25T01:03:00.0000000+00:00'}
  'queue-binary' {$s.cfg.threads[$s.queueId].queueAttempt.binarySha256=('b'*64)}
  'attempt' {$s.cfg.threads.desktop.attempt=@{id='uncertain'}}
  'invalid-timestamp' {$s.cfg.threads.desktop.nextCheckAt='not-a-timestamp'}
 }
 Save $s
 Reject {Apply $s $p} 'cli_pin_preview_scope_changed|installed_helper_identity_hold|desktop_queue_receipt_binding_changed|existing_dispatch_preserved' ($kind+' remains strict HOLD')
 Check (-not(Test-Path ($s.args.PlanFile+'.claimed'))) ($kind+' rejects before claim or write')
}
$s=Fixture 'diagnostic';$p=Plan $s;$s.cfg.apiToken='different-secret-do-not-output';Save $s
try{Apply $s $p;throw 'missing_rejection'}catch{$message=$_.Exception.Message}
Check ($message -ceq 'cli_pin_preview_scope_changed:/apiToken' -and -not $message.Contains('different-secret')) 'scope failure exposes exact changed field path without secret values'
$s=Fixture 'legacy-strict';$p=Plan $s;$plan=Get-Content $s.args.PlanFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
$plan.Remove('scopeContract');$plan.Remove('stableScope');$plan.registryScopeSha256=& $module {param($c)Get-PinScopeDigest $c $null} $s.cfg
[IO.File]::WriteAllText($s.args.PlanFile,($plan|ConvertTo-Json -Depth 20));$p.planSha256=(Get-FileHash $s.args.PlanFile).Hash.ToLowerInvariant();$p.confirmation='APPLY CODEX PIN '+$p.planSha256
$s.cfg.threads.desktop.nextCheckAt='2026-10-25T01:03:00.0000000+00:00';Save $s
Reject {Apply $s $p} 'cli_pin_preview_scope_changed' 'legacy digest-only plans retain former strict scope'
@{terminal='PASS';checks=$checks;fixture=$root;signature='FAKE_RUNNER_ONLY';livePlansCreated=0;liveRegistryChanges=0;workerStops=0;messages=0}|ConvertTo-Json
