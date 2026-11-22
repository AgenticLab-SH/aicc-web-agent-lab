#requires -Version 7.5
# Dot-sourced only by the SHA-pinned Invoke-AiccCodexContinuity helper.
# Owner files are evidence, not model instructions or fallback authorization.
function Test-GroupRegularFile([string]$File,[string]$Root,[string]$ExpectedSha){
 if(-not [IO.Path]::IsPathFullyQualified($File) -or $ExpectedSha -cnotmatch '^[a-f0-9]{64}$'){throw 'group_file_pin_required'}
 $base=[IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
 $full=[IO.Path]::GetFullPath($File)
 if((Get-Item -LiteralPath $Root -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'group_file_root_linked'}
 if(-not $full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'group_file_outside_owner_scope'}
 for($p=$full;$p.StartsWith($base,[StringComparison]::OrdinalIgnoreCase);$p=[IO.Path]::GetDirectoryName($p)){
  $item=Get-Item -LiteralPath $p -ErrorAction Stop
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'group_file_linked'}
 }
 $item=Get-Item -LiteralPath $full -ErrorAction Stop
 if($item.PSIsContainer -or $item.Length -gt 2097152 -or (Get-FileHash -LiteralPath $full).Hash.ToLowerInvariant() -cne $ExpectedSha){throw 'group_file_identity_changed'}
}
function GroupOwner-ManagedReleasePath([string]$Standalone,$Junction){
 # Inspect current metadata only. Never bypass a Windows untrusted mount.
 $root=[IO.Path]::GetFullPath($Standalone).TrimEnd([IO.Path]::DirectorySeparatorChar)
 $current=Join-Path $root 'current'
 if(-not $Junction -or $Junction.LinkType -cne 'Junction' -or
    -not $Junction.PSIsContainer -or
    -not ($Junction.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    [IO.Path]::GetFullPath([string]$Junction.FullName) -ine $current){
  throw 'recovered_cli_managed_current_required'
 }
 $targets=@($Junction.Target)
 if($targets.Count -ne 1 -or $targets[0] -isnot [string]){throw 'recovered_cli_release_target_unsafe'}
 # Windows Junction.Target normally reports an absolute path. Normalize only
 # an exact child of this managed releases directory; reject foreign roots.
 $target=$targets[0]
 if([IO.Path]::IsPathFullyQualified($target)){
  $target=[IO.Path]::GetRelativePath($root,[IO.Path]::GetFullPath($target))
 }
 $m=[regex]::Match($target,
  '^releases[\\/](?<leaf>[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9_]+-pc-windows-msvc)$')
 if(-not $m.Success){throw 'recovered_cli_release_target_unsafe'}
 $releases=[IO.Path]::GetFullPath((Join-Path $root 'releases'))
 $release=[IO.Path]::GetFullPath((Join-Path $releases $m.Groups['leaf'].Value))
 if([IO.Path]::GetDirectoryName($release) -ine $releases){throw 'recovered_cli_release_target_unsafe'}
 $exe=Join-Path $release 'bin/codex.exe'
 for($path=$exe;$path;$path=[IO.Path]::GetDirectoryName($path)){
  $item=Get-Item -LiteralPath $path -ErrorAction Stop
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType){
   throw 'recovered_cli_direct_release_reparse_forbidden'
  }
  if($path -ieq $exe){
   if($item.PSIsContainer){throw 'recovered_cli_release_file_required'}
  }elseif(-not $item.PSIsContainer){throw 'recovered_cli_release_directory_required'}
  if($path -ieq [IO.Path]::GetPathRoot($path)){break}
 }
 return $release
}
function Get-GroupRecoveredCliOwnerActivity($entry,$cfg){
 # Only an explicitly installed, disabled-at-install group entry can use this.
 # The original vscode metadata is immutable; the recovered CLI is transport,
 # not a grant of owner authority or permission to ignore pending delivery.
 $p=$entry.recoveredCliTransport
 if($entry.groupOwnerOnly -cne $true -or $entry.strictAccount -ne 2 -or -not $p -or
    $p.schemaVersion -ne 1 -or $p.kind -cne 'aicc-recovered-cli-transport' -or
    $p.threadId -cne $entry.threadId -or $p.ownerPid -le 0 -or
    $p.metaSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $p.commandLineSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $p.evidenceSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $p.codexSha256 -cne $cfg.codexSha256 -or
    $p.signerThumbprint -cnotmatch '^[A-F0-9]{40}$' -or
    [IO.Path]::GetFullPath([string]$p.projectRoot) -ine [IO.Path]::GetFullPath($entry.projectRoot) -or
    [IO.Path]::GetFullPath([string]$p.rollout) -ine [IO.Path]::GetFullPath($entry.rollout) -or
    [IO.Path]::GetFullPath([string]$p.codexExecutable) -ine [IO.Path]::GetFullPath($cfg.codexExecutable) -or
    (@($p.resumeArgs)|ConvertTo-Json -Compress) -cne (@('--no-daemon','resume',$entry.threadId)|ConvertTo-Json -Compress)){
  throw 'recovered_cli_registry_proof_changed'
 }
 $statePlans=Join-Path $StateRoot 'plans'
 $evidence=[IO.Path]::GetFullPath([string]$p.evidenceFile)
 $plansPrefix=[IO.Path]::GetFullPath($statePlans).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
 if(-not $evidence.StartsWith($plansPrefix,[StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetDirectoryName($evidence) -ine $statePlans -or
    (Get-Item -LiteralPath $statePlans -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint -or
    (Get-Item -LiteralPath $evidence -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint -or
    (Get-FileHash -LiteralPath $evidence -Algorithm SHA256).Hash.ToLowerInvariant() -cne $p.evidenceSha256){throw 'recovered_cli_owner_evidence_changed'}
 $availability=Thread-Availability $entry
 if($availability.state -cne 'ACTIVE' -or $availability.meta.source -isnot [string] -or
    $availability.meta.source -cne 'vscode'){throw 'recovered_cli_original_source_changed'}
 $stream=[IO.File]::Open($entry.rollout,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
 try{$reader=[IO.StreamReader]::new($stream);$first=$reader.ReadLine();if(-not $first -or $first.Length -gt 65536){throw 'recovered_cli_original_metadata_missing'}
  if((Digest-Text $first) -cne $p.metaSha256){throw 'recovered_cli_original_metadata_drift'}
 }finally{$stream.Dispose()}
 $ownerHome=[Environment]::GetFolderPath('UserProfile')
 $standalone=Join-Path $ownerHome '.codex/packages/standalone'
 $current=Join-Path $standalone 'current'
 $anchor=Join-Path $current 'bin/codex.exe'
 $junction=Get-Item -LiteralPath $current -ErrorAction Stop
 if($junction.LinkType -cne 'Junction' -or [IO.Path]::GetFullPath($cfg.codexExecutable) -ine [IO.Path]::GetFullPath($anchor)){throw 'recovered_cli_official_current_changed'}
 $release=GroupOwner-ManagedReleasePath $standalone $junction
 $releaseExe=Join-Path $release 'bin/codex.exe'
 if((Get-FileHash -LiteralPath $anchor -Algorithm SHA256).Hash.ToLowerInvariant() -cne $p.codexSha256 -or
    (Get-FileHash -LiteralPath $releaseExe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $p.codexSha256){throw 'recovered_cli_signed_binary_changed'}
 $sig=Get-AuthenticodeSignature -LiteralPath $releaseExe -ErrorAction Stop
 if($sig.Status -ne 'Valid' -or -not $sig.SignerCertificate -or
    $sig.SignerCertificate.Subject -notmatch '(?:^|, )O="?OpenAI OpCo, LLC"?(?:,|$)' -or
    $sig.SignerCertificate.Thumbprint -cne $p.signerThumbprint){throw 'recovered_cli_signed_origin_changed'}
 $owners=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$p.ownerPid) -ErrorAction Stop)
 if($owners.Count -eq 0){return 'EXITED'}
 if($owners.Count -ne 1){throw 'recovered_cli_owner_observation_unknown'}
 $proc=$owners[0]
 if(-not $proc.CreationDate -or $proc.CreationDate.ToUniversalTime().ToString('o') -cne
    ([DateTimeOffset]::Parse([string]$p.ownerCreatedAt)).UtcDateTime.ToString('o')){throw 'recovered_cli_pid_reused_or_owner_changed'}
 if([IO.Path]::GetFullPath([string]$proc.ExecutablePath) -ine [IO.Path]::GetFullPath($releaseExe) -and
    [IO.Path]::GetFullPath([string]$proc.ExecutablePath) -ine [IO.Path]::GetFullPath($anchor)){throw 'recovered_cli_owner_executable_changed'}
 if((Digest-Text ([string]$proc.CommandLine)) -cne $p.commandLineSha256){throw 'recovered_cli_owner_command_changed'}
 $rx='^(?:"(?<quoted>[^"]+)"|(?<unquoted>[^\s"]+))\s+--no-daemon\s+resume\s+(?<id>[a-f0-9-]{36})\s*$'
 if([string]$proc.CommandLine -cnotmatch $rx -or $Matches['id'] -cne $entry.threadId){throw 'recovered_cli_owner_not_exact_resume'}
 $argExe=if($Matches['quoted']){$Matches['quoted']}else{$Matches['unquoted']}
 if([IO.Path]::GetFullPath($argExe) -ine [IO.Path]::GetFullPath($anchor) -and
    [IO.Path]::GetFullPath($argExe) -ine [IO.Path]::GetFullPath($releaseExe)){throw 'recovered_cli_owner_argv_binary_changed'}
 return 'ACTIVE'
}
function Get-GroupOwnerProof($cfg,[bool]$AllowQueued,[string]$RequestedThreadId,[int]$RequestedAccountNumber,[string]$RequestedEventId,[string]$RequestedEventSha256,[string]$RequestedResultSha256,[string]$RequestedStateRoot){
 $out=@{schemaVersion=1;kind='aicc-group-owner-inspect';state='GROUP_OWNER_HOLD';threadId=$RequestedThreadId;exactThreadId=$RequestedThreadId;accountNumber=2;requestedAccountNumber=$RequestedAccountNumber;route='command-route-r2';claimed=$false;dispatched=$false;automaticReplay=$false;modelRequests=0}
 $expectedState=[IO.Path]::GetFullPath((Join-Path $ownerHome '.ai-control-center/control-plane/codex-continuity'))
 if($RequestedStateRoot -ine $expectedState){$out.state='GROUP_OWNER_ROOT_REQUIRED';return $out}
 $g=$cfg.groupOwner;$e=$cfg.threads[$RequestedThreadId]
 if(-not $g -or $g.schemaVersion -ne 1 -or $g.kind -cne 'aicc-owner-group-event' -or -not $e -or $RequestedThreadId -in $cfg.excludedThreadIds -or
    $e.groupOwnerOnly -cne $true -or $e.strictAccount -ne 2 -or $RequestedAccountNumber -ne 2 -or
    $RequestedThreadId -cne $g.threadId -or $RequestedEventId -cne $g.eventId -or ($RequestedEventSha256 -and $RequestedEventSha256 -cne $g.eventSha256) -or $RequestedResultSha256 -cne $g.resultSha256 -or
    $g.eventId -cnotmatch '^[a-f0-9]{64}$' -or $g.eventSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $g.ownerRevision -cnotmatch '^[a-f0-9]{64}$' -or $g.resultSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $g.workerOperationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    ($g.stopEpoch -isnot [int] -and $g.stopEpoch -isnot [long])){$out.state='GROUP_OWNER_BINDING_HOLD';return $out}
 $out.eventId=$g.eventId;$out.eventSha256=$g.eventSha256;$out.ownerRevision=$g.ownerRevision;$out.stopEpoch=$g.stopEpoch;$out.workerOperationId=$g.workerOperationId
 $out.sourceId=$g.sourceId;$out.resultSha256=$g.resultSha256;$out.root=$e.projectRoot
 if($e.groupOwnerRevision -cne $g.ownerRevision -or [string]$e.groupStopEpoch -cne [string]$g.stopEpoch -or $e.groupWorkerOperationId -cne $g.workerOperationId){$out.state='GROUP_OWNER_GENERATION_HOLD';return $out}
 if($cfg.workerStopRequestedAt){$out.state='WORKER_STOP_HOLD';return $out}
 if($e.attempt -or $e.queueAttempt -or @($cfg.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt}).Count){$out.state='PENDING_DELIVERY_HOLD';return $out}
 if($e.holdReason -or $e.state -match 'UNKNOWN|UNCERTAIN|HOLD|COMPLETE|RESUMING_OCX'){$out.state='ORIGINAL_PENDING_OR_HOLD';return $out}
 if($AllowQueued){
  if(-not $e.groupEvent -or $e.groupEvent.state -cne 'ENQUEUED' -or $e.groupEvent.eventId -cne $RequestedEventId){$out.state='GROUP_EVENT_NOT_QUEUED';return $out}
 }elseif($e.groupEvent){$out.state='GROUP_EVENT_ALREADY_RECORDED';return $out}
 try{
  $inbox=Join-Path $RequestedStateRoot 'group-inbox'
  $expected=Join-Path $inbox ($RequestedEventId+'.json')
  if([IO.Path]::GetFullPath([string]$g.eventFile) -ine $expected){throw 'group_inbox_identity_changed'}
  Test-GroupRegularFile $expected $RequestedStateRoot $g.eventSha256
  $v=Read-Json $expected
  foreach($key in @('threadId','eventId','ownerRevision','stopEpoch','workerOperationId','resultSha256','sourceId','registrationSha256','terminalSha256','sourceWriterReceiptSha256','projectRoot')){
   $expectedValue=if($key -eq 'projectRoot'){$e.projectRoot}else{$g[$key]}
   if([string]$v[$key] -cne [string]$expectedValue){throw 'owner_event_binding_changed'}
  }
  if($v.schemaVersion -ne 1 -or $v.kind -cne 'aicc-owner-group-event' -or $v.issuer -cne 'aicc-owner-controller' -or
     $v.accountNumber -ne 2 -or $v.route -cne 'command-route-r2' -or
     $v.callbackPending -cne $false -or $v.queuePending -cne $false -or $v.originalPending -cne $false -or
     $v.writerReleased -cne $true -or $v.sourceWriterReturned -cne $true -or $v.stopRequested -cne $false -or $v.authorityFresh -cne $true){throw 'owner_event_evidence_unknown'}
  $age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse([string]$v.observedAt)).TotalSeconds
  if($age -lt -3 -or $age -ge 120){throw 'owner_event_expired'}
  if($v.resultFile -cne $g.resultFile -or $v.sourceWriterReceiptFile -cne $g.sourceWriterReceiptFile){throw 'group_source_path_changed'}
  Test-GroupRegularFile $g.resultFile $g.sourceRoot $g.resultSha256
  Test-GroupRegularFile $g.sourceWriterReceiptFile $g.sourceRoot $g.sourceWriterReceiptSha256
  Test-GroupRegularFile $g.registrationFile ([IO.Path]::GetDirectoryName($g.registrationFile)) $g.registrationSha256
  $source=Read-Json $g.resultFile
  if($source.status -cne $g.expectedStatus){throw 'source_terminal_status_changed'}
  $receipt=Read-Json $g.sourceWriterReceiptFile
  if($receipt.schemaVersion -ne 1 -or $receipt.kind -cne 'aicc-source-writer-return' -or
     $receipt.threadId -cne $RequestedThreadId -or $receipt.sourceId -cne $g.sourceId -or $receipt.resultSha256 -cne $g.resultSha256 -or
     $receipt.ownerRevision -cne $g.ownerRevision -or $receipt.workerOperationId -cne $g.workerOperationId -or
     [string]$receipt.stopEpoch -cne [string]$g.stopEpoch -or $receipt.returned -cne $true -or $receipt.closed -cne $true){throw 'source_writer_return_unverified'}
  if((Thread-Availability $e).state -cne 'ACTIVE'){$out.state='ORIGINAL_THREAD_NOT_ACTIVE';return $out}
  if((Thread-Owner $e) -cne 'RELEASED'){$out.state='ORIGINAL_WRITER_NOT_RELEASED';return $out}
  $terminal=Terminal-Evidence $e
  if($terminal.state -cne 'TERMINAL' -or $terminal.sha256 -cne $g.terminalSha256){$out.state='ORIGINAL_TERMINAL_CHANGED_HOLD';return $out}
  $null=Get-StrictRouteLauncher $cfg
  $quota=Get-StrictAccountReadiness 2
  if($quota.state -cne 'STRICT_ACCOUNT_READY' -or $quota.quotaFresh -cne $true){$out.state=$quota.state;return $out}
  $out.state='READY';$out.quotaFresh=$true;$out.idle=$true;$out.writerReleased=$true;$out.sourceWriterReturned=$true
  $out.originalPending=$false;$out.stopRequested=$false;$out.authorityFresh=$true;$out.callbackPending=$false;$out.queuePending=$false
  $out.sourceWriterReceiptSha256=$g.sourceWriterReceiptSha256;$out.terminalSha256=$g.terminalSha256;$out.registrationSha256=$g.registrationSha256
 }catch{$out.state='GROUP_OWNER_EVIDENCE_HOLD'}
 $out
}
function Add-GroupOwnerEvent($cfg,[string]$RequestedThreadId,[int]$RequestedAccountNumber,[string]$RequestedEventId,[string]$RequestedEventSha256,[string]$RequestedResultSha256,[string]$RequestedStateRoot){
 if($RequestedEventSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'exact_group_enqueue_event_sha_required'}
 $proof=Get-GroupOwnerProof $cfg $false $RequestedThreadId $RequestedAccountNumber $RequestedEventId $RequestedEventSha256 $RequestedResultSha256 $RequestedStateRoot
 if($proof.state -cne 'READY'){throw ('group_event_not_ready:'+ $proof.state)}
 $folder=Join-Path $RequestedStateRoot 'group-events'
 if(-not(Test-Path -LiteralPath $folder -PathType Container)){New-Item -ItemType Directory -Path $folder -Force|Out-Null}
 if((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'group_event_folder_linked'}
 $marker=Join-Path $folder ($RequestedEventId+'.json')
 if(Test-Path -LiteralPath $marker){throw 'group_event_already_consumed'}
 $record=@{schemaVersion=1;eventId=$RequestedEventId;eventSha256=$cfg.groupOwner.eventSha256;resultSha256=$cfg.groupOwner.resultSha256;threadId=$RequestedThreadId;ownerRevision=$cfg.groupOwner.ownerRevision;stopEpoch=$cfg.groupOwner.stopEpoch;workerOperationId=$cfg.groupOwner.workerOperationId;state='ENQUEUED';createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Depth 5 -Compress)+[Environment]::NewLine)
 $handle=[IO.File]::Open($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$handle.Write($bytes);$handle.Flush($true)}finally{$handle.Dispose()}
 $e=$cfg.threads[$RequestedThreadId];$e.groupEvent=$record;$e.enabled=$true;$e.state='GROUP_EVENT_ENQUEUED';$e.nextCheckAt=[DateTimeOffset]::UtcNow.ToString('o')
 @{schemaVersion=1;kind='aicc-group-owner-enqueue';state='STRICT_INTENT_RECORDED';eventId=$RequestedEventId;threadId=$RequestedThreadId;claimed=$false;dispatched=$false;automaticReplay=$false;modelRequests=0}
}
function Confirm-GroupOwnerClaim($cfg,$entry,[string]$RequestedStateRoot,[string]$RunningWorkerOperationId){
 if($entry.groupOwnerOnly -cne $true){return $false}
 $g=$cfg.groupOwner;$event=$entry.groupEvent
 if(-not $g -or -not $event -or $RunningWorkerOperationId -cne $g.workerOperationId -or $event.state -cne 'ENQUEUED' -or $event.eventId -cne $g.eventId -or $event.ownerRevision -cne $g.ownerRevision -or
    $event.workerOperationId -cne $g.workerOperationId -or [string]$event.stopEpoch -cne [string]$g.stopEpoch -or
    $event.resultSha256 -cne $g.resultSha256){return $false}
 $marker=Join-Path $RequestedStateRoot ('group-events/'+$g.eventId+'.json')
 $claimed=Join-Path $RequestedStateRoot ('group-claims/'+$g.eventId+'.json')
 if(Test-Path -LiteralPath $claimed){return $false}
 try{
  $record=Read-Json $marker
  if($record.eventId -cne $event.eventId -or $record.eventSha256 -cne $event.eventSha256 -or $record.state -cne 'ENQUEUED'){return $false}
  # Worker -Action Worker has no caller-supplied event parameters. Exact values
  # are inherited only from the same locked registration, never guessed.
  $proof=Get-GroupOwnerProof $cfg $true $entry.threadId 2 $g.eventId $g.eventSha256 $g.resultSha256 $RequestedStateRoot
  if($proof.state -cne 'READY'){return $false}
  $folder=Split-Path -Parent $claimed
  if(-not(Test-Path -LiteralPath $folder)){New-Item -ItemType Directory -Path $folder -Force|Out-Null}
  if((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint){return $false}
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes((@{schemaVersion=1;eventId=$g.eventId;threadId=$entry.threadId;ownerRevision=$g.ownerRevision;workerOperationId=$g.workerOperationId;state='CLAIM_INTENT_NO_REPLAY';claimedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json -Compress)+[Environment]::NewLine)
  $handle=[IO.File]::Open($claimed,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$handle.Write($bytes);$handle.Flush($true)}finally{$handle.Dispose()}
  $entry.groupEvent.state='CLAIMED'
  return $true
 }catch{return $false}
}
function Register-GroupOwnerEvidence($cfg,[string]$RequestedThreadId,[int]$RequestedAccountNumber,[string]$RequestedEventId,[string]$RequestedEventSha256,[string]$RequestedStateRoot,[string]$RequestedConfirm){
 $ownerState=[IO.Path]::GetFullPath((Join-Path $ownerHome '.ai-control-center/control-plane/codex-continuity'))
 if($RequestedStateRoot -ine $ownerState){throw 'group_owner_local_root_required'}
 if($RequestedAccountNumber -ne 2 -or $RequestedThreadId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    $RequestedEventId -cnotmatch '^[a-f0-9]{64}$' -or $RequestedEventSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $RequestedConfirm -cne ('AUTHORIZE GROUP EVENT '+$RequestedEventSha256)){throw 'exact_group_owner_confirmation_required'}
 $e=$cfg.threads[$RequestedThreadId]
 if(-not $e -or $e.groupOwnerOnly -cne $true -or $e.strictAccount -ne 2 -or $RequestedThreadId -in $cfg.excludedThreadIds -or
    $e.attempt -or $e.queueAttempt -or $e.groupEvent -or $cfg.groupOwner){throw 'group_owner_registration_unavailable'}
 if(@($cfg.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt}).Count){throw 'pending_delivery_preserved'}
 $eventFile=Join-Path $RequestedStateRoot ('group-inbox/'+$RequestedEventId+'.json')
 Test-GroupRegularFile $eventFile $RequestedStateRoot $RequestedEventSha256
 $v=Read-Json $eventFile
 if($v.schemaVersion -ne 1 -or $v.kind -cne 'aicc-owner-group-event' -or $v.issuer -cne 'aicc-owner-controller' -or
    $v.eventId -cne $RequestedEventId -or $v.threadId -cne $RequestedThreadId -or
    $v.accountNumber -ne 2 -or $v.route -cne 'command-route-r2' -or $v.projectRoot -ine $e.projectRoot -or
    $v.ownerRevision -cne $e.groupOwnerRevision -or [string]$v.stopEpoch -cne [string]$e.groupStopEpoch -or
    $v.workerOperationId -cne $e.groupWorkerOperationId -or $v.sourceId -cnotmatch '^[A-Za-z0-9._-]{1,100}$' -or
    $v.resultSha256 -cnotmatch '^[a-f0-9]{64}$' -or $v.terminalSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $v.registrationSha256 -cnotmatch '^[a-f0-9]{64}$' -or $v.sourceWriterReceiptSha256 -cnotmatch '^[a-f0-9]{64}$'){
   throw 'group_owner_provenance_invalid'
 }
 if($v.callbackPending -cne $false -or $v.queuePending -cne $false -or $v.originalPending -cne $false -or
    $v.writerReleased -cne $true -or $v.sourceWriterReturned -cne $true -or $v.stopRequested -cne $false -or $v.authorityFresh -cne $true){
   throw 'group_owner_pending_or_issuer_hold'
 }
 $age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse([string]$v.observedAt)).TotalSeconds
 if($age -lt -3 -or $age -ge 120){throw 'group_owner_event_stale'}
 Test-GroupRegularFile $v.resultFile $v.sourceRoot $v.resultSha256
 Test-GroupRegularFile $v.sourceWriterReceiptFile $v.sourceRoot $v.sourceWriterReceiptSha256
 Test-GroupRegularFile $v.registrationFile ([IO.Path]::GetDirectoryName([string]$v.registrationFile)) $v.registrationSha256
 $receipt=Read-Json $v.sourceWriterReceiptFile
 if($receipt.kind -cne 'aicc-source-writer-return' -or $receipt.schemaVersion -ne 1 -or
    $receipt.threadId -cne $RequestedThreadId -or $receipt.sourceId -cne $v.sourceId -or $receipt.resultSha256 -cne $v.resultSha256 -or
    $receipt.ownerRevision -cne $v.ownerRevision -or [string]$receipt.stopEpoch -cne [string]$v.stopEpoch -or
    $receipt.workerOperationId -cne $v.workerOperationId -or $receipt.returned -cne $true -or $receipt.closed -cne $true){
   throw 'group_owner_source_receipt_invalid'
 }
 $reg=Read-Json $v.registrationFile
 if($reg.targetThreadId -cne $RequestedThreadId -or $reg.ownerRevision -cne $v.ownerRevision -or
    [string]$reg.stopEpoch -cne [string]$v.stopEpoch -or $reg.workerOperationId -cne $v.workerOperationId -or
    $reg.strictContinuity.eventId -cne $RequestedEventId){throw 'group_owner_scheduler_registration_mismatch'}
 $cfg.groupOwner=@{
  schemaVersion=1;kind=$v.kind;eventId=$RequestedEventId;eventSha256=$RequestedEventSha256;eventFile=$eventFile
  threadId=$RequestedThreadId;ownerRevision=$v.ownerRevision;stopEpoch=$v.stopEpoch;workerOperationId=$v.workerOperationId
  sourceRoot=$v.sourceRoot;sourceId=$v.sourceId;resultFile=$v.resultFile;resultSha256=$v.resultSha256;expectedStatus=$v.expectedStatus
  sourceWriterReceiptFile=$v.sourceWriterReceiptFile;sourceWriterReceiptSha256=$v.sourceWriterReceiptSha256
  registrationFile=$v.registrationFile;registrationSha256=$v.registrationSha256;terminalSha256=$v.terminalSha256
 }
 @{schemaVersion=1;kind='aicc-group-owner-registration';state='OWNER_EVENT_REGISTERED_NOT_ENQUEUED';eventId=$RequestedEventId;threadId=$RequestedThreadId;claimed=$false;dispatched=$false;modelRequests=0;automaticReplay=$false}
}
