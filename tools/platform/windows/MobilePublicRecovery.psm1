# Bounded owner-local mobile recovery adapter. No automatic retry, stop or model dispatch.
function Assert-MobileStoppedOriginalEvidence($Plan,$Request,$Status,$Stop,$Claim,$StopHash,$CurrentTaskHash,$ProcessCount,$Instances,$ListenerCount,$CandidateExists,$AttemptExists){
 if($Request.stoppedOriginal -ne $true -or $CurrentTaskHash -cne $Request.taskXmlSha256 -or $CandidateExists -or $AttemptExists -or $ProcessCount -ne 0 -or $Instances -ne 0 -or $ListenerCount -ne 0){throw 'original_stopped_cas_required'}
 if($Status.state -cne 'NORMAL_STOPPED' -or $Status.lastStopResult -cne 'NORMAL_STOP_ACK' -or $Status.runtimeId -cne $Plan.baselineRuntimeId -or $Status.releaseRoot -cne $Plan.baseRoot -or $Status.releaseManifestSha256 -cne $Plan.baseManifestSha256 -or $Status.lastOperationId -cne $Request.stopOperationId -or $Status.pid -ne $Request.runtimePid){throw 'original_normal_ack_required'}
 if($Stop.action -cne 'drain-and-stop' -or $Stop.operationId -cne $Status.lastOperationId -or $Stop.runtimeId -cne $Status.runtimeId -or $Stop.expectedPid -ne $Status.pid -or $Stop.expectedStartedAt -cne $Status.startedAt -or $Stop.releaseManifestSha256 -cne $Status.releaseManifestSha256 -or $Claim.state -cne 'CLAIMED_INPUT_OUTCOME_UNKNOWN' -or $Claim.operationId -cne $Stop.operationId -or $Claim.runtimeId -cne $Stop.runtimeId -or $Claim.pid -ne $Status.pid -or $Claim.requestSha256 -cne $StopHash){throw 'original_stop_claim_required'}
 $at=[DateTimeOffset]::Parse($Claim.at);$end=[DateTimeOffset]::Parse($Stop.expiresAt);$observed=[DateTimeOffset]::Parse($Status.observedAt)
 if($at -lt [DateTimeOffset]::Parse($Status.startedAt) -or $at -gt $end -or $at -lt $end.AddSeconds(-60) -or $observed -lt $at -or $observed -gt $end.AddSeconds(30) -or $observed -gt [DateTimeOffset]::UtcNow){throw 'original_stop_time_required'}
 if($Status.drain.accepted -ne $true -or $Status.drain.activeApiRequests -ne 0 -or $Status.drain.mutationBusy -ne $false -or $Status.drain.pendingOutcomes -ne 0 -or $Status.drain.deviceTrustPreserved -ne $true){throw 'original_idle_drain_required'}
}
function Assert-MobileStoppedOriginal($Plan,$Request,$TaskHash){
 $owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
 $config=Read-MobileRecoveryFile $Plan.runtimeConfig (Join-Path $owner 'control-plane/mobile-public-runtime')
 if((Get-MobileRecoveryHash $config) -cne $Plan.runtimeConfigSha256){throw 'original_config_changed'}
 $cfg=Get-Content -LiteralPath $config -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $statusFile=Read-MobileRecoveryFile $cfg.statusFile (Join-Path $owner 'runtime/mobile-public-control')
 if((Get-MobileRecoveryHash $statusFile) -cne $Request.statusSha256){throw 'original_stopped_status_changed'}
 $status=Get-Content -LiteralPath $statusFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $dir=Join-Path (Split-Path -Parent $config) ('stop-requests/'+$Request.stopOperationId)
 $stopFile=Read-MobileRecoveryFile (Join-Path $dir 'request.json') $dir;$claimFile=Read-MobileRecoveryFile (Join-Path $dir 'claim.json') $dir
 $stop=Get-Content -LiteralPath $stopFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String;$claim=Get-Content -LiteralPath $claimFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $processes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='pwsh.exe' OR Name='powershell.exe' OR Name='wscript.exe' OR Name='cscript.exe'" -ErrorAction Stop)
 if(@($processes|Where-Object {-not $_.CommandLine}).Count){throw 'original_process_inventory_unknown'}
 $count=@($processes|Where-Object {$_.ProcessId -ne $PID -and ($_.CommandLine.Contains($config,[StringComparison]::OrdinalIgnoreCase) -or $_.CommandLine.Contains('mobile-public-runner.mjs',[StringComparison]::OrdinalIgnoreCase) -or $_.CommandLine.Contains('Start-AiccMobilePublicRuntime.ps1',[StringComparison]::OrdinalIgnoreCase))}).Count
 $task=Get-ScheduledTask -TaskName $Request.target -TaskPath '\' -ErrorAction Stop
 if([string]$task.State -cne 'Ready' -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $env:WINDIR 'System32/wscript.exe')){throw 'original_task_not_ready'}
 $match=[regex]::Match([string]$task.Actions[0].Arguments,'^/b /nologo "(?<path>[^"\r\n]+\.vbs)"$');if(-not $match.Success){throw 'original_launcher_required'}
 $launcher=Read-MobileRecoveryFile $match.Groups['path'].Value (Join-Path $owner 'backups');$text=[IO.File]::ReadAllText($launcher)
 $command='"'+(Get-Process -Id $PID).Path+'" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $cfg.releaseRoot 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1')+'" -ConfigFile "'+$config+'" -ExpectedConfigSha256 '+$Plan.runtimeConfigSha256
 $compact="Option Explicit`r`nDim shell`r`nSet shell = CreateObject(""WScript.Shell"")`r`nWScript.Quit shell.Run("""+$command.Replace('"','""')+""",0,True)`r`n"
 if(@($compact,$compact.Replace(',0,True)',', 0, True)')) -cnotcontains $text){throw 'original_launcher_changed'}
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$instances=$scheduler.GetFolder('\').GetTask($Request.target).GetInstances(0).Count
 $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -EQ 4383)
 $op=Split-Path -Parent $Request.planFile
 Assert-MobileStoppedOriginalEvidence $Plan $Request $status $stop $claim (Get-MobileRecoveryHash $stopFile) $TaskHash $count $instances $listeners.Count (Test-Path -LiteralPath $Plan.futureConfigPath) (Test-Path -LiteralPath (Join-Path $op 'activation-attempt.json'))
 foreach($item in @(Get-ChildItem -LiteralPath (Join-Path $owner 'status-tray/requests') -File -ErrorAction Stop|Where-Object Name -Match '^mobile-[a-f0-9]{32}\.json$')){if((Get-Content -LiteralPath $item.FullName -Raw|ConvertFrom-Json).state -cne 'COMPLETED'){throw 'original_pending_outcome'}}
 return $true
}
function Get-MobileRecoveryHash($File){(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
function Get-MobileRecoveryTextHash($Text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($Text))).ToLowerInvariant()}
function Read-MobileRecoveryFile($File,$Root){
 $full=(Resolve-Path -LiteralPath $File -ErrorAction Stop).Path
 if(-not $full.StartsWith(([IO.Path]::GetFullPath($Root).TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'recovery_boundary_invalid'}
 for($p=$full;$p;$p=Split-Path -Parent $p){$i=Get-Item -LiteralPath $p -Force;if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'recovery_link_refused'};if((Split-Path -Parent $p) -eq $p){break}}
 if((Get-Item -LiteralPath $full).PSIsContainer){throw 'recovery_regular_file_required'}
 return $full
}
function Write-MobileRecoveryRecord($File,$Value){
 $temporary=$File+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 $s=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$b=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 15));$s.Write($b);$s.Flush($true)}finally{$s.Dispose()}
 [IO.File]::Move($temporary,$File,$false)
}
function Assert-MobileRecoveryCommand($Command,$Request,$RequestHash,[DateTimeOffset]$Now=[DateTimeOffset]::UtcNow){
 if(@($Command.Keys|Where-Object {$_ -notin @('action','operationId','nonce','requestSha256','expectedTaskXmlSha256','stopOperationId','rollbackOperationId','activationReceiptSha256','candidateStopOperationId')}).Count -or $Command.action -notin @('probe','arm','restore','close','arm-original','restore-original') -or $Command.operationId -cne $Request.operationId -or $Command.nonce -cne $Request.nonce -or $Command.requestSha256 -cne $RequestHash){throw 'recovery_signal_binding_invalid'}
 if([DateTimeOffset]::Parse($Request.expiresAt) -le $Now){throw 'recovery_request_expired'}
 if($Command.action -in @('arm','restore','arm-original','restore-original') -and $Command.expectedTaskXmlSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'recovery_task_pin_required'}
 if($Command.action -eq 'arm' -and $Command.stopOperationId -cne $Request.stopOperationId){throw 'recovery_stop_operation_changed'}
 if($Command.action -eq 'restore' -and ($Command.activationReceiptSha256 -cnotmatch '^[a-f0-9]{64}$' -or $Command.rollbackOperationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')){throw 'recovery_restore_binding_required'}
}
function New-MobileRecoveryRestoreArguments($Restore,$PlanFile,$PlanHash,$Command,$TaskHash,$ReadyFile,$ReadyHash,[bool]$StartAttempted){
 if($PlanHash -cnotmatch '^[a-f0-9]{64}$' -or $TaskHash -cnotmatch '^[a-f0-9]{64}$' -or $ReadyHash -cnotmatch '^[a-f0-9]{64}$' -or $Command.activationReceiptSha256 -cnotmatch '^[a-f0-9]{64}$' -or $Command.rollbackOperationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw 'restore_argument_pin_required'}
 $result=@('-NoProfile','-NonInteractive','-File',$Restore,'-PlanFile',$PlanFile,'-ExpectedPlanSha256',$PlanHash,'-ExpectedActivationReceiptSha256',$Command.activationReceiptSha256,'-ExpectedCurrentTaskXmlSha256',$TaskHash,'-RollbackOperationId',$Command.rollbackOperationId,'-RecoveryReadyFile',$ReadyFile,'-ExpectedRecoveryReadySha256',$ReadyHash,'-RestoreStoppedService')
 if($StartAttempted){if($Command.candidateStopOperationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $Command.candidateStopOperationId -ceq [guid]::Empty.ToString()){throw 'restore_candidate_stop_required'};$result+=@('-CandidateStopOperationId',$Command.candidateStopOperationId)}
 return ,$result
}
function Assert-MobileRecoveryInstallerIdentity($Installer,$Request,$PreflightHash,$Executable){
 if(-not $Installer -or $Installer.ProcessId -ne $Request.installerPid -or $Installer.CreationDate.ToUniversalTime().ToString('o') -cne $Request.installerCreatedAt -or (Get-MobileRecoveryTextHash $Installer.CommandLine) -cne $Request.installerCommandSha256 -or $PreflightHash -cne $Request.preflightSha256 -or $Installer.ExecutablePath -ine $Executable){throw 'recovery_live_installer_required'}
}
function Assert-MobileRecoveryRestoreIdentity($Process,$Preflight,$PlanHash,$Executable){
 if(-not $Process -or $Preflight.state -cne 'RELEASES_LOCKED_WAITING_FOR_FRESH_RECOVERY' -or $Preflight.planSha256 -cne $PlanHash -or $Process.ProcessId -ne $Preflight.restorePid -or $Process.CreationDate.ToUniversalTime().ToString('o') -cne $Preflight.restoreCreatedAt -or (Get-MobileRecoveryTextHash $Process.CommandLine) -cne $Preflight.restoreCommandSha256 -or $Process.ExecutablePath -ine $Executable -or $Preflight.restoreExecutable -ine $Executable){throw 'recovery_live_locked_restore_required'}
}
function Invoke-AiccMobileRecoveryWorker {
 [CmdletBinding()]param([Parameter(Mandatory)][string]$RequestFile,[Parameter(Mandatory)][string]$ExpectedRequestSha256,[switch]$StatusOnly)
 $ErrorActionPreference='Stop'
 $owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
 $requestPath=Read-MobileRecoveryFile $RequestFile (Join-Path $owner 'backups')
 if((Get-MobileRecoveryHash $requestPath) -cne $ExpectedRequestSha256){throw 'recovery_request_pin_changed'}
 $req=Get-Content -LiteralPath $requestPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 $now=[DateTimeOffset]::UtcNow;$expires=[DateTimeOffset]::Parse($req.expiresAt)
 if($req.schemaVersion -ne 1 -or $req.target -cne 'AgenticLab-AICC-Mobile-Public-Control' -or $req.action -cne 'bounded-mobile-lifecycle-recovery' -or $req.operationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $req.stopOperationId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $req.nonce -cnotmatch '^[a-f0-9]{64}$' -or $expires -le $now -or $expires -gt $now.AddMinutes(5)){throw 'recovery_request_scope_invalid'}
 $planFile=Read-MobileRecoveryFile $req.planFile (Join-Path $owner 'backups')
 if((Get-MobileRecoveryHash $planFile) -cne $req.planSha256){throw 'recovery_plan_changed'}
 $plan=Get-Content -LiteralPath $planFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 if($plan.operationId -cne $req.operationId -or $plan.lifecycleTransition.contractVersion -ne 1 -or $plan.state -cne 'ASSEMBLED_NOT_APPLIED'){throw 'recovery_plan_scope_invalid'}
 $op=Split-Path -Parent $planFile;$dir=Split-Path -Parent $requestPath
 $cfgFile=Read-MobileRecoveryFile $plan.runtimeConfig (Join-Path $owner 'control-plane/mobile-public-runtime')
 if((Get-MobileRecoveryHash $cfgFile) -cne $plan.runtimeConfigSha256){throw 'recovery_config_changed'}
 $cfg=Get-Content -LiteralPath $cfgFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 if($cfg.port -ne 4383 -or $cfg.runtimeId -cne $plan.baselineRuntimeId -or $cfg.releaseRoot -cne $plan.baseRoot){throw 'recovery_config_scope_invalid'}
 $registryFile=Read-MobileRecoveryFile (Join-Path $owner 'control-plane/mobile-public-recovery/current.json') (Join-Path $owner 'control-plane/mobile-public-recovery')
 $registry=Get-Content -LiteralPath $registryFile -Raw|ConvertFrom-Json -AsHashtable
 $release=Read-MobileRecoveryFile $registry.manifestFile (Join-Path $owner 'releases/mobile-public-recovery')
 if((Get-MobileRecoveryHash $release) -cne $registry.manifestSha256){throw 'recovery_install_manifest_changed'}
 $manifest=Get-Content -LiteralPath $release -Raw|ConvertFrom-Json -AsHashtable
 $held=[Collections.Generic.List[IDisposable]]::new()
 try{
 foreach($pin in $manifest.files){$f=Read-MobileRecoveryFile (Join-Path (Split-Path -Parent $release) $pin.path) (Split-Path -Parent $release);$stream=[IO.File]::Open($f,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$held.Add($stream);if((Get-MobileRecoveryHash $f) -cne $pin.sha256){throw 'recovery_installed_file_changed'}}
 if([IO.Path]::GetFullPath($PSCommandPath) -ine (Join-Path (Split-Path -Parent $release) 'tools/platform/windows/MobilePublicRecovery.psm1') -or (Get-MobileRecoveryHash $PSCommandPath) -cne $manifest.moduleSha256){throw 'recovery_installed_module_required'}
 if((Get-MobileRecoveryHash (Join-Path (Split-Path -Parent $release) 'tools/platform/windows/Restore-AiccMobilePublicRuntime.ps1')) -cne $plan.lifecycleTransition.rollbackSha256){throw 'recovery_restore_plan_pin_changed'}
 $task=Get-ScheduledTask -TaskName $req.target -TaskPath '\' -ErrorAction Stop
 $xml=Export-ScheduledTask -InputObject $task -ErrorAction Stop
 if((Get-MobileRecoveryTextHash $xml) -cne $req.taskXmlSha256){throw 'recovery_initial_task_changed'}
 $backup=Read-MobileRecoveryFile $req.taskBackup (Split-Path -Parent $requestPath)
 if((Get-MobileRecoveryHash $backup) -cne $req.taskXmlSha256){throw 'recovery_backup_changed'}
 $self=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID) -ErrorAction Stop
 $ancestry=@();$p=$self
 for($n=0;$p -and $n -lt 24;$n++){
  if($p.ProcessId -in @($req.runtimePid,$req.supervisorPid) -or ([string]$p.CommandLine).Contains('mobile-public-runner.mjs') -or ([string]$p.CommandLine).Contains('Start-AiccMobilePublicRuntime.ps1')){throw 'recovery_depends_on_target_runtime'}
  $ancestry+=@{pid=$p.ProcessId;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')}
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId) -ErrorAction Stop
 }
 if($PID -eq $req.callerPid -or -not ($ancestry.pid -contains $req.callerPid)){throw 'recovery_explicit_launcher_required'}
 if($StatusOnly){@{state='READ_ONLY';operationId=$req.operationId;installed=$true}|ConvertTo-Json -Compress;return}
 $lock=[IO.File]::Open((Join-Path $dir 'worker.lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
 try{
 $executor='mobile-local-process:'+ $PID +':'+$self.CreationDate.ToUniversalTime().Ticks
 Write-MobileRecoveryRecord (Join-Path $dir 'worker-started.json') @{state='WAITING_FOR_EXPLICIT_SIGNAL';operationId=$req.operationId;requestSha256=$ExpectedRequestSha256;workerPid=$PID;createdAt=$self.CreationDate.ToUniversalTime().ToString('o');executorId=$executor;ancestry=$ancestry;expiresAt=$req.expiresAt;automaticRecovery=$false}
 $index=1
 while([DateTimeOffset]::UtcNow -lt $expires){
  $signal=Join-Path $dir ('command-'+$index+'.json')
  if(-not(Test-Path -LiteralPath $signal)){Start-Sleep -Milliseconds 150;continue}
  $signal=Read-MobileRecoveryFile $signal $dir
  $command=Get-Content -LiteralPath $signal -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  Assert-MobileRecoveryCommand $command $req $ExpectedRequestSha256
  Write-MobileRecoveryRecord (Join-Path $dir ('claim-'+$index+'.json')) @{commandSha256=Get-MobileRecoveryHash $signal;at=[DateTimeOffset]::UtcNow.ToString('o');state='CLAIMED_NO_REPLAY'}
  if((Get-MobileRecoveryHash $requestPath) -cne $ExpectedRequestSha256 -or (Get-MobileRecoveryHash $planFile) -cne $req.planSha256 -or (Get-MobileRecoveryHash $cfgFile) -cne $plan.runtimeConfigSha256){throw 'recovery_inputs_changed'}
  $task=Get-ScheduledTask -TaskName $req.target -TaskPath '\' -ErrorAction Stop;$taskHash=Get-MobileRecoveryTextHash (Export-ScheduledTask -InputObject $task -ErrorAction Stop)
  $response=@{state='PROBE_RESPONSE';operationId=$req.operationId;nonce=$req.nonce;requestSha256=$ExpectedRequestSha256;executorId=$executor;workerPid=$PID;independent=$true;observedAt=[DateTimeOffset]::UtcNow.ToString('o');expiresAt=$req.expiresAt;taskXmlSha256=$taskHash;configSha256=Get-MobileRecoveryHash $cfgFile;mutationCount=0;automaticReplay=$false}
  if($command.action -eq 'close'){$response.state='CLOSED_NO_RECOVERY';Write-MobileRecoveryRecord (Join-Path $dir ('response-'+$index+'.json')) $response;return}
  if($command.action -eq 'probe' -and $taskHash -cne $req.taskXmlSha256){throw 'recovery_probe_task_changed'}
    if($command.action -in @('arm-original','restore-original')){
   if($req.stoppedOriginal -ne $true -or $taskHash -cne $command.expectedTaskXmlSha256){throw 'original_recovery_scope_required'}
   $recoveryPre=Read-MobileRecoveryFile (Join-Path $op 'recovery-preflight.json') $op
   $rp=Get-Content -LiteralPath $recoveryPre -Raw|ConvertFrom-Json -AsHashtable -DateKind String
   if((Get-MobileRecoveryHash $recoveryPre) -cne $req.recoveryPreflightSha256){throw 'original_restore_preflight_changed'}
   $restoreProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$rp.restorePid) -ErrorAction Stop
   Assert-MobileRecoveryRestoreIdentity $restoreProcess $rp $req.planSha256 (Get-Process -Id $PID).Path
   $null=Assert-MobileStoppedOriginal $plan $req $taskHash
   if($command.action -eq 'arm-original'){
    $ready=@{schemaVersion=1;status='READY';independent=$true;operationId=$req.operationId;planSha256=$req.planSha256;taskXmlSha256=$taskHash;previousConfigSha256=$plan.runtimeConfigSha256;stopOperationId=$req.stopOperationId;target=$req.target;recoveryAction='start-exact-unmodified-original-after-normal-stop';executorId=$executor;observedAt=[DateTimeOffset]::UtcNow.ToString('o');expiresAt=$req.expiresAt;requestSha256=$ExpectedRequestSha256}
    $tool=Join-Path $dir ('tool-receipt-'+$index+'.json');Write-MobileRecoveryRecord $tool $ready
    $ready.toolReceiptFile=$tool;$ready.toolReceiptSha256=Get-MobileRecoveryHash $tool
    $readyFile=Join-Path $dir ('ready-'+$index+'.json');Write-MobileRecoveryRecord $readyFile $ready
    $response.state='ORIGINAL_RECOVERY_ARMED';$response.readyFile=$readyFile;$response.readySha256=Get-MobileRecoveryHash $readyFile
   }else{
    $armFile=Join-Path $dir ('ready-'+($index-1)+'.json');$armed=Get-Content -LiteralPath $armFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
    if($armed.recoveryAction -cne 'start-exact-unmodified-original-after-normal-stop' -or $armed.requestSha256 -cne $ExpectedRequestSha256 -or $armed.taskXmlSha256 -cne $taskHash -or [DateTimeOffset]::Parse($armed.expiresAt) -le [DateTimeOffset]::UtcNow -or [DateTimeOffset]::Parse($armed.observedAt) -lt [DateTimeOffset]::UtcNow.AddSeconds(-120) -or (Get-MobileRecoveryHash $armed.toolReceiptFile) -cne $armed.toolReceiptSha256){throw 'fresh_original_ready_required'}
    $activationLock=[IO.File]::Open((Join-Path $owner 'control-plane/mobile-public-runtime/activation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try{
     $freshTaskHash=Get-MobileRecoveryTextHash (Export-ScheduledTask -InputObject (Get-ScheduledTask -TaskName $req.target -TaskPath '\' -ErrorAction Stop))
     $null=Assert-MobileStoppedOriginal $plan $req $freshTaskHash
     $once=Join-Path $op 'original-recovery-start-attempt.json'
     Write-MobileRecoveryRecord $once @{state='START_ATTEMPTED_OUTCOME_UNKNOWN';operationId=$req.operationId;requestSha256=$ExpectedRequestSha256;taskXmlSha256=$freshTaskHash;stopOperationId=$req.stopOperationId;startAttempted=$true;automaticReplay=$false;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
     Start-ScheduledTask -TaskName $req.target -TaskPath '\' -ErrorAction Stop
     $response.state='ORIGINAL_START_ACCEPTED_FUNCTION_UNOBSERVED';$response.mutationCount=1
    }finally{$activationLock.Dispose()}
   }
  }
  if($command.action -in @('arm','restore')){
   if($taskHash -cne $command.expectedTaskXmlSha256){throw 'recovery_task_cas_changed'}
   $recoveryPre=Read-MobileRecoveryFile (Join-Path $op 'recovery-preflight.json') $op
   $rp=Get-Content -LiteralPath $recoveryPre -Raw|ConvertFrom-Json -AsHashtable -DateKind String
   if($rp.operationId -cne $req.operationId -or (Get-MobileRecoveryHash $recoveryPre) -cne $req.recoveryPreflightSha256){throw 'recovery_restore_preflight_changed'}
   $restoreProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$rp.restorePid) -ErrorAction Stop
   Assert-MobileRecoveryRestoreIdentity $restoreProcess $rp $req.planSha256 (Get-Process -Id $PID).Path
   if($command.action -eq 'arm'){
    $pre=Read-MobileRecoveryFile (Join-Path $op 'installer-preflight.json') $op;$preflight=Get-Content -LiteralPath $pre -Raw|ConvertFrom-Json -AsHashtable
    if($preflight.operationId -cne $req.operationId -or $preflight.planSha256 -cne $req.planSha256 -or $preflight.state -cne 'CANDIDATE_LOCKED_WAITING_FOR_FRESH_COMMIT'){throw 'recovery_preflight_required'}
    $installer=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$preflight.installerPid) -ErrorAction Stop
    if($installer.ProcessId -eq $PID){throw 'recovery_self_installer_refused'}
    Assert-MobileRecoveryInstallerIdentity $installer $req (Get-MobileRecoveryHash $pre) (Get-Process -Id $PID).Path
    if([DateTimeOffset]::Parse($preflight.observedAt) -gt [DateTimeOffset]::UtcNow){throw 'recovery_preflight_time_invalid'}
   }
   $ready=@{schemaVersion=1;status='READY';independent=$true;operationId=$req.operationId;planSha256=$req.planSha256;taskXmlSha256=$taskHash;previousConfigSha256=$plan.runtimeConfigSha256;stopOperationId=$req.stopOperationId;target=$req.target;recoveryAction='restore-exact-task-after-normal-stop';executorId=$executor;observedAt=[DateTimeOffset]::UtcNow.ToString('o');expiresAt=$req.expiresAt;nonce=$req.nonce;workerPid=$PID;requestSha256=$ExpectedRequestSha256}
   if($command.action -eq 'restore'){
    $activation=Read-MobileRecoveryFile (Join-Path $op 'activation-attempt.json') $op
    if((Get-MobileRecoveryHash $activation) -cne $command.activationReceiptSha256){throw 'recovery_activation_receipt_changed'}
    $receipt=Get-Content -LiteralPath $activation -Raw|ConvertFrom-Json -AsHashtable
    $ready.rollbackOperationId=$command.rollbackOperationId;$ready.activationReceiptSha256=$command.activationReceiptSha256
    if($receipt.startAttempted){$cand=Get-Content -LiteralPath $plan.futureConfigPath -Raw|ConvertFrom-Json -AsHashtable;$ready.previousConfigSha256=$plan.configSha256;$ready.stopOperationId=$command.candidateStopOperationId}else{$ready.stopOperationId='NOT_STARTED'}
   }
   $tool=Join-Path $dir ('tool-receipt-'+$index+'.json');Write-MobileRecoveryRecord $tool $ready
   $ready.toolReceiptFile=$tool;$ready.toolReceiptSha256=Get-MobileRecoveryHash $tool
   $readyFile=Join-Path $dir ('ready-'+$index+'.json');Write-MobileRecoveryRecord $readyFile $ready
   $response.state='ARMED_FOR_EXPLICIT_RECOVERY';$response.readyFile=$readyFile;$response.readySha256=Get-MobileRecoveryHash $readyFile
   if($command.action -eq 'restore'){
    # Full verification already completed under retained OS locks. This fresh
    # one-use command wakes that exact process; never spawn a second verifier.
    $commitPath=[IO.Path]::GetFullPath($rp.commitFile)
    if(-not $commitPath.StartsWith(($op+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'recovery_commit_boundary_invalid'}
    $commit=@{schemaVersion=1;action='restore-exact-stopped-lifecycle';operationId=$req.operationId;planSha256=$req.planSha256;preflightSha256=Get-MobileRecoveryHash $recoveryPre;activationReceiptSha256=$command.activationReceiptSha256;taskXmlSha256=$taskHash;rollbackOperationId=$command.rollbackOperationId;readyFile=$readyFile;readySha256=$response.readySha256}
    if($receipt.startAttempted){$commit.candidateStopOperationId=$command.candidateStopOperationId}
    Write-MobileRecoveryRecord $commitPath $commit
    $response.state='FRESH_RESTORE_COMMIT_SUBMITTED_OUTCOME_UNOBSERVED';$response.childPid=$restoreProcess.ProcessId;$response.mutationCount=$null
    Write-MobileRecoveryRecord (Join-Path $dir ('response-'+$index+'.json')) $response;return
   }
  }
  Write-MobileRecoveryRecord (Join-Path $dir ('response-'+$index+'.json')) $response;$index++
 }
 Write-MobileRecoveryRecord (Join-Path $dir 'expired.json') @{state='EXPIRED_NO_AUTOMATIC_RECOVERY';at=[DateTimeOffset]::UtcNow.ToString('o');operationId=$req.operationId}
 }finally{$lock.Dispose()}
 }catch{
  $message=$_.Exception.Message;$code=if($message -cmatch '^[a-z][a-z0-9_]+$'){$message}else{'recovery_failed_details_not_logged'}
  Write-MobileRecoveryRecord (Join-Path $dir 'worker-failure.json') @{state='HOLD_NO_REPLAY';reason=$code;exceptionType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;operationId=$req.operationId;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
  throw
 }finally{foreach($h in $held){$h.Dispose()}}
}
Export-ModuleMember -Function Assert-MobileStoppedOriginal,Assert-MobileStoppedOriginalEvidence,Invoke-AiccMobileRecoveryWorker,Assert-MobileRecoveryCommand,New-MobileRecoveryRestoreArguments,Assert-MobileRecoveryInstallerIdentity,Assert-MobileRecoveryRestoreIdentity
