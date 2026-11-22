#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Acquire','Release')]
    [string]$Action,
    [string]$LeaseToken = '',
    [string]$Url = 'https://web.telegram.org/a/'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$AiccRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$CoordinationReader = Join-Path $AiccRoot 'tools\platform\core\Read-AiccCoordination.ps1'
$LeaseTool = Join-Path $AiccRoot 'tools\platform\web-automation\Manage-CdpChromeSlotLease.ps1'

if ($Action -eq 'Release') {
    if (-not $LeaseToken) { throw 'telegram_admin_release_requires_lease_token' }
    & $LeaseTool -Action Release -LeaseToken $LeaseToken -AsJson
    exit $LASTEXITCODE
}

$Port = [int](& $CoordinationReader -Key browser.telegram_admin_port)
$ExpectedProfile = [string](& $CoordinationReader -Key browser.telegram_admin_profile_dir)
$ExpectedLauncher = [string](& $CoordinationReader -Key browser.telegram_admin_launcher)
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'telegram_admin_port_missing' }
if ($Port -in @(9222, 9223, 9224, 9226)) { throw 'telegram_admin_port_must_be_dedicated' }
if (-not $ExpectedProfile -or -not $ExpectedLauncher) { throw 'telegram_admin_identity_incomplete' }

$Count = [int](& $CoordinationReader -Key browser.cdp_slot_count)
$Matched = $false
for ($Index = 1; $Index -le $Count; $Index++) {
    $SlotPort = [int](& $CoordinationReader -Key "browser.cdp_slot${Index}_port")
    if ($SlotPort -ne $Port) { continue }
    $Usage = [string](& $CoordinationReader -Key "browser.cdp_slot${Index}_usage")
    $Profile = [string](& $CoordinationReader -Key "browser.cdp_slot${Index}_profile_dir")
    $Launcher = [string](& $CoordinationReader -Key "browser.cdp_slot${Index}_launcher")
    if ($Usage -ne 'telegram_admin' -or $Profile -ne $ExpectedProfile -or $Launcher -ne $ExpectedLauncher) {
        throw 'telegram_admin_registered_slot_mismatch'
    }
    $Matched = $true
    break
}
if (-not $Matched) { throw 'telegram_admin_registered_slot_missing' }

$Raw = @(& $LeaseTool -Action Acquire -SlotPorts ([string]$Port) -Url $Url -AsJson) -join "`n"
$ExitCode = $LASTEXITCODE
if ($ExitCode -ne 0) { Write-Output $Raw; exit $ExitCode }
$Envelope = $Raw | ConvertFrom-Json -ErrorAction Stop
if (-not $Envelope.ok -or -not $Envelope.lease) { throw 'invalid_cdp_slot_lease_result' }
$Lease = $Envelope.lease
[ordered]@{
    ok = $true
    status = [string]$Envelope.status
    lease_token = [string]$Lease.lease_token
    port = [int]$Lease.port
    endpoint = [string]$Lease.endpoint
    profile_dir = [string]$Lease.profile_dir
    profile_directory = [string]$Lease.profile_directory
    account_alias = [string]$Lease.account_alias
    workspace = [string]$Lease.workspace
    target_id = [string]$Lease.target_id
    target_url = [string]$Lease.target_url
    control_state_dir = [string]$Lease.control_state_dir
    browser_started_by_lease = [bool]$Lease.browser_started_by_lease
    expires_at_utc = [string]$Lease.expires_at_utc
} | ConvertTo-Json -Compress
