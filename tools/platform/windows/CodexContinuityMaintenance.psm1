#requires -Version 7.5
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexContinuityCliPin.psm1') -Force
$script:PinModule=Get-Module CodexContinuityCliPin
function Maintenance-Hash([string]$File){(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
function Maintenance-Read([string]$File){Get-Content -LiteralPath $File -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function Maintenance-Closure([string]$SourceRoot){
 $pending=[Collections.Generic.Queue[string]]::new();$pending.Enqueue('src/codex-strict-continuity-bridge.mjs');$found=@{}
 while($pending.Count){
  $relative=$pending.Dequeue();if($found.ContainsKey($relative)){continue}
  $file=[IO.Path]::GetFullPath((Join-Path $SourceRoot $relative))
  if(-not $file.StartsWith(([IO.Path]::GetFullPath($SourceRoot)+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){throw 'bundle_import_outside_source'}
  if((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'bundle_import_alias'}
  $text=Get-Content -LiteralPath $file -Raw;$found[$relative]=Maintenance-Hash $file
  foreach($match in [regex]::Matches($text,'(?:from\s*|import\s*\()\s*[''"''](?<path>\.[^''"'']+)[''"'']')){
   $import=[IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $file) $match.Groups['path'].Value))
   $next=[IO.Path]::GetRelativePath($SourceRoot,$import).Replace('\','/');if($next.StartsWith('../')){throw 'bundle_import_outside_source'};$pending.Enqueue($next)
  }
 }
 $found['tools/platform/windows/Invoke-AiccCodexContinuity.ps1']=Maintenance-Hash (Join-Path $SourceRoot 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1')
 # The helper dot-sources this owner-only module; closure must be complete
 # before an immutable release can be installed.
 $groupOwner='tools/platform/windows/CodexContinuityGroupOwner.ps1'
 if((Get-Content -LiteralPath (Join-Path $SourceRoot 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1') -Raw -Encoding UTF8).Contains('CodexContinuityGroupOwner.ps1')){
  $groupSource=Join-Path $SourceRoot $groupOwner
  if(-not(Test-Path -LiteralPath $groupSource -PathType Leaf)){throw 'group_owner_dependency_missing'}
  $found[$groupOwner]=Maintenance-Hash $groupSource
 }
 return $found
}
# Verify the exact previous immutable sender before replacing its pin.
# Task/state/queue authority is independent of this source release.
function Maintenance-ExistingLauncher($cfg,[string]$StateRoot){
 if(-not $cfg.strictRouteLauncher){return $null}
 $pin=$cfg.strictRouteLauncher
 if($pin.schemaVersion -ne 1 -or $pin.route -cne 'command-route-r2' -or
    $pin.codexSha256 -cne $cfg.codexSha256 -or
    $pin.files -isnot [Collections.IDictionary] -or $pin.files.Count -lt 3){
  throw 'maintenance_previous_launcher_schema_changed'
 }
 $managedHome=[IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $StateRoot)))
 $parent=[IO.Path]::GetFullPath((Join-Path $managedHome 'releases/codex-continuity'))
 if(-not [IO.Path]::IsPathFullyQualified([string]$pin.releaseRoot)){throw 'maintenance_previous_release_unbound'}
 $release=[IO.Path]::GetFullPath([string]$pin.releaseRoot)
 if([IO.Path]::GetDirectoryName($release) -ine $parent -or
    [IO.Path]::GetFileName($release) -cnotmatch '^(?:group-owner|maintenance)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){
  throw 'maintenance_previous_release_unowned'
 }
 $expected=@{
  helper=(Join-Path $release 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1')
  bridge=(Join-Path $release 'src/codex-strict-continuity-bridge.mjs')
  route=(Join-Path $release 'src/codex-cli-routes.mjs')
 }
 if([IO.Path]::GetFullPath([string]$cfg.helperPath) -ine $expected.helper -or
    [IO.Path]::GetFullPath([string]$pin.bridgePath) -ine $expected.bridge -or
    [IO.Path]::GetFullPath([string]$pin.routeModulePath) -ine $expected.route -or
    $pin.files['tools/platform/windows/Invoke-AiccCodexContinuity.ps1'] -cne $cfg.helperSha256 -or
    $pin.files['src/codex-strict-continuity-bridge.mjs'] -cne $pin.bridgeSha256 -or
    $pin.files['src/codex-cli-routes.mjs'] -cne $pin.routeModuleSha256){
  throw 'maintenance_previous_launcher_binding_changed'
 }
 foreach($key in @('releaseRoot','nodePath','bridgePath','routeModulePath')){
  $value=[string]$pin[$key]
  if(-not [IO.Path]::IsPathFullyQualified($value)){throw 'maintenance_previous_launcher_path_unbound'}
 }
 foreach($f in @(@{file=$pin.nodePath;sha=$pin.nodeSha256},
                @{file=$cfg.codexExecutable;sha=$cfg.codexSha256})){
  if($f.sha -cnotmatch '^[a-f0-9]{64}$' -or
     (Get-Item -LiteralPath $f.file -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint -or
     (Maintenance-Hash $f.file) -cne $f.sha){throw 'maintenance_previous_toolchain_pin_changed'}
 }
 for($cursor=$release;$cursor.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase);$cursor=[IO.Path]::GetDirectoryName($cursor)){
  $item=Get-Item -LiteralPath $cursor -ErrorAction Stop
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'maintenance_previous_release_alias'}
  if($cursor -ieq $parent){break}
 }
 foreach($key in $pin.files.Keys){
  if($key -isnot [string] -or [IO.Path]::IsPathRooted($key) -or $key.Contains(':') -or
     $key -match '(^|[\\/])\.\.([\\/]|$)' -or
     $pin.files[$key] -cnotmatch '^[a-f0-9]{64}$'){throw 'maintenance_previous_closure_path_invalid'}
  $file=[IO.Path]::GetFullPath((Join-Path $release $key))
  if(-not $file.StartsWith($release+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
   throw 'maintenance_previous_closure_escape'
  }
  for($cursor=$file;$cursor.StartsWith($release,[StringComparison]::OrdinalIgnoreCase);$cursor=[IO.Path]::GetDirectoryName($cursor)){
   if((Get-Item -LiteralPath $cursor -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){
    throw 'maintenance_previous_closure_alias'
   }
   if($cursor -ieq $release){break}
  }
  $item=Get-Item -LiteralPath $file -ErrorAction Stop
  if($item.PSIsContainer -or (Maintenance-Hash $file) -cne $pin.files[$key]){
   throw 'maintenance_previous_closure_sha_changed'
  }
 }
 @{sha256=(& $script:PinModule {param($v)Get-PinValueDigest $v} -v $pin);
   releaseRoot=$release;nodePath=$pin.nodePath;nodeSha256=$pin.nodeSha256;
   helperSha256=$cfg.helperSha256;fileCount=$pin.files.Count}
}
function Maintenance-TaskStamp([string]$StateRoot){
 $task=GroupInstall-TaskSnapshot $StateRoot
 if($task.oldTaskState -cne 'Disabled'){throw 'maintenance_task_not_disabled'}
 @{xmlSha256=$task.xmlSha256;vbsSha256=$task.oldVbsSha256;
   taskName=$task.taskName;state=$task.oldTaskState}
}
function Maintenance-RegistryBytes([byte[]]$Before,$cfg,[string]$NewHelper,$pin){
 # Preserve all original bytes except three unique top-level fields.
 $text=[Text.UTF8Encoding]::new($false,$true).GetString($Before)
 $json=[Text.Json.JsonDocument]::Parse($text)
 try{
  $properties=@($json.RootElement.EnumerateObject())
  foreach($key in @('helperPath','helperSha256')){
   if(@($properties|Where-Object Name -ceq $key).Count -ne 1){throw 'maintenance_top_level_field_not_unique'}
  }
  $launcherCount=@($properties|Where-Object Name -ceq 'strictRouteLauncher').Count
  if($launcherCount -ne [int]($null -ne $cfg.strictRouteLauncher)){
   throw 'maintenance_top_level_launcher_not_unique'
  }
 }finally{$json.Dispose()}
 foreach($kv in @(
   @{key='helperPath';value=$NewHelper},
   @{key='helperSha256';value=$pin.files['tools/platform/windows/Invoke-AiccCodexContinuity.ps1']}
 )){
  $match=[regex]::Matches($text,'"'+$kv.key+'"\s*:\s*"(?:[^"\\]|\\.)*"')
  if($match.Count -ne 1){throw 'maintenance_raw_field_ambiguous'}
  $replacement='"'+$kv.key+'":'+(ConvertTo-Json -InputObject $kv.value -Compress)
  $text=$text.Substring(0,$match[0].Index)+$replacement+
        $text.Substring($match[0].Index+$match[0].Length)
 }
 $newPin=(ConvertTo-Json -InputObject $pin -Compress -Depth 20)
 if($cfg.strictRouteLauncher){
  $matches=[regex]::Matches($text,'"strictRouteLauncher"\s*:\s*\{')
  if($matches.Count -ne 1){throw 'maintenance_raw_launcher_ambiguous'}
  $begin=$matches[0].Index+$matches[0].Length-1
  $depth=0;$quoted=$false;$escaped=$false;$finish=-1
  for($i=$begin;$i -lt $text.Length;$i++){
   $ch=$text[$i]
   if($quoted){
    if($escaped){$escaped=$false}
    elseif($ch -eq '\'){$escaped=$true}
    elseif($ch -eq '"'){$quoted=$false}
   }elseif($ch -eq '"'){$quoted=$true}
   elseif($ch -eq '{'){$depth++}
   elseif($ch -eq '}'){
    $depth--
    if($depth -eq 0){$finish=$i;break}
   }
  }
  if($finish -lt 0){throw 'maintenance_raw_launcher_unterminated'}
  $beforePin=$text.Substring($begin,$finish-$begin+1)|ConvertFrom-Json -AsHashtable -DateKind String
  $digest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $beforePin
  $oldDigest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $cfg.strictRouteLauncher
  if($digest -cne $oldDigest){throw 'maintenance_launcher_source_mismatch'}
  $text=$text.Substring(0,$begin)+$newPin+$text.Substring($finish+1)
 }else{
  $end=$text.LastIndexOf('}')
  if($end -lt 0){throw 'maintenance_registry_json_invalid'}
  $text=$text.Substring(0,$end)+',"strictRouteLauncher":'+$newPin+$text.Substring($end)
 }
 $next=$text|ConvertFrom-Json -AsHashtable -DateKind String
 if($next.helperPath -cne $NewHelper -or $next.helperSha256 -cne $pin.files['tools/platform/windows/Invoke-AiccCodexContinuity.ps1']){
  throw 'maintenance_helper_rewrite_wrong'
 }
 $expected=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $pin
 $actual=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $next.strictRouteLauncher
 if($expected -cne $actual){throw 'maintenance_new_launcher_rewrite_wrong'}
 $preservedBefore=@{};$preservedAfter=@{}
 foreach($key in $cfg.Keys){
  if($key -in @('helperPath','helperSha256','strictRouteLauncher')){continue}
  $preservedBefore[$key]=$cfg[$key]
  $preservedAfter[$key]=$next[$key]
 }
 $beforeDigest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $preservedBefore
 $afterDigest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $preservedAfter
 if($beforeDigest -cne $afterDigest){throw 'maintenance_unowned_registry_fields_changed'}
 if(@($next.Keys).Count -ne @($cfg.Keys).Count+[int](-not $cfg.strictRouteLauncher)){
  throw 'maintenance_registry_field_count_changed'
 }
 [Text.UTF8Encoding]::new($false).GetBytes($text)
}
function Maintenance-Proof($cfg,[string]$StateRoot){
 if(-not $cfg.workerStopRequestedAt -or $cfg.worker.state -cne 'STOPPED_FOR_MAINTENANCE'){throw 'maintenance_fence_required'}
 # Reuse the reviewed exact historical Desktop queue classifier. No queue
 # becomes settled or eligible for dispatch as a result of installation.
 @(& $script:PinModule {param($c,$s)Assert-PinNoDispatch $c $s $c.codexSha256 $c.codexSha256} $cfg $StateRoot)
}
# Read only: the ordinary shared-HOME Codex/17841/OCX10101 original issuer
# is NOT this stopped strict-account worker. An exact session file identifies a
# saved conversation, but cannot authenticate its upstream quota error or send.
function Get-AiccGeneralCliContinuityStatus{
 param([string]$StateRoot,[string]$ThreadId,[string]$DeadlineUtc,[string]$SessionsRoot)
 $out=@{schemaVersion=1;kind='aicc-general-cli-original-issuer-inspect';
  threadId=$ThreadId;state='HOLD';routeKind='original-general-codex-shared-home';
  expectedPath='official-codex-to-17841-to-nonweb-OCX10101';
  routeObservedFromSession=$false;upstreamIssuerReceiptVerified=$false;
  fiveHourFailureVerified=$false;quotaResetAtVerified=$false;
  ownerExitVerified=$false;ownerRevisionVerified=$false;stopEpochVerified=$false;
  sameOriginalGoalVerified=$false;originalQueueApiSupported=$false;
  sourceOnly=$true;dispatchable=$false;modelRequests=0;claimed=$false;
  queueAck=$false;newTurnObserved=$false;goalResumed=$false;
  nativeFallback=$false;deadlineUtc=$DeadlineUtc;deadlineExpired=$null}
 $end=[DateTimeOffset]::MinValue
 if($ThreadId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    ($DeadlineUtc -and ($DeadlineUtc -cnotmatch '^\d{4}-\d\d-\d\dT' -or
    -not [DateTimeOffset]::TryParse($DeadlineUtc,[ref]$end)))){
  $out.state='DEADLINE_OR_EXACT_THREAD_HOLD';return $out
 }
 # An expired run must remain inspectable. This reader never extends a
 # deadline or grants dispatch; execution gates belong to the original sender.
 if($DeadlineUtc){$out.deadlineExpired=($end -le [DateTimeOffset]::UtcNow)}
 try{
  $root=[IO.Path]::GetFullPath($StateRoot)
  $registry=Join-Path $root 'registrations.json'
  $item=Get-Item -LiteralPath $registry -ErrorAction Stop
  if($item.PSIsContainer -or $item.Length -gt 2097152 -or
     ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'original_registry_unsafe'}
  $cfg=Maintenance-Read $registry
  if($cfg.schemaVersion -ne 1 -or $cfg.protocolVersion -ne 3 -or
     $cfg.threads -isnot [Collections.IDictionary] -or
     -not $cfg.threads.ContainsKey($ThreadId)){
   $out.state='ORIGINAL_REGISTERED_THREAD_REQUIRED';return $out
  }
  $entry=$cfg.threads[$ThreadId]
  if($entry.threadId -cne $ThreadId -or $ThreadId -in $cfg.excludedThreadIds -or
     -not [IO.Path]::IsPathFullyQualified([string]$entry.projectRoot)){
   $out.state='ORIGINAL_REGISTRY_SCOPE_HOLD';return $out
  }
  $out.registered=$true
  $out.selectionEnabled=($entry.enabled -eq $true)
  $out.originalPending=($null -ne $entry.attempt -or $null -ne $entry.queueAttempt)
  $out.historicalOtherPending=@($cfg.threads.Values|Where-Object{
    $_.threadId -cne $ThreadId -and ($_.attempt -or $_.queueAttempt)}).Count
  $out.maintenanceStopPresent=([bool]$cfg.workerStopRequestedAt)
  # A null strictAccount is correct for the original general 17841 path.
  # Never force account2, change provider, or adopt the named OCX10100 route.
  $out.namedStrictAccountOverride=($null -ne $entry.strictAccount)
  if($out.namedStrictAccountOverride){
   $out.state='GENERAL_CLI_ROUTE_OVERRIDE_HOLD';return $out
  }
  $sessions=if($SessionsRoot){[IO.Path]::GetFullPath($SessionsRoot)}else{
    [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex/sessions'))
  }
  $file=[IO.Path]::GetFullPath([string]$entry.rollout)
  if(-not $file.StartsWith($sessions+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
   $out.state='ORIGINAL_SAVED_SESSION_SCOPE_HOLD';return $out
  }
  for($cursor=$file;$cursor.StartsWith($sessions,[StringComparison]::OrdinalIgnoreCase);$cursor=[IO.Path]::GetDirectoryName($cursor)){
   $part=Get-Item -LiteralPath $cursor -ErrorAction Stop
   if($part.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'original_rollout_linked'}
   if($cursor -ieq $sessions){break}
  }
  $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  try{
   $first=([IO.StreamReader]::new($stream)).ReadLine()
   if([string]::IsNullOrWhiteSpace($first) -or $first.Length -gt 65536){throw 'original_session_meta_unsafe'}
   $meta=$first|ConvertFrom-Json -AsHashtable -DateKind String
   if($meta.type -cne 'session_meta' -or $meta.payload.id -cne $ThreadId -or
      $meta.payload.source -cnotin @('cli','exec') -or
      [IO.Path]::GetFullPath([string]$meta.payload.cwd) -ine [IO.Path]::GetFullPath([string]$entry.projectRoot)){
    $out.state='ORIGINAL_SESSION_ID_OR_SOURCE_HOLD';return $out
   }
  }finally{$stream.Dispose()}
  $out.exactSavedSessionReadback=$true
  $out.savedSessionSource='cli'
  $out.state=if($out.originalPending){'ORIGINAL_ATTEMPT_UNCERTAIN_NO_REPLAY'}
             elseif($out.maintenanceStopPresent){'ORIGINAL_ISSUER_CALLBACK_UNAVAILABLE_WORKER_STOPPED'}
             else{'ORIGINAL_ISSUER_CALLBACK_AND_SENDER_UNAVAILABLE'}
  # The official original CLI runtime must produce its own accepted/failed
  # request receipt with origin/issuer/previous turn, owner exit and goal.
  # This reader is not an issuer and never consumes a cooperative goal ledger.
  return $out
 }catch{
  $out.state='ORIGINAL_CLI_STATUS_READ_UNVERIFIED'
  return $out
 }
}
# Independent, read-only receiver for source quota evidence. This examines
# the ORIGINAL shared-HOME general CLI registration and an immutable handoff
# without modifying Task, registry, pending attempts or any stop fence.
function Get-AiccGeneralCliQuotaEvidenceReadiness {
 param([string]$StateRoot,[string]$ThreadId,
       [string]$SourceHandoffFile,[string]$ExpectedSourceHandoffSha256,
       [string]$ExpectedGoalSha256,[string]$SessionsRoot)
 $out=@{schemaVersion=1;kind='aicc-original-general-cli-quota-source-preflight/v1';
  threadId=$ThreadId;state='HOLD';sourceOnly=$true;dispatchable=$false;
  originalIssuerAuthenticated=$false;writerAuthorityTransferred=$false;
  ownerReleased=$false;claimed=$false;queueAck=$false;newTurnObserved=$false;
  registryChanged=$false;stopFenceChanged=$false;historicalPendingChanged=$false;
  modelRequests=0;newTurns=0;automaticReplay=$false}
 if($ThreadId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    $ExpectedSourceHandoffSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $ExpectedGoalSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    -not [IO.Path]::IsPathFullyQualified([string]$StateRoot) -or
    -not [IO.Path]::IsPathFullyQualified([string]$SourceHandoffFile)){
  $out.state='ORIGINAL_SOURCE_INPUT_PINS_REQUIRED';return $out
 }
 try{
  $root=[IO.Path]::GetFullPath($StateRoot)
  $registryFile=Join-Path $root 'registrations.json'
  $cfg=Maintenance-Read $registryFile
  if($cfg.protocolVersion -ne 3 -or $cfg.schemaVersion -ne 1 -or
     -not $cfg.threads.ContainsKey($ThreadId)){
   $out.state='CURRENT_GENERAL_OWNER_REGISTRATION_HOLD';return $out
  }
  $current=Get-AiccGeneralCliContinuityStatus -StateRoot $root -ThreadId $ThreadId -SessionsRoot $SessionsRoot
  $out.registrySha256=Maintenance-Hash $registryFile
  $out.registered=$current.registered -eq $true
  $out.exactSession=$current.exactSavedSessionReadback -eq $true
  $out.maintenanceStopPresent=$current.maintenanceStopPresent -eq $true
  $out.namedStrictAccountOverride=$current.namedStrictAccountOverride -eq $true
  $out.originalPending=$current.originalPending -eq $true
  $out.historicalPendingCount=[int]$current.historicalOtherPending
  $out.registeredState=$current.state
  $out.originalProducerRegistered=$null -ne $cfg.originalGeneralCliIssuerProducer
  $out.originalCallbackRegistered=$null -ne $cfg.threads[$ThreadId].originalIssuerQuotaCallback
  if(-not $out.registered -or -not $out.exactSession -or
     $out.namedStrictAccountOverride -or $current.selectionEnabled -ne $true){
   $out.state='ORIGINAL_GENERAL_OWNER_SCOPE_HOLD';return $out
  }
  $candidate=[IO.Path]::GetFullPath($SourceHandoffFile)
  $ownerRoot=[IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $root)))
  $ownerAssets=(Join-Path $ownerRoot 'asset-control')+[IO.Path]::DirectorySeparatorChar
  if(-not $candidate.StartsWith($ownerAssets,[StringComparison]::OrdinalIgnoreCase)){
   $out.state='SOURCE_CANDIDATE_OWNER_ROOT_HOLD';return $out
  }
  for($cursor=$candidate;$cursor.StartsWith($ownerAssets.TrimEnd([IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase);$cursor=Split-Path -Parent $cursor){
   $item=Get-Item -LiteralPath $cursor -ErrorAction Stop
   if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){
    $out.state='SOURCE_CANDIDATE_ALIAS_HOLD';return $out
   }
   if($cursor -ieq $ownerAssets.TrimEnd([IO.Path]::DirectorySeparatorChar)){break}
  }
  $file=Get-Item -LiteralPath $candidate -ErrorAction Stop
  if($file.PSIsContainer -or $file.Length -lt 1 -or $file.Length -gt 65536 -or
     (Maintenance-Hash $candidate) -cne $ExpectedSourceHandoffSha256){
   $out.state='SOURCE_CANDIDATE_BYTES_OR_SHA_HOLD';return $out
  }
  $handoff=Maintenance-Read $candidate
  $entry=$cfg.threads[$ThreadId]
  if($handoff.schemaVersion -ne 1 -or
     $handoff.kind -cne 'aicc-original-cli-quota-source-owner-handoff/v1' -or
     $handoff.status -cne 'SOURCE_RECEIPTS_PINNED_OWNER_AUTHORITY_NOT_GRANTED' -or
     $handoff.threadId -cne $ThreadId -or
     [IO.Path]::GetFullPath([string]$handoff.projectRoot) -ine [IO.Path]::GetFullPath([string]$entry.projectRoot) -or
     $handoff.goalSnapshotSha256 -cne $ExpectedGoalSha256 -or
     $handoff.route -cne 'official-codex-to-17841-to-nonweb-OCX10101' -or
     $handoff.ownerRevision -cnotmatch '^[a-f0-9]{64}$' -or
     $handoff.stopEpoch -isnot [ValueType] -or $handoff.stopEpoch -lt 0 -or
     $handoff.originalIssuerAttested -ne $false -or
     $handoff.originalOwnerReleased -ne $false -or
     $handoff.dispatchable -ne $false){
   $out.state='SOURCE_CANDIDATE_OWNER_GOAL_OR_ROUTE_HOLD';return $out
  }
  foreach($source in @($handoff.sources.failure,$handoff.sources.admission)){
   $filePath=[IO.Path]::GetFullPath([string]$source.file)
   $fileItem=Get-Item -LiteralPath $filePath -ErrorAction Stop
   if($source.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $fileItem.PSIsContainer -or
      ($fileItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $fileItem.Length -lt 1 -or $fileItem.Length -gt 65536 -or
      (Maintenance-Hash $filePath) -cne $source.sha256){
    $out.state='SOURCE_FAILURE_OR_ADMISSION_PIN_CHANGED_HOLD';return $out
   }
  }
  $out.sourceHandoffSha256=$ExpectedSourceHandoffSha256
  $out.sourceReceiptsPinned=$true
  $out.ownerRevisionClaim=$handoff.ownerRevision
  $out.stopEpochClaim=[long]$handoff.stopEpoch
  $out.failedTurnIdClaim=$handoff.failedTurnId
  if($out.originalPending -or $out.historicalPendingCount -gt 0){
   $out.state='ORIGINAL_OR_HISTORICAL_PENDING_UNSETTLED_HOLD';return $out
  }
  if($out.maintenanceStopPresent -or $cfg.worker.state -ceq 'STOPPED_FOR_MAINTENANCE'){
   $out.state='REGISTERED_MAINTENANCE_STOP_FENCE_HOLD';return $out
  }
  # Cryptographic inspection is delegated to the pinned Node consumer by the
  # explicit callback plan. PS source hashes/booleans cannot authenticate it.
  $out.state=if($out.originalProducerRegistered -and $out.originalCallbackRegistered){'REGISTERED_ORIGINAL_CALLBACK_CRYPTOGRAPHIC_INSPECTION_REQUIRED_HOLD'}else{'REGISTERED_ORIGINAL_ISSUER_CALLBACK_AND_OWNER_EPOCH_REQUIRED_HOLD'}
  return $out
 }catch{
  $out.state='ORIGINAL_SOURCE_OR_REGISTRY_READ_UNKNOWN_HOLD';return $out
 }
}
function Callback-Inspect($p){
 if($p.sourcePins.Count -ne 8){throw 'callback_source_closure_required'}
 foreach($pin in @(@{file=$p.nodePath;sha=$p.nodeSha256},@{file=$p.manifestFile;sha=$p.manifestSha256})){
  if(-not [IO.Path]::IsPathFullyQualified([string]$pin.file) -or (Get-Item -LiteralPath $pin.file).LinkType -or (Maintenance-Hash $pin.file) -cne $pin.sha){throw 'callback_runtime_pin_changed'}
 }
 foreach($relative in $p.sourcePins.Keys){
  if($relative -cnotin @('src/codex-goal-resume.mjs','tools/platform/codex/inspect-original-issuer-callback.mjs','tools/platform/windows/CodexContinuityMaintenance.psm1','src/adapters/codex-app-server.mjs','src/adapters/codex-app-server-proxy.mjs','src/adapters/codex-app-server-daemon.mjs','src/lib/windows-owner-only-acl.mjs','src/lib/windows-pwsh.mjs')){throw 'callback_source_scope_changed'}
  $file=Join-Path $p.sourceRoot $relative
  if((Get-Item -LiteralPath $file).LinkType -or (Maintenance-Hash $file) -cne $p.sourcePins[$relative]){throw 'callback_source_pin_changed'}
 }
 $registry=Join-Path $p.stateRoot 'registrations.json'
 if((Maintenance-Hash $registry) -cne $p.registrySha256){throw 'callback_registry_cas_changed'}
 $cfg=Maintenance-Read $registry
 if($cfg.schemaVersion -ne 1 -or $cfg.protocolVersion -ne 3 -or -not $cfg.threads[$p.threadId]){throw 'callback_original_registration_required'}
 if(@($cfg.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt}).Count){throw 'callback_original_or_historical_pending_unsettled_hold'}
 if($cfg.workerStopRequestedAt -or $cfg.worker.state -ceq 'STOPPED_FOR_MAINTENANCE'){throw 'callback_maintenance_stop_preserved_hold'}
 if(-not $cfg.originalGeneralCliIssuerProducer){throw 'callback_independent_original_producer_not_registered_hold'}
 $raw=& $p.nodePath (Join-Path $p.sourceRoot 'tools/platform/codex/inspect-original-issuer-callback.mjs') --manifest $p.manifestFile --manifest-sha256 $p.manifestSha256 --thread $p.threadId --root $p.projectRoot --goal-sha256 $p.goalSha256 --handoff $p.handoffFile --handoff-sha256 $p.handoffSha256 --registry $registry --registry-sha256 $p.registrySha256 --callback $p.callbackFile --callback-sha256 $p.callbackSha256
 if($LASTEXITCODE -ne 0){throw 'callback_original_inspection_unavailable_hold'}
 $result=$raw|ConvertFrom-Json -AsHashtable -DateKind String
 if($result.state -cne 'PREPARED_ORIGINAL_CALLBACK_REGISTRATION_REQUIRES_OWNER_CAS' -or $result.registrationChanged -ne $false -or $result.dispatchable -ne $false -or $result.modelRequests -ne 0){throw ('callback_registration_hold:'+ $result.state)}
 return $result
}
function New-AiccOriginalIssuerCallbackPlan {
 param([string]$StateRoot,[string]$SourceRoot,[string]$NodePath,[string]$ManifestFile,[string]$ExpectedManifestSha256,[string]$ThreadId,[string]$ProjectRoot,[string]$ExpectedGoalSha256,[string]$HandoffFile,[string]$ExpectedHandoffSha256,[string]$CallbackFile,[string]$ExpectedCallbackSha256,[string]$PlanFile)
 GroupInstall-RequireOwner $StateRoot;GroupInstall-PlanScope $StateRoot $PlanFile
 $p=@{schemaVersion=1;action='RegisterOriginalIssuerCallback';stateRoot=[IO.Path]::GetFullPath($StateRoot);sourceRoot=[IO.Path]::GetFullPath($SourceRoot);nodePath=[IO.Path]::GetFullPath($NodePath);nodeSha256=(Maintenance-Hash $NodePath);manifestFile=$ManifestFile;manifestSha256=$ExpectedManifestSha256;threadId=$ThreadId;projectRoot=$ProjectRoot;goalSha256=$ExpectedGoalSha256;handoffFile=$HandoffFile;handoffSha256=$ExpectedHandoffSha256;callbackFile=$CallbackFile;callbackSha256=$ExpectedCallbackSha256;sourcePins=@{};operationId=[guid]::NewGuid().ToString();expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(60).ToString('o')}
 foreach($relative in @('src/codex-goal-resume.mjs','tools/platform/codex/inspect-original-issuer-callback.mjs','tools/platform/windows/CodexContinuityMaintenance.psm1','src/adapters/codex-app-server.mjs','src/adapters/codex-app-server-proxy.mjs','src/adapters/codex-app-server-daemon.mjs','src/lib/windows-owner-only-acl.mjs','src/lib/windows-pwsh.mjs')){$p.sourcePins[$relative]=Maintenance-Hash (Join-Path $SourceRoot $relative)}
 $p.registrySha256=Maintenance-Hash (Join-Path $StateRoot 'registrations.json')
 $proof=Callback-Inspect $p
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($p|ConvertTo-Json -Depth 15))
 $stream=[IO.File]::Open($PlanFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
 @{state='PREPARED_ORIGINAL_CALLBACK_REGISTRATION';planFile=$PlanFile;planSha256=(Maintenance-Hash $PlanFile);confirmation=('REGISTER ORIGINAL CALLBACK '+(Maintenance-Hash $PlanFile));workerStarted=$false;modelRequests=0}
}
function Invoke-AiccOriginalIssuerCallbackPlan {
 param([string]$PlanFile,[string]$ExpectedPlanSha256,[string]$Confirm)
 if((Maintenance-Hash $PlanFile) -cne $ExpectedPlanSha256 -or $Confirm -cne ('REGISTER ORIGINAL CALLBACK '+$ExpectedPlanSha256)){throw 'callback_exact_preview_required'}
 $p=Maintenance-Read $PlanFile
 if($p.schemaVersion -ne 1 -or $p.action -cne 'RegisterOriginalIssuerCallback' -or [DateTimeOffset]::Parse($p.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'callback_stale_preview'}
 GroupInstall-RequireOwner $p.stateRoot;GroupInstall-PlanScope $p.stateRoot $PlanFile
 $lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $p.stateRoot
 try{
  $proof=Callback-Inspect $p
  $file=Join-Path $p.stateRoot 'registrations.json';$cfg=Maintenance-Read $file
  if((Maintenance-Hash $file) -cne $p.registrySha256 -or $cfg.threads[$p.threadId].originalIssuerQuotaCallback){throw 'callback_registry_changed_or_already_registered'}
  if($proof.callbackPin.kind -cne 'aicc-original-cli-issuer-callback-pin/v1' -or
     $proof.callbackPin.receiptFile -cne $p.callbackFile -or
     $proof.callbackPin.receiptSha256 -cne $p.callbackSha256){throw 'callback_inspection_pin_changed'}
  $claim=[IO.File]::Open(($PlanFile+'.claimed'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$claim.Flush($true)}finally{$claim.Dispose()}
  # Keep the exact old registry next to its one-shot plan for recovery. All
  # stop flags, pending requests and producer pins remain byte-value identical.
  $before=[IO.File]::ReadAllBytes($file)
  $backup=[IO.File]::Open(($PlanFile+'.registry.before'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$backup.Write($before);$backup.Flush($true)}finally{$backup.Dispose()}
  $cfg.threads[$p.threadId].originalIssuerQuotaCallback=$proof.callbackPin
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($cfg|ConvertTo-Json -Depth 50))
  $temporary=$PlanFile+'.registry.next'
  $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
  if((Maintenance-Hash $file) -cne $p.registrySha256){throw 'callback_registry_changed_before_commit'}
  [IO.File]::Move($temporary,$file,$true)
  $expectedAfter=[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($bytes))
  if((Maintenance-Hash $file) -cne $expectedAfter){throw 'callback_commit_readback_unknown_do_not_replay'}
  $result=@{schemaVersion=1;state='REGISTERED_ORIGINAL_CALLBACK_SENDER_INACTIVE';operationId=$p.operationId;planSha256=$ExpectedPlanSha256;registryChanged=$true;workerStarted=$false;modelRequests=0;dispatchable=$false;queueAck=$false;newTurnObserved=$false;afterRegistrySha256=$expectedAfter;beforeRegistrySha256=$p.registrySha256}
  $receipt=[Text.UTF8Encoding]::new($false).GetBytes(($result|ConvertTo-Json -Depth 8))
  $stream=[IO.File]::Open(($PlanFile+'.receipt.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($receipt);$stream.Flush($true)}finally{$stream.Dispose()}
  $result
 }finally{$lock.Dispose()}
}
function New-AiccContinuityMaintenancePlan{
 param([string]$StateRoot,[string]$SourceRoot,[string]$NodePath,[string]$PlanFile)
 $source=[IO.Path]::GetFullPath($SourceRoot);$state=[IO.Path]::GetFullPath($StateRoot)
 $workerFence=$null;$lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $state
 try{
  $file=Join-Path $state 'registrations.json';$cfg=Maintenance-Read $file
  $workerFence=& $script:PinModule {param($c,$s)Enter-PinMaintenanceFence $c $s} $cfg $state
  if(-not $workerFence){throw 'maintenance_fence_required'}
  $queues=@(Maintenance-Proof $cfg $state)
  if((Maintenance-Hash $cfg.codexExecutable) -cne $cfg.codexSha256){throw 'current_cli_pin_required'}
  if((Get-Item -LiteralPath $NodePath).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'node_alias_forbidden'}
  $previous=Maintenance-ExistingLauncher $cfg $state
  $task=if($previous){Maintenance-TaskStamp $state}else{$null}
  if($previous -and ([IO.Path]::GetFullPath([string]$NodePath) -ine [IO.Path]::GetFullPath([string]$previous.nodePath) -or
       (Maintenance-Hash $NodePath) -cne $previous.nodeSha256)){throw 'maintenance_previous_node_identity_changed'}
  $p=@{schemaVersion=1;action='InstallStoppedContinuityBundle';stateRoot=$state;sourceRoot=$source;registrySha256=(Maintenance-Hash $file);helperBefore=$cfg.helperSha256;nodePath=[IO.Path]::GetFullPath($NodePath);nodeSha256=(Maintenance-Hash $NodePath);files=(Maintenance-Closure $source);preservedQueues=$queues;expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o');operationId=[guid]::NewGuid().ToString();previousLauncher=$previous;task=$task;upgradeKind=if($previous){'EXISTING_STRICT_LAUNCHER'}else{'INITIAL_LAUNCHER'}}
  $p.releaseRoot=Join-Path (Split-Path -Parent (Split-Path -Parent $state)) ('releases/codex-continuity/maintenance-'+$p.operationId)
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($p|ConvertTo-Json -Depth 15)+[Environment]::NewLine)
  $out=[IO.File]::Open($PlanFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$out.Write($bytes);$out.Flush($true)}finally{$out.Dispose()}
  @{state='PREPARED';planFile=$PlanFile;planSha256=(Maintenance-Hash $PlanFile);confirmation=('INSTALL STOPPED CONTINUITY '+(Maintenance-Hash $PlanFile));upgradeKind=$p.upgradeKind;oldLauncherVerified=($null -ne $previous);taskXmlSha256=if($task){$task.xmlSha256}else{$null};workerStarted=$false;modelRequests=0;canApplyWithoutFreshPreview=$false}
 }finally{if($workerFence){$workerFence.Dispose()};$lock.Dispose()}
}
function Invoke-AiccContinuityMaintenancePlan{
 param([string]$PlanFile,[string]$ExpectedPlanSha256,[string]$Confirm)
 if((Maintenance-Hash $PlanFile) -cne $ExpectedPlanSha256 -or $Confirm -cne ('INSTALL STOPPED CONTINUITY '+$ExpectedPlanSha256)){throw 'exact_maintenance_preview_required'}
 $p=Maintenance-Read $PlanFile
 if($p.schemaVersion -ne 1 -or $p.action -cne 'InstallStoppedContinuityBundle' -or [DateTimeOffset]::Parse($p.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'stale_maintenance_plan'}
 $expectedRelease=Join-Path (Split-Path -Parent (Split-Path -Parent $p.stateRoot)) ('releases/codex-continuity/maintenance-'+$p.operationId)
 if($p.operationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or [IO.Path]::GetFullPath($p.releaseRoot) -ine [IO.Path]::GetFullPath($expectedRelease)){throw 'maintenance_release_scope_changed'}
 foreach($relative in $p.files.Keys){
  if([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)' -or $relative.Contains(':')){throw 'maintenance_bundle_relative_path_required'}
 }
 $state=$p.stateRoot;$file=Join-Path $state 'registrations.json';$workerFence=$null;$held=@()
 $lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $state
 try{
  $cfg=Maintenance-Read $file;$workerFence=& $script:PinModule {param($c,$s)Enter-PinMaintenanceFence $c $s} $cfg $state
  if(-not $workerFence -or (Maintenance-Hash $file) -cne $p.registrySha256){throw 'maintenance_registry_cas_changed'}
  $queues=@(Maintenance-Proof $cfg $state)
  $queueDigest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $queues
  $previewDigest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v @($p.preservedQueues)
  if($queueDigest -cne $previewDigest){throw 'maintenance_queue_proof_changed'}
  if((Maintenance-Hash $cfg.codexExecutable) -cne $cfg.codexSha256 -or (Maintenance-Hash $p.nodePath) -cne $p.nodeSha256){throw 'maintenance_toolchain_changed'}
  $previous=Maintenance-ExistingLauncher $cfg $state
  if($p.upgradeKind -cne $(if($previous){'EXISTING_STRICT_LAUNCHER'}else{'INITIAL_LAUNCHER'})){throw 'maintenance_previous_launcher_generation_changed'}
  if($previous){
   if($previous.sha256 -cne $p.previousLauncher.sha256 -or
      $previous.helperSha256 -cne $p.helperBefore -or
      $previous.nodePath -ine $p.nodePath -or $previous.nodeSha256 -cne $p.nodeSha256){throw 'maintenance_previous_pin_cas_changed'}
   $task=Maintenance-TaskStamp $state
   if($task.xmlSha256 -cne $p.task.xmlSha256 -or $task.vbsSha256 -cne $p.task.vbsSha256 -or
      $task.taskName -cne $p.task.taskName -or $task.state -cne $p.task.state){throw 'maintenance_task_xml_cas_changed'}
  }elseif($p.previousLauncher -or $p.task){throw 'maintenance_unexpected_prior_task_or_launcher'}
  foreach($r in $p.files.Keys){$source=Join-Path $p.sourceRoot $r;$held+=,[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);if((Maintenance-Hash $source) -cne $p.files[$r]){throw 'maintenance_source_changed'}}
  foreach($q in $queues){$held+=,[IO.File]::Open($q.receiptFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);if((Maintenance-Hash $q.receiptFile) -cne $q.receiptSha256){throw 'maintenance_receipt_changed'}}
  $claim=[IO.File]::Open($PlanFile+'.claimed',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$claim.Dispose()
  $before=[IO.File]::ReadAllBytes($file);$backup=$PlanFile+'.before.json';$b=[IO.File]::Open($backup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$b.Write($before);$b.Flush($true)}finally{$b.Dispose()}
  if((Maintenance-Hash $backup) -cne $p.registrySha256){throw 'maintenance_backup_mismatch'}
  if(Test-Path -LiteralPath $p.releaseRoot){throw 'maintenance_release_exists'}
  New-Item -ItemType Directory -Path $p.releaseRoot|Out-Null
  foreach($r in $p.files.Keys){$dest=Join-Path $p.releaseRoot $r;New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $p.sourceRoot $r) -Destination $dest;if((Maintenance-Hash $dest) -cne $p.files[$r]){throw 'maintenance_install_hash_mismatch'}}
  $newHelper=Join-Path $p.releaseRoot 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'
  $pin=@{schemaVersion=1;route='command-route-r2';nodePath=$p.nodePath;nodeSha256=$p.nodeSha256;bridgePath=(Join-Path $p.releaseRoot 'src/codex-strict-continuity-bridge.mjs');bridgeSha256=$p.files['src/codex-strict-continuity-bridge.mjs'];routeModulePath=(Join-Path $p.releaseRoot 'src/codex-cli-routes.mjs');routeModuleSha256=$p.files['src/codex-cli-routes.mjs'];codexSha256=$cfg.codexSha256;releaseRoot=$p.releaseRoot;files=$p.files}
  # Preserve every original byte outside the exact helper and launcher fields.
  $nextBytes=Maintenance-RegistryBytes $before $cfg $newHelper $pin
  $nextText=[Text.UTF8Encoding]::new($false,$true).GetString($nextBytes)
  $next=$nextText|ConvertFrom-Json -AsHashtable -DateKind String
  $afterThreads=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $next.threads
  $beforeThreads=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $cfg.threads
  if($afterThreads -cne $beforeThreads -or $next.workerStopRequestedAt -cne $cfg.workerStopRequestedAt){throw 'maintenance_preservation_failed'}
  if((Maintenance-Hash $file) -cne $p.registrySha256){throw 'maintenance_registry_cas_changed'}
  $temp=$file+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllBytes($temp,$nextBytes)
  [IO.File]::Move($temp,$file,$true)
  $expectedAfter=[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($nextBytes))
  if((Maintenance-Hash $file) -cne $expectedAfter){throw 'maintenance_readback_unknown'}
  $receipt=@{schemaVersion=1;kind='aicc-stopped-maintenance-immutable-upgrade';status='INSTALLED_STOPPED';operationId=$p.operationId;planSha256=(Maintenance-Hash $PlanFile);releaseRoot=$p.releaseRoot;helperPath=$newHelper;helperSha256=$next.helperSha256;installedFiles=$p.files.Count;beforeSha256=$p.registrySha256;afterSha256=$expectedAfter;backup=$backup;backupSha256=(Maintenance-Hash $backup);preservedQueues=$queues;previousLauncherSha256=if($previous){$previous.sha256}else{$null};task=$p.task;newLauncherSha256=(& $script:PinModule {param($v)Get-PinValueDigest $v} -v $pin);upgradeKind=$p.upgradeKind;workerStarted=$false;stopFencePreserved=$true;threadStatesChanged=$false;taskChanged=$false;modelRequests=0;runtimeAcceptance='NOT_RUN';rollback='exact before/after registry CAS, unchanged Task XML, pinned old/new immutable closure, same maintenance worker lock; no blind restore'}
  $receiptBytes=[Text.UTF8Encoding]::new($false).GetBytes(($receipt|ConvertTo-Json -Depth 20)+[Environment]::NewLine)
  $out=[IO.File]::Open($PlanFile+'.receipt.json',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$out.Write($receiptBytes);$out.Flush($true)}finally{$out.Dispose()}
  $receipt
 }finally{foreach($h in $held){$h.Dispose()};if($workerFence){$workerFence.Dispose()};$lock.Dispose()}
}
# Reconcile an interrupted install without restarting its original claim.
function Get-AiccContinuityMaintenanceStatus{
 param([string]$PlanFile)
 $out=@{schemaVersion=1;kind='aicc-continuity-maintenance-inspect';
   state='HOLD';modelRequests=0;newWorkerStarted=$false;automaticRetry=$false}
 try{
  $p=Maintenance-Read $PlanFile
  if($p.schemaVersion -ne 1 -or $p.action -cne 'InstallStoppedContinuityBundle'){throw 'exact_maintenance_plan_required'}
  $file=Join-Path $p.stateRoot 'registrations.json'
  $hash=Maintenance-Hash $file
  $claimed=Test-Path -LiteralPath ($PlanFile+'.claimed') -PathType Leaf
  $receiptFile=$PlanFile+'.receipt.json'
  $rollbackFile=$PlanFile+'.rollback.json'
  if(Test-Path -LiteralPath $rollbackFile -PathType Leaf){
   $rb=Maintenance-Read $rollbackFile
   $out.state=if($rb.status -ceq 'ROLLED_BACK_STOPPED' -and $hash -cne $rb.afterSha256){'ROLLED_BACK_RECEIPT_BUT_STATE_CHANGED_HOLD'}elseif($rb.status -ceq 'ROLLED_BACK_STOPPED' -and $hash -ceq $rb.afterSha256){'ROLLED_BACK_STOPPED'}else{'ROLLBACK_RECEIPT_UNKNOWN'}
   return $out
  }
  if(-not $claimed){
   $out.state=if($hash -ceq $p.registrySha256){'PREPARED_NOT_APPLIED'}else{'PREVIEW_REGISTRY_CHANGED_HOLD'}
   return $out
  }
  if(-not (Test-Path -LiteralPath $receiptFile -PathType Leaf)){
   $out.state='APPLY_CLAIMED_RESULT_UNKNOWN_NO_REPLAY';return $out
  }
  $receipt=Maintenance-Read $receiptFile
  if($receipt.schemaVersion -ne 1 -or $receipt.kind -cne 'aicc-stopped-maintenance-immutable-upgrade' -or
     $receipt.operationId -cne $p.operationId -or $receipt.planSha256 -cne (Maintenance-Hash $PlanFile)){
   $out.state='RECEIPT_IDENTITY_HOLD';return $out
  }
  $out.state=if($hash -ceq $receipt.afterSha256){'INSTALLED_STOPPED_NOT_STARTED'}else{'AFTER_REGISTRY_CAS_CHANGED_HOLD'}
 }catch{$out.state='READ_OR_PIN_UNVERIFIED_HOLD'}
 $out
}
function Maintenance-QueueScopeDigest($proofs){
 $safe=@(foreach($proof in @($proofs)){
  $copy=@{}
  foreach($key in $proof.Keys){
   if($key -cne 'helperSha256'){$copy[$key]=$proof[$key]}
  }
  $copy
 })
 & $script:PinModule {param($v)Get-PinValueDigest $v} -v $safe
}
function Undo-AiccContinuityMaintenancePlan{
 param([string]$PlanFile,[string]$ExpectedPlanSha256,[string]$ExpectedReceiptSha256,[string]$Confirm)
 if($ExpectedPlanSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $ExpectedReceiptSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    (Maintenance-Hash $PlanFile) -cne $ExpectedPlanSha256 -or
    $Confirm -cne ('ROLLBACK STOPPED CONTINUITY '+$ExpectedReceiptSha256)){
  throw 'exact_maintenance_rollback_receipts_required'
 }
 $p=Maintenance-Read $PlanFile
 $receiptFile=$PlanFile+'.receipt.json'
 if((Maintenance-Hash $receiptFile) -cne $ExpectedReceiptSha256){throw 'maintenance_rollback_receipt_sha_changed'}
 $r=Maintenance-Read $receiptFile
 if($p.schemaVersion -ne 1 -or $p.action -cne 'InstallStoppedContinuityBundle' -or
    $r.schemaVersion -ne 1 -or $r.kind -cne 'aicc-stopped-maintenance-immutable-upgrade' -or
    $r.status -cne 'INSTALLED_STOPPED' -or
    $r.operationId -cne $p.operationId -or $r.planSha256 -cne $ExpectedPlanSha256 -or
    $r.beforeSha256 -cne $p.registrySha256 -or $r.upgradeKind -cne $p.upgradeKind -or
    $r.backup -cne ($PlanFile+'.before.json') -or
    $r.backupSha256 -cne $p.registrySha256 -or
    [IO.Path]::GetFullPath([string]$r.releaseRoot) -ine [IO.Path]::GetFullPath([string]$p.releaseRoot)){
  throw 'maintenance_rollback_owner_binding_changed'
 }
 $state=$p.stateRoot;$file=Join-Path $state 'registrations.json'
 $lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $state
 $workerFence=$null
 try{
  $cfg=Maintenance-Read $file
  $workerFence=& $script:PinModule {param($c,$s)Enter-PinMaintenanceFence $c $s} $cfg $state
  if(-not $workerFence -or (Maintenance-Hash $file) -cne $r.afterSha256){
   throw 'maintenance_rollback_current_registry_cas_changed'
  }
  $task=if($p.task){Maintenance-TaskStamp $state}else{$null}
  if($p.task -and ($task.xmlSha256 -cne $p.task.xmlSha256 -or
                  $task.vbsSha256 -cne $p.task.vbsSha256 -or
                  $task.taskName -cne $p.task.taskName -or $task.state -cne 'Disabled')){
   throw 'maintenance_rollback_task_changed'
  }
  $currentPin=Maintenance-ExistingLauncher $cfg $state
  if(-not $currentPin -or $currentPin.releaseRoot -ine $p.releaseRoot -or
     $currentPin.sha256 -cne $r.newLauncherSha256 -or
     $cfg.helperSha256 -cne $r.helperSha256 -or
     $currentPin.fileCount -ne $p.files.Count){throw 'maintenance_rollback_new_release_changed'}
  foreach($relative in $p.files.Keys){
   if((Maintenance-Hash (Join-Path $p.releaseRoot $relative)) -cne $p.files[$relative]){
    throw 'maintenance_rollback_new_closure_changed'
   }
  }
  $before=[IO.File]::ReadAllBytes($r.backup)
  if((Maintenance-Hash $r.backup) -cne $p.registrySha256){throw 'maintenance_rollback_backup_sha_changed'}
  $prior=[Text.UTF8Encoding]::new($false,$true).GetString($before)|ConvertFrom-Json -AsHashtable -DateKind String
  $oldPin=Maintenance-ExistingLauncher $prior $state
  if($p.previousLauncher){
   if(-not $oldPin -or $oldPin.sha256 -cne $p.previousLauncher.sha256 -or
      $oldPin.helperSha256 -cne $p.helperBefore){throw 'maintenance_rollback_old_pin_changed'}
  }elseif($oldPin){throw 'maintenance_rollback_unexpected_old_pin'}
  if($prior.workerStopRequestedAt -cne $cfg.workerStopRequestedAt -or
     (& $script:PinModule {param($v)Get-PinValueDigest $v} -v $prior.threads) -cne
     (& $script:PinModule {param($v)Get-PinValueDigest $v} -v $cfg.threads)){
   throw 'maintenance_rollback_original_threads_or_stop_changed'
  }
  $currentQueues=@(Maintenance-Proof $cfg $state)
  if((Maintenance-QueueScopeDigest $currentQueues) -cne
     (Maintenance-QueueScopeDigest @($p.preservedQueues))){
   throw 'maintenance_rollback_queue_changed'
  }
  if(Test-Path -LiteralPath ($PlanFile+'.rollback-claimed') -PathType Leaf){
   throw 'maintenance_rollback_already_claimed_no_replay'
  }
  $mark=[IO.File]::Open($PlanFile+'.rollback-claimed',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$mark.Flush($true)}finally{$mark.Dispose()}
  if((Maintenance-Hash $file) -cne $r.afterSha256){throw 'maintenance_rollback_registry_changed_after_claim'}
  $temp=$file+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllBytes($temp,$before)
  [IO.File]::Move($temp,$file,$true)
  if((Maintenance-Hash $file) -cne $r.beforeSha256){throw 'maintenance_rollback_readback_unknown'}
  $result=@{schemaVersion=1;kind='aicc-stopped-maintenance-rollback';status='ROLLED_BACK_STOPPED';
    operationId=$p.operationId;planSha256=$ExpectedPlanSha256;installReceiptSha256=$ExpectedReceiptSha256;
    beforeSha256=$r.afterSha256;afterSha256=$r.beforeSha256;
    oldReleasePreserved=$true;newReleasePreserved=$true;taskChanged=$false;
    stopFencePreserved=$true;threadStatesChanged=$false;workerStarted=$false;
    modelRequests=0;automaticReplay=$false}
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($result|ConvertTo-Json -Depth 12)+[Environment]::NewLine)
  $output=[IO.File]::Open($PlanFile+'.rollback.json',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$output.Write($bytes);$output.Flush($true)}finally{$output.Dispose()}
  $result
 }finally{if($workerFence){$workerFence.Dispose()};$lock.Dispose()}
}
. (Join-Path $PSScriptRoot 'CodexContinuityGroupInstall.ps1')
. (Join-Path $PSScriptRoot 'CodexContinuityGroupActivation.ps1')
Export-ModuleMember -Function New-AiccContinuityMaintenancePlan,Invoke-AiccContinuityMaintenancePlan,New-AiccGroupOwnerInstallPlan,Invoke-AiccGroupOwnerInstallPlan,Undo-AiccGroupOwnerInstallPlan,Get-AiccGroupActivationStatus,New-AiccGroupActivationPlan,Invoke-AiccGroupActivationPlan,Undo-AiccGroupActivationPlan,Get-AiccContinuityMaintenanceStatus,Undo-AiccContinuityMaintenancePlan,Get-AiccGeneralCliContinuityStatus,Get-AiccGeneralCliQuotaEvidenceReadiness,New-AiccOriginalIssuerCallbackPlan,Invoke-AiccOriginalIssuerCallbackPlan
