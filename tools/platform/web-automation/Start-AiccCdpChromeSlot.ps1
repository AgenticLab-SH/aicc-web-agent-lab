#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet(9222, 9223, 9224, 9225)]
    [int]$Port,
    [string]$AiccRoot = '',
    [ValidateSet('Status', 'Ensure')]
    [string]$Action = 'Ensure',
    [string]$Url = '',
    [switch]$NoStart,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if (-not $IsWindows) { throw 'Windows is required.' }
if (-not $AiccRoot) { $AiccRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..')) }
$stateRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$baseLauncher = Join-Path $stateRoot 'browser-launchers/Start-CdpChromeSlot.ps1'
$extensionManager = Join-Path $stateRoot 'browser-extensions/Manage-AiccChromeExtensions.ps1'
$identityGuard = Join-Path $AiccRoot 'tools/platform/web-automation/Assert-CdpEndpointIdentity.ps1'
$coordination = Join-Path $stateRoot 'guidance/coordination.toml'
foreach ($required in @($baseLauncher, $extensionManager, $identityGuard, $coordination)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'Required registered launcher component is missing.' }
}
$browser = @{}
$section = ''
foreach ($raw in Get-Content -LiteralPath $coordination) {
    $line = $raw.Trim()
    if ($line -match '^\[([^\]]+)\]$') { $section = $Matches[1]; continue }
    if ($section -ne 'browser') { continue }
    if ($line -match '^(cdp_slot\d+_(?:port|profile_dir|usage))\s*=\s*(?:"([^"\r\n]*)"|(\d+))\s*(?:#.*)?$') {
        $key = $Matches[1]
        if ($browser.ContainsKey($key)) { throw 'Duplicate slot registration.' }
        $browser[$key] = if ($Matches.ContainsKey(2)) { $Matches[2] } else { $Matches[3] }
    }
}
$slotKeys = @($browser.Keys | Where-Object { $_ -match '^cdp_slot\d+_port$' -and [int]$browser[$_] -eq $Port })
if ($slotKeys.Count -ne 1) { throw 'One exact registered slot is required.' }
$prefix = $slotKeys[0] -replace '_port$', ''
$profile = [string]$browser["${prefix}_profile_dir"]
if (-not $profile -or -not $browser["${prefix}_usage"] -or $browser["${prefix}_usage"] -match 'disabled') { throw 'Slot registration is not eligible.' }
$baseProfile = Join-Path $stateRoot "browser-profiles/chrome/$Port/UserData"
if (-not [string]::Equals([IO.Path]::GetFullPath($profile).TrimEnd('\', '/'), [IO.Path]::GetFullPath($baseProfile).TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Registered profile does not match the base launcher; refusing fallback.'
}
$endpoint = "http://127.0.0.1:$Port"
function Get-GuardState {
    $guardJson = & pwsh -NoProfile -File $identityGuard -ExpectedBrowser chrome -Endpoint $endpoint -ExpectedProfileDir $profile -AsJson 2>$null
    try {
        $report = ($guardJson -join "`n") | ConvertFrom-Json
        if ($report.ok -and $LASTEXITCODE -ne 0) { throw 'Identity guard exit mismatch.' }
        return $report
    } catch { throw 'Identity guard failed.' }
}
function Get-ExtensionState([string]$RequestedAction, [switch]$Preview) {
    $arguments = @('-NoProfile', '-File', $extensionManager, '-Action', $RequestedAction, '-Target', [string]$Port, '-Extension', 'all', '-AiccRoot', $AiccRoot, '-NoStart')
    if ($Preview) { $arguments += '-DryRun' }
    $managerJson = & pwsh @arguments 2>$null
    try {
        $report = ($managerJson -join "`n") | ConvertFrom-Json
        if ($report.ok -and $LASTEXITCODE -ne 0) { throw 'Extension manager exit mismatch.' }
    } catch { throw 'Extension manager failed.' }
    if (-not $report.ok -and $report.error -ceq 'pinned_extension_source_verification_failed') {
        $failure = [InvalidOperationException]::new('Extension source verification failed.')
        $failure.Data['reasonCode'] = 'pinned_extension_source_verification_failed'
        if ($report.extension_key -cmatch '^[a-z0-9][a-z0-9-]{1,62}$') { $failure.Data['extensionKey'] = $report.extension_key }
        throw $failure
    }
    return $report
}
$phase = 'identity_before'
try {
    $before = Get-GuardState
    $offline = @($before.reasons).Count -eq 1 -and $before.reasons[0] -eq 'cdp_endpoint_unavailable'
    if (-not $before.ok -and -not $offline) { throw 'Identity mismatch; no launch or extension mutation allowed.' }
    if ($Action -eq 'Status') {
        $extensions = if ($before.ok) { Get-ExtensionState 'Status' } else { $null }
        [pscustomobject]@{ port = $Port; action = $Action; online = [bool]$before.ok; ok = [bool]($before.ok -and $extensions.ok) } | ConvertTo-Json -Compress
        if (-not ($before.ok -and $extensions.ok)) { exit 1 }
        exit 0
    }
    $phase = 'extension_preview'
    $preview = Get-ExtensionState 'Ensure' -Preview
    if (-not $preview.ok) { throw 'Extension preview failed.' }
    if ($DryRun) {
        [pscustomobject]@{ port = $Port; action = $Action; dry_run = $true; ok = $true; would_start = [bool]($offline -and -not $NoStart); blocked_by_no_start = [bool]($offline -and $NoStart) } | ConvertTo-Json -Compress
        exit 0
    }
    $started = $false
    $phase = 'browser_start'
    if ($offline -or $Url) {
        if ($offline -and $NoStart) { throw 'Slot is offline; NoStart prevents launch.' }
        $baseArguments = @('-NoProfile', '-File', $baseLauncher, '-Port', [string]$Port, '-AiccRoot', $AiccRoot)
        if ($Url) { $baseArguments += @('-Url', $Url) }
        & pwsh @baseArguments *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Registered base launcher failed.' }
        $started = [bool]$offline
    }
    $phase = 'identity_after'
    $after = Get-GuardState
    if (-not $after.ok) { throw 'Post-launch identity guard failed.' }
    $phase = 'extension_ensure'
    $extensions = Get-ExtensionState 'Ensure'
    $phase = 'extension_status'
    $verified = Get-ExtensionState 'Status'
    $phase = 'identity_final'
    $finalGuard = Get-GuardState
    $ok = [bool]($extensions.ok -and $verified.ok -and $finalGuard.ok)
    [pscustomobject]@{ port = $Port; action = $Action; ok = $ok; started = $started; extensions_verified = [bool]$verified.ok } | ConvertTo-Json -Compress
    if (-not $ok) { exit 1 }
} catch {
    $reason = if ($_.Exception.Data['reasonCode'] -ceq 'pinned_extension_source_verification_failed') { 'pinned_extension_source_verification_failed' } else { 'registered_launcher_operation_failed' }
    [pscustomobject]@{ port = $Port; action = $Action; ok = $false; error = $reason; phase = $phase; extension_key = $_.Exception.Data['extensionKey'] } | ConvertTo-Json -Compress
    exit 1
}
