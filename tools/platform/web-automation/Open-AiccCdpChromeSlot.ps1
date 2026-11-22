#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet(9222, 9223, 9224, 9225)]
    [int]$Port
)

$ErrorActionPreference = 'Stop'
$aiccRoot = 'C:\demo\open-AICC'
$registeredLauncher = Join-Path $PSScriptRoot 'Start-AiccCdpChromeSlot.ps1'
$identityGuard = Join-Path $aiccRoot 'tools\platform\web-automation\Assert-CdpEndpointIdentity.ps1'
$profileRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) ".ai-control-center\browser-profiles\chrome\$Port\UserData"
$url = if ($Port -in @(9222, 9223)) { 'https://chatgpt.com/' } else { 'about:blank' }

foreach ($file in @($registeredLauncher, $identityGuard)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Registered browser component is missing: $file" }
}
$chrome = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome was not found.' }

$ensured = & pwsh -NoProfile -File $registeredLauncher -Port $Port -AiccRoot $aiccRoot -Action Ensure -Url $url 2>&1
if ($LASTEXITCODE -ne 0) { throw "Registered slot $Port could not be opened: $($ensured -join ' ')" }
$state = & pwsh -NoProfile -File $identityGuard -ExpectedBrowser chrome -Endpoint "http://127.0.0.1:$Port" -ExpectedProfileDir $profileRoot -AsJson | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $state.ok) { throw "Registered slot $Port failed profile identity verification." }

# Ensure opens the requested URL once. A second Chrome invocation formerly created another window.
$final = & pwsh -NoProfile -File $identityGuard -ExpectedBrowser chrome -Endpoint "http://127.0.0.1:$Port" -ExpectedProfileDir $profileRoot -AsJson | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $final.ok) { throw "Registered slot $Port changed identity after opening." }
