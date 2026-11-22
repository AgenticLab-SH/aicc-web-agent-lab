param(
  [ValidateSet('status','install','rollback')]
  [string]$Action = 'status',
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'AICC-A1-Hub-Tunnel'
$Description = 'AICC A1 OpenCodex hub SSH loopback tunnel; hidden resident watchdog; no foreground shell polling.'
$AccessRoot = Join-Path $env:USERPROFILE '.ai-control-center\oracle-a1-access'
$StateRoot = Split-Path $AccessRoot -Parent
$BackupRoot = Join-Path $StateRoot 'backups\oracle-a1-hub-tunnel'
$Receipt = Join-Path $AccessRoot 'a1-hub-tunnel-task.managed-receipt.json'
$SourceWatchdog = Join-Path $PSScriptRoot 'a1-hub-tunnel-watchdog.ps1'
$SourceLauncher = Join-Path $PSScriptRoot 'a1-hub-tunnel-hidden.vbs'
$DeployedWatchdog = Join-Path $AccessRoot 'keep-a1-hub-tunnel.ps1'
$DeployedLauncher = Join-Path $AccessRoot 'a1-hub-tunnel-hidden.vbs'
$Wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
function Assert-RegularFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "required file unavailable: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "reparse-point file refused: $Path" }
}

function Get-BytesSha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Get-TaskOrNull {
  try { Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
  catch { $null }
}

function Get-TaskXmlOrNull {
  $task = Get-TaskOrNull
  if (-not $task) { return $null }
  Export-ScheduledTask -TaskName $TaskName
}
function Test-OwnedTask($Task) {
  if (-not $Task) { return $false }
  $action = @($Task.Actions) | Select-Object -First 1
  if (-not $action) { return $false }
  $execute = [string]$action.Execute
  $arguments = [string]$action.Arguments
  $newOwned = ([IO.Path]::GetFullPath($execute) -ieq [IO.Path]::GetFullPath($Wscript)) -and
    ($arguments -eq ('/b /nologo "' + $DeployedLauncher + '"'))
  $legacyOwned = ($execute -match '(?i)powershell\.exe$') -and
    ($arguments -match [regex]::Escape($AccessRoot)) -and
    ($arguments -match 'a1-hub-tunnel|ensure-a1-hub-tunnel|keep-a1-hub-tunnel')
  $descriptionOwned = ([string]$Task.Description) -match '^AICC A1 OpenCodex hub SSH loopback tunnel'
  return $descriptionOwned -and ($newOwned -or $legacyOwned)
}

function Get-ListenerState {
  $listeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 10101,10102 })
  $data = @($listeners | Where-Object LocalPort -eq 10101) | Select-Object -First 1
  $management = @($listeners | Where-Object LocalPort -eq 10102) | Select-Object -First 1
  [pscustomobject]@{
    Healthy = [bool]($data -and $management -and $data.OwningProcess -eq $management.OwningProcess)
    Pid = if ($data -and $management -and $data.OwningProcess -eq $management.OwningProcess) { [int]$data.OwningProcess } else { $null }
  }
}
function Get-ManagedStatus {
  $task = Get-TaskOrNull
  $info = if ($task) { Get-ScheduledTaskInfo -TaskName $TaskName } else { $null }
  $action = if ($task) { @($task.Actions) | Select-Object -First 1 } else { $null }
  $triggers = @()
  if ($task) { $triggers = @($task.Triggers) }
  $launcherExpected = '/b /nologo "' + $DeployedLauncher + '"'
  $taskShape = [bool]($task -and (Test-OwnedTask $task) -and
    $task.Settings.Hidden -and
    $triggers.Count -eq 1 -and
    [string]::IsNullOrWhiteSpace([string]$triggers[0].Repetition.Interval) -and
    ([IO.Path]::GetFullPath([string]$action.Execute) -ieq [IO.Path]::GetFullPath($Wscript)) -and
    ([string]$action.Arguments -eq $launcherExpected))
  $sourceMatch = [bool](
    (Test-Path -LiteralPath $DeployedWatchdog -PathType Leaf) -and
    (Test-Path -LiteralPath $DeployedLauncher -PathType Leaf) -and
    (Get-BytesSha256 $SourceWatchdog) -eq (Get-BytesSha256 $DeployedWatchdog) -and
    (Get-BytesSha256 $SourceLauncher) -eq (Get-BytesSha256 $DeployedLauncher)
  )
  $listener = Get-ListenerState
  [pscustomobject]@{
    Ok = [bool]($taskShape -and $sourceMatch -and $listener.Healthy -and $task.State -eq 'Running')
    TaskPresent = [bool]$task
    Owned = [bool](Test-OwnedTask $task)
    TaskShape = $taskShape
    SourceMatch = $sourceMatch
    Hidden = if ($task) { [bool]$task.Settings.Hidden } else { $null }
    TriggerCount = $triggers.Count
    RepetitionInterval = if ($triggers.Count) { [string]$triggers[0].Repetition.Interval } else { $null }
    State = if ($task) { [string]$task.State } else { 'Absent' }
    LastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
    ListenerHealthy = $listener.Healthy
    ListenerPid = $listener.Pid
  }
}
function Copy-Atomic([string]$Source,[string]$Destination) {
  Assert-RegularFile $Source
  $temporary = $Destination + '.aicc-new-' + [guid]::NewGuid().ToString('N')
  Copy-Item -LiteralPath $Source -Destination $temporary
  Move-Item -LiteralPath $temporary -Destination $Destination -Force
}

function Wait-TaskStopped {
  $deadline = (Get-Date).AddSeconds(8)
  do {
    $task = Get-TaskOrNull
    if (-not $task -or $task.State -ne 'Running') { return }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw 'scheduled task did not stop within the bounded wait'
}

function Stop-ExactWatchdogProcesses {
  $watchdogNeedle = [regex]::Escape($DeployedWatchdog)
  $launcherNeedle = [regex]::Escape($DeployedLauncher)
  $matches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -ieq 'powershell.exe' -and [string]$_.CommandLine -match $watchdogNeedle) -or
    ($_.Name -ieq 'wscript.exe' -and [string]$_.CommandLine -match $launcherNeedle)
  })
  foreach ($process in $matches) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
  }
  return @($matches).Count
}

function Backup-FileOrNull([string]$Path,[string]$Prefix,[string]$Stamp) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  Assert-RegularFile $Path
  $target = Join-Path $BackupRoot ($Prefix + '.' + $Stamp)
  Copy-Item -LiteralPath $Path -Destination $target
  return $target
}

function Restore-File([string]$Destination,$Backup,[string]$InstalledHash) {
  if ($Backup) {
    Assert-RegularFile $Backup
    Copy-Atomic $Backup $Destination
  } elseif (Test-Path -LiteralPath $Destination -PathType Leaf) {
    if ((Get-BytesSha256 $Destination) -ne $InstalledHash) { throw "rollback refused because deployed file drifted: $Destination" }
    Remove-Item -LiteralPath $Destination -Force
  }
}
function Restore-Previous($Record) {
  $current = Get-TaskOrNull
  if ($current) {
    if (-not (Test-OwnedTask $current)) { throw 'rollback refused because the scheduled task is no longer AICC-owned' }
    $currentXml = Get-TaskXmlOrNull
    if ((Get-TextSha256 $currentXml) -ne [string]$Record.currentTaskXmlSha256) {
      throw 'rollback refused because the scheduled task changed after install'
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Wait-TaskStopped
  }
  $null = Stop-ExactWatchdogProcesses
  Restore-File $DeployedWatchdog $Record.previousWatchdogBackup $Record.installedWatchdogSha256
  Restore-File $DeployedLauncher $Record.previousLauncherBackup $Record.installedLauncherSha256
  if ($Record.previousTaskXmlBackup) {
    Assert-RegularFile $Record.previousTaskXmlBackup
    Register-ScheduledTask -TaskName $TaskName -Xml (Get-Content -Raw -LiteralPath $Record.previousTaskXmlBackup) -Force | Out-Null
    if ([string]$Record.previousTaskState -eq 'Running') { Start-ScheduledTask -TaskName $TaskName }
  } else {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
}

foreach ($required in @($SourceWatchdog,$SourceLauncher,$Wscript)) { Assert-RegularFile $required }
if ([IO.Path]::GetFileName($AccessRoot.TrimEnd('\')) -ne 'oracle-a1-access') { throw 'unexpected access root' }
foreach ($required in @('connection.json','id_rsa','known_hosts')) {
  Assert-RegularFile (Join-Path $AccessRoot $required)
}
if ($Action -eq 'status') {
  Get-ManagedStatus | ConvertTo-Json -Depth 4
  exit 0
}

if ($Action -eq 'rollback') {
  if (-not (Test-Path -LiteralPath $Receipt -PathType Leaf)) { throw 'managed receipt missing; rollback refused' }
  $record = Get-Content -Raw -LiteralPath $Receipt | ConvertFrom-Json
  if ($record.schemaVersion -ne 4 -or $record.taskName -ne $TaskName -or $record.status -ne 'installed') {
    throw 'managed receipt is not a valid installed A1 tunnel receipt'
  }
  if ($DryRun) {
    [pscustomobject]@{Ok=$true;DryRun=$true;Action='rollback';TaskName=$TaskName} | ConvertTo-Json
    exit 0
  }
  Restore-Previous $record
  $record.status = 'rolled_back'
  $record | Add-Member -NotePropertyName rolledBackAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
  $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Receipt -Encoding utf8
  [pscustomobject]@{Ok=$true;Action='rollback';Status=(Get-ManagedStatus)} | ConvertTo-Json -Depth 6
  exit 0
}

$existing = Get-TaskOrNull
if ($existing -and -not (Test-OwnedTask $existing)) { throw 'existing task is not AICC-owned; install refused' }
$plan = [pscustomobject]@{
  Ok = $true
  DryRun = [bool]$DryRun
  Action = 'install'
  TaskName = $TaskName
  ExistingTask = [bool]$existing
  ExistingState = if ($existing) { [string]$existing.State } else { $null }
  NewTrigger = 'logon-only'
  NewLauncher = 'wscript-hidden'
  Polling = 'none'
}
if ($DryRun) { $plan | ConvertTo-Json -Depth 4; exit 0 }
New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$previousXml = Get-TaskXmlOrNull
$previousTaskBackup = if ($previousXml) {
  $path = Join-Path $BackupRoot ('AICC-A1-Hub-Tunnel.' + $stamp + '.previous.xml')
  Set-Content -LiteralPath $path -Value $previousXml -Encoding Unicode
  $path
} else { $null }
$previousWatchdogBackup = Backup-FileOrNull $DeployedWatchdog 'keep-a1-hub-tunnel.ps1.before' $stamp
$previousLauncherBackup = Backup-FileOrNull $DeployedLauncher 'a1-hub-tunnel-hidden.vbs.before' $stamp
$previousState = if ($existing) { [string]$existing.State } else { $null }

try {
  if ($existing -and $existing.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    Wait-TaskStopped
  }
  $null = Stop-ExactWatchdogProcesses
  Copy-Atomic $SourceWatchdog $DeployedWatchdog
  Copy-Atomic $SourceLauncher $DeployedLauncher

  $taskAction = New-ScheduledTaskAction -Execute $Wscript -Argument ('/b /nologo "' + $DeployedLauncher + '"')
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -DontStopOnIdleEnd
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Description $Description -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    $status = Get-ManagedStatus
    if ($status.Ok) { break }
  } while ((Get-Date) -lt $deadline)
  if (-not $status.Ok) { throw ('post-install verification failed: ' + ($status | ConvertTo-Json -Compress)) }

  $currentXml = Get-TaskXmlOrNull
  $record = [ordered]@{
    schemaVersion = 4
    status = 'installed'
    taskName = $TaskName
    installedAt = [DateTime]::UtcNow.ToString('o')
    previousTaskXmlBackup = $previousTaskBackup
    previousTaskState = $previousState
    previousWatchdogBackup = $previousWatchdogBackup
    previousLauncherBackup = $previousLauncherBackup
    currentTaskXmlSha256 = Get-TextSha256 $currentXml
    sourceWatchdogSha256 = Get-BytesSha256 $SourceWatchdog
    installedWatchdogSha256 = Get-BytesSha256 $DeployedWatchdog
    sourceLauncherSha256 = Get-BytesSha256 $SourceLauncher
    installedLauncherSha256 = Get-BytesSha256 $DeployedLauncher
    scheduleMode = 'logon-hidden-resident-watchdog'
    foregroundShellPolling = $false
  }
  $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Receipt -Encoding utf8
  [pscustomobject]@{Ok=$true;Action='install';Receipt=$Receipt;Status=(Get-ManagedStatus)} | ConvertTo-Json -Depth 6
} catch {
  try {
    if (Get-TaskOrNull) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Wait-TaskStopped
    }
    $null = Stop-ExactWatchdogProcesses
    Restore-File $DeployedWatchdog $previousWatchdogBackup (Get-BytesSha256 $SourceWatchdog)
    Restore-File $DeployedLauncher $previousLauncherBackup (Get-BytesSha256 $SourceLauncher)
    if ($previousTaskBackup) {
      Register-ScheduledTask -TaskName $TaskName -Xml (Get-Content -Raw -LiteralPath $previousTaskBackup) -Force | Out-Null
      if ($previousState -eq 'Running') { Start-ScheduledTask -TaskName $TaskName }
    } else {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
  } catch {
    throw ('install failed and rollback also failed: ' + $_.Exception.Message)
  }
  throw
}
