#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Candidate)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\workspace-mcp\Stop-WorkspaceOwnedRuntime.ps1')
$userRoot=[Environment]::GetFolderPath('UserProfile');$stateRoot=Join-Path $userRoot '.ai-control-center'
$candidateRoot=[IO.Path]::GetFullPath($Candidate)
if(-not $candidateRoot.StartsWith((Join-Path $stateRoot 'releases\unified-mcp\'),[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $candidateRoot).LinkType){throw 'Exact managed gateway candidate required'}
$registryPath=Join-Path $stateRoot 'runtime\components.json';$profile=Join-Path $stateRoot 'workspace-mcp\tunnel\profiles\aicc-workspace.yaml'
$taskName='AgenticLab-AICC-Workspace-Tunnel';$configPath=Join-Path $stateRoot 'workspace-mcp\config.json'
function Hash-File([string]$File){(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
function Atomic-Text([string]$File,[string]$Text){$tmp=$File+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($tmp,$Text,[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $tmp -Destination $File -Force}
function Idle([hashtable]$Registry){
  $component=$Registry.components.workspace
  $raw=& $component.runtime $component.entry workspace status --json
  if($LASTEXITCODE -ne 0){throw 'Workspace status unavailable'}
  $workspace=$raw|ConvertFrom-Json
  $native=Invoke-RestMethod -Uri 'http://127.0.0.1:17841/readyz' -NoProxy -TimeoutSec 8
  if($workspace.state -ne 'ready' -or -not $workspace.serverReady -or -not $workspace.tunnel.ready -or $workspace.remoteAuthority.activeLeases -cne 0 -or -not $native.ready -or $native.active_browser_http_turns -cne 0 -or $native.active_browser_turns -cne 0){throw 'Workspace/browser is active or unknown'}
  return @{workspace=$workspace;native=$native}
}
$manifest=Get-Content -LiteralPath (Join-Path $candidateRoot 'manifest.json') -Raw|ConvertFrom-Json -AsHashtable
if($manifest.schemaVersion -ne 1 -or (Split-Path $candidateRoot -Leaf) -cne $manifest.releaseHash -or $manifest.files.Count -ne 2){throw 'Sealed candidate required'}
foreach($name in @('gateway.cjs','config.json')){if((Hash-File (Join-Path $candidateRoot $name)) -cne $manifest.files[$name]){throw 'Candidate changed'}}
$lock=[IO.File]::Open($registryPath+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$profileLock=$null;$stopped=$false;$newStarted=$false
try{
  $profileLock=[IO.File]::Open($profile+'.unified-cutover.lock',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $registryBefore=[IO.File]::ReadAllText($registryPath);$registry=$registryBefore|ConvertFrom-Json -AsHashtable
  if($registry.root -ine $stateRoot -or $registry.schemaVersion -ne 1){throw 'Registry owner changed'}
  $old=$registry.components['unified-mcp'];if($old.location -ne 'managed' -or (Hash-File $old.entry) -cne $old.entryHash){throw 'Current gateway owner changed'}
  $currentConfig=Get-Content -LiteralPath (Join-Path $old.releaseRoot 'config.json') -Raw|ConvertFrom-Json -AsHashtable
  $nextConfig=Get-Content -LiteralPath (Join-Path $candidateRoot 'config.json') -Raw|ConvertFrom-Json -AsHashtable
  foreach($key in @('schemaVersion','surfaceProfile','workspaceIdentityHash','providers')){
    if(($currentConfig[$key]|ConvertTo-Json -Depth 30 -Compress) -cne ($nextConfig[$key]|ConvertTo-Json -Depth 30 -Compress)){throw 'Provider contracts must remain unchanged'}
  }
  $profileBefore=[IO.File]::ReadAllText($profile);$oldEntry=$old.entry.Replace('\','/');$oldConfig=(Join-Path $old.releaseRoot 'config.json').Replace('\','/')
  if($profileBefore.Split($oldEntry,[StringSplitOptions]::None).Count -ne 2 -or $profileBefore.Split($oldConfig,[StringSplitOptions]::None).Count -ne 2){throw 'Exact current profile required'}
  $profileAfter=$profileBefore.Replace($oldEntry,(Join-Path $candidateRoot 'gateway.cjs').Replace('\','/')).Replace($oldConfig,(Join-Path $candidateRoot 'config.json').Replace('\','/'))
  $before=Idle $registry;$owner=Get-WorkspaceOwnedRuntime 'business-full';$configHash=Hash-File $configPath
  $backup=Join-Path $stateRoot ('backups\runtime-layout\gateway-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $backup|Out-Null
  Copy-Item -LiteralPath $registryPath -Destination (Join-Path $backup 'components.before.json');Copy-Item -LiteralPath $profile -Destination (Join-Path $backup 'profile.before.yaml')
  $null=Idle $registry
  if([IO.File]::ReadAllText($registryPath) -cne $registryBefore -or [IO.File]::ReadAllText($profile) -cne $profileBefore){throw 'Generation changed'}
  Disable-ScheduledTask -TaskName $taskName|Out-Null;$null=Stop-WorkspaceOwnedRuntime $owner;$stopped=$true;Stop-ScheduledTask -TaskName $taskName
  $registry.components['unified-mcp']=@{location='managed';releaseRoot=$candidateRoot;entry=(Join-Path $candidateRoot 'gateway.cjs');entryHash=$manifest.files['gateway.cjs'];runtime=$old.runtime;previousRelease=$old.releaseRoot;recovery=$backup}
  Atomic-Text $registryPath ($registry|ConvertTo-Json -Depth 20);Atomic-Text $profile $profileAfter
  Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName;$newStarted=$true
  $post=$null
  for($attempt=0;$attempt -lt 20;$attempt++){Start-Sleep -Seconds 2;try{$post=Idle $registry;break}catch{if($attempt -eq 19){throw}}}
  $fresh=Get-WorkspaceOwnedRuntime 'business-full'
  if(-not $post -or $fresh.instanceId -ceq $owner.instanceId -or $post.native.pid -ne $before.native.pid -or (Hash-File $configPath) -cne $configHash){throw 'Gateway cutover admission failed'}
  $receipt=@{schemaVersion=1;terminal='PASS_APPLIED_UNIFIED_GATEWAY';completedAt=[DateTimeOffset]::Now.ToString('o');gateway=$candidateRoot;previousRelease=$old.releaseRoot;providerContractsUnchanged=$true;nativePidPreserved=$true;ownerConfigUnchanged=$true;freshInstance=$fresh.instanceId;recovery=$backup}
  Atomic-Text (Join-Path $stateRoot ('receipts\unified-gateway-'+[guid]::NewGuid().ToString('N')+'.json')) ($receipt|ConvertTo-Json -Depth 8)
  $receipt|ConvertTo-Json
}catch{
  $failure=$_.Exception.Message
  if($stopped){
    Disable-ScheduledTask -TaskName $taskName|Out-Null
    if($newStarted){$currentOwner=Get-WorkspaceOwnedRuntime 'business-full';$null=Stop-WorkspaceOwnedRuntime $currentOwner}
    Stop-ScheduledTask -TaskName $taskName
    Atomic-Text $registryPath $registryBefore;Atomic-Text $profile $profileBefore
    Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
    throw ('Gateway cutover refused; original owner restored: '+$failure)
  }
  throw
}finally{if($profileLock){$profileLock.Dispose();Remove-Item -LiteralPath ($profile+'.unified-cutover.lock') -Force};$lock.Dispose()}
