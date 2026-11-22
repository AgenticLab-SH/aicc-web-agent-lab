#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Install','Prepare','Stage','Start','Status','Remove')][string]$Action='Install',[switch]$ContinuityOnly,[switch]$CoworkOnly,[switch]$CliOnly,[switch]$QueueOnly,[switch]$PickerOnly,[switch]$AccountQuotaOnly,[switch]$StatusOnly,[switch]$CommonControlOnly)
$ErrorActionPreference='Stop'
if(([int][bool]$ContinuityOnly+[int][bool]$CoworkOnly+[int][bool]$CliOnly+[int][bool]$QueueOnly+[int][bool]$PickerOnly+[int][bool]$AccountQuotaOnly+[int][bool]$StatusOnly+[int][bool]$CommonControlOnly) -gt 1){throw 'Choose one tray source scope.'}
$taskName='AgenticLab-AICC-Status-Tray'
$aiccHome=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'}
$taskStateRoot=Join-Path $aiccHome 'status-tray'
$source=Join-Path $PSScriptRoot 'AiccStatusTray.cs'
$collector=Join-Path $PSScriptRoot 'tray-status.mjs'
$node=(Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$ownedTaskDescriptions=@('AICC owner-local unified status tray; no service mutations','AICC owner-local unified status tray; explicit account controls')
if($task -and $task.Description -notin $ownedTaskDescriptions){throw 'Unknown tray task owner'}
if($Action -eq 'Install'){
  # Preserve an already dispatched account transaction when replacing the UI.
  $currentRegistry=Join-Path $aiccHome 'runtime/components.json'
  if(Test-Path -LiteralPath $currentRegistry){
    $current=Get-Content -LiteralPath $currentRegistry -Raw|ConvertFrom-Json
    $previous=$current.components.tray
    if($previous.releaseRoot){
      $control=Join-Path $previous.releaseRoot 'tools/platform/windows/tray-control.mjs'
      $active=Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($control)}
      if($active){throw 'Tray account control is still active; preserve its original result before installing.'}
    }
  }
}
if($Action -eq 'Status'){
  @{installed=($null -ne $task);running=($task.State -eq 'Running');taskName=$taskName;consoleWindow=$false}|ConvertTo-Json;return
}
if($Action -eq 'Start'){
  if(-not $task){throw 'Status tray is not installed. Run the Install action first.'}
  Start-ScheduledTask -TaskName $taskName
  @{startRequested=$true;taskName=$taskName;consoleWindow=$false}|ConvertTo-Json;return
}
if($Action -eq 'Remove'){
  if($task){Stop-ScheduledTask $taskName;Unregister-ScheduledTask $taskName -Confirm:$false}
  @{removed=$true;servicesPreserved=$true}|ConvertTo-Json;return
}
$sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$snapshotFiles=@('tools/platform/windows/AiccStatusTray.cs','tools/platform/windows/AiccStatusTrayPanel.cs','tools/platform/windows/AiccStatusTrayCredits.cs','tools/platform/windows/tray-status.mjs','tools/platform/windows/tray-control.mjs','src/runtime-layout.mjs','src/private-home.mjs','docs/user-guide.html','tools/platform/opencodex/Invoke-AiccOcxHubAccounts.ps1','tools/platform/opencodex/hub-accounts.py','tools/platform/opencodex/Open-AiccOcxDashboard.ps1','tools/platform/opencodex/verify-client-dashboard.mjs','tools/platform/opencodex/Invoke-AiccOcxWindowPolicy.ps1','tools/platform/opencodex/hub-window-policy.py')
$sourceHashes=[ordered]@{}
$snapshotFiles+=@('tools/platform/windows/AiccTrayIdentity.cs','tools/platform/windows/AiccStatusTrayContinuity.cs','tools/platform/windows/Invoke-AiccCodexContinuity.ps1')
$snapshotFiles+=@('tools/platform/opencodex/Invoke-AiccLocalOcx.ps1','tools/platform/opencodex/Invoke-AiccOcxRecovery.ps1')
$snapshotFiles+=@('tools/platform/windows/AiccStatusTrayTools.cs')
$snapshotFiles+=@('tools/platform/windows/AiccSupervisedRunsPanel.cs')
$snapshotFiles+=@('tools/platform/windows/AiccCodexCliDialog.cs','tools/platform/windows/Start-AiccCodexCli.ps1')
$pickerFiles=@('tools/platform/windows/AiccTerminalPickerPanel.cs','tools/platform/windows/Invoke-AiccTerminalPicker.ps1','tools/platform/windows/Register-AiccTerminalPicker.ps1','tools/platform/codex/Select-PhoneTerminal.ps1','tools/platform/codex/Resume-PhoneTerminal.ps1')
$snapshotFiles+=$pickerFiles
$snapshotFiles+=@('tools/platform/windows/AiccOperationsDialog.cs','tools/platform/windows/Invoke-AiccTroubleshooter.ps1','tools/platform/workspace-mcp/Stop-WorkspaceOwnedRuntime.ps1','tools/platform/windows/rdc-managed-agent.mjs','tools/platform/windows/Start-AiccManagedRdc.ps1')
$snapshotFiles+=@('public/ai-cowork.json')
$snapshotRoots=@{}
if($AccountQuotaOnly){$snapshotFiles+=@('tools/platform/windows/Invoke-AiccAccountQuotaPolicy.ps1')}
if($ContinuityOnly -or $CoworkOnly -or $CliOnly -or $QueueOnly -or $PickerOnly -or $AccountQuotaOnly -or $StatusOnly -or $CommonControlOnly){
  $baselineRegistry=Get-Content -LiteralPath (Join-Path $aiccHome 'runtime/components.json') -Raw|ConvertFrom-Json -AsHashtable
  $baseline=$baselineRegistry.components.tray
  if(-not $baseline.releaseRoot.StartsWith((Join-Path $aiccHome 'releases\tray\'),[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $baseline.releaseRoot).LinkType){throw 'Registered tray baseline required'}
  if($CommonControlOnly){
    if(-not $baseline.sourceHashes){throw 'Registered tray pin list required'}
    $snapshotFiles=@($baseline.sourceHashes.Keys)
    foreach($required in 'tools/platform/windows/AiccStatusTray.cs','tools/platform/windows/AiccStatusTrayTools.cs'){
      if($required -cnotin $snapshotFiles){throw 'Common control tray source pin missing'}
    }
  }
  # A CLI-only update must not introduce a panel absent from the registered host.
  $supervisedRelative='tools/platform/windows/AiccSupervisedRunsPanel.cs'
  if(($CliOnly -or $QueueOnly -or $PickerOnly -or $AccountQuotaOnly -or $StatusOnly) -and -not $baseline.sourceHashes[$supervisedRelative]){
    if(Test-Path -LiteralPath (Join-Path $baseline.releaseRoot $supervisedRelative)){throw 'Unpinned installed supervised panel preserved'}
    $snapshotFiles=@($snapshotFiles|Where-Object {$_ -ne $supervisedRelative})
  }
  foreach($relative in $snapshotFiles){
    if($CommonControlOnly){
      if($relative -notmatch '^(?:[a-zA-Z0-9_.-]+/)+[a-zA-Z0-9_.-]+$' -or ($relative.Split('/') | Where-Object {$_ -in '.', '..'})){throw 'Invalid registered tray source path'}
      $installed=Join-Path $baseline.releaseRoot $relative
      if((Get-FileHash -LiteralPath $installed).Hash.ToLowerInvariant() -cne $baseline.sourceHashes[$relative]){throw 'Registered tray source pin differs'}
      $snapshotRoots[$relative]=if($relative -cin @('tools/platform/windows/AiccStatusTray.cs','tools/platform/windows/AiccStatusTrayTools.cs')){$sourceRoot}else{$baseline.releaseRoot}
      continue
    }
    if($StatusOnly){
      if($relative -ceq 'tools/platform/windows/tray-status.mjs'){$snapshotRoots[$relative]=$sourceRoot;continue}
      $installed=Join-Path $baseline.releaseRoot $relative
      if(-not $baseline.sourceHashes[$relative] -or (Get-FileHash -LiteralPath $installed).Hash.ToLowerInvariant() -cne $baseline.sourceHashes[$relative]){throw 'Registered tray source pin differs'}
      $snapshotRoots[$relative]=$baseline.releaseRoot;continue
    }
    if($AccountQuotaOnly){
      if($relative -in @('tools/platform/windows/AiccStatusTray.cs','tools/platform/windows/AiccStatusTrayPanel.cs','tools/platform/windows/tray-control.mjs','tools/platform/windows/tray-status.mjs','tools/platform/windows/Invoke-AiccAccountQuotaPolicy.ps1')){$snapshotRoots[$relative]=$sourceRoot;continue}
      $installed=Join-Path $baseline.releaseRoot $relative
      if(-not $baseline.sourceHashes[$relative] -or (Get-FileHash -LiteralPath $installed).Hash.ToLowerInvariant() -cne $baseline.sourceHashes[$relative]){throw 'Registered tray source pin differs'}
      $snapshotRoots[$relative]=$baseline.releaseRoot;continue
    }
    if($PickerOnly){
      if($relative -in $pickerFiles){$snapshotRoots[$relative]=$sourceRoot;continue}
      $installed=Join-Path $baseline.releaseRoot $relative
      if(-not $baseline.sourceHashes[$relative] -or (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant() -cne $baseline.sourceHashes[$relative]){throw 'Registered tray source pin differs'}
      $snapshotRoots[$relative]=$baseline.releaseRoot;continue
    }
    if($QueueOnly){
      if($relative -in @('tools/platform/windows/AiccStatusTrayPanel.cs','tools/platform/windows/tray-status.mjs')){$snapshotRoots[$relative]=$sourceRoot;continue}
      $installed=Join-Path $baseline.releaseRoot $relative
      if(-not $baseline.sourceHashes[$relative] -or (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant() -cne $baseline.sourceHashes[$relative]){throw 'Registered tray source pin differs'}
      $snapshotRoots[$relative]=$baseline.releaseRoot;continue
    }
    if($relative -in $pickerFiles){
      # Conversation UI is a bounded source slice. Other scoped installs preserve it.
      if($ContinuityOnly){$snapshotRoots[$relative]=$sourceRoot;continue}
      $installedPicker=Join-Path $baseline.releaseRoot $relative
      if($baseline.sourceHashes[$relative]){
        if((Get-FileHash -LiteralPath $installedPicker -Algorithm SHA256).Hash.ToLowerInvariant() -cne $baseline.sourceHashes[$relative]){throw 'Installed picker pin differs'}
        $snapshotRoots[$relative]=$baseline.releaseRoot;continue
      }
      $snapshotRoots[$relative]=$sourceRoot;continue
    }
    if($CliOnly){
      if($relative -in @('tools/platform/windows/AiccCodexCliDialog.cs','tools/platform/windows/Start-AiccCodexCli.ps1')){$snapshotRoots[$relative]=$sourceRoot;continue}
      $installed=Join-Path $baseline.releaseRoot $relative
      if(-not $baseline.sourceHashes[$relative] -or (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant() -cne $baseline.sourceHashes[$relative]){throw 'Registered tray source pin differs'}
      $snapshotRoots[$relative]=$baseline.releaseRoot;continue
    }
    if($relative -eq 'public/ai-cowork.json'){$snapshotRoots[$relative]=$sourceRoot;continue}
    if($CoworkOnly){
      if($relative -in @('public/ai-cowork.json','tools/platform/windows/AiccStatusTrayPanel.cs')){$snapshotRoots[$relative]=$sourceRoot;continue}
      $installed=Join-Path $baseline.releaseRoot $relative
      if(-not $baseline.sourceHashes[$relative] -or (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant() -cne $baseline.sourceHashes[$relative]){throw 'Registered tray source pin differs'}
      $snapshotRoots[$relative]=$baseline.releaseRoot;continue
    }
    if($relative -in @('tools/platform/windows/AiccCodexCliDialog.cs','tools/platform/windows/Start-AiccCodexCli.ps1')){$snapshotRoots[$relative]=$sourceRoot;continue}
    if($relative -in @('tools/platform/windows/AiccOperationsDialog.cs','tools/platform/windows/Invoke-AiccTroubleshooter.ps1','tools/platform/workspace-mcp/Stop-WorkspaceOwnedRuntime.ps1','tools/platform/windows/rdc-managed-agent.mjs','tools/platform/windows/Start-AiccManagedRdc.ps1')){$snapshotRoots[$relative]=$sourceRoot;continue}
    $installed=Join-Path $baseline.releaseRoot $relative
    if(-not $baseline.sourceHashes[$relative] -or (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant() -cne $baseline.sourceHashes[$relative]){throw 'Registered tray source pin differs'}
    $snapshotRoots[$relative]=if($relative -in @('tools/platform/windows/AiccStatusTrayContinuity.cs','tools/platform/windows/Invoke-AiccCodexContinuity.ps1','tools/platform/windows/AiccStatusTrayTools.cs','tools/platform/windows/AiccStatusTrayPanel.cs','tools/platform/windows/AiccStatusTray.cs','docs/user-guide.html')){$sourceRoot}else{$baseline.releaseRoot}
  }
}else{foreach($relative in $snapshotFiles){$snapshotRoots[$relative]=$sourceRoot}}
foreach($relative in $snapshotFiles){$sourceHashes[$relative]=(Get-FileHash -LiteralPath (Join-Path $snapshotRoots[$relative] $relative) -Algorithm SHA256).Hash.ToLowerInvariant()}
$manifestBytes=[Text.Encoding]::UTF8.GetBytes(($sourceHashes|ConvertTo-Json -Compress))
$digest=[Security.Cryptography.SHA256]::Create();try{$hash=[Convert]::ToHexString($digest.ComputeHash($manifestBytes)).ToLowerInvariant()}finally{$digest.Dispose()}
$release=Join-Path $aiccHome ('releases\tray\'+$hash.Substring(0,16))
New-Item $release -ItemType Directory -Force|Out-Null
foreach($relative in $snapshotFiles){
  $destination=Join-Path $release $relative
  if(-not(Test-Path -LiteralPath $destination)){New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $snapshotRoots[$relative] $relative) -Destination $destination}
  elseif((Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant() -ne $sourceHashes[$relative]){throw 'Existing immutable tray snapshot changed'}
}
[IO.File]::WriteAllText((Join-Path $release 'source-manifest.json'),($sourceHashes|ConvertTo-Json)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
# Stage is source packaging only: no compiler, executable, registry update or process restart.
if($Action -eq 'Stage'){
  @{staged=$true;sourceOnly=$true;releaseRoot=$release;releaseHash=$hash;runtimeChanged=$false;buildExecuted=$false;verificationExecuted=$false}|ConvertTo-Json
  return
}
$source=Join-Path $release 'tools\platform\windows\AiccStatusTray.cs'
$panelSource=Join-Path $release 'tools\platform\windows\AiccStatusTrayPanel.cs'
$creditSource=Join-Path $release 'tools\platform\windows\AiccStatusTrayCredits.cs'
$toolsSource=Join-Path $release 'tools\platform\windows\AiccStatusTrayTools.cs'
$codexCliSource=Join-Path $release 'tools\platform\windows\AiccCodexCliDialog.cs'
$operationsSource=Join-Path $release 'tools\platform\windows\AiccOperationsDialog.cs'
$continuitySource=Join-Path $release 'tools\platform\windows\AiccStatusTrayContinuity.cs'
$supervisedSource=Join-Path $release 'tools\platform\windows\AiccSupervisedRunsPanel.cs'
$terminalPickerSource=Join-Path $release 'tools\platform\windows\AiccTerminalPickerPanel.cs'
$collector=Join-Path $release 'tools\platform\windows\tray-status.mjs'
$exe=Join-Path $release 'aicc-status-tray.exe'
$iconPath=Join-Path $release 'aicc-status-tray.ico'
$identitySource=Join-Path $release 'tools\platform\windows\AiccTrayIdentity.cs'
if(-not (Test-Path -LiteralPath $iconPath)){
  Add-Type -AssemblyName System.Drawing
  $drawingReferences=@([Drawing.Bitmap].Assembly.Location,[Drawing.Color].Assembly.Location)
  $drawingReferences+=@(Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll' -File|Where-Object {$_.Name -ne 'System.Drawing.dll' -and $_.Name -ne 'System.Drawing.Primitives.dll'}|ForEach-Object {$_.FullName})
  $drawingReferences+=@(Get-ChildItem -LiteralPath $PSHOME -Filter 'System.Private.Windows.*.dll' -File|ForEach-Object {$_.FullName})
  Add-Type -Path $identitySource -ReferencedAssemblies $drawingReferences
  [AiccTrayIdentity]::WriteIcon($iconPath)
}
if(-not (Test-Path $exe)){
  $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $buildSources=@($source,$panelSource,$creditSource,$toolsSource,$codexCliSource,$operationsSource,$continuitySource,$terminalPickerSource,$identitySource)
  if($snapshotFiles -contains 'tools/platform/windows/AiccSupervisedRunsPanel.cs'){$buildSources+=$supervisedSource}
  & $compiler /nologo /target:winexe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/win32icon:$iconPath" "/out:$exe" @buildSources
  if($LASTEXITCODE -ne 0){throw 'Tray build failed'}
}
if($Action -eq 'Prepare'){@{prepared=$true;releaseRoot=$release;releaseHash=$hash;executable=$exe;runtimeChanged=$false;continuityOnly=[bool]$ContinuityOnly;cliOnly=[bool]$CliOnly;pickerOnly=[bool]$PickerOnly}|ConvertTo-Json;return}
$arguments='"'+$node+'" "'+$collector+'"'
$launcher=Join-Path $aiccHome 'bin\aicc-tray.exe'
$launcherSource=Join-Path $PSScriptRoot 'AiccComponentLauncher.cs'
$launcherSourceHash=(Get-FileHash -LiteralPath $launcherSource).Hash.ToLowerInvariant()
$identityHash=(Get-FileHash -LiteralPath $identitySource).Hash.ToLowerInvariant()
$launcherHasher=[Security.Cryptography.SHA256]::Create()
try{$launcherHash=[Convert]::ToHexString($launcherHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($launcherSourceHash+':'+$identityHash))).ToLowerInvariant()}finally{$launcherHasher.Dispose()}
$launcherReceipt=$launcher+'.source-sha256'
New-Item -ItemType Directory -Path (Split-Path $launcher -Parent) -Force|Out-Null
if($CommonControlOnly){
  if(-not (Test-Path -LiteralPath $launcher -PathType Leaf) -or -not $task -or $task.Actions.Count -ne 1 -or $task.Actions.Execute -ne $launcher -or $task.Actions.Arguments -ne 'tray'){throw 'Registered fixed tray launcher required'}
}elseif(-not(Test-Path -LiteralPath $launcherReceipt) -or [IO.File]::ReadAllText($launcherReceipt) -ne $launcherHash){
  $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  & $compiler /nologo /target:winexe /r:System.Web.Extensions.dll "/win32icon:$iconPath" "/out:$launcher" $launcherSource
  if($LASTEXITCODE -ne 0){throw 'Fixed component launcher build failed'}
  [IO.File]::WriteAllText($launcherReceipt,$launcherHash)
}
$registryPath=Join-Path $aiccHome 'runtime\components.json'
New-Item -ItemType Directory -Path (Split-Path $registryPath -Parent) -Force|Out-Null
$registryLock=[IO.File]::Open($registryPath+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
$registryBefore=if(Test-Path -LiteralPath $registryPath){[IO.File]::ReadAllText($registryPath)}else{$null}
$registry=if($null -ne $registryBefore){$registryBefore|ConvertFrom-Json -AsHashtable}else{@{schemaVersion=1;root=$aiccHome;components=@{}}}
if($registry.schemaVersion -ne 1 -or $registry.root -ne $aiccHome){throw 'Unknown component registry preserved'}
if($CommonControlOnly -and $registry.components.tray.releaseHash -cne $baseline.releaseHash){throw 'Tray baseline changed during common control preparation'}
if($task -and ($task.Actions.Execute -ne $launcher -or $task.Actions.Arguments -ne 'tray' -or $registry.components.tray.releaseHash -ne $hash)){
  # The fixed launcher exits after spawning the tray. Its task can be Ready while
  # the exact registered child still owns the singleton; stop only that child.
  $previousTray=$registry.components.tray
  if($previousTray.entry -and $previousTray.arguments.Count -eq 2){
    $oldEntry=[IO.Path]::GetFullPath($previousTray.entry)
    $allowedTrayRoot=[IO.Path]::GetFullPath((Join-Path $aiccHome 'releases\tray'))
    if(-not $oldEntry.StartsWith($allowedTrayRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unowned registered tray path preserved'}
    $ownedChildren=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $oldEntry -and $_.CommandLine -and $_.CommandLine.Contains([string]$previousTray.arguments[1])}
    foreach($ownedChild in $ownedChildren){Stop-Process -Id $ownedChild.ProcessId -ErrorAction Stop}
  }
  Export-ScheduledTask $taskName|Set-Content (Join-Path $release 'task.before.xml') -Encoding unicode
  Stop-ScheduledTask $taskName
  for($attempt=0;$attempt -lt 30;$attempt++){
    if((Get-ScheduledTask $taskName).State -ne 'Running'){break}
    Start-Sleep -Milliseconds 250
  }
  if((Get-ScheduledTask $taskName).State -eq 'Running'){throw 'Previous tray instance still active'}
}
$registry.components.tray=@{entry=$exe;arguments=@($node,$collector);releaseRoot=$release;releaseHash=$hash;location='managed';sourceHashes=$sourceHashes}
$temporary=$registryPath+'.'+[guid]::NewGuid().ToString()+'.tmp'
[IO.File]::WriteAllText($temporary,($registry|ConvertTo-Json -Depth 12)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
$registryNow=if(Test-Path -LiteralPath $registryPath){[IO.File]::ReadAllText($registryPath)}else{$null}
if($registryNow -cne $registryBefore){Remove-Item -LiteralPath $temporary;throw 'Component registry changed; preserved without overwrite'}
Move-Item -LiteralPath $temporary -Destination $registryPath -Force
}finally{$registryLock.Dispose()}
$actionDef=New-ScheduledTaskAction -Execute $launcher -Argument 'tray' -WorkingDirectory (Split-Path $launcher -Parent)
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $sid
$trigger.Delay='PT20S'
$principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask $taskName -Action $actionDef -Trigger $trigger -Principal $principal -Settings $settings -Description 'AICC owner-local unified status tray; explicit account controls' -Force|Out-Null
$shortcutDescription='AICC owner-local status tray launcher; no service mutations'
$shortcutPaths=@(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AICC 상태.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'AICC\AICC 상태.lnk')
)
$shell=New-Object -ComObject WScript.Shell
foreach($shortcutPath in $shortcutPaths){
  if(Test-Path -LiteralPath $shortcutPath){
    $previous=$shell.CreateShortcut($shortcutPath)
    if($previous.Description -ne $shortcutDescription){throw "Unowned shortcut preserved: $shortcutPath"}
  }
  New-Item -ItemType Directory -Path (Split-Path $shortcutPath -Parent) -Force|Out-Null
  $shortcut=$shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath=$launcher;$shortcut.Arguments='tray';$shortcut.WorkingDirectory=Split-Path $launcher -Parent
  $shortcut.Description=$shortcutDescription;$shortcut.IconLocation=$iconPath+',0';$shortcut.Save()
}
Start-ScheduledTask $taskName
@{installed=$true;taskName=$taskName;executable=$exe;sourceSha256=$hash;noConsole=$true;refreshSeconds=15;fastRefreshSeconds=60;hiddenRefreshSeconds=300;forceRefreshDebounceSeconds=30;displayStyle='WinFormsOpaqueWithOptionalOpacity';shortcuts=$shortcutPaths;autoStart='current-user logon + 20 seconds';start='Install-AiccStatusTray.ps1 -Action Start';remove='Install-AiccStatusTray.ps1 -Action Remove'}|ConvertTo-Json
