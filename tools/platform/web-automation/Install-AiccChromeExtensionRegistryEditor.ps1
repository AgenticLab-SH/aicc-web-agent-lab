#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) '.ai-control-center\browser-extensions'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$sources = @(
    'Edit-AiccChromeExtensionRegistry.ps1',
    'extension-postcondition.mjs',
    'edit-aicc-extension-registry.mjs',
    'Manage-AiccChromeExtensions.ps1',
    'manage-aicc-chrome-extensions.mjs',
    'verify-aicc-extension-registry-sources.mjs'
)
if (-not (Test-Path -LiteralPath (Join-Path $Destination 'registry.json') -PathType Leaf)) {
    throw "The existing owner registry is missing: $Destination\registry.json"
}
foreach ($name in $sources) {
    $source = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Canonical registry editor is missing: $source" }
    if (-not $DryRun) { Copy-Item -LiteralPath $source -Destination (Join-Path $Destination $name) -Force }
}
[ordered]@{ ok = $true; dry_run = $DryRun.IsPresent; destination = $Destination; files = $sources } | ConvertTo-Json -Compress
