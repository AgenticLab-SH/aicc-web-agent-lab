#requires -Version 7.5
# Owner-only explicit installer. This source never starts a worker or model.
# Loaded into CodexContinuityMaintenance.psm1; reuse its pinned maintenance gate.
function GroupInstall-HashText([string]$text){
 [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text)))
}
function GroupInstall-RequireOwner([string]$StateRoot){
 $expected=[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center/control-plane/codex-continuity'))
 if([IO.Path]::GetFullPath($StateRoot) -ine $expected){throw 'exact_owner_local_state_root_required'}
}
function GroupInstall-PlanScope([string]$StateRoot,[string]$PlanFile){
 if(-not [IO.Path]::IsPathFullyQualified($PlanFile)){throw 'owner_plan_absolute_path_required'}
 $base=Join-Path ([IO.Path]::GetFullPath($StateRoot)) 'plans'
 if(-not(Test-Path -LiteralPath $base -PathType Container)){New-Item -ItemType Directory -Path $base -Force|Out-Null}
 if((Get-Item -LiteralPath $base).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'owner_plan_linked_directory'}
 $full=[IO.Path]::GetFullPath($PlanFile)
 $prefix=[IO.Path]::GetFullPath($base).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
 if(-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($full) -cnotmatch '^[A-Za-z0-9._-]{8,100}\.json$' -or
    [IO.Path]::GetDirectoryName($full) -ine $base){throw 'owner_group_plan_scope_required'}
}
function GroupInstall-SafeFile([string]$Path,[string]$Root,[string]$Sha,[long]$MaximumBytes=67108864){
 if($MaximumBytes -notin @(67108864,134217728)){throw 'group_installer_file_limit_invalid'}
 if(-not [IO.Path]::IsPathFullyQualified($Path) -or $Sha -cnotmatch '^[a-f0-9]{64}$'){throw 'group_installer_file_pin_required'}
 $full=[IO.Path]::GetFullPath($Path)
 $base=[IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
 if((Get-Item -LiteralPath $Root -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'group_installer_root_linked'}
 if(-not $full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'group_installer_file_outside_owner'}
 for($p=$full;$p.StartsWith($base,[StringComparison]::OrdinalIgnoreCase);$p=[IO.Path]::GetDirectoryName($p)){
  $item=Get-Item -LiteralPath $p -ErrorAction Stop
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'group_installer_linked_path'}
 }
 $f=Get-Item -LiteralPath $full -ErrorAction Stop
 if($f.PSIsContainer -or $f.Length -gt $MaximumBytes -or (Maintenance-Hash $full) -cne $Sha){throw 'group_installer_file_changed'}
}
function GroupInstall-TaskOwnerSid([string]$Identity){
 if([string]::IsNullOrWhiteSpace($Identity)){throw 'task_owner_identity_unresolved'}
 try{
  if($Identity -match '^S-\d-'){
   return ([Security.Principal.SecurityIdentifier]::new($Identity)).Value
  }
  return ([Security.Principal.NTAccount]::new($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value
 }catch{throw 'task_owner_identity_unresolved'}
}
function GroupInstall-TaskSnapshot([string]$StateRoot){
 $taskName='AgenticLab-AICC-Codex-Continuity'
 $description='AICC owner-local registered Codex thread continuity; OCX only; no request replay'
 $task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
 if($task.TaskName -cne $taskName -or $task.Description -cne $description -or
    [string]$task.State -notin @('Ready','Disabled') -or @($task.Actions).Count -ne 1){throw 'unowned_or_running_task_preserved'}
 $action=$task.Actions[0]
 $wscript=Join-Path ([Environment]::GetFolderPath('Windows')) 'System32/wscript.exe'
 if([IO.Path]::GetFullPath($action.Execute) -ine [IO.Path]::GetFullPath($wscript) -or
    [string]$action.Arguments -cnotmatch '^/b /nologo "([^"]+worker\.hidden\.vbs)"$'){throw 'exact_old_continuity_task_required'}
 $vbs=[regex]::Match([string]$action.Arguments,'^/b /nologo "(?<file>[^"]+worker\.hidden\.vbs)"$').Groups['file'].Value
 $releaseRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center/releases/codex-continuity'
 $sha=Maintenance-Hash $vbs
 GroupInstall-SafeFile $vbs $releaseRoot $sha
 if([IO.Path]::GetFullPath([string]$action.WorkingDirectory) -ine [IO.Path]::GetDirectoryName($vbs)){throw 'old_task_working_directory_changed'}
 if((GroupInstall-TaskOwnerSid ([string]$task.Principal.UserId)) -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
    [string]$task.Principal.RunLevel -notin @('Limited','LeastPrivilege')){throw 'task_owner_or_privilege_mismatch'}
 $xml=Export-ScheduledTask -TaskName $taskName -ErrorAction Stop
 @{taskName=$taskName;xml=$xml;xmlSha256=(GroupInstall-HashText $xml);oldVbs=$vbs;oldVbsSha256=$sha;oldTaskState=[string]$task.State;wscript=$wscript}
}
function GroupInstall-TaskXml([string]$PriorXml,[string]$Vbs,[string]$Release,[string]$Wscript){
 $xml=[xml]$PriorXml
 $execs=@($xml.SelectNodes('/*[local-name()="Task"]/*[local-name()="Actions"]/*[local-name()="Exec"]'))
 if($execs.Count -ne 1){throw 'exact_single_task_exec_required'}
 $exec=$execs[0]
 $command=$exec.SelectSingleNode('./*[local-name()="Command"]')
 $arguments=$exec.SelectSingleNode('./*[local-name()="Arguments"]')
 $working=$exec.SelectSingleNode('./*[local-name()="WorkingDirectory"]')
 if(-not $command -or -not $arguments -or -not $working){throw 'complete_task_exec_required'}
 $command.InnerText=$Wscript
 $arguments.InnerText='/b /nologo "'+$Vbs+'"'
 $working.InnerText=$Release
 # Stopped installer must register a dormant Task.
 $enabled=$xml.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="Settings"]/*[local-name()="Enabled"]')
 if(-not $enabled){
  # Task Scheduler omits Enabled when it has the schema default true.
  $settings=$xml.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="Settings"]')
  if(-not $settings){throw 'task_settings_preimage_required'}
  $enabled=$xml.CreateElement('Enabled',$settings.NamespaceURI)
  $null=$settings.AppendChild($enabled)
 }
 $enabled.InnerText='false'
 return $xml.OuterXml
}
function GroupInstall-ExactResumeArgs([string]$CommandLine,[string]$ThreadId,[string[]]$AllowedExecutables){
 # A substring match is not evidence that the original no-daemon CLI owns a thread.
 $pattern='^(?:"(?<quoted>[^"]+)"|(?<unquoted>[^\s"]+))\s+--no-daemon\s+resume\s+(?<id>[a-f0-9-]{36})\s*$'
 if($CommandLine -cnotmatch $pattern -or $Matches['id'] -cne $ThreadId){throw 'recovered_cli_exact_no_daemon_resume_required'}
 $exe=if($Matches['quoted']){$Matches['quoted']}else{$Matches['unquoted']}
 if(-not @($AllowedExecutables|Where-Object {[IO.Path]::GetFullPath($_) -ieq [IO.Path]::GetFullPath($exe)}).Count){throw 'recovered_cli_command_executable_changed'}
 return @('--no-daemon','resume',$ThreadId)
}
function GroupInstall-CheckRecoveredFacts($meta,$e,$process,[string]$ThreadId,[string]$ExpectedRoot,[string]$Rollout,[string]$MetaSha,[string]$CodexPath,[string]$CodexSha,[string]$ReleaseExe){
 $rx='^[a-f0-9]{64}$'
 if($meta.type -cne 'session_meta' -or $meta.payload.source -isnot [string] -or $meta.payload.source -cne 'vscode' -or
    $meta.payload.id -cne $ThreadId -or [IO.Path]::GetFullPath([string]$meta.payload.cwd) -ine [IO.Path]::GetFullPath($ExpectedRoot) -or
    $e.schemaVersion -ne 1 -or $e.kind -cne 'aicc-recovered-cli-transport' -or $e.threadId -cne $ThreadId -or
    [IO.Path]::GetFullPath([string]$e.projectRoot) -ine [IO.Path]::GetFullPath($ExpectedRoot) -or
    [IO.Path]::GetFullPath([string]$e.rollout) -ine [IO.Path]::GetFullPath($Rollout) -or
    $e.metaSha256 -cne $MetaSha -or $e.metaSha256 -cnotmatch $rx -or
    $e.codexSha256 -cne $CodexSha -or $e.codexSha256 -cnotmatch $rx -or
    [IO.Path]::GetFullPath([string]$e.codexExecutable) -ine [IO.Path]::GetFullPath($CodexPath) -or
    $e.signerThumbprint -cnotmatch '^[A-F0-9]{40}$' -or
    ($e.ownerPid -isnot [int] -and $e.ownerPid -isnot [long]) -or $e.ownerPid -le 0 -or
    $process.ProcessId -ne $e.ownerPid -or -not $process.ExecutablePath -or -not $process.CommandLine -or -not $process.CreationDate){
  throw 'recovered_cli_evidence_binding_changed'
 }
 if([IO.Path]::GetFullPath([string]$process.ExecutablePath) -ine [IO.Path]::GetFullPath($ReleaseExe) -and
    [IO.Path]::GetFullPath([string]$process.ExecutablePath) -ine [IO.Path]::GetFullPath($CodexPath)){throw 'recovered_cli_process_binary_changed'}
 $actualCreated=$process.CreationDate.ToUniversalTime().ToString('o')
 if(([DateTimeOffset]::Parse([string]$e.ownerCreatedAt)).UtcDateTime.ToString('o') -cne $actualCreated){throw 'recovered_cli_process_creation_changed'}
 $args=GroupInstall-ExactResumeArgs ([string]$process.CommandLine) $ThreadId @($CodexPath,$ReleaseExe)
 if($e.commandLineSha256 -cne (GroupInstall-HashText ([string]$process.CommandLine)) -or
    $e.commandLineSha256 -cnotmatch $rx){throw 'recovered_cli_command_line_changed'}
 if((@($e.resumeArgs)|ConvertTo-Json -Compress) -cne (@($args)|ConvertTo-Json -Compress)){throw 'recovered_cli_arguments_changed'}
}
function GroupInstall-ManagedReleasePath([string]$Standalone,$Junction){
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
function GroupInstall-RecoveredCliProof([string]$ThreadId,[string]$ExpectedRoot,[string]$Rollout,[string]$MetaLine,$meta,$cfg,[string]$StateRoot,[string]$EvidenceFile){
 if(-not $EvidenceFile){throw 'explicit_recovered_cli_evidence_required'}
 GroupInstall-PlanScope $StateRoot $EvidenceFile
 $item=Get-Item -LiteralPath $EvidenceFile -ErrorAction Stop
 if($item.PSIsContainer -or $item.Length -gt 8192){throw 'recovered_cli_evidence_file_unsafe'}
 GroupInstall-SafeFile $EvidenceFile (Join-Path $StateRoot 'plans') (Maintenance-Hash $EvidenceFile)
 $e=Maintenance-Read $EvidenceFile
 $exe=[IO.Path]::GetFullPath([string]$cfg.codexExecutable)
 $ownerHome=[Environment]::GetFolderPath('UserProfile')
 $standalone=Join-Path $ownerHome '.codex/packages/standalone'
 $current=Join-Path $standalone 'current'
 $anchor=Join-Path $current 'bin/codex.exe'
 if($exe -ine [IO.Path]::GetFullPath($anchor)){throw 'recovered_cli_managed_standalone_required'}
 $junction=Get-Item -LiteralPath $current -ErrorAction Stop
 $release=GroupInstall-ManagedReleasePath $standalone $junction
 $releaseExe=Join-Path $release 'bin/codex.exe'
 if((Maintenance-Hash $exe) -cne $cfg.codexSha256 -or (Maintenance-Hash $releaseExe) -cne $cfg.codexSha256){throw 'recovered_cli_official_pin_changed'}
 $sig=Get-AuthenticodeSignature -LiteralPath $releaseExe -ErrorAction Stop
 if($sig.Status -ne 'Valid' -or -not $sig.SignerCertificate -or
    $sig.SignerCertificate.Subject -notmatch '(?:^|, )O="?OpenAI OpCo, LLC"?(?:,|$)' -or
    $sig.SignerCertificate.Thumbprint -cne $e.signerThumbprint){throw 'recovered_cli_official_signature_required'}
 if($e.ownerPid -isnot [int] -and $e.ownerPid -isnot [long]){throw 'recovered_cli_exact_pid_required'}
 $processes=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$e.ownerPid) -ErrorAction Stop)
 if($processes.Count -ne 1){throw 'recovered_cli_original_owner_not_live_for_preview'}
 $metaSha=GroupInstall-HashText $MetaLine
 GroupInstall-CheckRecoveredFacts $meta $e $processes[0] $ThreadId $ExpectedRoot $Rollout $metaSha $exe $cfg.codexSha256 $releaseExe
 return @{schemaVersion=1;kind='aicc-recovered-cli-transport';threadId=$ThreadId;projectRoot=[IO.Path]::GetFullPath($ExpectedRoot);
  rollout=[IO.Path]::GetFullPath($Rollout);metaSha256=$metaSha;codexExecutable=$exe;codexSha256=$cfg.codexSha256;
  signerThumbprint=$e.signerThumbprint;ownerPid=[int]$e.ownerPid;ownerCreatedAt=$processes[0].CreationDate.ToUniversalTime().ToString('o');
  resumeArgs=@('--no-daemon','resume',$ThreadId);commandLineSha256=$e.commandLineSha256;
  evidenceFile=[IO.Path]::GetFullPath($EvidenceFile);evidenceSha256=(Maintenance-Hash $EvidenceFile)}
}
function GroupInstall-Thread([string]$ThreadId,[string]$ExpectedRoot,$cfg,[string]$StateRoot,[string]$RecoveredCliEvidenceFile){
 $idRx='^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 if($ThreadId -cnotmatch $idRx -or $ThreadId -in $cfg.excludedThreadIds -or -not [IO.Path]::IsPathFullyQualified($ExpectedRoot)){throw 'exact_unprotected_group_thread_required'}
 $ownerHome=[Environment]::GetFolderPath('UserProfile')
 $sessions=Join-Path $ownerHome '.codex/sessions'
 if($cfg.threads.ContainsKey($ThreadId)){
  $e=$cfg.threads[$ThreadId]
  if([IO.Path]::GetFullPath($e.projectRoot) -ine [IO.Path]::GetFullPath($ExpectedRoot) -or
     $e.attempt -or $e.queueAttempt -or $e.groupEvent -or $e.groupOwnerOnly -or $e.enabled -ne $false -or
     $e.state -match 'UNKNOWN|UNCERTAIN|HOLD|RESUMING_OCX|COMPLETE'){throw 'existing_thread_not_safe_to_opt_in'}
  $file=$e.rollout
 }else{
  $hits=@(Get-ChildItem -LiteralPath $sessions -Recurse -File -Filter ('*'+$ThreadId+'.jsonl')|Select-Object -First 2)
  if($hits.Count -ne 1){throw 'single_exact_cli_rollout_required'}
  $file=$hits[0].FullName
 }
 $full=[IO.Path]::GetFullPath($file)
 $base=[IO.Path]::GetFullPath($sessions)+[IO.Path]::DirectorySeparatorChar
 if(-not $full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'active_codex_sessions_required'}
 for($p=$full;$p.StartsWith($base,[StringComparison]::OrdinalIgnoreCase);$p=[IO.Path]::GetDirectoryName($p)){
  if((Get-Item -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_rollout_refused'}
 }
 $stream=[IO.File]::Open($full,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
 try{$reader=[IO.StreamReader]::new($stream);$first=$reader.ReadLine();if(-not $first -or $first.Length -gt 65536){throw 'rollout_meta_oversize'};$meta=$first|ConvertFrom-Json -AsHashtable -DateKind String}finally{$stream.Dispose()}
 if($meta.type -cne 'session_meta' -or $meta.payload.id -cne $ThreadId -or
    [IO.Path]::GetFullPath([string]$meta.payload.cwd) -ine [IO.Path]::GetFullPath($ExpectedRoot) -or
    $meta.payload.source -isnot [string] -or
    $meta.payload.source -cnotin @('cli','exec','vscode')){throw 'exact_cli_thread_identity_unproven'}
 $recovered=$null
 if($meta.payload.source -ceq 'vscode'){
  $recovered=GroupInstall-RecoveredCliProof $ThreadId $ExpectedRoot $full $first $meta $cfg $StateRoot $RecoveredCliEvidenceFile
 }elseif($RecoveredCliEvidenceFile){throw 'recovered_cli_opt_in_only_for_original_vscode'}
 @{threadId=$ThreadId;projectRoot=[IO.Path]::GetFullPath($ExpectedRoot);rollout=$full;registered=$cfg.threads.ContainsKey($ThreadId);
   sourceMetadataSha256=(GroupInstall-HashText $first);recoveredCliTransport=$recovered}
}
function GroupInstall-AssertNoGroupMarkers([string]$StateRoot){
 # A create-once marker can precede registry commit after an interrupted claim.
 # No stopped install or rollback may erase/reuse that uncertain delivery.
 foreach($name in @('group-claims','group-events')){
  $folder=Join-Path $StateRoot $name
  if(-not(Test-Path -LiteralPath $folder)){continue}
  $item=Get-Item -LiteralPath $folder -ErrorAction Stop
  if(-not $item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'group_marker_directory_unsafe'}
  if(@(Get-ChildItem -LiteralPath $folder -Force -ErrorAction Stop).Count){throw 'group_unsettled_marker_preserved'}
 }
}
function GroupInstall-AssertHistoricalQueueCas($plan,$receipt,$beforeCfg,$currentCfg){
 # An installed helper has a new SHA; only exactly previously proven queue bytes
 # may survive rollback. No new pending claim or global dispatch exemption.
 $proofs=@($plan.preservedQueues)
 if($null -eq $plan.preservedQueues -or ($receipt -and
    ((& $script:PinModule {param($v)Get-PinValueDigest $v} -v $proofs) -cne
     (& $script:PinModule {param($v)Get-PinValueDigest $v} -v @($receipt.preservedQueues))))){throw 'group_rollback_preserved_queue_proof_changed'}
 $seen=@()
 foreach($id in @(@($beforeCfg.threads.Keys)+@($currentCfg.threads.Keys)|Sort-Object -Unique)){
  $old=$beforeCfg.threads[$id];$now=$currentCfg.threads[$id]
  if(($old -and ($old.attempt -or $old.groupEvent)) -or
     ($now -and ($now.attempt -or $now.groupEvent))){throw 'group_rollback_new_claim_or_group_event'}
  $oldQueue=if($old){$old.queueAttempt}else{$null}
  $newQueue=if($now){$now.queueAttempt}else{$null}
  $oldDigest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $oldQueue
  $newDigest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $newQueue
  if($oldDigest -cne $newDigest){throw 'group_rollback_queue_changed'}
  if($oldQueue){
   $hits=@($proofs|Where-Object {$_.threadId -ceq $id -and $_.attemptId -ceq $oldQueue.id})
   if($hits.Count -ne 1 -or $hits[0].queueSha256 -cne $oldDigest){throw 'group_rollback_unsealed_historical_queue'}
   $q=$hits[0]
   $requestDir=Join-Path $plan.stateRoot 'requests'
   $expectedFile=Join-Path $requestDir ($q.attemptId+'.json')
   if([IO.Path]::GetFullPath([string]$q.receiptFile) -ine [IO.Path]::GetFullPath($expectedFile)){throw 'group_rollback_queue_receipt_path_changed'}
   $item=Get-Item -LiteralPath $q.receiptFile -ErrorAction Stop
   if($item.Length -gt 2097152){throw 'group_rollback_queue_receipt_oversize'}
   GroupInstall-SafeFile $q.receiptFile $requestDir $q.receiptSha256
   $seen+=,$id
  }
 }
 if($seen.Count -ne $proofs.Count){throw 'group_rollback_historical_queue_count_changed'}
}
function New-AiccGroupOwnerInstallPlan{
 param([string]$StateRoot,[string]$SourceRoot,[string]$NodePath,[string]$PlanFile,
       [string]$ThreadId,[string]$TargetRoot,[string]$OwnerRevision,[long]$StopEpoch,[string]$WorkerOperationId,[string]$RecoveredCliEvidenceFile)
 GroupInstall-RequireOwner $StateRoot
 GroupInstall-PlanScope $StateRoot $PlanFile
 if($OwnerRevision -cnotmatch '^[a-f0-9]{64}$' -or $StopEpoch -lt 0 -or
    $WorkerOperationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw 'exact_owner_generation_required'}
 $state=[IO.Path]::GetFullPath($StateRoot);$source=[IO.Path]::GetFullPath($SourceRoot)
 $lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $state
 $fence=$null
 try{
  $file=Join-Path $state 'registrations.json';$cfg=Maintenance-Read $file
  $fence=& $script:PinModule {param($c,$s)Enter-PinMaintenanceFence $c $s} $cfg $state
  if(-not $fence){throw 'stop_fence_required'}
  $queues=@(Maintenance-Proof $cfg $state)
  GroupInstall-AssertNoGroupMarkers $state
  if($cfg.groupOwner){throw 'existing_group_authorisation_preserved'}
  $thread=GroupInstall-Thread $ThreadId $TargetRoot $cfg $state $RecoveredCliEvidenceFile
  $task=GroupInstall-TaskSnapshot $state
  if((Maintenance-Hash $cfg.codexExecutable) -cne $cfg.codexSha256){throw 'codex_identity_changed'}
  $nodeSha=Maintenance-Hash $NodePath
  GroupInstall-SafeFile $NodePath ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($NodePath))) $nodeSha 134217728
  $pwshPath=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center/toolchain/pwsh-7.6.6/runtime/pwsh.exe'
  $pwshSha=Maintenance-Hash $pwshPath
  $files=Maintenance-Closure $source
  if(-not $files.ContainsKey('tools/platform/windows/CodexContinuityGroupOwner.ps1')){throw 'group_owner_helper_module_required'}
  $op=[guid]::NewGuid().ToString()
  $release=Join-Path ([Environment]::GetFolderPath('UserProfile')) ('.ai-control-center/releases/codex-continuity/group-owner-'+$op)
  $p=@{schemaVersion=1;kind='aicc-group-owner-installer';action='InstallGroupOwnerStopped';operationId=$op;
   stateRoot=$state;sourceRoot=$source;registrySha256=(Maintenance-Hash $file);files=$files;nodePath=[IO.Path]::GetFullPath($NodePath);
   nodeSha256=$nodeSha;pwshPath=$pwshPath;pwshSha256=$pwshSha;releaseRoot=$release;taskName=$task.taskName;
   taskXmlSha256=$task.xmlSha256;oldVbs=$task.oldVbs;oldVbsSha256=$task.oldVbsSha256;
   oldTaskState=$task.oldTaskState;preservedQueues=$queues;thread=$thread;ownerRevision=$OwnerRevision;
   stopEpoch=$StopEpoch;workerOperationId=$WorkerOperationId;expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')}
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($p|ConvertTo-Json -Depth 18)+[Environment]::NewLine)
  $stream=[IO.File]::Open($PlanFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
  @{state='PREPARED';planFile=$PlanFile;planSha256=(Maintenance-Hash $PlanFile);
    confirmation='INSTALL GROUP OWNER '+(Maintenance-Hash $PlanFile);workerStarted=$false;taskChanged=$false;modelRequests=0}
 }finally{if($fence){$fence.Dispose()};$lock.Dispose()}
}
function Invoke-AiccGroupOwnerInstallPlan{
 param([string]$PlanFile,[string]$ExpectedPlanSha256,[string]$Confirm)
 if((Maintenance-Hash $PlanFile) -cne $ExpectedPlanSha256 -or $Confirm -cne ('INSTALL GROUP OWNER '+$ExpectedPlanSha256)){throw 'exact_group_install_confirmation_required'}
 $p=Maintenance-Read $PlanFile
 if($p.schemaVersion -ne 1 -or $p.kind -cne 'aicc-group-owner-installer' -or $p.action -cne 'InstallGroupOwnerStopped' -or
    [DateTimeOffset]::Parse($p.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'stale_group_install_plan'}
 GroupInstall-RequireOwner $p.stateRoot
 GroupInstall-PlanScope $p.stateRoot $PlanFile
 if($p.operationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw 'group_install_operation_invalid'}
 $expectedRelease=Join-Path ([Environment]::GetFolderPath('UserProfile')) ('.ai-control-center/releases/codex-continuity/group-owner-'+$p.operationId)
 if([IO.Path]::GetFullPath($p.releaseRoot) -ine [IO.Path]::GetFullPath($expectedRelease)){throw 'release_scope_changed'}
 foreach($relative in $p.files.Keys){if([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)' -or $relative.Contains(':')){throw 'unsafe_release_relative_path'}}
 $state=$p.stateRoot;$file=Join-Path $state 'registrations.json'
 $lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $state
 $fence=$null;$held=@();$taskMutationAttempted=$false;$installedTask=$null;$registryCommitted=$false
 try{
  $cfg=Maintenance-Read $file
  $fence=& $script:PinModule {param($c,$s)Enter-PinMaintenanceFence $c $s} $cfg $state
  if(-not $fence -or (Maintenance-Hash $file) -cne $p.registrySha256){throw 'group_install_registry_cas_changed'}
  $queues=@(Maintenance-Proof $cfg $state)
  $q1=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $queues
  $q2=& $script:PinModule {param($v)Get-PinValueDigest $v} -v @($p.preservedQueues)
  if($q1 -cne $q2){throw 'group_install_preserved_queue_changed'}
  GroupInstall-AssertNoGroupMarkers $state
  $thread=GroupInstall-Thread $p.thread.threadId $p.thread.projectRoot $cfg $state ([string]$p.thread.recoveredCliTransport.evidenceFile)
  $actualThreadDigest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $thread
  $plannedThreadDigest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $p.thread
  if($actualThreadDigest -cne $plannedThreadDigest){throw 'group_thread_preview_changed'}
  $task=GroupInstall-TaskSnapshot $state
  if($task.xmlSha256 -cne $p.taskXmlSha256 -or $task.oldVbsSha256 -cne $p.oldVbsSha256 -or $task.oldVbs -ine $p.oldVbs){throw 'group_task_preview_changed'}
  if((Maintenance-Hash $cfg.codexExecutable) -cne $cfg.codexSha256 -or (Maintenance-Hash $p.nodePath) -cne $p.nodeSha256 -or
     (Maintenance-Hash $p.pwshPath) -cne $p.pwshSha256){throw 'group_runtime_pin_changed'}
  foreach($relative in $p.files.Keys){
   $source=Join-Path $p.sourceRoot $relative
   $held+=,[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
   if((Maintenance-Hash $source) -cne $p.files[$relative]){throw 'group_install_source_changed'}
  }
  $claimed=[IO.File]::Open($PlanFile+'.claimed',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $claimed.Dispose()
  $before=[IO.File]::ReadAllBytes($file);$registryBackup=$PlanFile+'.before-registry.json'
  $bytes=[IO.File]::Open($registryBackup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$bytes.Write($before);$bytes.Flush($true)}finally{$bytes.Dispose()}
  if((Maintenance-Hash $registryBackup) -cne $p.registrySha256){throw 'group_install_preimage_changed'}
  $taskBackup=$PlanFile+'.before-task.xml'
  $writer=[IO.File]::Open($taskBackup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$data=[Text.UTF8Encoding]::new($false).GetBytes($task.xml);$writer.Write($data);$writer.Flush($true)}finally{$writer.Dispose()}
  if((GroupInstall-HashText ([IO.File]::ReadAllText($taskBackup))) -cne $p.taskXmlSha256){throw 'group_task_preimage_changed'}
  if(Test-Path -LiteralPath $p.releaseRoot){throw 'group_immutable_release_exists'}
  New-Item -ItemType Directory -Path $p.releaseRoot -Force|Out-Null
  foreach($relative in $p.files.Keys){
   $dest=Join-Path $p.releaseRoot $relative;New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force|Out-Null
   Copy-Item -LiteralPath (Join-Path $p.sourceRoot $relative) -Destination $dest
   if((Maintenance-Hash $dest) -cne $p.files[$relative]){throw 'group_installed_file_mismatch'}
  }
  $newHelper=Join-Path $p.releaseRoot 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'
  $vbs=Join-Path $p.releaseRoot 'worker.hidden.vbs'
  $workerCommand='"'+$p.pwshPath+'" -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$newHelper+'" -Action Worker -StateRoot "'+$state+'" -OperationId "'+$p.workerOperationId+'"'
  $sourceVbs='Option Explicit'+[Environment]::NewLine+'Dim shell, result'+[Environment]::NewLine+'Set shell = CreateObject("WScript.Shell")'+[Environment]::NewLine+
    'result = shell.Run("'+$workerCommand.Replace('"','""')+'", 0, True)'+[Environment]::NewLine+'WScript.Quit result'+[Environment]::NewLine
  [IO.File]::WriteAllText($vbs,$sourceVbs,[Text.UTF8Encoding]::new($false))
  $pin=@{schemaVersion=1;route='command-route-r2';nodePath=$p.nodePath;nodeSha256=$p.nodeSha256;
   bridgePath=(Join-Path $p.releaseRoot 'src/codex-strict-continuity-bridge.mjs');bridgeSha256=$p.files['src/codex-strict-continuity-bridge.mjs'];
   routeModulePath=(Join-Path $p.releaseRoot 'src/codex-cli-routes.mjs');routeModuleSha256=$p.files['src/codex-cli-routes.mjs'];
   codexSha256=$cfg.codexSha256;releaseRoot=$p.releaseRoot;files=$p.files}
  $cfg.helperPath=$newHelper;$cfg.helperSha256=$p.files['tools/platform/windows/Invoke-AiccCodexContinuity.ps1']
  $cfg.strictRouteLauncher=$pin
  $id=$p.thread.threadId
  if(-not $p.thread.registered){
   $cfg.threads[$id]=@{threadId=$id;projectRoot=$p.thread.projectRoot;rollout=$p.thread.rollout;
    title='Registered group-owner continuation';enabled=$false;state='DISABLED';attempt=$null;queueAttempt=$null;
    ownerPid=$null;ownerCreatedAt=$null;nextCheckAt=[DateTimeOffset]::UtcNow.ToString('o')}
  }
  $e=$cfg.threads[$id];$e.enabled=$false;$e.strictAccount=2;$e.groupOwnerOnly=$true
  if($p.thread.recoveredCliTransport){$e.recoveredCliTransport=$p.thread.recoveredCliTransport}
  $e.groupOwnerRevision=$p.ownerRevision;$e.groupStopEpoch=$p.stopEpoch;$e.groupWorkerOperationId=$p.workerOperationId
  $e.groupEvent=$null
  $updatedTaskXml=GroupInstall-TaskXml $task.xml $vbs $p.releaseRoot $task.wscript
  # The stop fence and worker lock remain in force across the Task change.
  # Register-ScheduledTask does not launch it; old triggers/identity are copied.
  $taskMutationAttempted=$true
  Register-ScheduledTask -TaskName $p.taskName -Xml $updatedTaskXml -Force -ErrorAction Stop|Out-Null
  $installedTask=GroupInstall-TaskSnapshot $state
  if($installedTask.oldVbs -ine $vbs -or $installedTask.oldVbsSha256 -cne (Maintenance-Hash $vbs) -or
     $installedTask.oldTaskState -cne 'Disabled'){throw 'group_task_disabled_readback_hold'}
  if((Maintenance-Hash $file) -cne $p.registrySha256){throw 'group_registry_before_commit_changed'}
  $temp=$file+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temp,($cfg|ConvertTo-Json -Depth 25)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temp,$file,$true)
  $registryCommitted=$true
  $afterSha=Maintenance-Hash $file
  $readback=Maintenance-Read $file
  if($readback.helperSha256 -cne $cfg.helperSha256 -or $readback.workerStopRequestedAt -cne $cfg.workerStopRequestedAt -or
     $readback.threads[$id].groupOwnerOnly -cne $true){throw 'group_registry_readback_hold'}
  $receipt=@{schemaVersion=1;kind='aicc-group-owner-install-receipt';state='INSTALLED_STOPPED';operationId=$p.operationId;
   planSha256=(Maintenance-Hash $PlanFile);preservedQueues=@($p.preservedQueues);
   beforeRegistrySha256=$p.registrySha256;afterRegistrySha256=$afterSha;beforeTaskSha256=$p.taskXmlSha256;
   afterTaskSha256=$installedTask.xmlSha256;beforeRegistryFile=$registryBackup;beforeTaskFile=$taskBackup;
   workerStarted=$false;taskStarted=$false;stopFencePreserved=$true;groupEventCreated=$false;modelRequests=0;
   threadId=$id;releaseRoot=$p.releaseRoot;helperSha256=$cfg.helperSha256;taskName=$p.taskName;runtimeAcceptance='NOT_RUN';
   transport=if($p.thread.recoveredCliTransport){'recovered-cli-v1'}else{'cli-native'}}
  [IO.File]::WriteAllText($PlanFile+'.receipt.json',($receipt|ConvertTo-Json -Depth 14),[Text.UTF8Encoding]::new($false))
  return $receipt
 }catch{
  # Registration may have changed the Task even when the registry remains old.
  # Restore only when our exact post-Task snapshot still matches under the lock.
  if($taskMutationAttempted){
   $partial=@{schemaVersion=1;kind='aicc-group-owner-install-partial';state='PARTIAL_HOLD';
    operationId=$p.operationId;failure=$_.Exception.Message;registryCommitted=$registryCommitted;
    taskRestore='NOT_ATTEMPTED';taskChangedOrUnknown=$true;stopFencePreserved=$true;
    beforeRegistrySha256=$p.registrySha256;beforeTaskSha256=$p.taskXmlSha256;modelRequests=0}
   try{
    if(-not $registryCommitted -and (Maintenance-Hash $file) -ceq $p.registrySha256 -and
       $taskBackup -and (GroupInstall-HashText ([IO.File]::ReadAllText($taskBackup))) -ceq $p.taskXmlSha256){
     $current=GroupInstall-TaskSnapshot $state
     if($current.xmlSha256 -ceq $p.taskXmlSha256){
      $partial.taskRestore='ORIGINAL_UNCHANGED';$partial.taskChangedOrUnknown=$false
     }elseif($installedTask -and $current.xmlSha256 -ceq $installedTask.xmlSha256 -and
             $current.oldTaskState -ceq 'Disabled'){
      Register-ScheduledTask -TaskName $p.taskName -Xml ([IO.File]::ReadAllText($taskBackup)) -Force -ErrorAction Stop|Out-Null
      $restored=GroupInstall-TaskSnapshot $state
      if($restored.xmlSha256 -cne $p.taskXmlSha256 -or $restored.oldTaskState -cne $p.oldTaskState){
       throw 'group_partial_self_restore_readback_hold'
      }
      if((Maintenance-Hash $file) -cne $p.registrySha256){throw 'group_partial_registry_changed_during_restore'}
      $partial.taskRestore='EXACT_SELF_TASK_RESTORED';$partial.taskChangedOrUnknown=$false
     }else{$partial.taskRestore='TASK_CAS_UNKNOWN_HOLD'}
    }else{$partial.taskRestore='REGISTRY_COMMIT_OR_PREIMAGE_CHANGED_HOLD'}
   }catch{$partial.restoreFailure=$_.Exception.Message;$partial.taskRestore='TASK_RESTORE_UNKNOWN_HOLD'}
   try{
    $partialFile=$PlanFile+'.partial.json'
    $out=[IO.File]::Open($partialFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$payload=[Text.UTF8Encoding]::new($false).GetBytes(($partial|ConvertTo-Json -Depth 8)+[Environment]::NewLine);$out.Write($payload);$out.Flush($true)}finally{$out.Dispose()}
   }catch{} # An existing partial receipt is never overwritten.
  }
  throw
 }finally{foreach($h in $held){$h.Dispose()};if($fence){$fence.Dispose()};$lock.Dispose()}
}
function Undo-AiccGroupOwnerInstallPlan{
 param([string]$PlanFile,[string]$Confirm)
 $p=Maintenance-Read $PlanFile
 $receiptFile=$PlanFile+'.receipt.json'
 if(-not(Test-Path -LiteralPath $receiptFile)){throw 'successful_group_install_receipt_required'}
 $r=Maintenance-Read $receiptFile
 GroupInstall-RequireOwner $p.stateRoot
 GroupInstall-PlanScope $p.stateRoot $PlanFile
 if($r.kind -cne 'aicc-group-owner-install-receipt' -or $r.state -cne 'INSTALLED_STOPPED' -or
    $r.operationId -cne $p.operationId -or $r.planSha256 -cne (Maintenance-Hash $PlanFile) -or
    $Confirm -cne ('ROLLBACK GROUP OWNER '+$r.afterRegistrySha256)){throw 'exact_group_rollback_confirmation_required'}
 if(Test-Path -LiteralPath ($PlanFile+'.rollback.json')){throw 'group_rollback_already_consumed'}
 $lock=& $script:PinModule {param($s)Enter-PinRegistryLock $s} $p.stateRoot
 $fence=$null
 try{
  $file=Join-Path $p.stateRoot 'registrations.json';$cfg=Maintenance-Read $file
  $fence=& $script:PinModule {param($c,$s)Enter-PinMaintenanceFence $c $s} $cfg $p.stateRoot
  if(-not $fence -or (Maintenance-Hash $file) -cne $r.afterRegistrySha256){throw 'group_rollback_registry_cas_changed'}
  if($cfg.groupOwner -or $cfg.threads[$r.threadId].groupEvent -or
     @($cfg.threads.Values|Where-Object {$_.attempt -or $_.groupEvent}).Count){throw 'group_claim_or_pending_preserved'}
  if((Maintenance-Hash $r.beforeRegistryFile) -cne $r.beforeRegistrySha256){throw 'group_rollback_registry_preimage_changed'}
  $beforeCfg=Maintenance-Read $r.beforeRegistryFile
  GroupInstall-AssertNoGroupMarkers $p.stateRoot
  GroupInstall-AssertHistoricalQueueCas $p $r $beforeCfg $cfg
  $task=GroupInstall-TaskSnapshot $p.stateRoot
  if($task.xmlSha256 -cne $r.afterTaskSha256 -or $task.oldTaskState -cne 'Disabled'){throw 'group_rollback_task_cas_changed'}
  if((Maintenance-Hash $r.beforeRegistryFile) -cne $r.beforeRegistrySha256 -or
     (GroupInstall-HashText ([IO.File]::ReadAllText($r.beforeTaskFile))) -cne $r.beforeTaskSha256){throw 'group_rollback_preimages_changed'}
  $oneUse=[IO.File]::Open($PlanFile+'.rollback.claimed',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $oneUse.Dispose()
  Register-ScheduledTask -TaskName $r.taskName -Xml ([IO.File]::ReadAllText($r.beforeTaskFile)) -Force -ErrorAction Stop|Out-Null
  $oldTask=GroupInstall-TaskSnapshot $p.stateRoot
  if($oldTask.xmlSha256 -cne $r.beforeTaskSha256 -or $oldTask.oldTaskState -cne $p.oldTaskState){throw 'group_rollback_task_readback_hold'}
  if((Maintenance-Hash $file) -cne $r.afterRegistrySha256){throw 'group_rollback_registry_changed'}
  $temp=$file+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllBytes($temp,[IO.File]::ReadAllBytes($r.beforeRegistryFile))
  [IO.File]::Move($temp,$file,$true)
  if((Maintenance-Hash $file) -cne $r.beforeRegistrySha256){throw 'group_rollback_registry_readback_hold'}
  $out=@{state='ROLLED_BACK_STOPPED';taskRestored=$true;registryRestored=$true;workerStarted=$false;
   immutableReleasePreserved=$true;modelRequests=0;stopFencePreserved=$true}
  [IO.File]::WriteAllText($PlanFile+'.rollback.json',($out|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
  return $out
 }finally{if($fence){$fence.Dispose()};$lock.Dispose()}
}
