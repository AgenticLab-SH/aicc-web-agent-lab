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
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-signer-rotation-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory $root|Out-Null
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
$a=Setup 'rotation';$p=New-AiccContinuityCliPinPlan @a;$plan=Get-Content $a.PlanFile -Raw|ConvertFrom-Json
Check ($plan.oldSignerThumbprint -ceq ('A'*40) -and $plan.newSignerThumbprint -ceq ('B'*40)) 'preview seals each exact rotated certificate'
$r=Invoke-AiccContinuityCliPinPlan -PlanFile $a.PlanFile -ExpectedPlanSha256 $p.planSha256 -Confirm $p.confirmation
Check ($r.state -ceq 'APPLIED' -and $r.oldSignerThumbprint -ceq ('A'*40) -and $r.newSignerThumbprint -ceq ('B'*40)) 'apply verifies and receipts each exact signer without worker stop'
foreach($kind in @('wrong-old','wrong-new','swapped','invalid-old','invalid-new','wrong-vendor-old','wrong-vendor-new','mixed','missing-old','missing-new','legacy-rotation')){
 $a=Setup $kind
 switch($kind){
  'wrong-old' {$a.ExpectedOldSignerThumbprint=('C'*40)}
  'wrong-new' {$a.ExpectedNewSignerThumbprint=('C'*40)}
  'swapped' {$a.ExpectedOldSignerThumbprint=('B'*40);$a.ExpectedNewSignerThumbprint=('A'*40)}
  'invalid-old' {& $module {$script:fakeSignatures.old.status='NotTrusted'}}
  'invalid-new' {& $module {$script:fakeSignatures.new.status='NotTrusted'}}
  'wrong-vendor-old' {& $module {$script:fakeSignatures.old.subject='O=Other Vendor, C=US'}}
  'wrong-vendor-new' {& $module {$script:fakeSignatures.new.subject='O=Other Vendor, C=US'}}
  'mixed' {$a.ExpectedSignerThumbprint=('A'*40)}
  'missing-old' {$a.Remove('ExpectedOldSignerThumbprint')}
  'missing-new' {$a.Remove('ExpectedNewSignerThumbprint')}
  'legacy-rotation' {$a.Remove('ExpectedOldSignerThumbprint');$a.Remove('ExpectedNewSignerThumbprint');$a.ExpectedSignerThumbprint=('A'*40)}
 }
 Reject {New-AiccContinuityCliPinPlan @a} 'valid_exact_openai_signature_required|exclusive_exact_signer_contract_required|exact_old_and_new_signers_required' ($kind+' rejects')
 Check (-not(Test-Path $a.PlanFile)) ($kind+' leaves preview and registry untouched')
}
$a=Setup 'legacy-same';$a.Remove('ExpectedOldSignerThumbprint');$a.Remove('ExpectedNewSignerThumbprint');$a.ExpectedSignerThumbprint=('A'*40)
& $module {$script:fakeSignatures.new.thumb=('A'*40)}
$p=New-AiccContinuityCliPinPlan @a
Check ($p.state -ceq 'PREPARED') 'legacy single exact signer accepts only actual same certificate'
$a=Setup 'late-old-signature';$p=New-AiccContinuityCliPinPlan @a
& $module {$script:fakeSignatures.old.thumb=('C'*40)}
Reject {Invoke-AiccContinuityCliPinPlan -PlanFile $a.PlanFile -ExpectedPlanSha256 $p.planSha256 -Confirm $p.confirmation} 'valid_exact_openai_signature_required' 'apply rechecks old signature'
Check (-not(Test-Path ($a.PlanFile+'.claimed'))) 'late signer drift rejects before claim'
$a=Setup 'late-new-signature';$p=New-AiccContinuityCliPinPlan @a
& $module {$script:fakeSignatures.new.thumb=('C'*40)}
Reject {Invoke-AiccContinuityCliPinPlan -PlanFile $a.PlanFile -ExpectedPlanSha256 $p.planSha256 -Confirm $p.confirmation} 'valid_exact_openai_signature_required' 'apply rechecks new signature'
Check (-not(Test-Path ($a.PlanFile+'.claimed'))) 'late new signer drift rejects before claim'
$a=Setup 'rotation-with-independent-queue';$file=Join-Path $a.StateRoot 'registrations.json';$cfg=Get-Content $file -Raw|ConvertFrom-Json -AsHashtable -DateKind String
$id='11111111-1111-4111-8111-111111111111';$op='22222222-2222-4222-8222-222222222222'
$q=@{id=$op;threadId=$id;transport='codex-queue';state='QUEUE_ACCEPTED';queuedMessageId='33333333-3333-4333-8333-333333333333';binarySource='signed-desktop-transport';binarySha256=('c'*64);automaticReplay=$false;exitCode=0;marker=('AICC_QUEUE_ATTEMPT:'+$op)}
$cfg.threads[$id]=@{threadId=$id;enabled=$false;state='DISABLED';attempt=$null;queueAttempt=$q}
& $module {param($hash)$script:DesktopQueueDependencyHelperSha256=$hash} $cfg.helperSha256
New-Item -ItemType Directory (Join-Path $a.StateRoot 'requests')|Out-Null
$receipt=Join-Path $a.StateRoot ('requests/'+$op+'.json');[IO.File]::WriteAllText($receipt,($q|ConvertTo-Json -Depth 10));$receiptBefore=[IO.File]::ReadAllText($receipt)
[IO.File]::WriteAllText($file,($cfg|ConvertTo-Json -Depth 20));$before=[IO.File]::ReadAllText($file)
$p=New-AiccContinuityCliPinPlan @a;$r=Invoke-AiccContinuityCliPinPlan -PlanFile $a.PlanFile -ExpectedPlanSha256 $p.planSha256 -Confirm $p.confirmation
Check ($r.preservedQueues.Count -eq 1 -and [IO.File]::ReadAllText($file) -ceq $before.Replace($a.ExpectedOldSha256,$a.ExpectedNewSha256) -and [IO.File]::ReadAllText($receipt) -ceq $receiptBefore) 'certificate rotation retains independent queue and original receipt exact bytes'
@{terminal='PASS';checks=$checks;fixture=$root;signature='FAKE_RUNNER_ONLY';liveRegistryChanges=0;workerStops=0;messages=0}|ConvertTo-Json
