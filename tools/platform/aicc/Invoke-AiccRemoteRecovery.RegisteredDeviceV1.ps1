param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('arm', 'watch', 'status', 'signal', 'bind-owner', 'close')]
  [string]$Mode,
  [Parameter(Mandatory = $false)]
  [string]$OperationId,
  [Parameter(Mandatory = $false)]
  [string]$ConversationId,
  [Parameter(Mandatory = $false)]
  [string]$ControllerThreadId,
  [Parameter(Mandatory = $false)]
  [string]$RollbackScriptPath,
  [Parameter(Mandatory = $false)]
  [string]$ResumeMessagePath,
  [Parameter(Mandatory = $false)]
  [string]$Nonce,
  [Parameter(Mandatory = $false)]
  [string]$Reason,
  [Parameter(Mandatory = $false)]
  [string]$Root = 'C:\demo\owner\.codex\ops\webgpt-remote-recovery',
  [Parameter(Mandatory = $false)]
  [int]$HeartbeatSeconds = 5
  ,
  [Parameter(Mandatory = $false)]
  [int]$OwnerPid = 0,
  [Parameter(Mandatory = $false)]
  [switch]$AutoOnOwnerExit,
  [ValidateSet('webgpt','rdc-device','rdc-17841')][string]$Transport = 'webgpt',
  [string]$DeviceId,
  [int]$RdcHostPid,
  [string]$RdcHostCreatedTicks,
  [string]$RdcHostCommandSha256,
  [string]$RdcHostImageSha256,
  [string]$SnapshotPath,
  [string]$ReleaseManifestPath,
  [string]$OperationExpiresAt,
  [string]$RecoveryExpiresAt,
  [string]$MetadataSha256,
  [ValidateSet('recover','activate')][string]$SignalAction = 'recover',
  [string]$RuntimeContractPath,
  [string]$RuntimeContractSha256,
  [string]$HandoffPath,
  [string]$HandoffSha256,
  [string]$TransportReceiptPath,
  [string]$TransportReceiptSha256,
  [string]$DeviceRegistrationPath,
  [string]$DeviceRegistrationSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if($Transport -cne 'rdc-17841'){throw 'This versioned successor is dedicated to 17841 maintenance only'}

$ExpectedConversationId = '6ac8a240-f0c0-83ec-b85c-7927270c9868'
$OperationIdPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$'
$NoncePattern = '^[a-f0-9]{32}$'
$Root = [System.IO.Path]::GetFullPath($Root)
$ScriptPath = [System.IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$HeartbeatSeconds = [Math]::Min([Math]::Max($HeartbeatSeconds, 2), 10)

function UtcNow { return [DateTime]::UtcNow.ToString('o') }

function Write-JsonAtomic([string]$Path, [object]$Value) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = "$Path.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
  $json = $Value | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($temp, "$json`n", [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Write-TextAtomic([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = "$Path.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
  [System.IO.File]::WriteAllText($temp, $Text, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $json=Get-Content -Raw -LiteralPath $Path -Encoding UTF8
  if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { return $json | ConvertFrom-Json -DateKind String }
  return $json | ConvertFrom-Json
}

function Require-OperationId {
  if ([string]::IsNullOrWhiteSpace($OperationId) -or $OperationId -notmatch $OperationIdPattern) {
    throw 'OperationId must be 6-64 characters using letters, digits, dot, underscore, or dash.'
  }
}

function Require-Nonce([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch $NoncePattern) {
    throw 'Nonce must be exactly 32 lowercase hexadecimal characters.'
  }
}

function Operation-Dir { return Join-Path $Root (Join-Path 'operations' $OperationId) }
function Operation-File([string]$Name) { return Join-Path (Operation-Dir) $Name }

function Require-Capsule {
  Require-OperationId
  $dir = Operation-Dir
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Recovery capsule does not exist: $OperationId" }
  $metadata = Read-Json (Operation-File 'metadata.json')
  if ($null -eq $metadata) { throw 'Recovery capsule metadata is missing.' }
  return $metadata
}

function Assert-PathUnder([string]$Child, [string]$Parent) {
  $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd('\') + '\'
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $childFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the recovery capsule: $Child"
  }
}

function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try { return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $stream.Dispose() }
  }
  finally { $sha.Dispose() }
}

function Build-Prompt([object]$Metadata) {
  $scriptPath = $ScriptPath
  $watchArgs = @(
    '-NoProfile', '-File', $scriptPath,
    '-Mode', 'watch', '-OperationId', $Metadata.operationId, '-Nonce', $Metadata.nonce
  )
  $argumentList = ($watchArgs | ForEach-Object { "'$_'" }) -join ','
  return @"
이 작업은 account 1의 지정된 ChatGPT 대화에서 Remote Command Tunnel 백업 복구를 준비하는 단일 요청이다.

절대 사용하지 말 것: AICC Workspace/MCP, Slack, ACL, SeSecurityPrivilege, OCX, Native Codex, 다른 계정, 다른 대화, provider fallback.

Remote Command Tunnel로 아래의 owner-local worker를 hidden/background로 정확히 한 번만 시작하라. worker는 캡슐의 고정된 rollback.ps1만 실행할 수 있고, 임의 명령을 만들거나 지금 rollback을 실행하지 않는다.

Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @($argumentList)

그 다음 Remote Command Tunnel로 다음 파일을 읽어 검증하라:
$((Join-Path (Operation-Dir) 'readiness.json'))
$((Join-Path (Operation-Dir) 'heartbeat.json'))

검증 조건: operationId=$($Metadata.operationId), nonce=$($Metadata.nonce), channel=remote-command-tunnel, account=account-1, conversationId=$($Metadata.conversationId), state=READY_STANDBY, standby=true, heartbeat가 최신.

조건을 만족하면 채팅에는 READY_STANDBY라고만 보고하고, 이 대화를 종료하지 말고 idle/standby로 유지하라. 위험한 변경이나 복구 실행은 내가 별도 신호를 보낼 때까지 하지 말라.
"@
}

function Arm {
  Require-OperationId
  if ($ConversationId -ne $ExpectedConversationId) { throw "ConversationId must be the protected account-1 conversation $ExpectedConversationId" }
  if ([string]::IsNullOrWhiteSpace($ControllerThreadId)) { throw 'ControllerThreadId is required.' }
  if ([string]::IsNullOrWhiteSpace($RollbackScriptPath)) { throw 'RollbackScriptPath is required.' }
  if (-not (Test-Path -LiteralPath $RollbackScriptPath -PathType Leaf)) { throw "Rollback script not found: $RollbackScriptPath" }
  if ($AutoOnOwnerExit -and $OwnerPid -le 0) { throw 'AutoOnOwnerExit requires an exact task-owned OwnerPid.' }
  if ($AutoOnOwnerExit -and $null -eq (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue)) { throw "OwnerPid is not running: $OwnerPid" }

  $dir = Operation-Dir
  if (Test-Path -LiteralPath $dir) { throw "Refusing to overwrite an existing capsule: $dir" }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $nonceBytes = New-Object byte[] 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($nonceBytes) } finally { $rng.Dispose() }
  $nonceValue = ($nonceBytes | ForEach-Object { $_.ToString('x2') }) -join ''
  $rollbackCopy = Join-Path $dir 'rollback.ps1'
  Copy-Item -LiteralPath $RollbackScriptPath -Destination $rollbackCopy
  $rollbackHash = Get-Sha256 $rollbackCopy
  Write-TextAtomic (Join-Path $dir 'rollback.sha256') "$rollbackHash  rollback.ps1`n"
  if ($ResumeMessagePath) {
    if (-not (Test-Path -LiteralPath $ResumeMessagePath -PathType Leaf)) { throw "Resume message template not found: $ResumeMessagePath" }
    Copy-Item -LiteralPath $ResumeMessagePath -Destination (Join-Path $dir 'resume-template.md')
  }
  $metadata = [ordered]@{
    schema = 'webgpt-remote-recovery/v1'
    operationId = $OperationId
    channel = 'remote-command-tunnel'
    account = 'account-1'
    conversationId = $ConversationId
    controllerThreadId = $ControllerThreadId
    nonce = $nonceValue
    rollbackSha256 = $rollbackHash
    createdAt = UtcNow
    heartbeatSeconds = $HeartbeatSeconds
    ownerPid = if ($OwnerPid -gt 0) { $OwnerPid } else { $null }
    ownerStartedAt = if ($OwnerPid -gt 0) { (Get-Process -Id $OwnerPid).StartTime.ToUniversalTime().ToString('o') } else { $null }
    autoOnOwnerExit = $AutoOnOwnerExit.IsPresent
    state = 'ARMED'
  }
  Write-JsonAtomic (Join-Path $dir 'metadata.json') $metadata
  Write-JsonAtomic (Join-Path $dir 'state.json') ([ordered]@{ state = 'ARMED'; updatedAt = UtcNow })
  Write-TextAtomic (Join-Path $dir 'webgpt-prompt.txt') (Build-Prompt $metadata)
  [ordered]@{ ok = $true; state = 'ARMED'; operationId = $OperationId; capsule = $dir; prompt = (Join-Path $dir 'webgpt-prompt.txt'); nonce = $nonceValue } | ConvertTo-Json -Depth 6
}

function Watch {
  Require-OperationId
  Require-Nonce $Nonce
  $metadata = Require-Capsule
  if ($metadata.nonce -ne $Nonce) { throw 'Nonce does not match the capsule.' }
  $rollback = Operation-File 'rollback.ps1'
  if ((Get-Sha256 $rollback) -ne $metadata.rollbackSha256) { throw 'Rollback script hash changed; refusing to start standby.' }
  $watchLock = [IO.File]::Open((Operation-File 'watch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
  $initialState = Read-Json (Operation-File 'state.json')
  if ($initialState.state -notin @('ARMED','READY_STANDBY') -or (Test-Path -LiteralPath (Operation-File 'rollback.claim.json'))) {
    throw 'Consumed or terminal capsule cannot be rearmed or replayed.'
  }
  $existingReadiness = Read-Json (Operation-File 'readiness.json')
  $existingHeartbeat = Read-Json (Operation-File 'heartbeat.json')
  if ($null -ne $existingReadiness -and $null -ne $existingHeartbeat -and $existingReadiness.watcherPid -and $existingReadiness.watcherPid -ne $PID) {
    $heartbeatAge = ([DateTime]::UtcNow - [DateTime]::Parse($existingHeartbeat.heartbeatAt)).TotalSeconds
    if ($heartbeatAge -le 20 -and (Get-Process -Id ([int]$existingReadiness.watcherPid) -ErrorAction SilentlyContinue)) {
      throw 'A live standby worker already owns this recovery capsule.'
    }
  }
  Write-JsonAtomic (Operation-File 'readiness.json') ([ordered]@{
    schema = 'webgpt-remote-recovery/v1'
    state = 'READY_STANDBY'
    standby = $true
    channel = 'remote-command-tunnel'
    account = 'account-1'
    conversationId = $metadata.conversationId
    operationId = $metadata.operationId
    nonce = $metadata.nonce
    watcherPid = $PID
    watcherStartedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
    readyAt = UtcNow
  })
  Write-JsonAtomic (Operation-File 'state.json') ([ordered]@{ state = 'READY_STANDBY'; updatedAt = UtcNow })

  while ($true) {
    $metadata = Read-Json (Operation-File 'metadata.json')
    $request = Read-Json (Operation-File 'failure.request.json')
    $state = Read-Json (Operation-File 'state.json')
    Write-JsonAtomic (Operation-File 'heartbeat.json') ([ordered]@{
      state = if ($null -eq $state) { 'READY_STANDBY' } else { $state.state }
      operationId = $metadata.operationId
      nonce = $metadata.nonce
      watcherPid = $PID
      watcherStartedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
      heartbeatAt = UtcNow
    })
    $boundOwner = if ([int]$metadata.ownerPid -gt 0) { Get-Process -Id ([int]$metadata.ownerPid) -ErrorAction SilentlyContinue } else { $null }
    $ownerMatches = $null -ne $boundOwner -and $boundOwner.StartTime.ToUniversalTime().Ticks -eq ([DateTimeOffset]::Parse([string]$metadata.ownerStartedAt)).UtcTicks
    if ($null -eq $request -and $metadata.autoOnOwnerExit -eq $true -and [int]$metadata.ownerPid -gt 0 -and -not $ownerMatches) {
      $request = [pscustomobject]@{
        state = 'REQUESTED'
        operationId = $metadata.operationId
        nonce = $metadata.nonce
        requestedAt = UtcNow
        reason = "Bound task-owned process $($metadata.ownerPid) exited unexpectedly."
      }
      Write-JsonAtomic (Operation-File 'failure.request.json') $request
    }
    if ($null -ne $request -and $request.operationId -eq $metadata.operationId -and $request.nonce -ceq $metadata.nonce -and $request.state -eq 'REQUESTED') {
      $claimFile = Operation-File 'rollback.claim.json'
      $claimStream = [IO.File]::Open($claimFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try { $claimBytes=[Text.UTF8Encoding]::new($false).GetBytes((@{operationId=$metadata.operationId;nonce=$metadata.nonce;claimedAt=UtcNow}|ConvertTo-Json)); $claimStream.Write($claimBytes,0,$claimBytes.Length) }
      finally { $claimStream.Dispose() }
      Write-JsonAtomic (Operation-File 'state.json') ([ordered]@{ state = 'RECOVERING'; updatedAt = UtcNow; reason = $request.reason })
      $exitCode = 1
      $errorText = $null
      try {
        if ((Get-Sha256 $rollback) -ne $metadata.rollbackSha256) { throw 'Rollback script hash changed after standby.' }
        $env:WEBGPT_RECOVERY_OPERATION_ID = [string]$metadata.operationId
        $env:WEBGPT_RECOVERY_CAPSULE = [string](Operation-Dir)
        $child = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-File', $rollback)
        $exitCode = [int]$child.ExitCode
      } catch {
        $errorText = $_.Exception.Message
      } finally {
        Remove-Item Env:WEBGPT_RECOVERY_OPERATION_ID -ErrorAction SilentlyContinue
        Remove-Item Env:WEBGPT_RECOVERY_CAPSULE -ErrorAction SilentlyContinue
      }
      $final = if ($null -eq $errorText -and $exitCode -eq 0) { 'RECOVERED' } else { 'FAILED' }
      Write-JsonAtomic (Operation-File 'result.json') ([ordered]@{
        schema = 'webgpt-remote-recovery/v1'
        state = $final
        operationId = $metadata.operationId
        nonce = $metadata.nonce
        channel = 'remote-command-tunnel'
        account = 'account-1'
        conversationId = $metadata.conversationId
        requestedAt = $request.requestedAt
        completedAt = UtcNow
        rollbackExitCode = $exitCode
        error = $errorText
      })
      # Keep the worker source ASCII-safe for Windows PowerShell. Decode the Korean
      # user-facing template from UTF-8 bytes so a legacy powershell.exe does not
      # reinterpret the script as the system code page.
      $resumeTemplateBase64 = 'IyBDb2RleCBEZXNrdG9wIOuzteq1rCDsnqzqsJwg66mU7Iuc7KeACgotIG9wZXJhdGlvbjoge29wZXJhdGlvbn0KLSDspp3sg4E6IHtyZWFzb259Ci0g67O16rWsIOqyveuhnDogYWNjb3VudCAxIFdlYkdQVOydmCBSZW1vdGUgRGVza3RvcCBDb21tYW5kZXIoUmVtb3RlIENvbW1hbmQgVHVubmVsKeqwgCBvd25lci1sb2NhbCByb2xsYmFjay5wczHsnYQgaGlkZGVuIGNoaWxkIHByb2Nlc3ProZwgMe2ajCDsi6TtlokKLSDqsrDqs7w6IHtmaW5hbH0gKGV4aXQgY29kZSB7ZXhpdH0pCi0g6rKw6rO8IO2MjOydvDoge3Jlc3VsdFBhdGh9Ci0g64uk7J2MIOuLqOqzhDog7J20IOuplOyLnOyngOulvCDrsJvsnYAgQ29kZXggRGVza3RvcCB0YXNr64qUIHJlc3VsdC5qc29u6rO8IOyekeyXhSDsg4Htg5zrpbwg7J296rOgIOuCqOydgCDsnpHsl4XsnYQg7J6s6rCc7ZWc64ukLgo='
      $summary = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($resumeTemplateBase64))
      $summary = $summary.Replace('{operation}', [string]$metadata.operationId).Replace('{reason}', [string]$request.reason).Replace('{final}', $final).Replace('{exit}', [string]$exitCode).Replace('{resultPath}', (Operation-File 'result.json'))
      Write-TextAtomic (Operation-File 'resume-message.md') $summary
      Write-JsonAtomic (Operation-File 'state.json') ([ordered]@{ state = $final; updatedAt = UtcNow })
      break
    }
    $state = Read-Json (Operation-File 'state.json')
    if ($null -ne $state -and $state.state -in @('CLOSED', 'RECOVERED', 'FAILED')) { break }
    Start-Sleep -Seconds ([Math]::Max(2, $HeartbeatSeconds))
  }
  } finally { $watchLock.Dispose() }
}

function Status {
  Require-OperationId
  $metadata = Require-Capsule
  $readiness = Read-Json (Operation-File 'readiness.json')
  $heartbeat = Read-Json (Operation-File 'heartbeat.json')
  $state = Read-Json (Operation-File 'state.json')
  $result = Read-Json (Operation-File 'result.json')
  $fresh = $false
  if ($null -ne $heartbeat -and $heartbeat.heartbeatAt) {
    $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$heartbeat.heartbeatAt)).TotalSeconds
    $worker = Get-Process -Id ([int]$heartbeat.watcherPid) -ErrorAction SilentlyContinue
    $creationMatches = $null -ne $worker -and $worker.StartTime.ToUniversalTime().Ticks -eq ([DateTimeOffset]::Parse([string]$heartbeat.watcherStartedAt)).UtcTicks
    $fresh = $age -ge 0 -and $age -le 20 -and $creationMatches
  }
  [ordered]@{
    ok = ($null -ne $state -and $state.state -eq 'READY_STANDBY' -and $null -ne $readiness -and $readiness.state -eq 'READY_STANDBY' -and $readiness.standby -eq $true -and $readiness.channel -eq 'remote-command-tunnel' -and $readiness.account -eq 'account-1' -and $readiness.conversationId -eq $metadata.conversationId -and $readiness.operationId -eq $metadata.operationId -and $readiness.nonce -eq $metadata.nonce -and $fresh)
    operationId = $metadata.operationId
    state = if ($null -eq $state) { $null } else { $state.state }
    readiness = $readiness
    heartbeatFresh = $fresh
    heartbeat = $heartbeat
    result = $result
    chatConversationId = $metadata.conversationId
  } | ConvertTo-Json -Depth 12
}

function Signal {
  Require-OperationId
  Require-Nonce $Nonce
  $metadata = Require-Capsule
  if ($metadata.nonce -ne $Nonce) { throw 'Nonce does not match the capsule.' }
  $current = Read-Json (Operation-File 'state.json')
  if ($null -eq $current -or $current.state -notin @('ARMED', 'READY_STANDBY')) { throw "Cannot signal recovery from state $($current.state)." }
  if (Test-Path -LiteralPath (Operation-File 'failure.request.json') -PathType Leaf) { throw 'A recovery signal already exists; refusing to signal twice.' }
  if ([string]::IsNullOrWhiteSpace($Reason)) { $Reason = 'Codex controller reported an interruption.' }
  Write-JsonAtomic (Operation-File 'failure.request.json') ([ordered]@{
    state = 'REQUESTED'
    operationId = $metadata.operationId
    nonce = $metadata.nonce
    requestedAt = UtcNow
    reason = $Reason.Substring(0, [Math]::Min(500, $Reason.Length))
  })
  [ordered]@{ ok = $true; state = 'REQUESTED'; operationId = $metadata.operationId } | ConvertTo-Json -Depth 5
}

function Bind-Owner {
  Require-OperationId
  Require-Nonce $Nonce
  $metadata = Require-Capsule
  if ($metadata.nonce -ne $Nonce) { throw 'Nonce does not match the capsule.' }
  $current = Read-Json (Operation-File 'state.json')
  if ($null -eq $current -or $current.state -ne 'READY_STANDBY') { throw 'Owner binding requires READY_STANDBY.' }
  if ($OwnerPid -le 0) { throw 'OwnerPid is required.' }
  if ($null -eq (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue)) { throw "OwnerPid is not running: $OwnerPid" }
  $metadata.ownerPid = $OwnerPid
  $metadata.ownerStartedAt = (Get-Process -Id $OwnerPid).StartTime.ToUniversalTime().ToString('o')
  $metadata.autoOnOwnerExit = $true
  $metadata | Add-Member -NotePropertyName boundAt -NotePropertyValue (UtcNow) -Force
  Write-JsonAtomic (Operation-File 'metadata.json') $metadata
  [ordered]@{ ok = $true; state = 'OWNER_BOUND'; operationId = $OperationId; ownerPid = $OwnerPid } | ConvertTo-Json -Depth 6
}

function Close {
  $metadata = Require-Capsule
  $current = Read-Json (Operation-File 'state.json')
  if ($null -eq $current -or $current.state -notin @('RECOVERED', 'FAILED', 'READY_STANDBY', 'ARMED')) { throw 'Capsule cannot be closed from its current state.' }
  Write-JsonAtomic (Operation-File 'state.json') ([ordered]@{ state = 'CLOSED'; updatedAt = UtcNow })
  [ordered]@{ ok = $true; state = 'CLOSED'; operationId = $metadata.operationId } | ConvertTo-Json -Depth 5
}

# The device branch is a bounded, fixed OCX transaction. It never attributes an
# RDC process to the historical WebGPT account/conversation. The controller must
# retain the real start_process response from this device; JSON is not proof of
# transport. No arbitrary command, owner-exit trigger or new listener is accepted.
function Rdc-Regular([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path)
  $item=Get-Item -LiteralPath $full -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'RDC regular file required'}
  for($parent=$item.Directory;$parent;$parent=$parent.Parent){if($parent.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RDC linked ancestor refused'}}
  return $full
}
function Rdc-TextHash([string]$Value) {
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()
}
function Rdc-New([string]$Path,$Value) {
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 18 -Compress))
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Rdc-Publish([string]$Path,$Value) {
  $pending=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  Rdc-New $pending $Value
  # Publish only a complete message; an existing request is never overwritten.
  [IO.File]::Move($pending,$Path,$false)
}
function Rdc-Identity([int]$ProcessId) {
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProcessId)
  if(-not $p -or -not $p.CommandLine -or -not $p.ExecutablePath){throw 'RDC process identity unavailable'}
  @{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;createdTicks=$p.CreationDate.ToUniversalTime().Ticks.ToString();image=(Rdc-Regular $p.ExecutablePath);imageSha256=(Get-Sha256 $p.ExecutablePath);commandSha256=(Rdc-TextHash ([string]$p.CommandLine))}
}
function Rdc-SameProcess($A,$B) {
  $A.pid -eq $B.pid -and $A.parentPid -eq $B.parentPid -and $A.createdTicks -ceq $B.createdTicks -and $A.image -ieq $B.image -and $A.imageSha256 -ceq $B.imageSha256 -and $A.commandSha256 -ceq $B.commandSha256
}
function Rdc-Time([string]$Value) {
  $time=[DateTimeOffset]::Parse($Value)
  if($Value -cne $time.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")){throw 'Canonical UTC milliseconds expiry required'}
  return $time
}
function Rdc-Ancestry($Metadata) {
  $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -in @(10100,10101,17841))
  $blocked=@($listeners.OwningProcess)
  $rows=@();$cursor=$PID;$found=$false
  for($depth=0;$cursor -gt 0 -and $depth -lt 16;$depth++){
    $row=Rdc-Identity $cursor
    if($cursor -in $blocked){throw 'RDC ancestry depends on the affected model route'}
    $rows+=@($row)
    if($cursor -eq $Metadata.rdcHost.pid){
      if(-not (Rdc-SameProcess $row $Metadata.rdcHost)){throw 'RDC host process changed'}
      $found=$true;break
    }
    $cursor=[int]$row.parentPid
  }
  if(-not $found){throw 'Worker was not started under the pinned RDC host'}
  return ,$rows
}
function Rdc-DeviceRegistration($Metadata) {
  if(-not $Metadata.PSObject.Properties['deviceRegistration']){
    if($Metadata.deviceId -cne '32002de6-dd98-4da6-9423-7d1032bfec6e'){throw 'New device requires exact immutable registered host attestation'}
    return
  }
  $module=Rdc-Regular (Join-Path $PSScriptRoot 'Recovery-DeviceBinding.psm1')
  $pin=$Metadata.deviceRegistration
  if($pin.modulePath -ine $module -or $pin.moduleSha256 -cne (Get-Sha256 $module)){throw 'Pinned recovery device module changed'}
  Import-Module -Name $module -Force
  Assert-AiccRecoveryDeviceMetadata -Metadata $Metadata
}
function Rdc-Binding([switch]$BeforeActivation,[switch]$ReadOnly) {
  Require-OperationId;Require-Nonce $Nonce
  $expectedRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\webgpt-remote-recovery'
  if($Root -ine [IO.Path]::GetFullPath($expectedRoot)){throw 'Device recovery uses the existing owner-local capsule root'}
  $file=Rdc-Regular (Operation-File 'metadata.json')
  if($MetadataSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-Sha256 $file) -cne $MetadataSha256){throw 'RDC immutable metadata changed'}
  $m=Read-Json $file
  if($m.schema -cne 'aicc-rdc-ocx-recovery/v1' -or $m.channel -cne 'rdc-device' -or $m.operationId -cne $OperationId -or $m.nonce -cne $Nonce -or $m.deviceId -cne $DeviceId -or $m.target -cne 'ocx-only'){throw 'RDC operation/device binding differs'}
  Rdc-DeviceRegistration $m
  foreach($pin in @(@($m.workerScript,$m.workerScriptSha256),@($m.transitionScript,$m.transitionScriptSha256),@($m.powershell,$m.powershellSha256),@((Join-Path $m.snapshotPath 'snapshot.json'),$m.snapshotSha256),@($m.releaseManifestPath,$m.releaseManifestSha256))){if((Get-Sha256 (Rdc-Regular $pin[0])) -cne $pin[1]){throw 'RDC pinned code or transaction input changed'}}
  if($m.workerScript -ine $ScriptPath -or (-not $ReadOnly -and (Rdc-Time $m.recoveryExpiresAt) -le [DateTimeOffset]::UtcNow)){throw 'RDC recovery expired or worker path changed'}
  if($BeforeActivation -and (Rdc-Time $m.operationExpiresAt) -le [DateTimeOffset]::UtcNow){throw 'RDC activation expired; no dispatch'}
  return $m
}
function Rdc-Arm {
  Require-OperationId
  if($PSVersionTable.PSVersion -lt [version]'7.5'){throw 'Device recovery requires the existing PowerShell 7.5+ runtime'}
  if($ControllerThreadId -notmatch '^[a-f0-9-]{36}$' -or $ConversationId -or $RollbackScriptPath -or $ResumeMessagePath -or $AutoOnOwnerExit -or $OwnerPid){throw 'Exact existing RDC device and controller required; no WebGPT impersonation or owner-exit trigger'}
  $expectedRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\webgpt-remote-recovery'
  if($Root -ine [IO.Path]::GetFullPath($expectedRoot)){throw 'Existing capsule root required'}
  $activationExpiry=Rdc-Time $OperationExpiresAt;$recoveryExpiry=Rdc-Time $RecoveryExpiresAt;$now=[DateTimeOffset]::UtcNow
  if($activationExpiry -le $now -or $activationExpiry -gt $now.AddMinutes(30) -or $recoveryExpiry -lt $activationExpiry.AddMinutes(5) -or $recoveryExpiry -gt $activationExpiry.AddMinutes(30)){throw 'Bounded activation and recovery deadlines required'}
  $hostIdentity=Rdc-Identity $RdcHostPid
  if($hostIdentity.createdTicks -cne $RdcHostCreatedTicks -or $hostIdentity.commandSha256 -cne $RdcHostCommandSha256 -or $hostIdentity.imageSha256 -cne $RdcHostImageSha256){throw 'Fresh RDC host pins required'}
  $registrationPin=$null
  if($DeviceRegistrationPath -or $DeviceRegistrationSha256){
    $module=Rdc-Regular (Join-Path $PSScriptRoot 'Recovery-DeviceBinding.psm1')
    Import-Module -Name $module -Force
    $registration=Get-AiccRecoveryDeviceRegistration -Path $DeviceRegistrationPath -Sha256 $DeviceRegistrationSha256 -DeviceId $DeviceId -RdcHost $hostIdentity
    if($recoveryExpiry -gt [DateTimeOffset]::Parse($registration.challenge.expiresAt)){throw 'Recovery deadline outlives exact device registration'}
    $registrationPin=@{path=(Rdc-Regular $DeviceRegistrationPath);sha256=$DeviceRegistrationSha256;modulePath=$module;moduleSha256=(Get-Sha256 $module)}
  }elseif($DeviceId -cne '32002de6-dd98-4da6-9423-7d1032bfec6e'){throw 'New device requires exact immutable registered host attestation'}
  $control=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
  $snapshotFile=Rdc-Regular (Join-Path $SnapshotPath 'snapshot.json');Assert-PathUnder $snapshotFile (Join-Path $control 'backups\runtime-layout')
  if((Split-Path (Split-Path $snapshotFile -Parent) -Leaf) -notmatch '^ocx-clean-\d{8}-\d{6}-[a-f0-9]{8}$'){throw 'Existing exact OCX snapshot contract required'}
  $releaseFile=Rdc-Regular $ReleaseManifestPath;Assert-PathUnder $releaseFile (Join-Path $control 'opencodex-native\external-candidates')
  $snapshot=Read-Json $snapshotFile;$release=Read-Json $releaseFile
  if($snapshot.schema -cne 'aicc-ocx-software-snapshot/v1' -or @($snapshot.files).Count -ne 4 -or $release.schema -cne 'aicc-external-ocx-release/v1'){throw 'Exact software snapshot and external OCX candidate required'}
  $expectedFiles=@((Join-Path $control 'runtime\ocx-local\current.json'),(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.opencodex\opencodex-service.cmd'),(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.opencodex\service-state.json'),(Join-Path $control 'runtime\ocx-local\home\service-state.json'))
  if(@($snapshot.files.path|Select-Object -Unique).Count -ne 4 -or @($snapshot.files.backupFile|Select-Object -Unique).Count -ne 4){throw 'Duplicate snapshot target refused'}
  foreach($saved in $snapshot.files){
    if($saved.path -notin $expectedFiles -or $saved.backupFile -notmatch '^[0-3]\.preimage$' -or (Get-Sha256 (Rdc-Regular (Join-Path $SnapshotPath $saved.backupFile))) -cne $saved.sha256 -or (Get-Sha256 (Rdc-Regular $saved.path)) -cne $saved.sha256){throw 'Snapshot or live preimage changed before arming'}
  }
  foreach($entry in $release.adapterFiles.PSObject.Properties){$path=Rdc-Regular (Join-Path (Split-Path $releaseFile -Parent) $entry.Name);Assert-PathUnder $path (Split-Path $releaseFile -Parent);if((Get-Sha256 $path) -cne $entry.Value){throw 'Candidate adapter pin changed'}}
  $transition=Rdc-Regular (Join-Path $PSScriptRoot '..\opencodex\Invoke-AiccOcxTransition.ps1')
  $engine=Rdc-Regular ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
  $dir=Operation-Dir
  if(Test-Path -LiteralPath $dir){throw 'Existing operation is never overwritten or rearmed'}
  New-Item -ItemType Directory -Path $dir|Out-Null
  $m=[ordered]@{schema='aicc-rdc-ocx-recovery/v1';channel='rdc-device';deviceId=$DeviceId;operationId=$OperationId;nonce=([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant());controllerThreadId=$ControllerThreadId;target='ocx-only';allowedActions=@('activate-once','rollback-once','status','close');createdAt=(UtcNow);operationExpiresAt=$OperationExpiresAt;recoveryExpiresAt=$RecoveryExpiresAt;rdcHost=$hostIdentity;workerScript=$ScriptPath;workerScriptSha256=(Get-Sha256 $ScriptPath);transitionScript=$transition;transitionScriptSha256=(Get-Sha256 $transition);powershell=$engine;powershellSha256=(Get-Sha256 $engine);snapshotPath=(Split-Path $snapshotFile -Parent);snapshotSha256=(Get-Sha256 $snapshotFile);releaseManifestPath=$releaseFile;releaseManifestSha256=(Get-Sha256 $releaseFile);noReplay=$true;automaticOwnerExitRecovery=$false;excluded=@('17841','Workspace','Chrome','accounts','credentials','original requests')}
  if($registrationPin){$m.deviceRegistration=$registrationPin}
  Rdc-New (Operation-File 'metadata.json') $m
  Rdc-New (Operation-File 'state.json') @{state='ARMED';operationId=$OperationId;updatedAt=(UtcNow)}
  @{ok=$true;state='ARMED';channel='rdc-device';deviceId=$DeviceId;operationId=$OperationId;nonce=$m.nonce;metadataSha256=(Get-Sha256 (Operation-File 'metadata.json'));capsule=$dir;workerScript=$ScriptPath;powershell=$engine;runtimeChanged=$false;standby=$false}|ConvertTo-Json -Depth 6
}
function Rdc-Heartbeat($Metadata,[string]$Phase,$Worker) {
  Write-JsonAtomic (Operation-File 'heartbeat.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;deviceId=$Metadata.deviceId;phase=$Phase;worker=$Worker;heartbeatAt=(UtcNow)}
}
function Rdc-RunChild($Metadata,[string]$ChildMode,$Worker) {
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$Metadata.powershell;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false,$true);$start.StandardErrorEncoding=$start.StandardOutputEncoding
  foreach($arg in @('-NoProfile','-NonInteractive','-File',$Metadata.transitionScript,'-Mode',$ChildMode,'-SnapshotPath',$Metadata.snapshotPath,'-ReleaseManifestPath',$Metadata.releaseManifestPath,'-RecoveryOperationId',$OperationId,'-RecoveryNonce',$Nonce,'-RecoveryMetadataSha256',$MetadataSha256)){$start.ArgumentList.Add([string]$arg)}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$start
  $phase=if($ChildMode -ceq 'Activate'){'ACTIVATING'}else{'ROLLING_BACK'}
  Write-JsonAtomic (Operation-File 'state.json') @{state=$phase;operationId=$OperationId;updatedAt=(UtcNow)}
  Rdc-Heartbeat $Metadata $phase $Worker
  try{
    if(-not $process.Start()){throw 'RDC child start not confirmed'}
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    Rdc-New (Operation-File ($ChildMode.ToLowerInvariant()+'.child.json')) @{pid=$process.Id;createdTicks=$process.StartTime.ToUniversalTime().Ticks.ToString();operationId=$OperationId;mode=$ChildMode;startedAt=(UtcNow)}
    while(-not $process.WaitForExit(1000)){
      Rdc-Heartbeat $Metadata $phase $Worker
      if([DateTimeOffset]::UtcNow -ge (Rdc-Time $Metadata.recoveryExpiresAt)){
        return @{known=$false;state='UNCERTAIN_NO_REPLAY';reason='child_deadline_alive';pid=$process.Id;mode=$ChildMode}
      }
    }
    # Child output is never copied into receipts. Only bounded metadata is kept.
    $exitCode=$process.ExitCode;$outText=$stdout.GetAwaiter().GetResult();$errText=$stderr.GetAwaiter().GetResult()
    return @{known=$true;mode=$ChildMode;exitCode=$exitCode;stdoutSha256=(Rdc-TextHash $outText);stderrSha256=(Rdc-TextHash $errText);completedAt=(UtcNow)}
  }catch{return @{known=$false;state='UNCERTAIN_NO_REPLAY';reason='child_start_or_capture_unconfirmed';mode=$ChildMode}}
  finally{$process.Dispose()}
}
function Rdc-Watch {
  $m=Rdc-Binding -BeforeActivation
  $lock=[IO.File]::Open((Operation-File 'watch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    $state=Read-Json (Operation-File 'state.json')
    if($state.state -cne 'ARMED' -or (Test-Path -LiteralPath (Operation-File 'watch.claim.json'))){throw 'Device worker launch is one-use; inspect an uncertain launch instead of retrying'}
    $ancestry=Rdc-Ancestry $m;$worker=$ancestry[0]
    if($worker.image -ine $m.powershell -or $worker.imageSha256 -cne $m.powershellSha256){throw 'Pinned PowerShell worker required'}
    Rdc-New (Operation-File 'watch.claim.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;claimedAt=(UtcNow)}
    $ready=@{schema='aicc-rdc-ocx-ready/v1';state='READY_STANDBY';standby=$true;channel='rdc-device';deviceId=$DeviceId;operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;ancestry=$ancestry;operationExpiresAt=$m.operationExpiresAt;recoveryExpiresAt=$m.recoveryExpiresAt;snapshotSha256=$m.snapshotSha256;releaseManifestSha256=$m.releaseManifestSha256;readyAt=(UtcNow);transportProof='retain_actual_RDC_start_process_response'}
    Write-JsonAtomic (Operation-File 'readiness.json') $ready
    Write-JsonAtomic (Operation-File 'state.json') @{state='READY_STANDBY';operationId=$OperationId;updatedAt=(UtcNow)}
    Rdc-Heartbeat $m 'READY_STANDBY' $worker
    $ready|ConvertTo-Json -Depth 12 -Compress
    while($true){
      $state=Read-Json (Operation-File 'state.json')
      if($state.state -ceq 'CLOSED'){return}
      if([DateTimeOffset]::UtcNow -ge (Rdc-Time $m.operationExpiresAt)){Write-JsonAtomic (Operation-File 'state.json') @{state='EXPIRED';updatedAt=(UtcNow)};return}
      $m=Rdc-Binding -BeforeActivation;$null=Rdc-Ancestry $m
      Rdc-Heartbeat $m 'READY_STANDBY' $worker
      $request=Read-Json (Operation-File 'activate.request.json')
      if($request){
        if($request.operationId -cne $OperationId -or $request.nonce -cne $Nonce -or $request.metadataSha256 -cne $MetadataSha256 -or $request.deviceId -cne $DeviceId -or $request.action -cne 'activate'){throw 'Foreign activation request refused'}
        $control=[IO.File]::Open((Operation-File 'control.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try{
          if((Read-Json (Operation-File 'state.json')).state -cne 'READY_STANDBY'){throw 'Activation no longer accepted'}
          Rdc-New (Operation-File 'activation.claim.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;claimedAt=(UtcNow)}
          Write-JsonAtomic (Operation-File 'state.json') @{state='ACTIVATING';updatedAt=(UtcNow)}
        }finally{$control.Dispose()}
        $activation=Rdc-RunChild $m 'Activate' $worker
        $terminal='UNCERTAIN_NO_REPLAY';$rollback=$null
        $completion=Read-Json (Join-Path $m.snapshotPath 'activation-result.json')
        $failure=Read-Json (Join-Path $m.snapshotPath 'activation-failure.json')
        if($activation.known -and $activation.exitCode -eq 0 -and $completion -and $completion.state -ceq 'ACTIVATED' -and $completion.operationId -ceq $OperationId -and $completion.manifestSha256 -ceq $m.releaseManifestSha256){$terminal='ACTIVATED'}
        elseif($activation.known -and $activation.exitCode -ne 0 -and $failure -and $failure.operationId -ceq $OperationId -and $failure.state -ceq 'FAILED'){
          $m=Rdc-Binding
          Rdc-New (Operation-File 'rollback.claim.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;claimedAt=(UtcNow)}
          $rollback=Rdc-RunChild $m 'Rollback' $worker
          $restored=Read-Json (Join-Path $m.snapshotPath 'rollback-result.json')
          if($rollback.known -and $rollback.exitCode -eq 0 -and $restored -and $restored.operationId -ceq $OperationId -and $restored.state -in @('RESTORED','RESTORED_RUNTIME','NO_CHANGE')){$terminal='RECOVERED'}
          elseif($rollback.known){$terminal='HOLD_RECONCILE_REQUIRED'}
        }
        $result=@{schema='aicc-rdc-ocx-result/v1';state=$terminal;operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;deviceId=$DeviceId;activation=$activation;rollback=$rollback;completedAt=(UtcNow);noReplay=$true;originalRequestsReplayed=$false}
        Rdc-New (Operation-File 'result.json') $result
        Write-JsonAtomic (Operation-File 'state.json') @{state=$terminal;updatedAt=(UtcNow)}
        $result|ConvertTo-Json -Depth 10 -Compress;return
      }
      Start-Sleep -Seconds $HeartbeatSeconds
    }
  }finally{$lock.Dispose()}
}
function Rdc-Status {
  $m=Rdc-Binding -ReadOnly;$ready=Read-Json (Operation-File 'readiness.json');$heartbeat=Read-Json (Operation-File 'heartbeat.json');$state=Read-Json (Operation-File 'state.json');$fresh=$false
  if($ready -and $heartbeat){
    try{$age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($heartbeat.heartbeatAt)).TotalSeconds;$fresh=$age -ge 0 -and $age -le 20 -and (Rdc-SameProcess (Rdc-Identity $ready.worker.pid) $ready.worker) -and $ready.metadataSha256 -ceq $MetadataSha256 -and $heartbeat.metadataSha256 -ceq $MetadataSha256 -and $ready.nonce -ceq $Nonce -and $ready.deviceId -ceq $DeviceId}catch{$fresh=$false}
  }
  @{ok=($state.state -ceq 'READY_STANDBY' -and $fresh -and (Rdc-Time $m.operationExpiresAt) -gt [DateTimeOffset]::UtcNow);state=$state.state;readiness=$ready;heartbeatFresh=$fresh;result=(Read-Json (Operation-File 'result.json'));noReplay=$true}|ConvertTo-Json -Depth 15
}
function Rdc-Signal {
  $m=Rdc-Binding -BeforeActivation
  if($SignalAction -cne 'activate'){throw 'Device worker owns failure rollback; only one activation request is supported'}
  $control=[IO.File]::Open((Operation-File 'control.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    if((Read-Json (Operation-File 'state.json')).state -cne 'READY_STANDBY'){throw 'Fresh device standby required'}
    $status=Rdc-Status|ConvertFrom-Json
    if(-not $status.ok){throw 'Device worker readiness is not fresh'}
    Rdc-Publish (Operation-File 'activate.request.json') @{action='activate';operationId=$OperationId;nonce=$Nonce;deviceId=$DeviceId;metadataSha256=$MetadataSha256;requestedAt=(UtcNow)}
    @{ok=$true;state='REQUESTED';operationId=$OperationId;noReplay=$true}|ConvertTo-Json -Compress
  }finally{$control.Dispose()}
}
function Rdc-Close {
  $null=Rdc-Binding -ReadOnly
  $control=[IO.File]::Open((Operation-File 'control.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    $state=Read-Json (Operation-File 'state.json')
    if($state.state -notin @('ARMED','READY_STANDBY','EXPIRED','ACTIVATED','RECOVERED')){throw 'Active or uncertain device transaction cannot be closed'}
    if($state.state -in @('ARMED','READY_STANDBY') -and (Test-Path -LiteralPath (Operation-File 'activate.request.json'))){throw 'Pending activation must be reconciled; no close/replay'}
    Write-JsonAtomic (Operation-File 'state.json') @{state='CLOSED';updatedAt=(UtcNow)}
    @{ok=$true;state='CLOSED';operationId=$OperationId}|ConvertTo-Json -Compress
  }finally{$control.Dispose()}
}

# 17841 has a separate transaction and state machine. It uses only the shared
# file/process primitives above, never the OCX standby/transition/rollback path.
# The candidate is the maintenance executor even when starting the restored
# original config.runtimeCommand. No option is passed to the old CLI's serve.
function W41-Home { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-chatgpt-web' }
function W41-Path([string]$Path) { [IO.Path]::GetFullPath($Path.Replace('/','\')).TrimEnd('\') }
function W41-HashPin([string]$Path,[string]$Expected) {
  if($Expected -cnotmatch '^[a-f0-9]{64}$' -or (Get-Sha256 (Rdc-Regular $Path)) -cne $Expected){throw '17841 file pin changed'}
}
function W41-SafeDirectory([string]$Path) {
  for($directory=[IO.DirectoryInfo]::new((W41-Path $Path));$directory;$directory=$directory.Parent){
    if(Test-Path -LiteralPath $directory.FullName){
      $entry=Get-Item -LiteralPath $directory.FullName -Force
      if(-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '17841 capsule/backup directory link refused'}
    }
  }
}
function W41-PrivateHome {
  $homePath=W41-Home
  $null=Rdc-Regular (Join-Path $homePath 'config.json')
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed=@($sid,'S-1-5-18','S-1-5-32-544')
  foreach($directory in @($homePath,(Join-Path $homePath 'runtime'),(Join-Path $homePath 'runtime\rdc-recovery'))){
    W41-SafeDirectory $directory
    if(-not (Test-Path -LiteralPath $directory)){continue}
    $acl=Get-Acl -LiteralPath $directory;$ownerFull=$false
    if($directory -ieq $homePath -and -not $acl.AreAccessRulesProtected){throw '17841 private home ACL must already be protected'}
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
      if($rule.AccessControlType -ne 'Allow'){continue}
      if($rule.IdentityReference.Value -notin $allowed){throw '17841 private backup ACL is not owner-local'}
      if($rule.IdentityReference.Value -eq $sid -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl){$ownerFull=$true}
    }
    if(-not $ownerFull){throw '17841 owner-local access unavailable; no ACL repair in this capsule'}
  }
}
function W41-InventoryVisit([string]$Directory,[string]$Prefix,$Digest) {
  $item=Get-Item -LiteralPath $Directory -Force
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '17841 bundle directory must not be a link'}
  [string[]]$names=@([IO.Directory]::EnumerateFileSystemEntries($Directory)|ForEach-Object{[IO.Path]::GetFileName($_)})
  [Array]::Sort($names,[StringComparer]::Ordinal)
  foreach($name in $names){
    $path=Join-Path $Directory $name;$entry=Get-Item -LiteralPath $path -Force;$relative=$Prefix+$name
    if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '17841 bundle link refused'}
    if($entry.PSIsContainer){W41-InventoryVisit $path ($relative+'/') $Digest;continue}
    $null=Rdc-Regular $path
    $Digest.AppendData([Text.Encoding]::UTF8.GetBytes($relative+[char]0))
    $stream=[IO.File]::OpenRead($path)
    try{$buffer=[byte[]]::new(65536);while(($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0){$Digest.AppendData($buffer,0,$read)}}finally{$stream.Dispose()}
    $Digest.AppendData([byte[]]@(0))
  }
}
function W41-Inventory([string]$Directory) {
  $digest=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
  try{W41-InventoryVisit (W41-Path $Directory) '' $digest;[Convert]::ToHexString($digest.GetHashAndReset()).ToLowerInvariant()}finally{$digest.Dispose()}
}
function W41-Canonical($Value) {
  if($null -eq $Value){return 'null'}
  if($Value -is [Collections.IDictionary]){
    [string[]]$keys=@($Value.Keys);[Array]::Sort($keys,[StringComparer]::Ordinal)
    $parts=@(foreach($key in $keys){($key|ConvertTo-Json -Compress)+':'+(W41-Canonical $Value[$key])})
    return '{'+($parts -join ',')+'}'
  }
  if($Value -is [Collections.IList]){return '['+(@(foreach($entry in $Value){W41-Canonical $entry}) -join ',')+']'}
  return ($Value|ConvertTo-Json -Compress -Depth 40)
}
function W41-ConfigInvariant([string]$Path) {
  $data=[IO.File]::ReadAllText($Path,[Text.Encoding]::UTF8)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 100
  $data.Remove('releaseVersion');$data.Remove('runtimeCommand')
  Rdc-TextHash (W41-Canonical $data)
}
function W41-Counter($Value) {
  if(($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt 0){throw '17841 active count is UNKNOWN'}
  return [long]$Value
}
function W41-CommandTokens([string]$Command) {
  $matches=[regex]::Matches($Command,'"([^"]*)"|([^\s"]+)');$cursor=0;$tokens=@()
  foreach($match in $matches){
    if($Command.Substring($cursor,$match.Index-$cursor) -match '\S'){throw '17841 command token boundary is UNKNOWN'}
    $tokens+=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
    $cursor=$match.Index+$match.Length
    if($cursor -lt $Command.Length -and -not [char]::IsWhiteSpace($Command[$cursor])){throw '17841 mixed command token refused'}
  }
  if($Command.Substring($cursor) -match '\S'){throw '17841 command token boundary is UNKNOWN'}
  return ,$tokens
}
function W41-Observe($Metadata,[string]$ExpectedRuntime,$ExpectedOwner=$null) {
  $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq 17841|Select-Object -ExpandProperty OwningProcess -Unique)
  $rows=@();$homePrefix=(W41-Path $Metadata.home)+'\'
  foreach($p in @(Get-CimInstance Win32_Process -Filter "Name = 'bun.exe' OR Name = 'node.exe' OR Name = 'codex-chatgpt-web.exe' OR Name = 'Codex Web GPT.exe'" -ErrorAction Stop)){
    if(-not $p.CommandLine -or -not $p.ExecutablePath){throw '17841 process inventory is UNKNOWN'}
    $normalized=([string]$p.CommandLine).Replace('/','\')
    if($p.ProcessId -notin $listeners -and -not ($normalized.IndexOf($homePrefix,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $normalized -match '(?i)\s"?serve"?(?:\s|$)')){continue}
    $tokens=W41-CommandTokens ([string]$p.CommandLine)
    if($tokens.Count -ne 3 -or (W41-Path $tokens[0]) -ine (W41-Path (Join-Path $ExpectedRuntime 'runtime\bun.exe')) -or (W41-Path $tokens[1]) -ine (W41-Path (Join-Path $ExpectedRuntime 'app\cli.js')) -or $tokens[2] -cne 'serve'){throw '17841 foreign or unexpected runtime command'}
    $rows+=@(Rdc-Identity ([int]$p.ProcessId))
  }
  $client=[Net.Http.HttpClient]::new();$client.Timeout=[TimeSpan]::FromSeconds(3)
  $health=$null;$refused=$false
  try{
    $response=$client.GetAsync('http://127.0.0.1:17841/healthz').GetAwaiter().GetResult()
    try{
      if(-not $response.IsSuccessStatusCode){throw '17841 health status is UNKNOWN'}
      $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if($text.Length -gt 65536){throw '17841 health response is oversized'}
      $health=$text|ConvertFrom-Json -DateKind String
    }finally{$response.Dispose()}
  }catch{
    $errorValue=$_.Exception
    while($errorValue){if($errorValue -is [Net.Sockets.SocketException] -and $errorValue.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused){$refused=$true;break};$errorValue=$errorValue.InnerException}
    if(-not $refused){throw '17841 health observation is UNKNOWN'}
  }finally{$client.Dispose()}
  if($listeners.Count -eq 0 -and $rows.Count -eq 0 -and $refused){return @{state='ABSENT';observedAt=(UtcNow)}}
  if($rows.Count -ne 1 -or $listeners.Count -ne 1 -or [int]$listeners[0] -ne $rows[0].pid -or -not $health){throw '17841 owner or absence is UNKNOWN'}
  $owner=$rows[0];$marker=Read-Json (Join-Path $Metadata.home 'runtime\windows-process.json')
  if(-not $marker -or $marker.pid -ne $owner.pid -or ([DateTimeOffset]::Parse($marker.created)).UtcTicks.ToString() -cne $owner.createdTicks -or $marker.commandHash -cne $owner.commandSha256 -or (W41-Path $marker.executable) -ine $owner.image){throw '17841 process marker does not match actual owner'}
  if($ExpectedOwner -and -not (Rdc-SameProcess $owner $ExpectedOwner)){throw '17841 owner changed since Arm'}
  $config=Read-Json (Join-Path $Metadata.home 'config.json')
  if($health.service -cne 'codex-chatgpt-web' -or $health.status -cne 'ok' -or $health.pid -ne $owner.pid -or $health.port -ne 17841 -or $health.version -cne $config.releaseVersion -or $health.accepting_turns -isnot [bool]){throw '17841 health identity differs'}
  $counts=@((W41-Counter $health.active_http_turns),(W41-Counter $health.active_browser_http_turns),(W41-Counter $health.active_browser_turns))
  @{state='OWNED';owner=$owner;counts=$counts;idle=(@($counts|Where-Object{$_ -ne 0}).Count -eq 0);acceptingTurns=$health.accepting_turns;version=$health.version;observedAt=(UtcNow)}
}
function W41-FileSet($Metadata,[string]$Expected) {
  foreach($saved in $Metadata.preimages){W41-HashPin $saved.backup $saved.sha256}
  $allBefore=$true
  foreach($saved in @($Metadata.preimages|Where-Object name -ne 'marker')){if((Get-Sha256 (Rdc-Regular $saved.path)) -cne $saved.sha256){$allBefore=$false}}
  if($Expected -ceq 'original'){if(-not $allBefore){throw '17841 original CAS changed'};return 'original'}
  if($Expected -ceq 'either' -and $allBefore){return 'original'}
  $config=Read-Json (Join-Path $Metadata.home 'config.json');$journal=Read-Json (Join-Path $Metadata.home 'runtime\windows-install.json');$descriptor=Read-Json (Join-Path $Metadata.home 'runtime\windows-command.json')
  if($config.port -ne 17841 -or $config.runtimeOwner -cne 'service' -or @($config.runtimeCommand).Count -ne 2 -or (W41-Path $config.runtimeCommand[0]) -ine (Join-Path $Metadata.destination 'runtime\bun.exe') -or (W41-Path $config.runtimeCommand[1]) -ine (Join-Path $Metadata.destination 'app\cli.js') -or $config.releaseVersion -cne $Metadata.candidateVersion){throw '17841 replacement config is not the exact candidate'}
  if((W41-ConfigInvariant (Join-Path $Metadata.home 'config.json')) -cne $Metadata.configInvariantSha256){throw '17841 unrelated config or authentication changed'}
  if($journal.schemaVersion -ne 1 -or (W41-Path $journal.runtimeRoot) -ine $Metadata.destination -or $journal.inventoryHash -cne $Metadata.contract.inventorySha256 -or $journal.configHash -cne (Get-Sha256 (Join-Path $Metadata.home 'config.json')) -or $journal.descriptorHash -cne (Get-Sha256 (Join-Path $Metadata.home 'runtime\windows-command.json'))){throw '17841 replacement journal ownership differs'}
  if((W41-Path $descriptor.runtimeRoot) -ine $Metadata.destination -or $descriptor.inventoryHash -cne $Metadata.contract.inventorySha256 -or $descriptor.endpoint -cne 'http://127.0.0.1:17841'){throw '17841 replacement command descriptor differs'}
  $beforeConfig=@($Metadata.preimages|Where-Object name -eq 'config')[0];$beforeDescriptor=@($Metadata.preimages|Where-Object name -eq 'descriptor')[0];$beforeJournal=@($Metadata.preimages|Where-Object name -eq 'journal')[0]
  if((Rdc-TextHash ([string]$journal.previousConfig)) -cne $beforeConfig.sha256 -or (Rdc-TextHash ([string]$journal.previousDescriptor)) -cne $beforeDescriptor.sha256){throw '17841 installer preimages differ'}
  $refProperty=$journal.PSObject.Properties['previousJournalRef']
  if($refProperty -and $refProperty.Value){
    $reference=$refProperty.Value
    if($null -ne $journal.previousJournal -or $reference.sha256 -cne $beforeJournal.sha256 -or $reference.bytes -ne (Get-Item -LiteralPath $beforeJournal.backup).Length){throw '17841 journal reference differs'}
    W41-HashPin (Join-Path $Metadata.home ('runtime\journal-preimages\'+$reference.sha256+'.json')) $beforeJournal.sha256
  }elseif((Rdc-TextHash ([string]$journal.previousJournal)) -cne $beforeJournal.sha256){throw '17841 previous journal differs'}
  W41-HashPin (Join-Path $Metadata.destination 'manifest.json') $Metadata.contract.manifestSha256
  W41-HashPin (Join-Path $Metadata.destination 'app\cli.js') $Metadata.contract.appSha256
  $installedPins=Read-Json (Operation-File 'installed-pins.json')
  if($installedPins){
    if($installedPins.operationId -cne $OperationId -or $installedPins.runtimeRoot -ine $Metadata.destination){throw '17841 installed transaction pins differ'}
    W41-HashPin (Join-Path $Metadata.home 'config.json') $installedPins.configSha256
    W41-HashPin (Join-Path $Metadata.home 'runtime\windows-command.json') $installedPins.descriptorSha256
    W41-HashPin (Join-Path $Metadata.home 'runtime\windows-install.json') $installedPins.journalSha256
  }
  return 'candidate'
}
function W41-Pins($Metadata,[switch]$Trees) {
  W41-HashPin $Metadata.workerScript $Metadata.workerScriptSha256
  W41-HashPin $Metadata.powershell $Metadata.powershellSha256
  W41-HashPin $Metadata.contract.installerPath $Metadata.contract.installerSha256
  W41-HashPin $Metadata.contractPath $Metadata.contractSha256
  W41-HashPin (Join-Path $Metadata.contract.bundleRoot 'manifest.json') $Metadata.contract.manifestSha256
  W41-HashPin (Join-Path $Metadata.contract.bundleRoot 'app\cli.js') $Metadata.contract.appSha256
  W41-HashPin (Join-Path $Metadata.contract.bundleRoot 'runtime\bun.exe') $Metadata.contract.bunSha256
  W41-HashPin (Join-Path $Metadata.originalRuntime 'manifest.json') $Metadata.contract.baseline.manifestSha256
  W41-HashPin (Join-Path $Metadata.originalRuntime 'app\cli.js') $Metadata.contract.baseline.appSha256
  foreach($saved in $Metadata.preimages){W41-HashPin $saved.backup $saved.sha256}
  if($Trees -and ((W41-Inventory $Metadata.contract.bundleRoot) -cne $Metadata.contract.inventorySha256 -or (W41-Inventory $Metadata.originalRuntime) -cne $Metadata.contract.baseline.inventorySha256)){throw '17841 full runtime inventory changed'}
}
function W41-Binding([switch]$Activation,[switch]$ReadOnly) {
  Require-OperationId;Require-Nonce $Nonce
  $expectedRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\webgpt-remote-recovery'
  if($Root -ine (W41-Path $expectedRoot)){throw '17841 uses the existing capsule root'}
  W41-HashPin (Operation-File 'metadata.json') $MetadataSha256
  $m=Read-Json (Operation-File 'metadata.json')
  if($m.schema -cne 'aicc-rdc-17841-recovery/v1' -or $m.operationId -cne $OperationId -or $m.nonce -cne $Nonce -or $m.deviceId -cne $DeviceId -or $m.target -cne '17841-only' -or $m.workerScript -ine $ScriptPath -or $m.home -ine (W41-Home)){throw '17841 capsule identity differs'}
  Rdc-DeviceRegistration $m
  W41-Pins $m
  if(-not $ReadOnly -and (Rdc-Time $m.recoveryExpiresAt) -le [DateTimeOffset]::UtcNow){throw '17841 recovery lease expired'}
  if($Activation -and (Rdc-Time $m.operationExpiresAt) -le [DateTimeOffset]::UtcNow){throw '17841 activation lease expired'}
  return $m
}
function W41-Arm {
  Require-OperationId;W41-PrivateHome
  if($DeviceId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $ControllerThreadId -notmatch '^[a-f0-9-]{36}$' -or $ConversationId -or $RollbackScriptPath -or $ResumeMessagePath -or $AutoOnOwnerExit -or $OwnerPid -or $SnapshotPath -or $ReleaseManifestPath){throw '17841 exact device/controller contract required; legacy recovery arguments refused'}
  $expectedRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\webgpt-remote-recovery'
  if($Root -ine (W41-Path $expectedRoot)){throw '17841 existing capsule root required'}
  $expiry=Rdc-Time $OperationExpiresAt;$recovery=Rdc-Time $RecoveryExpiresAt;$now=[DateTimeOffset]::UtcNow
  if($expiry -le $now -or $expiry -gt $now.AddMinutes(30) -or $recovery -lt $expiry.AddMinutes(5) -or $recovery -gt $expiry.AddMinutes(30)){throw '17841 bounded activation/recovery deadlines required'}
  W41-HashPin $RuntimeContractPath $RuntimeContractSha256
  $contract=Read-Json $RuntimeContractPath
  if($contract.schema -cne 'aicc-rdc-17841-candidate/v1' -or $contract.target -cne '17841-only'){throw '17841 explicit built candidate contract required'}
  foreach($name in @('runtimeOnlyStart','configuredCommandStart','authenticatedIdleStop','exactJournalRollback')){if($contract.capabilities.$name -isnot [bool] -or $contract.capabilities.$name -ne $true){throw '17841 runtime-only/rollback capability contract missing'}}
  $manifest=Read-Json (Rdc-Regular (Join-Path $contract.bundleRoot 'manifest.json'))
  if($manifest.schemaVersion -ne 1 -or $manifest.platform -cne 'win32' -or $manifest.arch -cne 'x64' -or $manifest.entrypoint -cne 'app/cli.js' -or $manifest.appVersion -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $manifest.bundleId -cnotmatch '^[a-f0-9]{64}$'){throw '17841 candidate manifest differs'}
  foreach($name in @('runtimeOnlyStart','configuredCommandStart','authenticatedIdleStop','exactJournalRollback')){if($manifest.capabilities.$name -isnot [bool] -or $manifest.capabilities.$name -ne $true){throw '17841 candidate manifest lacks explicit capability'}}
  $homePath=W41-Home;$configPath=Join-Path $homePath 'config.json';$config=Read-Json $configPath
  $journal=Read-Json (Join-Path $homePath 'runtime\windows-install.json')
  $original=W41-Path $journal.runtimeRoot
  if((Split-Path $original -Parent) -ine (Join-Path $homePath 'versions') -or $config.port -ne 17841 -or $config.runtimeOwner -cne 'service' -or @($config.runtimeCommand).Count -ne 2 -or (W41-Path $config.runtimeCommand[0]) -ine (Join-Path $original 'runtime\bun.exe') -or (W41-Path $config.runtimeCommand[1]) -ine (Join-Path $original 'app\cli.js')){throw '17841 original version/config ownership differs'}
  if($journal.schemaVersion -ne 1 -or $journal.configHash -cne (Get-Sha256 $configPath) -or $journal.descriptorHash -cne (Get-Sha256 (Join-Path $homePath 'runtime\windows-command.json')) -or (W41-Path $contract.baseline.runtimeRoot) -ine $original -or $contract.baseline.inventorySha256 -cne $journal.inventoryHash){throw '17841 original install journal or baseline differs'}
  $hostIdentity=Rdc-Identity $RdcHostPid
  if($hostIdentity.createdTicks -cne $RdcHostCreatedTicks -or $hostIdentity.commandSha256 -cne $RdcHostCommandSha256 -or $hostIdentity.imageSha256 -cne $RdcHostImageSha256){throw '17841 fresh RDC host pins required'}
  $registrationPin=$null
  if($DeviceRegistrationPath -or $DeviceRegistrationSha256){
    $module=Rdc-Regular (Join-Path $PSScriptRoot 'Recovery-DeviceBinding.psm1')
    Import-Module -Name $module -Force
    $registration=Get-AiccRecoveryDeviceRegistration -Path $DeviceRegistrationPath -Sha256 $DeviceRegistrationSha256 -DeviceId $DeviceId -RdcHost $hostIdentity
    if($recovery -gt [DateTimeOffset]::Parse($registration.challenge.expiresAt)){throw '17841 recovery deadline outlives exact device registration'}
    $registrationPin=@{path=(Rdc-Regular $DeviceRegistrationPath);sha256=$DeviceRegistrationSha256;modulePath=$module;moduleSha256=(Get-Sha256 $module)}
  }elseif($DeviceId -cne '32002de6-dd98-4da6-9423-7d1032bfec6e'){throw '17841 current device requires exact immutable registered host attestation'}
  $engine=Rdc-Regular ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
  $destination=Join-Path $homePath ('versions\'+$manifest.appVersion+'-win32-x64-'+$contract.inventorySha256.Substring(0,16))
  if($destination -ieq $original -or (Test-Path -LiteralPath $destination) -and (W41-Inventory $destination) -cne $contract.inventorySha256){throw '17841 distinct candidate destination required; no implicit repair suffix'}
  $m=[ordered]@{schema='aicc-rdc-17841-recovery/v1';channel='rdc-device';target='17841-only';deviceId=$DeviceId;operationId=$OperationId;nonce=([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant());controllerThreadId=$ControllerThreadId;createdAt=(UtcNow);operationExpiresAt=$OperationExpiresAt;recoveryExpiresAt=$RecoveryExpiresAt;rdcHost=$hostIdentity;workerScript=$ScriptPath;workerScriptSha256=(Get-Sha256 $ScriptPath);powershell=$engine;powershellSha256=(Get-Sha256 $engine);home=$homePath;originalRuntime=$original;originalVersion=$config.releaseVersion;candidateVersion=$manifest.appVersion;destination=$destination;contractPath=(Rdc-Regular $RuntimeContractPath);contractSha256=$RuntimeContractSha256;contract=$contract;preimages=@();configInvariantSha256=(W41-ConfigInvariant $configPath);noReplay=$true;unknownOriginalOutcomes='PRESERVED';automaticOwnerExitRecovery=$false;allowedActions=@('wait-exact-idle','authenticated-stop-once','install-once','runtime-only-start-once','known-failure-restore-once','status','close');excluded=@('OCX','Tunnel','Workspace','Chrome','accounts','credentials','original-request-replay');capabilityDeclarationIsLiveVerification=$false}
  if($registrationPin){$m.deviceRegistration=$registrationPin}
  W41-Pins $m -Trees
  $observed=W41-Observe $m $original
  if($observed.state -cne 'OWNED' -or -not $observed.acceptingTurns){throw '17841 original owned accepting runtime required at Arm'}
  $m.originalOwner=$observed.owner
  $dir=Operation-Dir;$backup=Join-Path $homePath ('runtime\rdc-recovery\'+$OperationId)
  if((Test-Path -LiteralPath $dir) -or (Test-Path -LiteralPath $backup)){throw '17841 operation and private backup are never rearmed'}
  W41-SafeDirectory $dir;W41-SafeDirectory $backup
  New-Item -ItemType Directory -Path $dir|Out-Null
  New-Item -ItemType Directory -Path $backup|Out-Null
  # Only this protected, existing user home holds secret-bearing bytes. Metadata
  # and stdout contain paths/hashes, never config, controlToken or journal text.
  $targets=[ordered]@{config=$configPath;descriptor=(Join-Path $homePath 'runtime\windows-command.json');journal=(Join-Path $homePath 'runtime\windows-install.json');marker=(Join-Path $homePath 'runtime\windows-process.json')}
  foreach($entry in $targets.GetEnumerator()){
    $path=Rdc-Regular $entry.Value;$sha=Get-Sha256 $path;$saved=Join-Path $backup ($entry.Key+'.preimage')
    [IO.File]::Copy($path,$saved,$false);W41-HashPin $saved $sha;W41-HashPin $path $sha
    $m.preimages+=@(@{name=$entry.Key;path=$path;backup=$saved;sha256=$sha})
  }
  $null=W41-FileSet $m 'original';$null=W41-Observe $m $original $m.originalOwner
  Rdc-New (Operation-File 'metadata.json') $m
  Rdc-New (Operation-File 'state.json') @{state='ARMED';operationId=$OperationId;updatedAt=(UtcNow)}
  @{ok=$true;state='ARMED';target='17841-only';deviceId=$DeviceId;operationId=$OperationId;nonce=$m.nonce;metadataSha256=(Get-Sha256 (Operation-File 'metadata.json'));capsule=$dir;privateBackup=$backup;powershell=$engine;workerScript=$ScriptPath;standby=$false;runtimeChanged=$false}|ConvertTo-Json -Depth 6 -Compress
}
function W41-Phase($Metadata,$Worker,[string]$Phase,$Details=$null) {
  Write-JsonAtomic (Operation-File 'state.json') @{state=$Phase;operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;details=$Details;updatedAt=(UtcNow)}
  Write-JsonAtomic (Operation-File 'heartbeat.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;deviceId=$DeviceId;phase=$Phase;worker=$Worker;heartbeatAt=(UtcNow)}
}
function W41-Child($Metadata,$Worker,[string]$Phase,[string]$Action) {
  $null=W41-Binding;W41-Pins $Metadata
  $claim=Operation-File ($Phase.ToLowerInvariant()+'.claim.json')
  Rdc-New $claim @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;action=$Action;phase=$Phase;claimedAt=(UtcNow)}
  W41-Phase $Metadata $Worker $Phase @{action=$Action;dispatchState='INTENT_RECORDED'}
  $quote={param($s) "'"+([string]$s).Replace("'","''")+"'"}
  $command="`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(`$false); `$OutputEncoding=[Console]::OutputEncoding; & "+(& $quote $Metadata.contract.installerPath)+' -Action '+(& $quote $Action)+' -Bundle '+(& $quote $Metadata.contract.bundleRoot)+' -HomePath '+(& $quote $Metadata.home)
  if($Action -ceq 'start'){$command+=' -RuntimeOnly'}
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$Metadata.powershell;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false,$true);$start.StandardErrorEncoding=$start.StandardOutputEncoding
  foreach($arg in @('-NoProfile','-NonInteractive','-EncodedCommand',[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command)))){$start.ArgumentList.Add($arg)}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$start
  try{
    if(-not $process.Start()){throw '17841 child start unconfirmed'}
    $outTask=$process.StandardOutput.ReadToEndAsync();$errTask=$process.StandardError.ReadToEndAsync()
    Rdc-New (Operation-File ($Phase.ToLowerInvariant()+'.child.json')) @{operationId=$OperationId;phase=$Phase;pid=$process.Id;createdTicks=$process.StartTime.ToUniversalTime().Ticks.ToString();startedAt=(UtcNow);commandSha256=(Rdc-TextHash $command)}
    $seconds=if($Action -ceq 'install'){600}else{180};$deadline=[DateTimeOffset]::UtcNow.AddSeconds($seconds)
    while(-not $process.WaitForExit(1000)){
      W41-Phase $Metadata $Worker $Phase @{action=$Action;dispatchState='CHILD_RUNNING';childPid=$process.Id}
      if([DateTimeOffset]::UtcNow -ge $deadline -or [DateTimeOffset]::UtcNow -ge (Rdc-Time $Metadata.recoveryExpiresAt)){
        $unknown=@{known=$false;phase=$Phase;state='UNCERTAIN_NO_REPLAY';reason='child_deadline_alive';childPid=$process.Id;noReplay=$true}
        Rdc-New (Operation-File ($Phase.ToLowerInvariant()+'.exit.json')) $unknown;return $unknown
      }
    }
    $code=$process.ExitCode;$stdout=$outTask.GetAwaiter().GetResult();$stderr=$errTask.GetAwaiter().GetResult();$payload=$null
    if($code -eq 0 -and $stdout.Length -le 1048576){try{$payload=$stdout|ConvertFrom-Json -DateKind String -Depth 30}catch{$payload=$null}}
    $result=@{known=$true;phase=$Phase;exitCode=$code;stdoutSha256=(Rdc-TextHash $stdout);stderrSha256=(Rdc-TextHash $stderr);completedAt=(UtcNow)}
    Rdc-New (Operation-File ($Phase.ToLowerInvariant()+'.exit.json')) $result
    $result.payload=$payload;return $result
  }catch{return @{known=$false;phase=$Phase;state='UNCERTAIN_NO_REPLAY';reason='child_start_or_output_unconfirmed';noReplay=$true}}
  finally{$process.Dispose()}
}
function W41-Outcome([string]$State,[string]$Reason) { @{state=$State;reason=$Reason;operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;target='17841-only';noReplay=$true;unknownOriginalOutcomes='PRESERVED';originalRequestsReplayed=$false;completedAt=(UtcNow)} }
function W41-Recover($Metadata,$Worker,[string]$FailurePhase) {
  $null=W41-Binding
  Rdc-New (Operation-File 'rollback.claim.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;failurePhase=$FailurePhase;claimedAt=(UtcNow)}
  W41-Phase $Metadata $Worker 'RECOVERING' @{failurePhase=$FailurePhase}
  # Only two understood file states are recoverable. Partial/foreign writes are
  # not overwritten by copying backups or by pretending installed() succeeded.
  $fileState=W41-FileSet $Metadata 'either'
  $rootPath=if($fileState -ceq 'original'){$Metadata.originalRuntime}else{$Metadata.destination}
  $observation=W41-Observe $Metadata $rootPath
  if($fileState -ceq 'original' -and $observation.state -ceq 'OWNED'){
    if((Rdc-SameProcess $observation.owner $Metadata.originalOwner) -and $observation.acceptingTurns){return (W41-Outcome 'NO_CHANGE' 'original_owner_and_files_preserved')}
    return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'original_runtime_state_requires_observation')
  }
  if($fileState -ceq 'candidate'){
    if($observation.state -ceq 'OWNED'){
      if(-not $observation.idle){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_active_preserved')}
      $stop=W41-Child $Metadata $Worker 'ROLLBACK_STOP_INTENT' 'stop'
      if(-not $stop.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'candidate_stop_unconfirmed')}
      if($stop.exitCode -ne 0){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_stop_refused')}
      if(-not $stop.payload -or $stop.payload.stopped -ne $true -or $stop.payload.pid -ne $observation.owner.pid){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_authenticated_stop_ack_missing')}
      $observation=W41-Observe $Metadata $Metadata.destination
    }
    if($observation.state -cne 'ABSENT'){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_absence_unproved')}
    $null=W41-FileSet $Metadata 'candidate';W41-Pins $Metadata -Trees
    $rollback=W41-Child $Metadata $Worker 'ROLLBACK_FILES_INTENT' 'rollback'
    if(-not $rollback.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'rollback_unconfirmed')}
    if($rollback.exitCode -ne 0 -or -not $rollback.payload -or $rollback.payload.restored -ne $true){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'rollback_result_not_proved')}
  }
  $null=W41-FileSet $Metadata 'original'
  if((W41-Observe $Metadata $Metadata.originalRuntime).state -cne 'ABSENT'){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'original_start_absence_unproved')}
  # Candidate maintenance CLI reads the restored original runtimeCommand and
  # spawns its exact Bun/CLI serve, with runtime-only suppressing Tunnel ensure.
  $start=W41-Child $Metadata $Worker 'RESTORE_START_INTENT' 'start'
  if(-not $start.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'original_start_unconfirmed')}
  if($start.exitCode -ne 0 -or -not $start.payload -or $start.payload.startScope -cne 'runtime-only' -or $start.payload.tunnelEnsured -ne $false){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'original_start_result_not_proved')}
  $null=W41-FileSet $Metadata 'original';$restored=W41-Observe $Metadata $Metadata.originalRuntime
  if($restored.state -cne 'OWNED' -or -not $restored.acceptingTurns){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'original_owner_not_admitted')}
  $result=W41-Outcome 'RECOVERED' 'original_files_and_runtime_restored_once';$result.owner=$restored.owner;return $result
}
function W41-Activate($Metadata,$Worker) {
  W41-Pins $Metadata -Trees
  while($true){
    if([DateTimeOffset]::UtcNow -ge (Rdc-Time $Metadata.operationExpiresAt)){return (W41-Outcome 'NOT_ACTIVATED' 'idle_not_reached_before_activation_expiry')}
    $null=W41-Binding -Activation;$null=W41-FileSet $Metadata 'original';$null=Rdc-Ancestry $Metadata
    $before=W41-Observe $Metadata $Metadata.originalRuntime $Metadata.originalOwner
    if($before.state -cne 'OWNED' -or -not $before.acceptingTurns){return (W41-Outcome 'HOLD_PRE_DISPATCH' 'original_runtime_changed_before_stop')}
    W41-Phase $Metadata $Worker 'WAITING_FOR_IDLE' @{counts=$before.counts;observedAt=$before.observedAt}
    if($before.idle){break}
    Start-Sleep -Seconds $HeartbeatSeconds
  }
  # The supported stop command repeats exact owner/idle checks, performs the
  # authenticated atomic drain, then shutdown. No Stop-Process/taskkill fallback.
  $null=W41-Binding -Activation;$null=W41-FileSet $Metadata 'original'
  Rdc-New (Operation-File 'before-stop.json') @{operationId=$OperationId;nonce=$Nonce;owner=$before.owner;counts=$before.counts;observedAt=$before.observedAt;metadataSha256=$MetadataSha256}
  $stop=W41-Child $Metadata $Worker 'STOP_INTENT' 'stop'
  if(-not $stop.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'stop_unconfirmed')}
  if($stop.exitCode -ne 0){return (W41-Recover $Metadata $Worker 'stop')}
  if(-not $stop.payload -or $stop.payload.stopped -ne $true -or $stop.payload.pid -ne $before.owner.pid){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'authenticated_stop_ack_missing')}
  $null=W41-FileSet $Metadata 'original'
  if((W41-Observe $Metadata $Metadata.originalRuntime).state -cne 'ABSENT'){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'shutdown_absence_unproved')}
  W41-Phase $Metadata $Worker 'STOPPED_ABSENT'
  W41-Pins $Metadata -Trees;$null=W41-FileSet $Metadata 'original'
  if([DateTimeOffset]::UtcNow -ge (Rdc-Time $Metadata.operationExpiresAt)){return (W41-Recover $Metadata $Worker 'activation_expired_after_stop')}
  $install=W41-Child $Metadata $Worker 'INSTALL_INTENT' 'install'
  if(-not $install.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'install_unconfirmed')}
  if($install.exitCode -ne 0){return (W41-Recover $Metadata $Worker 'install')}
  $null=W41-FileSet $Metadata 'candidate'
  if((W41-Inventory $Metadata.destination) -cne $Metadata.contract.inventorySha256 -or (W41-Observe $Metadata $Metadata.destination).state -cne 'ABSENT'){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_inventory_or_absence_differs')}
  Rdc-New (Operation-File 'installed-pins.json') @{operationId=$OperationId;runtimeRoot=$Metadata.destination;inventorySha256=$Metadata.contract.inventorySha256;configSha256=(Get-Sha256 (Join-Path $Metadata.home 'config.json'));descriptorSha256=(Get-Sha256 (Join-Path $Metadata.home 'runtime\windows-command.json'));journalSha256=(Get-Sha256 (Join-Path $Metadata.home 'runtime\windows-install.json'));observedAt=(UtcNow)}
  $start=W41-Child $Metadata $Worker 'START_INTENT' 'start'
  if(-not $start.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'candidate_start_unconfirmed')}
  if($start.exitCode -ne 0){return (W41-Recover $Metadata $Worker 'start')}
  if(-not $start.payload -or $start.payload.startScope -cne 'runtime-only' -or $start.payload.tunnelEnsured -ne $false){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'runtime_only_start_ack_missing')}
  $null=W41-FileSet $Metadata 'candidate';$after=W41-Observe $Metadata $Metadata.destination
  if($after.state -cne 'OWNED' -or -not $after.acceptingTurns){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_owner_not_admitted')}
  $result=W41-Outcome 'ACTIVATED' 'candidate_installed_and_runtime_only_started';$result.owner=$after.owner;$result.runtimeRoot=$Metadata.destination;$result.manifestSha256=$Metadata.contract.manifestSha256;return $result
}
function W41-Status {
  $m=W41-Binding -ReadOnly;$ready=Read-Json (Operation-File 'readiness.json');$heartbeat=Read-Json (Operation-File 'heartbeat.json');$state=Read-Json (Operation-File 'state.json');$fresh=$false
  if($ready -and $heartbeat){try{$age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($heartbeat.heartbeatAt)).TotalSeconds;$fresh=$age -ge 0 -and $age -le 20 -and (Rdc-SameProcess (Rdc-Identity $ready.worker.pid) $ready.worker) -and $ready.metadataSha256 -ceq $MetadataSha256 -and $heartbeat.metadataSha256 -ceq $MetadataSha256 -and $ready.nonce -ceq $Nonce -and $ready.deviceId -ceq $DeviceId}catch{$fresh=$false}}
  @{ok=($state.state -ceq 'READY_STANDBY' -and $fresh -and (Rdc-Time $m.operationExpiresAt) -gt [DateTimeOffset]::UtcNow);state=$state.state;heartbeatFresh=$fresh;readiness=$ready;result=(Read-Json (Operation-File 'result.json'));noReplay=$true}|ConvertTo-Json -Depth 15 -Compress
}
function W41-RequestProof($Metadata,$Ready,[string]$HandoffFile,[string]$HandoffDigest,[string]$ReceiptFile,[string]$ReceiptDigest) {
  W41-HashPin $HandoffFile $HandoffDigest;W41-HashPin $ReceiptFile $ReceiptDigest
  $handoff=Read-Json $HandoffFile;$receipt=Read-Json $ReceiptFile
  if($handoff.schema -cne 'aicc-17841-controller-handoff/v1' -or $handoff.operationId -cne $OperationId -or $handoff.nonce -cne $Nonce -or $handoff.metadataSha256 -cne $MetadataSha256 -or $handoff.controllerThreadId -cne $Metadata.controllerThreadId -or $handoff.state -cne 'RELEASED_FOR_MAINTENANCE' -or $handoff.noReplay -ne $true -or $handoff.unknownOriginalOutcomes -cne 'PRESERVED' -or $handoff.expiresAt -cne $Metadata.operationExpiresAt){throw '17841 explicit operation handoff missing'}
  W41-HashPin $handoff.approvalRef.path $handoff.approvalRef.sha256
  if($receipt.schema -cne 'aicc-rdc-transport-ack/v1' -or $receipt.source -cne 'remote_desktop_commander.start_process' -or $receipt.operationId -cne $OperationId -or $receipt.nonce -cne $Nonce -or $receipt.metadataSha256 -cne $MetadataSha256 -or $receipt.deviceId -cne $DeviceId -or $receipt.readyObserved -ne $true -or $receipt.workerPid -ne $Ready.worker.pid -or $receipt.responseProcessId -notin @($Ready.ancestry|Where-Object pid -ne $Metadata.rdcHost.pid|ForEach-Object pid)){throw '17841 actual RDC response binding missing'}
}
function W41-Signal {
  $m=W41-Binding -Activation
  if($SignalAction -cne 'activate'){throw '17841 only the worker may recover a known failure'}
  $control=[IO.File]::Open((Operation-File 'control.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    $status=W41-Status|ConvertFrom-Json -DateKind String
    if(-not $status.ok){throw '17841 actual independent standby is not fresh'}
    W41-RequestProof $m $status.readiness $HandoffPath $HandoffSha256 $TransportReceiptPath $TransportReceiptSha256
    Rdc-Publish (Operation-File 'activate.request.json') @{action='activate';operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;deviceId=$DeviceId;handoffPath=(Rdc-Regular $HandoffPath);handoffSha256=$HandoffSha256;transportReceiptPath=(Rdc-Regular $TransportReceiptPath);transportReceiptSha256=$TransportReceiptSha256;requestedAt=(UtcNow)}
    @{ok=$true;state='REQUESTED';operationId=$OperationId;workerWaitsForActualIdle=$true;controllerMustReleaseCurrentTurn=$true;noReplay=$true}|ConvertTo-Json -Compress
  }finally{$control.Dispose()}
}
function W41-Watch {
  $m=W41-Binding -Activation
  $lock=[IO.File]::Open((Operation-File 'watch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    if((Read-Json (Operation-File 'state.json')).state -cne 'ARMED' -or (Test-Path -LiteralPath (Operation-File 'watch.claim.json'))){throw '17841 worker start is one-use; no replay'}
    $ancestry=Rdc-Ancestry $m;$worker=$ancestry[0]
    if($worker.image -ine $m.powershell -or $worker.imageSha256 -cne $m.powershellSha256){throw '17841 pinned independent worker required'}
    Rdc-New (Operation-File 'watch.claim.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;claimedAt=(UtcNow)}
    W41-PrivateHome;W41-Pins $m -Trees;$null=W41-FileSet $m 'original';$null=W41-Observe $m $m.originalRuntime $m.originalOwner
    $ready=@{schema='aicc-rdc-17841-ready/v1';state='READY_STANDBY';target='17841-only';deviceId=$DeviceId;operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;ancestry=$ancestry;operationExpiresAt=$m.operationExpiresAt;recoveryExpiresAt=$m.recoveryExpiresAt;candidateManifestSha256=$m.contract.manifestSha256;contractSha256=$m.contractSha256;readyAt=(UtcNow);standby=$true;idleClaimed=$false;transportProof='retain_actual_RDC_start_process_response'}
    Write-JsonAtomic (Operation-File 'readiness.json') $ready;W41-Phase $m $worker 'READY_STANDBY'
    $ready|ConvertTo-Json -Depth 14 -Compress
    while($true){
      if((Read-Json (Operation-File 'state.json')).state -ceq 'CLOSED'){return}
      if([DateTimeOffset]::UtcNow -ge (Rdc-Time $m.operationExpiresAt)){W41-Phase $m $worker 'EXPIRED';return}
      $null=W41-Binding -Activation;$null=Rdc-Ancestry $m
      Write-JsonAtomic (Operation-File 'heartbeat.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;deviceId=$DeviceId;phase='READY_STANDBY';worker=$worker;heartbeatAt=(UtcNow)}
      $request=Read-Json (Operation-File 'activate.request.json')
      if($request){
        if($request.operationId -cne $OperationId -or $request.nonce -cne $Nonce -or $request.metadataSha256 -cne $MetadataSha256 -or $request.deviceId -cne $DeviceId -or $request.action -cne 'activate'){throw '17841 foreign activation request refused'}
        W41-RequestProof $m $ready $request.handoffPath $request.handoffSha256 $request.transportReceiptPath $request.transportReceiptSha256
        $control=[IO.File]::Open((Operation-File 'control.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try{
          if((Read-Json (Operation-File 'state.json')).state -cne 'READY_STANDBY'){throw '17841 activation no longer accepted'}
          Rdc-New (Operation-File 'activation.claim.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;handoffSha256=$request.handoffSha256;transportReceiptSha256=$request.transportReceiptSha256;claimedAt=(UtcNow)}
          W41-Phase $m $worker 'ACTIVATION_CLAIMED'
        }finally{$control.Dispose()}
        try{$result=W41-Activate $m $worker}catch{$result=W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'guard_or_observation_failed_no_automatic_replay';$result.lastPhase=(Read-Json (Operation-File 'state.json')).state}
        Rdc-New (Operation-File 'result.json') $result;W41-Phase $m $worker $result.state
        $result|ConvertTo-Json -Depth 12 -Compress;return
      }
      Start-Sleep -Seconds $HeartbeatSeconds
    }
  }finally{$lock.Dispose()}
}
function W41-Close {
  $null=W41-Binding -ReadOnly
  $control=[IO.File]::Open((Operation-File 'control.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    $state=Read-Json (Operation-File 'state.json')
    if($state.state -notin @('ARMED','READY_STANDBY','EXPIRED','NOT_ACTIVATED','NO_CHANGE','ACTIVATED','RECOVERED')){throw '17841 active/unknown/HOLD capsule must be reconciled before close'}
    if($state.state -in @('ARMED','READY_STANDBY') -and (Test-Path -LiteralPath (Operation-File 'activate.request.json'))){throw '17841 pending activation cannot be cancelled by close'}
    Write-JsonAtomic (Operation-File 'state.json') @{state='CLOSED';operationId=$OperationId;updatedAt=(UtcNow)}
    @{ok=$true;state='CLOSED';operationId=$OperationId;target='17841-only'}|ConvertTo-Json -Compress
  }finally{$control.Dispose()}
}

$webRuntimeBranch=$Transport -ceq 'rdc-17841'
if($Mode -ne 'arm' -and $OperationId -match $OperationIdPattern){
  $webRuntimeMetadata=Read-Json (Operation-File 'metadata.json')
  if($webRuntimeMetadata -and $webRuntimeMetadata.schema -ceq 'aicc-rdc-17841-recovery/v1'){$webRuntimeBranch=$true}
}
if($webRuntimeBranch){
  try{
    if($PSVersionTable.PSVersion -lt [version]'7.5'){throw '17841 device recovery requires PowerShell 7.5+'}
    switch($Mode){'arm'{W41-Arm};'watch'{W41-Watch};'status'{W41-Status};'signal'{W41-Signal};'close'{W41-Close};default{throw '17841 has no owner-exit trigger'}}
  }catch{
    # Never echo parser/native error text: config and prior journals contain
    # authentication material. Exact phase and output digests remain in capsule.
    @{ok=$false;state='HOLD';target='17841-only';operationId=$OperationId;reason='capsule_guard_or_observation_refused';errorType=$_.Exception.GetType().Name;noReplay=$true}|ConvertTo-Json -Compress
    exit 1
  }
  return
}

$deviceBranch=$Transport -ceq 'rdc-device'
if($Mode -ne 'arm' -and $OperationId -match $OperationIdPattern){
  $existing=Read-Json (Operation-File 'metadata.json')
  if($existing -and $existing.schema -ceq 'aicc-rdc-ocx-recovery/v1'){$deviceBranch=$true}
}
if($deviceBranch){
  if($PSVersionTable.PSVersion -lt [version]'7.5'){throw 'Device recovery requires PowerShell 7.5+'}
  switch($Mode){'arm'{Rdc-Arm};'watch'{Rdc-Watch};'status'{Rdc-Status};'signal'{Rdc-Signal};'close'{Rdc-Close};default{throw 'Device branch has no owner-exit binding'}}
  return
}
switch ($Mode) {
  'arm' { Arm }
  'watch' { Watch }
  'status' { Status }
  'signal' { Signal }
  'bind-owner' { Bind-Owner }
  'close' { Close }
}
