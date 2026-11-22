#requires -Version 7.0
<#
.SYNOPSIS
  Atomically lease a task-owned background target on a registered CDP Chrome slot.
.DESCRIPTION
  Coordinates agents without a daemon. Each port may host several independent
  target leases. A named mutex protects per-target JSON records stored outside
  the repository. Acquire chooses the least-loaded verified authenticated slot,
  starts it only with explicit AllowBrowserStart, and creates one background
  target. Release closes only that target.

  Port 9226 is the separate AICC-owned isolated QA browser and is intentionally
  started and stopped on demand instead of joining this authenticated pool.
  Registered slots whose usage contains "pending" are excluded until their
  account and workspace identity has been verified in private coordination.
  Reserved administration slots are selected only by an explicit port request.

  Leases cover an active browser-action interval, not an entire conversation.
  Existing tabs are never selected, activated, navigated, or closed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Acquire', 'Heartbeat', 'Release', 'Status', 'ReadExisting', 'CloseCompleted', 'QueueOwnerInspect')]
    [string]$Action,
    [string]$OwnerId = '',
    [string]$LeaseToken = '',
    [string]$Url = 'about:blank',
    [ValidateRange(0, 60)]
    [int]$WaitSec = 5,
    [ValidateRange(0, 86400)]
    [int]$TtlSec = 0,
    [int]$MaxTargetsPerSlot = 0,
    [string]$StateRoot = '',
    [string[]]$SlotPorts = @(),
    [string]$AccountAlias = '',
    [string]$Workspace = '',
    [ValidateRange(0, 65535)]
    [int]$PreferredPort = 0,
    [switch]$ExclusiveSlot,
    [switch]$AllowBrowserStart,
    [string]$CoordinationPath = '',
    [switch]$NoBrowser,
    [switch]$KeepTarget,
    [switch]$AsJson,
    # Opt-in original acquisition for future retained-target reconciliation.
    [switch]$RecordReadHistory,
    [string]$OriginalReceipt = '',
    [string]$OriginalReceiptSha256 = '',
    [string]$PromptSha256 = '',
    [string]$TargetId = '',
    [string]$CompletionReceipt = '',
    [string]$CompletionReceiptSha256 = '',
    # Owner-issued queue proof is read-only and requires an exact active task lease.
    [string]$ConversationId = '',
    [string]$OriginalRequestSha256 = '',
    # Queue pre-dispatch retention is distinct from post-dispatch original receipts.
    [string]$QueueOwnerRequestFile = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$aiccStateRoot = if ($env:AICC_STATE_ROOT) { $env:AICC_STATE_ROOT } else { Join-Path $HOME '.ai-control-center' }
$explicitCoordination = $PSBoundParameters.ContainsKey('CoordinationPath')
$coordinationPath = if ($CoordinationPath) { $CoordinationPath } elseif ($env:AICC_COORDINATION_FILE) { $env:AICC_COORDINATION_FILE } else { Join-Path $aiccStateRoot 'guidance/coordination.toml' }
$identityGuard = Join-Path $PSScriptRoot 'Assert-CdpEndpointIdentity.ps1'

function Get-TomlSection {
    param([string]$Path, [string]$Section)
    $result = @{}
    $current = ''
    foreach ($raw in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $raw.Trim()
        if ($line -match '^\[(.+)\]$') { $current = $Matches[1]; continue }
        if ($current -ne $Section) { continue }
        if ($line -match '^([A-Za-z0-9_\-]+)\s*=\s*"([^"]*)"\s*(#.*)?$') {
            $result[$Matches[1]] = $Matches[2]
        } elseif ($line -match '^([A-Za-z0-9_\-]+)\s*=\s*([^\s#]+)\s*(#.*)?$') {
            $result[$Matches[1]] = $Matches[2]
        }
    }
    return $result
}

function Get-DefaultStateRoot {
    if ($env:AICC_CDP_LEASE_ROOT) { return $env:AICC_CDP_LEASE_ROOT }
    return (Join-Path $aiccStateRoot 'browser/cdp-target-leases')
}

$browserConfig = if (Test-Path -LiteralPath $coordinationPath -PathType Leaf) {
    Get-TomlSection -Path $coordinationPath -Section 'browser'
} else { @{} }
if ($TtlSec -eq 0) { $TtlSec = [int]$browserConfig['cdp_lease_ttl_seconds'] }
if ($TtlSec -lt 1) { $TtlSec = 600 }
if ($MaxTargetsPerSlot -eq 0) { $MaxTargetsPerSlot = [int]$browserConfig['cdp_targets_per_slot'] }
if ($MaxTargetsPerSlot -lt 1) { $MaxTargetsPerSlot = 3 }
if ($MaxTargetsPerSlot -gt 16) { throw 'MaxTargetsPerSlot must be between 1 and 16.' }

if (-not $StateRoot) { $StateRoot = Get-DefaultStateRoot }
$StateRoot = [IO.Path]::GetFullPath($StateRoot)
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null

$normalizedSlotPorts = @($SlotPorts | ForEach-Object {
    foreach ($part in ([string]$_ -split ',')) {
        $trimmed = $part.Trim()
        if (-not $trimmed) { continue }
        $parsed = 0
        if (-not [int]::TryParse($trimmed, [ref]$parsed) -or $parsed -lt 1024 -or $parsed -gt 65535) {
            throw "Invalid CDP slot port: $trimmed"
        }
        $parsed
    }
} | Sort-Object -Unique)

function Get-ConfiguredSlots {
    if ($NoBrowser -and $normalizedSlotPorts.Count -gt 0 -and -not $explicitCoordination) {
        return @($normalizedSlotPorts | ForEach-Object {
            [pscustomobject]@{
                port = [int]$_
                endpoint = "http://127.0.0.1:$_"
                profile_dir = ''
                profile_directory = 'Default'
                launcher = ''
                account_alias = ''
                workspace = ''
                usage = 'test'
            }
        })
    }
    if (-not (Test-Path -LiteralPath $coordinationPath -PathType Leaf)) {
        throw "coordination.toml not found: $coordinationPath"
    }
    $count = [int]$browserConfig['cdp_slot_count']
    if ($count -lt 1) { throw 'No registered CDP Chrome slots are configured.' }
    $configured = for ($index = 1; $index -le $count; $index++) {
        $port = [int]$browserConfig["cdp_slot${index}_port"]
        if ($normalizedSlotPorts.Count -gt 0 -and $port -notin $normalizedSlotPorts) { continue }
        $profile = [string]$browserConfig["cdp_slot${index}_profile_dir"]
        if (-not $port -or -not $profile) { throw "Incomplete CDP slot configuration at index $index." }
        $launcher = [string]$browserConfig["cdp_slot${index}_launcher"]
        [pscustomobject]@{
            port = $port
            endpoint = "http://127.0.0.1:$port"
            profile_dir = $profile
            profile_directory = [string]$browserConfig["cdp_slot${index}_profile_directory"]
            launcher = $launcher
            account_alias = [string]$browserConfig["cdp_slot${index}_account_alias"]
            workspace = [string]$browserConfig["cdp_slot${index}_workspace"]
            usage = [string]$browserConfig["cdp_slot${index}_usage"]
            exclusive = [string]$browserConfig["cdp_slot${index}_exclusive"] -eq 'true'
        }
    }
    if ($AccountAlias) {
        $configured = @($configured | Where-Object {
            $_.account_alias -eq $AccountAlias -and (-not $Workspace -or $_.workspace -eq $Workspace)
        })
    }
    $configured = @($configured | Where-Object { $_.usage -notmatch '(?i)pending|disabled|reserved' })
    if ($normalizedSlotPorts.Count -eq 0) {
        $configured = @($configured | Where-Object { $_.usage -notmatch '(?i)telegram_admin|admin_reserved' })
    }
    $resolved = @($configured | Sort-Object port)
    if ($PreferredPort -and (-not $AccountAlias -or -not $Workspace)) {
        throw 'PreferredPort requires an exact account alias and workspace; port fallback must preserve identity.'
    }
    if ($PreferredPort -and $normalizedSlotPorts.Count -gt 0) { throw 'Use SlotPorts for an exact port or PreferredPort for a matching registered pool, not both.' }
    if ($PreferredPort -and @($resolved | Where-Object port -eq $PreferredPort).Count -ne 1) { throw 'PreferredPort is not registered for this account/workspace.' }
    if ($resolved.Count -eq 0) {
        $requestedIdentity = if ($AccountAlias) { "$AccountAlias/$Workspace" } else { 'registered authenticated slots' }
        throw "No registered CDP Chrome slots matched the requested scope: $requestedIdentity"
    }
    return $resolved
}

$slots = @(Get-ConfiguredSlots)
if ($Action -eq 'Acquire' -and -not $NoBrowser -and $normalizedSlotPorts.Count -eq 0 -and (-not $AccountAlias -or -not $Workspace)) {
    throw 'Automatic browser allocation requires an exact account alias and workspace.'
}
if (-not $OwnerId) {
    $OwnerId = @($env:CODEX_THREAD_ID, $env:CLAUDE_SESSION_ID, $env:AGENT_TASK_ID) |
        Where-Object { $_ } | Select-Object -First 1
}
if (-not $OwnerId) { $OwnerId = "manual-$([Guid]::NewGuid().ToString('N'))" }

$hashBytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($StateRoot))
$mutexSuffix = ([Convert]::ToHexString($hashBytes)).Substring(0, 20)
$mutex = [Threading.Mutex]::new($false, "AICC.CdpChromeTargetLease.$mutexSuffix")

function Enter-LeaseMutex {
    try {
        if (-not $mutex.WaitOne([TimeSpan]::FromSeconds(15))) { throw 'Timed out waiting for the CDP target lease mutex.' }
    } catch [Threading.AbandonedMutexException] { }
}
function Exit-LeaseMutex { try { $mutex.ReleaseMutex() } catch { } }

function Get-PortLeaseDirectory {
    param([int]$Port)
    Join-Path $StateRoot ("{0}.leases" -f $Port)
}
function Get-LeasePath {
    param([int]$Port, [string]$Token)
    Join-Path (Get-PortLeaseDirectory -Port $Port) ("{0}.lease.json" -f $Token)
}
function Read-PortLeases {
    param([int]$Port)
    $dir = Get-PortLeaseDirectory -Port $Port
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return @() }
    $records = foreach ($path in Get-ChildItem -LiteralPath $dir -Filter '*.lease.json' -File -ErrorAction SilentlyContinue) {
        if ($path.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked lease record refused.' }
        try { $record = Convert-LeaseJson (Get-Content -LiteralPath $path.FullName -Raw -Encoding UTF8) } catch { throw "Unreadable lease record; preserve this slot: $Port" }
        if ($record.port -ne $Port -or [string]$record.lease_token -notmatch '^[a-f0-9]{32}$' -or $path.Name -cne "$($record.lease_token).lease.json") { throw "Invalid lease identity; preserve this slot: $Port" }
        $record
    }
    return @($records)
}
function Convert-LeaseJson([string]$Text) {
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { return $Text | ConvertFrom-Json -DateKind String }
    return $Text | ConvertFrom-Json
}
function Write-Lease {
    param([Parameter(Mandatory)]$Lease)
    $dir = Get-PortLeaseDirectory -Port ([int]$Lease.port)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $path = Get-LeasePath -Port ([int]$Lease.port) -Token ([string]$Lease.lease_token)
    $temp = Join-Path $dir ("{0}.{1}.tmp" -f $Lease.lease_token, [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($temp, ($Lease | ConvertTo-Json -Depth 7) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $path -Force
}
function Remove-LeaseRecord {
    param($Lease)
    if ([string]$Lease.lease_token -notmatch '^[a-f0-9]{32}$') { throw 'Invalid lease token.' }
    $path = Get-LeasePath -Port ([int]$Lease.port) -Token ([string]$Lease.lease_token)
    if ($Lease.control_state_dir -and (Test-Path -LiteralPath ([string]$Lease.control_state_dir) -PathType Container)) {
        $expected = [IO.Path]::GetFullPath((Join-Path (Get-PortLeaseDirectory -Port ([int]$Lease.port)) ("control-{0}" -f $Lease.lease_token)))
        $actual = [IO.Path]::GetFullPath([string]$Lease.control_state_dir)
        if ($actual -cne $expected -or (Get-Item -LiteralPath $actual).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unowned control-state directory preserved.' }
        Remove-Item -LiteralPath $actual -Recurse -Force -ErrorAction Stop
    }
    Remove-Item -LiteralPath $path -Force -ErrorAction Stop
}
function Test-LeaseExpired {
    param($Lease)
    if ($null -eq $Lease -or -not $Lease.expires_at_utc) { return $false }
    try { return [DateTimeOffset]::Parse([string]$Lease.expires_at_utc) -le [DateTimeOffset]::UtcNow } catch { return $false }
}
function Test-LeaseBlocksSlot($Lease) {
    if ([string]$Lease.mode -eq 'read-existing') { return $true }
    return (-not (Test-LeaseExpired $Lease)) -or [string]$Lease.state -in @('releasing', 'reclaiming', 'cleanup_failed', 'provisioning', 'unknown', 'outcome_unknown')
}
function Get-SlotCapacity($Slot) {
    if ($ExclusiveSlot -or $Slot.exclusive) { return 1 }
    return $MaxTargetsPerSlot
}
function New-TaskTargetNonce {
    $bytes = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToHexString($bytes).ToLowerInvariant()
}
function Get-TaskTargetUrl {
    param([string]$RequestedUrl, [string]$Nonce)
    $parsed = $null
    if (-not [Uri]::TryCreate($RequestedUrl, [UriKind]::Absolute, [ref]$parsed)) { return $RequestedUrl }
    if ($parsed.Scheme -ne 'https' -or $parsed.Host -ne 'chatgpt.com') { return $RequestedUrl }
    if ($parsed.Query -match '(^|[?&])aicc_task_target=') { throw 'ChatGPT target URL already contains aicc_task_target.' }
    if ($Nonce -notmatch '^[a-f0-9]{64}$') { throw 'ChatGPT task target nonce is invalid.' }
    $builder = [UriBuilder]::new($parsed)
    $existing = $builder.Query.TrimStart('?')
    $builder.Query = @($existing, "aicc_task_target=$Nonce") | Where-Object { $_ } | Join-String -Separator '&'
    return $builder.Uri.AbsoluteUri
}
function New-LeaseRecord {
    param($Slot)
    $now = [DateTimeOffset]::UtcNow
    $token = [Guid]::NewGuid().ToString('N')
    [pscustomobject][ordered]@{
        schema_version = 3
        state = 'provisioning'
        owner_id = $OwnerId
        lease_token = $token
        port = [int]$Slot.port
        endpoint = [string]$Slot.endpoint
        profile_dir = [string]$Slot.profile_dir
        profile_directory = if ($Slot.profile_directory) { [string]$Slot.profile_directory } else { 'Default' }
        account_alias = [string]$Slot.account_alias
        workspace = [string]$Slot.workspace
        acquired_at_utc = $now.ToString('o')
        heartbeat_at_utc = $now.ToString('o')
        expires_at_utc = $now.AddSeconds($TtlSec).ToString('o')
        ttl_seconds = $TtlSec
        target_id = $null
        target_url = $null
        task_target_nonce = New-TaskTargetNonce
        control_state_dir = Join-Path (Get-PortLeaseDirectory -Port ([int]$Slot.port)) ("control-{0}" -f $token)
        browser_started_by_lease = $false
    }
}
function Update-LeaseHeartbeat {
    param($Lease)
    $now = [DateTimeOffset]::UtcNow
    $Lease.heartbeat_at_utc = $now.ToString('o')
    $Lease.expires_at_utc = $now.AddSeconds($TtlSec).ToString('o')
    $Lease.ttl_seconds = $TtlSec
    Write-Lease -Lease $Lease
    return $Lease
}
function Find-LeaseByToken {
    param([string]$Token)
    # A lease token is the complete capability for heartbeat/release. Do not
    # reapply the Acquire scope here: an account-routed slot must still be
    # releasable by token alone in a later process invocation.
    foreach ($path in Get-ChildItem -LiteralPath $StateRoot -Filter '*.lease.json' -File -Recurse -ErrorAction SilentlyContinue) {
        $lease = try { Convert-LeaseJson (Get-Content -LiteralPath $path.FullName -Raw -Encoding UTF8) } catch { throw 'Unreadable lease record; preserve ownership.' }
        if ($lease -and [string]$lease.lease_token -eq $Token) { return $lease }
    }
    return $null
}

function Get-IdentityReport {
    param($Slot)
    $issuerShell=(Get-Process -Id $PID -ErrorAction Stop).Path
    $raw = @(& $issuerShell -NoProfile -File $identityGuard -ExpectedBrowser chrome -Endpoint $Slot.endpoint -ExpectedProfileDir $Slot.profile_dir -AsJson 2>$null) -join "`n"
    $exitCode = $LASTEXITCODE
    $report = try { $raw | ConvertFrom-Json } catch { $null }
    [pscustomobject]@{ exit_code = $exitCode; report = $report; raw = $raw }
}
function Start-RegisteredSlot {
    param($Slot)
    if (-not $Slot.launcher -or -not (Test-Path -LiteralPath $Slot.launcher)) {
        throw "Registered launcher is missing for CDP Chrome $($Slot.port): $($Slot.launcher)"
    }
    if ($IsMacOS) {
        & /usr/bin/open -gj --env 'AICC_BACKGROUND_LAUNCH=1' $Slot.launcher
        if ($LASTEXITCODE -ne 0) { throw "Failed to open registered launcher in background: $($Slot.launcher)" }
    } elseif ($IsWindows) {
        Start-Process -FilePath $Slot.launcher -WindowStyle Hidden | Out-Null
    } else { throw 'Automatic registered-slot launch is supported only on macOS and Windows.' }
}
function Ensure-SlotReady {
    param($Slot)
    if ($NoBrowser) { return $false }
    $identity = Get-IdentityReport -Slot $Slot
    if ($identity.exit_code -eq 0 -and $identity.report.ok) { return $false }
    $reasons = @($identity.report.reasons)
    $unavailableOnly = $reasons.Count -gt 0 -and @($reasons | Where-Object { $_ -ne 'cdp_endpoint_unavailable' }).Count -eq 0
    if (-not $unavailableOnly) { throw "CDP Chrome $($Slot.port) identity mismatch; refusing fallback: $($identity.raw)" }
    if (-not $AllowBrowserStart) { throw "Registered CDP Chrome $($Slot.port) is offline; preserve existing sessions or explicitly authorize -AllowBrowserStart." }
    Start-RegisteredSlot -Slot $Slot
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 250
        $identity = Get-IdentityReport -Slot $Slot
        if ($identity.exit_code -eq 0 -and $identity.report.ok) { return $true }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Registered CDP Chrome $($Slot.port) did not pass identity verification after background launch: $($identity.raw)"
}
function Get-CdpTargets {
    param([string]$Endpoint, [switch]$Strict)
    if ($NoBrowser) { return @() }
    try {
        $response = Invoke-RestMethod -Uri ($Endpoint.TrimEnd('/') + '/json/list') -TimeoutSec 3
        foreach ($target in $response) { Write-Output $target }
    } catch { if ($Strict) { throw }; return @() }
}
function Invoke-CdpBrowserCommand {
    param([string]$Endpoint, [string]$Method, [hashtable]$Params = @{}, [string]$TargetWebSocket = '',
        [ValidateRange(1, 130)][int]$ResponseTimeoutSec = 5)
    $socketUrl = $TargetWebSocket
    if (-not $socketUrl) {
        $version = Invoke-RestMethod -Uri ($Endpoint.TrimEnd('/') + '/json/version') -TimeoutSec 3
        if (-not $version.webSocketDebuggerUrl) { throw "CDP browser websocket was not advertised by $Endpoint." }
        $socketUrl = [string]$version.webSocketDebuggerUrl
    }
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    try {
        $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(5))
        try { $null = $socket.ConnectAsync([Uri]$socketUrl, $cts.Token).GetAwaiter().GetResult() } finally { $cts.Dispose() }
        $id = [Security.Cryptography.RandomNumberGenerator]::GetInt32(1, [int]::MaxValue)
        $payload = [Text.Encoding]::UTF8.GetBytes((@{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 8))
        $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(5))
        try { $null = $socket.SendAsync([ArraySegment[byte]]::new($payload), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult() } finally { $cts.Dispose() }
        # One deadline for the complete reply, including interleaved events and fragments.
        # A slow identity GET must not inherit the short browser-control timeout.
        $responseDeadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($ResponseTimeoutSec))
        try { do {
            $stream = [IO.MemoryStream]::new()
            try {
                do {
                    $buffer = [byte[]]::new(16384)
                    $received = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $responseDeadline.Token).GetAwaiter().GetResult()
                    if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { throw "CDP websocket closed before replying to $Method." }
                    $stream.Write($buffer, 0, $received.Count)
                } while (-not $received.EndOfMessage)
                $message = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
            } finally { $stream.Dispose() }
        } while ([long]$message.id -ne $id)
        } finally { $responseDeadline.Dispose() }
        if ($message.error) { throw "CDP $Method failed: $($message.error | ConvertTo-Json -Compress)" }
        return $message.result
    } finally { $socket.Dispose() }
}
function New-OwnedTarget {
    param($Slot, [string]$TargetUrl)
    if ($NoBrowser) { return "synthetic-$([Guid]::NewGuid().ToString('N'))" }
    $target = Invoke-CdpBrowserCommand -Endpoint $Slot.endpoint -Method 'Target.createTarget' -Params @{ url = $TargetUrl; background = $true }
    if (-not $target.targetId) { throw "CDP Chrome $($Slot.port) did not return a target ID." }
    return [string]$target.targetId
}
function Write-ControlState {
    param($Lease)
    if ($NoBrowser -or -not $Lease.control_state_dir -or -not $Lease.target_id) { return }
    New-Item -ItemType Directory -Force -Path ([string]$Lease.control_state_dir) | Out-Null
    $state = [ordered]@{ port = [int]$Lease.port; activeTargetId = [string]$Lease.target_id; managed_by = 'AICC.CdpChromeTargetLease' }
    [IO.File]::WriteAllText((Join-Path ([string]$Lease.control_state_dir) 'browser-state.json'), ($state | ConvertTo-Json) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
function Close-OwnedTarget {
    param($Lease)
    if ($NoBrowser -or $KeepTarget -or -not $Lease -or -not $Lease.target_id -or [string]$Lease.mode -eq 'read-existing') { return $false }
    $targets = @(Get-CdpTargets -Endpoint ([string]$Lease.endpoint) -Strict)
    if (@($targets | Where-Object { [string]$_.id -eq [string]$Lease.target_id }).Count -eq 0) { return $true }
    try {
        $closeUri = ([string]$Lease.endpoint).TrimEnd('/') + "/json/close/$($Lease.target_id)"
        Invoke-RestMethod -Uri $closeUri -TimeoutSec 3 | Out-Null
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(8)
        $absentSince = $null
        $lastCloseAt = [DateTimeOffset]::UtcNow
        do {
            Start-Sleep -Milliseconds 200
            $remaining = @(Get-CdpTargets -Endpoint ([string]$Lease.endpoint) -Strict | Where-Object { [string]$_.id -eq [string]$Lease.target_id })
            if ($remaining.Count -eq 0) {
                if ($null -eq $absentSince) { $absentSince = [DateTimeOffset]::UtcNow }
                if ([DateTimeOffset]::UtcNow - $absentSince -ge [TimeSpan]::FromMilliseconds(1500)) { return $true }
            } else {
                $absentSince = $null
                if ([DateTimeOffset]::UtcNow - $lastCloseAt -ge [TimeSpan]::FromSeconds(1)) {
                    Invoke-RestMethod -Uri $closeUri -TimeoutSec 3 | Out-Null
                    $lastCloseAt = [DateTimeOffset]::UtcNow
                }
            }
        } while ([DateTimeOffset]::UtcNow -lt $deadline)
    } catch { }
    return $false
}
function Test-LeaseCleanupUnchanged($Current, $Expected) {
    if (-not $Current -or -not (Test-LeaseExpired $Current)) { return $false }
    foreach ($key in @('lease_token', 'owner_id', 'state', 'target_id', 'endpoint', 'profile_dir', 'heartbeat_at_utc', 'expires_at_utc')) {
        if ([string]$Current.$key -cne [string]$Expected.$key) { return $false }
    }
    return $true
}
function Test-ExpiredTargetCleanup($Slot, $Lease) {
    # Offline is not evidence of absence. A restarted browser must pass the same
    # registered profile guard before exact task-owned target reconciliation.
    if ($NoBrowser) { return $true }
    if (-not $Lease.target_id -or [string]$Lease.endpoint -cne [string]$Slot.endpoint -or
        [IO.Path]::GetFullPath([string]$Lease.profile_dir) -ine [IO.Path]::GetFullPath([string]$Slot.profile_dir)) { return $false }
    $identity = Get-IdentityReport -Slot $Slot
    if ($identity.exit_code -ne 0 -or -not $identity.report.ok) {
        $reasons = @($identity.report.reasons)
        $offline = $reasons.Count -gt 0 -and @($reasons | Where-Object { $_ -ne 'cdp_endpoint_unavailable' }).Count -eq 0
        if (-not $offline) { throw "CDP Chrome $($Slot.port) identity mismatch during cleanup; preserve lease: $($identity.raw)" }
        if (-not $AllowBrowserStart) { return $false }
        $null = Ensure-SlotReady -Slot $Slot
    }
    try { return (Close-OwnedTarget -Lease $Lease) } catch { return $false }
}
# Immutable proof events stay within the existing per-port lease control-plane.
function Get-ProofHash([byte[]]$Bytes) {
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-ProofTextHash([string]$Text) { Get-ProofHash ([Text.Encoding]::UTF8.GetBytes($Text)) }
function Stop-ReadProof([string]$Code) { throw [InvalidOperationException]::new($Code) }
function Assert-UnlinkedPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-ReadProof 'HOLD_PROOF_LINK' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Read-BoundedProofJson([string]$Path, [int]$Limit = 65536) {
    Assert-UnlinkedPath $Path
    $file = Get-Item -LiteralPath $Path -Force
    if ($file.PSIsContainer -or $file.Length -gt $Limit) { Stop-ReadProof 'HOLD_PROOF_SIZE' }
    $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -gt $Limit) { Stop-ReadProof 'HOLD_PROOF_SIZE' }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($count -eq 0) { Stop-ReadProof 'HOLD_PROOF_PARTIAL' }
            $offset += $count
        }
    } finally { $stream.Dispose() }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $document = [Text.Json.JsonDocument]::Parse($text)
    try {
        function Assert-ProofKeys($Element) {
            if ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
                $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
                foreach ($property in $Element.EnumerateObject()) {
                    if (-not $seen.Add($property.Name)) { Stop-ReadProof 'HOLD_PROOF_DUPLICATE_KEY' }
                    Assert-ProofKeys $property.Value
                }
            } elseif ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
                foreach ($item in $Element.EnumerateArray()) { Assert-ProofKeys $item }
            }
        }
        Assert-ProofKeys $document.RootElement
    } finally { $document.Dispose() }
    [pscustomobject]@{ bytes = $bytes; value = (Convert-LeaseJson $text); sha256 = (Get-ProofHash $bytes) }
}
function Get-TargetHistoryDirectory([int]$Port, [string]$Id) {
    if ($Id -cnotmatch '^[A-Fa-f0-9]{32}$') { Stop-ReadProof 'HOLD_TARGET_ID' }
    $dir = Join-Path (Get-PortLeaseDirectory $Port) ("target-{0}.history" -f $Id.ToUpperInvariant())
    Assert-UnlinkedPath $dir
    return $dir
}
function Write-TargetHistory([string]$Directory, [string]$Name, $Event) {
    Assert-UnlinkedPath $Directory
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    $path = Join-Path $Directory $Name
    if (Test-Path -LiteralPath $path) { Stop-ReadProof 'HOLD_HISTORY_ALREADY_EXISTS' }
    $payload = $Event | ConvertTo-Json -Depth 8 -Compress
    $digest = Get-ProofTextHash $payload
    $envelope = [ordered]@{ schema = 'cdp-target-history/v1'; payload_json = $payload; sha256 = $digest }
    $temp = Join-Path $Directory ("pending-{0}.tmp" -f [Guid]::NewGuid().ToString('N'))
    $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($envelope | ConvertTo-Json -Compress -Depth 4))
        $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
    } finally { $stream.Dispose() }
    # No overwrite, repair, deletion or retry on partial/racing writes.
    Move-Item -LiteralPath $temp -Destination $path -ErrorAction Stop
    return $digest
}
function Read-TargetHistory([string]$Directory, [string]$Name) {
    $path = Join-Path $Directory $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Stop-ReadProof 'HOLD_HISTORY_UNPROVEN' }
    $envelope = (Read-BoundedProofJson $path).value
    if ($envelope.schema -cne 'cdp-target-history/v1' -or $envelope.payload_json -isnot [string] -or
        $envelope.sha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-ProofTextHash $envelope.payload_json) -cne $envelope.sha256) {
        Stop-ReadProof 'HOLD_HISTORY_DAMAGED'
    }
    [pscustomobject]@{ event = (Convert-LeaseJson $envelope.payload_json); sha256 = $envelope.sha256 }
}
function Test-PortReadBarrier([int]$Port) {
    $portDir = Get-PortLeaseDirectory $Port
    Assert-UnlinkedPath $portDir
    if (-not (Test-Path -LiteralPath $portDir)) { return $false }
    $open = $false
    foreach ($dir in Get-ChildItem -LiteralPath $portDir -Directory -Filter 'target-*.history' -Force) {
        Assert-UnlinkedPath $dir.FullName
        $creation = Read-TargetHistory $dir.FullName 'creation.json'
        if ($creation.event.kind -cne 'created' -or (Get-TargetHistoryDirectory $Port $creation.event.target_id) -cne $dir.FullName) { Stop-ReadProof 'HOLD_HISTORY_DAMAGED' }
        foreach ($file in Get-ChildItem -LiteralPath $dir.FullName -Force) {
            if ($file.PSIsContainer -or $file.Name -cnotmatch '^(creation|release|closed)\.json$|^read-[a-f0-9]{32}\.(acquired|returned)\.json$') { Stop-ReadProof 'HOLD_HISTORY_PARTIAL' }
            $record = Read-TargetHistory $dir.FullName $file.Name
            if ($file.Name -match '^read-([a-f0-9]{32})\.acquired\.json$') {
                $readId = $Matches[1]
                if ($record.event.kind -cne 'read-acquired' -or $record.event.read_id -cne $readId -or
                    $record.event.creation_sha256 -cne $creation.sha256) { Stop-ReadProof 'HOLD_HISTORY_DAMAGED' }
                $returnedPath = Join-Path $dir.FullName "read-$readId.returned.json"
                if (-not (Test-Path -LiteralPath $returnedPath)) { $open = $true }
            } elseif ($file.Name -match '^read-([a-f0-9]{32})\.returned\.json$') {
                $acquired = Read-TargetHistory $dir.FullName "read-$($Matches[1]).acquired.json"
                if ($record.event.kind -cne 'read-returned' -or $record.event.acquired_sha256 -cne $acquired.sha256 -or
                    $record.event.target_preserved -ne $true) { Stop-ReadProof 'HOLD_HISTORY_DAMAGED' }
            } elseif ($file.Name -ceq 'release.json') {
                if ($record.event.kind -cne 'released' -or $record.event.creation_sha256 -cne $creation.sha256) { Stop-ReadProof 'HOLD_HISTORY_DAMAGED' }
            } elseif ($file.Name -ceq 'closed.json') {
                if ($record.event.kind -cne 'completed-target-closed' -or $record.event.creation_sha256 -cne $creation.sha256) { Stop-ReadProof 'HOLD_HISTORY_DAMAGED' }
            }
        }
    }
    return $open
}
function Get-RegistrationHash($Slot) {
    Get-ProofTextHash (([ordered]@{
        endpoint = $Slot.endpoint; port = $Slot.port; profile_dir = $Slot.profile_dir
        profile_directory = $Slot.profile_directory; account_alias = $Slot.account_alias
        workspace = $Slot.workspace; usage = $Slot.usage; exclusive = [bool]$Slot.exclusive
        coordination_sha256 = (Get-ProofHash ([IO.File]::ReadAllBytes($coordinationPath)))
    }) | ConvertTo-Json -Compress)
}
function Get-TargetIdentityProof($Slot, [string]$Id) {
    if ($NoBrowser) { Stop-ReadProof 'HOLD_REAL_IDENTITY_REQUIRED' }
    $registration = Get-RegistrationHash $Slot
    $guard = Get-IdentityReport $Slot
    if ($guard.exit_code -ne 0 -or -not $guard.report.ok) { Stop-ReadProof 'HOLD_REGISTERED_IDENTITY' }
    $targets = @(Get-CdpTargets -Endpoint $Slot.endpoint -Strict | Where-Object { [string]$_.id -ceq $Id -and $_.type -ceq 'page' })
    if ($targets.Count -ne 1) { Stop-ReadProof 'HOLD_TARGET_CLOSED_OR_UNPROVEN' }
    $url = [Uri]$targets[0].url
    $socketUri = [Uri]$targets[0].webSocketDebuggerUrl
    if ($url.Scheme -cne 'https' -or $url.Host -cne 'chatgpt.com' -or $url.UserInfo -or
        $socketUri.Scheme -cne 'ws' -or $socketUri.Host -cne '127.0.0.1' -or $socketUri.Port -ne $Slot.port -or
        $socketUri.AbsolutePath -cne "/devtools/page/$Id" -or $socketUri.Query -or $socketUri.Fragment -or $socketUri.UserInfo) {
        Stop-ReadProof 'HOLD_TARGET_ORIGIN'
    }
    # Existing registered adapter user-id/account-id projection, one identity
    # GET only. No conversation API, retries, navigation or page mutation.
    $expression = @"
(async () => {
 if (location.origin !== 'https://chatgpt.com') return null;
 try {
  const r = await fetch('/api/auth/session', {method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(60000)});
  if (!r.ok) return null;
  const s = await r.json();
  const hash = async v => typeof v === 'string' && v.trim() ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v.trim()))),b=>b.toString(16).padStart(2,'0')).join('') : null;
  return {identityHash:await hash(s?.user?.id ?? s?.user?.email), workspaceIdentityHash:await hash(s?.account?.id)};
 } catch { return null; }
})()
"@
    $reply = Invoke-CdpBrowserCommand -Endpoint $Slot.endpoint -TargetWebSocket $socketUri.AbsoluteUri -Method 'Runtime.evaluate' -ResponseTimeoutSec 90 -Params @{
        expression = $expression; returnByValue = $true; awaitPromise = $true
    }
    $identity = $reply.result.value
    if ($reply.exceptionDetails -or $identity.identityHash -cnotmatch '^[a-f0-9]{64}$' -or
        $identity.workspaceIdentityHash -cnotmatch '^[a-f0-9]{64}$') { Stop-ReadProof 'HOLD_ACCOUNT_WORKSPACE_UNPROVEN' }
    $guard = Get-IdentityReport $Slot
    if ($guard.exit_code -ne 0 -or -not $guard.report.ok -or (Get-RegistrationHash $Slot) -cne $registration) { Stop-ReadProof 'HOLD_REGISTRATION_CHANGED' }
    [pscustomobject]@{ identityHash = $identity.identityHash; workspaceIdentityHash = $identity.workspaceIdentityHash; registration_sha256 = $registration }
}
function Get-OriginalReceiptBinding($Lease) {
    if ($OriginalReceiptSha256 -cnotmatch '^[a-f0-9]{64}$' -or $PromptSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        -not [IO.Path]::IsPathFullyQualified($OriginalReceipt)) { Stop-ReadProof 'HOLD_ORIGINAL_PROOF_ARGUMENTS' }
    $file = [IO.Path]::GetFullPath($OriginalReceipt)
    $homeBoundary = [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $file.StartsWith($homeBoundary, [StringComparison]::OrdinalIgnoreCase) -or $file.Substring($homeBoundary.Length).Contains(':')) { Stop-ReadProof 'HOLD_ORIGINAL_PROOF_PATH' }
    $read = Read-BoundedProofJson $file 8388608
    if ($read.sha256 -cne $OriginalReceiptSha256) { Stop-ReadProof 'HOLD_ORIGINAL_RECEIPT_CHANGED' }
    $r = $read.value
    if ($r.schemaVersion -ne 1 -or $r.executor -cne 'registered_cdp' -or $r.submissions -ne 1 -or
        $r.cadence.committed -ne $true -or $r.retryable -ne $false -or $r.recovery.automaticRetry -ne $false -or
        $r.recovery.ownerId -cne $Lease.owner_id -or $r.recovery.targetId -cne $Lease.target_id -or
        $r.recovery.endpoint -cne $Lease.endpoint -or $r.recovery.promptSha256 -cne $PromptSha256 -or
        $r.accountAlias -cne $Lease.account_alias -or $r.workspaceAlias -cne $Lease.workspace -or
        $r.surface.selectedPort -ne $Lease.port -or $r.surface.targetOwnership -cne 'task-created' -or
        $r.surface.targetIdHash -cne (Get-ProofTextHash ("registered-review-target" + [char]0 + $Lease.target_id)) -or
        $r.turns.user -ne 1) { Stop-ReadProof 'HOLD_ORIGINAL_PROOF_UNPROVEN' }
    if ($r.attachments -ne 0) { Stop-ReadProof 'HOLD_ATTACHMENT_CONTENT_HASH_UNPROVEN' }
    [pscustomobject]@{ receiptSha256 = $read.sha256; promptSha256 = $PromptSha256; attachmentSha256 = @() }
}
# Validate the private original queue request against the actual task lease.
# A caller's SHA or boolean never becomes release authority by itself.
function Get-QueueOriginalRequestBinding($Lease) {
    if (-not $KeepTarget -and $Action -eq 'Release') { Stop-ReadProof 'HOLD_QUEUE_KEEP_TARGET_REQUIRED' }
    if (-not $QueueOwnerRequestFile -or -not [IO.Path]::IsPathFullyQualified($QueueOwnerRequestFile) -or
        $OriginalRequestSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $ConversationId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') {
        Stop-ReadProof 'HOLD_QUEUE_RETENTION_PRIVATE_REQUEST_REQUIRED'
    }
    $file=[IO.Path]::GetFullPath($QueueOwnerRequestFile)
    $ownerHome=[IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $file.StartsWith($ownerHome,[StringComparison]::OrdinalIgnoreCase) -or
        $file.Substring($ownerHome.Length).Contains(':')) { Stop-ReadProof 'HOLD_QUEUE_RETENTION_PRIVATE_REQUEST_BOUNDARY' }
    $sealed=Read-BoundedProofJson $file 65536
    if ($sealed.sha256 -cne $OriginalRequestSha256) { Stop-ReadProof 'HOLD_QUEUE_RETENTION_REQUEST_SHA_CHANGED' }
    $v=$sealed.value
    if ($v.schemaVersion -ne 1 -or $v.kind -cne 'aicc-gpt-queue-original-owner-request' -or
        $v.ownerId -cne $Lease.owner_id -or $v.ownerIdentityHash -cnotmatch '^[a-f0-9]{64}$' -or
        $v.bindingId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$' -or
        $v.operationId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$' -or
        @($v.roles).Count -ne 2) { Stop-ReadProof 'HOLD_QUEUE_RETENTION_REQUEST_IDENTITY' }
    $matching=@($v.roles|Where-Object {
        $_.slot -ceq [string]$Lease.port -and $_.targetId -cne $null -and
        $_.targetId -ceq $Lease.target_id -and $_.leaseToken -ceq $Lease.lease_token -and
        $_.targetNonce -ceq $Lease.task_target_nonce -and
        $_.conversationId -ceq $ConversationId -and
        $_.accountAlias -ceq $Lease.account_alias -and $_.browserWorkspace -ceq $Lease.workspace
    })
    if ($matching.Count -ne 1 -or @($v.roles|Where-Object {
        $_.slot -ceq [string]$Lease.port
    }).Count -ne 1) { Stop-ReadProof 'HOLD_QUEUE_RETENTION_ORIGINAL_LEASE_MISMATCH' }
    return [ordered]@{
        kind='aicc-queue-original-request-retained/v1'
        originalRequestSha256=$sealed.sha256; bindingId=$v.bindingId; operationId=$v.operationId
        ownerIdentityHash=$v.ownerIdentityHash; conversationId=$ConversationId
        originalLeaseSha256=(Get-ProofTextHash $Lease.lease_token)
        taskTargetNonceSha256=(Get-ProofTextHash $Lease.task_target_nonce)
    }
}
function Assert-QueueOriginalTargetUrl($Slot,[string]$Id,[string]$Conversation,[string]$Nonce){
    $targets=@(Get-CdpTargets -Endpoint $Slot.endpoint -Strict|Where-Object {
        [string]$_.id -ceq $Id -and [string]$_.type -ceq 'page'
    })
    if($targets.Count -ne 1){Stop-ReadProof 'HOLD_QUEUE_TARGET_CHANGED'}
    $parsed=$null
    if(-not [Uri]::TryCreate([string]$targets[0].url,[UriKind]::Absolute,[ref]$parsed) -or
        $parsed.Scheme -cne 'https' -or $parsed.Host -cne 'chatgpt.com' -or
        $parsed.UserInfo -or $parsed.AbsolutePath -cne "/c/$Conversation"){
        Stop-ReadProof 'HOLD_QUEUE_SAVED_CONVERSATION_UNPROVEN'
    }
    $nonces=@([regex]::Matches($parsed.Query,'(?:^\?|&)aicc_task_target=([a-f0-9]{64})(?=&|$)'))
    if($nonces.Count -ne 1 -or $nonces[0].Groups[1].Value -cne $Nonce){
        Stop-ReadProof 'HOLD_QUEUE_LIVE_NONCE_UNPROVEN'
    }
}
function Write-CreationHistory($Slot, $Lease, $Identity) {
    if ($NoBrowser) { return }
    $dir = Get-TargetHistoryDirectory $Lease.port $Lease.target_id
    $event = [ordered]@{
        kind = 'created'; recorded_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
        owner_id = $Lease.owner_id; endpoint = $Lease.endpoint; port = $Lease.port; target_id = $Lease.target_id
        account_alias = $Lease.account_alias; workspace = $Lease.workspace
        registration_sha256 = (Get-RegistrationHash $Slot)
        write_lease_sha256 = (Get-ProofTextHash $Lease.lease_token)
        task_target_nonce_sha256 = (Get-ProofTextHash $Lease.task_target_nonce)
        identityHash = $Identity.identityHash; workspaceIdentityHash = $Identity.workspaceIdentityHash
        identity_verified = ($null -ne $Identity)
    }
    if ($Identity -and $Identity.registration_sha256 -cne $event.registration_sha256) { Stop-ReadProof 'HOLD_REGISTRATION_CHANGED' }
    $null = Write-TargetHistory $dir 'creation.json' $event
}
function Write-KeepTargetHistory($Lease) {
    if ($NoBrowser -or [string]$Lease.target_id -cnotmatch '^[A-Fa-f0-9]{32}$') { return }
    $dir = Get-TargetHistoryDirectory $Lease.port $Lease.target_id
    if (-not (Test-Path -LiteralPath $dir)) {
        if ($OriginalReceipt -or $OriginalReceiptSha256 -or $PromptSha256) { Stop-ReadProof 'HOLD_HISTORY_UNPROVEN' }
        return
    }
    $creation = Read-TargetHistory $dir 'creation.json'
    $c = $creation.event
    if ($c.kind -cne 'created' -or $c.owner_id -cne $Lease.owner_id -or $c.target_id -cne $Lease.target_id -or
        $c.endpoint -cne $Lease.endpoint -or $c.write_lease_sha256 -cne (Get-ProofTextHash $Lease.lease_token)) { Stop-ReadProof 'HOLD_HISTORY_UNPROVEN' }
    $binding = $null; $identity = $null
    if ($QueueOwnerRequestFile -and ($OriginalReceipt -or $OriginalReceiptSha256 -or $PromptSha256)) {
        Stop-ReadProof 'HOLD_QUEUE_RETENTION_MIXED_WITH_POST_DISPATCH'
    }
    if ($OriginalReceipt -or $OriginalReceiptSha256 -or $PromptSha256) {
        if ($c.identity_verified -ne $true -or (Test-LeaseExpired $Lease)) { Stop-ReadProof 'HOLD_CREATION_IDENTITY_UNPROVEN' }
        $slot = @($slots | Where-Object { $_.port -eq $Lease.port -and $_.account_alias -ceq $Lease.account_alias -and $_.workspace -ceq $Lease.workspace })
        if ($slot.Count -ne 1 -or (Get-RegistrationHash $slot[0]) -cne $c.registration_sha256) { Stop-ReadProof 'HOLD_REGISTRATION_CHANGED' }
        $binding = Get-OriginalReceiptBinding $Lease
        $identity = Get-TargetIdentityProof $slot[0] $Lease.target_id
        if ($identity.identityHash -cne $c.identityHash -or $identity.workspaceIdentityHash -cne $c.workspaceIdentityHash) { Stop-ReadProof 'HOLD_IDENTITY_CHANGED' }
    } elseif ($QueueOwnerRequestFile) {
        if ($c.identity_verified -ne $true -or (Test-LeaseExpired $Lease)) { Stop-ReadProof 'HOLD_QUEUE_RETENTION_CREATION_UNVERIFIED' }
        $slot=@($slots|Where-Object { $_.port -eq $Lease.port -and
            $_.account_alias -ceq $Lease.account_alias -and $_.workspace -ceq $Lease.workspace })
        if($slot.Count -ne 1 -or (Get-RegistrationHash $slot[0]) -cne $c.registration_sha256){
            Stop-ReadProof 'HOLD_QUEUE_RETENTION_REGISTRATION_CHANGED'
        }
        $binding=Get-QueueOriginalRequestBinding $Lease
        $identity=Get-TargetIdentityProof $slot[0] $Lease.target_id
        if ($identity.identityHash -cne $c.identityHash -or
            $identity.workspaceIdentityHash -cne $c.workspaceIdentityHash){
            Stop-ReadProof 'HOLD_QUEUE_RETENTION_IDENTITY_CHANGED'
        }
        Assert-QueueOriginalTargetUrl $slot[0] $Lease.target_id $binding.conversationId $Lease.task_target_nonce
    }
    $event = [ordered]@{
        kind = 'released'; recorded_at_utc = [DateTimeOffset]::UtcNow.ToString('o'); keep_target = $true
        creation_sha256 = $creation.sha256; owner_id = $Lease.owner_id; target_id = $Lease.target_id
        endpoint = $Lease.endpoint; write_lease_sha256 = (Get-ProofTextHash $Lease.lease_token)
        binding = $binding; identityHash = $identity.identityHash; workspaceIdentityHash = $identity.workspaceIdentityHash
    }
    $null = Write-TargetHistory $dir 'release.json' $event
}
function Assert-ReadLeaseCurrent($Lease) {
    if ([string]$Lease.mode -cne 'read-existing' -or $Lease.read_only -ne $true -or
        @((Read-PortLeases $Lease.port)).Count -ne 1) { Stop-ReadProof 'HOLD_READ_LEASE_CONFLICT' }
    $dir = Get-TargetHistoryDirectory $Lease.port $Lease.target_id
    $acquired = Read-TargetHistory $dir "read-$($Lease.read_id).acquired.json"
    if ($acquired.sha256 -cne $Lease.read_acquired_sha256 -or
        $acquired.event.read_lease_sha256 -cne (Get-ProofTextHash $Lease.lease_token) -or
        $acquired.event.owner_id -cne $Lease.owner_id -or $acquired.event.target_id -cne $Lease.target_id -or
        (Test-Path -LiteralPath (Join-Path $dir "read-$($Lease.read_id).returned.json"))) { Stop-ReadProof 'HOLD_READ_LEASE_CONFLICT' }
    $null = Test-PortReadBarrier $Lease.port
}
function Invoke-ExistingTargetRead {
    if ($NoBrowser -or $AllowBrowserStart -or -not $ExclusiveSlot -or $PreferredPort -or
        -not $AccountAlias -or -not $Workspace -or $normalizedSlotPorts.Count -ne 1 -or
        $slots.Count -ne 1 -or $TargetId -cnotmatch '^[A-Fa-f0-9]{32}$') { Stop-ReadProof 'HOLD_READ_ARGUMENTS' }
    if ($StateRoot -ine [IO.Path]::GetFullPath((Get-DefaultStateRoot))) { Stop-ReadProof 'HOLD_READ_AUTHORITY_ROOT' }
    $slot = $slots[0]
    $dir = Get-TargetHistoryDirectory $slot.port $TargetId
    Enter-LeaseMutex
    try {
        if (@((Read-PortLeases $slot.port)).Count -ne 0 -or (Test-PortReadBarrier $slot.port)) { Stop-ReadProof 'HOLD_SLOT_LEASE_PRESENT' }
        $creation = Read-TargetHistory $dir 'creation.json'
        if (Test-Path -LiteralPath (Join-Path $dir 'closed.json')) { Stop-ReadProof 'HOLD_TARGET_ALREADY_CLOSED' }
        $release = Read-TargetHistory $dir 'release.json'
        $c = $creation.event; $r = $release.event
        if ($c.kind -cne 'created' -or $r.kind -cne 'released' -or $r.keep_target -ne $true -or
            $c.owner_id -cne $OwnerId -or $r.owner_id -cne $OwnerId -or $c.target_id -cne $TargetId -or
            $r.target_id -cne $TargetId -or $c.port -ne $slot.port -or $c.endpoint -cne $slot.endpoint -or
            $r.endpoint -cne $slot.endpoint -or $c.account_alias -cne $AccountAlias -or $c.workspace -cne $Workspace -or
            $r.creation_sha256 -cne $creation.sha256 -or $r.write_lease_sha256 -cne $c.write_lease_sha256 -or
            $c.identity_verified -ne $true -or $c.registration_sha256 -cne (Get-RegistrationHash $slot)) { Stop-ReadProof 'HOLD_HISTORY_UNPROVEN' }
        $original = Get-OriginalReceiptBinding ([pscustomobject]@{
            owner_id=$OwnerId; target_id=$TargetId; port=$slot.port; endpoint=$slot.endpoint; account_alias=$AccountAlias; workspace=$Workspace
        })
        if ($r.binding.receiptSha256 -cne $original.receiptSha256 -or $r.binding.promptSha256 -cne $original.promptSha256 -or
            @($r.binding.attachmentSha256).Count -ne 0) { Stop-ReadProof 'HOLD_ORIGINAL_BINDING_UNPROVEN' }
        $identity = Get-TargetIdentityProof $slot $TargetId
        if ($identity.identityHash -cne $c.identityHash -or $identity.identityHash -cne $r.identityHash -or
            $identity.workspaceIdentityHash -cne $c.workspaceIdentityHash -or $identity.workspaceIdentityHash -cne $r.workspaceIdentityHash) { Stop-ReadProof 'HOLD_IDENTITY_CHANGED' }
        $lease = New-LeaseRecord $slot
        $lease.target_id = $TargetId; $lease.target_url = $null; $lease.task_target_nonce = $null; $lease.control_state_dir = $null
        $lease.state = 'ready'
        $readId = [Guid]::NewGuid().ToString('N')
        $event = [ordered]@{
            kind='read-acquired'; read_id=$readId; recorded_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
            owner_id=$OwnerId; target_id=$TargetId; endpoint=$slot.endpoint
            read_lease_sha256=(Get-ProofTextHash $lease.lease_token); creation_sha256=$creation.sha256
            release_sha256=$release.sha256; receipt_sha256=$original.receiptSha256; prompt_sha256=$original.promptSha256
        }
        $acquiredHash = Write-TargetHistory $dir "read-$readId.acquired.json" $event
        $lease | Add-Member -NotePropertyMembers @{ mode='read-existing'; read_only=$true; read_id=$readId; read_acquired_sha256=$acquiredHash }
        Write-Lease $lease
        $proof = [ordered]@{
            schema='released-task-target-read/v1'; receiptSha256=$original.receiptSha256; promptSha256=$original.promptSha256
            ownerId=$OwnerId; targetId=$TargetId; endpoint=$slot.endpoint; identityHash=$identity.identityHash
            workspaceIdentityHash=$identity.workspaceIdentityHash; attachmentSha256=@()
            targetCreatedByOriginalLease=$true; releasedWithKeepTarget=$true; exclusiveReadLease=$true
            creationReceiptSha256=$creation.sha256; releaseReceiptSha256=$release.sha256
        }
    } finally { Exit-LeaseMutex }
    return [pscustomobject]@{ ok=$true; status='read_acquired'; lease=$lease; proof=$proof }
}
function Write-Result {
    param($Result, [int]$ExitCode = 0)
    if ($AsJson) { $Result | ConvertTo-Json -Compress -Depth 8 } else { $Result | ConvertTo-Json -Depth 8 }
    $mutex.Dispose()
    exit $ExitCode
}

# Completion cleanup is a separate mutation. ReadExisting remains read-only.
# The archived exact response is required even when its old persistence API was
# unavailable; that historical HOLD is never rewritten into API success.
function Get-CompletedTargetArchive($Lease) {
    if (-not [IO.Path]::IsPathFullyQualified($CompletionReceipt) -or $CompletionReceiptSha256 -cnotmatch '^[a-f0-9]{64}$') { Stop-ReadProof 'HOLD_COMPLETION_ARGUMENTS' }
    $boundary = [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $file = [IO.Path]::GetFullPath($CompletionReceipt)
    if (-not $file.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase) -or $file.Substring($boundary.Length).Contains(':')) { Stop-ReadProof 'HOLD_COMPLETION_PATH' }
    $archive = Read-BoundedProofJson $file 8388608
    $r = $archive.value
    $dir = Get-TargetHistoryDirectory $Lease.port $Lease.target_id
    $acquired = Read-TargetHistory $dir "read-$($Lease.read_id).acquired.json"
    if ($archive.sha256 -cne $CompletionReceiptSha256 -or $r.schemaVersion -ne 1 -or $r.action -cne 'read-existing' -or
        $r.executor -cne 'registered_cdp' -or $r.submissions -ne 0 -or $r.readLease.returned -ne $true -or
        $r.readLease.acquired -ne $true -or $r.reconciliation.proof -cne 'exact_target_dom' -or
        $r.reconciliation.domComplete -ne $true -or $r.turns.user -ne 1 -or $r.turns.assistant -ne 1 -or
        $r.original.receiptSha256 -cne $acquired.event.receipt_sha256 -or
        $r.original.promptSha256 -cne $acquired.event.prompt_sha256 -or
        $r.reconciliation.promptSha256 -cne $acquired.event.prompt_sha256 -or
        $r.accountAlias -cne $Lease.account_alias -or $r.workspaceAlias -cne $Lease.workspace -or
        $r.original.targetIdHash -cne (Get-ProofTextHash ("registered-review-target" + [char]0 + $Lease.target_id)) -or
        $r.body.kind -cne 'dom_original_assistant' -or -not $r.body.value -or
        $r.reconciliation.userTurnId -cnotmatch '^[a-f0-9-]{36}$' -or $r.reconciliation.assistantTurnId -cnotmatch '^[a-f0-9-]{36}$' -or
        $r.conversationUrl -cnotmatch '^https://chatgpt\.com/c/[a-f0-9-]{36}$') { Stop-ReadProof 'HOLD_COMPLETION_UNPROVEN' }
    return $archive
}
function Assert-CompletedTargetLive($Slot,$Lease,$Archive) {
    $identity = Get-TargetIdentityProof $Slot $Lease.target_id
    $creation = Read-TargetHistory (Get-TargetHistoryDirectory $Lease.port $Lease.target_id) 'creation.json'
    if ($identity.identityHash -cne $creation.event.identityHash -or $identity.workspaceIdentityHash -cne $creation.event.workspaceIdentityHash) { Stop-ReadProof 'HOLD_IDENTITY_CHANGED' }
    $expected = $Archive.value
    # Only visible modern turn roots with unambiguous exact message IDs qualify.
    # A changed conversation, extra turn, draft, attachment, or generation keeps it.
    $expression = @'
(() => {
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
 const roots=[...document.querySelectorAll('[data-chatgpt-search-unit-key]')].filter(visible);
 const users=roots.filter(e=>e.getAttribute('data-chatgpt-search-unit-key').endsWith(':user'));
 const answers=roots.filter(e=>e.getAttribute('data-chatgpt-search-unit-key').endsWith(':assistant'));
 const stop=[...document.querySelectorAll('[data-testid="stop-button"],button[aria-label="응답 중지"],button[aria-label="생성 중지"],button[aria-label="중지"],button[aria-label="Stop generating"],button[aria-label="Stop response"]')].some(visible);
 const draft=[...document.querySelectorAll('#prompt-textarea,[contenteditable="true"][role="textbox"],textarea')].filter(visible).some(e=>(e.value||e.innerText||'').trim());
 const attachments=[...document.querySelectorAll('[data-testid="composer-file-preview"],[data-testid*="attachment-pill"],[data-testid*="file-preview"]')].some(visible);
 if(users.length!==1||answers.length!==1||stop||draft||attachments)return null;
 const a=answers[0],u=users[0],ids=e=>[...new Set((e.getAttribute('data-chatgpt-search-message-ids')||'').trim().split(/\s+/).filter(Boolean))];
 let scope=a;for(let n=0;n<4&&scope.parentElement;n++){const p=scope.parentElement;if(p.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"]').length!==1)break;scope=p;if(scope.hasAttribute('data-talvt-turn-state'))break}
 const done=[...scope.querySelectorAll('button[data-testid="copy-turn-action-button"],button[aria-label="복사"],button[aria-label="Copy"]')].some(e=>visible(e)&&!e.closest('pre,.markdown,[data-markdown-text-style="assistant-message"]'));
 const state=a.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state');
 if(!done||(state&&state!=='complete')||a.querySelector('[data-streaming-response-status="streaming"],[data-streaming-response-status="in_progress"]'))return null;
 const bodies=[...a.querySelectorAll('.markdown,[data-markdown-text-style="assistant-message"]')].filter(e=>visible(e)&&!e.closest('[data-streaming-response-status]'));
 return {href:location.href,userIds:ids(u),assistantIds:ids(a),body:bodies.filter(e=>!bodies.some(p=>p!==e&&p.contains(e))).map(e=>e.innerText.replace(/\r\n?/g,'\n').trim()).filter(Boolean).join('\n\n')};
})()
'@
    $targets = @(Get-CdpTargets -Endpoint $Slot.endpoint -Strict | Where-Object id -CEQ $Lease.target_id)
    if ($targets.Count -ne 1) { Stop-ReadProof 'HOLD_TARGET_CLOSED_OR_UNPROVEN' }
    $reply = Invoke-CdpBrowserCommand -Endpoint $Slot.endpoint -TargetWebSocket $targets[0].webSocketDebuggerUrl -Method 'Runtime.evaluate' -Params @{expression=$expression;returnByValue=$true}
    $live = $reply.result.value
    if (-not $live -or $reply.exceptionDetails -or $live.href -cne $expected.conversationUrl -or
        @($live.userIds).Count -ne 1 -or @($live.assistantIds).Count -ne 1 -or
        $live.userIds[0] -cne $expected.reconciliation.userTurnId -or $live.assistantIds[0] -cne $expected.reconciliation.assistantTurnId -or
        (Get-ProofTextHash $live.body) -cne (Get-ProofTextHash $expected.body.value)) { Stop-ReadProof 'HOLD_COMPLETION_CHANGED_OR_ACTIVE' }
}
if ($Action -eq 'CloseCompleted') {
    try {
        if ($NoBrowser -or $KeepTarget -or -not $LeaseToken) { Stop-ReadProof 'HOLD_COMPLETION_ARGUMENTS' }
        Enter-LeaseMutex
        try {
            $matched = Find-LeaseByToken $LeaseToken
            Assert-ReadLeaseCurrent $matched
            if ($matched.state -cne 'ready' -or (Test-LeaseExpired $matched)) { Stop-ReadProof 'HOLD_READ_LEASE_NOT_RENEWABLE' }
            $archive = Get-CompletedTargetArchive $matched
            $slot = @($slots | Where-Object { $_.port -eq $matched.port -and $_.account_alias -ceq $matched.account_alias -and $_.workspace -ceq $matched.workspace })
            if ($slot.Count -ne 1) { Stop-ReadProof 'HOLD_REGISTERED_IDENTITY' }
            Assert-CompletedTargetLive $slot[0] $matched $archive
            $closeLease = $matched.PSObject.Copy(); $closeLease.mode = 'completed-cleanup'
            if (-not (Close-OwnedTarget $closeLease)) { Stop-ReadProof 'HOLD_TARGET_CLOSE_UNPROVEN' }
            $dir = Get-TargetHistoryDirectory $matched.port $matched.target_id
            $creation = Read-TargetHistory $dir 'creation.json'
            $null = Write-TargetHistory $dir 'closed.json' ([ordered]@{kind='completed-target-closed';creation_sha256=$creation.sha256;completion_receipt_sha256=$archive.sha256;recorded_at_utc=[DateTimeOffset]::UtcNow.ToString('o')})
        } finally { Exit-LeaseMutex }
        Write-Result ([pscustomobject]@{ok=$true;status='completed_target_closed';target_id=$matched.target_id;target_closed=$true;read_lease_requires_release=$true})
    } catch {
        $code = if ($_.Exception.Message -cmatch '^HOLD_[A-Z0-9_]+$') { $_.Exception.Message } else { 'HOLD_COMPLETION_OR_STORAGE_UNPROVEN' }
        Write-Result ([pscustomobject]@{ok=$false;status='HOLD';holdCode=$code;retryable=$false;target_closed_unproven=$true}) 4
    }
}

# Strictly read-only owner issuer inspection; no acquired lease or browser startup.
# It observes one exact owned target and never authorizes dispatch or handoff.
if ($Action -eq 'QueueOwnerInspect') {
    try {
        if ($NoBrowser -or $AllowBrowserStart -or $KeepTarget -or $RecordReadHistory -or
            $OriginalReceipt -or $OriginalReceiptSha256 -or $CompletionReceipt -or $CompletionReceiptSha256 -or
            -not $PSBoundParameters.ContainsKey('OwnerId') -or -not $PSBoundParameters.ContainsKey('LeaseToken') -or
            -not $PSBoundParameters.ContainsKey('TargetId') -or $explicitCoordination -or
            $StateRoot -ine [IO.Path]::GetFullPath((Get-DefaultStateRoot)) -or
            $normalizedSlotPorts.Count -ne 1 -or $slots.Count -ne 1 -or
            -not $OwnerId -or -not $AccountAlias -or -not $Workspace -or
            $LeaseToken -cnotmatch '^[a-f0-9]{32}$' -or $TargetId -cnotmatch '^[A-Fa-f0-9]{32}$' -or
            $ConversationId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or
            $OriginalRequestSha256 -cnotmatch '^[a-f0-9]{64}$') { Stop-ReadProof 'HOLD_QUEUE_OWNER_INSPECT_ARGUMENTS' }
        $slot = $slots[0]
        $proof = $null
        Enter-LeaseMutex
        try {
            $lease = Find-LeaseByToken $LeaseToken
            $retained=$null
            if (-not $lease) {
                # A released queue target may outlive its original action lease,
                # but ONLY a sealed creation + queue-bound KeepTarget release
                # can replace that live lease. Ordinary release, expiry, closed
                # targets and historical creation-only evidence stay HOLD.
                if (-not $QueueOwnerRequestFile) { Stop-ReadProof 'HOLD_QUEUE_ORIGINAL_ACTIVE_LEASE_UNPROVEN' }
                $dir=Get-TargetHistoryDirectory $slot.port $TargetId
                if(-not (Test-Path -LiteralPath (Join-Path $dir 'release.json')) -or
                   (Test-Path -LiteralPath (Join-Path $dir 'closed.json'))) {
                    Stop-ReadProof 'HOLD_QUEUE_RETAINED_RELEASE_UNPROVEN'
                }
                $creation=Read-TargetHistory $dir 'creation.json'
                $released=Read-TargetHistory $dir 'release.json'
                $c=$creation.event;$r=$released.event
                if (-not [IO.Path]::IsPathFullyQualified($QueueOwnerRequestFile)) {
                    Stop-ReadProof 'HOLD_QUEUE_RETENTION_PRIVATE_REQUEST_REQUIRED'
                }
                $queuePrivateFile=[IO.Path]::GetFullPath($QueueOwnerRequestFile)
                $ownerHome=[IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
                if (-not $queuePrivateFile.StartsWith($ownerHome,[StringComparison]::OrdinalIgnoreCase) -or
                    $queuePrivateFile.Substring($ownerHome.Length).Contains(':')) {
                    Stop-ReadProof 'HOLD_QUEUE_RETENTION_PRIVATE_REQUEST_BOUNDARY'
                }
                $original=(Read-BoundedProofJson $queuePrivateFile 65536)
                if($original.sha256 -cne $OriginalRequestSha256 -or
                   @($original.value.roles).Count -ne 2){
                    Stop-ReadProof 'HOLD_QUEUE_RETAINED_REQUEST_UNPROVEN'
                }
                $roles=@($original.value.roles|Where-Object {
                    $_.slot -ceq [string]$slot.port -and
                    $_.targetId -ceq $TargetId -and $_.leaseToken -ceq $LeaseToken -and
                    $_.conversationId -ceq $ConversationId
                })
                if($roles.Count -ne 1){Stop-ReadProof 'HOLD_QUEUE_RETAINED_ROLE_UNPROVEN'}
                $lease=[pscustomobject]@{
                    owner_id=$OwnerId; port=$slot.port; endpoint=$slot.endpoint
                    target_id=$TargetId; lease_token=$LeaseToken
                    task_target_nonce=$roles[0].targetNonce
                    account_alias=$AccountAlias; workspace=$Workspace
                }
                $bound=Get-QueueOriginalRequestBinding $lease
                if($c.kind -cne 'created' -or $c.identity_verified -ne $true -or
                   $c.owner_id -cne $OwnerId -or $c.port -ne $slot.port -or
                   $c.endpoint -cne $slot.endpoint -or $c.target_id -cne $TargetId -or
                   $c.account_alias -cne $AccountAlias -or $c.workspace -cne $Workspace -or
                   $c.write_lease_sha256 -cne (Get-ProofTextHash $LeaseToken) -or
                   $c.task_target_nonce_sha256 -cne (Get-ProofTextHash $lease.task_target_nonce) -or
                   $c.registration_sha256 -cne (Get-RegistrationHash $slot) -or
                   $r.kind -cne 'released' -or $r.keep_target -ne $true -or
                   $r.creation_sha256 -cne $creation.sha256 -or
                   $r.owner_id -cne $OwnerId -or $r.target_id -cne $TargetId -or
                   $r.endpoint -cne $slot.endpoint -or
                   $r.write_lease_sha256 -cne $c.write_lease_sha256 -or
                   $r.identityHash -cne $c.identityHash -or
                   $r.workspaceIdentityHash -cne $c.workspaceIdentityHash -or
                   $r.binding.kind -cne 'aicc-queue-original-request-retained/v1'){
                    Stop-ReadProof 'HOLD_QUEUE_RETAINED_CHAIN_UNPROVEN'
                }
                foreach($key in $bound.Keys){
                    if($r.binding.PSObject.Properties[$key].Value -cne $bound[$key]){
                        Stop-ReadProof 'HOLD_QUEUE_RETAINED_CHAIN_UNPROVEN'
                    }
                }
                if(@(Read-PortLeases $slot.port|Where-Object {
                    $_.target_id -ceq $TargetId
                }).Count -ne 0){Stop-ReadProof 'HOLD_QUEUE_RETAINED_LEASE_CONFLICT'}
                $retained=[ordered]@{
                    kind='aicc-queue-keep-target-release-history/v1'
                    creationSha256=$creation.sha256; releaseSha256=$released.sha256
                }
            } else {
                if ($lease.schema_version -ne 3 -or $lease.mode -eq 'read-existing' -or
                    $lease.state -cne 'ready' -or (Test-LeaseExpired $lease) -or
                    $lease.owner_id -cne $OwnerId -or $lease.target_id -cne $TargetId -or
                    $lease.port -ne $slot.port -or $lease.endpoint -cne $slot.endpoint -or
                    $lease.account_alias -cne $AccountAlias -or $lease.workspace -cne $Workspace -or
                    $lease.task_target_nonce -cnotmatch '^[a-f0-9]{64}$') {
                    Stop-ReadProof 'HOLD_QUEUE_ORIGINAL_ACTIVE_LEASE_UNPROVEN'
                }
                $leaseFile=Get-LeasePath -Port $slot.port -Token $LeaseToken
                Assert-UnlinkedPath $leaseFile
                $record=(Read-BoundedProofJson $leaseFile).value
                if($record.owner_id -cne $OwnerId -or $record.target_id -cne $TargetId -or
                   $record.lease_token -cne $LeaseToken -or
                   $record.task_target_nonce -cne $lease.task_target_nonce){
                    Stop-ReadProof 'HOLD_QUEUE_ORIGINAL_ACTIVE_LEASE_CHANGED'
                }
            }
            $identity = Get-TargetIdentityProof $slot $TargetId
            if($retained -and ($identity.identityHash -cne $c.identityHash -or
                $identity.workspaceIdentityHash -cne $c.workspaceIdentityHash -or
                $identity.registration_sha256 -cne $c.registration_sha256)){
                Stop-ReadProof 'HOLD_QUEUE_RETAINED_IDENTITY_CHANGED'
            }
            $targets = @(Get-CdpTargets -Endpoint $slot.endpoint -Strict | Where-Object {
                [string]$_.id -ceq $TargetId -and [string]$_.type -ceq 'page'
            })
            if ($targets.Count -ne 1) { Stop-ReadProof 'HOLD_QUEUE_TARGET_CHANGED' }
            # $Url is a typed string parameter; PowerShell variable names ignore case.
            # Keep the parsed Uri separate so its properties are not coerced away.
            $queueTargetUri = $null
            if (-not [Uri]::TryCreate([string]$targets[0].url, [UriKind]::Absolute, [ref]$queueTargetUri) -or
                $queueTargetUri.Scheme -cne 'https' -or $queueTargetUri.Host -cne 'chatgpt.com' -or $queueTargetUri.UserInfo -or
                $queueTargetUri.AbsolutePath -cne "/c/$ConversationId") { Stop-ReadProof 'HOLD_QUEUE_SAVED_CONVERSATION_UNPROVEN' }
            $nonces = @([regex]::Matches($queueTargetUri.Query, '(?:^\?|&)aicc_task_target=([a-f0-9]{64})(?=&|$)'))
            if ($nonces.Count -ne 1 -or $nonces[0].Groups[1].Value -cne $lease.task_target_nonce) {
                Stop-ReadProof 'HOLD_QUEUE_LIVE_NONCE_UNPROVEN'
            }
            $now = [DateTimeOffset]::UtcNow
            $expires = $now.AddSeconds(120)
            if (-not $retained) {
                $leaseExpires = [DateTimeOffset]::Parse([string]$lease.expires_at_utc)
                if ($leaseExpires -lt $expires) { $expires = $leaseExpires }
            }
            if ($expires -le $now) { Stop-ReadProof 'HOLD_QUEUE_LEASE_EXPIRED' }
            $proof = [ordered]@{
                schemaVersion = 1; kind = 'aicc-cdp-queue-live-target-inspection'
                originalRequestSha256 = $OriginalRequestSha256; ownerId = $OwnerId
                originalLeaseSha256 = (Get-ProofTextHash $LeaseToken)
                slot = [string]$slot.port; targetId = $TargetId
                targetNonce = [string]$lease.task_target_nonce; conversationId = $ConversationId
                accountAlias = $AccountAlias; workspaceAlias = $Workspace
                accountIdentityHash = [string]$identity.identityHash
                workspaceIdentityHash = [string]$identity.workspaceIdentityHash
                registrationSha256 = [string]$identity.registration_sha256
                observedAt = $now.ToString('o'); expiresAt = $expires.ToString('o')
                state = if ($retained) { 'OWNER_KEEP_TARGET_RETAINED' } else { 'OWNED_ACTIVE' }
            }
            if($retained){$proof.retentionProof=$retained}
        } finally { Exit-LeaseMutex }
        Write-Result ([pscustomobject]@{ ok=$true; status=if($retained){'verified_retained_owner_target'}else{'verified_active_owner_target'}; proof=[pscustomobject]$proof })
    } catch {
        $code = if ($_.Exception.Message -cmatch '^HOLD_[A-Z0-9_]+$') { $_.Exception.Message } else { 'HOLD_QUEUE_OWNER_INSPECT_UNPROVEN' }
        Write-Result ([pscustomobject]@{ok=$false;status='HOLD';holdCode=$code;retryable=$false;target_preserved=$true}) 4
    }
}
if ($Action -eq 'ReadExisting') {
    try {
        if (-not $PSBoundParameters.ContainsKey('OwnerId') -or -not $OwnerId) { Stop-ReadProof 'HOLD_ORIGINAL_OWNER_REQUIRED' }
        $result = Invoke-ExistingTargetRead
    } catch {
        $code = if ($_.Exception.Message -cmatch '^HOLD_[A-Z0-9_]+$') { $_.Exception.Message } else { 'HOLD_READ_PROOF_OR_STORAGE_UNPROVEN' }
        $diagnostic = [ordered]@{ exceptionType=$_.Exception.GetType().Name; scriptLine=$_.InvocationInfo.ScriptLineNumber }
        Write-Result ([pscustomobject]@{ ok=$false; status='HOLD'; holdCode=$code; diagnostic=$diagnostic; retryable=$false; target_preserved=$true; nextActor='원 owner/등록 broker 담당: 공식 생성·반환 근거와 저장 상태 조정' }) 4
    }
    Write-Result $result
}

if ($Action -eq 'Status') {    $records = foreach ($slot in $slots) {
        $leases = @(Read-PortLeases -Port $slot.port)
        $active = @($leases | Where-Object { Test-LeaseBlocksSlot $_ })
        $capacity = Get-SlotCapacity $slot
        $readBarrier = Test-PortReadBarrier $slot.port
        if ($readBarrier -or @($leases | Where-Object mode -eq 'read-existing').Count -gt 0) { $capacity = 1 }
        [pscustomobject]@{
            port = $slot.port
            endpoint = $slot.endpoint
            status = if ($readBarrier -or $active.Count -ge $capacity) { 'full' } elseif ($active.Count -gt 0) { 'shared' } else { 'available' }
            active_count = [Math]::Max($active.Count, [int]$readBarrier)
            read_history_hold = $readBarrier
            capacity = $capacity
            leases = @($active | ForEach-Object { [pscustomobject]@{ owner_id = $_.owner_id; expires_at_utc = $_.expires_at_utc; target_id = $_.target_id; state = $_.state } })
        }
    }
    Write-Result ([pscustomobject]@{ ok = $true; state_root = $StateRoot; slots = @($records); capabilities = @('read-existing-readonly/v1'); proof_schema = 'released-task-target-read/v1' })
}

if ($Action -in @('Heartbeat', 'Release')) {
    if (-not $LeaseToken) { throw "-$Action requires -LeaseToken." }
    Enter-LeaseMutex
    try {
        $matched = Find-LeaseByToken -Token $LeaseToken
        if (-not $matched) { throw 'Lease token was not found.' }
        if ([string]$matched.mode -eq 'read-existing') {
            Assert-ReadLeaseCurrent $matched
            if ($matched.state -cne 'ready' -or ($Action -eq 'Heartbeat' -and (Test-LeaseExpired $matched))) { Stop-ReadProof 'HOLD_READ_LEASE_NOT_RENEWABLE' }
        }
        if ($Action -eq 'Release' -and $QueueOwnerRequestFile){
            if($NoBrowser -or -not $KeepTarget -or [string]$matched.mode -eq 'read-existing' -or
               $matched.state -cne 'ready' -or (Test-LeaseExpired $matched) -or
               $OriginalReceipt -or $OriginalReceiptSha256 -or $PromptSha256){
                Stop-ReadProof 'HOLD_QUEUE_RETENTION_RELEASE_UNSAFE'
            }
            $null=Get-QueueOriginalRequestBinding $matched
        }
        if ($Action -eq 'Release' -and [string]$matched.mode -ne 'read-existing' -and
            ($OriginalReceipt -or $OriginalReceiptSha256 -or $PromptSha256) -and
            (-not $KeepTarget -or $matched.state -cne 'ready' -or (Test-LeaseExpired $matched))) { Stop-ReadProof 'HOLD_ORIGINAL_RELEASE_BINDING' }
        if ($Action -eq 'Heartbeat') { $matched = Update-LeaseHeartbeat -Lease $matched }
        else { $matched.state = 'releasing'; $matched = Update-LeaseHeartbeat -Lease $matched }
    } finally { Exit-LeaseMutex }
    if ($Action -eq 'Heartbeat') { Write-Result ([pscustomobject]@{ ok = $true; status = 'renewed'; lease = $matched }) }
    $isReadLease = [string]$matched.mode -eq 'read-existing'
    $closed = if ($isReadLease) { $false } else { Close-OwnedTarget -Lease $matched }
    $released = $isReadLease -or $closed -or $NoBrowser -or $KeepTarget
    if ($released) {
        Enter-LeaseMutex
        try {
            $current = Find-LeaseByToken -Token $LeaseToken
            if (-not $current) { Stop-ReadProof 'HOLD_RELEASE_OWNERSHIP_CHANGED' }
            foreach ($key in @('lease_token','owner_id','target_id','endpoint','state','heartbeat_at_utc','expires_at_utc')) {
                if ([string]$current.$key -cne [string]$matched.$key) { Stop-ReadProof 'HOLD_RELEASE_OWNERSHIP_CHANGED' }
            }
            if ($isReadLease) {
                Assert-ReadLeaseCurrent $current
                $dir = Get-TargetHistoryDirectory $current.port $current.target_id
                $null = Write-TargetHistory $dir "read-$($current.read_id).returned.json" ([ordered]@{
                    kind='read-returned'; recorded_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
                    read_id=$current.read_id; acquired_sha256=$current.read_acquired_sha256; target_preserved=$true
                })
            } elseif ($KeepTarget) {
                Write-KeepTargetHistory $current
            }
            Remove-LeaseRecord -Lease $current
        } finally { Exit-LeaseMutex }
    }
    Write-Result ([pscustomobject]@{ ok = $released; status = if ($released) { 'released' } else { 'release_pending_cleanup' }; port = [int]$matched.port; target_id = $matched.target_id; target_closed = $closed }) $(if ($released) { 0 } else { 4 })
}

if ($PreferredPort -and -not $NoBrowser -and -not $AllowBrowserStart) {
    $slots = @($slots | Where-Object {
        $identity = Get-IdentityReport -Slot $_
        if ($identity.exit_code -eq 0 -and $identity.report.ok) { return $true }
        $reasons = @($identity.report.reasons)
        if ($reasons.Count -gt 0 -and @($reasons | Where-Object { $_ -ne 'cdp_endpoint_unavailable' }).Count -eq 0) { return $false }
        throw "CDP Chrome $($_.port) identity mismatch; refusing fallback: $($identity.raw)"
    })
    if ($slots.Count -eq 0) { throw 'No connected registered slot matches the requested identity; no browser was started.' }
}
$deadline = [DateTimeOffset]::UtcNow.AddSeconds($WaitSec)
$selected = $null
$reclaimed = @()
$cleanupAttempted = [Collections.Generic.HashSet[string]]::new()
do {
    $expired = @()
    Enter-LeaseMutex
    try {
        foreach ($slot in $slots) {
            foreach ($lease in @(Read-PortLeases -Port $slot.port)) {
                if ([string]$lease.mode -ne 'read-existing' -and (Test-LeaseExpired $lease) -and [string]$lease.state -in @('ready', 'reclaiming', 'releasing', 'cleanup_failed') -and $cleanupAttempted.Add([string]$lease.lease_token)) {
                    $lease.state = 'reclaiming'; Write-Lease $lease
                    $expired += [pscustomobject]@{ slot = $slot; lease = $lease }
                }
            }
        }
    } finally { Exit-LeaseMutex }
    foreach ($candidate in $expired) {
        $lease = $candidate.lease
        $closed = Test-ExpiredTargetCleanup -Slot $candidate.slot -Lease $lease
        if ($closed -or $NoBrowser) {
            Enter-LeaseMutex
            try { $current = Find-LeaseByToken $lease.lease_token; if (Test-LeaseCleanupUnchanged $current $lease) { Remove-LeaseRecord $current; $reclaimed += $lease } } finally { Exit-LeaseMutex }
        } else {
            Enter-LeaseMutex
            try { $current = Find-LeaseByToken $lease.lease_token; if (Test-LeaseCleanupUnchanged $current $lease) { $current.state = 'cleanup_failed'; Write-Lease $current } } finally { Exit-LeaseMutex }
        }
    }

    Enter-LeaseMutex
    try {
        $candidates = foreach ($slot in $slots) {
            $active = @(Read-PortLeases -Port $slot.port | Where-Object { Test-LeaseBlocksSlot $_ })
            if ((Test-PortReadBarrier $slot.port) -or @($active | Where-Object mode -eq 'read-existing').Count -gt 0) { continue }
            if ($active.Count -lt (Get-SlotCapacity $slot)) { [pscustomobject]@{ slot = $slot; count = $active.Count } }
        }
        $choice = if ($PreferredPort) {
            $candidates | Sort-Object @{ Expression = { if ($_.slot.port -ge $PreferredPort) { $_.slot.port - $PreferredPort } else { 65536 + $_.slot.port - $PreferredPort } } } | Select-Object -First 1
        } else { $candidates | Sort-Object count, @{ Expression = { $_.slot.port } } | Select-Object -First 1 }
        if ($choice) {
            $record = New-LeaseRecord -Slot $choice.slot
            Write-Lease -Lease $record
            $selected = [pscustomobject]@{ slot = $choice.slot; lease = $record }
        }
    } finally { Exit-LeaseMutex }
    if ($selected -or [DateTimeOffset]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 250
} while ($true)

if (-not $selected) {
    $busy = foreach ($slot in $slots) {
        $active = @(Read-PortLeases -Port $slot.port | Where-Object { Test-LeaseBlocksSlot $_ })
        [pscustomobject]@{ port = $slot.port; active_count = $active.Count; capacity = (Get-SlotCapacity $slot) }
    }
    Write-Result ([pscustomobject]@{ ok = $false; status = 'busy'; reason = 'all_registered_cdp_chrome_target_capacity_is_leased'; slots = @($busy) }) 3
}

$createdTarget = $null
$historyStage = $false
try {
    $started = Ensure-SlotReady -Slot $selected.slot
    $lease = $selected.lease
    $targetUrl = Get-TaskTargetUrl -RequestedUrl $Url -Nonce ([string]$lease.task_target_nonce)
    $createdTarget = New-OwnedTarget -Slot $selected.slot -TargetUrl $targetUrl
    $lease.target_id = $createdTarget
    $lease.target_url = $targetUrl
    Write-ControlState -Lease $lease
    $lease.state = 'ready'
    $lease.browser_started_by_lease = [bool]$started
    Enter-LeaseMutex
    try {
        $current = Find-LeaseByToken $lease.lease_token
        if (-not $current) { throw 'Lease ownership changed while the target was being prepared.' }
        if ($current.state -cne 'provisioning' -or $current.owner_id -cne $lease.owner_id) { Stop-ReadProof 'HOLD_CREATION_OWNER_CHANGED' }
        $historyStage = $true
        $identity = if ($RecordReadHistory) { Get-TargetIdentityProof $selected.slot $createdTarget } else { $null }
        Write-CreationHistory $selected.slot $lease $identity
        $lease = Update-LeaseHeartbeat -Lease $lease
    } finally { Exit-LeaseMutex }
    Write-Result ([pscustomobject]@{
        ok = $true
        status = 'acquired'
        lease = $lease
        reclaimed_count = $reclaimed.Count
        instructions = 'Use only target_id with BROWSER_AGENT_HOME=control_state_dir. Never activate the target. Release immediately after this browser-action interval.'
    })
} catch {
    if ($historyStage) {
        Enter-LeaseMutex
        try {
            $current = Find-LeaseByToken $selected.lease.lease_token
            if ($current -and $current.owner_id -ceq $selected.lease.owner_id) {
                $current.target_id = $createdTarget; $current.state = 'unknown'; Write-Lease $current
            }
        } finally { Exit-LeaseMutex }
        throw
    }
    $cleanupFailed = $false
    if ($createdTarget) {
        $selected.lease.target_id = $createdTarget
        $cleanupFailed = -not (Close-OwnedTarget $selected.lease)
    }
    Enter-LeaseMutex
    try {
        $current = Find-LeaseByToken $selected.lease.lease_token
        if ($current) {
            if ($cleanupFailed) { $current.target_id = $createdTarget; $current.state = 'cleanup_failed'; Write-Lease $current }
            else { Remove-LeaseRecord $current }
        }
    } finally { Exit-LeaseMutex }
    throw
}
