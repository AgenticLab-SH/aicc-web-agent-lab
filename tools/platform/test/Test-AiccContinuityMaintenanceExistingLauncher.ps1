#requires -Version 7.5
# Fake-only, exact isolated owner registry/Task/immutable release. No active service.
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityMaintenance.psm1') -Force
$m=Get-Module CodexContinuityMaintenance
& $m {
 $script:fakeTasks=@{}
 function script:GroupInstall-TaskSnapshot([string]$StateRoot){return $script:fakeTasks[$StateRoot]}
 & $script:PinModule {
  $script:fakeWorkerAlive=$false
  function script:Get-CimInstance {param($ClassName,$Filter,$ErrorAction)
   if($script:fakeWorkerAlive){@{ProcessId=123}}
  }
 }
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-g1-maintenance-owner-'+[guid]::NewGuid().ToString('N'))
$checks=0
function Check($x,[string]$label){if(-not $x){throw ('FAIL:'+ $label)};$script:checks++}
function Reject($fn,[string]$pattern){
 try{& $fn|Out-Null;throw 'expected_rejection_missing'}
 catch{Check ($_.Exception.Message -match $pattern) ($pattern+':'+$_.Exception.Message)}
}
function Hash([string]$file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function Setup([string]$name){
 $fixtureHome=Join-Path $root $name
 $state=Join-Path $fixtureHome 'control-plane/codex-continuity'
 $release=Join-Path $fixtureHome 'releases/codex-continuity/group-owner-11111111-1111-4111-8111-111111111111'
 $source=Join-Path $fixtureHome 'source'
 foreach($dir in @($state,(Join-Path $release 'tools/platform/windows'),(Join-Path $release 'src'),
   (Join-Path $source 'src'),(Join-Path $source 'tools/platform/windows'))){
  $null=New-Item -ItemType Directory -Path $dir -Force
 }
 $helper=Join-Path $release 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'
 $bridge=Join-Path $release 'src/codex-strict-continuity-bridge.mjs'
 $route=Join-Path $release 'src/codex-cli-routes.mjs'
 [IO.File]::WriteAllText($helper,'# old reviewed stopped helper fake')
 [IO.File]::WriteAllText($bridge,'import { route } from "./codex-cli-routes.mjs"')
 [IO.File]::WriteAllText($route,'export const route="old"')
 $files=@{'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'=(Hash $helper);
   'src/codex-strict-continuity-bridge.mjs'=(Hash $bridge);
   'src/codex-cli-routes.mjs'=(Hash $route)}
 $node=Join-Path $fixtureHome 'node.exe';$exe=Join-Path $fixtureHome 'codex.exe'
 [IO.File]::WriteAllText($node,'fixture-node')
 [IO.File]::WriteAllText($exe,'fixture-codex')
 $cfg=@{schemaVersion=1;protocolVersion=3;nativeFallback=$false;
  helperPath=$helper;helperSha256=(Hash $helper);codexExecutable=$exe;codexSha256=(Hash $exe);
  workerStopRequestedAt='2026-11-10T01:00:00Z';
  worker=@{pid=123;state='STOPPED_FOR_MAINTENANCE';heartbeatAt='before'};
  threads=@{one=@{threadId='one';enabled=$false;state='DISABLED';attempt=$null;
    queueAttempt=$null;originalMarker='PRESERVE'}};
  strictRouteLauncher=@{schemaVersion=1;route='command-route-r2';releaseRoot=$release;
   files=$files;nodePath=$node;nodeSha256=(Hash $node);
   bridgePath=$bridge;bridgeSha256=(Hash $bridge);
   routeModulePath=$route;routeModuleSha256=(Hash $route);codexSha256=(Hash $exe)}}
 $registry=Join-Path $state 'registrations.json'
 [IO.File]::WriteAllText($registry,($cfg|ConvertTo-Json -Depth 20))
 foreach($file in @('worker.lock','registrations.json.lock')){
  [IO.File]::WriteAllText((Join-Path $state $file),'')
 }
 [IO.File]::WriteAllText((Join-Path $source 'src/codex-strict-continuity-bridge.mjs'),
  'import {route} from "./codex-cli-routes.mjs";')
 [IO.File]::WriteAllText((Join-Path $source 'src/codex-cli-routes.mjs'),
  'import fs from "node:fs"; export const route="new";')
 [IO.File]::WriteAllText((Join-Path $source 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'),
  '# new stopped helper fake')
 & $m {param($s)
  $script:fakeTasks[$s]=@{oldTaskState='Disabled';xmlSha256=('a'*64);
   oldVbsSha256=('b'*64);taskName='AgenticLab-AICC-Codex-Continuity'}
 } $state
 @{StateRoot=$state;SourceRoot=$source;NodePath=$node;PlanFile=(Join-Path $fixtureHome 'plan.json');
  Registry=$registry;OldHelper=$helper;OldRelease=$release}
}
function Preview($a){New-AiccContinuityMaintenancePlan -StateRoot $a.StateRoot -SourceRoot $a.SourceRoot -NodePath $a.NodePath -PlanFile $a.PlanFile}
function Apply($a,$preview){Invoke-AiccContinuityMaintenancePlan -PlanFile $a.PlanFile -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirmation}
function Rollback($a,$preview){
 $receipt=Hash ($a.PlanFile+'.receipt.json')
 Undo-AiccContinuityMaintenancePlan -PlanFile $a.PlanFile -ExpectedPlanSha256 $preview.planSha256 -ExpectedReceiptSha256 $receipt -Confirm ('ROLLBACK STOPPED CONTINUITY '+$receipt)
}
$a=Setup 'success'
$old=[IO.File]::ReadAllBytes($a.Registry);$oldHash=Hash $a.Registry
$p=Preview $a
Check ($p.state -ceq 'PREPARED' -and $p.oldLauncherVerified -eq $true -and $p.upgradeKind -ceq 'EXISTING_STRICT_LAUNCHER') 'existing launcher preview supported'
Check ((Hash $a.Registry) -ceq $oldHash -and -not(Test-Path -LiteralPath ($a.PlanFile+'.claimed'))) 'preview no registry or claim mutation'
Check ((Get-AiccContinuityMaintenanceStatus -PlanFile $a.PlanFile).state -ceq 'PREPARED_NOT_APPLIED') 'preflight status read only'
$r=Apply $a $p
Check ($r.status -ceq 'INSTALLED_STOPPED' -and $r.workerStarted -eq $false -and $r.taskChanged -eq $false -and $r.installedFiles -eq 3) 'existing launcher installed stopped'
$after=Get-Content -LiteralPath $a.Registry -Raw|ConvertFrom-Json -AsHashtable -DateKind String
$before=[Text.UTF8Encoding]::new($false,$true).GetString($old)|ConvertFrom-Json -AsHashtable -DateKind String
Check ($after.threads.one.originalMarker -ceq 'PRESERVE' -and
 $after.workerStopRequestedAt -ceq $before.workerStopRequestedAt -and
 $after.worker.heartbeatAt -ceq $before.worker.heartbeatAt -and
 $after.codexSha256 -ceq $before.codexSha256) 'historical state and stop byte semantics preserved'
Check ($after.strictRouteLauncher.releaseRoot -cne $before.strictRouteLauncher.releaseRoot -and
 $after.strictRouteLauncher.files.Count -eq 3 -and
 (Hash $a.OldHelper) -ceq $before.helperSha256) 'only new immutable launcher pin'
Check ((Get-AiccContinuityMaintenanceStatus -PlanFile $a.PlanFile).state -ceq 'INSTALLED_STOPPED_NOT_STARTED') 'installed state is not worker execution'
Reject {Apply $a $p} 'maintenance_registry_cas_changed|already exists'
$rb=Rollback $a $p
Check ($rb.status -ceq 'ROLLED_BACK_STOPPED' -and $rb.oldReleasePreserved -and $rb.newReleasePreserved -and $rb.modelRequests -eq 0) 'exact rollback against stopped source'
Check ((Hash $a.Registry) -ceq $oldHash -and
 [Convert]::ToHexString([IO.File]::ReadAllBytes($a.Registry)) -ceq [Convert]::ToHexString($old)) 'rollback restores original full registry bytes'
Check ((Get-AiccContinuityMaintenanceStatus -PlanFile $a.PlanFile).state -ceq 'ROLLED_BACK_STOPPED') 'rollback receipt state readback'
Reject {Rollback $a $p} 'maintenance_rollback_current_registry_cas_changed'
$a=Setup 'old-drift'
[IO.File]::AppendAllText($a.OldHelper,'modified')
Reject {Preview $a} 'installed_helper_identity_hold|maintenance_previous_closure_sha_changed'
$a=Setup 'task-drift'
$p=Preview $a
& $m {param($s)$script:fakeTasks[$s].xmlSha256='c'*64} $a.StateRoot
Reject {Apply $a $p} 'maintenance_task_xml_cas_changed'
Check (-not(Test-Path -LiteralPath ($a.PlanFile+'.claimed'))) 'task drift rejected before claim'
$a=Setup 'queue-drift'
$p=Preview $a
$c=Get-Content $a.Registry -Raw|ConvertFrom-Json -AsHashtable -DateKind String
$c.threads.one.queueAttempt=@{state='QUEUE_ACCEPTED'}
[IO.File]::WriteAllText($a.Registry,($c|ConvertTo-Json -Depth 20))
Reject {Apply $a $p} 'maintenance_registry_cas_changed|existing_dispatch_preserved'
Check (-not(Test-Path -LiteralPath ($a.PlanFile+'.claimed'))) 'queue drift rejected before claim'
$a=Setup 'worker-alive'
& $m {& $script:PinModule {$script:fakeWorkerAlive=$true}}
Reject {Preview $a} 'worker_maintenance_exit_unconfirmed'
& $m {& $script:PinModule {$script:fakeWorkerAlive=$false}}
$a=Setup 'claimed-no-replay'
$p=Preview $a
[IO.File]::WriteAllText(($a.PlanFile+'.claimed'),'original attempt unknown')
Check ((Get-AiccContinuityMaintenanceStatus -PlanFile $a.PlanFile).state -ceq 'APPLY_CLAIMED_RESULT_UNKNOWN_NO_REPLAY') 'post-claim interruption is UNKNOWN'
Reject {Apply $a $p} 'already exists'
$a=Setup 'new-release-drift'
$p=Preview $a
$r=Apply $a $p
[IO.File]::AppendAllText((Join-Path $r.releaseRoot 'src/codex-cli-routes.mjs'),'tamper')
Reject {Rollback $a $p} 'maintenance_previous_closure_sha_changed|maintenance_rollback_new_closure_changed'
Check (-not(Test-Path -LiteralPath ($a.PlanFile+'.rollback-claimed'))) 'new release drift rejected before rollback claim'
@{status='PASS';checks=$checks;fixtures='isolated-Temp-only';realTaskMutations=0;liveRegistryWrites=0;realModelRequests=0;workerStarts=0}|ConvertTo-Json -Compress
