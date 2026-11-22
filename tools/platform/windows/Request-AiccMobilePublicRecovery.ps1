#requires -Version 7.5
[CmdletBinding()]param(
 [ValidateSet('StartProbe','Signal','Status')][string]$Action='Status',
 [string]$PlanFile,[ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPlanSha256,
 [string]$RequestFile,[ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedRequestSha256,
 [ValidateSet('probe','arm','restore','close','arm-original','restore-original')][string]$Signal='probe',
 [ValidateRange(1,20)][int]$Sequence=1,
 [switch]$StoppedOriginal,[string]$ExpectedTaskXmlSha256,[guid]$RollbackOperationId,[string]$ActivationReceiptSha256,[guid]$CandidateStopOperationId
)
$ErrorActionPreference='Stop'
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
Import-Module (Join-Path $PSScriptRoot 'MobilePublicRecovery.psm1') -Force
$hash={param($f)(Get-FileHash -LiteralPath $f).Hash.ToLowerInvariant()}
function WriteNew($f,$v){$tmp=$f+'.'+[guid]::NewGuid().ToString('N')+'.tmp';$s=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$b=[Text.UTF8Encoding]::new($false).GetBytes(($v|ConvertTo-Json -Depth 12));$s.Write($b);$s.Flush($true)}finally{$s.Dispose()};[IO.File]::Move($tmp,$f,$false)}
function Regular($f,$root){$full=(Resolve-Path -LiteralPath $f).Path;if(-not $full.StartsWith(([IO.Path]::GetFullPath($root).TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'recovery_request_boundary_invalid'};for($p=$full;$p;$p=Split-Path -Parent $p){if((Get-Item -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'recovery_request_link_denied'};if((Split-Path -Parent $p) -eq $p){break}};return $full}
if($Action -eq 'StartProbe'){
 $planFile=Regular $PlanFile (Join-Path $owner 'backups');if((& $hash $planFile) -cne $ExpectedPlanSha256){throw 'recovery_plan_pin_changed'}
 $plan=Get-Content -LiteralPath $planFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 if($plan.state -cne 'ASSEMBLED_NOT_APPLIED' -or $plan.lifecycleTransition.contractVersion -ne 1){throw 'recovery_lifecycle_plan_required'}
 $config=Regular $plan.runtimeConfig (Join-Path $owner 'control-plane/mobile-public-runtime');if((& $hash $config) -cne $plan.runtimeConfigSha256){throw 'recovery_original_config_changed'}
 $cfg=Get-Content -LiteralPath $config -Raw|ConvertFrom-Json -AsHashtable
 $statusFile=Regular $cfg.statusFile (Join-Path $owner 'runtime/mobile-public-control');$status=Get-Content -LiteralPath $statusFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 if(($status.state -cne 'LISTENING' -and -not ($StoppedOriginal -and $status.state -ceq 'NORMAL_STOPPED')) -or $status.runtimeId -cne $cfg.runtimeId -or $status.releaseManifestSha256 -cne $cfg.releaseManifestSha256){throw 'recovery_current_owner_required'}
 $runtime=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$status.pid) -ErrorAction Stop
 if(-not $StoppedOriginal -and (-not $runtime -or $runtime.ExecutablePath -ine $cfg.nodeExecutable -or -not $runtime.CommandLine.Contains($config) -or -not $runtime.CommandLine.Contains('mobile-public-runner.mjs'))){throw 'recovery_current_process_required'}
 $task=Get-ScheduledTask -TaskName 'AgenticLab-AICC-Mobile-Public-Control' -TaskPath '\' -ErrorAction Stop
 if(@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $env:WINDIR 'System32/wscript.exe')){throw 'recovery_exact_task_required'}
 $taskXml=Export-ScheduledTask -InputObject $task -ErrorAction Stop
 $taskHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($taskXml))).ToLowerInvariant()
 $regFile=Regular (Join-Path $owner 'control-plane/mobile-public-recovery/current.json') (Join-Path $owner 'control-plane/mobile-public-recovery');$registry=Get-Content -LiteralPath $regFile -Raw|ConvertFrom-Json
 $manifest=Regular $registry.manifestFile (Join-Path $owner 'releases/mobile-public-recovery')
 if((& $hash $manifest) -cne $registry.manifestSha256){throw 'recovery_install_pin_changed'}
 $entry=Regular $registry.entry (Split-Path -Parent $manifest)
 $pin=@((Get-Content -LiteralPath $manifest -Raw|ConvertFrom-Json).files|Where-Object path -CEQ 'tools/platform/workspace-mcp/Watch-AiccHostRuntimeRecovery.ps1')
 if($pin.Count -ne 1 -or (& $hash $entry) -cne $pin[0].sha256){throw 'recovery_entry_changed'}
 $dir=Join-Path (Split-Path -Parent $planFile) ('recovery-link-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $dir|Out-Null
 $backup=Join-Path $dir 'public-task.before.xml';[IO.File]::WriteAllText($backup,$taskXml,[Text.UTF8Encoding]::new($false))
 $req=@{schemaVersion=1;action='bounded-mobile-lifecycle-recovery';target=$task.TaskName;operationId=$plan.operationId;planFile=$planFile;planSha256=$ExpectedPlanSha256;taskXmlSha256=$taskHash;taskBackup=$backup;stopOperationId=[guid]::NewGuid().ToString();nonce=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant();runtimePid=$runtime.ProcessId;supervisorPid=$runtime.ParentProcessId;callerPid=$PID;createdAt=[DateTimeOffset]::UtcNow.ToString('o');expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(2).ToString('o')}
 if($StoppedOriginal){if($runtime){throw 'stopped_original_process_present'};$req.stoppedOriginal=$true;$req.runtimePid=[int]$status.pid;$req.supervisorPid=0;$req.stopOperationId=$status.lastOperationId;$req.statusSha256=& $hash $statusFile; Assert-MobileStoppedOriginal $plan $req $taskHash | Out-Null}
 $preflightFile=Join-Path (Split-Path -Parent $planFile) 'installer-preflight.json'
 if(-not $StoppedOriginal -and (Test-Path -LiteralPath $preflightFile)){
  $pre=Get-Content -LiteralPath $preflightFile -Raw|ConvertFrom-Json
  if($pre.planSha256 -cne $ExpectedPlanSha256 -or $pre.operationId -cne $plan.operationId){throw 'request_preflight_scope_changed'}
  $installer=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$pre.installerPid) -ErrorAction Stop
  if(-not $installer){throw 'request_preflight_process_absent'}
  $req.installerPid=$installer.ProcessId;$req.installerCreatedAt=$installer.CreationDate.ToUniversalTime().ToString('o')
  $req.installerCommandSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($installer.CommandLine))).ToLowerInvariant()
  $req.preflightSha256=& $hash $preflightFile
 }
 $recoveryPreflight=Join-Path (Split-Path -Parent $planFile) 'recovery-preflight.json'
 if(Test-Path -LiteralPath $recoveryPreflight){
  $rp=Get-Content -LiteralPath $recoveryPreflight -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  if($rp.operationId -cne $plan.operationId){throw 'request_restore_scope_changed'}
  $restoreProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$rp.restorePid) -ErrorAction Stop
  Assert-MobileRecoveryRestoreIdentity $restoreProcess $rp $ExpectedPlanSha256 (Get-Process -Id $PID).Path
  $req.recoveryPreflightSha256=& $hash $recoveryPreflight
 }
 $requestFile=Join-Path $dir 'request.json';WriteNew $requestFile $req;$ExpectedRequestSha256=& $hash $requestFile
 $psi=[Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path);$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 foreach($arg in @('-NoProfile','-NonInteractive','-File',$entry,'-Mode','Watch','-MobilePublicRecovery','-RequestFile',$requestFile,'-ExpectedRequestSha256',$ExpectedRequestSha256)){$psi.ArgumentList.Add($arg)}
 $worker=[Diagnostics.Process]::Start($psi)
 # stdout is not used as READY. Actual bound response files plus live PID are required.
 $deadline=[DateTimeOffset]::UtcNow.AddSeconds(20);$started=Join-Path $dir 'worker-started.json'
 while(-not(Test-Path -LiteralPath $started)){
  if($worker.HasExited){$errorText=$worker.StandardError.ReadToEnd();WriteNew (Join-Path $dir 'launch-failure.json') @{exitCode=$worker.ExitCode;diagnostic=$errorText};throw 'recovery_worker_start_failed'}
  if([DateTimeOffset]::UtcNow -gt $deadline){throw 'recovery_worker_start_unknown_no_replay'};Start-Sleep -Milliseconds 100
 }
 $start=$null
 do{
  try{$start=Get-Content -LiteralPath $started -Raw|ConvertFrom-Json -ErrorAction Stop}catch{$start=$null}
  if($start.workerPid -eq $worker.Id -and $start.requestSha256 -ceq $ExpectedRequestSha256){break}
  if($worker.HasExited -or [DateTimeOffset]::UtcNow -gt $deadline){throw 'recovery_worker_identity_mismatch'}
  Start-Sleep -Milliseconds 50
 }while($true)
 $Signal='probe';$Sequence=1
}else{
 $requestFile=Regular $RequestFile (Join-Path $owner 'backups');if((& $hash $requestFile) -cne $ExpectedRequestSha256){throw 'recovery_request_pin_changed'}
 $req=Get-Content -LiteralPath $requestFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String;$dir=Split-Path -Parent $requestFile
}
if($Action -ne 'Status'){
 $command=@{action=$Signal;operationId=$req.operationId;nonce=$req.nonce;requestSha256=$ExpectedRequestSha256}
 if($Signal -in @('arm','restore','arm-original','restore-original')){$command.expectedTaskXmlSha256=$ExpectedTaskXmlSha256}
 if($Signal -eq 'arm'){$command.stopOperationId=$req.stopOperationId}
 if($Signal -eq 'restore'){$command.rollbackOperationId=$RollbackOperationId.ToString();$command.activationReceiptSha256=$ActivationReceiptSha256;$command.candidateStopOperationId=$CandidateStopOperationId.ToString()}
 Assert-MobileRecoveryCommand $command $req $ExpectedRequestSha256
 WriteNew (Join-Path $dir ('command-'+$Sequence+'.json')) $command
}
$response=Join-Path $dir ('response-'+$Sequence+'.json');$until=[DateTimeOffset]::UtcNow.AddSeconds(20)
while(-not(Test-Path -LiteralPath $response)){
 if($Action -eq 'Status' -or [DateTimeOffset]::UtcNow -gt $until){@{state='RESPONSE_PENDING_NO_REPLAY';requestFile=$requestFile;requestSha256=$ExpectedRequestSha256;responseFile=$response}|ConvertTo-Json -Compress;return};Start-Sleep -Milliseconds 100
}
$v=Get-Content -LiteralPath $response -Raw|ConvertFrom-Json
if($v.operationId -cne $req.operationId -or $v.nonce -cne $req.nonce -or $v.requestSha256 -cne $ExpectedRequestSha256){throw 'recovery_response_binding_invalid'}
@{state=$v.state;requestFile=$requestFile;requestSha256=$ExpectedRequestSha256;responseFile=$response;responseSha256=(& $hash $response);workerPid=$v.workerPid;observedAt=$v.observedAt;expiresAt=$v.expiresAt;mutationCount=$v.mutationCount;readyFile=$v.readyFile;readySha256=$v.readySha256}|ConvertTo-Json -Depth 5
