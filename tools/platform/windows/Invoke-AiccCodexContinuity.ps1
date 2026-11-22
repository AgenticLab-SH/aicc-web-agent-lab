#requires -Version 7.5
[CmdletBinding()]
param([ValidateSet('Worker','Candidates','FindThread','Overview','Register','Enable','Resume','Disable','Complete','Status','StopWorker','QueuePreflight','QueueMessage','DesktopQueue','DesktopClaim','DesktopAck','DesktopObserve','DesktopHeartbeatObserve','StrictPreflight','QuotaPreflight','GroupInspect','GroupEnqueue','GroupAuthorise')][string]$Action='Status',[string]$ThreadId,[string]$StateRoot,[string]$EvidenceFile,[string]$AttemptId,[string]$ExpectedTerminalSha256,[string]$SenderThreadId,[string]$MessageFile,[string]$OperationId,[ValidateRange(0,99)][int]$StrictAccountNumber=0,[string]$EventId,[string]$ExpectedEventSha256,[string]$ExpectedResultSha256,[string]$QuotaDeadlineUtc,[string]$Confirm)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ownerHome=[Environment]::GetFolderPath('UserProfile')
if(-not $StateRoot){$StateRoot=Join-Path $ownerHome '.ai-control-center\control-plane\codex-continuity'}
$StateRoot=[IO.Path]::GetFullPath($StateRoot)
$configFile=Join-Path $StateRoot 'registrations.json'
$codexHome=Join-Path $ownerHome '.codex'
$utf8=[Text.UTF8Encoding]::new($false)
$protocolVersion=3
function Helper-Identity { @{protocolVersion=$protocolVersion;helperSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()} }
function Assert-HelperIdentity($cfg){$identity=Helper-Identity;if($cfg.protocolVersion -ne $identity.protocolVersion -or $cfg.helperSha256 -cne $identity.helperSha256){throw 'continuity_protocol_or_helper_pin_mismatch'}}
function Read-Json($file){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){return $null};$item=Get-Item -LiteralPath $file;if($item.LinkType -or $item.Length -gt 2097152){throw 'state_file_unsafe'};Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json -AsHashtable -DateKind String}
function Write-Json($file,$value){$temp=$file+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($temp,($value|ConvertTo-Json -Depth 14)+[Environment]::NewLine,$utf8);for($attempt=0;$attempt -lt 5;$attempt++){try{[IO.File]::Move($temp,$file,$true);return}catch [IO.IOException]{if($attempt -eq 4){throw};Start-Sleep -Milliseconds 40}}}
function With-Registry($operation){New-Item -ItemType Directory -Path $StateRoot -Force|Out-Null;$lock=$null;for($i=0;$i -lt 20;$i++){try{$lock=[IO.File]::Open($configFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);break}catch{Start-Sleep -Milliseconds 100}};if(-not $lock){throw 'registry_busy'};try{$cfg=Read-Json $configFile;if(-not $cfg -or $cfg.schemaVersion -ne 1){throw 'registered_configuration_required'};& $operation $cfg;Write-Json $configFile $cfg}finally{$lock.Dispose()}}
function Metadata($file){$stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{$reader=[IO.StreamReader]::new($stream);$line=$reader.ReadLine();if($line.Length -gt 65536){throw 'session_metadata_oversize'};$meta=$line|ConvertFrom-Json -AsHashtable -DateKind String;if($meta.type -ne 'session_meta' -or $meta.payload.id -notmatch '^[a-f0-9-]{36}$'){throw 'session_metadata_missing'};$meta.payload}finally{$stream.Dispose()}}
function Thread-Surface($meta){if($meta.source -is [System.Collections.IDictionary]){return 'subagent'};if($meta.originator -eq 'Codex Desktop' -or $meta.source -eq 'vscode'){return 'desktop'};if($meta.source -in @('cli','exec') -and $meta.originator -in @('codex-tui','codex_exec','codex_cli_rs')){return 'cli'};'unknown'}
function Thread-Availability($entry){
 # Archiving moves the rollout. Never follow it into the archive to resume work,
 # rebind another file, unarchive, or erase an uncertain delivery attempt.
 try{
  $file=[IO.Path]::GetFullPath([string]$entry.rollout)
  $sessions=[IO.Path]::GetFullPath((Join-Path $codexHome 'sessions'))+[IO.Path]::DirectorySeparatorChar
  if(-not $file.StartsWith($sessions,[StringComparison]::OrdinalIgnoreCase)){return @{state='THREAD_SCOPE_HOLD';reason='ROLLOUT_OUTSIDE_ACTIVE_SESSIONS'}}
  if(-not(Test-Path -LiteralPath $file -PathType Leaf)){
   $archived=Join-Path (Join-Path $codexHome 'archived_sessions') ([IO.Path]::GetFileName($file))
   if(Test-Path -LiteralPath $archived -PathType Leaf){return @{state='ARCHIVED_THREAD_HOLD';reason='ARCHIVED_BY_APP'}}
   return @{state='ROLLOUT_MISSING_HOLD';reason='SAVED_SESSION_NOT_FOUND'}
  }
  $item=Get-Item -LiteralPath $file
  while($item -and $item.FullName.StartsWith($sessions.TrimEnd([IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){
   if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){return @{state='THREAD_SCOPE_HOLD';reason='LINKED_SESSION_PATH'}}
   $item=if($item -is [IO.FileInfo]){$item.Directory}else{$item.Parent}
  }
  $meta=Metadata $file
  if($meta.id -cne $entry.threadId -or [IO.Path]::GetFullPath([string]$meta.cwd) -ine [IO.Path]::GetFullPath([string]$entry.projectRoot)){return @{state='THREAD_SCOPE_HOLD';reason='REGISTERED_SCOPE_CHANGED'}}
  return @{state='ACTIVE';meta=$meta}
 }catch{return @{state='THREAD_OBSERVATION_HOLD';reason='SESSION_READ_FAILED';errorType=$_.Exception.GetType().FullName}}
}
function Assert-ThreadAvailable($entry){$availability=Thread-Availability $entry;if($availability.state -ne 'ACTIVE'){throw ('thread_unavailable:'+ $availability.state)}}
function Digest-Text([string]$text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()}
function Queue-Order($entries){@($entries|Sort-Object @{Expression={if($_.lastDispatchAt){[string]$_.lastDispatchAt}else{''}}},@{Expression={[string]$_.enabledAt}},@{Expression={[string]$_.threadId}})}
function Terminal-Evidence($entry){
 $events=@(Read-Tail $entry.rollout);$last=$events|Where-Object {$_.type -in @('user_message','task_started','task_complete','turn_aborted')}|Select-Object -Last 1
 if(-not $last){return @{state='TERMINAL_EVIDENCE_UNKNOWN'}}
 $digest=Digest-Text (($last.type,[string]$last.recordedAt,[string]$last.last_agent_message)|ConvertTo-Json -Compress)
 $hold=$null;$pattern='(?m)^AICC_CONTINUITY_HOLD:'+ [regex]::Escape($entry.threadId)+':([A-Z0-9_]{1,80})\s*$'
 if($last.type -eq 'task_complete' -and $last.last_agent_message -match $pattern){$hold=$Matches[1]}
 $authorized=$entry.resumeAuthorization -and $entry.resumeAuthorization.terminalSha256 -ceq $digest
 $quota=$entry.lastTerminal -ceq 'turn.failed' -and $entry.failureKind -ceq 'QUOTA_WAIT' -and $entry.lastTerminalAt -and $last.recordedAt -and [DateTimeOffset]::Parse($last.recordedAt) -le [DateTimeOffset]::Parse($entry.lastTerminalAt)
 @{state=if($hold -and -not $authorized){'REQUIRED_ACTION_HOLD'}elseif($last.type -ne 'task_complete' -and -not $quota){'INTERRUPTED_TURN_HOLD'}else{'TERMINAL'};sha256=$digest;holdReason=$hold;event=$last;quotaTerminal=$quota}
}
function Assert-DesktopEvidence($entry,$proof){
 Assert-ThreadAvailable $entry
 if(-not $proof -or $proof.schemaVersion -ne 1 -or $proof.source -cne 'codex-app.read_thread' -or $proof.threadId -cne $entry.threadId -or [IO.Path]::GetFullPath([string]$proof.projectRoot) -ine [IO.Path]::GetFullPath($entry.projectRoot)){throw 'exact_app_thread_evidence_required'}
 $age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse([string]$proof.observedAt)).TotalSeconds
 if($age -lt -2 -or $age -gt 30 -or $proof.status -notin @('active','idle','notLoaded','systemError')){throw 'fresh_app_thread_evidence_required'}
 if($proof.turnId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'exact_app_turn_required'}
 if((Thread-Surface (Metadata $entry.rollout)) -ne 'desktop'){throw 'desktop_thread_required'}
}
function Assert-DesktopTargetRoute($entry,$proof){
 # The caller copies only fields actually returned by official read_thread.
 # A local config, pool quota, selected model label or caller guess is not proof.
 $route=$proof.targetRoute
 if(-not $route -or $route.source -cne 'codex-app.read_thread' -or $route.provider -cne 'ocx' -or $route.threadId -cne $entry.threadId -or $route.turnId -cne $proof.turnId -or $route.responseSha256 -notmatch '^[a-f0-9]{64}$'){throw 'actual_target_ocx_route_unproven'}
 $age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse([string]$route.observedAt)).TotalSeconds
 if($age -lt -2 -or $age -gt 30 -or [IO.Path]::GetFullPath([string]$route.projectRoot) -ine [IO.Path]::GetFullPath($entry.projectRoot)){throw 'fresh_exact_target_ocx_route_required'}
 return @{source=$route.source;provider='ocx';threadId=$route.threadId;turnId=$route.turnId;observedAt=$route.observedAt;responseSha256=$route.responseSha256;scope='exact-target-turn'}
}
function Continuity-Progress($entry){
 # Rollout hints and pool readiness are not fresh official idle/target-route proof.
 $attempt=if($entry.attempt){$entry.attempt}else{$entry.lastContinuityAttempt}
 $observation=if($entry.lastDesktopObservation){$entry.lastDesktopObservation}else{$entry.lastDesktopResult}
 $quota=$attempt.poolReadiness;$route=$attempt.targetRoute;$routeRecorded=$route -and $route.provider -ceq 'ocx' -and $route.threadId -ceq $entry.threadId
 $reason='OFFICIAL_SENDER_REQUIRED'
 if($entry.enabled -ne $true){$reason=if($entry.state -eq 'COMPLETE'){'QUEUE_TRACKING_COMPLETE'}else{'SELECTION_DISABLED'}}
 elseif($entry.holdReason -or $entry.state -eq 'REQUIRED_ACTION_HOLD'){$reason='USER_ACTION_HOLD'}
 elseif($entry.attempt){$reason=if($entry.state -eq 'DESKTOP_TURN_ACTIVE'){'TARGET_ACTIVE_WAIT'}elseif($entry.attempt.ack){'NEW_TURN_OBSERVATION_REQUIRED'}else{'DELIVERY_UNCERTAIN_NO_REPLAY'}}
 elseif($entry.state -in @('USER_STOP_HOLD','INTERRUPTED_TURN_HOLD')){$reason='USER_STOP_HOLD'}
 elseif($entry.state -eq 'DESKTOP_ACTIVITY_HINT'){$reason='TARGET_ACTIVITY_REQUIRES_APP_READ'}
 elseif($entry.state -eq 'QUOTA_WAIT'){$reason='QUOTA_WAIT'}
 elseif($entry.state -in @('ARCHIVED_THREAD_HOLD','ROLLOUT_MISSING_HOLD','THREAD_SCOPE_HOLD','THREAD_OBSERVATION_HOLD','DESKTOP_FAILURE_HOLD')){$reason=$entry.state}
 elseif($entry.state -match 'ROUTE|OCX|POLICY|ADMISSION'){$reason='ROUTE_OR_QUOTA_UNCONFIRMED'}
 $newTurn=$attempt -and $observation -and $observation.attemptId -ceq $attempt.id -and $observation.turnId -and $observation.turnId -cne $attempt.previousTurnId
 @{
  scope='aicc-continuity-not-codex-goal';reason=$reason;dispatchable=$false;automaticReplay=$false;localWorkerCanInvoke=$false
  queueRegistered=$true;selected=($entry.enabled -eq $true)
  quota=@{state=if($quota){$quota.state}else{'UNKNOWN'};observedAt=$quota.observedAt;scope='ocx-pool-only';targetRoute=if($routeRecorded){'RECORDED_OCX_AT_CLAIM'}else{'UNPROVEN'};targetRouteObservedAt=$route.observedAt;resetTimeIsReadiness=$false;currentTargetRouteReady=$false}
  claim=@{state=if($attempt){'RECORDED'}else{'NOT_RECORDED'};attemptId=$attempt.id;at=$attempt.at}
  deliveryAck=@{state=if($attempt.ack){'RECORDED'}else{'NOT_RECORDED'};at=$attempt.deliveryAckAt}
  newTurn=@{state=if($newTurn){'OBSERVED'}else{'NOT_RECORDED'};turnStatus=if($newTurn){$observation.turnStatus}else{$null};observedAt=if($newTurn){$observation.observedAt}else{$null}}
  goal=@{state='UNKNOWN';source='codex-goal-not-read';queueTrackingComplete=($entry.state -eq 'COMPLETE');completionIsNotInferredFromTurn=$true}
 }
}
function Recent-Candidates($cfg){
 $rows=@{};$index=Join-Path $codexHome 'session_index.jsonl';$titles=@{}
 if(Test-Path -LiteralPath $index){foreach($line in Get-Content -LiteralPath $index -Encoding utf8){try{$x=$line|ConvertFrom-Json -AsHashtable -DateKind String;$titles[$x.id]=[string]$x.thread_name}catch{}}}
 for($day=0;$day -lt 7;$day++){$folder=Join-Path $codexHome ('sessions/'+(Get-Date).AddDays(-$day).ToString('yyyy/MM/dd',[Globalization.CultureInfo]::InvariantCulture));if(-not(Test-Path -LiteralPath $folder)){continue};foreach($file in Get-ChildItem -LiteralPath $folder -File -Filter 'rollout-*.jsonl'|Sort-Object LastWriteTimeUtc -Descending|Select-Object -First 60){try{$meta=Metadata $file.FullName;$surface=Thread-Surface $meta;if($meta.id -in $cfg.excludedThreadIds -or $surface -in @('subagent','unknown')){continue};if($rows.ContainsKey($meta.id)){continue};$title=([string]$titles[$meta.id] -replace '[\x00-\x1f\x7f]',' ');if(-not $title){$title='최근 대화 '+$meta.id.Substring(0,8)};if($title.Length -gt 110){$title=$title.Substring(0,110)};$rows[$meta.id]=@{threadId=$meta.id;title=$title;projectRoot=$meta.cwd;rollout=$file.FullName;executionSurface=$surface;updatedAt=$file.LastWriteTimeUtc.ToString('o');registered=$cfg.threads.ContainsKey($meta.id);enabled=($cfg.threads.ContainsKey($meta.id) -and $cfg.threads[$meta.id].enabled -eq $true)}}catch{}}}
 foreach($entry in $cfg.threads.Values){if($entry.threadId -notin $cfg.excludedThreadIds -and -not $rows.ContainsKey($entry.threadId)){$row=@{};foreach($key in $entry.Keys){$row[$key]=$entry[$key]};$row.registered=$true;try{$row.executionSurface=Thread-Surface (Metadata $entry.rollout)}catch{$row.executionSurface='unknown'};$rows[$entry.threadId]=$row}}
 # Registered entries must remain reachable even when many newer chats exist.
 @($rows.Values|Where-Object registered|Sort-Object updatedAt -Descending)
 @($rows.Values|Where-Object {-not $_.registered}|Sort-Object updatedAt -Descending|Select-Object -First 60)
}
function Find-ExactCandidate($cfg,[string]$id){
 if($id -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $id -in $cfg.excludedThreadIds){return $null}
 if($cfg.threads.ContainsKey($id)){$row=@{};foreach($key in $cfg.threads[$id].Keys){$row[$key]=$cfg.threads[$id][$key]};$row.registered=$true}
 else{
  # Explicit UUID lookup only: no full-history scan on typing or background refresh.
  $files=@(Get-ChildItem -LiteralPath (Join-Path $codexHome 'sessions') -Recurse -File -Filter ('*'+$id+'*.jsonl')|Select-Object -First 2)
  if($files.Count -ne 1){return $null}
  $meta=Metadata $files[0].FullName
  if($meta.id -cne $id -or (Thread-Surface $meta) -in @('unknown','subagent')){return $null}
  $row=@{threadId=$id;title=('대화 '+$id.Substring(0,8));projectRoot=$meta.cwd;rollout=$files[0].FullName;updatedAt=$files[0].LastWriteTimeUtc.ToString('o');registered=$false;enabled=$false}
 }
 $index=Join-Path $codexHome 'session_index.jsonl'
 if(Test-Path -LiteralPath $index){foreach($line in Get-Content -LiteralPath $index -Encoding UTF8){try{$record=$line|ConvertFrom-Json -AsHashtable -DateKind String;if($record.id -ceq $id -and $record.thread_name){$row.title=([string]$record.thread_name -replace '[\x00-\x1f\x7f]',' ')}}catch{}}}
 if($row.title.Length -gt 110){$row.title=$row.title.Substring(0,110)}
 $availability=Thread-Availability $row;$row.availabilityState=$availability.state
 $row.executionSurface=if($availability.state -eq 'ACTIVE'){Thread-Surface $availability.meta}else{'unknown'}
 if($availability.state -eq 'ACTIVE'){$row.terminalSha256=(Terminal-Evidence $row).sha256;if($row.executionSurface -eq 'desktop'){$row.queueProgress=Queue-Progress $row}}
 $row
}
function Read-Tail($file){$stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{$offset=[Math]::Max(0,$stream.Length-1048576);$null=$stream.Seek($offset,[IO.SeekOrigin]::Begin);$reader=[IO.StreamReader]::new($stream);$text=$reader.ReadToEnd();$lines=$text -split "`n";if($offset -gt 0){$lines=$lines|Select-Object -Skip 1};$events=@();foreach($line in $lines){try{$row=$line|ConvertFrom-Json -AsHashtable -DateKind String;if($row.type -eq 'event_msg'){$row.payload.recordedAt=$row.timestamp;$events+=,$row.payload}}catch{}};$events}finally{$stream.Dispose()}}
function Process-Alive($id,$created){if(-not $id -or -not $created){return $false};$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$id) -ErrorAction SilentlyContinue;if(-not $p){return $false};$p.CreationDate.ToUniversalTime().Ticks -eq [DateTimeOffset]::Parse([string]$created).UtcDateTime.Ticks}
# A Desktop transport is not an interactive writer. Exclude it only with exact
# command, same-session parent lineage, installed paths and valid OpenAI signatures.
$script:desktopSignatures=@{}
function Test-DesktopTransport($process){
 if($process.CommandLine -notmatch '(?:^|\s)exec-server(?:\s|$)' -or $process.CommandLine -notmatch '(?:^|\s)--remote(?:\s|$)'){return $false}
 $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$process.ParentProcessId) -ErrorAction SilentlyContinue
 if(-not $parent -or $parent.Name -ine 'ChatGPT.exe' -or $parent.SessionId -ne $process.SessionId -or $process.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){return $false}
 if($parent.ExecutablePath -notmatch '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -or $process.ExecutablePath -notmatch '(?i)\\(?:Local\\OpenAI\\Codex\\bin\\[^\\]+|Programs\\OpenAI\\Codex\\bin)\\codex\.exe$'){return $false}
 foreach($path in @($parent.ExecutablePath,$process.ExecutablePath)){
  try{$item=Get-Item -LiteralPath $path -ErrorAction Stop;$key=$path+'|'+$item.LastWriteTimeUtc.Ticks+'|'+$item.Length
   if(-not $script:desktopSignatures.ContainsKey($key)){$signature=Get-AuthenticodeSignature -LiteralPath $path;$script:desktopSignatures[$key]=($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'OpenAI OpCo, LLC')}
   if(-not $script:desktopSignatures[$key]){return $false}
  }catch{return $false}
 }
 return $true
}
function Thread-Owner($entry){
 $script:ownerBlocker=$null
 $surface=Thread-Surface (Metadata $entry.rollout)
 if($surface -ne 'cli'){
  if($surface -ne 'desktop' -or -not $entry.recoveredCliTransport){return 'DESKTOP_APP_TRANSPORT_REQUIRED'}
  try{$originalOwner=Get-GroupRecoveredCliOwnerActivity $entry $script:registry}
  catch{$script:ownerBlocker=@{kind='recovered_cli_proof_hold'};return 'RECOVERED_CLI_TRANSPORT_HOLD'}
  if($originalOwner -cne 'EXITED'){return 'EXACT_THREAD_OWNER_ACTIVE'}
 }
 if(Process-Alive $entry.ownerPid $entry.ownerCreatedAt){return 'REGISTERED_OWNER_ACTIVE'}
 foreach($p in @(Get-CimInstance Win32_Process -Filter "Name='codex.exe'")){
  if(-not $p.CommandLine){$script:ownerBlocker=@{pid=$p.ProcessId;kind='unreadable_codex'};return 'OWNER_UNKNOWN'}
  if($p.CommandLine.Contains($entry.threadId)){return 'EXACT_THREAD_OWNER_ACTIVE'}
  if(Test-DesktopTransport $p){continue}
  if($p.CommandLine -notmatch '(?:^|\s)app-server(?:\s|$)'){
   $known=$false;foreach($id in $script:registry.threads.Keys){$other=$script:registry.threads[$id];if($p.ProcessId -eq $other.ownerPid -and (Process-Alive $other.ownerPid $other.ownerCreatedAt)){$known=$true};if($p.CommandLine.Contains($id)){$known=$true}}
   if(-not $known){$script:ownerBlocker=@{pid=$p.ProcessId;kind='unclassified_cli'};return 'UNCLASSIFIED_CLI_OWNER'}
  }
 }
 'RELEASED'
}
function Get-RegisteredOwnerPolicy {
 # Same read-only snapshot contract as external-broker-transport.ts. No lease,
 # credential refresh, route change or inference request is made here.
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=(Get-Command ssh.exe -ErrorAction Stop).Source;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 foreach($arg in @('-T','-o','BatchMode=yes','-o','ConnectTimeout=10','skct-relay-micro','/demo/owner/.local/bin/oracle-a1-connection exec -- python3 /demo/owner/.local/share/aicc-ocx-local/local-broker.py')){$info.ArgumentList.Add($arg)}
 $p=[Diagnostics.Process]::Start($info)
 try{$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync();$p.StandardInput.Write('{"action":"snapshot"}');$p.StandardInput.Close();if(-not $p.WaitForExit(45000)){try{$p.Kill()}catch{};throw 'owner_policy_timeout'};if($p.ExitCode -ne 0 -or $out.Result.Length -gt 262144){throw 'owner_policy_unavailable'};$snapshot=$out.Result|ConvertFrom-Json -AsHashtable -DateKind String
  $age=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$snapshot.observedAt
  if($snapshot.ok -cne $true -or $snapshot.settings.schemaVersion -ne 1 -or $age -lt 0 -or $age -ge 60000){throw 'owner_policy_unverified'}
  foreach($rule in @($snapshot.settings.fiveHour,$snapshot.settings.longWindow)){if($rule.usedThreshold -isnot [long] -and $rule.usedThreshold -isnot [int]){throw 'owner_policy_invalid'};if($rule.usedThreshold -lt 1 -or $rule.usedThreshold -gt 100 -or $rule.action -notin @('switch','stop')){throw 'owner_policy_invalid'}}
  return @{strictAdmission=$true;freshQuotaRequired=$true;fiveHourUsedThreshold=$snapshot.settings.fiveHour.usedThreshold;longWindowUsedThreshold=$snapshot.settings.longWindow.usedThreshold;fiveHourAction=$snapshot.settings.fiveHour.action;longWindowAction=$snapshot.settings.longWindow.action;source='registered-a1-snapshot';observedAt=$snapshot.observedAt}
 }finally{$p.Dispose()}
}
# The separate OCX CLI supports strict selection, but continuity has no
# pinned strict launcher. A selected account cannot inherit pool readiness.
function Resolve-StrictOwnerAccount([int]$number){
 if($number -lt 1 -or $number -gt 99){throw 'strict_account_number_required'}
 $runtime=Join-Path $ownerHome '.ai-control-center\runtime\ocx-local'
 $reg=Read-Json (Join-Path $runtime 'current.json')
 $expectedHome=Join-Path $runtime 'home'
 if(-not $reg -or $reg.schemaVersion -ne 1 -or $reg.requestExecution -cne 'windows-local' -or $reg.credentialWriter -cne 'a1' -or -not $reg.opencodexHome -or [IO.Path]::GetFullPath([string]$reg.opencodexHome) -ine [IO.Path]::GetFullPath($expectedHome)){throw 'strict_owner_registry_mismatch'}
 $cfg=Read-Json (Join-Path $expectedHome 'config.json')
 if(-not $cfg -or -not $cfg.codexAccounts -or -not $cfg.codexAccountNamespaces){throw 'strict_account_mapping_missing'}
 $rows=@($cfg.codexAccounts|Where-Object {$_.isMain -ne $true -and [string]$_.alias -cmatch ('^'+$number+'번\([^()\r\n]+\)\z')})
 if($rows.Count -ne 1 -or -not $rows[0].id){throw 'strict_account_number_not_unique'}
 $row=$rows[0];$selectors=@($cfg.codexAccountNamespaces.Keys|Where-Object {$cfg.codexAccountNamespaces[$_] -ceq $row.id})
 $selector=if($selectors -ccontains $row.logLabel){[string]$row.logLabel}elseif($selectors.Count -eq 1){[string]$selectors[0]}else{$null}
 if(-not $selector -or $selector -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z' -or $selector -in @('__proto__','prototype','constructor')){throw 'strict_selector_not_unique'}
 @{number=$number;selector=$selector;accountId=[string]$row.id;paused=($cfg.pausedCodexAccountIds -ccontains $row.id);registry=$reg}
}
function Get-StrictAccountReadiness([int]$number){
 try{$binding=Resolve-StrictOwnerAccount $number}catch{return @{state='STRICT_SELECTOR_MISMATCH';reason='OWNER_LOCAL_BINDING_UNVERIFIED';quotaFresh=$false}}
 if($binding.paused){return @{state='STRICT_ACCOUNT_PAUSED';quotaFresh=$false}}
 try{
  $ready=Invoke-RestMethod 'http://127.0.0.1:10100/readyz' -NoProxy -TimeoutSec 8
  if($ready.ready -ne $true -or $ready.requestExecution -cne 'windows-local' -or $ready.credentialWriter -cne 'a1' -or $ready.nativeExcluded -ne $true){return @{state='STRICT_ENDPOINT_MISMATCH';quotaFresh=$false}}
  $policy=Get-RegisteredOwnerPolicy
  if($policy.strictAdmission -ne $true -or $policy.freshQuotaRequired -ne $true -or $null -eq $policy.fiveHourUsedThreshold -or $null -eq $policy.longWindowUsedThreshold){return @{state='STRICT_POLICY_UNKNOWN';quotaFresh=$false}}
  $tokenFile=Join-Path $binding.registry.opencodexHome 'admin-api-token';$item=Get-Item -LiteralPath $tokenFile -ErrorAction Stop
  if($item.PSIsContainer -or $item.LinkType -or $item.Length -lt 16 -or $item.Length -gt 4096){throw 'strict_token_unsafe'}
  $token=[IO.File]::ReadAllText($tokenFile).Trim()
  if($token.Length -lt 16 -or $token.Length -gt 4096 -or $token -match '[\r\n]'){throw 'strict_token_invalid'}
  $pool=Invoke-RestMethod 'http://127.0.0.1:10100/api/codex-auth/accounts?refresh=1' -Headers @{Authorization='Bearer '+$token} -NoProxy -TimeoutSec 45
  $matches=@($pool.accounts|Where-Object {[string]$_.id -ceq $binding.accountId})
  if($matches.Count -ne 1){return @{state='STRICT_SELECTOR_MISMATCH';reason='LIVE_ACCOUNT_NOT_EXACT';quotaFresh=$false}}
  $a=$matches[0]
  if($a.isMain -eq $true -or $a.paused -eq $true){return @{state='STRICT_ACCOUNT_PAUSED';quotaFresh=$false}}
  if($a.needsReauth -eq $true -or $a.hasCredential -ne $true){return @{state='STRICT_REAUTH_HOLD';quotaFresh=$false}}
  $q=$a.quota;$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if(-not $q -or $q.updatedAt -isnot [ValueType] -or $q.updatedAt -gt $now -or $now-$q.updatedAt -ge 60000){return @{state='STRICT_QUOTA_STALE';quotaFresh=$false}}
  $long=if($null -ne $q.weeklyPercent){$q.weeklyPercent}else{$q.monthlyPercent}
  if($q.shortPercent -isnot [ValueType] -or $long -isnot [ValueType] -or $q.shortPercent -lt 0 -or $long -lt 0){return @{state='STRICT_QUOTA_UNKNOWN';quotaFresh=$false}}
  if($q.shortPercent -ge $policy.fiveHourUsedThreshold -or $long -ge $policy.longWindowUsedThreshold){return @{state='STRICT_QUOTA_WAIT';quotaFresh=$true}}
  @{state='STRICT_ACCOUNT_READY';scope='selected-account-only';selectedAccountNumber=$number;quotaFresh=$true;quotaUpdatedAtMs=[long]$q.updatedAt}
 }catch{return @{state='STRICT_OBSERVATION_UNKNOWN';reason='OWNER_OR_QUOTA_READ_FAILED';quotaFresh=$false}}
}
function Get-StrictRouteLauncher($cfg){
 # An opt-in source path is not a runtime launcher. Owner must pin the
 # installed Node, one-shot bridge, official route module and Codex executable.
 $pin=$cfg.strictRouteLauncher
 if(-not $pin -or $pin.schemaVersion -ne 1 -or $pin.route -cne 'command-route-r2'){throw 'strict_owner_route_pin_required'}
 if(-not $pin.bridgePath -or [IO.Path]::GetFileName([string]$pin.bridgePath) -cne 'codex-strict-continuity-bridge.mjs'){throw 'strict_bridge_entry_required'}
 $routePath=Join-Path (Split-Path -Parent ([string]$pin.bridgePath)) 'codex-cli-routes.mjs'
 if(-not $pin.routeModulePath -or [IO.Path]::GetFullPath([string]$pin.routeModulePath) -ine [IO.Path]::GetFullPath($routePath)){throw 'strict_official_route_module_required'}
 if($pin.codexSha256 -cne $cfg.codexSha256 -or -not $cfg.codexExecutable){throw 'strict_codex_pin_mismatch'}
 $files=@(
  @{path=[string]$pin.nodePath;hash=[string]$pin.nodeSha256},
  @{path=[string]$pin.bridgePath;hash=[string]$pin.bridgeSha256},
  @{path=[string]$pin.routeModulePath;hash=[string]$pin.routeModuleSha256},
  @{path=[string]$cfg.codexExecutable;hash=[string]$cfg.codexSha256}
 )
 foreach($f in $files){
  if(-not [IO.Path]::IsPathFullyQualified($f.path) -or $f.hash -cnotmatch '^[a-f0-9]{64}$'){throw 'strict_route_hash_pin_required'}
  $item=Get-Item -LiteralPath $f.path -ErrorAction Stop
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-FileHash -LiteralPath $f.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.hash){throw 'strict_route_file_identity_changed'}
 }
 if($pin.files){
  if(-not [IO.Path]::IsPathFullyQualified([string]$pin.releaseRoot)){throw 'strict_bundle_root_required'}
  $bundle=[IO.Path]::GetFullPath([string]$pin.releaseRoot)+[IO.Path]::DirectorySeparatorChar
  foreach($relative in $pin.files.Keys){
   $target=[IO.Path]::GetFullPath((Join-Path $pin.releaseRoot $relative))
   if(-not $target.StartsWith($bundle,[StringComparison]::OrdinalIgnoreCase) -or $pin.files[$relative] -cnotmatch '^[a-f0-9]{64}$'){throw 'strict_bundle_path_invalid'}
   for($ancestor=$target;$ancestor.StartsWith($bundle,[StringComparison]::OrdinalIgnoreCase);$ancestor=Split-Path -Parent $ancestor){if((Get-Item -LiteralPath $ancestor -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'strict_bundle_alias_forbidden'}}
   if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.files[$relative]){throw 'strict_bundle_dependency_changed'}
  }
 }
 @{nodePath=[string]$pin.nodePath;bridgePath=[string]$pin.bridgePath;routeModuleSha256=[string]$pin.routeModuleSha256;bridgeSha256=[string]$pin.bridgeSha256}
}
function Get-StrictTerminalSettlement([bool]$threadStarted,[bool]$foreignThread,[string]$event,[string]$failure,[int]$exitCode){
 # Terminal ACK is a settled event from the exact original thread, not queue
 # admission, a process exit by itself, or a neighbouring thread's event.
 $exact=($threadStarted -and -not $foreignThread)
 $completed=($exact -and $event -ceq 'turn.completed' -and $exitCode -eq 0)
 $quota=($exact -and $event -ceq 'turn.failed' -and $failure -ceq 'QUOTA_WAIT')
 @{exactThread=$exact;completed=$completed;quota=$quota;acknowledged=($completed -or $quota);automaticReplay=$false}
}
# Only the installed strict OCX sender may issue this typed terminal receipt.
# A message containing "quota" or a quota reset clock is not a 5h refusal.
function Get-StrictFiveHourQuotaTerminal($Event,[string]$OriginalThread,[string]$StartedTurn,[string]$RawEvent,[DateTimeOffset]$Now=[DateTimeOffset]::UtcNow){
 if(-not $Event -or $Event.type -cne 'turn.failed' -or
    $OriginalThread -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    $StartedTurn -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    $Event.turn_id -cne $StartedTurn -or
    $Event.error.code -cne 'usage_limit_reached' -or
    $Event.error.quota.window -cne 'five_hour' -or
    $Event.error.quota.provider -cne 'ocx' -or
    -not $RawEvent -or $RawEvent.Length -gt 65536){return $null}
 $reset=[DateTimeOffset]::MinValue
 if([string]$Event.error.quota.resetAt -cnotmatch '^\d{4}-\d\d-\d\dT' -or
    -not [DateTimeOffset]::TryParse([string]$Event.error.quota.resetAt,[ref]$reset)){return $null}
 $at=$Now
 if($reset -le $at -or $reset -gt $at.AddHours(6)){return $null}
 @{schemaVersion=1;kind='aicc-original-strict-five-hour-quota-terminal';
   issuer='installed-strict-command-route-r2';route='command-route-r2';provider='ocx';
   threadId=$OriginalThread;previousTurnId=$StartedTurn;
   terminalEvent='turn.failed';errorCode='usage_limit_reached';quotaWindow='five_hour';
   rawEventSha256=(Digest-Text $RawEvent);resetAt=$reset.ToString('o');
   observedAt=$at.ToString('o');modelRequests=0;automaticReplay=$false}
}
function Test-ExactFiveHourQuotaPreflight($cfg,[string]$DeadlineUtc,[DateTimeOffset]$Now=[DateTimeOffset]::UtcNow){
 $out=@{schemaVersion=1;kind='aicc-exact-ocx-fivehour-quota-preflight';
   state='HOLD';threadId=$ThreadId;accountNumber=$StrictAccountNumber;
   route='command-route-r2';provider='ocx';scope='original-registered-thread-only';
   quotaSource='original-strict-worker-terminal-plus-fresh-selected-account';
   queueRegistered=$false;officialSender='installed-strict-continuity-worker-only';
   sourceOnly=$true;dispatchable=$false;claimed=$false;dispatched=$false;
   queueAck=$false;newTurnObserved=$false;goalContinued=$false;
   automaticReplay=$false;modelRequests=0;deadlineUtc=$DeadlineUtc}
 $now=$Now
 $deadline=[DateTimeOffset]::MinValue
 if($ThreadId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    $StrictAccountNumber -ne 2 -or
    [string]$DeadlineUtc -cnotmatch '^\d{4}-\d\d-\d\dT' -or
    -not [DateTimeOffset]::TryParse([string]$DeadlineUtc,[ref]$deadline)){
  $out.state='EXACT_TARGET_ACCOUNT_AND_DEADLINE_REQUIRED';return $out
 }
 if($deadline -gt [DateTimeOffset]::Parse('2026-11-10T06:00:00Z') -or $deadline -le $now){
  $out.state='DEADLINE_EXPIRED_OR_UNAPPROVED';return $out
 }
 $entry=$cfg.threads[$ThreadId]
 if(-not $entry -or $ThreadId -in $cfg.excludedThreadIds){
  $out.state='ORIGINAL_THREAD_NOT_REGISTERED';return $out
 }
 $out.queueRegistered=$true;$out.enabled=($entry.enabled -eq $true)
 $out.ownAttemptPending=($null -ne $entry.attempt -or $null -ne $entry.queueAttempt)
 $out.unrelatedPendingCount=@($cfg.threads.Values|Where-Object {
    $_.threadId -cne $ThreadId -and ($_.attempt -or $_.queueAttempt)}).Count
 $out.workerStop=([bool]$cfg.workerStopRequestedAt)
 if($entry.threadId -cne $ThreadId -or $entry.groupOwnerOnly -eq $true -or
    $entry.strictAccount -ne 2 -or $entry.enabled -ne $true -or
    -not [IO.Path]::IsPathFullyQualified([string]$entry.projectRoot)){
  $out.state='ORIGINAL_REGISTERED_STRICT_ACCOUNT_BINDING_HOLD';return $out
 }
 if($out.ownAttemptPending){$out.state='ORIGINAL_TARGET_PENDING_HOLD';return $out}
 $receipt=$entry.lastStrictRouteReceipt
 $q=$receipt.quotaTerminal
 if(-not $receipt -or $receipt.route -cne 'command-route-r2' -or $receipt.threadId -cne $ThreadId -or
    $receipt.threadStartedObserved -cne $true -or $receipt.foreignThreadObserved -ne $false -or
    $receipt.terminalEvent -cne 'turn.failed' -or $receipt.acknowledged -ne $true -or
    $receipt.attemptId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    -not $q -or $q.schemaVersion -ne 1 -or $q.kind -cne 'aicc-original-strict-five-hour-quota-terminal' -or
    $q.issuer -cne 'installed-strict-command-route-r2' -or
    $q.terminalEvent -cne 'turn.failed' -or
    $q.threadId -cne $ThreadId -or $q.provider -cne 'ocx' -or $q.route -cne 'command-route-r2' -or
    $q.previousTurnId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    $q.rawEventSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $q.errorCode -cne 'usage_limit_reached' -or $q.quotaWindow -cne 'five_hour' -or
    $entry.lastTerminal -cne 'turn.failed' -or $entry.failureKind -cne 'QUOTA_WAIT'){
  $out.state='ORIGINAL_ISSUER_FIVE_HOUR_TERMINAL_NOT_PROVEN';return $out
 }
 $prior=$entry.lastContinuityAttempt
 if(-not $prior -or $prior.id -cne $receipt.attemptId -or
    $prior.routeMode -cne 'strict' -or $prior.accountNumber -ne 2 -or
    $prior.executionRoute -cne 'command-route-r2' -or
    $prior.selectorSha256 -cnotmatch '^[a-f0-9]{64}$'){
  $out.state='ORIGINAL_ATTEMPT_ACCOUNT_AND_ROUTE_UNPROVEN';return $out
 }
 $reset=[DateTimeOffset]::MinValue
 if(-not [DateTimeOffset]::TryParse([string]$q.resetAt,[ref]$reset) -or
    $reset -gt $deadline -or $reset -le [DateTimeOffset]::Parse([string]$q.observedAt)){
  $out.state='QUOTA_RESET_EVIDENCE_INVALID';return $out
 }
 $out.previousTurnSha256=Digest-Text ([string]$q.previousTurnId)
 $out.quotaTerminalSha256=[string]$q.rawEventSha256
 $out.resetAtUtc=$reset.ToUniversalTime().ToString('o')
 if($now -lt $reset){$out.state='FIVE_HOUR_QUOTA_WAIT';return $out}
 if($out.workerStop){$out.state='WORKER_STOP_HOLD';return $out}
 if($out.unrelatedPendingCount -gt 0){
  # Historical ce9a is not the target's quota terminal or a transferable
  # sender claim. Existing global worker fence is still authoritative.
  $out.state='UNRELATED_PENDING_WORKER_GATE_HOLD';return $out
 }
 try {
  $availability=Thread-Availability $entry
  if($availability.state -cne 'ACTIVE'){$out.state=$availability.state;return $out}
  if((Thread-Owner $entry) -cne 'RELEASED'){$out.state='ORIGINAL_WRITER_NOT_RELEASED';return $out}
  $null=Get-StrictRouteLauncher $cfg
  $admission=Get-StrictAccountReadiness 2
  $out.quotaAdmission=$admission.state
  if($admission.state -cne 'STRICT_ACCOUNT_READY' -or $admission.quotaFresh -ne $true){
   $out.state='FRESH_SAME_ACCOUNT_QUOTA_ADMISSION_HOLD';return $out
  }
  $out.state='EXACT_ADMISSION_PROVEN_SENDER_CLAIM_STILL_REQUIRED'
 } catch { $out.state='OFFICIAL_SENDER_OR_OWNER_EVIDENCE_UNAVAILABLE' }
 $out
}
function Test-StrictPreflight($cfg){
 Assert-HelperIdentity $cfg
 if($StrictAccountNumber -lt 1 -or $ThreadId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\z'){throw 'exact_thread_and_strict_account_required'}
 $out=@{schemaVersion=1;kind='aicc-strict-continuity-preflight';threadId=$ThreadId;selectedAccountNumber=$StrictAccountNumber;claimed=$false;dispatched=$false;dispatchable=$false;automaticReplay=$false;selectorSource='owner-local-current-registration';quotaScope='selected-account-only';executionRoute='UNBOUND';reason='STRICT_CONTINUITY_LAUNCHER_AND_THREAD_CLAIM_NOT_PINNED'}
 $entry=$cfg.threads[$ThreadId]
 if(-not $entry -or $ThreadId -in $cfg.excludedThreadIds){$out.state='REGISTERED_THREAD_REQUIRED';return $out}
 if($cfg.workerStopRequestedAt){$out.state='WORKER_STOP_HOLD';return $out}
 if($entry.attempt -or $entry.queueAttempt){$out.state='PENDING_DELIVERY_HOLD';return $out}
 if(@($cfg.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt}).Count){$out.state='ANOTHER_DISPATCH_PENDING';return $out}
 if($entry.holdReason -or $entry.state -match 'UNKNOWN|UNCERTAIN|HOLD|COMPLETE|RESUMING_OCX'){$out.state='ORIGINAL_PENDING_OR_HOLD';return $out}
 if($entry.enabled -ne $true){$out.state='SELECTION_DISABLED';return $out}
 $availability=Thread-Availability $entry
 if($availability.state -cne 'ACTIVE'){$out.state=$availability.state;return $out}
 $surface=Thread-Surface $availability.meta
 if($surface -cne 'cli'){
  if($surface -cne 'desktop' -or -not $entry.recoveredCliTransport){$out.state='STRICT_CLI_THREAD_REQUIRED';return $out}
  try{$null=Get-GroupRecoveredCliOwnerActivity $entry $cfg}
  catch{$out.state='RECOVERED_CLI_TRANSPORT_HOLD';return $out}
 }
 if((Thread-Owner $entry) -cne 'RELEASED'){$out.state='ORIGINAL_WRITER_NOT_RELEASED';return $out}
 if((Terminal-Evidence $entry).state -cne 'TERMINAL'){$out.state='ORIGINAL_TERMINAL_UNPROVEN';return $out}
 $selected=Get-StrictAccountReadiness $StrictAccountNumber
 $out.selectedQuotaState=$selected.state;$out.quotaFresh=($selected.quotaFresh -eq $true)
 $out.state=if($selected.state -ceq 'STRICT_ACCOUNT_READY'){'STRICT_EXECUTION_UNBOUND'}else{$selected.state}
 if($selected.state -ceq 'STRICT_ACCOUNT_READY'){
  try{
   $null=Get-StrictRouteLauncher $cfg
   $out.executionRoute='command-route-r2'
   $out.state=if($entry.strictAccount -is [int] -or $entry.strictAccount -is [long]){if([int]$entry.strictAccount -eq $StrictAccountNumber){'STRICT_ROUTE_READY_NOT_DISPATCHED'}else{'STRICT_OPT_IN_REQUIRED'}}else{'STRICT_OPT_IN_REQUIRED'}
   $out.reason='READ_ONLY_PREVIEW_NO_CLAIM'
  }catch{$out.reason='STRICT_OWNER_ROUTE_PIN_NOT_VERIFIED'}
 }
 $out
}
. (Join-Path $PSScriptRoot 'CodexContinuityGroupOwner.ps1')
function Get-PoolReadiness($cfg){
 $route=Read-Json (Join-Path $ownerHome '.codex-chatgpt-web\config.json')
 if(-not $route -or $route.port -ne 17841 -or $route.nativeUpstreamBaseUrl -notin @('http://127.0.0.1:10100/v1','http://127.0.0.1:10101/v1','http://localhost:10100/v1','http://localhost:10101/v1')){return @{state='ROUTE_HOLD';delay=120}}
 try{
  $bridge=Invoke-RestMethod 'http://127.0.0.1:17841/readyz' -NoProxy -TimeoutSec 8
  $ocx=Invoke-RestMethod 'http://127.0.0.1:10100/readyz' -NoProxy -TimeoutSec 8
  if($bridge.service -ne 'codex-chatgpt-web' -or $bridge.ready -ne $true -or $ocx.ready -ne $true){return @{state='OCX_WAIT';delay=120}}
  if($bridge.active_http_turns -isnot [long] -and $bridge.active_http_turns -isnot [int]){return @{state='ACTIVITY_UNKNOWN';delay=120}}
  foreach($field in @('active_http_turns','active_browser_http_turns','active_browser_turns')){if($null -eq $bridge.$field -or $bridge.$field -lt 0){return @{state='ACTIVITY_UNKNOWN';delay=120}}}
  # Starting an ordinary inference request does not replace a shared service.
  # The exact-thread owner/dispatch guards above prevent competing writers.
  # Service maintenance still requires its separate fresh exact-zero gate.
  if($null -eq $ocx.activeTurns -or $ocx.activeTurns -lt 0){return @{state='OCX_ACTIVITY_UNKNOWN';delay=60}}
  $reg=Read-Json (Join-Path $ownerHome '.ai-control-center\runtime\ocx-local\current.json')
  $tokenFile=Join-Path $reg.opencodexHome 'admin-api-token';$token=[IO.File]::ReadAllText($tokenFile).Trim()
  $headers=@{Authorization='Bearer '+$token}
  $policy=$null;$serverAdmission=$false
  try{$policy=Invoke-RestMethod 'http://127.0.0.1:10100/api/aicc-local/policy' -Headers $headers -NoProxy -TimeoutSec 12}
  catch{
   # This installed external adapter has no public policy endpoint. Its pinned
   # HTTP boundary already enforces A1-owned settings and fresh quota per request.
   # Do not treat the unrelated legacy local policy file as the external policy.
   if([int]$_.Exception.Response.StatusCode -ne 404){return @{state='POLICY_UNKNOWN';delay=120}}
   if(-not $reg.adapterManifest -or $reg.requestExecution -ne 'windows-local' -or $reg.credentialWriter -ne 'a1' -or $ocx.requestExecution -ne 'windows-local' -or $ocx.credentialWriter -ne 'a1' -or $ocx.nativeExcluded -ne $true){return @{state='POLICY_UNKNOWN';delay=120}}
   if((Get-FileHash -LiteralPath $reg.adapterManifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $reg.manifestSha256){return @{state='ADMISSION_IDENTITY_HOLD';delay=120}}
   $manifest=Read-Json $reg.adapterManifest
   if($manifest.supplierVersion -ne $reg.version -or $ocx.version -ne $reg.version -or $manifest.adapterVersion -ne $ocx.adapterVersion -or $manifest.nativeExcluded -ne $true){return @{state='ADMISSION_IDENTITY_HOLD';delay=120}}
   foreach($name in @('external-http-boundary.ts','external-pool-state.ts','external-broker-transport.ts','window-inflight-monitor.ts')){
    $file=Join-Path (Split-Path -Parent $reg.adapterManifest) $name
    if(-not $manifest.adapterFiles[$name] -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.adapterFiles[$name]){return @{state='ADMISSION_IDENTITY_HOLD';delay=120}}
   }
   $serverAdmission=$true
   $policy=Get-RegisteredOwnerPolicy
  }
  $pool=Invoke-RestMethod 'http://127.0.0.1:10100/api/codex-auth/accounts?refresh=1' -Headers $headers -NoProxy -TimeoutSec 45
  if($policy.strictAdmission -ne $true -or $policy.freshQuotaRequired -ne $true -or $null -eq $policy.fiveHourUsedThreshold -or $null -eq $policy.longWindowUsedThreshold){return @{state='POLICY_UNKNOWN';delay=30}}
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$eligible=0;$resetTimes=@()
  foreach($a in $pool.accounts){
   if($a.isMain -eq $true -or $a.paused -eq $true -or $a.needsReauth -eq $true -or $a.hasCredential -ne $true){continue}
   $q=$a.quota;if(-not $q -or $null -eq $q.updatedAt -or $now-$q.updatedAt -ge 60000 -or $q.updatedAt -gt $now){continue}
   $long=if($null -ne $q.weeklyPercent){$q.weeklyPercent}else{$q.monthlyPercent}
   if($null -ne $q.shortPercent -and $null -ne $long -and $q.shortPercent -ge 0 -and $long -ge 0 -and $q.shortPercent -lt $policy.fiveHourUsedThreshold -and $long -lt $policy.longWindowUsedThreshold){$eligible++}
   foreach($v in @($q.shortResetAt,$q.weeklyResetAt,$q.monthlyResetAt)){if($v -is [ValueType] -and $v*1000 -gt $now){$resetTimes+=,[double]$v}}
  }
  if($eligible -gt 0){return @{state='READY';delay=15;eligible=$eligible;policy=$policy;quotaFresh=$true;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}}
  $delay=30;if($resetTimes.Count){$seconds=([double]($resetTimes|Measure-Object -Minimum).Minimum)-$now/1000;$delay=[Math]::Clamp([int][Math]::Ceiling($seconds),5,30)}
  return @{state='QUOTA_WAIT';delay=$delay;eligible=0;nextResetAt=if($resetTimes.Count){[DateTimeOffset]::FromUnixTimeSeconds([long]($resetTimes|Measure-Object -Minimum).Minimum).ToString('o')}else{$null}}
 }catch{return @{state='OCX_WAIT';delay=120}}
}
function Set-Observation($id,$changes){With-Registry {param($cfg)if(-not $cfg.threads.ContainsKey($id)){return};$e=$cfg.threads[$id];foreach($key in $changes.Keys){$e[$key]=$changes[$key]};$e.observedAt=[DateTimeOffset]::UtcNow.ToString('o')}}
function Queue-Progress($entry){
 $attempt=if($entry.queueAttempt){$entry.queueAttempt}else{$entry.lastQueueAttempt}
 if(-not $attempt){return @{state='QUEUE_NONE';pending=$false}}
 $result=@{};foreach($key in $attempt.Keys){$result[$key]=$attempt[$key]};$result.pending=($null -ne $entry.queueAttempt)
 if(-not $result.pending){return $result}
 # Completion can be outside the UI's bounded tail after a long tool result or
 # an interrupted controller. Stream the exact original rollout, never infer
 # delivery from a neighbouring user turn or a diagnostic mention of its ID.
 if($attempt.threadId -cne $entry.threadId -or
    $attempt.id -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    $attempt.messageSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $attempt.marker -cne ('AICC_QUEUE_ATTEMPT:'+$attempt.id)){
  $result.observationReason='QUEUE_BINDING_INVALID';return $result
 }
 $savedTurn=[string]$attempt.turnId;$turns=@{};$terminal=@{};$invalid=$false;$conflict=$false
 # A persisted turn is a hint, not a substitute for the original message.
 # Bind the file itself before accepting any of its events.
 try{
  $meta=Metadata $entry.rollout
  if($meta.id -cne $entry.threadId -or
     [IO.Path]::GetFullPath([string]$meta.cwd) -ine [IO.Path]::GetFullPath([string]$entry.projectRoot)){
   $result.observationReason='QUEUE_ORIGINAL_SCOPE_CHANGED';return $result
  }
 }catch{$result.observationReason='QUEUE_ORIGINAL_READ_UNAVAILABLE';return $result}
 try{
 $since=[DateTimeOffset]::Parse([string]$attempt.at).AddSeconds(-2)
 $stream=[IO.File]::Open($entry.rollout,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
 try{
 $reader=[IO.StreamReader]::new($stream)
 while($null -ne ($line=$reader.ReadLine())){
  if([string]::IsNullOrWhiteSpace($line)){continue}
  try{$row=$line|ConvertFrom-Json -AsHashtable -DateKind String}catch{$invalid=$true;continue}
  if($row.type -cne 'event_msg'){continue}
  $event=$row.payload
  try{if(-not $row.timestamp -or [DateTimeOffset]::Parse([string]$row.timestamp) -lt $since){continue}}catch{$invalid=$true;continue}
  # Desktop emits a typed UserMessage item with the exact turn ID, while CLI
  # user_message events may have no turn ID. Never bind a neighbouring turn.
  if($event.type -eq 'item_completed' -and $event.item.type -eq 'UserMessage' -and $event.turn_id){
   $text=(@($event.item.content|Where-Object type -eq 'text'|ForEach-Object text) -join "`n")
   $suffix=[regex]::Match($text,'\r?\n\r?\n'+[regex]::Escape([string]$attempt.marker)+'$')
   if($suffix.Success -and (Digest-Text $text.Substring(0,$suffix.Index)) -ceq $attempt.messageSha256){$turns[[string]$event.turn_id]=$true}
  }
  if($event.turn_id -and $turns.ContainsKey([string]$event.turn_id) -and $event.type -in @('task_complete','turn_aborted')){
   if($terminal.ContainsKey([string]$event.turn_id) -and $terminal[[string]$event.turn_id].type -cne $event.type){$conflict=$true}
   $terminal[[string]$event.turn_id]=@{type=$event.type;at=$row.timestamp}
  }
 }
 }finally{$stream.Dispose()}
 }catch{$result.observationReason='QUEUE_ORIGINAL_READ_UNAVAILABLE';return $result}
 if($invalid){$result.observationReason='QUEUE_ORIGINAL_RECORD_INVALID';return $result}
 if($turns.Count -gt 1){$result.observationReason='QUEUE_MULTIPLE_TURNS_NO_REPLAY';return $result}
 if($savedTurn -and $turns.Count -eq 1 -and -not $turns.ContainsKey($savedTurn)){$result.observationReason='QUEUE_SAVED_TURN_CONFLICT';return $result}
 if($conflict){$result.observationReason='QUEUE_TERMINAL_CONFLICT';return $result}
 if($turns.Count -eq 1){
  $turn=[string]@($turns.Keys)[0];$result.turnId=$turn;$result.state='QUEUE_TURN_ACTIVE'
  if($terminal.ContainsKey($turn)){
   $result.state=if($terminal[$turn].type -ceq 'task_complete'){'QUEUE_TURN_COMPLETED'}else{'QUEUE_TURN_INTERRUPTED'}
   $result.pending=$false;$result.terminalAt=$terminal[$turn].at;$result.goalComplete=$false
  }
 }else{$result.observationReason='QUEUE_EXACT_TURN_NOT_OBSERVED'}
 $result
}
function Save-QueueProgress($id){
 With-Registry {param($cfg)$entry=$cfg.threads[$id];if(-not $entry.queueAttempt){return};if((Thread-Availability $entry).state -ne 'ACTIVE'){return}
  $progress=Queue-Progress $entry;$pending=$progress.pending;$null=$progress.Remove('pending')
  if($pending -and $progress.state -ceq $entry.queueAttempt.state -and $progress.turnId -ceq $entry.queueAttempt.turnId -and
     $progress.observationReason -ceq $entry.queueAttempt.observationReason){return}
  Write-Json (Join-Path $StateRoot ('requests/'+$progress.id+'.json')) $progress
  if($pending){$entry.queueAttempt=$progress}else{
   $entry.lastQueueAttempt=$progress;$entry.queueAttempt=$null
   if($progress.state -ceq 'QUEUE_TURN_INTERRUPTED'){$entry.state='INTERRUPTED_TURN_HOLD';$entry.holdReason='QUEUE_TURN_INTERRUPTED'}
  }
 }
}
function Queue-Binary($cfg){
 foreach($process in @(Get-CimInstance Win32_Process -Filter "Name='codex.exe'")){
  if(Test-DesktopTransport $process){return @{path=$process.ExecutablePath;sha256=(Get-FileHash -LiteralPath $process.ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant();source='signed-desktop-transport'}}
 }
 $binary=[string]$cfg.codexExecutable
 if(-not $binary -or (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $cfg.codexSha256){throw 'registered_codex_identity_required'}
 @{path=$binary;sha256=$cfg.codexSha256;source='registered-codex'}
}
function Test-QueuePreflight($cfg){
 Assert-HelperIdentity $cfg
 if($ThreadId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $OperationId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw 'exact_thread_and_operation_required'}
 $e=$cfg.threads[$ThreadId]
 if(-not $e -or $ThreadId -in $cfg.excludedThreadIds -or $cfg.workerStopRequestedAt){throw 'registered_unprotected_thread_required'}
 if($e.strictAccount){throw 'strict_continuity_dispatch_route_unbound'}
 if($e.attempt -or $e.queueAttempt){throw 'pending_delivery_reconcile_first'}
 if($e.holdReason -or $e.state -match 'HOLD|COMPLETE|ARCHIVED|MISSING'){throw 'exact_hold_or_completion_preserved'}
 $requestRoot=Join-Path $StateRoot 'requests'
 $expectedMessage=Join-Path $requestRoot ($OperationId+'.txt')
 $expectedEvidence=Join-Path $requestRoot ($OperationId+'.preflight-evidence.json')
 if(-not $MessageFile -or -not $EvidenceFile -or [IO.Path]::GetFullPath($MessageFile) -ine $expectedMessage -or [IO.Path]::GetFullPath($EvidenceFile) -ine $expectedEvidence){throw 'owned_preflight_input_required'}
 foreach($file in @($StateRoot,$requestRoot,$expectedMessage,$expectedEvidence)){if((Get-Item -LiteralPath $file -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_message_path_refused'}}
 if(Test-Path -LiteralPath (Join-Path $requestRoot ($OperationId+'.json'))){throw 'existing_operation_reconcile_first'}
 $message=[IO.File]::ReadAllText($expectedMessage,[Text.UTF8Encoding]::new($false,$true)).Trim()
 if(-not $message -or $message.Length -gt 4000 -or (Get-Item -LiteralPath $expectedMessage).Length -gt 32768){throw 'message_length_invalid'}
 $proof=Read-Json $expectedEvidence
 Assert-DesktopEvidence $e $proof
 if($proof.operationId -cne $OperationId -or $proof.messageSha256 -cne (Digest-Text $message) -or $proof.senderThreadId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $proof.senderThreadId -ceq $ThreadId){throw 'exact_preflight_intent_required'}
 if($proof.status -notin @('idle','notLoaded') -or $proof.turnStatus -ne 'completed'){throw 'exact_completed_idle_required'}
 $route=Assert-DesktopTargetRoute $e $proof
 if(Process-Alive $e.ownerPid $e.ownerCreatedAt){throw 'registered_writer_active'}
 foreach($process in @(Get-CimInstance Win32_Process -Filter "Name='codex.exe'")){
  if(Test-DesktopTransport $process){continue}
  if(-not $process.CommandLine){throw 'writer_observation_unknown'}
  if($process.CommandLine.Contains($ThreadId)){throw 'exact_thread_writer_active'}
 }
 $terminal=Terminal-Evidence $e
 if($terminal.state -eq 'REQUIRED_ACTION_HOLD' -or $terminal.event.type -eq 'turn_aborted'){throw 'exact_hold_or_completion_preserved'}
 if($terminal.event.type -eq 'task_complete' -and $terminal.event.last_agent_message -match ('(?m)^AICC_CONTINUITY_COMPLETE:'+ [regex]::Escape($ThreadId)+'\s*$')){throw 'completed_goal_preserved'}
 $binary=Queue-Binary $cfg
 $pool=Get-PoolReadiness $cfg
 if($pool.state -ne 'READY'){return @{schemaVersion=1;kind='aicc-queue-preflight';state=$pool.state;threadId=$ThreadId;operationId=$OperationId;dispatched=$false;claimed=$false;automaticDelivery=$false}}
 @{schemaVersion=1;kind='aicc-queue-preflight';state='READY_NOT_AUTHORIZED';threadId=$ThreadId;operationId=$OperationId;messageSha256=(Digest-Text $message);targetRoute='EXACT_OCX';idleVerified=$true;binarySha256=$binary.sha256;quotaFresh=($pool.quotaFresh -eq $true);observedAt=[DateTimeOffset]::UtcNow.ToString('o');evidenceSha256=(Get-FileHash -LiteralPath $expectedEvidence).Hash.ToLowerInvariant();dispatched=$false;claimed=$false;automaticDelivery=$false}
}
function Send-QueueMessage($cfg){
 if($ThreadId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $OperationId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'exact_thread_and_operation_required'}
 $requestRoot=Join-Path $StateRoot 'requests';$expectedFile=Join-Path $requestRoot ($OperationId+'.txt')
 if(-not $MessageFile -or [IO.Path]::GetFullPath($MessageFile) -ine $expectedFile){throw 'owned_utf8_message_file_required'}
 foreach($path in @($StateRoot,$requestRoot,$expectedFile)){if((Get-Item -LiteralPath $path -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_message_path_refused'}}
 $item=Get-Item -LiteralPath $expectedFile;if($item.Length -gt 32768){throw 'message_too_large'}
 $message=[IO.File]::ReadAllText($expectedFile,[Text.UTF8Encoding]::new($false,$true)).Trim()
 if(-not $message -or $message.Length -gt 8192 -or $message.Contains([char]0)){throw 'message_length_invalid'}
 $hash=Digest-Text $message;$receiptFile=Join-Path $requestRoot ($OperationId+'.json')
 $previous=Read-Json $receiptFile
 if($previous){if($previous.threadId -cne $ThreadId -or $previous.messageSha256 -cne $hash){throw 'operation_scope_changed'};return $previous}
 # Reconcile a saved exact marker before admitting a NEW human request; an
 # existing operation ID always returns its receipt and never invokes CLI again.
 if($cfg.threads.ContainsKey($ThreadId) -and $cfg.threads[$ThreadId].strictAccount){throw 'strict_continuity_dispatch_route_unbound'}
 if($cfg.threads.ContainsKey($ThreadId) -and $cfg.threads[$ThreadId].queueAttempt){Save-QueueProgress $ThreadId}
 $binary=Queue-Binary $cfg
 $claim=With-Registry {param($c)Assert-HelperIdentity $c
  $e=$c.threads[$ThreadId];if(-not $e -or $ThreadId -in $c.excludedThreadIds){throw 'registered_unprotected_thread_required'}
  Assert-ThreadAvailable $e;if((Thread-Surface (Metadata $e.rollout)) -ne 'desktop'){throw 'desktop_thread_required'}
  if($c.workerStopRequestedAt -or $e.attempt -or $e.queueAttempt){throw 'pending_delivery_reconcile_first'}
  # Dashboard checked send reuses this exact sender, under its registry lock.
  # Fresh route/writer/quota evidence is rechecked immediately before claim.
  if($EvidenceFile){
   $checked=Test-QueuePreflight $c
   if($checked.state -cne 'READY_NOT_AUTHORIZED' -or $checked.messageSha256 -cne $hash -or $checked.binarySha256 -cne $binary.sha256){throw 'checked_queue_admission_required'}
  }
  if(Test-Path -LiteralPath $receiptFile){return @{existing=$true}}
  $record=@{id=$OperationId;threadId=$ThreadId;at=[DateTimeOffset]::UtcNow.ToString('o');transport='codex-queue';state='QUEUE_DELIVERY_UNCERTAIN';marker=('AICC_QUEUE_ATTEMPT:'+$OperationId);messageSha256=$hash;binarySource=$binary.source;binarySha256=$binary.sha256;automaticReplay=$false}
  Write-Json $receiptFile $record;$e.queueAttempt=$record;return $record
 }
 if($claim.existing){return (Read-Json $receiptFile)}
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$binary.path;$info.WorkingDirectory=$cfg.threads[$ThreadId].projectRoot;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
 $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.StandardOutputEncoding=$utf8;$info.StandardErrorEncoding=$utf8
 foreach($arg in @('queue','--thread',$ThreadId,'--message',($message+"`n`n"+$claim.marker))){$info.ArgumentList.Add($arg)}
 foreach($name in @('CODEX_THREAD_ID','CODEX_SESSION_ID')){$null=$info.Environment.Remove($name)}
 $result=@{};foreach($key in $claim.Keys){$result[$key]=$claim[$key]};$process=$null
 try{
  $process=[Diagnostics.Process]::Start($info);$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  if(-not $process.WaitForExit(25000)){try{$process.Kill()}catch{};$result.errorCode='QUEUE_TIMEOUT_NO_REPLAY'}
  else{
   $result.exitCode=$process.ExitCode;$result.outputSha256=Digest-Text ($stdout.Result+"`n"+$stderr.Result)
   $pattern='(?m)^Queued message ([a-f0-9-]{36}) for thread '+[regex]::Escape($ThreadId)+'\.\r?$'
   if($process.ExitCode -eq 0 -and $stdout.Result -cmatch $pattern){$result.state='QUEUE_ACCEPTED';$result.queuedMessageId=$Matches[1];$result.acceptedAt=[DateTimeOffset]::UtcNow.ToString('o')}
   else{$result.errorCode='QUEUE_ACK_UNCONFIRMED_NO_REPLAY'}
  }
 }catch{$result.errorCode='QUEUE_PROCESS_UNCONFIRMED_NO_REPLAY';$result.errorType=$_.Exception.GetType().FullName}finally{if($process){$process.Dispose()}}
 With-Registry {param($c)$e=$c.threads[$ThreadId];if($e.queueAttempt.id -ceq $OperationId){if($e.queueAttempt.turnId){$result.turnId=$e.queueAttempt.turnId;$result.state=$e.queueAttempt.state};Write-Json $receiptFile $result;$e.queueAttempt=$result}elseif($e.lastQueueAttempt.id -ceq $OperationId){$last=$e.lastQueueAttempt;foreach($key in @('queuedMessageId','acceptedAt','exitCode','outputSha256','errorCode')){if($result.ContainsKey($key)){$last[$key]=$result[$key]}};Write-Json $receiptFile $last}}
 return $result
}
if($MyInvocation.InvocationName -eq '.'){return}
function Continuity-Status($cfg){$rows=@(foreach($e in $cfg.threads.Values){$row=@{};foreach($key in $e.Keys){$row[$key]=$e[$key]};$availability=Thread-Availability $e;$row.availabilityState=$availability.state;$row.observationError=$availability.reason;if($availability.state -eq 'ACTIVE'){try{$row.executionSurface=Thread-Surface $availability.meta;$terminal=Terminal-Evidence $e;$row.terminalSha256=$terminal.sha256;if($row.executionSurface -eq 'desktop'){$row.progress=Continuity-Progress $e;$row.queueProgress=Queue-Progress $e}}catch{$row.availabilityState='THREAD_OBSERVATION_HOLD';$row.observationError='SESSION_READ_FAILED'}}else{$row.executionSurface='unknown';if($row.enabled -eq $true -and -not $row.attempt){$row.state=$availability.state}};$row});$identity=Helper-Identity;@{threads=$rows;worker=$cfg.worker;protocolVersion=$protocolVersion;helperSha256=$identity.helperSha256;installedHelperSha256=$cfg.helperSha256;protocolMatch=($cfg.protocolVersion -eq $protocolVersion -and $cfg.helperSha256 -ceq $identity.helperSha256);desktopTransport='codex-app-tools';desktopDispatchByCli=$false;queueMessageSupported=$true;manualDesktopTransport='codex-queue';queueDispatchPending=(@($cfg.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt}).Count -gt 0);cycleInitialization='existing-A1-watcher';nativeFallback=$false}}
if($StrictAccountNumber -gt 0 -and $Action -notin @('StrictPreflight','QuotaPreflight','GroupInspect','GroupEnqueue','GroupAuthorise')){throw 'strict_selection_is_read_only_preflight_only'}
if($Action -ne 'Worker'){
 $cfg=Read-Json $configFile;if(-not $cfg -or $cfg.schemaVersion -ne 1){throw 'registered_configuration_required'}
 if($Action -notin @('Candidates','FindThread','Overview','Status','StopWorker','Disable')){Assert-HelperIdentity $cfg}
 switch($Action){
  'Candidates' {@{candidates=@(Recent-Candidates $cfg)}|ConvertTo-Json -Depth 5}
  'FindThread' {$candidate=Find-ExactCandidate $cfg $ThreadId;@{found=($null -ne $candidate);candidate=$candidate}|ConvertTo-Json -Depth 8}
  'Status' {Continuity-Status $cfg|ConvertTo-Json -Depth 8}
  'Overview' {@{candidates=@(Recent-Candidates $cfg);status=(Continuity-Status $cfg)}|ConvertTo-Json -Depth 10}
  'StrictPreflight' {Test-StrictPreflight $cfg|ConvertTo-Json -Depth 6}
  'QuotaPreflight' {Test-ExactFiveHourQuotaPreflight $cfg $QuotaDeadlineUtc|ConvertTo-Json -Depth 8}
  'GroupInspect' {Get-GroupOwnerProof $cfg $false $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot|ConvertTo-Json -Depth 8}
  'GroupEnqueue' {With-Registry {param($c)Assert-HelperIdentity $c;Add-GroupOwnerEvent $c $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $ExpectedResultSha256 $StateRoot}|ConvertTo-Json -Depth 8}
  'GroupAuthorise' {With-Registry {param($c)Assert-HelperIdentity $c;Register-GroupOwnerEvidence $c $ThreadId $StrictAccountNumber $EventId $ExpectedEventSha256 $StateRoot $Confirm}|ConvertTo-Json -Depth 8}
  'QueuePreflight' {Test-QueuePreflight $cfg|ConvertTo-Json -Depth 6}
  'QueueMessage' {Send-QueueMessage $cfg|ConvertTo-Json -Depth 6}
  'Register' {if($ThreadId -in $cfg.excludedThreadIds){throw 'protected_thread'};$row=Recent-Candidates $cfg|Where-Object threadId -eq $ThreadId|Select-Object -First 1;if(-not $row){$row=Find-ExactCandidate $cfg $ThreadId};if(-not $row -or $row.availabilityState -and $row.availabilityState -ne 'ACTIVE'){throw 'active_exact_thread_required'};$root=(Resolve-Path -LiteralPath $row.projectRoot).Path;With-Registry {param($c)if($c.threads.ContainsKey($ThreadId)){return};$c.threads[$ThreadId]=@{threadId=$ThreadId;title=$row.title;projectRoot=$root;rollout=$row.rollout;enabled=$false;state='DISABLED';ownerPid=$null;ownerCreatedAt=$null;nextCheckAt=[DateTimeOffset]::UtcNow.ToString('o');attempt=$null}};@{registered=$true;threadId=$ThreadId;enabled=$false}|ConvertTo-Json}
  'StopWorker' {With-Registry {
    param($c)
    $at=[DateTimeOffset]::UtcNow.ToString('o');$c.workerStopRequestedAt=$at
    foreach($entry in $c.threads.Values){
     if($entry.groupOwnerOnly -eq $true){
      # A stop permanently revokes the old generation, even if a fence is
      # later cleared. No stale queued event may be revived by Enable/Resume.
      $entry.groupStopEpoch=[long]$entry.groupStopEpoch+1
      $entry.groupStopRevokedAt=$at
      $entry.enabled=$false
     }
    }
   };@{stopRequested=$true;runningTurnPreserved=$true;groupGenerationRevoked=$true}|ConvertTo-Json}
  {$_ -in @('Enable','Resume')} {With-Registry {param($c)Assert-HelperIdentity $c;if($ThreadId -in $c.excludedThreadIds -or -not $c.threads.ContainsKey($ThreadId)){throw 'registered_unprotected_thread_required'};$e=$c.threads[$ThreadId];if($e.groupOwnerOnly -eq $true){throw 'owner_group_event_action_required'};Assert-ThreadAvailable $e;$terminal=Terminal-Evidence $e;if($Action -eq 'Resume' -and ($ExpectedTerminalSha256 -notmatch '^[a-f0-9]{64}$' -or $terminal.sha256 -cne $ExpectedTerminalSha256 -or -not $terminal.holdReason)){throw 'displayed_terminal_changed_refresh_required'};if($e.attempt -or $e.queueAttempt){throw 'uncertain_or_active_delivery_preserved'};if($Action -eq 'Resume'){$e.resumeAuthorization=@{terminalSha256=$terminal.sha256;authorizedAt=[DateTimeOffset]::UtcNow.ToString('o');action=$Action};$e.holdReason=$null};$e.enabled=$true;$e.enabledAt=[DateTimeOffset]::UtcNow.ToString('o');$e.nextCheckAt=[DateTimeOffset]::UtcNow.ToString('o');$e.state=if($Action -eq 'Enable' -and ($e.holdReason -or $terminal.state -eq 'REQUIRED_ACTION_HOLD')){'REQUIRED_ACTION_HOLD'}else{'QUEUED'};$e.executionSurface=Thread-Surface (Metadata $e.rollout)};@{enabled=$true;threadId=$ThreadId;noRequestDispatched=$true;holdPreserved=($Action -eq 'Enable')}|ConvertTo-Json}
  'Disable' {With-Registry {param($c)if(-not $c.threads.ContainsKey($ThreadId)){throw 'registered_thread_required'};$c.threads[$ThreadId].enabled=$false;$c.threads[$ThreadId].state='DISABLED'};@{enabled=$false;runningTurnPreserved=$true}|ConvertTo-Json}
  'Complete' {With-Registry {param($c)if(-not $c.threads.ContainsKey($ThreadId)){throw 'registered_thread_required'};if($c.threads[$ThreadId].attempt -or $c.threads[$ThreadId].queueAttempt){throw 'uncertain_or_active_delivery_preserved'};$c.threads[$ThreadId].enabled=$false;$c.threads[$ThreadId].state='COMPLETE'};@{complete=$true;completionScope='queue-tracking-only';codexGoalChanged=$false;runningTurnPreserved=$true}|ConvertTo-Json}
  'DesktopQueue' {$rows=@(foreach($e in (Queue-Order $cfg.threads.Values)){if($e.enabled -ne $true -or $e.threadId -in $cfg.excludedThreadIds){continue};$availability=Thread-Availability $e;$surface=if($availability.state -eq 'ACTIVE'){Thread-Surface $availability.meta}else{'unknown'};if($surface -eq 'desktop' -or $availability.state -ne 'ACTIVE'){@{threadId=$e.threadId;projectRoot=$e.projectRoot;title=$e.title;state=if($e.attempt){$e.state}elseif($availability.state -ne 'ACTIVE'){$availability.state}else{$e.state};attempt=$e.attempt;holdReason=$e.holdReason;availabilityState=$availability.state;observationError=$availability.reason;executionSurface=$surface;enabledAt=$e.enabledAt;lastDispatchAt=$e.lastDispatchAt;progress=(Continuity-Progress $e)}}});@{schemaVersion=1;threads=$rows;transport='codex-app-tools';claimRequired=$true;automaticReplay=$false;localSenderAvailable=$false;targetRouteProofRequired=$true}|ConvertTo-Json -Depth 8}
  'DesktopHeartbeatObserve' {
   $observation=With-Registry {param($c)Assert-HelperIdentity $c;$e=$c.threads[$ThreadId];if(-not $e -or $ThreadId -in $c.excludedThreadIds){throw 'registered_unprotected_thread_required'};$proof=Read-Json $EvidenceFile;Assert-DesktopEvidence $e $proof
    if($proof.status -ne 'active' -or $proof.turnStatus -ne 'inProgress' -or -not $proof.turnId -or $proof.heartbeatAutomationId -notmatch '^[A-Za-z0-9_-]{1,120}$'){throw 'actual_native_heartbeat_turn_required'}
    $e.lastNativeHeartbeat=@{automationId=$proof.heartbeatAutomationId;turnId=$proof.turnId;observedAt=$proof.observedAt;evidenceSha256=(Get-FileHash -LiteralPath $EvidenceFile -Algorithm SHA256).Hash.ToLowerInvariant();transport='codex-app-heartbeat';notDeliveryAck=$true}
    @{continueWork=($e.enabled -eq $true -and -not $e.holdReason -and $e.state -ne 'COMPLETE');threadId=$ThreadId;turnId=$proof.turnId;selfDispatch=$false;attemptCreated=$false}
   };$observation|ConvertTo-Json
  }
  'DesktopClaim' {
   if($SenderThreadId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $SenderThreadId -ceq $ThreadId){throw 'separate_exact_official_sender_required'}
   if($cfg.threads[$ThreadId].strictAccount){throw 'strict_continuity_dispatch_route_unbound'}
   $proof=Read-Json $EvidenceFile;$pool=Get-PoolReadiness $cfg;if($pool.state -ne 'READY'){@{claimed=$false;state=$pool.state;queuePreserved=$true}|ConvertTo-Json;return}
   $claim=With-Registry {param($c)Assert-HelperIdentity $c;$e=$c.threads[$ThreadId];if(-not $e -or $e.enabled -ne $true -or $ThreadId -in $c.excludedThreadIds -or $e.attempt -or $c.workerStopRequestedAt){throw 'enabled_unclaimed_desktop_thread_required'};if(@($c.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt}).Count -ge 1){throw 'another_dispatch_is_pending'};Assert-DesktopEvidence $e $proof
    if($proof.status -notin @('idle','notLoaded') -or $proof.turnStatus -notin @('completed','failed','interrupted') -or -not $proof.turnId){throw 'exact_idle_terminal_required'}
    $targetRoute=Assert-DesktopTargetRoute $e $proof
    if($proof.turnStatus -ne 'completed' -and $proof.errorCode -notmatch '^(usage_limit_reached|rate_limit_exceeded|quota_exceeded|window_stop_policy)$'){throw 'non_quota_failure_requires_user_resume'}
    $terminal=Terminal-Evidence $e;if($e.holdReason -or $terminal.state -eq 'REQUIRED_ACTION_HOLD'){throw 'exact_hold_resume_required'};if($terminal.event.type -eq 'turn_aborted' -and -not $terminal.quotaTerminal){throw 'user_stopped_turn_preserved'}
    if($e.state -eq 'COMPLETE' -or ($terminal.event.type -eq 'task_complete' -and $terminal.event.last_agent_message -match ('(?m)^AICC_CONTINUITY_COMPLETE:'+ [regex]::Escape($ThreadId)+'\s*$'))){throw 'completed_goal_preserved'}
    $e.attempt=@{id=[guid]::NewGuid().ToString();at=[DateTimeOffset]::UtcNow.ToString('o');transport='codex-app-tools';previousTurnId=$proof.turnId;senderThreadId=$SenderThreadId;targetRoute=$targetRoute;poolReadiness=@{state=$pool.state;observedAt=$pool.observedAt;scope='ocx-pool-only';targetRoute='UNPROVEN'};state='CLAIMED_NO_ACK';evidenceSha256=(Get-FileHash -LiteralPath $EvidenceFile -Algorithm SHA256).Hash.ToLowerInvariant()};$e.state='DISPATCH_CLAIMED';$e.lastAttemptId=$e.attempt.id;$e.lastDispatchAt=$e.attempt.at;return $e.attempt
   };@{claimed=$true;threadId=$ThreadId;attempt=$claim;messageMarker=('AICC_CONTINUITY_ATTEMPT:'+ $claim.id);noReplay=$true}|ConvertTo-Json -Depth 6
  }
  'DesktopAck' {With-Registry {param($c)Assert-HelperIdentity $c;$e=$c.threads[$ThreadId];$proof=Read-Json $EvidenceFile;if(-not $e.attempt -or $e.attempt.id -cne $AttemptId -or $e.attempt.transport -cne 'codex-app-tools'){throw 'exact_desktop_attempt_required'};if($proof.schemaVersion -ne 1 -or $proof.source -cne 'codex-app.send_message_to_thread' -or $proof.threadId -cne $ThreadId -or $proof.attemptId -cne $AttemptId -or $proof.accepted -cne $true -or $proof.responseSha256 -notmatch '^[a-f0-9]{64}$'){throw 'actual_delivery_ack_required'};$e.attempt.ack=$proof;$e.attempt.deliveryAckAt=[DateTimeOffset]::UtcNow.ToString('o');if($e.state -ne 'DESKTOP_TURN_ACTIVE'){$e.attempt.state='ACKNOWLEDGED';$e.state='DESKTOP_DELIVERY_ACCEPTED'}};@{acknowledged=$true;terminalConfirmed=$false;automaticReplay=$false}|ConvertTo-Json}
  'DesktopObserve' {With-Registry {param($c)Assert-HelperIdentity $c;$e=$c.threads[$ThreadId];$proof=Read-Json $EvidenceFile;Assert-DesktopEvidence $e $proof
    if(-not $e.attempt -or $e.attempt.id -cne $AttemptId -or $proof.continuityAttemptId -cne $AttemptId -or $proof.turnId -eq $e.attempt.previousTurnId -or $proof.markerTurnId -cne $proof.turnId -or $proof.attemptMarker -cne ('AICC_CONTINUITY_ATTEMPT:'+$AttemptId)){throw 'exact_marker_bound_delivered_turn_required'}
    if($proof.continuityComplete -ceq $true -and ($proof.turnStatus -cne 'completed' -or $proof.finalMarker -cne ('AICC_CONTINUITY_COMPLETE:'+$ThreadId))){throw 'exact_final_completion_marker_required'}
    if($proof.holdReason -and ($proof.holdReason -notmatch '^[A-Z0-9_]{1,80}$' -or $proof.finalMarker -cne ('AICC_CONTINUITY_HOLD:'+$ThreadId+':'+$proof.holdReason))){throw 'exact_final_hold_marker_required'}
    $e.lastDesktopObservation=@{attemptId=$AttemptId;turnId=$proof.turnId;turnStatus=$proof.turnStatus;observedAt=$proof.observedAt};if($proof.status -eq 'active' -or $proof.turnStatus -eq 'inProgress'){$e.attempt.state='NEW_TURN_OBSERVED';$e.state='DESKTOP_TURN_ACTIVE';return}
    if($proof.turnStatus -notin @('completed','failed','interrupted')){throw 'turn_outcome_unknown_preserved'}
    $quota=$proof.turnStatus -ne 'completed' -and $proof.errorCode -match '^(usage_limit_reached|rate_limit_exceeded|quota_exceeded|window_stop_policy)$'
    $e.lastDesktopResult=@{attemptId=$AttemptId;turnId=$proof.turnId;turnStatus=$proof.turnStatus;errorCode=$proof.errorCode;observedAt=$proof.observedAt};$e.lastTerminalAt=$proof.observedAt;$e.lastTerminal=if($proof.turnStatus -eq 'completed'){'turn.completed'}else{'turn.failed'};$e.failureKind=if($quota){'QUOTA_WAIT'}elseif($proof.turnStatus -eq 'completed'){$null}else{'FAILURE_HOLD'}
    if($proof.turnStatus -eq 'completed' -or $quota){$e.lastContinuityAttempt=$e.attempt;$e.attempt=$null;$e.state=if($quota){'QUOTA_WAIT'}else{'TURN_TERMINAL'};$e.nextCheckAt=[DateTimeOffset]::UtcNow.ToString('o');if($proof.turnStatus -eq 'completed' -and $proof.continuityComplete -ceq $true){$e.state='COMPLETE';$e.enabled=$false};if($proof.turnStatus -eq 'completed' -and $proof.holdReason -match '^[A-Z0-9_]{1,80}$'){$e.state='REQUIRED_ACTION_HOLD';$e.holdReason=$proof.holdReason}}else{$e.state='FAILURE_HOLD'}
   };@{observed=$true;automaticReplay=$false}|ConvertTo-Json}
 }
 return
}
New-Item -ItemType Directory -Path $StateRoot -Force|Out-Null
$workerLock=$null;try{$workerLock=[IO.File]::Open((Join-Path $StateRoot 'worker.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{exit 0}
$running=$null;$pendingLine=$null;$runningId=$null;$streamTerminal=$null;$failureKind=$null
$runningStrict=$false;$runningThreadConfirmed=$false;$runningForeignThread=$false;$runningAttemptId=$null
$runningTurnStartedId=$null;$runningFiveHourTerminal=$null
try{
 while($true){
  $script:registry=Read-Json $configFile;if(-not $script:registry -or $script:registry.schemaVersion -ne 1){throw 'configuration_unknown'}
  Assert-HelperIdentity $script:registry
  if($script:registry.workerStopRequestedAt -and -not $running){With-Registry {param($cfg)$cfg.worker=@{pid=$PID;heartbeatAt=[DateTimeOffset]::UtcNow.ToString('o');state='STOPPED_FOR_MAINTENANCE';noNative=$true}};break}
  With-Registry {param($cfg)$cfg.worker=@{pid=$PID;heartbeatAt=[DateTimeOffset]::UtcNow.ToString('o');state=if($running){'RUNNING_REGISTERED_THREAD'}else{'WATCHING'};noNative=$true;protocolVersion=$protocolVersion;helperSha256=$cfg.helperSha256}}
  if($running){
   $readBudget=0
   while($pendingLine -and $pendingLine.IsCompleted -and $readBudget++ -lt 100){
    $line=$pendingLine.GetAwaiter().GetResult()
    if($null -eq $line){$pendingLine=$null;break}
    try{
     $ev=$line|ConvertFrom-Json -AsHashtable -DateKind String
     if($runningStrict -and $ev.type -eq 'thread.started'){
      if($ev.thread_id -ceq $runningId){$runningThreadConfirmed=$true}else{$runningForeignThread=$true}
     }
     if($runningStrict -and $ev.type -eq 'turn.started'){
      if([string]$ev.turn_id -cmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){
       if($runningTurnStartedId -and $runningTurnStartedId -cne $ev.turn_id){$runningForeignThread=$true}
       $runningTurnStartedId=[string]$ev.turn_id
      }
     }
     if($ev.type -in @('turn.completed','turn.failed')){$streamTerminal=$ev.type}
     if($ev.type -eq 'turn.failed'){
      if($runningStrict){
       $runningFiveHourTerminal=Get-StrictFiveHourQuotaTerminal $ev $runningId $runningTurnStartedId $line
       $failureKind=if($runningFiveHourTerminal){'QUOTA_WAIT'}else{'FAILURE_HOLD'}
      }else{
       $failureKind=if([string]$ev.error.message -match '(?i)rate.?limit|usage.?limit|quota|too many requests|no[ _-]eligible[ _-]account|window_stop_policy'){'QUOTA_WAIT'}else{'FAILURE_HOLD'}
      }
     }
    }catch{}
    $pendingLine=$running.StandardOutput.ReadLineAsync()
   }
   if($running.HasExited -and -not $pendingLine){
    $exitCode=$running.ExitCode
    if($runningStrict){
     $settled=Get-StrictTerminalSettlement $runningThreadConfirmed $runningForeignThread $streamTerminal $failureKind $exitCode
     $exact=$settled.exactThread;$certain=$settled.completed;$quota=$settled.quota
    }else{
     $exact=$true
     $certain=$streamTerminal -eq 'turn.completed' -and $exitCode -eq 0
     $quota=$streamTerminal -eq 'turn.failed' -and $failureKind -eq 'QUOTA_WAIT'
    }
    $updates=@{state=if($certain){'TURN_TERMINAL'}elseif($quota){'QUOTA_WAIT'}elseif($exact -and $streamTerminal -eq 'turn.failed'){'FAILURE_HOLD'}else{'DELIVERY_UNCERTAIN'};lastExitCode=$exitCode;lastTerminal=$streamTerminal;lastTerminalAt=[DateTimeOffset]::UtcNow.ToString('o');failureKind=$failureKind;attempt=if($certain -or $quota){$null}else{$script:registry.threads[$runningId].attempt};nextCheckAt=[DateTimeOffset]::UtcNow.AddSeconds(15).ToString('o')}
    if($runningStrict){
     # Carry the exact prior claim across a settled five-hour refusal. A
     # reset clock is never an authority to invent a new attempt or owner.
     if($quota){$updates.lastContinuityAttempt=$script:registry.threads[$runningId].attempt}
     $updates.lastStrictRouteReceipt=@{attemptId=$runningAttemptId;route='command-route-r2';threadId=$runningId;threadStartedObserved=$runningThreadConfirmed;foreignThreadObserved=$runningForeignThread;terminalEvent=$streamTerminal;exitCode=$exitCode;acknowledged=($certain -or $quota);automaticReplay=$false;observedAt=[DateTimeOffset]::UtcNow.ToString('o');quotaTerminal=if($quota){$runningFiveHourTerminal}else{$null}}
     With-Registry {param($c)$e=$c.threads[$runningId];if(-not $e -or $e.attempt.id -cne $runningAttemptId -or $e.attempt.routeMode -cne 'strict'){throw 'strict_attempt_cas_changed'};foreach($key in $updates.Keys){$e[$key]=$updates[$key]}}
    }else{Set-Observation $runningId $updates}
    $running.Dispose();$running=$null;$runningId=$null;$streamTerminal=$null;$failureKind=$null
    $runningStrict=$false;$runningThreadConfirmed=$false;$runningForeignThread=$false;$runningAttemptId=$null
    $runningTurnStartedId=$null;$runningFiveHourTerminal=$null
   }
   Start-Sleep -Seconds 3;continue
  }
  foreach($id in @((Queue-Order $script:registry.threads.Values)|ForEach-Object threadId)){
   $entry=$script:registry.threads[$id]
   if($entry.queueAttempt -and $id -notin $script:registry.excludedThreadIds){
    # Full original scans are recovery work, not a three-second polling loop.
    if(-not $script:queueRecoveryDue){$script:queueRecoveryDue=@{}}
    if(-not $script:queueRecoveryDue[$id] -or $script:queueRecoveryDue[$id] -le [DateTimeOffset]::UtcNow){
     $script:queueRecoveryDue[$id]=[DateTimeOffset]::UtcNow.AddSeconds(30)
     try{Save-QueueProgress $id}catch{}
    }
    continue
   }
   if($entry.enabled -ne $true -or $id -in $script:registry.excludedThreadIds){continue}
   if($entry.groupOwnerOnly -eq $true -and (-not $entry.groupEvent -or $entry.groupEvent.state -cne 'ENQUEUED')){continue}
   if($null -ne $entry.strictAccount -and (($entry.strictAccount -isnot [int] -and $entry.strictAccount -isnot [long]) -or [int]$entry.strictAccount -lt 1 -or [int]$entry.strictAccount -gt 99)){
    Set-Observation $id @{state='STRICT_SELECTION_INVALID_HOLD';nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')}
    continue
   }
   try{
   if($entry.nextCheckAt -and [DateTimeOffset]::Parse($entry.nextCheckAt) -gt [DateTimeOffset]::UtcNow){continue}
   $availability=Thread-Availability $entry
   if($availability.state -ne 'ACTIVE'){Set-Observation $id @{state=if($entry.attempt){'DELIVERY_UNCERTAIN'}else{$availability.state};availabilityState=$availability.state;observationError=$availability.reason;nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(2).ToString('o')};continue}
   if((Thread-Surface (Metadata $entry.rollout)) -eq 'desktop' -and
      -not ($entry.groupOwnerOnly -eq $true -and $entry.recoveredCliTransport)){if(-not $entry.attempt){$terminal=Terminal-Evidence $entry;Set-Observation $id @{state=if($entry.holdReason -or $terminal.state -eq 'REQUIRED_ACTION_HOLD'){'REQUIRED_ACTION_HOLD'}elseif($entry.state -eq 'COMPLETE'){'COMPLETE'}elseif($terminal.event.error -and -not $terminal.quotaTerminal){'DESKTOP_FAILURE_HOLD'}elseif($terminal.event.type -eq 'turn_aborted'){'USER_STOP_HOLD'}elseif($terminal.event.type -in @('user_message','task_started')){'DESKTOP_ACTIVITY_HINT'}elseif($terminal.quotaTerminal){'QUOTA_WAIT'}else{'DESKTOP_QUEUE_WAIT'};nextCheckAt=[DateTimeOffset]::UtcNow.AddSeconds(30).ToString('o')}};continue}
   $owner=Thread-Owner $entry
   if($owner -ne 'RELEASED'){Set-Observation $id @{state=$owner;ownerBlocker=$script:ownerBlocker;nextCheckAt=[DateTimeOffset]::UtcNow.AddSeconds(30).ToString('o')};continue}
   # A typed original strict five-hour refusal is NOT permission for another
   # send. The exact issuer must first authorise one bounded resume with
   # same-owner revision/stop epoch/deadline. No such one-use issuer exists
   # in the installed worker today, so preserve it rather than auto-replay.
   if($entry.lastTerminal -ceq 'turn.failed' -and
      $entry.lastStrictRouteReceipt -and
      $entry.lastStrictRouteReceipt.quotaTerminal){
    Set-Observation $id @{state='EXACT_QUOTA_OWNER_REAUTHORISATION_HOLD';
      nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')}
    continue
   }
   if($entry.holdReason){Set-Observation $id @{state='REQUIRED_ACTION_HOLD';nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(15).ToString('o')};continue}
   if($entry.attempt){
    if($null -ne $entry.strictAccount){
     # A saved strict claim may have reached the provider. Never infer delivery
     # from an old rollout after a worker restart or reissue the launch.
     Set-Observation $id @{state='STRICT_DELIVERY_UNCERTAIN';nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')}
     continue
    }
    # A restarted watcher may have missed stdout. Accept only a saved terminal
    # event from this exact thread after the dispatch claim; never replay unknown work.
    $terminal=@(Read-Tail $entry.rollout)|Where-Object {$_.type -eq 'task_complete' -and $_.recordedAt -and [DateTimeOffset]::Parse($_.recordedAt) -ge [DateTimeOffset]::Parse($entry.attempt.at)}|Select-Object -Last 1
    if(-not $terminal){Set-Observation $id @{state=if($entry.failureKind -eq 'FAILURE_HOLD'){'FAILURE_HOLD'}else{'DELIVERY_UNCERTAIN'};nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')};continue}
    Set-Observation $id @{state='SAVED_TERMINAL_RECOVERED';attempt=$null;failureKind=$null;lastTerminal='saved.task_complete'}
   }
   $meta=Metadata $entry.rollout;if($meta.id -ne $id -or [IO.Path]::GetFullPath($meta.cwd) -ine [IO.Path]::GetFullPath($entry.projectRoot)){Set-Observation $id @{state='THREAD_SCOPE_HOLD';enabled=$false};continue}
   $file=Get-Item -LiteralPath $entry.rollout;if([DateTime]::UtcNow-$file.LastWriteTimeUtc -lt [TimeSpan]::FromSeconds(30)){continue}
   $events=@(Read-Tail $entry.rollout)
   $lastEvent=$events|Where-Object {$_.type -in @('user_message','task_started','task_complete','turn_aborted')}|Select-Object -Last 1
   $complete=$lastEvent -and $lastEvent.type -eq 'task_complete' -and $lastEvent.last_agent_message -match ('(?m)^AICC_CONTINUITY_COMPLETE:'+ [regex]::Escape($id)+'\s*$')
   if($complete){Set-Observation $id @{state='COMPLETE';enabled=$false};continue}
   $terminalEvidence=Terminal-Evidence $entry
   if($lastEvent -and $lastEvent.type -ne 'task_complete' -and -not $terminalEvidence.quotaTerminal){Set-Observation $id @{state='INTERRUPTED_TURN_HOLD';nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')};continue}
   if(-not $lastEvent){Set-Observation $id @{state='TERMINAL_EVIDENCE_UNKNOWN';nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')};continue}
   $holdPattern='(?m)^AICC_CONTINUITY_HOLD:'+ [regex]::Escape($id)+':([A-Z0-9_]{1,80})\s*$'
   if($terminalEvidence.state -eq 'REQUIRED_ACTION_HOLD'){Set-Observation $id @{state='REQUIRED_ACTION_HOLD';holdReason=$terminalEvidence.holdReason;terminalSha256=$terminalEvidence.sha256;nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(15).ToString('o')};continue}
   $strictMode=($null -ne $entry.strictAccount)
   $strictNumber=if($strictMode){[int]$entry.strictAccount}else{0}
   $strictBinding=$null;$strictLauncher=$null;$strictQuotaCheckedAt=$null;$strictQuotaUpdatedAtMs=$null
   if($strictMode){
    if($entry.state -match 'UNKNOWN|UNCERTAIN|HOLD|COMPLETE|RESUMING_OCX'){continue}
    # Uninstalled or changed bridge must not repeatedly query owner quota.
    try{$strictLauncher=Get-StrictRouteLauncher $script:registry}
    catch{
     Set-Observation $id @{state='STRICT_EXECUTION_UNBOUND';nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')}
     continue
    }
    $strictQuota=Get-StrictAccountReadiness $strictNumber
    if($strictQuota.state -cne 'STRICT_ACCOUNT_READY'){
     Set-Observation $id @{state=$strictQuota.state;nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(1).ToString('o')}
     continue
    }
    $strictQuotaCheckedAt=[DateTimeOffset]::UtcNow
    $strictQuotaUpdatedAtMs=[long]$strictQuota.quotaUpdatedAtMs
    try{
     $strictBinding=Resolve-StrictOwnerAccount $strictNumber
     if($strictBinding.paused){throw 'strict_account_paused'}
    }catch{
     Set-Observation $id @{state='STRICT_SELECTOR_MISMATCH';nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')}
     continue
    }
   }else{
    $pool=Get-PoolReadiness $script:registry
    if($pool.state -ne 'READY'){
     Set-Observation $id @{state=$pool.state;nextResetAt=$pool.nextResetAt;nextCheckAt=[DateTimeOffset]::UtcNow.AddSeconds($pool.delay).ToString('o')}
     continue
    }
   }
   $binary=$script:registry.codexExecutable
   if((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:registry.codexSha256){Set-Observation $id @{state='CODEX_IDENTITY_HOLD';enabled=$false};continue}
   $claim=[guid]::NewGuid().ToString()
   $dispatch=With-Registry {
    param($cfg)
    Assert-HelperIdentity $cfg
    $e=$cfg.threads[$id]
    if(-not $e -or $cfg.workerStopRequestedAt -or $e.enabled -ne $true -or $id -in $cfg.excludedThreadIds -or $e.attempt -or $e.queueAttempt -or $e.holdReason -or @($cfg.threads.Values|Where-Object {$_.attempt -or $_.queueAttempt}).Count -ne 0){return $false}
    if($strictMode){
     if(($e.strictAccount -isnot [int] -and $e.strictAccount -isnot [long]) -or [int]$e.strictAccount -ne $strictNumber -or $e.state -match 'UNKNOWN|UNCERTAIN|HOLD|COMPLETE|RESUMING_OCX'){return $false}
     if(($null -eq $strictQuotaCheckedAt) -or ([DateTimeOffset]::UtcNow-$strictQuotaCheckedAt).TotalSeconds -gt 15 -or $strictQuotaUpdatedAtMs -le 0 -or ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$strictQuotaUpdatedAtMs) -ge 60000){return $false}
     $currentBinding=Resolve-StrictOwnerAccount $strictNumber
     $currentLauncher=Get-StrictRouteLauncher $cfg
     if($currentBinding.paused -or $currentBinding.selector -cne $strictBinding.selector -or $currentBinding.accountId -cne $strictBinding.accountId -or $currentLauncher.bridgeSha256 -cne $strictLauncher.bridgeSha256 -or $currentLauncher.routeModuleSha256 -cne $strictLauncher.routeModuleSha256){return $false}
    }elseif($null -ne $e.strictAccount){return $false}
    $terminal=Terminal-Evidence $e
    if($terminal.state -ne 'TERMINAL' -or (Thread-Owner $e) -ne 'RELEASED'){return $false}
    $record=@{id=$claim;at=[DateTimeOffset]::UtcNow.ToString('o');terminalSha256=$terminal.sha256}
    if($e.groupOwnerOnly -eq $true){
     # Single create-once group claim before starting any model process.
     if(-not $strictMode -or -not(Confirm-GroupOwnerClaim $cfg $e $StateRoot $OperationId)){return $false}
     $record.groupEventId=$e.groupEvent.eventId
    }
    if($strictMode){
     $record.routeMode='strict';$record.accountNumber=$strictNumber;$record.selectorSha256=Digest-Text $strictBinding.selector;$record.executionRoute='command-route-r2';$record.automaticReplay=$false
    }
    $e.attempt=$record;$e.lastDispatchAt=$record.at;$e.state='DISPATCH_CLAIMED'
    return $true
   }
   if(-not $dispatch){continue}
   $prompt='기존 대화와 정본의 중단 지점부터 승인된 남은 작업을 계속해라. OCX Sol 6.1 High만 사용하고 Native로 자동 대체하지 마라. 먼저 현재 영수증·작성자·이미 수행한 변경을 읽어 중복 작업을 피하고 결과 불명 요청을 재전송하지 마라. 보호된 검증 대기 세션을 재개하지 마라. 기존 승인은 유지하되 정책·도구 거부를 우회하지 마라. 등록된 목표의 모든 필수 작업이 실제로 완료되면 마지막 줄에 AICC_CONTINUITY_COMPLETE:'+ $id +' 를 쓰고, HOLD는 완료로 표시하지 마라. 현재 모델 정책대로 코드 사후 검증은 사용자가 명시한 범위만 하고 미실행을 완료로 바꾸지 마라. 실행 가능한 안전한 남은 작업부터 모두 수행하고, 같은 외부 조건 때문에 더 진행할 수 없을 때는 다음 주체와 필요한 한 행동을 보고한 뒤 마지막 줄에 AICC_CONTINUITY_HOLD:'+$id+':REQUIRED_EXTERNAL_ACTION 을 써라. 설치 또는 조회만으로 전체 목표 완료를 선언하지 마라.'
   $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=if($strictMode){$strictLauncher.nodePath}else{$binary};$info.WorkingDirectory=$entry.projectRoot;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
   if($strictMode){$info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)}
   if($strictMode){
    foreach($arg in @($strictLauncher.bridgePath,$strictBinding.selector,$id,$entry.projectRoot,$binary,$script:registry.codexSha256,$prompt)){$info.ArgumentList.Add($arg)}
   }else{
    foreach($arg in @('--no-daemon','-c','model_provider="openai"','-c','openai_base_url="http://127.0.0.1:17841/v1"','-c','model_reasoning_effort="high"','-m','gpt-6.1-sol','-a','never','-s','danger-full-access','-C',$entry.projectRoot,'exec','resume',$id,'--json',$prompt)){$info.ArgumentList.Add($arg)}
   }
   foreach($name in @('CODEX_THREAD_ID','CODEX_SESSION_ID')){$null=$info.Environment.Remove($name)}
   try{
    $running=[Diagnostics.Process]::Start($info)
    $runningStrict=$strictMode;$runningThreadConfirmed=$false;$runningForeignThread=$false;$runningAttemptId=$claim
    $runningTurnStartedId=$null;$runningFiveHourTerminal=$null
    $null=$running.StandardError.ReadToEndAsync();$pendingLine=$running.StandardOutput.ReadLineAsync()
    $runningId=$id;$streamTerminal=$null
    $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$running.Id)
    Set-Observation $id @{state='RESUMING_OCX';ownerPid=$running.Id;ownerCreatedAt=$p.CreationDate.ToUniversalTime().ToString('o');lastAttemptId=$claim}
    break
   }catch{Set-Observation $id @{state='DELIVERY_UNCERTAIN'};break}
   }catch{
    $entryErrorType=$_.Exception.GetType().FullName
    With-Registry {param($c)$e=$c.threads[$id];if($e){$e.observationError='ENTRY_OBSERVATION_FAILED';$e.observationErrorType=$entryErrorType;$e.observedAt=[DateTimeOffset]::UtcNow.ToString('o');$e.nextCheckAt=[DateTimeOffset]::UtcNow.AddMinutes(2).ToString('o');if($e.enabled -eq $true){$e.state=if($e.attempt){'DELIVERY_UNCERTAIN'}elseif($e.holdReason){'REQUIRED_ACTION_HOLD'}else{'THREAD_OBSERVATION_HOLD'}}}}
   }
  }
  Start-Sleep -Seconds 15
 }
}catch{
 $workerErrorType=$_.Exception.GetType().FullName
 try{if($script:registry.workerStopRequestedAt -and -not $running){With-Registry {param($cfg)$cfg.worker=@{pid=$PID;heartbeatAt=[DateTimeOffset]::UtcNow.ToString('o');state='STOPPED_FOR_MAINTENANCE';noNative=$true}};break}
  With-Registry {param($cfg)$cfg.worker=@{pid=$PID;heartbeatAt=[DateTimeOffset]::UtcNow.ToString('o');state='WORKER_FAILED';errorType=$workerErrorType;noNative=$true}}}catch{}
 throw
}finally{if($workerLock){$workerLock.Dispose()}}
