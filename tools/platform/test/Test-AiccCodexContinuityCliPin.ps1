#requires -Version 7.5
$ErrorActionPreference='Stop'
$modulePath=Join-Path $PSScriptRoot '../windows/CodexContinuityCliPin.psm1'
Import-Module $modulePath -Force
$module=Get-Module CodexContinuityCliPin
# Fake signed executables only: no real account, process, task or registry access.
& $module {function script:Get-AuthenticodeSignature {param([string]$LiteralPath) @{Status=if($script:badSignature){'NotSigned'}else{'Valid'};SignerCertificate=@{Subject='CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", C=US';Thumbprint=('A'*40)}}}}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-cli-pin-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
$checks=0
function Check($condition,$label){if(-not $condition){throw ('FAIL: '+$label)};$script:checks++}
function Reject($code,$pattern,$label){try{& $code;throw 'expected_rejection_missing'}catch{Check ($_.Exception.Message -match $pattern) $label}}
function Setup($name){
 $s=Join-Path $root $name;$state=Join-Path $s 'state';$standalone=Join-Path $s 'standalone'
 $old=Join-Path $standalone 'releases/old';$new=Join-Path $standalone 'releases/new'
 foreach($d in @($state,(Join-Path $old 'bin'),(Join-Path $new 'bin'))){New-Item -ItemType Directory -Path $d -Force|Out-Null}
 [IO.File]::WriteAllText((Join-Path $old 'bin/codex.exe'),'old-fake-exe');[IO.File]::WriteAllText((Join-Path $new 'bin/codex.exe'),'new-fake-exe')
 New-Item -ItemType Junction -Path (Join-Path $standalone 'current') -Target $new|Out-Null
 $helper=Join-Path $s 'fake-helper.ps1';[IO.File]::WriteAllText($helper,'fake-helper')
 $oldHash=(Get-FileHash (Join-Path $old 'bin/codex.exe')).Hash.ToLowerInvariant();$newHash=(Get-FileHash (Join-Path $new 'bin/codex.exe')).Hash.ToLowerInvariant()
 $cfg=@{schemaVersion=1;protocolVersion=3;codexExecutable=[IO.Path]::GetFullPath((Join-Path $standalone 'current/bin/codex.exe'));codexSha256=$oldHash;helperPath=$helper;helperSha256=(Get-FileHash $helper).Hash.ToLowerInvariant();nativeFallback=$false;worker=@{pid=123;state='WATCHING';heartbeatAt='before'};workerStopRequestedAt=$null;excludedThreadIds=@('protected');threads=@{one=@{state='QUOTA_WAIT';enabled=$false;attempt=$null;queueAttempt=$null;holdReason='keep';extension='preserve'}}}
 $file=Join-Path $state 'registrations.json';[IO.File]::WriteAllText($file,($cfg|ConvertTo-Json -Depth 20));[IO.File]::WriteAllText(($file+'.lock'),'')
 @{StateRoot=$state;StandaloneRoot=$standalone;OldRelease=$old;NewRelease=$new;ExpectedOldSha256=$oldHash;ExpectedNewSha256=$newHash;ExpectedSignerThumbprint=('A'*40);PlanFile=(Join-Path $s 'plan.json')}
}
function Read-Cfg($a){Get-Content (Join-Path $a.StateRoot 'registrations.json') -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function Save-Cfg($a,$c){[IO.File]::WriteAllText((Join-Path $a.StateRoot 'registrations.json'),($c|ConvertTo-Json -Depth 20))}
function Apply($a,$preview){Invoke-AiccContinuityCliPinPlan -PlanFile $a.PlanFile -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirmation}
$a=Setup 'valid';$before=[IO.File]::ReadAllBytes((Join-Path $a.StateRoot 'registrations.json'));$preview=New-AiccContinuityCliPinPlan @a
Check (($before -join ',') -ceq ([IO.File]::ReadAllBytes((Join-Path $a.StateRoot 'registrations.json')) -join ',')) 'preview writes no registry'
$c=Read-Cfg $a;$c.worker.heartbeatAt='later';Save-Cfg $a $c;$preApply=[IO.File]::ReadAllBytes((Join-Path $a.StateRoot 'registrations.json'))
$result=Apply $a $preview;$after=Read-Cfg $a
Check ($after.codexSha256 -ceq $a.ExpectedNewSha256 -and $result.state -eq 'APPLIED' -and -not $result.workerStopped) 'exact signed pin changes without worker stop'
Check (($preApply -join ',') -ceq ([IO.File]::ReadAllBytes(($a.PlanFile+'.before.json')) -join ',')) 'backup contains exact locked before bytes'
$after.codexSha256=$a.ExpectedOldSha256
Check (($after|ConvertTo-Json -Depth 20 -Compress) -ceq ($c|ConvertTo-Json -Depth 20 -Compress)) 'all thread and helper/route/config fields preserved'
Reject {Apply $a $preview} 'preview_scope_changed|registered_cli|already exists' 'consumed plan cannot replay'
$a=Setup 'queue';$c=Read-Cfg $a;$c.threads.one.queueAttempt=@{id='unknown';state='QUEUE_DELIVERY_UNCERTAIN'};Save-Cfg $a $c
Reject {New-AiccContinuityCliPinPlan @a} 'existing_dispatch_preserved' 'unknown queue prevents preview'
Check (-not(Test-Path $a.PlanFile)) 'unknown queue writes no plan or claim'
$a=Setup 'stale';$p=New-AiccContinuityCliPinPlan @a;$c=Read-Cfg $a;$c.threads.one.enabled=$true;Save-Cfg $a $c
Reject {Apply $a $p} 'preview_scope_changed' 'stale thread state is CAS HOLD'
Check ((Read-Cfg $a).codexSha256 -ceq $a.ExpectedOldSha256 -and -not(Test-Path ($a.PlanFile+'.claimed'))) 'stale preview leaves pin and claim untouched'
$a=Setup 'path';$p=New-AiccContinuityCliPinPlan @a
(Get-Item (Join-Path $a.StandaloneRoot 'current')).Delete();New-Item -ItemType Junction -Path (Join-Path $a.StandaloneRoot 'current') -Target $a.OldRelease|Out-Null
Reject {Apply $a $p} 'path_cas_failed' 'changed current junction is HOLD'
$a=Setup 'signature';& $module {$script:badSignature=$true}
Reject {New-AiccContinuityCliPinPlan @a} 'valid_exact_openai_signature_required' 'unsigned replacement is rejected'
& $module {$script:badSignature=$false}
$a=Setup 'bytes';$p=New-AiccContinuityCliPinPlan @a;[IO.File]::AppendAllText((Join-Path $a.NewRelease 'bin/codex.exe'),'changed')
Reject {Apply $a $p} 'hash_changed' 'changed vendor bytes reject before claim'
$a=Setup 'late-unknown';$p=New-AiccContinuityCliPinPlan @a;$c=Read-Cfg $a;$c.threads.one.attempt=@{id='unresolved'};Save-Cfg $a $c
Reject {Apply $a $p} 'existing_dispatch_preserved' 'unknown appearing after preview cannot be cleared'
$a=Setup 'unknown-state';$c=Read-Cfg $a;$c.threads.one.state='DELIVERY_UNCERTAIN';Save-Cfg $a $c
Reject {New-AiccContinuityCliPinPlan @a} 'existing_dispatch_preserved' 'unknown state without attempt remains HOLD'
$a=Setup 'confirm';$p=New-AiccContinuityCliPinPlan @a
Reject {Invoke-AiccContinuityCliPinPlan -PlanFile $a.PlanFile -ExpectedPlanSha256 $p.planSha256 -Confirm 'wrong'} 'exact_preview_confirmation_required' 'wrong one-use confirmation rejected'
# Execute the actual installer's new pre-stop preflight on a stale pin fixture.
$source=Get-Content (Join-Path $PSScriptRoot '../windows/Install-AiccCodexContinuity.ps1') -Raw
$start=$source.IndexOf('  $current=Get-Content -LiteralPath $currentFile');$end=$source.IndexOf(' }finally{$readLock.Dispose()}', $start)
$preflight=[scriptblock]::Create($source.Substring($start,$end-$start))
$currentFile=Join-Path $a.StateRoot 'registrations.json';$exe=Join-Path $a.NewRelease 'bin/codex.exe';$ThreadId='one'
Reject {& $preflight} 'identity_hold_before_stop' 'Upgrade rejects stale CLI before invoking worker stop'
$tokens=$null;$parseErrors=$null;[void][Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors)
Check ($parseErrors.Count -eq 0) 'installer full parser'
Check ($source.IndexOf('immutable_release_changed_before_stop') -lt $source.IndexOf('-Action StopWorker')) 'immutable release checked before stop'
Check ($source.IndexOf('existing_registry_identity_hold_before_stop') -lt $source.IndexOf('-Action StopWorker')) 'Upgrade preflight precedes StopWorker in source'
@{terminal='PASS';checks=$checks;fixture=$root;liveRegistrationsChanged=0;workerStops=0;messages=0;signature='FAKE_RUNNER_ONLY'}|ConvertTo-Json
