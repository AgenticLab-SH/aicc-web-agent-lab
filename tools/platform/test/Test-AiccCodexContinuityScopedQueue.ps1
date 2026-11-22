#requires -Version 7.5
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityCliPin.psm1') -Force
$module=Get-Module CodexContinuityCliPin
& $module {function script:Get-AuthenticodeSignature {param([string]$LiteralPath) @{Status='Valid';SignerCertificate=@{Subject='O="OpenAI OpCo, LLC", C=US';Thumbprint=('A'*40)}}}}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-scoped-queue-test-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory $root|Out-Null
$checks=0
function Check($condition,$label){if(-not $condition){throw ('FAIL: '+$label)};$script:checks++}
function Reject($code,$pattern,$label){try{& $code;throw 'expected_rejection_missing'}catch{Check ($_.Exception.Message -match $pattern) $label}}
function Setup($name){
 $r=Join-Path $root $name;$state=Join-Path $r 'state';$standalone=Join-Path $r 'standalone';$old=Join-Path $standalone 'releases/old';$new=Join-Path $standalone 'releases/new'
 foreach($d in @((Join-Path $state 'requests'),(Join-Path $old 'bin'),(Join-Path $new 'bin'))){New-Item -ItemType Directory $d -Force|Out-Null}
 [IO.File]::WriteAllText((Join-Path $old 'bin/codex.exe'),'old-fake');[IO.File]::WriteAllText((Join-Path $new 'bin/codex.exe'),'new-fake')
 New-Item -ItemType Junction -Path (Join-Path $standalone 'current') -Target $new|Out-Null
 $helper=Join-Path $r 'fixture-helper.ps1';[IO.File]::WriteAllText($helper,'fixture reviewed dependency contract')
 $helperHash=(Get-FileHash $helper).Hash.ToLowerInvariant()
 # This trust substitution exists only in the fake runner, never as an action flag.
 & $module {param($hash)$script:DesktopQueueDependencyHelperSha256=$hash} $helperHash
 $oldHash=(Get-FileHash (Join-Path $old 'bin/codex.exe')).Hash.ToLowerInvariant();$newHash=(Get-FileHash (Join-Path $new 'bin/codex.exe')).Hash.ToLowerInvariant()
 $id='11111111-1111-4111-8111-111111111111';$op='22222222-2222-4222-8222-222222222222'
 $queue=@{id=$op;threadId=$id;transport='codex-queue';state='QUEUE_ACCEPTED';queuedMessageId='33333333-3333-4333-8333-333333333333';binarySource='signed-desktop-transport';binarySha256=('c'*64);automaticReplay=$false;exitCode=0;marker=('AICC_QUEUE_ATTEMPT:'+$op);at='2026-10-23T10:00:00Z';messageSha256=('d'*64)}
 $receipt=Join-Path $state ('requests/'+$op+'.json');[IO.File]::WriteAllText($receipt,($queue|ConvertTo-Json -Depth 10))
 $entry=@{threadId=$id;enabled=$false;state='DISABLED';attempt=$null;queueAttempt=$queue;holdReason='preserve'}
 $cfg=@{schemaVersion=1;protocolVersion=3;nativeFallback=$false;codexExecutable=[IO.Path]::GetFullPath((Join-Path $standalone 'current/bin/codex.exe'));codexSha256=$oldHash;helperPath=$helper;helperSha256=$helperHash;worker=@{state='WATCHING';heartbeatAt='before'};workerStopRequestedAt=$null;threads=@{}}
 $cfg.threads[$id]=$entry;$file=Join-Path $state 'registrations.json'
 [IO.File]::WriteAllText($file," `r`n"+($cfg|ConvertTo-Json -Depth 20)+"`r`n  ");[IO.File]::WriteAllText(($file+'.lock'),'')
 @{args=@{StateRoot=$state;StandaloneRoot=$standalone;OldRelease=$old;NewRelease=$new;ExpectedOldSha256=$oldHash;ExpectedNewSha256=$newHash;ExpectedSignerThumbprint=('A'*40);PlanFile=(Join-Path $r 'plan.json')};file=$file;receipt=$receipt;id=$id;cfg=$cfg}
}
function Save($s){[IO.File]::WriteAllText($s.file,($s.cfg|ConvertTo-Json -Depth 20))}
function SaveReceipt($s){[IO.File]::WriteAllText($s.receipt,($s.cfg.threads[$s.id].queueAttempt|ConvertTo-Json -Depth 10))}
function Plan($s){$a=$s.args;New-AiccContinuityCliPinPlan @a}
function Apply($s,$p){Invoke-AiccContinuityCliPinPlan -PlanFile $s.args.PlanFile -ExpectedPlanSha256 $p.planSha256 -Confirm $p.confirmation}
$s=Setup 'independent';$before=[IO.File]::ReadAllText($s.file);$queueBefore=[IO.File]::ReadAllBytes($s.receipt);$p=Plan $s
Check ($p.state -eq 'PREPARED') 'separate disabled accepted Desktop queue permits scoped preview'
$result=Apply $s $p
Check ([IO.File]::ReadAllText($s.file) -ceq $before.Replace($s.args.ExpectedOldSha256,$s.args.ExpectedNewSha256)) 'only exact 64-byte CLI pin changes, all queue/config original bytes remain'
Check (($queueBefore -join ',') -ceq ([IO.File]::ReadAllBytes($s.receipt) -join ',')) 'original request receipt raw bytes preserved'
Check ($result.preservedQueues.Count -eq 1 -and $result.preservedQueues[0].binarySha256 -ceq ('c'*64) -and -not $result.workerStopped) 'separate binary pin is retained in post-readback evidence'
Check ([IO.File]::ReadAllText(($s.args.PlanFile+'.before.json')) -ceq $before) 'backup retains full original bytes including queue'
foreach($kind in @('registered-source','enabled','replay','same-old','same-new','unknown-helper','unknown-state','other-attempt','string-disabled','string-replay')){
 $s=Setup $kind;$q=$s.cfg.threads[$s.id].queueAttempt
 switch($kind){
  'string-disabled' {$s.cfg.threads[$s.id].enabled='False'}
  'string-replay' {$q.automaticReplay='False'}
  'registered-source' {$q.binarySource='registered-codex'}
  'enabled' {$s.cfg.threads[$s.id].enabled=$true}
  'replay' {$q.automaticReplay=$true}
  'same-old' {$q.binarySha256=$s.args.ExpectedOldSha256}
  'same-new' {$q.binarySha256=$s.args.ExpectedNewSha256}
  'unknown-helper' {& $module {$script:DesktopQueueDependencyHelperSha256=('e'*64)}}
  'unknown-state' {$s.cfg.threads[$s.id].state='DELIVERY_UNCERTAIN'}
  'other-attempt' {$s.cfg.threads.other=@{state='DISABLED';attempt=@{id='unresolved'};queueAttempt=$null}}
 }
 Save $s;SaveReceipt $s
 Reject {Plan $s} 'existing_dispatch_preserved' ($kind+' remains HOLD')
 Check (-not(Test-Path $s.args.PlanFile)) ($kind+' writes no plan')
}
$s=Setup 'receipt-binding';$other=@{id='different'};[IO.File]::WriteAllText($s.receipt,($other|ConvertTo-Json))
Reject {Plan $s} 'desktop_queue_receipt_binding_changed' 'different original receipt cannot certify unrelated dependency'
$s=Setup 'receipt-raw-drift';$p=Plan $s;[IO.File]::AppendAllText($s.receipt,"`n ")
Reject {Apply $s $p} 'preserved_queue_preview_changed' 'even semantic-identical receipt byte drift is stale'
Check (-not(Test-Path ($s.args.PlanFile+'.claimed'))) 'receipt drift rejects before one-use claim or registry writes'
$s=Setup 'queue-pin-drift';$p=Plan $s;$s.cfg.threads[$s.id].queueAttempt.binarySha256=('b'*64);Save $s;SaveReceipt $s
Reject {Apply $s $p} 'preserved_queue_preview_changed|preview_scope_changed' 'independent historical binary pin cannot change after preview'
$s=Setup 'ambiguous-pin';$p=Plan $s
$text=[IO.File]::ReadAllText($s.file);$text=$text.Replace('"protocolVersion": 3','"codexSha256": "'+$s.args.ExpectedOldSha256+'", "protocolVersion": 3');[IO.File]::WriteAllText($s.file,$text)
Reject {Apply $s $p} 'unique_top_level_codex_pin_required' 'duplicate literal top-level pin is rejected before claim'
Check (-not(Test-Path ($s.args.PlanFile+'.claimed'))) 'ambiguous original bytes do not consume claim'
@{terminal='PASS';checks=$checks;fixture=$root;signature='FAKE_RUNNER_ONLY';liveRegistrationsChanged=0;workerStops=0;messages=0}|ConvertTo-Json
