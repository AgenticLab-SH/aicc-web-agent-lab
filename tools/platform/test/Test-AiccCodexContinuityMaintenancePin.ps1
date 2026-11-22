#requires -Version 7.5
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityCliPin.psm1') -Force
$module=Get-Module CodexContinuityCliPin
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-maintenance-pin-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
$lock=Join-Path $root 'worker.lock';[IO.File]::WriteAllText($lock,'')
# Process lookup is isolated. Real worker locks and exception propagation are used.
& $module {function script:Get-CimInstance {param($ClassName,$Filter,$ErrorAction)if($script:lookupFails){throw 'lookup_failed'};if($script:alive){@{ProcessId=123}}}}
$cfg=@{workerStopRequestedAt='2026-11-07T00:00:00Z';worker=@{state='STOPPED_FOR_MAINTENANCE';pid=123}}
$checks=0
function Check($ok,$name){if(-not $ok){throw ('FAIL:'+ $name)};$script:checks++}
function Reject($action,$pattern){try{& $action;throw 'rejection_missing'}catch{Check ($_.Exception.Message -match $pattern) $pattern}}
$h=& $module {param($c,$r)Enter-PinMaintenanceFence $c $r} $cfg $root
Check ($null -ne $h) 'fence acquired only after exit'
Reject {[IO.File]::Open($lock,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)} 'used by another process|another process|process cannot access'
$h.Dispose()
& $module {$script:alive=$true}
Reject {& $module {param($c,$r)Enter-PinMaintenanceFence $c $r} $cfg $root} 'worker_maintenance_exit_unconfirmed'
& $module {$script:alive=$false;$script:lookupFails=$true}
Reject {& $module {param($c,$r)Enter-PinMaintenanceFence $c $r} $cfg $root} 'lookup_failed'
& $module {$script:lookupFails=$false}
$cfg.worker.state='WATCHING'
Reject {& $module {param($c,$r)Enter-PinMaintenanceFence $c $r} $cfg $root} 'worker_maintenance_exit_unconfirmed'
$cfg.worker.state='STOPPED_FOR_MAINTENANCE';$cfg.workerStopRequestedAt=$null
Check ($null -eq (& $module {param($c,$r)Enter-PinMaintenanceFence $c $r} $cfg $root)) 'ordinary pin unchanged'
@{terminal='PASS';checks=$checks;liveMutations=0;fixture=$root}|ConvertTo-Json
