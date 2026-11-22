#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet(9222, 9223, 9224, 9225)]
    [int]$Port,
    [string]$AiccRoot = 'C:\demo\open-AICC',
    [string]$Url = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $IsWindows) { throw 'Windows 전용 launcher입니다.' }
$explicitUrl = -not [string]::IsNullOrWhiteSpace($Url)
if (-not $explicitUrl) { $Url = 'about:blank#aicc-webgpt-standby=' + [guid]::NewGuid().ToString() }
$chromeCandidates = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $chrome) { throw '공식 Google Chrome을 찾지 못했습니다.' }

$profileRoot = Join-Path $HOME ".ai-control-center\browser-profiles\chrome\$Port\UserData"
$endpoint = "http://127.0.0.1:$Port"
$identityGuard = Join-Path $AiccRoot 'tools\platform\web-automation\Assert-CdpEndpointIdentity.ps1'
if (-not (Test-Path -LiteralPath $identityGuard -PathType Leaf)) { throw "AICC identity guard가 없습니다: $identityGuard" }

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    & pwsh -NoProfile -File $identityGuard -ExpectedBrowser chrome -Endpoint $endpoint -ExpectedProfileDir $profileRoot -AsJson
    if ($LASTEXITCODE -ne 0) { throw "CDP $Port identity mismatch; 기존 listener를 건드리지 않습니다." }
    # Opening the launcher again attaches to the slot without adding another default tab.
    if (-not $explicitUrl) { exit 0 }
    $targets = @(Invoke-RestMethod -Uri "$endpoint/json/list" -TimeoutSec 5)
    if (@($targets | Where-Object { $_.type -eq 'page' -and $_.url -ceq $Url }).Count -gt 0) { exit 0 }
    $encodedUrl = [Uri]::EscapeDataString($Url)
    Invoke-RestMethod -Method Put -Uri "$endpoint/json/new?$encodedUrl" -TimeoutSec 5 | Out-Null
    exit 0
}

New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null
$arguments = @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$Port",
    "--user-data-dir=`"$profileRoot`"",
    '--profile-directory=Default',
    '--no-first-run',
    '--new-window',
    $Url
)
Start-Process -FilePath $chrome -ArgumentList $arguments -WindowStyle Hidden | Out-Null

$deadline = [DateTimeOffset]::UtcNow.AddSeconds(25)
do {
    Start-Sleep -Milliseconds 500
    & pwsh -NoProfile -File $identityGuard -ExpectedBrowser chrome -Endpoint $endpoint -ExpectedProfileDir $profileRoot -AsJson
    if ($LASTEXITCODE -eq 0) { exit 0 }
} while ([DateTimeOffset]::UtcNow -lt $deadline)

throw "CDP $Port가 전용 profile identity 검증을 통과하지 못했습니다. 다른 surface로 fallback하지 않습니다."
