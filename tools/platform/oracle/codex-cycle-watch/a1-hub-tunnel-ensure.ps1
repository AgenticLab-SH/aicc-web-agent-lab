param(
  [Parameter(Mandatory=$true)]
  [string]$Root
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = [IO.Path]::GetFullPath($Root)
if ([IO.Path]::GetFileName($Root.TrimEnd('\')) -ne 'oracle-a1-access') {
  throw 'unexpected A1 access root'
}
$connection = Join-Path $Root 'connection.json'
$key = Join-Path $Root 'id_rsa'
$knownHosts = Join-Path $Root 'known_hosts'
$log = Join-Path $Root 'a1-hub-tunnel.log'
$localInference=Test-Path -LiteralPath (Join-Path (Split-Path $Root -Parent) 'runtime/ocx-local/current.json')
$ssh = Join-Path $env:LOCALAPPDATA 'Programs\AICC-Tools\Git\usr\bin\ssh.exe'
foreach ($file in @($connection, $key, $knownHosts, $ssh)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw ('required file unavailable: ' + [IO.Path]::GetFileName($file))
  }
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\AICC_A1_Hub_Tunnel_Ensure')
try {
  try {
    $owned = $mutex.WaitOne(0, $false)
  } catch [System.Threading.AbandonedMutexException] {
    $owned = $true
  }
  if (-not $owned) { exit 0 }

  function Write-Log([string]$Message) {
    try {
      if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1048576) {
        Move-Item -LiteralPath $log -Destination ($log + '.old') -Force
      }
      Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + ' ' + $Message) -Encoding utf8
    } catch {}
  }
  function Get-ExactTunnelState {
    $listeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -in $(if($localInference){@(10102)}else{@(10101,10102)}) })
    $data = @($listeners | Where-Object { $_.LocalPort -eq 10101 }) | Select-Object -First 1
    $management = @($listeners | Where-Object { $_.LocalPort -eq 10102 }) | Select-Object -First 1
    if (-not $data -and -not $management) {
      return [pscustomobject]@{ State='absent'; Pid=$null }
    }
    if (-not $management -or (-not $localInference -and (-not $data -or $data.OwningProcess -ne $management.OwningProcess))) {
      return [pscustomobject]@{ State='conflict'; Pid=$null }
    }
    $pidValue = [int]$management.OwningProcess
    $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pidValue) -ErrorAction SilentlyContinue
    $command = [string]$process.CommandLine
    if ($process -and $process.Name -eq 'ssh.exe' -and
        $command -match 'HostKeyAlias=aicc-oracle-a1' -and
        (($localInference -and $command -notmatch '127\.0\.0\.1:10101:127\.0\.0\.1:10100') -or (-not $localInference -and $command -match '127\.0\.0\.1:10101:127\.0\.0\.1:10100')) -and
        $command -match '127\.0\.0\.1:10102:127\.0\.0\.1:10102') {
      return [pscustomobject]@{ State='healthy'; Pid=$pidValue }
    }
    return [pscustomobject]@{ State='conflict'; Pid=$pidValue }
  }

  $state = Get-ExactTunnelState
  if ($state.State -eq 'healthy') { exit 0 }
  if ($state.State -eq 'conflict') {
    Write-Log 'ensure-port-conflict'
    exit 2
  }

  $target = Get-Content -Raw -LiteralPath $connection | ConvertFrom-Json
  if (-not $target.user -or -not $target.host) { throw 'invalid connection metadata' }
  $args = @(
    '-F','none','-N',
    '-o','BatchMode=yes',
    '-o','IdentitiesOnly=yes',
    '-o','StrictHostKeyChecking=yes',
    '-o',('UserKnownHostsFile=' + $knownHosts),
    '-o','HostKeyAlias=aicc-oracle-a1',
    '-o','ExitOnForwardFailure=yes',
    '-o','ServerAliveInterval=30',
    '-o','ServerAliveCountMax=3',
    '-o','ConnectTimeout=15',
    '-i',$key,
    '-L','127.0.0.1:10102:127.0.0.1:10102',
    ($target.user + '@' + $target.host)
  )
  if(-not $localInference){$args=@('-L','127.0.0.1:10101:127.0.0.1:10100')+$args}
  Write-Log 'ensure-starting'
  $child = Start-Process -FilePath $ssh -ArgumentList $args -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    $child.Refresh()
    if ($child.HasExited) {
      Write-Log ('ensure-exited code=' + $child.ExitCode)
      exit 3
    }
    $nowState = Get-ExactTunnelState
    if ($nowState.State -eq 'healthy' -and $nowState.Pid -eq $child.Id) {
      Write-Log ('ensure-ready pid=' + $child.Id)
      exit 0
    }
    if ($nowState.State -eq 'conflict') {
      try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch {}
      Write-Log 'ensure-race-conflict'
      exit 4
    }
  } while ((Get-Date) -lt $deadline)

  try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch {}
  Write-Log 'ensure-timeout'
  exit 5
} finally {
  try {
    if ($owned) { $mutex.ReleaseMutex() }
  } catch {}
  $mutex.Dispose()
}
