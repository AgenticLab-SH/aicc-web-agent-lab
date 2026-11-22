#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SnapshotPath,[Parameter(Mandatory)][string]$ReleaseManifestPath,
  [ValidateRange(1,30)][int]$Minutes=20,
  [string]$RecoveryOperationId,[string]$RecoveryNonce,[string]$RecoveryMetadataSha256,[string]$DeviceId)
$ErrorActionPreference='Stop'
$allowed=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center\backups\runtime-layout\'
$SnapshotPath=[IO.Path]::GetFullPath($SnapshotPath)
if(-not $SnapshotPath.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Owned exact snapshot required'}
# One bounded existing RDC transaction; no schedule, model resend or manual-recovery fallback.
if($RecoveryOperationId -or $RecoveryNonce -or $RecoveryMetadataSha256 -or $DeviceId){
  if($RecoveryOperationId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$' -or $RecoveryNonce -notmatch '^[a-f0-9]{32}$' -or $RecoveryMetadataSha256 -notmatch '^[a-f0-9]{64}$'){throw 'Exact operation-bound RDC arguments required'}
  $recovery=Join-Path $PSScriptRoot '..\aicc\Invoke-AiccRemoteRecovery.ps1'
  $capsule=Join-Path ([Environment]::GetFolderPath('UserProfile')) ('.codex\ops\webgpt-remote-recovery\operations\'+$RecoveryOperationId)
  $metadataFile=Join-Path $capsule 'metadata.json'
  if((Get-FileHash -LiteralPath $metadataFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RecoveryMetadataSha256){throw 'Recovery metadata changed'}
  $m=Get-Content -LiteralPath $metadataFile -Raw|ConvertFrom-Json -DateKind String
  if($m.schema -cne 'aicc-rdc-ocx-recovery/v1' -or $m.snapshotPath -ine $SnapshotPath -or $m.releaseManifestPath -ine [IO.Path]::GetFullPath($ReleaseManifestPath) -or $m.nonce -cne $RecoveryNonce -or $m.deviceId -cne $DeviceId -or $m.workerScript -ine [IO.Path]::GetFullPath($recovery)){throw 'Existing transaction binding differs'}
  if($m.PSObject.Properties['deviceRegistration']){
    $module=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\aicc\Recovery-DeviceBinding.psm1'))
    for($cursor=$module;$cursor;$cursor=Split-Path -Parent $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked recovery device module refused'}}
    if($m.deviceRegistration.modulePath -ine $module -or (Get-FileHash -LiteralPath $module -Algorithm SHA256).Hash.ToLowerInvariant() -cne $m.deviceRegistration.moduleSha256){throw 'Pinned recovery device module changed'}
    Import-Module -Name $module -Force
    Assert-AiccRecoveryDeviceMetadata -Metadata $m
  }elseif($DeviceId -cne '32002de6-dd98-4da6-9423-7d1032bfec6e'){throw 'New device requires exact immutable registered host attestation'}
  $deadline=[DateTimeOffset]::UtcNow.AddMinutes($Minutes)
  $expiry=[DateTimeOffset]::Parse($m.operationExpiresAt)
  if($expiry -lt $deadline){$deadline=$expiry}
  $recordPath=Join-Path $SnapshotPath 'rdc-idle-result.json'
  $claimPath=Join-Path $SnapshotPath 'rdc-idle-claim.json'
  if(Test-Path -LiteralPath $recordPath){throw 'Terminal wait already exists; reconcile without replay'}
  $claim=[IO.File]::Open($claimPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bytes=[Text.Encoding]::UTF8.GetBytes(($RecoveryOperationId+':'+$PID));$claim.Write($bytes);$claim.Flush($true)}finally{$claim.Dispose()}
  $recoveryArgs=@{Transport='rdc-device';OperationId=$RecoveryOperationId;Nonce=$RecoveryNonce;MetadataSha256=$RecoveryMetadataSha256;DeviceId=$DeviceId}
  $state='WAIT_EXPIRED';$samples=0;$owner=0;$signalled=$false;$active=$null
  try{
    Write-Output ('Waiting for exact idle; operation='+$RecoveryOperationId+'; deadline='+$deadline.ToString('o'))
    while([DateTimeOffset]::UtcNow -lt $deadline){
      $s=& $recovery -Mode status @recoveryArgs|ConvertFrom-Json -DateKind String
      if(-not $s.ok -or -not $s.heartbeatFresh){throw 'Fresh independent READY unavailable; no activation'}
      $ready=$null;$active=$null
      try{$ready=Invoke-RestMethod -Uri 'http://127.0.0.1:10100/readyz' -TimeoutSec 3}catch{}
      if($ready -and ($ready.localActive -is [int] -or $ready.localActive -is [long]) -and $ready.localActive -ge 0){$active=$ready.localActive}
      if($null -ne $active -and $active -eq 0 -and $ready.ready -ceq $true){
        $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$ready.pid)
        $snapshot=Get-Content -LiteralPath (Join-Path $SnapshotPath 'snapshot.json') -Raw|ConvertFrom-Json
        if(-not $p -or $p.Name -ine 'bun.exe' -or -not $p.CommandLine.Contains([string]$snapshot.previous.cliPath) -or $ready.version -cne $snapshot.previous.version){throw 'Expected OCX owner changed'}
        if($owner -and $owner -ne $ready.pid){throw 'OCX generation changed while waiting'}
        $owner=$ready.pid;$samples++
      }else{$samples=0}
      if($samples -ge 5){
        $signal=& $recovery -Mode signal @recoveryArgs -SignalAction activate|ConvertFrom-Json
        if(-not $signal.ok -or $signal.state -cne 'REQUESTED'){throw 'Activation signal outcome unconfirmed; no replay'}
        $signalled=$true;$state='REQUESTED';break
      }
      Start-Sleep -Seconds 1
    }
  }catch{$state=if($signalled){'RECONCILE_REQUIRED'}else{'NOT_ACTIVATED'};$reason=$_.Exception.Message}
  $result=@{schema='aicc-rdc-idle-wait/v1';operationId=$RecoveryOperationId;state=$state;activationRequested=$signalled;lastActive=$active;idleSamples=$samples;expiresAt=$deadline.ToString('o');completedAt=[DateTimeOffset]::UtcNow.ToString('o');noReplay=$true;originalRequestsReplayed=$false}
  if(Get-Variable -Name reason -Scope Local -ErrorAction SilentlyContinue){$result.reason=$reason}
  $stream=[IO.File]::Open($recordPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bytes=[Text.Encoding]::UTF8.GetBytes(($result|ConvertTo-Json -Depth 6));$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
  $result|ConvertTo-Json -Depth 6
  exit
}
$resultFile=Join-Path $SnapshotPath 'deferred-result.json'
if(Test-Path -LiteralPath $resultFile){throw 'Terminal operation already exists; no replay'}
$lock=[IO.File]::Open((Join-Path $SnapshotPath 'deferred.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$utf8=[Text.UTF8Encoding]::new($false)
function WriteRecord([string]$p,$v){$temporary=$p+'.tmp';[IO.File]::WriteAllText($temporary,($v|ConvertTo-Json -Depth 6),$utf8);Move-Item -LiteralPath $temporary -Destination $p -Force}
$helper=Join-Path $PSScriptRoot 'Invoke-AiccOcxTransition.ps1'
$probe=Join-Path $PSScriptRoot 'probe-installed-external.ts'
$pins=@{helper=(Get-FileHash -LiteralPath $helper).Hash;probe=(Get-FileHash -LiteralPath $probe).Hash;manifest=(Get-FileHash -LiteralPath $ReleaseManifestPath).Hash}
$deadline=[DateTimeOffset]::UtcNow.AddMinutes($Minutes)
$beforeBridge=Invoke-RestMethod http://127.0.0.1:17841/readyz -TimeoutSec 5
$snapshot=Get-Content -LiteralPath (Join-Path $SnapshotPath 'snapshot.json') -Raw|ConvertFrom-Json
$count=0;$ownerPid=0;$attempted=$false
try {
  do {
    if((Get-FileHash -LiteralPath $helper).Hash -cne $pins.helper -or (Get-FileHash -LiteralPath $probe).Hash -cne $pins.probe -or (Get-FileHash -LiteralPath $ReleaseManifestPath).Hash -cne $pins.manifest){throw 'Pinned maintenance code changed'}
    $ready=$null
    try{$ready=Invoke-RestMethod http://127.0.0.1:10100/readyz -TimeoutSec 3}catch{}
    if($ready -and $ready.adapterVersion -ceq '0.1.0' -and $ready.localActive -ceq 0){
      if($ownerPid -and $ownerPid -ne $ready.pid){throw 'OCX owner changed while waiting'}
      $ownerPid=$ready.pid;$count++
    }else{$count=0}
    WriteRecord (Join-Path $SnapshotPath 'deferred-state.json') @{state='WAITING_EXACT_IDLE';workerPid=$PID;heartbeatAt=[DateTimeOffset]::UtcNow.ToString('o');expiresAt=$deadline.ToString('o');idleSamples=$count;active=if($ready){$ready.localActive}else{$null}}
    if($count -ge 5){break}
    Start-Sleep -Seconds 1
  } while([DateTimeOffset]::UtcNow -lt $deadline)
  if($count -lt 5){throw 'Idle deadline expired; active work preserved'}
  $attempted=$true
  $activation=& $helper -Mode Activate -ManualRecovery -SnapshotPath $SnapshotPath -ReleaseManifestPath $ReleaseManifestPath
  if(($activation|ConvertFrom-Json).state -cne 'ACTIVATED'){throw 'Transition did not complete'}
  $registryFile=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center\runtime\ocx-local\current.json'
  $registry=Get-Content -LiteralPath $registryFile -Raw|ConvertFrom-Json
  $verification=& $registry.bunPath $probe
  if($LASTEXITCODE -ne 0){throw 'Installed canary failed; no replay'}
  $canary=$verification|ConvertFrom-Json
  $afterBridge=Invoke-RestMethod http://127.0.0.1:17841/readyz -TimeoutSec 5
  $native=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\config.toml'
  if($afterBridge.pid -ne $beforeBridge.pid -or (Get-FileHash -LiteralPath $native).Hash.ToLowerInvariant() -cne $snapshot.nativeSha256){throw 'Non-target identity changed; preserve for investigation'}
  WriteRecord $resultFile @{status='PASS';operation='ocx-clean-wire-closure';at=[DateTimeOffset]::UtcNow.ToString('o');canary=$canary;bridgePidPreserved=$true;nativeConfigUnchanged=$true;automaticReplay=$false}
} catch {
  $rolledBack=$false
  if($attempted -and (Test-Path -LiteralPath (Join-Path $SnapshotPath 'activation.json'))){
    try{$restoration=& $helper -Mode Rollback -SnapshotPath $SnapshotPath;$rolledBack=($restoration|ConvertFrom-Json).state -in @('RESTORED','NO_CHANGE')}catch{}
  }
  WriteRecord $resultFile @{status='HOLD';operation='ocx-clean-wire-closure';at=[DateTimeOffset]::UtcNow.ToString('o');code=$_.Exception.Message;activationAttempted=$attempted;rolledBack=$rolledBack;automaticReplay=$false}
} finally {$lock.Dispose()}
