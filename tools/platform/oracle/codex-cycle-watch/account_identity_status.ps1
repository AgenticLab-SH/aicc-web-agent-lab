[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Root
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-OpenSshTool([string]$Name) {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git) {
        $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
        $candidate = Join-Path $gitRoot "usr\bin\$Name.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $fallback = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
    if ($fallback) { return $fallback.Source }
    throw "$Name executable not found."
}

function Assert-RegularFile([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label missing" }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$Label link refused" }
}

$resolvedRoot = [IO.Path]::GetFullPath($Root)
if (-not [IO.Path]::IsPathFullyQualified($Root) -or (Split-Path $resolvedRoot -Leaf) -ne 'oracle-a1-access') {
    throw 'Exact access root required'
}
$walk = $resolvedRoot
while ($walk) {
    if (Test-Path -LiteralPath $walk) {
        if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Reparse point refused'
        }
    }
    $next = Split-Path $walk -Parent
    if ($next -eq $walk) { break }
    $walk = $next
}

$contractPath = Join-Path $resolvedRoot 'connection.json'
$keyPath = Join-Path $resolvedRoot 'id_rsa'
$knownHosts = Join-Path $resolvedRoot 'known_hosts'
Assert-RegularFile $contractPath 'connection metadata'
Assert-RegularFile $keyPath 'private key'
Assert-RegularFile $knownHosts 'known_hosts'

$contract = Get-Content -Raw -LiteralPath $contractPath | ConvertFrom-Json
if (($contract.version -ne 1) -or
    ($contract.target -ne 'a1') -or
    ($contract.user -notmatch '^[a-z_][a-z0-9_-]*$') -or
    ($contract.host -notmatch '^\d{1,3}(\.\d{1,3}){3}$') -or
    ([string]$contract.knownHostsSha256 -notmatch '^[A-Fa-f0-9]{64}$')) {
    throw 'Invalid connection contract'
}

& (Join-Path $PSScriptRoot 'access_key.ps1') -Action status -Target a1 -Root $resolvedRoot | Out-Null
if ((Get-FileHash -LiteralPath $knownHosts -Algorithm SHA256).Hash -ne $contract.knownHostsSha256) {
    throw 'Pinned host identity changed'
}

$ssh = Resolve-OpenSshTool 'ssh'
$sshArgs = @(
    '-F','none',
    '-o','BatchMode=yes',
    '-o','IdentitiesOnly=yes',
    '-o','StrictHostKeyChecking=yes',
    '-o',"UserKnownHostsFile=$knownHosts",
    '-o','HostKeyAlias=aicc-oracle-a1',
    '-o','ConnectTimeout=15',
    '-i',$keyPath,
    "$($contract.user)@$($contract.host)"
)

$sourceWatcher = Join-Path $PSScriptRoot 'hub_cycle_watch.py'
$sourcePolicy = Join-Path $PSScriptRoot 'cycle_policy.py'
Assert-RegularFile $sourceWatcher 'identity observer source'
Assert-RegularFile $sourcePolicy 'identity observer policy'
$expectedWatcherHash = (Get-FileHash -LiteralPath $sourceWatcher -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedPolicyHash = (Get-FileHash -LiteralPath $sourcePolicy -Algorithm SHA256).Hash.ToLowerInvariant()
$remoteHashCommand = 'sha256sum "$HOME/.local/share/aicc-ocx-identity-observer/hub_cycle_watch.py" "$HOME/.local/share/aicc-ocx-identity-observer/cycle_policy.py"'
$remoteHashes = @(& $ssh @sshArgs $remoteHashCommand)
if ($LASTEXITCODE -ne 0 -or $remoteHashes.Count -ne 2) { throw 'A1 identity observer hash check failed' }
$observedWatcherHash = ([string]$remoteHashes[0] -split '\s+', 2)[0].ToLowerInvariant()
$observedPolicyHash = ([string]$remoteHashes[1] -split '\s+', 2)[0].ToLowerInvariant()
if ($observedWatcherHash -ne $expectedWatcherHash -or $observedPolicyHash -ne $expectedPolicyHash) {
    throw 'A1 identity observer source drift'
}

$remoteCommand = 'python3 -B "$HOME/.local/share/aicc-ocx-identity-observer/hub_cycle_watch.py" identity-status --root "$HOME/.local/state/aicc-ocx-cycle-watch" --ocx "$HOME/.local/bin/ocx-hub" --hub-config "$HOME/.opencodex-hub/config.json"'
$raw = @(& $ssh @sshArgs $remoteCommand)
if ($LASTEXITCODE -ne 0) { throw 'A1 identity observer failed' }
$text = ($raw -join [Environment]::NewLine).Trim()
if (-not $text) { throw 'A1 identity observer returned no data' }

try { $payload = $text | ConvertFrom-Json } catch { throw 'A1 identity observer returned invalid JSON' }
if ($payload.schemaVersion -ne 1 -or $payload.source -ne 'a1-ocx-hub' -or $null -eq $payload.accounts) {
    throw 'A1 identity observer schema mismatch'
}
$observedAt = [double]$payload.observedAt
if ([double]::IsNaN($observedAt) -or [double]::IsInfinity($observedAt) -or $observedAt -le 0) {
    throw 'A1 identity observer timestamp invalid'
}

$accounts = @()
foreach ($row in @($payload.accounts)) {
    $selector = [string]$row.selector
    $identityHash = [string]$row.identityHash
    $plan = [string]$row.plan
    $blockReason = if ($null -eq $row.blockReason) { $null } else { [string]$row.blockReason }
    if ($selector -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'Unsafe OCX selector' }
    if ($identityHash -notmatch '^[a-f0-9]{64}$') { throw 'Unsafe OCX identity hash' }
    if ($plan.Length -gt 32 -or $plan -match '[\x00-\x1f\x7f]') { throw 'Unsafe OCX plan label' }
    if ($null -ne $blockReason -and $blockReason -notin @('paused','needs_reauth')) { throw 'Unsafe OCX block reason' }
    if ($row.active -isnot [bool]) { throw 'Unsafe OCX active state' }
    $accounts += [pscustomobject]@{
        selector = $selector
        identityHash = $identityHash
        active = [bool]$row.active
        plan = $plan
        blockReason = $blockReason
    }
}

[pscustomobject]@{
    schemaVersion = 1
    source = 'a1-ocx-hub'
    observedAt = $observedAt
    accountCount = $accounts.Count
    activeCount = @($accounts | Where-Object { $_.active }).Count
    accounts = $accounts
} | ConvertTo-Json -Depth 5 -Compress
