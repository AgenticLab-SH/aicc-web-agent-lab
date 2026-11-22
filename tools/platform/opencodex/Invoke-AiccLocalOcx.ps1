#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Install','Upgrade','RollbackUpgrade','Recover','Status','Rollback')][string]$Action='Status',[string]$PackageRoot,[string]$UpgradeBackup)
$ErrorActionPreference='Stop'
$owner=[Environment]::GetFolderPath('UserProfile')
$homeRoot=Join-Path $owner '.ai-control-center'
$registryPath=Join-Path $homeRoot 'runtime/ocx-local/current.json'
if(Test-Path -LiteralPath $registryPath){
  $registered=Get-Content -LiteralPath $registryPath -Raw|ConvertFrom-Json
  if($registered.PSObject.Properties['adapterManifest']){
    $transition=Join-Path $PSScriptRoot 'Invoke-AiccOcxTransition.ps1'
    switch($Action){
      'Status' { & $transition -Mode Status;return }
      'Recover' { & $transition -Mode Recover;return }
      'RollbackUpgrade' { if(-not $UpgradeBackup){throw 'Exact software-only snapshot required'};& $transition -Mode Rollback -SnapshotPath $UpgradeBackup;return }
      default { throw 'Clean external runtime: fork installer/Native rollback is not applicable. Use a separately accepted supplier release.' }
    }
  }
}
$legacy=Join-Path $owner '.opencodex'
$taskName='opencodex-proxy'
$launcher=Join-Path $legacy 'opencodex-service-launcher.vbs'
$wrapper=Join-Path $legacy 'opencodex-service.cmd'
$statePath=Join-Path $legacy 'service-state.json'
$native=Join-Path $owner '.codex/config.toml'
$bun=Join-Path $owner '.bun/install/global/node_modules/bun/bin/bun.exe'
$tunnelRoot=Join-Path $homeRoot 'oracle-a1-access'
$tunnelTaskName='AICC-A1-Hub-Tunnel'
function TunnelTaskOwner{
  $task=Get-ScheduledTask -TaskName $tunnelTaskName
  $vbs=Join-Path $tunnelRoot 'a1-hub-tunnel-hidden.vbs'
  if($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32/wscript.exe') -or $task.Actions[0].Arguments -cne ('/b /nologo "'+$vbs+'"')){throw 'Tunnel task owner changed.'}
  $task
}
function StopDataTunnel{
  $null=TunnelTaskOwner
  $ports=if(Test-Path $registryPath){@(10102)}else{@(10101,10102)}
  $listeners=@(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 | Where-Object {$_.LocalPort -in $ports})
  $owners=@($listeners.OwningProcess|Select-Object -Unique)
  if($owners.Count -ne 1){throw 'Existing tunnel listener ownership differs.'}
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owners[0])
  if($process.Name -ne 'ssh.exe' -or $process.CommandLine -notmatch 'HostKeyAlias=aicc-oracle-a1' -or $process.CommandLine -notmatch '127\.0\.0\.1:10102:127\.0\.0\.1:10102'){throw 'Management tunnel differs.'}
  Stop-ScheduledTask -TaskName $tunnelTaskName
  foreach($helper in @(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('powershell.exe','wscript.exe') -and $_.CommandLine -and ($_.CommandLine.Contains((Join-Path $tunnelRoot 'keep-a1-hub-tunnel.ps1')) -or $_.CommandLine.Contains((Join-Path $tunnelRoot 'a1-hub-tunnel-hidden.vbs')))})){Stop-Process -Id $helper.ProcessId -Force}
  $fresh=Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.ProcessId)
  if($fresh -and $fresh.CommandLine -ceq $process.CommandLine){Stop-Process -Id $process.ProcessId -Force}
}
function Hash($file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function Regular($file){$item=Get-Item -LiteralPath $file;if($item.PSIsContainer -or $item.LinkType){throw 'Regular owned file required.'}}
function Ready{try{Invoke-RestMethod http://127.0.0.1:10100/readyz -NoProxy -TimeoutSec 3}catch{$null}}
function TaskOwner{
  $task=Get-ScheduledTask -TaskName $taskName
  if($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32/wscript.exe') -or $task.Actions[0].Arguments -cne ('/b /nologo "'+$launcher+'"')){throw 'Registered OCX task changed.'}
  $task
}
function OwnedProcesses($cli){@(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('bun.exe','cmd.exe','wscript.exe') -and $_.CommandLine -and ($_.CommandLine.Contains($cli) -or $_.CommandLine.Contains($wrapper) -or $_.CommandLine.Contains($launcher))})}
function ProtectedDependencies {
  # This recovery plane must remain usable when the model route is unavailable.
  $componentsFile=Join-Path $homeRoot 'runtime/components.json';Regular $componentsFile
  $components=Get-Content $componentsFile -Raw|ConvertFrom-Json
  $workspace=$components.components.workspace;$gateway=$components.components.'unified-mcp'
  $allowed=([IO.Path]::GetFullPath((Join-Path $homeRoot 'releases'))+[IO.Path]::DirectorySeparatorChar)
  foreach($entry in @($workspace.entry,$workspace.runtime,$gateway.entry)){Regular $entry}
  foreach($entry in @($workspace.entry,$gateway.entry)){if(-not ([IO.Path]::GetFullPath($entry)).StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Independent AICC recovery owner differs.'}}
  if((Hash $gateway.entry) -cne $gateway.entryHash){throw 'Independent AICC gateway changed.'}
  $marker=Get-Content (Join-Path $homeRoot 'workspace-mcp/runtime/remote-authority-status.json') -Raw|ConvertFrom-Json
  # ConvertFrom-Json can already return a UTC DateTime; parsing it as text drops
  # its zone through culture formatting. Preserve typed timestamps directly.
  $heartbeat=if($marker.heartbeatAt -is [DateTime]){[DateTimeOffset]$marker.heartbeatAt}else{[DateTimeOffset]::Parse([string]$marker.heartbeatAt)}
  $age=([DateTimeOffset]::UtcNow-$heartbeat).TotalSeconds
  if($marker.phase -ne 'ready' -or $marker.transport.connected -ne $true -or $age -lt 0 -or $age -gt 30 -or
     (Split-Path $marker.installedIdentity.lockfileRealpath -Parent) -ine $workspace.releaseRoot){throw 'Independent AICC recovery readiness unknown; no route cutover.'}
  if((Hash $workspace.runtime) -cne $marker.installedIdentity.nodeExecSha256){throw 'Independent AICC runtime changed.'}
  $files=@($componentsFile,$workspace.entry,$workspace.runtime,$gateway.entry)
  $webConfigFile=Join-Path $owner '.codex-chatgpt-web/config.json'
  Regular $webConfigFile
  $webConfig=Get-Content $webConfigFile -Raw|ConvertFrom-Json
  $upstream=[uri]$webConfig.nativeUpstreamBaseUrl
  if($upstream.Scheme -eq 'http' -and $upstream.Host -in @('127.0.0.1','localhost','::1') -and $upstream.Port -in @(10100,10101)){
    $webRoot=Join-Path $owner '.codex-chatgpt-web'
    $installFile=Join-Path $webRoot 'runtime/windows-install.json'
    $commandFile=Join-Path $webRoot 'runtime/windows-command.json'
    $installed=Get-Content $installFile -Raw|ConvertFrom-Json
    $command=Get-Content $commandFile -Raw|ConvertFrom-Json
    $manifestFile=Join-Path $installed.runtimeRoot 'manifest.json';Regular $manifestFile
    $manifest=Get-Content $manifestFile -Raw|ConvertFrom-Json
    $entry=Join-Path $installed.runtimeRoot 'app/cli.js';Regular $entry
    if($installed.runtimeRoot -ine $command.runtimeRoot -or $installed.inventoryHash -cne $command.inventoryHash -or
       $webConfig.runtimeCommand[1] -ine $entry){throw 'Integrated bridge installation owner differs.'}
    $handoff=$manifest.localOcxAuthHandoff
    $expected=if($handoff.version -eq 1 -and $handoff.scope -eq 'loopback-ocx-data-only'){$handoff.entrypointSha256}
      elseif($manifest.hotfix.kind -eq 'local-ocx-auth-handoff'){$manifest.hotfix.cliSha256}else{$null}
    if(-not $expected -or (Hash $entry) -cne $expected){throw 'Integrated bridge OCX authentication handoff is not attested; preserve the running route.'}
    # Credential bytes remain in their existing owner file and never enter output.
    $credential=[IO.File]::ReadAllText((Join-Path $legacy 'service-api-token')).Trim()
    if($credential.Length -lt 16 -or $credential.Length -gt 4096 -or $credential -match '[\r\n]'){throw 'Local OCX data credential unavailable.'}
    # A catalog read exercises the handoff without sending an inference request.
    # Deliberately do not supply the OCX credential as the incoming Codex Bearer.
    try{
      $catalog=Invoke-RestMethod http://127.0.0.1:17841/v1/models -Headers @{Authorization=('Bearer aicc-route-preflight-'+[guid]::NewGuid().ToString('N'))} -NoProxy -TimeoutSec 10
      # Codex exposes models/slug; OpenAI-compatible catalogs expose data/id.
      $models=if($catalog.data){$catalog.data}else{$catalog.models}
      $nativeModels=@($models|Where-Object {
        $modelId=if($_.id){[string]$_.id}else{[string]$_.slug}
        $modelId -and $modelId -notlike 'chatgpt-web/*'
      })
      if($nativeModels.Count -eq 0){throw 'catalog_unconfirmed'}
    }catch{throw 'Integrated OCX authenticated catalog unavailable; preserve the running route.'}
    $files+=@($installFile,$commandFile,$manifestFile,$entry)
  }
  $files+=@($webConfigFile,$native)
  $fence=@{};foreach($file in $files){$fence[$file]=Hash $file};return $fence
}
function AssertProtectedFence($fence){
  $fresh=ProtectedDependencies
  foreach($file in $fence.Keys){if($fresh[$file] -cne $fence[$file]){throw 'Recovery or bridge owner changed before cutover; preserve it.'}}
}
function AssertIdle{
  $consecutive=0
  for($sample=0;$sample -lt 45;$sample++){
    $raw=& (Join-Path $PSScriptRoot 'Invoke-AiccOcxWindowPolicy.ps1') -Action activity
    if($LASTEXITCODE -ne 0){throw 'Upstream activity unknown; preserve the running owner.'}
    $value=$raw|ConvertFrom-Json
    if($value.terminal -ne 'PASS' -or $null -eq $value.activeTurnCount -or $null -eq $value.isDraining){throw 'Upstream request state unknown; preserve the running owner.'}
    if($value.activeTurnCount -ne 0 -or $value.isDraining -ne $false){
      if($sample -eq 0 -or $sample -eq 44){Write-Warning ('Maintenance waiting: A1 active='+$value.activeTurnCount+' draining='+$value.isDraining)}
      $consecutive=0;Start-Sleep -Seconds 1;continue
    }
    $bridge=Invoke-RestMethod http://127.0.0.1:17841/readyz -NoProxy -TimeoutSec 5
    if($bridge.ready -ne $true -or $bridge.accepting_turns -ne $true -or
       $null -eq $bridge.active_http_turns -or $null -eq $bridge.active_browser_turns){throw 'Integrated request state unknown; preserve the running route.'}
    if($bridge.active_http_turns -ne 0 -or $bridge.active_browser_turns -ne 0){
      if($sample -eq 0 -or $sample -eq 44){Write-Warning ('Maintenance waiting: bridge HTTP='+$bridge.active_http_turns+' browser='+$bridge.active_browser_turns)}
      $consecutive=0;Start-Sleep -Seconds 1;continue
    }
    if(Test-Path $registryPath){
      $registered=Get-Content $registryPath -Raw|ConvertFrom-Json
      $key=[IO.File]::ReadAllText((Join-Path $registered.opencodexHome 'admin-api-token')).Trim()
      $activity=Invoke-RestMethod http://127.0.0.1:10100/api/system/memory -Headers @{Authorization='Bearer '+$key} -NoProxy -TimeoutSec 5
      if($activity.activeTurnCount -ne 0 -or $activity.isDraining -ne $false){throw 'Local request active or unknown.'}
    }
    Start-Sleep -Milliseconds 200
    $consecutive++
    if($consecutive -eq 5){return}
  }
  throw 'Upstream remained active; preserve the running owner.'
}
function StopOwned($cli){
  $null=TaskOwner
  Stop-ScheduledTask -TaskName $taskName
  foreach($process in (OwnedProcesses $cli)){
    $fresh=Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.ProcessId)
    if($fresh -and $fresh.CommandLine -ceq $process.CommandLine){Stop-Process -Id $process.ProcessId -Force}
  }
  Start-Sleep -Milliseconds 300
  if((OwnedProcesses $cli).Count){throw 'Owned process has not stopped.'}
}
function StartOwned{
  Start-ScheduledTask -TaskName $taskName
  for($i=0;$i -lt 45;$i++){$ready=Ready;if($ready.status -eq 'ready'){return $ready};Start-Sleep -Seconds 1}
  throw 'Start outcome unconfirmed; do not repeat start.'
}
function TextHash([string]$text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($text))).ToLowerInvariant()}
function RestoreUpgrade([string]$backup){
  $backup=[IO.Path]::GetFullPath($backup)
  $allowed=[IO.Path]::GetFullPath((Join-Path $homeRoot 'backups/runtime-layout'))+[IO.Path]::DirectorySeparatorChar
  if(-not $backup.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $backup -Leaf) -notmatch '^ocx-local-upgrade-\d{8}-\d{6}-[a-f0-9]{8}$'){throw 'Owned software-upgrade backup required.'}
  $recordFile=Join-Path $backup 'upgrade.json';Regular $recordFile;$record=Get-Content $recordFile -Raw|ConvertFrom-Json
  $previous=$record.previous
  $expected=@($wrapper,$statePath,$registryPath,(Join-Path $homeRoot 'runtime/ocx-local/home/service-state.json'))
  if($record.schemaVersion -ne 1 -or $record.files.Count -ne 4 -or $previous.opencodexHome -ine (Join-Path $homeRoot 'runtime/ocx-local/home')){throw 'Software recovery contract differs.'}
  foreach($file in $record.files){
    if($file.path -notin $expected -or $file.backupFile -notmatch '^[0-3]\.preimage$'){throw 'Software recovery target differs.'}
    $saved=Join-Path $backup $file.backupFile;Regular $saved;Regular $file.path
    if((Hash $saved) -cne $file.beforeSha256 -or (Hash $file.path) -notin @($file.beforeSha256,$file.afterSha256)){throw 'Software recovery preimage changed; preserve newer edits.'}
  }
  if(@($record.files.path|Select-Object -Unique).Count -ne 4){throw 'Software recovery target duplicated.'}
  $oldManifest=Join-Path $previous.packageRoot 'aicc-policy-manifest.json';Regular $oldManifest
  if((Hash $oldManifest) -cne $previous.manifestSha256){throw 'Previous immutable release changed.'}
  foreach($entry in $record.protected.psobject.Properties){Regular $entry.Name;if((Hash $entry.Name) -cne $entry.Value){throw 'Independent recovery or bridge changed; do not overwrite it.'}}
  $null=TaskOwner
  $processes=@((OwnedProcesses $record.candidateCli),(OwnedProcesses $previous.cliPath))|ForEach-Object {$_}|Sort-Object ProcessId -Unique
  $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object {$_.LocalPort -in @(10100,10101)})
  foreach($listener in $listeners){if($listener.OwningProcess -notin @($processes.ProcessId)){throw 'Foreign data listener; no automatic recovery.'}}
  if($processes.Count){
    # Never kill a replacement that may already have accepted another request.
    AssertIdle
    StopOwned $record.candidateCli
    if((OwnedProcesses $previous.cliPath).Count){throw 'Previous owner still present; no duplicate start.'}
  }elseif((TaskOwner).State -ne 'Ready'){throw 'Service owner outcome unknown; do not repeat start.'}
  foreach($file in $record.files){if((Hash $file.path) -notin @($file.beforeSha256,$file.afterSha256)){throw 'Software recovery target changed during stop.'}}
  foreach($file in $record.files){Copy-Item -LiteralPath (Join-Path $backup $file.backupFile) -Destination $file.path -Force}
  $restored=StartOwned
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$restored.pid)
  if($restored.version -ne $previous.version -or $process.ExecutablePath -ine $bun -or -not $process.CommandLine.Contains($previous.cliPath)){throw 'Previous release start outcome unconfirmed; do not repeat start.'}
  return $restored
}
$maintenanceLock=$null
if($Action -in @('Install','Upgrade','RollbackUpgrade','Recover','Rollback')){
  New-Item (Split-Path $registryPath -Parent) -ItemType Directory -Force|Out-Null
  $maintenanceLock=[IO.File]::Open($registryPath+'.maintenance.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}
try {
if($Action -eq 'RollbackUpgrade'){
  if(-not $UpgradeBackup){$UpgradeBackup=(Get-Content $registryPath -Raw|ConvertFrom-Json).upgradeBackup}
  if(-not $UpgradeBackup){throw 'No software-upgrade backup registered; do not use architecture Rollback.'}
  $ready=RestoreUpgrade $UpgradeBackup
  @{terminal='PASS_UPGRADE_ROLLBACK';version=$ready.version;pid=$ready.pid;backup=$UpgradeBackup}|ConvertTo-Json -Compress;return
}
if($Action -eq 'Upgrade'){
  $registered=Get-Content $registryPath -Raw|ConvertFrom-Json
  $PackageRoot=[IO.Path]::GetFullPath($PackageRoot)
  $allowed=[IO.Path]::GetFullPath((Join-Path $homeRoot 'releases/ocx-local'))+[IO.Path]::DirectorySeparatorChar
  if(-not $PackageRoot.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Managed release required.'}
  $manifest=Join-Path $PackageRoot 'aicc-policy-manifest.json';Regular $manifest;$candidate=Get-Content $manifest -Raw|ConvertFrom-Json
  if($candidate.version -notin @('2.77.0-aicc.local.2','2.77.0-aicc.local.3') -or $candidate.requestExecution -ne 'windows-local' -or $candidate.credentialWriter -ne 'a1'){throw 'Upgrade contract differs.'}
  foreach($set in @($candidate.localSourceSha256,$candidate.admissionSourceSha256)){foreach($entry in $set.psobject.Properties){$file=Join-Path $PackageRoot $entry.Name;Regular $file;if((Hash $file) -cne $entry.Value){throw 'Upgrade attestation differs.'}}}
  if((Hash $wrapper) -cne $registered.wrapperSha256 -or (Hash $statePath) -cne $registered.stateSha256 -or (Hash (Join-Path $registered.packageRoot 'aicc-policy-manifest.json')) -cne $registered.manifestSha256){throw 'Running owner preimage changed.'}
  $ready=Ready;$process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ready.pid)
  if($ready.status -ne 'ready' -or $process.ExecutablePath -ine $bun -or -not $process.CommandLine.Contains($registered.cliPath)){throw 'Upgrade running owner unconfirmed.'}
  if($PackageRoot -ieq $registered.packageRoot){
    @{terminal='PASS_ALREADY_CURRENT';version=$ready.version;pid=$ready.pid;changed=$false}|ConvertTo-Json -Compress;return
  }
  $protected=ProtectedDependencies
  $previous=$registered|ConvertTo-Json -Depth 8|ConvertFrom-Json
  $mirror=Join-Path $registered.opencodexHome 'service-state.json'
  $before=@{};foreach($file in @($wrapper,$statePath,$registryPath,$mirror)){Regular $file;$before[$file]=Hash $file}
  $backup=Join-Path $homeRoot ('backups/runtime-layout/ocx-local-upgrade-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8));New-Item $backup -ItemType Directory|Out-Null
  $cli=Join-Path $PackageRoot 'aicc-local-bootstrap.ts'
  Regular $cli
  $text=[IO.File]::ReadAllText($wrapper)
  if(-not $text.Contains($registered.cliPath)){throw 'Upgrade wrapper anchor changed.'}
  $wrapperText=$text.Replace($registered.cliPath,$cli)
  $state=Get-Content $statePath -Raw|ConvertFrom-Json;$state.cliPath=$cli;$state.revision=[int]$state.revision+1
  $stateText=($state|ConvertTo-Json -Depth 12)+[Environment]::NewLine
  $registered.cliPath=$cli;$registered.packageRoot=$PackageRoot;$registered.version=$candidate.version;$registered.manifestSha256=Hash $manifest;$registered.wrapperSha256=TextHash $wrapperText;$registered.stateSha256=TextHash $stateText
  $registered|Add-Member -NotePropertyName upgradeBackup -NotePropertyValue $backup -Force
  $writes=@{ };$writes[$wrapper]=$wrapperText;$writes[$statePath]=$stateText;$writes[$mirror]=$stateText;$writes[$registryPath]=$registered|ConvertTo-Json -Depth 8
  $files=@();$index=0
  foreach($file in @($wrapper,$statePath,$registryPath,$mirror)){
    $saved=([string]$index)+'.preimage';Copy-Item -LiteralPath $file -Destination (Join-Path $backup $saved)
    $files+=@{path=$file;backupFile=$saved;beforeSha256=$before[$file];afterSha256=(TextHash $writes[$file])};$index++
  }
  [IO.File]::WriteAllText((Join-Path $backup 'upgrade.json'),(@{schemaVersion=1;previous=$previous;candidateCli=$cli;files=$files;protected=$protected}|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
  AssertIdle;foreach($file in $before.Keys){if((Hash $file) -cne $before[$file]){throw 'Upgrade owner changed before stop.'}}
  AssertProtectedFence $protected
  try{
    StopOwned $previous.cliPath
    foreach($file in @($wrapper,$statePath,$mirror,$registryPath)){[IO.File]::WriteAllText($file,$writes[$file],[Text.UTF8Encoding]::new($false))}
    $ready=StartOwned
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ready.pid)
    if($ready.version -ne $candidate.version -or $process.ExecutablePath -ine $bun -or -not $process.CommandLine.Contains($cli)){throw 'Candidate running owner differs.'}
  }catch{
    $failure=$_.Exception.Message
    try{$restored=RestoreUpgrade $backup}catch{throw ('HOLD_UPGRADE_RECOVERY: '+$_.Exception.Message+'; backup='+$backup+'; original='+$failure)}
    throw ('HOLD_UPGRADE_ROLLED_BACK: previous release restored once; '+$failure+'; backup='+$backup)
  }
  @{terminal='PASS_UPGRADED';version=$ready.version;pid=$ready.pid;requestExecution='windows-local';credentialWriter='a1';backup=$backup}|ConvertTo-Json -Compress;return
}
if($Action -eq 'Install'){
  if(Test-Path $registryPath){throw 'Local OCX already registered; recover the exact owner.'}
  $PackageRoot=[IO.Path]::GetFullPath($PackageRoot)
  $releases=[IO.Path]::GetFullPath((Join-Path $homeRoot 'releases/ocx-local'))+[IO.Path]::DirectorySeparatorChar
  if(-not $PackageRoot.StartsWith($releases,[StringComparison]::OrdinalIgnoreCase)){throw 'Managed release required.'}
  $manifest=Join-Path $PackageRoot 'aicc-policy-manifest.json';Regular $manifest
  $attested=Get-Content $manifest -Raw|ConvertFrom-Json
  if($attested.version -notin @('2.77.0-aicc.local.1','2.77.0-aicc.local.2','2.77.0-aicc.local.3') -or $attested.requestExecution -ne 'windows-local' -or $attested.credentialWriter -ne 'a1'){throw 'Local release contract differs.'}
  foreach($set in @($attested.localSourceSha256,$attested.admissionSourceSha256)){
    foreach($entry in $set.psobject.Properties){$file=Join-Path $PackageRoot $entry.Name;Regular $file;if((Hash $file) -cne $entry.Value){throw 'Local source attestation differs.'}}
  }
  foreach($file in @($statePath,$wrapper,$launcher,$native,$bun)){Regular $file}
  $state=Get-Content $statePath -Raw|ConvertFrom-Json
  $oldCli=Join-Path $owner '.bun/install/global/node_modules/@bitkyc08/opencodex/src/cli/index.ts'
  if($state.backend -ne 'scheduler' -or $state.cliPath -ine $oldCli -or $state.opencodexHome -ine $legacy -or $state.bunPath -ine $bun){throw 'Stock local service owner changed.'}
  $task=TaskOwner;$before=Ready
  if($task.State -ne 'Running' -or $before.role -ne 'client' -or $before.status -ne 'ready'){throw 'Existing client owner unconfirmed.'}
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$before.pid)
  if($process.ExecutablePath -ine $bun -or -not $process.CommandLine.Contains($oldCli)){throw 'Existing listener owner differs.'}
  $config=[IO.File]::ReadAllText($native)
  $block='(?ms)(\[model_providers\.opencodex\]\r?\n.*?)(?=^\[|\z)'
  $match=[regex]::Match($config,$block)
  if(-not $match.Success -or ([regex]::Matches($match.Value,'base_url = "http://localhost:10101/v1"')).Count -ne 1){throw 'Existing OCX provider route differs.'}
  $nextConfig=$config.Remove($match.Index,$match.Length).Insert($match.Index,$match.Value.Replace('base_url = "http://localhost:10101/v1"','base_url = "http://localhost:10100/v1"'))
  $protected=ProtectedDependencies
  $backup=Join-Path $homeRoot ('backups/runtime-layout/ocx-local-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item $backup -ItemType Directory|Out-Null
  $files=@($statePath,$wrapper,$launcher,$native,(Join-Path $tunnelRoot 'ensure-a1-hub-tunnel.ps1'),(Join-Path $tunnelRoot 'keep-a1-hub-tunnel.ps1'))
  $preimages=@{};foreach($file in $files){$preimages[$file]=Hash $file;Copy-Item -LiteralPath $file -Destination (Join-Path $backup (Split-Path $file -Leaf))}
  AssertIdle
  foreach($file in $files){if((Hash $file) -cne $preimages[$file]){throw 'Preimage changed; no cutover.'}}
  AssertProtectedFence $protected
  StopOwned $oldCli
  StopDataTunnel
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../oracle/codex-cycle-watch/a1-hub-tunnel-ensure.ps1') -Destination (Join-Path $tunnelRoot 'ensure-a1-hub-tunnel.ps1') -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../oracle/codex-cycle-watch/a1-hub-tunnel-watchdog.ps1') -Destination (Join-Path $tunnelRoot 'keep-a1-hub-tunnel.ps1') -Force
  $localHome=Join-Path $homeRoot 'runtime/ocx-local/home';New-Item $localHome -ItemType Directory -Force|Out-Null
  $cli=Join-Path $PackageRoot 'aicc-local-bootstrap.ts'
  $script=@"
@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "OCX_SERVICE=1"
set "OCX_WINDOWS_WRAPPER_PROTOCOL=1"
set "AICC_OCX_LOCAL_AUTH=1"
set "AICC_OCX_COMPAT_PORT=10101"
set "AICC_OCX_WINDOW_THRESHOLDS=95,98"
set "OPENCODEX_HOME=$localHome"
set "CODEX_HOME=$localHome\codex-runtime"
set /p OPENCODEX_API_AUTH_TOKEN=<"$legacy\service-api-token"
:loop
"$bun" "$cli" start --port 10100 >>"$localHome\service.log" 2>&1
if "%ERRORLEVEL%"=="42" exit /b 0
ping -n 6 127.0.0.1 >nul
goto loop
"@
  [IO.File]::WriteAllText($wrapper,$script,[Text.UTF8Encoding]::new($false))
  $state.cliPath=$cli;$state.opencodexHome=$localHome;$state.codexHome=Join-Path $localHome 'codex-runtime';$state.codexSqliteHome=$state.codexHome;$state.revision=[int]$state.revision+1
  $stateText=($state|ConvertTo-Json -Depth 12)+[Environment]::NewLine
  [IO.File]::WriteAllText($statePath,$stateText,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $localHome 'service-state.json'),$stateText,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($native,$nextConfig,[Text.UTF8Encoding]::new($false))
  $registry=@{schemaVersion=1;version=$attested.version;packageRoot=$PackageRoot;manifestSha256=(Hash $manifest);opencodexHome=$localHome;cliPath=$cli;bunPath=$bun;tokenFile=(Join-Path $legacy 'service-api-token');backup=$backup;wrapperSha256=(Hash $wrapper);stateSha256=(Hash $statePath);nativeSha256=(Hash $native);previousNativeSha256=$preimages[$native];credentialWriter='a1';requestExecution='windows-local'}
  [IO.File]::WriteAllText($registryPath,($registry|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  Start-ScheduledTask -TaskName $tunnelTaskName
  $ready=StartOwned
  @{terminal='PASS_INSTALLED';version=$ready.version;pid=$ready.pid;requestExecution='windows-local';credentialWriter='a1';backup=$backup;route='http://localhost:10100/v1'}|ConvertTo-Json -Compress
  return
}
if(-not (Test-Path $registryPath)){throw 'Local OCX is not registered.'}
Regular $registryPath;$registry=Get-Content $registryPath -Raw|ConvertFrom-Json
$null=TaskOwner
if((Hash $wrapper) -cne $registry.wrapperSha256 -or (Hash $statePath) -cne $registry.stateSha256 -or (Hash (Join-Path $registry.packageRoot 'aicc-policy-manifest.json')) -cne $registry.manifestSha256){throw 'Registered owner changed.'}
if($Action -eq 'Rollback'){
  if((Hash $native) -cne $registry.nativeSha256){throw 'Native config changed after installation; preserve user changes.'}
  $protected=ProtectedDependencies
  AssertIdle;AssertProtectedFence $protected;StopOwned $registry.cliPath;StopDataTunnel
  foreach($file in @($statePath,$wrapper,$native)){Copy-Item -LiteralPath (Join-Path $registry.backup (Split-Path $file -Leaf)) -Destination $file -Force}
  foreach($name in @('ensure-a1-hub-tunnel.ps1','keep-a1-hub-tunnel.ps1')){Copy-Item -LiteralPath (Join-Path $registry.backup $name) -Destination (Join-Path $tunnelRoot $name) -Force}
  Move-Item -LiteralPath $registryPath -Destination ($registryPath+'.rolled-back')
  Start-ScheduledTask -TaskName $tunnelTaskName
  $ready=StartOwned
  @{terminal='PASS_ROLLBACK';version=$ready.version}|ConvertTo-Json -Compress;return
}
$ready=Ready
if($Action -eq 'Recover' -and -not $ready){
  for($i=0;$i -lt 5;$i++){if((OwnedProcesses $registry.cliPath).Count -or (TaskOwner).State -ne 'Ready'){throw 'Existing owner remains; no duplicate start.'};Start-Sleep -Milliseconds 200}
  $ready=StartOwned
}
if(-not $ready -or $ready.status -ne 'ready' -or $ready.version -ne $registry.version){throw 'Local readiness unconfirmed.'}
$process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ready.pid)
if($process.ExecutablePath -ine $bun -or -not $process.CommandLine.Contains($registry.cliPath)){throw 'Running local owner differs.'}
@{terminal='PASS';version=$ready.version;pid=$ready.pid;requestExecution='windows-local';credentialWriter='a1';dashboard='http://localhost:10100'}|ConvertTo-Json -Compress
} finally {if($maintenanceLock){$maintenanceLock.Dispose()}}
