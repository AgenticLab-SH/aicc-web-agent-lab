#requires -Version 7.5
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityMaintenance.psm1') -Force
$m=Get-Module CodexContinuityMaintenance
& $m { & $script:PinModule {function script:Get-CimInstance {param($ClassName,$Filter,$ErrorAction)if($script:alive){@{ProcessId=123}}} } }
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-maint-install-'+[guid]::NewGuid().ToString('N'))
$checks=0
function Check($ok,$label){if(-not $ok){throw ('FAIL:'+ $label)};$script:checks++}
function Reject($action,$pattern){try{& $action;throw 'rejection_missing'}catch{Check ($_.Exception.Message -match $pattern) $pattern}}
function Setup($name){
 $r=Join-Path $root $name;$state=Join-Path $r 'control-plane/codex-continuity';$source=Join-Path $r 'source'
 foreach($d in @($state,(Join-Path $source 'src'),(Join-Path $source 'tools/platform/windows'))){New-Item -ItemType Directory -Path $d -Force|Out-Null}
 [IO.File]::WriteAllText((Join-Path $source 'src/codex-strict-continuity-bridge.mjs'),"import {route} from './codex-cli-routes.mjs';")
 [IO.File]::WriteAllText((Join-Path $source 'src/codex-cli-routes.mjs'),"import fs from 'node:fs'; export const route=1;")
 [IO.File]::WriteAllText((Join-Path $source 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'),'# fake new helper')
 $node=Join-Path $r 'node.exe';$exe=Join-Path $r 'codex.exe';$helper=Join-Path $r 'old.ps1'
 foreach($f in @($node,$exe,$helper)){[IO.File]::WriteAllText($f,'fixture')}
 $cfg=@{schemaVersion=1;protocolVersion=3;nativeFallback=$false;codexExecutable=$exe;codexSha256=(Get-FileHash $exe).Hash.ToLowerInvariant();helperPath=$helper;helperSha256=(Get-FileHash $helper).Hash.ToLowerInvariant();workerStopRequestedAt='2026-11-07T00:00:00Z';worker=@{pid=123;state='STOPPED_FOR_MAINTENANCE'};threads=@{one=@{state='DISABLED';enabled=$false;attempt=$null;queueAttempt=$null}}}
 $registry=Join-Path $state 'registrations.json';[IO.File]::WriteAllText($registry,($cfg|ConvertTo-Json -Depth 15));foreach($f in @('worker.lock','registrations.json.lock')){[IO.File]::WriteAllText((Join-Path $state $f),'')}
 @{StateRoot=$state;SourceRoot=$source;NodePath=$node;PlanFile=(Join-Path $r 'plan.json')}
}
function Apply($a,$p){Invoke-AiccContinuityMaintenancePlan -PlanFile $a.PlanFile -ExpectedPlanSha256 $p.planSha256 -Confirm $p.confirmation}
$a=Setup 'valid';$before=Get-Content -LiteralPath (Join-Path $a.StateRoot 'registrations.json') -Raw;$p=New-AiccContinuityMaintenancePlan @a
Check ($before -ceq (Get-Content -LiteralPath (Join-Path $a.StateRoot 'registrations.json') -Raw)) 'preview no registry mutation'
$r=Apply $a $p;Check ($r.status -ceq 'INSTALLED_STOPPED' -and -not $r.workerStarted -and $r.installedFiles -eq 3) 'real installer applies complete dependency closure stopped'
$after=Get-Content -LiteralPath (Join-Path $a.StateRoot 'registrations.json') -Raw|ConvertFrom-Json -AsHashtable -DateKind String
Check ($after.workerStopRequestedAt -ceq '2026-11-07T00:00:00Z' -and $after.threads.one.enabled -ceq $false -and $after.strictRouteLauncher.files.Count -eq 3) 'stop and disabled thread preserved'
Reject {Apply $a $p} 'cas_changed|already exists' 
$a=Setup 'source-drift';$p=New-AiccContinuityMaintenancePlan @a;[IO.File]::AppendAllText((Join-Path $a.SourceRoot 'src/codex-cli-routes.mjs'),'// drift')
Reject {Apply $a $p} 'maintenance_source_changed';Check (-not(Test-Path -LiteralPath ($a.PlanFile+'.claimed'))) 'drift rejects before claim'
$a=Setup 'pending';$f=Join-Path $a.StateRoot 'registrations.json';$c=Get-Content -LiteralPath $f -Raw|ConvertFrom-Json -AsHashtable -DateKind String;$c.threads.one.attempt=@{id='unknown'};[IO.File]::WriteAllText($f,($c|ConvertTo-Json -Depth 15))
Reject {New-AiccContinuityMaintenancePlan @a} 'existing_dispatch_preserved'
$a=Setup 'alive';& $m {& $script:PinModule {$script:alive=$true}}
Reject {New-AiccContinuityMaintenancePlan @a} 'worker_maintenance_exit_unconfirmed'
& $m {& $script:PinModule {$script:alive=$false}}
@{terminal='PASS';checks=$checks;fixture=$root;liveMutations=0;requests=0}|ConvertTo-Json
