[CmdletBinding()]
param(
  [string]$Root = "$env:USERPROFILE\.ai-control-center\oracle-a1-access",
  [string]$CandidateRoot = "$env:USERPROFILE\.codex\releases\open-aicc\controlplane-40169375",
  [string]$ExpectedManifestSha256 = "03bd9608072b73ab6556e02c612801473a3773509f7c5b39c6fb3a7ae1fb77d6"
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$receipt = Join-Path $Root 'post-logon-reboot-canary.json'
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$started = Get-Date

function Write-Receipt([string]$State,[string]$Reason,[object]$Extra=$null){
  $obj=[ordered]@{
    schemaVersion=1; observedAt=(Get-Date).ToString('o'); bootAt=$boot.ToString('o')
    state=$State; reason=$Reason; elapsedSeconds=[math]::Round(((Get-Date)-$started).TotalSeconds,3)
    candidate='controlplane-40169375'; extra=$Extra
  }
  $tmp=$receipt+'.tmp'
  [IO.File]::WriteAllText($tmp,($obj|ConvertTo-Json -Depth 7),(New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $receipt -Force
  $obj|ConvertTo-Json -Depth 7 -Compress
  if($State -ne 'PASS'){exit 3}
}

$baselinePath=Join-Path $Root 'reboot-survival-baseline.json'
if(-not (Test-Path $baselinePath -PathType Leaf)){Write-Receipt 'HOLD' 'reboot_baseline_missing'}
try{$baseline=Get-Content -Raw $baselinePath|ConvertFrom-Json}catch{Write-Receipt 'HOLD' 'reboot_baseline_invalid'}
if($baseline.schemaVersion -ne 1 -or $baseline.candidate -ne 'controlplane-40169375' -or
   $baseline.candidateManifestSha256 -ne $ExpectedManifestSha256){
  Write-Receipt 'HOLD' 'reboot_baseline_mismatch'
}
try{$baselineBoot=[datetimeoffset]::Parse([string]$baseline.bootAt)}catch{Write-Receipt 'HOLD' 'reboot_baseline_boot_invalid'}
$currentBoot=[datetimeoffset]$boot
if([int64]$currentBoot.UtcTicks -le [int64]$baselineBoot.UtcTicks){
  Write-Receipt 'HOLD' 'boot_not_changed' @{
    baselineBootAt=$baseline.bootAt
    baselineUtcTicks=[int64]$baselineBoot.UtcTicks
    currentUtcTicks=[int64]$currentBoot.UtcTicks
  }
}

$manifest=Join-Path $CandidateRoot '.aicc-release.json'
if(-not (Test-Path $manifest -PathType Leaf)){Write-Receipt 'HOLD' 'candidate_manifest_missing'}
$hash=(Get-FileHash $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
if($hash -ne $ExpectedManifestSha256){Write-Receipt 'HOLD' 'candidate_manifest_mismatch' @{manifest=$hash}}

$deadline=(Get-Date).AddSeconds(90)
$ocx=$null
$ports=$null
do{
  $ports=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue |
    Where-Object {$_.LocalPort -in 10100,10101,10102})
  try{
    $raw=(& ocx.cmd status --json 2>$null|Out-String)
    $ocx=$raw|ConvertFrom-Json
  }catch{$ocx=$null}
  $ready=(@($ports|Where-Object{$_.LocalPort -eq 10100}).Count -eq 1 -and
          @($ports|Where-Object{$_.LocalPort -eq 10101}).Count -eq 1 -and
          @($ports|Where-Object{$_.LocalPort -eq 10102}).Count -eq 1 -and
          $ocx.remoteHub.connected -eq $true -and $ocx.connection.readiness -eq 'ready')
  if($ready){break}
  Start-Sleep -Seconds 3
}while((Get-Date)-lt $deadline)
if(-not $ready){Write-Receipt 'HOLD' 'route_not_ready_after_logon'}
$observer=Join-Path $CandidateRoot 'tools\platform\oracle\codex-cycle-watch\account_identity_status.ps1'
try{
  $obsRaw=(& pwsh -NoProfile -ExecutionPolicy Bypass -File $observer -Root $Root 2>$null|Out-String)
  $obs=$obsRaw|ConvertFrom-Json
}catch{Write-Receipt 'HOLD' 'identity_observer_failed'}
if($obs.activeCount -ne 1){Write-Receipt 'HOLD' 'active_identity_count_invalid' @{activeCount=$obs.activeCount}}

$route='C:\demo\owner\AppData\Local\Programs\AICC-Tools\node-v22.23.2-win-x64\node_modules\open-aicc'
try{$target=(Get-Item -Force -LiteralPath $route).Target}catch{$target=$null}
Write-Receipt 'PASS' 'post_logon_route_ready' @{
  manifestSha256=$hash
  ports=@($ports|Sort-Object LocalPort|ForEach-Object{@{port=$_.LocalPort;pid=$_.OwningProcess}})
  remoteHubConnected=$ocx.remoteHub.connected
  readiness=$ocx.connection.readiness
  identityCount=$obs.accountCount
  activeIdentityCount=$obs.activeCount
  installedRouteTarget=$target
}
