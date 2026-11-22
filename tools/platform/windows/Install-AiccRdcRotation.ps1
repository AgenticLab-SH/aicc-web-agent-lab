#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigFile)
$ErrorActionPreference='Stop'
$root=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.desktop-commander-device'
$dir=Join-Path $root 'rotation';New-Item -ItemType Directory -Path $dir -Force|Out-Null
$config=Get-Content -LiteralPath $ConfigFile -Raw|ConvertFrom-Json -AsHashtable
if($config.accounts.Count -ne 3 -or ($config.accounts.profile -join ',') -cne 'account1,account2,account3'){throw 'Explicit ordered three-account owner configuration required'}
$files=@('rdc-managed-agent.mjs','Rdc-ProfileStore.ps1','rdc-chatgpt-connector.mjs','rdc-quota-client.mjs','Invoke-AiccRdcRotation.ps1')
$manifest=[ordered]@{};foreach($name in $files){$manifest[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant()}
$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($manifest|ConvertTo-Json -Compress)))).ToLowerInvariant()
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$release=Join-Path $owner ('releases\rdc-rotation\'+$hash.Substring(0,16));New-Item -ItemType Directory -Path $release -Force|Out-Null
foreach($name in $files){$dest=Join-Path $release $name;if(-not(Test-Path -LiteralPath $dest)){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $dest}}
$backup=Join-Path $dir ('install-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $backup|Out-Null
$oldRuntime=if(Test-Path -LiteralPath (Join-Path $dir 'runtime.json')){Get-Content -LiteralPath (Join-Path $dir 'runtime.json') -Raw|ConvertFrom-Json}else{$null}
$watchers=if($oldRuntime){@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'pwsh.exe' -and $_.CommandLine -and $_.CommandLine.Contains([string]$oldRuntime.entry) -and $_.CommandLine -match '-Action\s+Watch(?:\s|$)'})}else{@()}
if($watchers.Count){
 [IO.File]::WriteAllText((Join-Path $dir 'stop.json'),'{"reason":"rotation-runtime-update"}')
 $deadline=[DateTimeOffset]::UtcNow.AddSeconds(55)
 foreach($w in $watchers){while((Get-Process -Id $w.ProcessId -ErrorAction SilentlyContinue) -and [DateTimeOffset]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 200};if(Get-Process -Id $w.ProcessId -ErrorAction SilentlyContinue){throw 'Previous exact rotation owner still busy; replacement deferred'}}
}
$managedFile=Join-Path $root 'managed-runtime.json';Copy-Item -LiteralPath $managedFile -Destination (Join-Path $backup 'managed-runtime.before.json')
$managed=Get-Content -LiteralPath $managedFile -Raw|ConvertFrom-Json -AsHashtable
$agentChanged=$managed.agentSha256 -cne $manifest['rdc-managed-agent.mjs']
$managed.agent=Join-Path $release 'rdc-managed-agent.mjs';$managed.agentSha256=$manifest['rdc-managed-agent.mjs'];$managed.profileStore=Join-Path $release 'Rdc-ProfileStore.ps1';$managed.profileStoreSha256=$manifest['Rdc-ProfileStore.ps1'];$managed.powershell=$config.powershell
[IO.File]::WriteAllText($managedFile,($managed|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
$cfgPath=Join-Path $dir 'config.json';if(Test-Path -LiteralPath $cfgPath){Copy-Item -LiteralPath $cfgPath -Destination (Join-Path $backup 'config.before.json')}
if(Test-Path -LiteralPath $cfgPath){
 $prior=Get-Content -LiteralPath $cfgPath -Raw|ConvertFrom-Json -AsHashtable
 foreach($account in $config.accounts){$old=@($prior.accounts|Where-Object {$_.profile -ceq $account.profile -and $_.deviceId -ceq $account.deviceId -and $_.userId -ceq $account.userId});if($old.Count -eq 1){$account.linkIds=@(@($old[0].linkId)+@($old[0].linkIds)+@($account.linkId)+@($account.linkIds)|Where-Object {$_}|Select-Object -Unique);if(-not $account.linkId){$account.linkId=$old[0].linkId}}}
}
[IO.File]::WriteAllText($cfgPath,($config|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))
$runtime=@{schemaVersion=1;entry=(Join-Path $release 'Invoke-AiccRdcRotation.ps1');entrySha256=$manifest['Invoke-AiccRdcRotation.ps1'];browserEntry=(Join-Path $release 'rdc-chatgpt-connector.mjs');browserSha256=$manifest['rdc-chatgpt-connector.mjs'];quotaEntry=(Join-Path $release 'rdc-quota-client.mjs');quotaSha256=$manifest['rdc-quota-client.mjs'];node=$managed.node;powershell=$config.powershell;config=$cfgPath;release=$release;backup=$backup}
[IO.File]::WriteAllText((Join-Path $dir 'runtime.json'),($runtime|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$commandDir=Split-Path (Get-Command aicc -ErrorAction Stop).Source -Parent
$wrapper=@('param([ValidateSet(''Start'',''Next'',''Status'',''Quota'',''Observe'',''Confirm'',''Bind'',''Connect'',''Reconcile'',''Stop'')][string]$Action=''Start'',[string]$Profile,[double]$RemainingPercent=100,[string]$ObservedAt,[string]$ConnectorUserId,[string]$DeviceId,[string]$LinkId,[string]$OperationId,[switch]$ReadSucceeded,[switch]$UsageRejected,[switch]$Refresh)','$r=Get-Content -LiteralPath (Join-Path ([Environment]::GetFolderPath(''UserProfile'')) ''.desktop-commander-device\rotation\runtime.json'') -Raw|ConvertFrom-Json','if((Get-FileHash -LiteralPath $r.entry).Hash.ToLowerInvariant() -cne $r.entrySha256){throw ''RDC rotation pin differs''}','& $r.entry @PSBoundParameters') -join [Environment]::NewLine
[IO.File]::WriteAllText((Join-Path $commandDir 'aicc-rdc.ps1'),$wrapper,[Text.UTF8Encoding]::new($false))
if($agentChanged){$restart=& $config.troubleshooter -Action RdcRestart|ConvertFrom-Json;if($restart.ok -cne $true){throw 'Initial managed restart not accepted; inspect before retry'}}
# Keep the owner's existing login launcher and append the pinned controller.
$launcher=Join-Path $root 'launch-remote.ps1'
$launchText=Get-Content -LiteralPath $launcher -Raw
if(-not $launchText.Contains('# AICC-RDC-rotation-autostart')){
 Copy-Item -LiteralPath $launcher -Destination (Join-Path $backup 'launch-remote.before.ps1')
 $launchText+=[Environment]::NewLine+@'
# AICC-RDC-rotation-autostart
$rotationRuntime=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.desktop-commander-device\rotation\runtime.json'
if(Test-Path -LiteralPath $rotationRuntime){
 $rotation=Get-Content -LiteralPath $rotationRuntime -Raw|ConvertFrom-Json
 if((Get-FileHash -LiteralPath $rotation.entry).Hash.ToLowerInvariant() -cne $rotation.entrySha256){throw 'RDC rotation pin differs'}
 Start-Process -FilePath $rotation.powershell -ArgumentList @('-NoProfile','-NonInteractive','-File',('"'+$rotation.entry+'"'),'-Action','Watch') -WindowStyle Hidden|Out-Null
}
'@
 [IO.File]::WriteAllText($launcher,$launchText,[Text.UTF8Encoding]::new($false))
}
& $runtime.entry -Action Start
@{installed=$true;release=$release;command='aicc-rdc';backup=$backup;verificationExecuted=$false}|ConvertTo-Json
