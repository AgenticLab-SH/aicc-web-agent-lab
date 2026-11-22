#requires -Version 7.5
[CmdletBinding()]
param([ValidateSet('Preview','Install','Status','RunOnce','Rollback')][string]$Action='Status',[string]$PlanPath,[string]$ReceiptPath)
$ErrorActionPreference='Stop'
$taskName='AgenticLab-AICC-Durable-Scheduler'
$description='AICC bounded local scheduler; upstream review only; no automatic installation'
$owner=[Environment]::GetFolderPath('UserProfile')
$state=Join-Path $owner '.ai-control-center\monitoring\scheduler'
$publicRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
function Hash([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function TextHash([string]$s){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($s))).ToLowerInvariant()}
function Json([string]$p){Get-Content -LiteralPath $p -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function Save([string]$p,$v){[IO.File]::WriteAllText($p,($v|ConvertTo-Json -Depth 14),[Text.UTF8Encoding]::new($false))}
function OwnedTask{
  $t=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if($t -and $t.Description -cne $description){throw 'foreign_scheduler_task_preserved'}
  return $t
}
function TaskState{
  $t=OwnedTask
  if(-not $t){return @{registered=$false;taskName=$taskName}}
  $info=Get-ScheduledTaskInfo -TaskName $taskName
  @{registered=$true;taskName=$taskName;state=[string]$t.State;action=@($t.Actions|Select-Object Execute,Arguments,WorkingDirectory);
    trigger=@($t.Triggers|ForEach-Object {@{type=$_.CimClass.CimClassName;start=$_.StartBoundary;enabled=$_.Enabled;interval=$_.Repetition.Interval}});nextRun=$info.NextRunTime.ToString('o');lastRun=$info.LastRunTime.ToString('o');lastTaskResult=$info.LastTaskResult}
}
if($Action -eq 'Status'){TaskState|ConvertTo-Json -Depth 7;return}
if($Action -eq 'RunOnce'){$null=OwnedTask;Start-ScheduledTask -TaskName $taskName;@{requested=$true;taskName=$taskName;notExecutionProof=$true}|ConvertTo-Json;return}
if($Action -eq 'Preview'){
  $t=OwnedTask;if($t -and $t.State -eq 'Running'){throw 'existing_scheduler_tick_preserved'}
  $node=(Get-Command node.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
  $pwsh=(Get-Process -Id $PID).Path
  $runner=Join-Path $PSScriptRoot 'Invoke-AiccSchedulerTick.ps1'
  $registration=Join-Path $state 'agent-review-registration.json'
  foreach($p in @($node,$pwsh,$runner,$registration)){
    for($cursor=$p;$cursor;$cursor=Split-Path -Parent $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'scheduler_linked_input_refused'}}
    if((Get-Item -LiteralPath $p -Force).PSIsContainer){throw 'scheduler_regular_input_required'}
  }
  $reg=Json $registration
  if(-not $reg.enabled -or $reg.reviewOnly -ne $true -or $reg.automaticApply -ne $false){throw 'authorized_review_registration_required'}
  $previousXml=if($t){Export-ScheduledTask -TaskName $taskName}else{$null}
  $plan=@{schema='aicc-windows-scheduler-plan/v1';taskName=$taskName;description=$description;node=$node;nodeSha256=Hash $node;pwsh=$pwsh;pwshSha256=Hash $pwsh;
    runner=$runner;runnerSha256=Hash $runner;registration=$registration;registrationSha256=Hash $registration;repositoryRoot=$publicRoot;
    previousXml=$previousXml;previousXmlSha256=if($previousXml){TextHash $previousXml}else{$null};sourceSha256=Hash $PSCommandPath;
    userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;intervalMinutes=30;automaticApply=$false;scope='upstream-review';createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
  $plans=Join-Path $state 'windows-task';New-Item -ItemType Directory -Path $plans -Force|Out-Null
  $file=Join-Path $plans ('plan-'+[guid]::NewGuid().ToString('N')+'.json');Save $file $plan
  @{preview=$true;planPath=$file;planSha256=Hash $file;taskName=$taskName;intervalMinutes=30;scope=$plan.scope;automaticApply=$false}|ConvertTo-Json;return
}
if($Action -eq 'Rollback'){
  if(-not $ReceiptPath){throw 'exact_scheduler_receipt_required'};$r=Json $ReceiptPath
  if($r.schema -cne 'aicc-windows-scheduler-receipt/v1' -or $r.taskName -cne $taskName){throw 'scheduler_receipt_scope_invalid'}
  $t=OwnedTask;if($t.State -eq 'Running'){throw 'scheduler_active_tick_preserved'}
  if((TextHash (Export-ScheduledTask -TaskName $taskName)) -cne $r.installedXmlSha256){throw 'scheduler_foreign_edit_preserved'}
  if($r.previousXml){Register-ScheduledTask -TaskName $taskName -Xml $r.previousXml -Force|Out-Null}else{Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
  @{rolledBack=$true;taskName=$taskName;previousTaskRestored=[bool]$r.previousXml}|ConvertTo-Json;return
}
if(-not $PlanPath){throw 'fresh_scheduler_plan_required'}
$installerLock=[IO.File]::Open((Join-Path $state 'scheduler-install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
$plan=Json $PlanPath
if($plan.schema -cne 'aicc-windows-scheduler-plan/v1' -or $plan.taskName -cne $taskName -or $plan.sourceSha256 -cne (Hash $PSCommandPath) -or
  ([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($plan.createdAt)).TotalMinutes -gt 15){throw 'scheduler_plan_stale_or_changed'}
foreach($pin in @(@($plan.node,$plan.nodeSha256),@($plan.pwsh,$plan.pwshSha256),@($plan.runner,$plan.runnerSha256),@($plan.registration,$plan.registrationSha256))){if((Hash $pin[0]) -cne $pin[1]){throw 'scheduler_input_changed'}}
$t=OwnedTask;if($t -and $t.State -eq 'Running'){throw 'scheduler_active_tick_preserved'}
$currentXml=if($t){Export-ScheduledTask -TaskName $taskName}else{$null}
if($currentXml -cne $plan.previousXml){throw 'scheduler_task_changed_since_preview'}
$claim=[IO.File]::Open(($PlanPath+'.claim'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);$claim.Dispose()
$releaseKey=TextHash (($plan.runnerSha256,$plan.node,$plan.pwsh,$publicRoot) -join '|')
$release=Join-Path $state ('windows-task\'+$releaseKey.Substring(0,16));New-Item -ItemType Directory -Path $release -Force|Out-Null
$runner=Join-Path $release 'Invoke-AiccSchedulerTick.ps1';if(Test-Path -LiteralPath $runner){if((Hash $runner) -cne $plan.runnerSha256){throw 'scheduler_release_changed'}}else{Copy-Item -LiteralPath $plan.runner -Destination $runner}
function Vbs([string]$s){$s.Replace('"','""')}
$command='"'+$plan.pwsh+'" -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$runner+'" -NodePath "'+$plan.node+'" -RepositoryRoot "'+$publicRoot+'"'
$launcher=Join-Path $release 'scheduler.vbs'
$body='Set shell = CreateObject("WScript.Shell")'+"`r`n"+'shell.Run "'+(Vbs $command)+'", 0, True'+"`r`n"
if(Test-Path -LiteralPath $launcher){if([IO.File]::ReadAllText($launcher) -cne $body){throw 'scheduler_launcher_changed'}}else{[IO.File]::WriteAllText($launcher,$body,[Text.UTF8Encoding]::new($false))}
$taskAction=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument ('/b /nologo "'+$launcher+'"') -WorkingDirectory $publicRoot
$logon=New-ScheduledTaskTrigger -AtLogOn -User $plan.userSid
$timer=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId $plan.userSid -LogonType Interactive -RunLevel Limited
$receipt=Join-Path (Split-Path $PlanPath -Parent) ('receipt-'+[guid]::NewGuid().ToString('N')+'.json')
try{
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($logon,$timer) -Settings $settings -Principal $principal -Description $description -Force|Out-Null
  $installed=OwnedTask
  if(@($installed.Actions).Count -ne 1 -or $installed.Actions[0].Arguments -cne $taskAction.Arguments -or $installed.Actions[0].Execute -ine $taskAction.Execute){throw 'scheduler_poststate_mismatch'}
  Save $receipt @{schema='aicc-windows-scheduler-receipt/v1';taskName=$taskName;planPath=$PlanPath;previousXml=$currentXml;installedXmlSha256=TextHash (Export-ScheduledTask -TaskName $taskName);at=[DateTimeOffset]::UtcNow.ToString('o');automaticApply=$false;status=(TaskState)}
}catch{
  $candidate=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if($candidate.Description -ceq $description -and $candidate.Actions[0].Arguments -ceq $taskAction.Arguments){
    if($currentXml){Register-ScheduledTask -TaskName $taskName -Xml $currentXml -Force|Out-Null}else{Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
  }
  throw
}
@{installed=$true;receiptPath=$receipt;status=(TaskState)}|ConvertTo-Json -Depth 8
}finally{$installerLock.Dispose()}
