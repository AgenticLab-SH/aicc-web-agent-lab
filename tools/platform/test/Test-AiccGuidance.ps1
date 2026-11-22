[CmdletBinding()]
param(
    [string]$AiccRoot = '.',
    [string[]]$TargetGroups = @(),
    [switch]$AllTargets,
    [switch]$FullIntegration,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$AiccRoot = (Resolve-Path -LiteralPath $AiccRoot).Path

$effectiveTargetGroups = @($TargetGroups)
if (-not $AllTargets -and $effectiveTargetGroups.Count -eq 0) {
    $modulePath = Join-Path $AiccRoot 'tools/platform/core/AgentHomeDeployment.psm1'
    Import-Module $modulePath -Force
    $policy = Get-AgentHomeDeploymentPolicy -AiccRoot $AiccRoot
    $effectiveTargetGroups = @($policy.default_groups)
    $effectiveTargetGroups = @($effectiveTargetGroups | Sort-Object -Unique)
}

$commands = @(
    @{ name='deployment-policy'; path='tools/platform/test/Test-AgentHomeDeploymentPolicy.ps1'; target_aware=$false },
    @{ name='directives'; path='tools/platform/test/Test-AgentHomeDirectives.ps1'; target_aware=$true },
    @{ name='skills'; path='tools/platform/inspect/Inspect-AgentSkills.ps1'; target_aware=$true },
    @{ name='guidance-sources'; path='tools/platform/inspect/Inspect-GuidanceSources.ps1'; target_aware=$false },
    @{ name='agents'; path='tools/platform/test/Test-CodexAgentDeployment.ps1'; target_aware=$false }
)
$invocations = @()
$invocationIndex = 0
foreach ($command in $commands) {
    $baseArguments = @('-NoProfile', '-File', (Join-Path $AiccRoot $command.path), '-AiccRoot', $AiccRoot, '-SummaryOnly', '-AsJson')
    if ($FullIntegration -and $command.name -eq 'deployment-policy') { $baseArguments += '-FullIntegration' }

    # pwsh -File binds only the first command-line value of an array parameter;
    # a second value can fall through positionally into CatalogPath. Validate
    # selected groups one at a time instead of relying on lossy CLI array binding.
    $targetRuns = if (
        $command.target_aware -and
        -not $AllTargets
    ) { @($effectiveTargetGroups) } else { @('') }

    foreach ($targetRun in $targetRuns) {
        $arguments = @($baseArguments)
        $name = [string]$command.name
        if ($command.target_aware) {
            if ($AllTargets) {
                $arguments += '-AllTargets'
            } elseif ($targetRun) {
                $arguments += @('-TargetGroups', [string]$targetRun)
                if ($targetRuns.Count -gt 1) { $name = "$name`:$targetRun" }
            }
        }
        $invocations += [pscustomobject]@{
            index = $invocationIndex
            name = $name
            arguments = $arguments
        }
        $invocationIndex += 1
    }
}
$results = @($invocations | ForEach-Object -Parallel {
    $invocation = $_
    $arguments = @($invocation.arguments)
    $raw = @(& pwsh @arguments) -join "`n"
    $exitCode = $LASTEXITCODE
    $payload = try { $raw | ConvertFrom-Json } catch { $null }
    [pscustomobject]@{
        index = [int]$invocation.index
        name = [string]$invocation.name
        ok = ($exitCode -eq 0 -and $null -ne $payload -and [bool]$payload.ok)
        exit_code = $exitCode
        result = $payload
    }
} -ThrottleLimit 5 | Sort-Object index | Select-Object name, ok, exit_code, result)
$failed = @($results | Where-Object { -not $_.ok })
$report = [ordered]@{
    ok = ($failed.Count -eq 0)
    mode = if ($FullIntegration) { 'full-integration' } else { 'fast-drift' }
    aicc_root = $AiccRoot
    check_count = $results.Count
    failed_count = $failed.Count
    checks = $results
}
if ($AsJson) { $report | ConvertTo-Json -Compress -Depth 9 } else { $report | ConvertTo-Json -Depth 9 }
if ($failed.Count) { exit 1 }
