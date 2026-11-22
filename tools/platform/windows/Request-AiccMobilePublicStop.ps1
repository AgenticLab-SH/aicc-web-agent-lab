#requires -Version 7.5
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ConfigFile,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedConfigSha256,
 [Parameter(Mandatory)][guid]$OperationId,
 [switch]$Submit,
 [ValidateRange(0,30)][int]$WaitSeconds=0
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'MobilePublicStopCompatibility.psm1') -Force -DisableNameChecking
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
function OwnedRegular([string]$File,[string]$Boundary,[long]$Maximum=65536){
 $resolved=(Resolve-Path -LiteralPath $File).Path
 if(-not $resolved.StartsWith(([IO.Path]::GetFullPath($Boundary)+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){throw 'exact_owned_lifecycle_file_required'}
 for($p=$resolved;;$p=Split-Path -Parent $p){$item=Get-Item -LiteralPath $p -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_lifecycle_path_preserved'};$parent=Split-Path -Parent $p;if(-not $parent -or $parent -eq $p){break}}
 $item=Get-Item -LiteralPath $resolved;if($item.PSIsContainer -or $item.Length -gt $Maximum){throw 'regular_lifecycle_file_required'}
 return $resolved
}
$config=OwnedRegular $ConfigFile (Join-Path $owner 'control-plane\mobile-public-runtime')
if((Get-FileHash -LiteralPath $config).Hash.ToLowerInvariant() -cne $ExpectedConfigSha256){throw 'exact_config_pin_required'}
$cfg=Get-Content -LiteralPath $config -Raw|ConvertFrom-Json -AsHashtable -DateKind String
if($cfg.schemaVersion -ne 1 -or $cfg.runtimeId -notmatch '^[a-f0-9-]{36}$' -or $cfg.releaseManifestSha256 -notmatch '^[a-f0-9]{64}$' -or $cfg.port -ne 4383){throw 'scoped_lifecycle_config_required'}
$statusPath=OwnedRegular $cfg.statusFile (Join-Path $owner 'runtime\mobile-public-control')
$operation=$OperationId.ToString()
$operationRoot=Join-Path (Join-Path (Split-Path -Parent $config) 'stop-requests') $operation
$requestFile=Join-Path $operationRoot 'request.json'
$created=$false
function Assert-CurrentStopStatusBinding([string]$Directory,[string]$RuntimeId,[string]$Operation,$Status,$request,[string]$requestPath){
 # A status label is not a receipt for a different request or process generation.
 foreach($p in @($Directory,$requestPath)){$i=Get-Item -LiteralPath $p -Force;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_status_binding'}}
 $claimPath=Join-Path $Directory 'claim.json'
 $claimItem=Get-Item -LiteralPath $claimPath -Force -ErrorAction Stop
 if($claimItem.PSIsContainer -or ($claimItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $claimItem.Length -gt 4096){throw 'unsafe_status_claim'}
 $claim=Get-Content -LiteralPath $claimPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $requestSha=(Get-FileHash -LiteralPath $requestPath).Hash.ToLowerInvariant()
 if(($request.expectedPid -isnot [int] -and $request.expectedPid -isnot [long]) -or $request.expectedPid -le 0 -or $request.expectedStartedAt -isnot [string] -or -not $request.expectedStartedAt -or $request.releaseManifestSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'status_request_fields'}
 if($request.action -cne 'drain-and-stop' -or $request.runtimeId -cne $RuntimeId -or $request.operationId -cne $Operation -or $request.expectedPid -ne $Status.pid -or $request.expectedStartedAt -cne $Status.startedAt -or $request.releaseManifestSha256 -cne $Status.releaseManifestSha256 -or $claim.schemaVersion -ne 1 -or $claim.runtimeId -cne $RuntimeId -or $claim.operationId -cne $Operation -or $claim.pid -ne $Status.pid -or $claim.requestSha256 -cne $requestSha -or $claim.state -cne 'CLAIMED_INPUT_OUTCOME_UNKNOWN'){throw 'current_status_request_claim_binding'}
}
function Read-ExactStopResult([string]$Directory,[string]$RuntimeId,[string]$Operation,$Status,$request,[string]$requestPath){
 $resultPath=Join-Path $Directory 'result.json';$claimPath=Join-Path $Directory 'claim.json'
 if(-not (Test-Path -LiteralPath $resultPath)){return $null}
    foreach($p in @($Directory,$requestPath)){$i=Get-Item -LiteralPath $p -Force;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_result_source'}}
    if($request.action -cne 'drain-and-stop' -or $request.operationId -cne $Operation -or $request.runtimeId -cne $RuntimeId){throw 'result_request_binding'}
    $resultItem=Get-Item -LiteralPath $resultPath -Force
    if($resultItem.PSIsContainer -or ($resultItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $resultItem.Length -gt 4096){throw 'unsafe_result'}
    $result=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
    $claimItem=Get-Item -LiteralPath $claimPath -Force -ErrorAction Stop
    if($claimItem.PSIsContainer -or ($claimItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $claimItem.Length -gt 4096){throw 'unsafe_claim'}
    $claim=Get-Content -LiteralPath $claimPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
    $requestSha=(Get-FileHash -LiteralPath $requestPath).Hash.ToLowerInvariant()
    if(($result.pid -isnot [int] -and $result.pid -isnot [long]) -or $result.pid -le 0 -or $result.startedAt -isnot [string] -or -not $result.startedAt -or $result.releaseManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or $result.automaticReplay -isnot [bool]){throw 'result_fields'}
    $bound=$result.schemaVersion -eq 1 -and $result.kind -ceq 'aicc-mobile-stop-result/v1' -and $result.operationId -ceq $Operation -and $result.runtimeId -ceq $RuntimeId -and $result.pid -eq $request.expectedPid -and $result.pid -eq $Status.pid -and $result.startedAt -ceq $request.expectedStartedAt -and $result.startedAt -ceq $Status.startedAt -and $result.releaseManifestSha256 -ceq $request.releaseManifestSha256 -and $result.releaseManifestSha256 -ceq $Status.releaseManifestSha256 -and $result.requestSha256 -ceq $requestSha -and $result.automaticReplay -eq $false -and $claim.schemaVersion -eq 1 -and $claim.operationId -ceq $Operation -and $claim.runtimeId -ceq $RuntimeId -and $claim.pid -eq $result.pid -and $claim.requestSha256 -ceq $requestSha -and $claim.state -ceq 'CLAIMED_INPUT_OUTCOME_UNKNOWN'
    if(-not $bound){throw 'result_binding'}
 return $result
}
function Get-ExistingStopRequestGate([string]$Root,[string]$RuntimeId,[string]$Operation,$Status,$GenerationEvidence=$null){
 # Expiry or a claim is not a failed delivery. Keep earlier uncertain requests
 # across new operation IDs; only the exact owner's terminal result settles one.
 $out=@{supported=$true;reason=$null;pending=0;historicalUnknown=0;historicalTerminal=0}
 if(-not (Test-Path -LiteralPath $Root)){return $out}
 try{
  $rootItem=Get-Item -LiteralPath $Root -Force
  if(-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'unsafe_root'}
  $items=@(Get-ChildItem -LiteralPath $Root -Force)
  if($items.Count -gt 1000){throw 'inventory_bounds'}
  foreach($item in $items){
   if($item.Name -ceq 'submission.lock' -and -not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){continue}
   if(-not $item.PSIsContainer -or $item.Name -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'unsafe_entry'}
   $requestPath=Join-Path $item.FullName 'request.json';$claimPath=Join-Path $item.FullName 'claim.json'
   if(-not (Test-Path -LiteralPath $requestPath -PathType Leaf)){
    if(Test-Path -LiteralPath $claimPath){throw 'orphan_claim'}
    continue
   }
   $requestItem=Get-Item -LiteralPath $requestPath -Force
   if(($requestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $requestItem.Length -gt 4096){throw 'unsafe_request'}
   $request=Get-Content -LiteralPath $requestPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
   if($request.action -cne 'drain-and-stop' -or $request.runtimeId -cne $RuntimeId -or $request.operationId -cne $item.Name){throw 'request_binding'}
   if($GenerationEvidence -and $GenerationEvidence.verified -eq $true -and
    ($request.expectedPid -ne $Status.pid -or $request.expectedStartedAt -cne $Status.startedAt)){
    # Old UNKNOWN stays UNKNOWN. Only an exact, already claimed, expired request
    # proved disjoint from the current live process can be counted separately.
    $claimItem=Get-Item -LiteralPath $claimPath -Force -ErrorAction Stop
    if($claimItem.PSIsContainer -or ($claimItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $claimItem.Length -gt 4096){throw 'historical_claim_unknown'}
    $claimSha=(Get-FileHash -LiteralPath $claimPath).Hash.ToLowerInvariant()
    $claim=Get-Content -LiteralPath $claimPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
    $old=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$request.expectedPid) -ErrorAction Stop)
    $sha=(Get-FileHash -LiteralPath $requestPath).Hash.ToLowerInvariant()
    if(-not (Test-AiccMobileHistoricalStopBinding $request $claim $sha $RuntimeId $item.Name $Status $GenerationEvidence ($old.Count -eq 0))){throw 'historical_generation_unproven'}
    $result=$null
    if(Test-Path -LiteralPath (Join-Path $item.FullName 'result.json')){
     # A restored runner has a new PID/start. Verify the old receipt against its
     # own original input, never against or as an ACK for the current generation.
     $prior=@{pid=$request.expectedPid;startedAt=$request.expectedStartedAt;releaseManifestSha256=$request.releaseManifestSha256}
     $result=Read-ExactStopResult $item.FullName $RuntimeId $item.Name $prior $request $requestPath
     $at=[DateTimeOffset]::MinValue
     if($result.state -cne 'NORMAL_STOPPED' -or $result.lastStopResult -cne 'NORMAL_STOP_ACK' -or
      -not [DateTimeOffset]::TryParse([string]$result.observedAt,[ref]$at) -or
      $at -lt [DateTimeOffset]::Parse($claim.at) -or $at -ge [DateTimeOffset]::Parse($GenerationEvidence.createdAt)){throw 'historical_terminal_unproven'}
    }
    if((Get-FileHash -LiteralPath $requestPath).Hash.ToLowerInvariant() -cne $sha -or
     (Get-FileHash -LiteralPath $claimPath).Hash.ToLowerInvariant() -cne $claimSha){throw 'historical_evidence_changed'}
    if($result){$out.historicalTerminal++}else{$out.historicalUnknown++};continue
   }
   if($item.Name -ceq $Operation){continue}
   $terminal=$Status.lastOperationId -ceq $item.Name -and (
    ($Status.state -ceq 'NORMAL_STOPPED' -and $Status.lastStopResult -ceq 'NORMAL_STOP_ACK') -or
    ($Status.state -ceq 'LISTENING' -and $Status.lastStopResult -cin @('WORK_PRESERVED','NOT_LISTENING_PRESERVED')))
   if($terminal){Assert-CurrentStopStatusBinding $item.FullName $RuntimeId $item.Name $Status $request $requestPath}
   $result=Read-ExactStopResult $item.FullName $RuntimeId $item.Name $Status $request $requestPath
   if($result){
    $terminal=$terminal -or ($result.state -ceq 'NORMAL_STOPPED' -and $result.lastStopResult -ceq 'NORMAL_STOP_ACK') -or ($result.state -ceq 'LISTENING' -and $result.lastStopResult -cin @('WORK_PRESERVED','NOT_LISTENING_PRESERVED'))
   }
   if(-not $terminal){$out.pending++}
  }
  if($out.pending){$out.supported=$false;$out.reason='EXISTING_STOP_OUTCOME_UNCONFIRMED'}
 }catch{$out.supported=$false;$out.reason='EXISTING_STOP_INVENTORY_UNKNOWN';$out.pending=$null}
 return $out
}
function Get-SupervisorStopReadiness([string]$Source){
 # A running supervisor cannot adopt a repaired parser from a later source tree.
 # Inspect the installed, manifest-pinned source before creating a new request.
 $tokens=$null;$errors=$null
 $ast=[Management.Automation.Language.Parser]::ParseInput($Source,[ref]$tokens,[ref]$errors)
 if(@($errors).Count){return @{supported=$false;reason='INSTALLED_SUPERVISOR_PARSE_UNKNOWN'}}
 $reads=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'ConvertFrom-Json'},$true))
 if(-not $reads.Count){return @{supported=$false;reason='INSTALLED_SUPERVISOR_JSON_CONTRACT_UNKNOWN'}}
 foreach($read in $reads){
  $elements=@($read.CommandElements)
  $date=@(for($i=0;$i -lt $elements.Count;$i++){if($elements[$i] -is [Management.Automation.Language.CommandParameterAst] -and $elements[$i].ParameterName -ieq 'DateKind'){$i}})
  if($date.Count -ne 1){return @{supported=$false;reason='INSTALLED_SUPERVISOR_DATE_STRING_UNSUPPORTED'}}
  $parameter=$elements[$date[0]]
  $value=if($parameter.Argument){$parameter.Argument}else{if($date[0]+1 -lt $elements.Count){$elements[$date[0]+1]}else{$null}}
  if($value -isnot [Management.Automation.Language.StringConstantExpressionAst] -or $value.Value -ine 'String'){
   return @{supported=$false;reason='INSTALLED_SUPERVISOR_DATE_STRING_UNSUPPORTED'}
  }
 }
 return @{supported=$true;reason=$null}
}
function ReadInstalledStopReadiness($Status) {
 try{
  $release=[IO.Path]::GetFullPath($cfg.releaseRoot)
  $manifestPath=OwnedRegular (Join-Path $release '.aicc-release.json') (Join-Path $owner 'releases\cli') 16777216
  if((Get-FileHash -LiteralPath $manifestPath).Hash.ToLowerInvariant() -cne $cfg.releaseManifestSha256){throw 'manifest_changed'}
  $manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  $relative='tools/platform/windows/Start-AiccMobilePublicRuntime.ps1'
  $pins=@($manifest.files|Where-Object path -CEQ $relative)
  if($manifest.schemaVersion -ne 1 -or $manifest.component -cne 'mobile-public-control' -or $pins.Count -ne 1 -or $pins[0].sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'supervisor_pin_unknown'}
  $file=OwnedRegular (Join-Path $release $relative) $release
  if((Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant() -cne $pins[0].sha256){throw 'supervisor_pin_changed'}
  $source=[IO.File]::ReadAllText($file)
  $modern=Get-SupervisorStopReadiness $source
  if($modern.supported -and $Status.state -ceq 'LISTENING'){
   $runnerFile=OwnedRegular (Join-Path $release 'tools/platform/windows/mobile-public-runner.mjs') $release
   $runnerPin=@($manifest.files|Where-Object path -CEQ 'tools/platform/windows/mobile-public-runner.mjs')
   if($runnerPin.Count -ne 1 -or (Get-FileHash $runnerFile).Hash.ToLowerInvariant() -cne $runnerPin[0].sha256){throw 'modern_runner_pin_changed'}
   $process=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$Status.pid) -ErrorAction Stop)
   if($process.Count -ne 1){throw 'modern_runner_unknown'}
   $parent=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$process[0].ParentProcessId) -ErrorAction Stop)
   if($parent.Count -ne 1 -or [IO.Path]::GetFileName($parent[0].ExecutablePath) -ine 'pwsh.exe' -or
    (Get-FileHash $cfg.nodeExecutable).Hash.ToLowerInvariant() -cne $cfg.nodeSha256 -or
    -not (Test-AiccMobileLegacyGeneration $Status $process[0] $parent[0] $config $ExpectedConfigSha256 $file $runnerFile $cfg.nodeExecutable)){throw 'modern_generation_unknown'}
   $modern.generation=@{verified=$true;pid=$Status.pid;startedAt=$Status.startedAt;manifestSha256=$cfg.releaseManifestSha256;createdAt=([DateTimeOffset]$process[0].CreationDate).ToUniversalTime().ToString('o')}
   return $modern
  }
  if($modern.supported){return $modern}
  # Preserve the general AST refusal. A single reviewed legacy source pair can
  # additionally qualify for its exact current process and lossless timestamp.
  $runnerRelative='tools/platform/windows/mobile-public-runner.mjs'
  $runnerPins=@($manifest.files|Where-Object path -CEQ $runnerRelative)
  if($runnerPins.Count -ne 1){throw 'legacy_runner_pin_unknown'}
  $runnerFile=OwnedRegular (Join-Path $release $runnerRelative) $release
  $runnerSha=(Get-FileHash -LiteralPath $runnerFile).Hash.ToLowerInvariant()
  if($runnerSha -cne $runnerPins[0].sha256 -or
   -not (Test-AiccMobileLegacyStopPins $cfg.releaseManifestSha256 $pins[0].sha256 $runnerSha)){return $modern}
  $process=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$Status.pid) -ErrorAction Stop)
  if($process.Count -ne 1){throw 'legacy_runner_process_unknown'}
  $parent=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$process[0].ParentProcessId) -ErrorAction Stop)
  if($parent.Count -ne 1){throw 'legacy_supervisor_process_unknown'}
  $nodeFile=OwnedRegular $cfg.nodeExecutable (Split-Path -Parent $cfg.nodeExecutable) 134217728
  if((Get-FileHash -LiteralPath $nodeFile).Hash.ToLowerInvariant() -cne $cfg.nodeSha256){throw 'legacy_node_changed'}
  $pwshFile=OwnedRegular $parent[0].ExecutablePath (Split-Path -Parent $parent[0].ExecutablePath) 134217728
  if([IO.Path]::GetFileName($pwshFile) -ine 'pwsh.exe'){throw 'legacy_powershell_unknown'}
  if(-not (Test-AiccMobileLegacyGeneration $Status $process[0] $parent[0] $config $ExpectedConfigSha256 $file $runnerFile $nodeFile)){throw 'legacy_generation_unknown'}
  $pwshSha=(Get-FileHash -LiteralPath $pwshFile).Hash.ToLowerInvariant()
  $round=Invoke-AiccMobileLegacyDateProbe $pwshFile $pwshSha $Status.startedAt
  if(-not $round.exact){return @{supported=$false;reason='INSTALLED_LEGACY_TIMESTAMP_ROUNDTRIP_LOSSY';legacy=$true}}
  $again=ReadStatus
  $processAgain=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$Status.pid) -ErrorAction Stop)
  $parentAgain=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$parent[0].ProcessId) -ErrorAction Stop)
  if($again.pid -ne $Status.pid -or $again.startedAt -cne $Status.startedAt -or $again.state -cne $Status.state -or
   $processAgain.Count -ne 1 -or $parentAgain.Count -ne 1 -or
   $processAgain[0].CreationDate -ne $process[0].CreationDate -or $parentAgain[0].CreationDate -ne $parent[0].CreationDate -or
   -not (Test-AiccMobileLegacyGeneration $again $processAgain[0] $parentAgain[0] $config $ExpectedConfigSha256 $file $runnerFile $nodeFile) -or
   (Get-FileHash -LiteralPath $config).Hash.ToLowerInvariant() -cne $ExpectedConfigSha256 -or
   (Get-FileHash -LiteralPath $manifestPath).Hash.ToLowerInvariant() -cne $cfg.releaseManifestSha256 -or
   (Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant() -cne $pins[0].sha256 -or
   (Get-FileHash -LiteralPath $runnerFile).Hash.ToLowerInvariant() -cne $runnerSha){throw 'legacy_identity_changed_after_probe'}
  return @{supported=$true;reason=$null;legacy=$true;mode='EXACT_LEGACY_GENERATION_LOSSLESS';powerShellVersion=$round.version;
   generation=@{verified=$true;pid=$Status.pid;startedAt=$Status.startedAt;manifestSha256=$cfg.releaseManifestSha256;
    createdAt=([DateTimeOffset]$process[0].CreationDate).ToUniversalTime().ToString('o');powerShellSha256=$pwshSha}}
 }catch{return @{supported=$false;reason='INSTALLED_SUPERVISOR_IDENTITY_UNKNOWN'}}
}
function ReadStatus {
 $value=Get-Content -LiteralPath $statusPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 if($value.schemaVersion -ne 1 -or $value.controlProtocolVersion -ne 2 -or $value.runtimeId -cne $cfg.runtimeId -or $value.releaseManifestSha256 -cne $cfg.releaseManifestSha256 -or $value.pid -le 0 -or -not $value.startedAt){throw 'exact_runtime_generation_required'}
 return $value
}
function Read-StopOperationOutcome([string]$Directory,[string]$RuntimeId,[string]$Operation,$Status){
 $out=@{lastStopResult='UNCONFIRMED';resultSource='UNCONFIRMED';normalStopAck=$false;currentNormalStopAck=$false}
 $requestPath=Join-Path $Directory 'request.json'
 try{
  if(-not (Test-Path -LiteralPath $requestPath)){return $out}
  if(Test-Path -LiteralPath $requestPath){
   foreach($p in @($Directory,$requestPath)){$i=Get-Item -LiteralPath $p -Force;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_result_query'}}
   $i=Get-Item -LiteralPath $requestPath
   if($i.PSIsContainer -or $i.Length -gt 4096){throw 'request_bounds'}
   $request=Get-Content -LiteralPath $requestPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
   if($request.action -cne 'drain-and-stop' -or $request.operationId -cne $Operation -or $request.runtimeId -cne $RuntimeId){throw 'request_binding'}
   $result=Read-ExactStopResult $Directory $RuntimeId $Operation $Status $request $requestPath
   if($result){
    $out.lastStopResult=$result.lastStopResult;$out.resultSource='EXACT_OPERATION_RECEIPT'
    $out.normalStopAck=$result.state -ceq 'NORMAL_STOPPED' -and $result.lastStopResult -ceq 'NORMAL_STOP_ACK'
   }
  }
  $currentAck=$Status.lastOperationId -ceq $Operation -and $Status.state -ceq 'NORMAL_STOPPED' -and $Status.lastStopResult -ceq 'NORMAL_STOP_ACK'
  if($Status.lastOperationId -ceq $Operation){Assert-CurrentStopStatusBinding $Directory $RuntimeId $Operation $Status $request $requestPath}
  if($out.resultSource -ceq 'UNCONFIRMED' -and $Status.lastOperationId -ceq $Operation){
   $out.lastStopResult=$Status.lastStopResult;$out.resultSource='CURRENT_STATUS';$out.normalStopAck=$currentAck
  }
  $out.currentNormalStopAck=$currentAck -and $out.normalStopAck
  if($out.normalStopAck -and -not $currentAck){$out.resultSource='HISTORICAL_ACK_CURRENT_STATUS_UNCONFIRMED'}
 }catch{$out.lastStopResult='UNCONFIRMED';$out.resultSource='RESULT_BINDING_UNKNOWN';$out.normalStopAck=$false;$out.currentNormalStopAck=$false}
 return $out
}
$current=ReadStatus
$stopReadiness=ReadInstalledStopReadiness $current
$requestRoot=Join-Path (Split-Path -Parent $config) 'stop-requests'
$requestGate=Get-ExistingStopRequestGate $requestRoot $cfg.runtimeId $operation $current $stopReadiness.generation
if($Submit -and -not (Test-Path -LiteralPath $requestFile)){
 if(-not $requestGate.supported){throw ('normal_stop_not_submitted:'+ $requestGate.reason)}
 if(-not $stopReadiness.supported){throw ('normal_stop_not_submitted:'+ $stopReadiness.reason)}
 if($current.state -cne 'LISTENING'){throw 'listening_generation_required_no_stop_sent'}
 $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$current.pid) -ErrorAction Stop
 $runner=Join-Path ([IO.Path]::GetFullPath($cfg.releaseRoot)) 'tools\platform\windows\mobile-public-runner.mjs'
 if(-not $process -or $process.ExecutablePath -ine $cfg.nodeExecutable -or -not $process.CommandLine.Contains($config) -or -not $process.CommandLine.Contains($runner)){throw 'exact_runtime_process_owner_required'}
 # Request creation is the one dispatch. A timeout or refusal never deletes it.
 for($ancestor=$operationRoot;;$ancestor=Split-Path -Parent $ancestor){if(Test-Path -LiteralPath $ancestor){$existing=Get-Item -LiteralPath $ancestor -Force;if($existing.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_operation_preserved'}};$parentPath=Split-Path -Parent $ancestor;if(-not $parentPath -or $parentPath -eq $ancestor){break}}
 New-Item -ItemType Directory -Path $requestRoot -Force|Out-Null
 $submissionLock=[IO.File]::Open((Join-Path $requestRoot 'submission.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{
 $current=ReadStatus
 $stopReadiness=ReadInstalledStopReadiness $current
 if(-not $stopReadiness.supported){throw ('normal_stop_not_submitted:'+ $stopReadiness.reason)}
 $requestGate=Get-ExistingStopRequestGate $requestRoot $cfg.runtimeId $operation $current $stopReadiness.generation
 if(-not $requestGate.supported){throw ('normal_stop_not_submitted:'+ $requestGate.reason)}
 if($current.state -cne 'LISTENING'){throw 'listening_generation_required_no_stop_sent'}
 $beforeCreate=ReadStatus
 if($beforeCreate.pid -ne $current.pid -or $beforeCreate.startedAt -cne $current.startedAt -or
  $beforeCreate.state -cne $current.state -or (Get-FileHash -LiteralPath $config).Hash.ToLowerInvariant() -cne $ExpectedConfigSha256){throw 'generation_changed_no_stop_sent'}
 New-Item -ItemType Directory -Path $operationRoot -Force|Out-Null
 $parent=Get-Item -LiteralPath $operationRoot -Force
 if($parent.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_operation_preserved'}
 $request=@{action='drain-and-stop';operationId=$operation;runtimeId=$cfg.runtimeId;expectedPid=$current.pid;expectedStartedAt=$current.startedAt;releaseManifestSha256=$cfg.releaseManifestSha256;expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(45).ToString('o')}
 $stream=[IO.File]::Open($requestFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($request|ConvertTo-Json -Compress));$stream.Write($bytes);$stream.Flush($true);$created=$true}finally{$stream.Dispose()}
 }finally{$submissionLock.Dispose()}
}
$deadline=[DateTimeOffset]::UtcNow.AddSeconds($WaitSeconds)
do {
 $current=ReadStatus
 $outcome=Read-StopOperationOutcome $operationRoot $cfg.runtimeId $operation $current
 if($outcome.resultSource -ceq 'RESULT_BINDING_UNKNOWN' -or $outcome.normalStopAck -or $outcome.lastStopResult -in @('WORK_PRESERVED','NOT_LISTENING_PRESERVED','UNKNOWN')){break}
 if([DateTimeOffset]::UtcNow -ge $deadline){break}
 Start-Sleep -Milliseconds 250
}while($true)
$ack=$outcome.normalStopAck
$latest=ReadStatus
if($stopReadiness.legacy -and ($latest.pid -ne $stopReadiness.generation.pid -or
 $latest.startedAt -cne $stopReadiness.generation.startedAt -or $latest.state -cne 'LISTENING' -or
 (Get-FileHash -LiteralPath $config).Hash.ToLowerInvariant() -cne $ExpectedConfigSha256)){
 $stopReadiness.supported=$false;$stopReadiness.reason='LEGACY_GENERATION_CHANGED_READBACK_HOLD'
}
# ACK belongs to this generation and operation. OS process exit is a separate gate.
$processStillPresent=[bool](Get-Process -Id $current.pid -ErrorAction SilentlyContinue)
@{operationId=$operation;runtimeId=$cfg.runtimeId;pid=$current.pid;runtimeState=$current.state;submittedThisCall=$created;existingRequestPreserved=(Test-Path -LiteralPath $requestFile);otherPendingStopRequests=$requestGate.pending;historicalUnknownStopRequests=$requestGate.historicalUnknown;normalStopAck=$ack;processExitObserved=($outcome.currentNormalStopAck -and -not $processStillPresent);transitionReady=($outcome.currentNormalStopAck -and -not $processStillPresent);lastStopResult=$outcome.lastStopResult;resultSource=$outcome.resultSource;automaticReplay=$false;forceStop=$false;legacyRunnerSupported=($stopReadiness.legacy -eq $true -and $stopReadiness.supported);compatibilityMode=$stopReadiness.mode;installedSupervisorSupported=$stopReadiness.supported;stopSubmissionSupported=($stopReadiness.supported -and $requestGate.supported);stopHoldReason=if(-not $requestGate.supported){$requestGate.reason}else{$stopReadiness.reason}}|ConvertTo-Json -Compress
