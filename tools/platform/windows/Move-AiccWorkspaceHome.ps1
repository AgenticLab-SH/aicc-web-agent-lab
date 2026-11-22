#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PlanFile)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\workspace-mcp\Stop-WorkspaceOwnedRuntime.ps1')
$ownerRoot=[Environment]::GetFolderPath('UserProfile')
$stateRoot=Join-Path $ownerRoot '.ai-control-center'
$planPath=[IO.Path]::GetFullPath($PlanFile)
if(-not $planPath.StartsWith((Join-Path $stateRoot 'runtime\workspace-home-plan-'),[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $planPath).LinkType){throw 'Owned relocation plan required'}
$plan=Get-Content -LiteralPath $planPath -Raw|ConvertFrom-Json -AsHashtable
$taskName='AgenticLab-AICC-Workspace-Tunnel'
$launcher=Join-Path $stateRoot 'workspace-mcp\runtime\aicc-workspace.hidden.ps1'
$configFile=Join-Path $stateRoot 'workspace-mcp\config.json'
$registryFile=Join-Path $stateRoot 'runtime\components.json'
$taskReceiptFile=Join-Path $stateRoot ('backups\workspace-tunnel-windows-task\'+$taskName+'.install.json')
$node=Join-Path $ownerRoot 'AppData\Local\Programs\AICC-Tools\node-v22.23.2-win-x64\node.exe'
function Hash-File([string]$File){(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
function Set-AtomicText([string]$File,[string]$Text){$temporary=$File+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($temporary,$Text,[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $File -Force}
function Read-Idle([string]$Backend){
  $raw=& $node (Join-Path $Backend 'bin\aicc') workspace status --json
  if($LASTEXITCODE -ne 0){throw 'Workspace status unavailable'}
  $workspace=$raw|ConvertFrom-Json
  $native=Invoke-RestMethod -Uri 'http://127.0.0.1:17841/readyz' -TimeoutSec 8 -NoProxy
  if($workspace.remoteAuthority.activeLeases -cne 0 -or $native.ready -ne $true -or $native.active_browser_http_turns -cne 0 -or $native.active_browser_turns -cne 0){throw 'Workspace or browser work is active or unknown'}
  return @{workspace=$workspace;native=$native}
}
if($plan.schemaVersion -ne 1 -or $plan.profile -ine (Join-Path $stateRoot 'workspace-mcp\tunnel\profiles\aicc-workspace.yaml')){throw 'Unknown relocation plan'}
foreach($pair in @(@($plan.backend,'workspace'),@($plan.gateway,'unified-mcp'),@($plan.host,'workspace-host'))){if(-not $pair[0].StartsWith((Join-Path $stateRoot ('releases\'+$pair[1]+'\')),[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $pair[0]).LinkType){throw 'Unowned code candidate'}}
if($plan.helperEntry -ine (Join-Path $plan.host 'tools\platform\workspace-mcp\windows-tunnel-secret.mjs') -or (Hash-File $plan.profile) -cne $plan.profileBeforeHash -or (Hash-File $plan.stagedProfile) -cne $plan.profileAfterHash){throw 'Plan preimage changed'}
foreach($relative in $plan.helperHashes.Keys){$file=[IO.Path]::GetFullPath((Join-Path $plan.host $relative));if(-not $file.StartsWith($plan.host+'\',[StringComparison]::OrdinalIgnoreCase) -or (Hash-File $file) -cne $plan.helperHashes[$relative]){throw 'Helper candidate changed'}}
$gatewayConfig=Get-Content -LiteralPath (Join-Path $plan.gateway 'config.json') -Raw|ConvertFrom-Json
foreach($provider in $gatewayConfig.providers){
  if($provider.args[0] -cne $provider.entrypoint -or $provider.entrypoint -notin @($provider.files.path) -or $provider.command -notin @($provider.files.path)){throw 'Provider executable/entrypoint contract differs; runtime preserved'}
  foreach($item in $provider.files){if((Hash-File $item.path) -cne $item.sha256){throw 'Provider candidate changed'}}
}
$lock=[IO.File]::Open($registryFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$profileLock=$null;$stopped=$false;$registryChanged=$false
try{
  $profileLock=[IO.File]::Open($plan.profile+'.unified-cutover.lock',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $registryBefore=[IO.File]::ReadAllText($registryFile);$registry=$registryBefore|ConvertFrom-Json -AsHashtable
  if($registry.root -ine $stateRoot -or $registry.schemaVersion -ne 1){throw 'Registry owner changed'}
  $marker=Get-Content -LiteralPath (Join-Path $stateRoot 'workspace-mcp\runtime\remote-authority-status.json') -Raw|ConvertFrom-Json
  $oldBackend=Split-Path $marker.installedIdentity.lockfileRealpath -Parent
  $managedBackend=$registry.components.workspace.releaseRoot
  $legacyBackend=$oldBackend.StartsWith((Join-Path $ownerRoot '.codex\releases\open-aicc\'),[StringComparison]::OrdinalIgnoreCase)
  if(-not $legacyBackend -and ($oldBackend -ine $managedBackend -or -not $oldBackend.StartsWith((Join-Path $stateRoot 'releases\workspace\'),[StringComparison]::OrdinalIgnoreCase))){throw 'Original pinned backend changed'}
  if($plan.ContainsKey('originalBackend') -and $plan.originalBackend -ine $oldBackend){throw 'Exact planned backend changed'}
  $before=Read-Idle $oldBackend;$owner=Get-WorkspaceOwnedRuntime 'business-full'
  if($before.workspace.state -ne 'ready' -or -not $before.workspace.serverReady -or -not $before.workspace.tunnel.ready){throw 'Original runtime is not ready'}
  $configHash=Hash-File $configFile;$launcherBefore=[IO.File]::ReadAllText($launcher)
  $taskReceiptBefore=[IO.File]::ReadAllText($taskReceiptFile)
  $taskReceipt=$taskReceiptBefore|ConvertFrom-Json -AsHashtable
  if($taskReceipt.schemaVersion -ne 2 -or $taskReceipt.status -cne 'installed' -or $taskReceipt.taskName -cne $taskName -or $taskReceipt.surfaceProfile -cne 'business-full' -or $taskReceipt.profile -ine $plan.profile -or $taskReceipt.launcher -ine $launcher -or $taskReceipt.profileSha256 -cne $plan.profileBeforeHash -or $taskReceipt.launcherSha256 -cne (Hash-File $launcher)){throw 'Task receipt preimage differs; reconcile relocation history before moving again'}
  $oldHelper=Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\workspace-mcp'))) 'windows-tunnel-secret.mjs'
  if($registry.components.ContainsKey('workspace-host')){$oldHelper=$registry.components['workspace-host'].entry}
  if($launcherBefore.Split($oldHelper,[StringSplitOptions]::None).Count -ne 2){throw 'Exact original helper launcher required'}
  $launcherAfter=$launcherBefore.Replace($oldHelper,$plan.helperEntry)
  $backup=Join-Path $stateRoot ('backups\runtime-layout\workspace-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $backup|Out-Null
  Copy-Item -LiteralPath $launcher -Destination (Join-Path $backup 'launcher.before.ps1');Copy-Item -LiteralPath $plan.profile -Destination (Join-Path $backup 'profile.before.yaml');Copy-Item -LiteralPath $registryFile -Destination (Join-Path $backup 'components.before.json')
  Copy-Item -LiteralPath $taskReceiptFile -Destination (Join-Path $backup 'task-install.before.json')
  Export-ScheduledTask -TaskName $taskName|Set-Content -LiteralPath (Join-Path $backup 'task.before.xml')
  $null=Read-Idle $oldBackend
  if((Hash-File $plan.profile) -cne $plan.profileBeforeHash -or [IO.File]::ReadAllText($launcher) -cne $launcherBefore -or [IO.File]::ReadAllText($registryFile) -cne $registryBefore -or [IO.File]::ReadAllText($taskReceiptFile) -cne $taskReceiptBefore){throw 'Relocation generation changed'}
  Disable-ScheduledTask -TaskName $taskName|Out-Null
  $null=Stop-WorkspaceOwnedRuntime $owner;$stopped=$true
  Stop-ScheduledTask -TaskName $taskName
  $registry.components.workspace=@{location='managed';releaseRoot=$plan.backend;entry=(Join-Path $plan.backend 'bin\aicc');runtime=$node;previousRelease=$oldBackend;recovery=$backup}
  $registry.components['workspace-host']=@{location='managed';releaseRoot=$plan.host;entry=$plan.helperEntry;entryHash=(Hash-File $plan.helperEntry);sourceHashes=$plan.helperHashes;runtime=$node;recovery=$backup}
  $gatewayEntry=Join-Path $plan.gateway 'gateway.cjs'
  $registry.components['unified-mcp']=@{location='managed';releaseRoot=$plan.gateway;entry=$gatewayEntry;entryHash=(Hash-File $gatewayEntry);runtime=$node;previousRelease=$plan.oldGateway;recovery=$backup}
  Set-AtomicText $registryFile ($registry|ConvertTo-Json -Depth 18);$registryChanged=$true
  Set-AtomicText $launcher $launcherAfter
  Set-AtomicText $plan.profile ([IO.File]::ReadAllText($plan.stagedProfile))
  $taskReceipt.profileSha256=$plan.profileAfterHash
  $taskReceipt.launcherSha256=Hash-File $launcher
  $taskReceipt.helperSha256=Hash-File $plan.helperEntry
  $taskReceipt.relocationBackup=$backup
  Set-AtomicText $taskReceiptFile ($taskReceipt|ConvertTo-Json -Depth 18)
  Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
  $post=$null
  for($attempt=0;$attempt -lt 20;$attempt++){
    Start-Sleep -Seconds 2
    try{$post=Read-Idle $plan.backend;if($post.workspace.state -eq 'ready' -and $post.workspace.serverReady -and $post.workspace.tunnel.ready){break}}catch{if($attempt -eq 19){throw}}
  }
  $fresh=Get-WorkspaceOwnedRuntime 'business-full'
  $markerAfter=Get-Content -LiteralPath (Join-Path $stateRoot 'workspace-mcp\runtime\remote-authority-status.json') -Raw|ConvertFrom-Json
  if(-not $post -or $post.workspace.state -ne 'ready' -or -not $post.workspace.serverReady -or -not $post.workspace.tunnel.ready -or $fresh.instanceId -ceq $owner.instanceId -or $post.native.pid -ne $before.native.pid -or (Hash-File $configFile) -cne $configHash -or (Split-Path $markerAfter.installedIdentity.lockfileRealpath -Parent) -ine $plan.backend){throw 'Relocated runtime admission failed'}
  $receipt=@{schemaVersion=1;terminal='PASS_RELOCATED_WORKSPACE';completedAt=[DateTimeOffset]::Now.ToString('o');backend=$plan.backend;gateway=$plan.gateway;host=$plan.host;oldInstance=$owner.instanceId;freshInstance=$fresh.instanceId;nativePidPreserved=$true;ownerConfigUnchanged=$true;activeLeases=0;recovery=$backup}
  $receiptFile=Join-Path $stateRoot ('receipts\workspace-home-'+[guid]::NewGuid().ToString('N')+'.json');Set-AtomicText $receiptFile ($receipt|ConvertTo-Json -Depth 8)
  $receipt|ConvertTo-Json
}catch{
  $failure=$_.Exception.Message
  if($stopped){
    Disable-ScheduledTask -TaskName $taskName|Out-Null
    try{$newOwner=Get-WorkspaceOwnedRuntime 'business-full';$null=Stop-WorkspaceOwnedRuntime $newOwner}catch{
      $helperLockFile=Join-Path $stateRoot 'workspace-mcp\tunnel\runtime\windows-helper.lock'
      if(Test-Path -LiteralPath $helperLockFile){
        $helperLock=Get-Content -LiteralPath $helperLockFile -Raw|ConvertFrom-Json
        if($helperLock.pid -lt 1 -or (Get-Process -Id $helperLock.pid -ErrorAction SilentlyContinue)){throw 'Rollback ownership unknown; candidate preserved for reconciliation'}
      }
      $remaining=@(Get-CimInstance Win32_Process|Where-Object {
        $_.CommandLine -and ($_.CommandLine.Contains($plan.helperEntry) -or $_.CommandLine.Contains($plan.gateway) -or $_.CommandLine.Contains($plan.backend) -or ($_.Name -eq 'tunnel-client.exe' -and $_.ExecutablePath -like ($stateRoot+'\workspace-mcp\*')))
      })
      if($remaining.Count){throw 'Rollback ownership unknown; candidate preserved for reconciliation'}
    }
    Stop-ScheduledTask -TaskName $taskName
    Copy-Item -LiteralPath (Join-Path $backup 'launcher.before.ps1') -Destination $launcher -Force
    Copy-Item -LiteralPath (Join-Path $backup 'profile.before.yaml') -Destination $plan.profile -Force
    Set-AtomicText $taskReceiptFile $taskReceiptBefore
    if($registryChanged){Set-AtomicText $registryFile $registryBefore}
    Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
    throw ('Relocation refused; original owner restored: '+$failure)
  }
  Enable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue|Out-Null
  throw
}finally{if($profileLock){$profileLock.Dispose();Remove-Item -LiteralPath ($plan.profile+'.unified-cutover.lock') -Force};$lock.Dispose()}
