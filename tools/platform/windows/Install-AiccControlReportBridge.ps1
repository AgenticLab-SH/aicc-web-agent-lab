#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$TaskId,[Parameter(Mandatory)][string]$ProjectKey,[switch]$Update)
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$state=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$notifications=Join-Path $state 'notifications'
$schedulerFile=Join-Path $notifications 'process-due-scheduler.json'
$before=[IO.File]::ReadAllBytes($schedulerFile)
$scheduler=[Text.Encoding]::UTF8.GetString($before)|ConvertFrom-Json -AsHashtable
function Hash([string]$File){(Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant()}
if($TaskId -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $ProjectKey -cnotmatch '^[a-z0-9][a-z0-9-]{1,79}$'){throw 'Exact authorized reporting scope required'}
$task=Get-ScheduledTask -TaskName $scheduler.taskName
if($task.State -ne 'Ready' -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32\wscript.exe') -or
 $task.Actions[0].Arguments -cne ('/b /nologo "'+$scheduler.launcher+'"')){throw 'Registered sender busy or changed'}
foreach($pin in @(@{file=$scheduler.node;sha=$scheduler.nodeSha256},@{file=$scheduler.cli;sha=$scheduler.cliSha256},@{file=$scheduler.launcher;sha=$scheduler.launcherSha256})){
 if((Hash $pin.file) -cne $pin.sha){throw 'Registered sender pin changed'}
}
$configFile=Join-Path $notifications 'control-report-bridge.json'
$existingConfig=$null
if(Test-Path -LiteralPath $configFile){
 if(-not $Update -or -not $scheduler.controlReportBridge){throw 'Existing bridge must be reconciled; no duplicate installation'}
 $existingConfig=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json -AsHashtable
 if(@($existingConfig.workers|Where-Object {$_.taskId -cne $TaskId -or $_.projectKey -cne $ProjectKey}).Count){throw 'Existing bridge scope differs'}
}
$files=@('tools/platform/codex/process-report-notifications.mjs','src/notifications/control-report-bridge.mjs','src/control-plane/report-store.mjs','src/notifications/outbox-service.mjs','src/notification-policy.mjs','src/lib/redact.mjs','src/jobs/durable-store.mjs')
$pins=[ordered]@{};foreach($relative in $files){$pins[$relative]=Hash (Join-Path $source $relative)}
$bytes=[Text.Encoding]::UTF8.GetBytes(($pins|ConvertTo-Json -Compress))
$releaseId=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant().Substring(0,16)
$release=Join-Path $notifications ('report-bridge-releases\'+$releaseId)
if(Test-Path -LiteralPath $release){throw 'Prior release exists; reconcile before retry'}
foreach($relative in $files){
 $destination=Join-Path $release $relative
 [IO.Directory]::CreateDirectory((Split-Path $destination -Parent))|Out-Null
 Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $destination
 if((Hash $destination) -cne $pins[$relative]){throw 'Reporting candidate changed'}
}
$utf=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $release 'report-bridge-manifest.json'),(@{schemaVersion=1;files=$pins}|ConvertTo-Json -Depth 4),$utf)
$backup=Join-Path $state ('backups\control-report-bridge-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff'))
[IO.Directory]::CreateDirectory($backup)|Out-Null
[IO.File]::WriteAllBytes((Join-Path $backup 'scheduler.json'),$before)
Copy-Item -LiteralPath $scheduler.launcher -Destination (Join-Path $backup 'process-due-hidden.vbs')
if($existingConfig){Copy-Item -LiteralPath $configFile -Destination (Join-Path $backup 'control-report-bridge.json')}
Export-ScheduledTask -TaskName $scheduler.taskName|Set-Content -LiteralPath (Join-Path $backup 'task.xml') -Encoding utf8
$config=@{schemaVersion=1;enabled=$true;enabledAt=[DateTime]::UtcNow.ToString('o');workers=@(
 @{workerId='central-controller';projectKey=$ProjectKey;taskId=$TaskId;label='개발 종합'},
 @{workerId='g1-controller';projectKey=$ProjectKey;taskId=$TaskId;label='G1 자동재개'},
 @{workerId='g3-controller';projectKey=$ProjectKey;taskId=$TaskId;label='G3 앱·통합관제'},
 @{workerId='g2-controller';projectKey=$ProjectKey;taskId=$TaskId;label='G2 자동매매'},
 @{workerId='g4-controller';projectKey=$ProjectKey;taskId=$TaskId;label='G4 기존 개발'})}
if($existingConfig){$config=$existingConfig}
$runner=Join-Path $release 'tools/platform/codex/process-report-notifications.mjs'
$vbs="Set shell = CreateObject(""WScript.Shell"")`r`nshell.CurrentDirectory = ""$($scheduler.root)""`r`nshell.Run """"""$($scheduler.node)"""" """"$runner"""""", 0, True`r`n"
if((Hash $schedulerFile) -cne ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($before)).ToLowerInvariant()) -or (Get-ScheduledTask -TaskName $scheduler.taskName).State -ne 'Ready'){throw 'Sender changed before installation'}
try{
 [IO.File]::WriteAllText($configFile,($config|ConvertTo-Json -Depth 6),$utf)
 [IO.File]::WriteAllText($scheduler.launcher,$vbs,$utf)
 $scheduler.launcherSha256=Hash $scheduler.launcher
 $scheduler.controlReportBridge=@{releaseRoot=$release;manifestSha256=(Hash (Join-Path $release 'report-bridge-manifest.json'));configFile=$configFile;backup=$backup}
 [IO.File]::WriteAllText($schedulerFile,($scheduler|ConvertTo-Json -Depth 6),$utf)
}catch{
 Copy-Item -LiteralPath (Join-Path $backup 'process-due-hidden.vbs') -Destination $scheduler.launcher -Force
 [IO.File]::WriteAllBytes($schedulerFile,$before)
 throw
}
@{state='INSTALLED_EXISTING_SCHEDULER';release=$release;backup=$backup;taskName=$scheduler.taskName;newTask=$false;modelCalls=0}|ConvertTo-Json
