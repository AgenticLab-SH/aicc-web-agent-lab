#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('List','Register','Unregister','TrustRoot','RefreshTrustRoot','UntrustRoot')]
    [string]$Action,
    [string]$Key = '',
    [string]$Definition = '',
    [string]$SourceRoot = '',
    [string]$ExpectedGitHead = '',
    [string]$ExpectedGitRemote = '',
    [string]$Registry = (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) '.ai-control-center\browser-extensions\registry.json'),
    [switch]$Replace,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Editor = Join-Path $PSScriptRoot 'edit-aicc-extension-registry.mjs'
foreach ($required in @($Registry,$Editor)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required registry component is missing: $required" }
}

$actionName = ($Action -creplace '([a-z])([A-Z])','$1-$2').ToLowerInvariant()
$arguments = @($Editor,'--registry',(Resolve-Path -LiteralPath $Registry).Path,'--action',$actionName,'--dry-run',$DryRun.IsPresent.ToString().ToLowerInvariant())
if ($Action -eq 'Register') {
    if (-not $Definition) { throw 'Register requires -Definition with an exact absolute JSON path' }
    $resolvedDefinition = [IO.Path]::GetFullPath($Definition)
    if (-not (Test-Path -LiteralPath $resolvedDefinition -PathType Leaf)) { throw "Definition is missing: $resolvedDefinition" }
    $arguments += @('--definition',$resolvedDefinition,'--replace',$Replace.IsPresent.ToString().ToLowerInvariant())
}
if ($Action -in @('TrustRoot','RefreshTrustRoot','UntrustRoot')) {
    if (-not $SourceRoot) { throw "$Action requires an exact -SourceRoot" }
    $arguments += @('--source-root',[IO.Path]::GetFullPath($SourceRoot))
}
if ($Action -in @('TrustRoot','RefreshTrustRoot')) {
    if (-not $ExpectedGitHead -or -not $ExpectedGitRemote) { throw "$Action requires -ExpectedGitHead and -ExpectedGitRemote" }
    $arguments += @('--expected-head',$ExpectedGitHead,'--expected-remote',$ExpectedGitRemote)
}
if ($Action -in @('Register','Unregister')) {
    if (-not $Key) { throw "$Action requires an exact -Key" }
    $arguments += @('--key',$Key)
}
& node @arguments
exit $LASTEXITCODE
