[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$CandidateRoot,
  [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:Receipt=$null

function Write-ReceiptObject([object]$Object){
  if(-not $script:Receipt){return}
  $tmp=$script:Receipt+'.tmp'
  [IO.File]::WriteAllText($tmp,($Object|ConvertTo-Json -Depth 7),(New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $script:Receipt -Force
}

function Emit-Hold([string]$Reason,[object]$Detail=$null){
  $obj=[pscustomobject]@{ok=$false;state='HOLD_PRE_DISPATCH';reason=$Reason;detail=$Detail;observedAt=(Get-Date).ToString('o')}
  Write-ReceiptObject $obj
  $obj|ConvertTo-Json -Depth 6 -Compress
  exit 3
}

$Root=[IO.Path]::GetFullPath($Root)
$CandidateRoot=[IO.Path]::GetFullPath($CandidateRoot)
if((Split-Path $Root -Leaf) -ne 'oracle-a1-access'){ Emit-Hold 'unexpected_access_root' }
$script:Receipt=Join-Path $Root 'a1-hub-tunnel-survival-receipt.json'
if(-not (Test-Path -LiteralPath $CandidateRoot -PathType Container)){ Emit-Hold 'candidate_missing' }
$manifest=Join-Path $CandidateRoot '.aicc-release.json'
if(-not (Test-Path -LiteralPath $manifest -PathType Leaf)){ Emit-Hold 'candidate_manifest_missing' }
$manifestHash=(Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
if($manifestHash -ne $ExpectedManifestSha256.ToLowerInvariant()){ Emit-Hold 'candidate_manifest_mismatch' }
$candidateCli=Join-Path $CandidateRoot 'src\cli.mjs'
if(-not (Test-Path -LiteralPath $candidateCli -PathType Leaf)){ Emit-Hold 'candidate_cli_missing' }
$node=(Get-Command node.exe -ErrorAction SilentlyContinue).Source
if(-not $node){ Emit-Hold 'node_runtime_missing' }
$raw=(& $node $candidateCli codex-desktop status --json 2>$null | Out-String)
try{$desktop=$raw|ConvertFrom-Json}catch{ Emit-Hold 'candidate_codex_desktop_status_invalid' }
$active=@($desktop.active).Count
$unknown=@($desktop.unknown).Count
if($desktop.safe -ne $true -or $active -ne 0 -or $unknown -ne 0){
  Emit-Hold 'codex_not_exact_idle' ([pscustomobject]@{safe=$desktop.safe;active=$active;unknown=$unknown})
}

function Get-ExactTunnel {
  $listeners=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue |
    Where-Object {$_.LocalPort -in 10101,10102})
  $data=@($listeners|Where-Object {$_.LocalPort -eq 10101})|Select-Object -First 1
  $mgmt=@($listeners|Where-Object {$_.LocalPort -eq 10102})|Select-Object -First 1
  if(-not $data -or -not $mgmt -or $data.OwningProcess -ne $mgmt.OwningProcess){ return $null }
  $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$data.OwningProcess) -ErrorAction SilentlyContinue
  $cmd=[string]$proc.CommandLine
  if($proc -and $proc.Name -eq 'ssh.exe' -and
     $cmd -match 'HostKeyAlias=aicc-oracle-a1' -and
     $cmd -match '127\.0\.0\.1:10101:127\.0\.0\.1:10100' -and
     $cmd -match '127\.0\.0\.1:10102:127\.0\.0\.1:10102'){
    return [pscustomobject]@{pid=[int]$data.OwningProcess}
  }
  return $null
}
$task=Get-ScheduledTask -TaskName 'AICC-A1-Hub-Tunnel' -ErrorAction SilentlyContinue
if(-not $task -or [int]$task.State -ne 4){ Emit-Hold 'tunnel_watchdog_not_running' }
$before=Get-ExactTunnel
if(-not $before){ Emit-Hold 'tunnel_not_healthy_before_test' }

$started=Get-Date
Stop-Process -Id $before.pid -Force
$deadline=(Get-Date).AddSeconds(45)
$after=$null
do{
  Start-Sleep -Milliseconds 500
  $after=Get-ExactTunnel
  if($after -and $after.pid -ne $before.pid){ break }
}while((Get-Date) -lt $deadline)
if(-not $after -or $after.pid -eq $before.pid){
  Emit-Hold 'tunnel_did_not_recover' ([pscustomobject]@{oldPid=$before.pid})
}

$ocxRaw=(& ocx.cmd status --json 2>$null | Out-String)
try{$ocx=$ocxRaw|ConvertFrom-Json}catch{ Emit-Hold 'ocx_status_invalid_after_reconnect' }
if($ocx.remoteHub.connected -ne $true -or $ocx.connection.readiness -ne 'ready'){
  Emit-Hold 'ocx_not_ready_after_reconnect'
}
$observer=Join-Path $CandidateRoot 'tools\platform\oracle\codex-cycle-watch\account_identity_status.ps1'
if(-not (Test-Path -LiteralPath $observer -PathType Leaf)){ Emit-Hold 'candidate_observer_missing' }
$obsRaw=(& pwsh -NoProfile -ExecutionPolicy Bypass -File $observer -Root $Root 2>$null | Out-String)
try{$obs=$obsRaw|ConvertFrom-Json}catch{ Emit-Hold 'identity_observer_invalid_after_reconnect' }
if($obs.activeCount -ne 1){ Emit-Hold 'active_identity_count_invalid_after_reconnect' }

$elapsed=((Get-Date)-$started).TotalSeconds
$result=[pscustomobject]@{
  ok=$true
  state='PASS'
  observedAt=(Get-Date).ToString('o')
  oldPid=$before.pid
  newPid=$after.pid
  reconnectSeconds=[math]::Round($elapsed,3)
  remoteHubConnected=$ocx.remoteHub.connected
  readiness=$ocx.connection.readiness
  identityCount=$obs.accountCount
  activeIdentityCount=$obs.activeCount
  candidateManifestSha256=$manifestHash
}
Write-ReceiptObject $result
$result|ConvertTo-Json -Depth 5 -Compress
