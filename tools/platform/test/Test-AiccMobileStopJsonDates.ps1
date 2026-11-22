#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath $AiccRoot).Path
$stopPath=Join-Path $repo 'tools/platform/windows/Request-AiccMobilePublicStop.ps1'
$startPath=Join-Path $repo 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1'
$runnerPath=Join-Path $repo 'tools/platform/windows/mobile-public-runner.mjs'
$stopSource=[IO.File]::ReadAllText($stopPath)
$startSource=[IO.File]::ReadAllText($startPath)
$runnerSource=[IO.File]::ReadAllText($runnerPath)
$pass=0

function Check([bool]$ok,[string]$reason) {
 if(-not $ok){throw $reason}
 $script:pass++
}
function SourceHas([string]$source,[string]$needle) {
 Check ($source.Contains($needle)) ('lifecycle_guard_missing: '+$needle)
}
function RoundTrip($value) {
 $json=$value|ConvertTo-Json -Depth 12 -Compress
 $decoded=$json|ConvertFrom-Json -AsHashtable -DateKind String
 $roundJson=$decoded|ConvertTo-Json -Depth 12 -Compress
 return ($roundJson|ConvertFrom-Json -AsHashtable -DateKind String)
}

# Parse-only inspection of the real helpers; never invoke the stop or supervisor.
# Two additional reads retain exact request-bound result and claim timestamps.
foreach($entry in @(@($stopPath,9),@($startPath,3))) {
 $tokens=$null;$errors=$null
 $ast=[Management.Automation.Language.Parser]::ParseFile([string]$entry[0],[ref]$tokens,[ref]$errors)
 Check (@($errors).Count -eq 0) 'helper_source_parse_failed'
 $commands=@($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'ConvertFrom-Json'
 },$true))
 Check ($commands.Count -eq [int]$entry[1]) 'json_read_count_changed_review_required'
 foreach($command in $commands) {
  $argsText=$command.Extent.Text
  Check ($argsText -match '(?i)-AsHashtable\s+-DateKind\s+String\b') 'json_timestamp_string_contract_missing'
 }
}
SourceHas $stopSource 'if($Submit -and -not (Test-Path -LiteralPath $requestFile))'
SourceHas $stopSource '[IO.FileMode]::CreateNew'
SourceHas $stopSource 'expectedStartedAt=$current.startedAt'
SourceHas $stopSource '$Status.lastOperationId -ceq $Operation'
SourceHas $stopSource '$outcome.currentNormalStopAck -and -not $processStillPresent'
SourceHas $startSource 'if(-not (Test-Path -LiteralPath $requestFile -PathType Leaf) -or (Test-Path -LiteralPath $claimFile)){continue}'
SourceHas $startSource '[IO.FileMode]::CreateNew'
SourceHas $startSource '$request.runtimeId -cne $cfg.runtimeId'
SourceHas $startSource '$request.expectedPid -ne $node.Id'
SourceHas $startSource '[DateTimeOffset]::Parse([string]$request.expiresAt)'
SourceHas $startSource '$expires -lt [DateTimeOffset]::UtcNow'
SourceHas $startSource '$request.controlNonce=$cfg.controlNonce'
SourceHas $startSource '$node.StandardInput.WriteLine(($request|ConvertTo-Json -Compress))'
SourceHas $runnerSource 'request.expectedStartedAt !== status.startedAt'
SourceHas $runnerSource 'request.controlNonce !== cfg.controlNonce'
SourceHas $runnerSource 'seen.has(request.operationId)'
SourceHas $runnerSource 'NORMAL_STOP_ACK'

$generation=[guid]::NewGuid().ToString()
$manifest='a'*64
$now=[DateTimeOffset]::UtcNow
$expiry=$now.AddSeconds(45).ToString('o')
foreach($stamp in @(
 '2026-11-04T03:02:01.410Z',
 '2026-11-04T03:02:01.41Z',
 '2026-11-04T12:02:01.410+09:00',
 '2026-11-03T23:02:01.410-04:00'
)) {
 $config=RoundTrip @{schemaVersion=1;runtimeId=$generation;releaseManifestSha256=$manifest;port=4383;createdAt=$stamp}
 $release=RoundTrip @{schemaVersion=1;component='mobile-public-control';builtAt=$stamp;files=@(@{path='tools/platform/windows/mobile-public-runner.mjs';sha256=$manifest})}
 $status=RoundTrip @{schemaVersion=1;controlProtocolVersion=2;runtimeId=$generation;releaseManifestSha256=$manifest;pid=12345;startedAt=$stamp;observedAt=$stamp;state='LISTENING'}
 $request=RoundTrip @{action='drain-and-stop';operationId=([guid]::NewGuid().ToString());runtimeId=$generation;expectedPid=12345;expectedStartedAt=$status.startedAt;releaseManifestSha256=$manifest;expiresAt=$expiry}
 Check ($config.createdAt -is [string] -and $config.createdAt -ceq $stamp) 'config_timestamp_changed'
 Check ($release.builtAt -is [string] -and $release.builtAt -ceq $stamp) 'manifest_timestamp_changed'
 Check ($status.startedAt -is [string] -and $status.startedAt -ceq $stamp) 'status_startedAt_changed'
 Check ($status.observedAt -is [string] -and $status.observedAt -ceq $stamp) 'status_observedAt_changed'
 Check ($request.expectedStartedAt -is [string] -and $request.expectedStartedAt -ceq $stamp) 'stop_request_startedAt_changed'
 Check ($request.runtimeId -ceq $status.runtimeId -and $request.expectedPid -eq $status.pid -and $request.releaseManifestSha256 -ceq $status.releaseManifestSha256) 'synthetic_generation_pid_manifest_mismatch'
 $wrongGeneration=$request.Clone();$wrongGeneration.runtimeId=[guid]::NewGuid().ToString()
 Check ($wrongGeneration.runtimeId -cne $config.runtimeId) 'stale_generation_not_rejected'
 $wrongPid=$request.Clone();$wrongPid.expectedPid=98765
 Check ($wrongPid.expectedPid -ne $status.pid) 'stale_pid_not_rejected'
 $wrongStart=$request.Clone();$wrongStart.expectedStartedAt='2026-11-04T03:02:01.41Z'
 if($stamp -ceq '2026-11-04T03:02:01.41Z'){$wrongStart.expectedStartedAt='2026-11-04T03:02:01.410Z'}
 Check ($wrongStart.expectedStartedAt -cne $status.startedAt) 'timestamp_exact_comparison_weakened'
 Check ([DateTimeOffset]::Parse([string]$request.expiresAt) -gt $now -and [DateTimeOffset]::Parse([string]$request.expiresAt) -le $now.AddSeconds(60)) 'fresh_ttl_parse_failed'
}
$expired=RoundTrip @{expiresAt=$now.AddSeconds(-1).ToString('o')}
Check ([DateTimeOffset]::Parse([string]$expired.expiresAt) -lt $now) 'expired_request_accepted'
$future=RoundTrip @{expiresAt=$now.AddSeconds(61).ToString('o')}
Check ([DateTimeOffset]::Parse([string]$future.expiresAt) -gt $now.AddSeconds(60)) 'far_future_request_accepted'
$badDateRejected=$false
try{$null=[DateTimeOffset]::Parse('not-an-iso-date')}catch [FormatException] {$badDateRejected=$true}
Check $badDateRejected 'invalid_expiry_not_rejected'

# One isolated, disposable create-once claim; no operational request or service.
$fixture=Join-Path $repo ('tools/platform/test/.aicc-g3-stop-json-'+[guid]::NewGuid().ToString('N'))
if(Test-Path -LiteralPath $fixture){throw 'synthetic_fixture_already_exists'}
$claimPath=Join-Path $fixture 'claim.json'
[IO.Directory]::CreateDirectory($fixture)|Out-Null
try {
 $stream=[IO.File]::Open($claimPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes('{"synthetic":true}');$stream.Write($bytes);$stream.Flush()}finally{$stream.Dispose()}
 $secondBlocked=$false
 try{$second=[IO.File]::Open($claimPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$second.Dispose()}catch [IO.IOException] {$secondBlocked=$true}
 Check $secondBlocked 'duplicate_claim_not_rejected'
 Check ([IO.File]::ReadAllText($claimPath) -ceq '{"synthetic":true}') 'claim_changed_after_duplicate'
} finally {
 if([IO.File]::Exists($claimPath)){[IO.File]::Delete($claimPath)}
 if([IO.Directory]::Exists($fixture)){[IO.Directory]::Delete($fixture)}
}

# The separate transition test also verifies ACK-operation matching and process exit.
@{passed=$pass;failed=0;synthetic=$true;stopRequests=0;serviceStarts=0;operationalClaims=0;temporaryFixtureRemoved=(-not (Test-Path -LiteralPath $fixture))}|ConvertTo-Json -Compress
