#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedProfileSha256,[switch]$Commit,[switch]$HideConsole)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Stop-WorkspaceOwnedRuntime.ps1')
$taskHome=[Environment]::GetFolderPath('UserProfile')
$profileFile=Join-Path $taskHome '.ai-control-center\workspace-mcp\tunnel\profiles\aicc-workspace.yaml'
$taskName='AgenticLab-AICC-Workspace-Tunnel'
function Profile-Hash{(Get-FileHash -LiteralPath $profileFile -Algorithm SHA256).Hash.ToLowerInvariant()}
function Check-Idle{
  $marker=Get-Content (Join-Path $taskHome '.ai-control-center\workspace-mcp\runtime\remote-authority-status.json') -Raw | ConvertFrom-Json
  $pinnedRoot=Split-Path $marker.installedIdentity.lockfileRealpath -Parent
  $registry=Get-Content -LiteralPath (Join-Path $taskHome '.ai-control-center\runtime\components.json') -Raw|ConvertFrom-Json
  if(-not $pinnedRoot.StartsWith((Join-Path $taskHome '.codex\releases\open-aicc\'),[StringComparison]::OrdinalIgnoreCase) -and $pinnedRoot -ine $registry.components.workspace.releaseRoot){throw 'Pinned Workspace runtime required'}
  $state=(& node (Join-Path $pinnedRoot 'bin\aicc') workspace status --json) | ConvertFrom-Json
  $native=(& curl.exe --noproxy '*' -sS --fail --max-time 8 http://127.0.0.1:17841/readyz) | ConvertFrom-Json
  if($state.remoteAuthority.activeLeases -cne 0 -or $native.ready -ne $true -or (-not $HideConsole -and $native.active_http_turns -cne 0) -or $native.active_browser_http_turns -cne 0 -or $native.active_browser_turns -cne 0){throw 'Exact idle state is unknown or active'}
  return @{state=$state;native=$native}
}
if((Profile-Hash) -cne $ExpectedProfileSha256){throw 'Exact profile changed'}
$idle=Check-Idle;$owner=Get-WorkspaceOwnedRuntime 'business-full'
if(-not $Commit){@{terminal='DRY_RUN';instanceId=$owner.instanceId;ownedProcessCount=$owner.processes.Count;nativePid=$idle.native.pid;profileChange=$false} | ConvertTo-Json;return}
$lockFile=$profileFile+'.unified-cutover.lock';$lock=[IO.File]::Open($lockFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{
  if((Profile-Hash) -cne $ExpectedProfileSha256){throw 'Profile changed before repair'}
  $null=Check-Idle
  Stop-ScheduledTask -TaskName $taskName
  $stopped=Stop-WorkspaceOwnedRuntime $owner
  if($HideConsole){
    & node (Join-Path $PSScriptRoot 'install-windows-task.mjs') repair --surface business-full
    if($LASTEXITCODE -ne 0){Start-ScheduledTask -TaskName $taskName;throw 'Hidden launcher installation failed; previous task restarted'}
  }else{Start-ScheduledTask -TaskName $taskName}
  $post=$null
  for($attempt=0;$attempt -lt 15;$attempt++){
    Start-Sleep -Seconds 1;$post=Check-Idle
    if($post.state.state -eq 'ready' -and $post.state.serverReady -eq $true -and $post.state.tunnel.ready -eq $true){break}
  }
  $fresh=Get-WorkspaceOwnedRuntime 'business-full'
  if($post.state.state -ne 'ready' -or $fresh.instanceId -ceq $owner.instanceId -or (Get-ScheduledTask -TaskName $taskName).State -ne 'Running' -or $post.native.pid -ne $idle.native.pid){throw 'Fresh task-owned runtime did not become ready'}
  @{terminal='PASS_REPAIRED_OWNER';oldInstanceId=$owner.instanceId;freshInstanceId=$fresh.instanceId;ownedProcessCount=$owner.processes.Count;ownedTreeStopped=$stopped.stopped;nativePidPreserved=$true;profileSha256=(Profile-Hash);profileChange=$false} | ConvertTo-Json
}finally{$lock.Dispose();Remove-Item -LiteralPath $lockFile -Force}
