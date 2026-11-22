#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$RuntimeRoot = '',
    [string]$BasePython = '',
    [string]$PlaywrightVersion = '1.62.0',
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$BasePython = if ($BasePython) { $BasePython } elseif ($IsWindows) { 'py' } else { 'python3' }
$AiccStateRoot = if ($env:AICC_STATE_ROOT) { $env:AICC_STATE_ROOT } else { Join-Path $HOME '.ai-control-center' }
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $AiccStateRoot 'runtime/telegram-admin-python' }
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
if (-not $RuntimeRoot.StartsWith([IO.Path]::GetFullPath($AiccStateRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) {
    throw 'telegram_admin_runtime_must_remain_under_aicc_state'
}

$Python = if ($IsWindows) { Join-Path $RuntimeRoot 'Scripts/python.exe' } else { Join-Path $RuntimeRoot 'bin/python' }
$Created = $false
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    & $BasePython -m venv $RuntimeRoot
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Python -PathType Leaf)) {
        throw 'telegram_admin_virtualenv_creation_failed'
    }
    $Created = $true
}

$InstalledVersion = @(& $Python -c 'import importlib.metadata; print(importlib.metadata.version("playwright"))' 2>$null) -join ''
if ($InstalledVersion -ne $PlaywrightVersion) {
    & $Python -m pip install --disable-pip-version-check --no-input "playwright==$PlaywrightVersion"
    if ($LASTEXITCODE -ne 0) { throw 'telegram_admin_playwright_install_failed' }
}
$VerifiedVersion = @(& $Python -c 'import importlib.metadata; from playwright.sync_api import sync_playwright; print(importlib.metadata.version("playwright"))') -join ''
if ($LASTEXITCODE -ne 0 -or $VerifiedVersion -ne $PlaywrightVersion) { throw 'telegram_admin_playwright_verification_failed' }

$Result = [ordered]@{
    ok = $true
    runtime_root = $RuntimeRoot
    python = $Python
    playwright_version = $VerifiedVersion
    created = $Created
    browser_downloaded = $false
}
if ($AsJson) { $Result | ConvertTo-Json -Compress } else { $Result | ConvertTo-Json -Depth 4 }
