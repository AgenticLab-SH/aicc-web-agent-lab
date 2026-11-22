param([Parameter(Mandatory)][string]$OperationId,[Parameter(Mandatory)][string]$Nonce,[ValidateRange(1,240)][int]$Minutes=180)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($OperationId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{5,63}$' -or $Nonce -notmatch '^[0-9a-f]{32}$') { throw 'Invalid operation binding' }
$root=Join-Path $env:USERPROFILE ('.ai-control-center\control-plane\file-mailboxes\'+$OperationId)
$manifest=Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.operationId -ne $OperationId -or $manifest.nonce -cne $Nonce) { throw 'Mailbox identity mismatch' }
$worker=Join-Path $root 'webgpt\worker'
New-Item -ItemType Directory -Path $worker -Force | Out-Null
foreach($p in @($root,(Split-Path $root),(Join-Path $root 'webgpt'),$worker)) {
  if ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked worker path refused' }
}
# OS-held lock survives stale files and excludes competing live workers.
$lock=[IO.File]::Open((Join-Path $worker 'watch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$utf8=[Text.UTF8Encoding]::new($false)
$expires=[DateTime]::UtcNow.AddMinutes($Minutes)
$lastObservation=''
function Publish([object]$v) {
  $file=Join-Path $worker 'heartbeat.json'
  $tmp=$file+".$PID.tmp"
  [IO.File]::WriteAllText($tmp,($v|ConvertTo-Json -Depth 5),$utf8)
  Move-Item -LiteralPath $tmp -Destination $file -Force
}
try {
  do {
    $stopFile=Join-Path $root 'control\stop.json'
    $state='MONITORING'
    if (Test-Path -LiteralPath $stopFile -PathType Leaf) {
      $stop=Get-Content -LiteralPath $stopFile -Raw | ConvertFrom-Json
      if ($stop.operationId -eq $OperationId -and $stop.nonce -ceq $Nonce) { $state='CLOSED' }
    }
    if ([DateTime]::UtcNow -ge $expires) { $state='EXPIRED' }
    $health=[ordered]@{}
    foreach($entry in @(@('ocx','http://127.0.0.1:10100/readyz'),@('bridge','http://127.0.0.1:17841/healthz'))) {
      try { $r=Invoke-WebRequest -Uri $entry[1] -UseBasicParsing -TimeoutSec 2; $health[$entry[0]]=[int]$r.StatusCode }
      catch { $health[$entry[0]]='UNAVAILABLE' }
    }
    $queue=@(Get-ChildItem -LiteralPath (Join-Path $root 'codex') -File -Filter '*.json' | Sort-Object LastWriteTimeUtc | Select-Object -Last 20 | ForEach-Object {
      if ($_.Length -gt 131072 -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe coordinator message' }
      $m=Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($m.operationId -ne $OperationId -or $m.nonce -cne $Nonce -or $m.writer -ne 'codex') { throw 'Coordinator message identity mismatch' }
      [ordered]@{messageId=$m.messageId;bodySha256=$m.bodySha256;sentAt=$m.sentAt}
    })
    $snapshot=[ordered]@{schema='aicc-file-monitor/v1';operationId=$OperationId;nonce=$Nonce;state=$state;startedBy='webgpt-remote-command-tunnel';watcherPid=$PID;processStartedAt=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o');heartbeatAt=[DateTime]::UtcNow.ToString('o');expiresAt=$expires.ToString('o');health=$health;coordinatorQueue=$queue;automaticExecution=$false;automaticRecovery=$false}
    Publish $snapshot
    $observation=ConvertTo-Json -InputObject @($state,$health,$queue) -Depth 5 -Compress
    if ($observation -cne $lastObservation) {
      $events=Join-Path $worker 'events'
      New-Item -ItemType Directory -Path $events -Force | Out-Null
      $eventPath=Join-Path $events ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')+'-'+[Guid]::NewGuid().ToString('N')+'.json')
      $eventTemp=$eventPath+'.$PID.tmp'
      [IO.File]::WriteAllText($eventTemp,($snapshot|ConvertTo-Json -Depth 6),$utf8)
      [IO.File]::Move($eventTemp,$eventPath)
      $lastObservation=$observation
    }
    if ($state -ne 'MONITORING') { break }
    Start-Sleep -Seconds 10
  } while ($true)
} finally { $lock.Dispose() }
