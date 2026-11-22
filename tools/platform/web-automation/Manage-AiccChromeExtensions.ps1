#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Status','Ensure','Reload','Configure','Remove')]
    [string]$Action,
    [Parameter(Mandatory)]
    [ValidateSet('all','9222','9223','9224','9225')]
    [string]$Target,
    [string]$Extension = 'all',
    [string]$AiccRoot = 'C:\demo\open-AICC',
    [switch]$NoStart,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSCommandPath
$RegistryPath = Join-Path $Root 'registry.json'
$ManagerPath = Join-Path $Root 'manage-aicc-chrome-extensions.mjs'
$SourceVerifier = Join-Path $Root 'verify-aicc-extension-registry-sources.mjs'
$userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$LauncherPath = Join-Path $userHome '.ai-control-center\browser-launchers\Start-CdpChromeSlot.ps1'
$IdentityGuard = Join-Path $AiccRoot 'tools\platform\web-automation\Assert-CdpEndpointIdentity.ps1'
$ProfileRoot = Join-Path $userHome '.ai-control-center\browser-profiles\chrome'
$Ports = if ($Target -eq 'all') { @(9222,9223,9224,9225) } else { @([int]$Target) }
$ActionName = $Action.ToLowerInvariant()

foreach ($required in @($RegistryPath,$ManagerPath,$SourceVerifier,$LauncherPath,$IdentityGuard)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required file is missing: $required" }
}
$verification = & node $SourceVerifier --registry $RegistryPath --extension $Extension 2>&1
if ($LASTEXITCODE -ne 0) {
    # Return a bounded reason; raw Git errors can contain private source paths.
    $failedKey = $null
    if (($verification -join "`n") -match 'Pinned extension source drift for ([a-z0-9][a-z0-9-]{1,62})(?:\s|$)') { $failedKey = $Matches[1] }
    [pscustomobject]@{ok=$false;action=$ActionName;target=$Target;error='pinned_extension_source_verification_failed';extension_key=$failedKey} | ConvertTo-Json -Compress
    exit 1
}

if ($DryRun) {
    $registry = Get-Content -LiteralPath $RegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $operations = foreach ($Port in $Ports) {
        $keys = @($registry.extensions | Where-Object {
            ($Extension -eq 'all' -or $_.key -eq $Extension) -and ([string]$Port -in @($_.slots | ForEach-Object { [string]$_ }))
        } | ForEach-Object { $_.key })
        if ($keys.Count -eq 0) { throw "No registered extension matches port $Port and key $Extension" }
        [pscustomobject]@{port=$Port;action=$ActionName;extensions=$keys}
    }
    [pscustomobject]@{ok=$true;dry_run=$true;registry=$RegistryPath;target=$Target;action=$ActionName;operations=@($operations)} | ConvertTo-Json -Depth 8
    exit 0
}

$results = @()
foreach ($Port in $Ports) {
    $Endpoint = "http://127.0.0.1:$Port"
    $Profile = Join-Path $ProfileRoot "$Port\UserData"
    try {
        try { Invoke-RestMethod -Uri "$Endpoint/json/version" -TimeoutSec 3 | Out-Null }
        catch {
            if ($Action -eq 'Status' -or $NoStart) { throw "CDP $Port is offline" }
            & $LauncherPath -Port $Port -AiccRoot $AiccRoot
        }
        & pwsh -NoProfile -File $IdentityGuard -ExpectedBrowser chrome -Endpoint $Endpoint -ExpectedProfileDir $Profile -AsJson *> $null
        if ($LASTEXITCODE -ne 0) { throw "CDP identity check failed for $Port" }
        $raw = & node $ManagerPath --registry $RegistryPath --endpoint $Endpoint --slot ([string]$Port) --action $ActionName --extension $Extension 2>&1
        if ($LASTEXITCODE -ne 0) { throw ($raw -join [Environment]::NewLine) }
        $results += (($raw -join [Environment]::NewLine) | ConvertFrom-Json)
    } catch {
        $results += [pscustomobject]@{ok=$false;endpoint=$Endpoint;slot=[string]$Port;action=$ActionName;error=$_.Exception.Message}
    }
}
$summary = [pscustomobject]@{ok=@($results | Where-Object { -not $_.ok }).Count -eq 0;registry=$RegistryPath;scope='registered_AICC_extensions_only';action=$ActionName;target=$Target;results=$results}
$summary | ConvertTo-Json -Depth 10
if (-not $summary.ok) { exit 1 }
