#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^@[A-Za-z0-9_]{5,32}$')]
    [string]$BotUsername,
    [string]$Endpoint = '',
    [ValidateRange(10,300)]
    [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$AuditScript = Join-Path $PSScriptRoot 'botfather_menu_audit.py'
$LeaseHelper = Join-Path $PSScriptRoot 'Invoke-TelegramAdminBrowserLease.ps1'
$AiccStateRoot = if ($env:AICC_STATE_ROOT) { $env:AICC_STATE_ROOT } else { Join-Path $HOME '.ai-control-center' }
$Python = if ($env:AICC_TELEGRAM_ADMIN_PYTHON) { $env:AICC_TELEGRAM_ADMIN_PYTHON } elseif ($IsWindows) { Join-Path $AiccStateRoot 'runtime/telegram-admin-python/Scripts/python.exe' } else { Join-Path $AiccStateRoot 'runtime/telegram-admin-python/bin/python' }
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw 'telegram_admin_runtime_missing_run_install_telegram_admin_runtime' }
$Lease = $null
$Released = $false
$Result = $null
$ExitCode = 2

try {
    $LeaseRaw = @(& $LeaseHelper -Action Acquire -Url 'https://web.telegram.org/a/') -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'telegram_admin_lease_acquire_failed' }
    $Lease = $LeaseRaw | ConvertFrom-Json -ErrorAction Stop
    if (-not $Lease.ok -or -not $Lease.endpoint -or -not $Lease.lease_token) { throw 'invalid_telegram_admin_lease' }
    if ($Endpoint -and $Endpoint -ne [string]$Lease.endpoint) { throw 'endpoint_does_not_match_registered_telegram_admin' }
    $Endpoint = [string]$Lease.endpoint

    $Raw = @(& $Python $AuditScript --endpoint $Endpoint --bot-username $BotUsername --timeout-sec $TimeoutSec) -join "`n"
    $ExitCode = $LASTEXITCODE
    try { $Result = $Raw | ConvertFrom-Json -ErrorAction Stop }
    catch { $Result = [pscustomobject]@{ok=$false;error='invalid_audit_json'}; $ExitCode=2 }
    if ($null -eq $Result) { $Result = [pscustomobject]@{ok=$false;error='empty_audit_json'}; $ExitCode=2 }
} catch {
    $Result = [pscustomobject]@{ok=$false;error=$_.Exception.Message}
    $ExitCode = 2
} finally {
    if ($Lease -and $Lease.lease_token) {
        $ReleaseRaw = @(& $LeaseHelper -Action Release -LeaseToken ([string]$Lease.lease_token)) -join "`n"
        if ($LASTEXITCODE -eq 0) {
            try { $Released = [bool](($ReleaseRaw | ConvertFrom-Json).ok) } catch { $Released = $false }
        }
    }
}

$Result | Add-Member -NotePropertyName endpoint -NotePropertyValue $Endpoint -Force
$Result | Add-Member -NotePropertyName browser_role -NotePropertyValue 'telegram_admin' -Force
$Result | Add-Member -NotePropertyName browser_started_by_lease -NotePropertyValue ([bool]$Lease.browser_started_by_lease) -Force
$Result | Add-Member -NotePropertyName lease_released -NotePropertyValue $Released -Force
$Result | Add-Member -NotePropertyName chrome_side_effect -NotePropertyValue $false -Force
$Result | Add-Member -NotePropertyName ok -NotePropertyValue ([bool]$Result.ok -and $ExitCode -eq 0 -and $Released) -Force
if (-not $Released -and -not $Result.error) { $Result | Add-Member -NotePropertyName error -NotePropertyValue 'telegram_admin_lease_release_failed' -Force }
$Result | ConvertTo-Json -Depth 8
if (-not $Result.ok) { exit 2 }
