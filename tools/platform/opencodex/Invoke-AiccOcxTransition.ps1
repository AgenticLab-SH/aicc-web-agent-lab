[CmdletBinding()]
param([ValidateSet('Prepare','Activate','Rollback','Status','Recover')][string]$Mode='Status',
  [string]$SnapshotPath,[string]$ReleaseManifestPath,[string]$RecoveryOperationId,[string]$RecoveryNonce,[switch]$ManualRecovery,
  [string]$RecoveryMetadataSha256,[string]$PlannedOfflineDecisionPath,[string]$LocalRecoveryReadyPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Assert-AiccOcxShippingAcceptance.ps1')
$ownerRoot=[Environment]::GetFolderPath('UserProfile')
$controlRoot=Join-Path $ownerRoot '.ai-control-center'
$registryFile=Join-Path $controlRoot 'runtime\ocx-local\current.json'
$serviceHome=Join-Path $controlRoot 'runtime\ocx-local\home'
$legacyHome=Join-Path $ownerRoot '.opencodex'
$wrapperFile=Join-Path $legacyHome 'opencodex-service.cmd'
$launcherFile=Join-Path $legacyHome 'opencodex-service-launcher.vbs'
$stateFile=Join-Path $legacyHome 'service-state.json'
$homeStateFile=Join-Path $serviceHome 'service-state.json'
$nativeFile=Join-Path $ownerRoot '.codex\config.toml'
$taskName='opencodex-proxy'
$utf8=[Text.UTF8Encoding]::new($false)
$script:deviceRecovery=$null
$script:transitionProgress=$null
function Hash([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function SharedLaunchCommand($Release,[string]$Root,[string]$Bun,[string]$Cli,[string]$Manifest){
  if(-not $Release.PSObject.Properties['sharedLauncher']){return ('"'+$Bun+'" "'+$Cli+'" "'+$Manifest+'"')}
  $policy=$Release.sharedLauncher
  $operating=$policy.PSObject.Properties['artifactContract'] -and $policy.artifactContract -ceq 'shipping-cli-appserver/v2'
  $shipping=$operating -or ($policy.PSObject.Properties['artifactContract'] -and $policy.artifactContract -ceq 'shipping-cli-appserver/v1')
  $members=@('original-issuer-shared-launcher.exe','original-issuer-bootstrap.node')
  if($shipping){$members+=@('codex.exe','codex-app-server.exe')}
  # Candidate provenance does not grant operating acceptance. Reject before any
  # lifecycle stop; JSON flags cannot authorize a new caller.
  if($policy.protocol -cne 'retained-child-bootstrap/v1' -or
     ($policy.PSObject.Properties['artifactContract'] -and -not $shipping) -or
     $policy.originalTuiAttachment -cne $(if($operating){'ACTUAL_SHIPPING_ACCEPTED'}elseif($shipping){'SHIPPING_BUILD_CANDIDATE_ONLY'}else{'NOT_IMPLEMENTED'}) -or
     $policy.canActivate -cne [bool]$operating){throw 'Unsupported shared launcher attachment contract'}
  if(@($Release.nativeAdapterFiles.PSObject.Properties).Count -ne $members.Count){throw 'Exact native shared launcher inventory required'}
  foreach($name in $members){
    $pin=$Release.nativeAdapterFiles.PSObject.Properties[$name]
    if(-not $pin -or $pin.Value -cnotmatch '^[a-f0-9]{64}$'){throw 'Pinned native shared launcher member required'}
    $file=Join-Path $Root $name;Regular $file
    if((Hash $file) -cne $pin.Value){throw 'Shared launcher release member changed'}
  }
  if((Hash $Bun) -cne $policy.bunSha256){throw 'Shared launcher Bun pin changed'}
  if($shipping){
    if($policy.codexClientVersion -cne '0.166.0' -or $Release.codexClientVersion -cne '0.166.0' -or
       $policy.shippingBuildSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Shipping build provenance required'}
    if(-not $operating){throw 'Shipping original TUI operating acceptance pending; no stop or replacement start'}
    if(-not (Get-Command Assert-AiccOcxShippingAcceptance -ErrorAction SilentlyContinue)){. (Join-Path $PSScriptRoot 'Assert-AiccOcxShippingAcceptance.ps1')}
    $nativePins=@{};foreach($p in $Release.nativeAdapterFiles.PSObject.Properties){$nativePins[$p.Name]=$p.Value}
    $adapterPins=@{};foreach($p in $Release.adapterFiles.PSObject.Properties){$adapterPins[$p.Name]=$p.Value}
    $null=Assert-AiccOcxShippingAcceptance -Path (Join-Path $Root 'shipping-evidence/shipping-operating-acceptance.json') -Sha256 $policy.operatingAcceptanceSha256 -NativePins $nativePins -AdapterPins $adapterPins
    return ('"'+(Join-Path $Root 'original-issuer-shared-launcher.exe')+'" --run')
  }
  throw 'Original TUI capability caller not implemented; no stop or replacement start'
}
function ReadJson([string]$Path){
  $json=Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')){return $json|ConvertFrom-Json -DateKind String}
  $json|ConvertFrom-Json
}
function AtomicText([string]$Path,[string]$Text){
  $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temporary,$Text,$utf8)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}
function TextHash([string]$Text){
  $sha=[Security.Cryptography.SHA256]::Create()
  try{([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($Text)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Atomic([string]$Path,[object]$Value){
  $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 15),$utf8)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}
function Regular([string]$Path){
  for($cursor=[IO.Path]::GetFullPath($Path);$cursor;$cursor=Split-Path -Parent $cursor){
    if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked software path refused'}}
  }
  if((Get-Item -LiteralPath $Path).PSIsContainer){throw 'Regular software file required'}
}
function TaskOwner{
  $task=Get-ScheduledTask -TaskName $taskName
  if(@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32\wscript.exe') -or $task.Actions[0].Arguments -cne ('/b /nologo "'+$launcherFile+'"')){throw 'Existing task owner changed'}
  $task
}
function Ready{
  try{Invoke-RestMethod -Uri 'http://127.0.0.1:10100/readyz' -NoProxy -TimeoutSec 5}
  catch{[Console]::Error.WriteLine('OCX readiness unavailable: '+$_.Exception.Message);$null}
}
function KnownActiveCount($Value){
  if(($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt 0 -or $Value -gt [int]::MaxValue){throw 'Actual active count is null, malformed or unknown; no stop'}
  return [int]$Value
}
function Active{
  $ready=Ready
  if(-not $ready){return $null}
  if($ready.PSObject.Properties.Name -contains 'localActive'){return (KnownActiveCount $ready.localActive)}
  $admin=[IO.File]::ReadAllText((Join-Path $serviceHome 'admin-api-token')).Trim()
  $memory=Invoke-RestMethod -Uri 'http://127.0.0.1:10100/api/system/memory' -Headers @{'x-opencodex-api-key'=$admin} -TimeoutSec 3
  if($memory.PSObject.Properties.Name -notcontains 'activeTurnCount'){throw 'Actual full-response counter unavailable'}
  KnownActiveCount $memory.activeTurnCount
}
function Test-OwnedOcxProcess($Process,[string]$Cli,[string]$Wrapper,[string]$Launcher){
  if(-not $Process.CommandLine){return $false}
  if($Process.Name -ieq 'original-issuer-shared-launcher.exe'){
    # The retained shared host has neither the TS entry nor wrapper in argv.
    # Match the exact release member and sole operating argument; preserve
    # --check probes, foreign images and command-line substring lookalikes.
    $shared=Join-Path (Split-Path $Cli -Parent) 'original-issuer-shared-launcher.exe'
    return ($Process.ExecutablePath -and $Process.ExecutablePath -ieq $shared -and
      ([string]$Process.CommandLine).Trim() -imatch ('^(?:"'+[regex]::Escape($shared)+'"|'+[regex]::Escape($shared)+')\s+--run$'))
  }
  return ($Process.Name -in @('bun.exe','cmd.exe','wscript.exe') -and
    ($Process.CommandLine.Contains($Cli) -or $Process.CommandLine.Contains($Wrapper) -or $Process.CommandLine.Contains($Launcher)))
}
function Owned([string]$Cli){
  @(Get-CimInstance Win32_Process|Where-Object{Test-OwnedOcxProcess $_ $Cli $wrapperFile $launcherFile})
}
function OwnerPins($Processes){
  @($Processes|Sort-Object ProcessId|ForEach-Object {[ordered]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;createdTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString();image=$_.ExecutablePath;commandSha256=(TextHash ([string]$_.CommandLine))}})
}
function TransitionPhase([string]$Phase){
  if($script:transitionProgress){$script:transitionProgress.phase=$Phase;$script:transitionProgress.observedAt=[DateTime]::UtcNow.ToString('o');Atomic (Join-Path $SnapshotPath 'transition-state.json') $script:transitionProgress}
}
function ReadyOwned([string]$ExpectedCli,[string]$ExpectedVersion){
  $ready=Ready
  if(-not $ready -or $ready.version -cne $ExpectedVersion){return $null}
  if($ready.PSObject.Properties.Name -contains 'ready' -and $ready.ready -cne $true){return $null}
  $owners=@(Owned $ExpectedCli|Where-Object {$_.ProcessId -eq $ready.pid -and $_.Name -ieq 'bun.exe' -and $_.CommandLine.Contains($ExpectedCli)})
  if($owners.Count -ne 1){return $null}
  return $ready
}
function StopOwned([string]$Cli){
  $null=TaskOwner
  $processes=Owned $Cli
  $beforePins=OwnerPins $processes
  if($script:transitionProgress){$script:transitionProgress.originalProcesses=$beforePins}
  TransitionPhase 'STOP_INTENT'
  $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -in @(10100,10101)})
  foreach($listener in $listeners){if($listener.OwningProcess -notin @($processes.ProcessId)){throw 'Foreign data listener preserved'}}
  if($listeners.Count){
    $active=Active
    for($attempt=0;$attempt -lt 180 -and $null -ne $active -and $active -ne 0;$attempt++){
      Start-Sleep -Milliseconds 250
      $active=Active
    }
    if($null -eq $active -or $active -ne 0){throw 'OCX has active or unknown response lifetime; no stop'}
    $ready=Ready
    if($ready.PSObject.Properties.Name -contains 'adapterVersion'){
      TransitionPhase 'DRAIN_INTENT'
      $admin=[IO.File]::ReadAllText((Join-Path $serviceHome 'admin-api-token')).Trim()
      $drain=Invoke-RestMethod -Uri 'http://127.0.0.1:10100/api/aicc-local/drain' -Method Post -Headers @{Authorization='Bearer '+$admin} -TimeoutSec 3
      if(-not $drain.idle){throw 'New OCX drain has active responses; no stop'}
      TransitionPhase 'DRAIN_ACKNOWLEDGED'
    }
    if((Active) -ne 0){throw 'OCX acquired a response before stop; preserve it'}
  }
  if((ConvertTo-Json -InputObject (OwnerPins (Owned $Cli)) -Depth 6 -Compress) -cne (ConvertTo-Json -InputObject $beforePins -Depth 6 -Compress)){throw 'Owned process generation changed before stop'}
  TransitionPhase 'TASK_STOP_INTENT'
  Stop-ScheduledTask -TaskName $taskName
  foreach($process in $processes|Sort-Object @{Expression={if($_.Name -eq 'bun.exe'){1}else{0}}}){
    $fresh=Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.ProcessId)
    if($fresh -and $fresh.CreationDate -eq $process.CreationDate -and $fresh.CommandLine -ceq $process.CommandLine){Stop-Process -Id $process.ProcessId -Force}
  }
  for($i=0;$i -lt 30;$i++){
    $remaining=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort -in @(10100,10101)})
    if(-not $remaining.Count -and @(Owned $Cli).Count -eq 0){TransitionPhase 'RUNTIME_STOPPED';return};Start-Sleep -Milliseconds 100
  }
  throw 'Owned data ports did not stop; no replacement start'
}
function PrepareOriginalIssuerSocketDirectory {
  # Source-only until approved activation. Create with an inheritable, owner-only
  # DACL atomically; never loosen or repair an unsafe existing directory.
  $path=Join-Path $serviceHome 'oi'
  $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
  if(-not $owner){throw 'Original issuer owner identity unavailable'}
  if(-not (Test-Path -LiteralPath $path)){
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true,$false)
    $rule=[Security.AccessControl.FileSystemAccessRule]::new(
      $owner,[Security.AccessControl.FileSystemRights]::FullControl,
      ([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'),
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    # Framework exposes Directory.CreateDirectory(path, acl). Modern .NET
    # exposes the atomic ACL creation through FileSystemAclExtensions instead.
    # Never create a permissive directory first and tighten it afterwards.
    if($PSVersionTable.PSEdition -eq 'Core'){
      [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($path),$acl)
    }else{
      $null=[IO.Directory]::CreateDirectory($path,$acl)
    }
  }
  $item=Get-Item -LiteralPath $path -Force
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){
    throw 'Original issuer path must be a regular private directory'
  }
  $observed=Get-Acl -LiteralPath $path
  $ownerSid=([Security.Principal.NTAccount]::new($observed.Owner)).Translate([Security.Principal.SecurityIdentifier])
  $rules=@($observed.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if(-not $observed.AreAccessRulesProtected -or $ownerSid -ne $owner -or $rules.Count -ne 1){
    throw 'Original issuer private DACL not confirmed'
  }
  $r=$rules[0]
  if($r.IdentityReference -ne $owner -or $r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
    $r.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
    $r.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit') -or
    $r.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){
    throw 'Original issuer owner-only DACL differs'
  }
}
function StartOwned([string]$ExpectedVersion){
  $selected=ReadJson $registryFile
  if(@(Owned $selected.cliPath).Count -or @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object LocalPort -in @(10100,10101)).Count){throw 'Start outcome or owner already present; no duplicate start'}
  PrepareOriginalIssuerSocketDirectory
  $null=TaskOwner;Start-ScheduledTask -TaskName $taskName
  for($i=0;$i -lt 45;$i++){
    $ready=ReadyOwned $selected.cliPath $ExpectedVersion
    if($ready){return $ready}
    Start-Sleep -Seconds 1
  }
  throw 'Replacement readiness unconfirmed; no automatic second start'
}
function Snapshot{
  if(-not $SnapshotPath){throw 'Exact snapshot required'}
  $full=[IO.Path]::GetFullPath($SnapshotPath)
  $allowed=[IO.Path]::GetFullPath((Join-Path $controlRoot 'backups\runtime-layout'))+'\'
  if(-not $full.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $full -Leaf) -notmatch '^ocx-clean-\d{8}-\d{6}-[a-f0-9]{8}$'){throw 'Owned software-only snapshot required'}
  $recordFile=Join-Path $full 'snapshot.json';Regular $recordFile
  $record=ReadJson $recordFile
  if($record.schema -ne 'aicc-ocx-software-snapshot/v1' -or @($record.files).Count -ne 4){throw 'Software snapshot contract changed'}
  $expected=@($registryFile,$wrapperFile,$stateFile,$homeStateFile)
  foreach($file in $record.files){
    if($file.path -notin $expected -or $file.backupFile -notmatch '^[0-3]\.preimage$'){throw 'Unexpected restore target'}
    $saved=Join-Path $full $file.backupFile;Regular $saved
    if((Hash $saved) -cne $file.sha256){throw 'Software preimage changed'}
  }
  if(@($record.files.path|Select-Object -Unique).Count -ne 4){throw 'Duplicate restore target'}
  if((Hash $record.previous.cliPath) -cne $record.previousCliSha256 -or (Hash (Join-Path $record.previous.packageRoot 'package.json')) -cne $record.previousPackageSha256){throw 'Previous immutable software changed'}
  return $record
}
function RdcStandby($Metadata,[string]$Capsule){
  if($PSVersionTable.PSVersion -lt [version]'7.5'){throw 'Device transaction requires PowerShell 7.5+'}
  if($ManualRecovery -or $RecoveryMetadataSha256 -notmatch '^[a-f0-9]{64}$' -or (Hash (Join-Path $Capsule 'metadata.json')) -cne $RecoveryMetadataSha256){throw 'Exact immutable RDC metadata required'}
  if($Metadata.schema -cne 'aicc-rdc-ocx-recovery/v1' -or $Metadata.channel -cne 'rdc-device' -or $Metadata.target -cne 'ocx-only' -or $Metadata.operationId -cne $RecoveryOperationId -or $Metadata.nonce -cne $RecoveryNonce -or $Metadata.snapshotPath -ine [IO.Path]::GetFullPath($SnapshotPath) -or $Metadata.releaseManifestPath -ine [IO.Path]::GetFullPath($ReleaseManifestPath)){throw 'RDC target binding differs'}
  if($Metadata.PSObject.Properties['deviceRegistration']){
    $module=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\aicc\Recovery-DeviceBinding.psm1'));Regular $module
    if($Metadata.deviceRegistration.modulePath -ine $module -or (Hash $module) -cne $Metadata.deviceRegistration.moduleSha256){throw 'Pinned recovery device module changed'}
    Import-Module -Name $module -Force
    Assert-AiccRecoveryDeviceMetadata -Metadata $Metadata
  }elseif($Metadata.deviceId -cne '32002de6-dd98-4da6-9423-7d1032bfec6e'){throw 'New device requires exact immutable registered host attestation'}
  $thisScript=[IO.Path]::GetFullPath($PSCommandPath)
  foreach($pin in @(@($Metadata.workerScript,$Metadata.workerScriptSha256),@($Metadata.transitionScript,$Metadata.transitionScriptSha256),@($Metadata.powershell,$Metadata.powershellSha256),@((Join-Path $SnapshotPath 'snapshot.json'),$Metadata.snapshotSha256),@($ReleaseManifestPath,$Metadata.releaseManifestSha256))){Regular $pin[0];if((Hash $pin[0]) -cne $pin[1]){throw 'RDC code or transaction pin changed'}}
  if($Metadata.transitionScript -ine $thisScript){throw 'Different transition implementation refused'}
  $expiry=if($Mode -ceq 'Activate'){$Metadata.operationExpiresAt}else{$Metadata.recoveryExpiresAt}
  if([DateTimeOffset]::Parse($expiry) -le [DateTimeOffset]::UtcNow){throw 'RDC transaction deadline expired before dispatch'}
  $ready=ReadJson (Join-Path $Capsule 'readiness.json');$heartbeat=ReadJson (Join-Path $Capsule 'heartbeat.json');$state=ReadJson (Join-Path $Capsule 'state.json')
  $phase=if($Mode -ceq 'Activate'){'ACTIVATING'}else{'ROLLING_BACK'}
  $claimName=if($Mode -ceq 'Activate'){'activation.claim.json'}else{'rollback.claim.json'}
  $claim=ReadJson (Join-Path $Capsule $claimName)
  $age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($heartbeat.heartbeatAt)).TotalSeconds
  foreach($bound in @($ready,$heartbeat,$claim)){if($bound.operationId -cne $RecoveryOperationId -or $bound.nonce -cne $RecoveryNonce -or $bound.metadataSha256 -cne $RecoveryMetadataSha256){throw 'RDC worker/claim binding differs'}}
  if($state.state -cne $phase -or $age -lt 0 -or $age -gt 20 -or $ready.deviceId -cne $Metadata.deviceId){throw 'Fresh independent worker phase required'}
  $self=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
  $worker=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ready.worker.pid)
  if(-not $worker -or $self.ParentProcessId -ne $worker.ProcessId -or $worker.ParentProcessId -ne $ready.worker.parentPid -or $worker.CreationDate.ToUniversalTime().Ticks.ToString() -cne $ready.worker.createdTicks -or $worker.ExecutablePath -ine $Metadata.powershell -or (Hash $worker.ExecutablePath) -cne $ready.worker.imageSha256 -or (TextHash ([string]$worker.CommandLine)) -cne $ready.worker.commandSha256){throw 'Transition must be the exact pinned RDC worker child'}
  $blocked=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -in @(10100,10101,17841)|Select-Object -ExpandProperty OwningProcess)
  $cursor=$worker;$found=$false
  for($depth=0;$cursor -and $depth -lt 16;$depth++){
    if($cursor.ProcessId -in $blocked){throw 'RDC executor depends on the affected route'}
    if($cursor.ProcessId -eq $Metadata.rdcHost.pid){
      if($cursor.CreationDate.ToUniversalTime().Ticks.ToString() -cne $Metadata.rdcHost.createdTicks -or $cursor.ParentProcessId -ne $Metadata.rdcHost.parentPid -or $cursor.ExecutablePath -ine $Metadata.rdcHost.image -or (Hash $cursor.ExecutablePath) -cne $Metadata.rdcHost.imageSha256 -or (TextHash ([string]$cursor.CommandLine)) -cne $Metadata.rdcHost.commandSha256){throw 'RDC host generation changed'}
      $found=$true;break
    }
    $cursor=Get-CimInstance Win32_Process -Filter ('ProcessId='+$cursor.ParentProcessId)
  }
  if(-not $found){throw 'Pinned RDC host ancestry unavailable'}
  $invocation=Join-Path $Capsule ('transition-'+$Mode.ToLowerInvariant()+'.claim.json')
  $stream=[IO.File]::Open($invocation,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bytes=$utf8.GetBytes((@{operationId=$RecoveryOperationId;nonce=$RecoveryNonce;mode=$Mode;pid=$PID;createdTicks=$self.CreationDate.ToUniversalTime().Ticks.ToString();metadataSha256=$RecoveryMetadataSha256}|ConvertTo-Json -Compress));$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
  $script:deviceRecovery=$Metadata
}
function LocalStandby{
  # A model-free one-shot worker can perform the same exact rollback without an RDC/model round trip.
  $expected=Join-Path $SnapshotPath 'local-recovery-ready.json'
  if([IO.Path]::GetFullPath($LocalRecoveryReadyPath) -ine $expected){throw 'Exact local recovery receipt required'}
  Regular $expected;$r=ReadJson $expected
  $workerScript=Join-Path $PSScriptRoot 'Invoke-AiccOcxLocalRecovery.ps1';Regular $workerScript
  $now=[DateTimeOffset]::UtcNow
  $age=($now-[DateTimeOffset]::Parse($r.readyAt)).TotalSeconds
  if($r.schema -cne 'aicc-ocx-local-recovery/v1' -or $r.state -cne 'READY' -or $r.operationId -cne $RecoveryOperationId -or
    $r.nonce -cne $RecoveryNonce -or $r.snapshotSha256 -cne (Hash (Join-Path $SnapshotPath 'snapshot.json')) -or
    $r.manifestSha256 -cne (Hash $ReleaseManifestPath) -or $r.helperSha256 -cne (Hash $PSCommandPath) -or
    $r.workerSha256 -cne (Hash $workerScript) -or [DateTimeOffset]::Parse($r.expiresAt) -le $now -or
    $age -lt 0 -or $age -gt 120){throw 'Fresh bound local recovery unavailable'}
  $worker=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$r.workerPid)
  $caller=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
  if(-not $worker -or $worker.Name -ine 'pwsh.exe' -or $worker.CreationDate.ToUniversalTime().Ticks.ToString() -cne $r.workerStartedTicks -or
    -not $worker.CommandLine.Contains($workerScript) -or $caller.ParentProcessId -ne $worker.ProcessId){throw 'Transition must run under its live independent recovery worker'}
  $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object LocalPort -in @(10100,10101,17841))
  for($x=[int]$worker.ProcessId;$x;){
    if($x -in @($listeners.OwningProcess)){throw 'Recovery worker depends on the target service process'}
    $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$x);if(-not $p -or $p.ParentProcessId -eq $x){break};$x=[int]$p.ParentProcessId
  }
  $claim=[IO.File]::Open((Join-Path $SnapshotPath 'local-activation.claim'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $claim.Dispose()
}
function Standby{
  if($RecoveryOperationId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$' -or $RecoveryNonce -notmatch '^[a-f0-9]{32}$'){throw 'Fresh recovery binding required'}
  $capsule=Join-Path $ownerRoot ('.codex\ops\webgpt-remote-recovery\operations\'+$RecoveryOperationId)
  Regular (Join-Path $capsule 'metadata.json')
  $metadata=ReadJson (Join-Path $capsule 'metadata.json')
  if($metadata.schema -ceq 'aicc-rdc-ocx-recovery/v1'){RdcStandby $metadata $capsule;return}
  if($RecoveryMetadataSha256){throw 'Device metadata cannot be used as historical WebGPT standby'}
  $ready=ReadJson (Join-Path $capsule 'readiness.json');$heartbeat=ReadJson (Join-Path $capsule 'heartbeat.json');$state=ReadJson (Join-Path $capsule 'state.json')
  $age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse([string]$heartbeat.heartbeatAt)).TotalSeconds
  $process=Get-Process -Id ([int]$heartbeat.watcherPid) -ErrorAction SilentlyContinue
  if($metadata.nonce -cne $RecoveryNonce -or $ready.nonce -cne $RecoveryNonce -or $heartbeat.nonce -cne $RecoveryNonce -or $state.state -ne 'READY_STANDBY' -or $ready.channel -ne 'remote-command-tunnel' -or $ready.account -ne 'account-1' -or $ready.conversationId -ne '6ac8a240-f0c0-83ec-b85c-7927270c9868' -or -not $ready.standby -or $age -lt 0 -or $age -gt 20 -or -not $process -or $process.StartTime.ToUniversalTime().Ticks -ne ([DateTimeOffset]::Parse([string]$heartbeat.watcherStartedAt)).UtcTicks){throw 'Fresh process-bound remote recovery standby missing'}
  if((Hash (Join-Path $capsule 'rollback.ps1')) -cne $metadata.rollbackSha256){throw 'Recovery rollback changed'}
}
# Planned-offline activation (2026-10-31 G1). The independent standby exists so a controller whose own
# model route is this OCX can recover if the stop/replace fails. When OCX is already stopped by a
# recorded planned shutdown and the caller is not a descendant of any Codex process, there is no live
# route to lose. It still requires an exact user-approved decision bound to this snapshot and release,
# the release's own user install decision, and leaves Rollback (no standby needed) as the recovery path.
function PlannedOffline{
  Regular $PlannedOfflineDecisionPath
  $decision=ReadJson $PlannedOfflineDecisionPath
  $release=ReadJson $ReleaseManifestPath
  $created=[DateTimeOffset]::MinValue
  if($decision.schema -cne 'aicc-ocx-planned-offline-activation/v1' -or $decision.automaticRecovery -ne $false -or
    [string]::IsNullOrWhiteSpace([string]$decision.userInstruction) -or $decision.controllerKind -cne 'kiro-local-not-ocx' -or
    [IO.Path]::GetFullPath([string]$decision.snapshotPath) -ine [IO.Path]::GetFullPath($SnapshotPath) -or $decision.snapshotSha256 -cne (Hash (Join-Path $SnapshotPath 'snapshot.json')) -or
    [IO.Path]::GetFullPath([string]$decision.releaseManifestPath) -ine [IO.Path]::GetFullPath($ReleaseManifestPath) -or $decision.releaseManifestSha256 -cne (Hash $ReleaseManifestPath) -or
    $decision.userDecisionSha256 -cne $release.userDecisionSha256 -or $decision.operationId -cne $RecoveryOperationId -or
    -not [DateTimeOffset]::TryParse([string]$decision.createdAt,[ref]$created) -or ([DateTimeOffset]::UtcNow-$created).TotalMinutes -gt 30 -or ([DateTimeOffset]::UtcNow-$created).TotalMinutes -lt 0){throw 'Exact fresh planned-offline decision required'}
  if(@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object LocalPort -in @(10100,10101)).Count -or @(Owned $current.cliPath).Count){throw 'OCX is running; planned-offline activation refused, use the standby path'}
  $task=TaskOwner
  if([string]$task.State -cne 'Ready'){throw 'opencodex-proxy must be enabled and not running before planned-offline activation'}
  for($x=$PID;$x;){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$x);if(-not $p){break};if($p.Name -match '^codex(\.exe)?$'){throw 'Caller descends from Codex; its route may depend on OCX'};$x=$p.ParentProcessId;if($x -eq $p.ProcessId){break}}
}
if($Mode -eq 'Prepare'){
  $null=TaskOwner
  $previous=ReadJson $registryFile
  if($previous.schemaVersion -ne 1 -or $previous.requestExecution -ne 'windows-local' -or $previous.credentialWriter -ne 'a1' -or $previous.opencodexHome -ine $serviceHome){throw 'Registered runtime owner differs'}
  $SnapshotPath=Join-Path $controlRoot ('backups\runtime-layout\ocx-clean-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $SnapshotPath | Out-Null
  $files=@();$index=0
  foreach($path in @($registryFile,$wrapperFile,$stateFile,$homeStateFile)){
    Regular $path;$backupFile="$index.preimage";Copy-Item -LiteralPath $path -Destination (Join-Path $SnapshotPath $backupFile)
    $files+=@{path=$path;backupFile=$backupFile;sha256=Hash $path};$index++
  }
  Atomic (Join-Path $SnapshotPath 'snapshot.json') @{schema='aicc-ocx-software-snapshot/v1';createdAt=[DateTime]::UtcNow.ToString('o');previous=$previous;files=$files;
    previousCliSha256=Hash $previous.cliPath;previousPackageSha256=Hash (Join-Path $previous.packageRoot 'package.json');nativeSha256=Hash $nativeFile;
    excluded=@('Native profile/auth/history','OCX credentials/account/data/history','17841 bridge','A1 service/grants','Workspace','Chrome')}
  @{ok=$true;mode='Prepare';snapshot=$SnapshotPath;softwareFiles=4;runtimeChanged=$false}|ConvertTo-Json
  exit
}
if($Mode -eq 'Status'){
  $current=ReadJson $registryFile;$ready=Ready
  @{registryVersion=$current.version;ready=$ready;active=Active;nativeSha256=Hash $nativeFile}|ConvertTo-Json -Depth 6
  exit
}
if($Mode -eq 'Recover'){
  $current=ReadJson $registryFile;$ready=Ready
  if($ready){if($ready.version -cne $current.version){throw 'Different runtime preserved'};$ready|ConvertTo-Json -Depth 5;exit}
  if(@(Owned $current.cliPath).Count){throw 'Start outcome unknown; do not duplicate owner'}
  StartOwned $current.version|ConvertTo-Json -Depth 5;exit
}
$record=Snapshot
$current=ReadJson $registryFile
if($Mode -eq 'Rollback'){
  if($RecoveryMetadataSha256){Standby}
  $unchanged=$true
  foreach($file in $record.files){if((Hash $file.path) -cne $file.sha256){$unchanged=$false}}
  if($unchanged){
    $existingReady=ReadyOwned $record.previous.cliPath $record.previous.version
    if($existingReady){
      Atomic (Join-Path $SnapshotPath 'rollback-result.json') @{state='NO_CHANGE';operationId=$RecoveryOperationId;version=$existingReady.version;at=[DateTime]::UtcNow.ToString('o');runtimeReady=$true}
      @{ok=$true;state='NO_CHANGE';version=$existingReady.version;runtimeStopped=$false}|ConvertTo-Json;exit
    }
    # Original bytes do not prove a live original service. A confirmed stop/drain
    # may have happened before the first file replacement.
    $progress=ReadJson (Join-Path $SnapshotPath 'transition-state.json')
    if($progress.schema -cne 'aicc-ocx-transition-progress/v1' -or $progress.snapshotSha256 -cne (Hash (Join-Path $SnapshotPath 'snapshot.json')) -or ($RecoveryMetadataSha256 -and $progress.operationId -cne $RecoveryOperationId) -or $progress.lastCompletedPhase -notin @('STOP_INTENT','DRAIN_INTENT','DRAIN_ACKNOWLEDGED','TASK_STOP_INTENT','RUNTIME_STOPPED','FILES_APPLIED','START_INTENT')){throw 'Original files without exact interrupted-stop evidence; inspect instead of starting'}
    $owners=@(Owned $record.previous.cliPath)
    if($owners.Count){
      foreach($actual in (OwnerPins $owners)){
        $expected=@($progress.originalProcesses|Where-Object {$_.pid -eq $actual.pid -and $_.createdTicks -ceq $actual.createdTicks -and $_.commandSha256 -ceq $actual.commandSha256 -and $_.image -ieq $actual.image})
        if($expected.Count -ne 1){throw 'Different original runtime generation preserved'}
      }
      StopOwned $record.previous.cliPath
    }
    if(@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object LocalPort -in @(10100,10101)).Count -or @(Owned $record.previous.cliPath).Count){throw 'Original stop outcome remains unknown; no start'}
    $ready=StartOwned $record.previous.version
    Atomic (Join-Path $SnapshotPath 'rollback-result.json') @{state='RESTORED_RUNTIME';operationId=$RecoveryOperationId;version=$ready.version;at=[DateTime]::UtcNow.ToString('o');nativeUnchanged=((Hash $nativeFile) -ceq $record.nativeSha256)}
    @{ok=$true;state='RESTORED_RUNTIME';version=$ready.version}|ConvertTo-Json;exit
  }
  $plan=ReadJson (Join-Path $SnapshotPath 'activation.json')
  foreach($file in $record.files){if((Hash $file.path) -notin @($file.sha256,$plan.afterHashes.($file.path))){throw 'Newer foreign software edit preserved; no rollback'}}
  StopOwned $current.cliPath
  foreach($file in $record.files){Copy-Item -LiteralPath (Join-Path $SnapshotPath $file.backupFile) -Destination $file.path -Force}
  $ready=StartOwned $record.previous.version
  Atomic (Join-Path $SnapshotPath 'rollback-result.json') @{state='RESTORED';operationId=$RecoveryOperationId;version=$ready.version;at=[DateTime]::UtcNow.ToString('o');nativeUnchanged=((Hash $nativeFile) -ceq $record.nativeSha256)}
  @{ok=$true;state='RESTORED';version=$ready.version}|ConvertTo-Json;exit
}
if($ManualRecovery){
  $approval=ReadJson (Join-Path $ownerRoot '.codex\ops\ocx-upstream-separation\20261009\manual-recovery-approval.json')
  if($approval.schema -cne 'aicc-manual-ocx-transition/v1' -or $approval.userApprovedLocalManualRecovery -ne $true -or
    $approval.snapshotPath -cne $SnapshotPath -or $approval.releaseManifestPath -cne $ReleaseManifestPath -or
    $approval.snapshotSha256 -cne (Hash (Join-Path $SnapshotPath 'snapshot.json')) -or
    $approval.releaseManifestSha256 -cne (Hash $ReleaseManifestPath) -or $approval.automaticRecovery -ne $false){throw 'Exact user-approved manual recovery record required'}
  $observer=ReadJson (Join-Path $ownerRoot '.ai-control-center\control-plane\file-mailboxes\ocx-clean-20261009-1517\webgpt\worker\heartbeat.json')
  $age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse([string]$observer.heartbeatAt)).TotalSeconds
  $worker=Get-Process -Id ([int]$observer.watcherPid) -ErrorAction SilentlyContinue
  if($observer.operationId -cne 'ocx-clean-20261009-1517' -or $observer.nonce -cne '963cec728b6543ab8f902e156c54dcda' -or
    $observer.state -cne 'MONITORING' -or $age -lt 0 -or $age -gt 30 -or -not $worker -or
    $worker.StartTime.ToUniversalTime().Ticks -ne ([DateTimeOffset]::Parse([string]$observer.processStartedAt)).UtcTicks){throw 'Existing document observer is not fresh'}
}elseif($PlannedOfflineDecisionPath){PlannedOffline}elseif($LocalRecoveryReadyPath){LocalStandby}else{Standby}
foreach($file in $record.files){if((Hash $file.path) -cne $file.sha256){throw 'Software changed since fresh preimage; preserve edits'}}
if((Hash $nativeFile) -cne $record.nativeSha256){throw 'Native config changed since snapshot; prepare a fresh software snapshot before stopping OCX'}
Regular $ReleaseManifestPath
$release=ReadJson $ReleaseManifestPath;$releaseRoot=Split-Path $ReleaseManifestPath -Parent
$acceptanceFile=Join-Path $releaseRoot 'compatibility-acceptance.json';$acceptance=ReadJson $acceptanceFile
if($release.schema -ne 'aicc-external-ocx-release/v1' -or $release.supplierVersion -notin @('2.81.0','2.96.0') -or $acceptance.supplierVersion -cne $release.supplierVersion -or -not $acceptance.accepted -or (Hash $acceptanceFile) -cne $release.acceptanceSha256){throw 'Accepted immutable clean release required'}
foreach($entry in $release.adapterFiles.PSObject.Properties){if((Hash (Join-Path $releaseRoot $entry.Name)) -cne $entry.Value){throw 'Adapter release changed'}}
$bun=Join-Path $release.supplierRoot 'node_modules\@oven\bun-windows-x64\bin\bun.exe';Regular $bun
$cli=Join-Path $releaseRoot 'external-runtime.ts'
$serviceLaunch=SharedLaunchCommand $release $releaseRoot $bun $cli $ReleaseManifestPath
# Validate runtime-specific secure creation before draining/stopping a healthy
# service. StartOwned repeats the unchanged ACL check for recovery/start paths.
PrepareOriginalIssuerSocketDirectory
$newRegistry=@{}
foreach($property in $current.PSObject.Properties){$newRegistry[$property.Name]=$property.Value}
$newRegistry.version=$release.supplierVersion;$newRegistry.packageRoot=$release.supplierRoot;$newRegistry.cliPath=$cli;$newRegistry.bunPath=$bun
$newRegistry.adapterManifest=$ReleaseManifestPath;$newRegistry.adapterVersion=$release.adapterVersion;$newRegistry.softwareSnapshot=$SnapshotPath
$state=ReadJson $stateFile;$state.cliPath=$cli;$state.bunPath=$bun;$state.codexHome=Join-Path $serviceHome 'external-stock-codex';$state.codexSqliteHome=$state.codexHome;$state.revision=[int]$state.revision+1
$wrapperText=@"
@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "OCX_SERVICE=1"
set "OCX_WINDOWS_WRAPPER_PROTOCOL=1"
set "OPENCODEX_HOME=$serviceHome"
set "CODEX_HOME=$(Join-Path $serviceHome 'external-stock-codex')"
set /p OPENCODEX_API_AUTH_TOKEN=<"$($current.tokenFile)"
:loop
$serviceLaunch >>"$(Join-Path $serviceHome 'service.log')" 2>&1
if "%ERRORLEVEL%"=="42" exit /b 0
ping -n 6 127.0.0.1 >nul
goto loop
"@
# Build all intended software bytes/hashes before stopping an idle component.
$planned=@{}
$stateJson=$state|ConvertTo-Json -Depth 15
$newRegistry.wrapperSha256=TextHash $wrapperText
$newRegistry.stateSha256=TextHash $stateJson
$newRegistry.manifestSha256=Hash $ReleaseManifestPath
$newRegistry.nativeSha256=Hash $nativeFile
$registryJson=$newRegistry|ConvertTo-Json -Depth 15
foreach($pair in @(@($registryFile,$registryJson),@($wrapperFile,$wrapperText),@($stateFile,$stateJson),@($homeStateFile,$stateJson))){
  $sha=[Security.Cryptography.SHA256]::Create();try{$planned[$pair[0]]=([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes([string]$pair[1])))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
foreach($prior in @('activation.json','activation-result.json','activation-failure.json','transition-state.json')){if(Test-Path -LiteralPath (Join-Path $SnapshotPath $prior)){throw 'Snapshot already has an activation attempt; reconcile instead of replaying'}}
Atomic (Join-Path $SnapshotPath 'activation.json') @{schema='aicc-ocx-software-activation/v1';operationId=$RecoveryOperationId;afterHashes=$planned;manifest=$ReleaseManifestPath;manifestSha256=Hash $ReleaseManifestPath;state='PLANNED'}
$script:transitionProgress=@{schema='aicc-ocx-transition-progress/v1';operationId=$RecoveryOperationId;snapshotSha256=(Hash (Join-Path $SnapshotPath 'snapshot.json'));manifestSha256=(Hash $ReleaseManifestPath);phase='PLANNED';lastCompletedPhase='PLANNED';originalProcesses=@();observedAt=[DateTime]::UtcNow.ToString('o')}
TransitionPhase 'PLANNED'
try{
  StopOwned $current.cliPath
  AtomicText $wrapperFile $wrapperText;AtomicText $stateFile $stateJson;AtomicText $homeStateFile $stateJson;AtomicText $registryFile $registryJson
  TransitionPhase 'FILES_APPLIED'
  TransitionPhase 'START_INTENT'
  $ready=StartOwned $release.supplierVersion
  if((Hash $nativeFile) -cne $record.nativeSha256){throw 'Native config changed during component transition; investigate without restoring it'}
  TransitionPhase 'ACTIVATED'
  Atomic (Join-Path $SnapshotPath 'activation-result.json') @{state='ACTIVATED';operationId=$RecoveryOperationId;version=$ready.version;at=[DateTime]::UtcNow.ToString('o');nativeUnchanged=$true;manifestSha256=Hash $ReleaseManifestPath}
  @{ok=$true;state='ACTIVATED';version=$ready.version;snapshot=$SnapshotPath}|ConvertTo-Json
}catch{
  $script:transitionProgress.lastCompletedPhase=$script:transitionProgress.phase
  TransitionPhase 'FAILED'
  Atomic (Join-Path $SnapshotPath 'activation-failure.json') @{state='FAILED';operationId=$RecoveryOperationId;lastCompletedPhase=$script:transitionProgress.lastCompletedPhase;at=[DateTime]::UtcNow.ToString('o');code='component_transition_not_completed'}
  throw
}
