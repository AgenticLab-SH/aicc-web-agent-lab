#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('business-full','personal-read-fetch')][string]$OwnedRuntimeSurface='business-full')
$ErrorActionPreference='Stop'
function Get-WorkspaceOwnedRuntime([string]$Surface){
  $taskHome=[Environment]::GetFolderPath('UserProfile')
  $directory=if($Surface -eq 'business-full'){'workspace-mcp'}else{'workspace-mcp-personal-read-fetch'}
  $alias=if($Surface -eq 'business-full'){'aicc-workspace'}else{'aicc-workspace-personal-read-fetch'}
  $root=Join-Path $taskHome ('.ai-control-center\'+$directory)
  $markerFile=Join-Path $root 'runtime\remote-authority-status.json'
  $lockFile=Join-Path $root 'tunnel\runtime\windows-helper.lock'
  $pidFile=Join-Path $root ('tunnel\runtime\'+$alias+'.pid')
  foreach($file in @($markerFile,$lockFile,$pidFile)){if((Get-Item -LiteralPath $file).LinkType){throw 'Linked ownership evidence refused'}}
  $marker=Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json
  $lock=Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
  $tunnelPid=[int](Get-Content -LiteralPath $pidFile -Raw)
  if($lock.surfaceProfile -cne $Surface -or $lock.pid -lt 1 -or $marker.process.pid -lt 1 -or $marker.supervisor.pid -lt 1 -or $tunnelPid -lt 1){throw 'Exact runtime ownership evidence required'}
  $all=@(Get-CimInstance Win32_Process)
  $byPid=@{};foreach($item in $all){$byPid[[int]$item.ProcessId]=$item}
  $helper=$byPid[[int]$lock.pid];$tunnel=$byPid[$tunnelPid];$server=$byPid[[int]$marker.process.pid];$supervisor=$byPid[[int]$marker.supervisor.pid]
  if(-not $server -or -not $supervisor){throw 'Recorded runtime is absent; inspect instead of killing another process'}
  $orphaned=(-not $helper -and -not $tunnel)
  if((-not $helper -or -not $tunnel) -and -not $orphaned){throw 'Partial helper/Tunnel ownership is unknown'}
  $helperSource=Join-Path $PSScriptRoot 'windows-tunnel-secret.mjs'
  $registryFile=Join-Path $taskHome '.ai-control-center\runtime\components.json'
  $registry=if(Test-Path -LiteralPath $registryFile){Get-Content -LiteralPath $registryFile -Raw|ConvertFrom-Json}else{$null}
  $managedHelper=$registry.components.'workspace-host'
  if($managedHelper -and $helper -and $helper.CommandLine.Contains($managedHelper.entry)){
    if(-not $managedHelper.entry.StartsWith((Join-Path $taskHome '.ai-control-center\releases\workspace-host\'),[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $managedHelper.entry).LinkType -or (Get-FileHash -LiteralPath $managedHelper.entry -Algorithm SHA256).Hash.ToLowerInvariant() -cne $managedHelper.entryHash){throw 'Managed helper fingerprint differs'}
    $helperSource=$managedHelper.entry
  }
  if(-not $orphaned){
    if($helper.Name -ine 'node.exe' -or -not $helper.CommandLine.Contains($helperSource) -or -not $helper.CommandLine.Contains($root.Substring(0,$root.LastIndexOf('\'))) -or $helper.CommandLine -notmatch ('--surface\s+'+[regex]::Escape($Surface)+'(?:\s|$)')){throw 'Helper command identity differs'}
    if($tunnel.ExecutablePath -ine (Join-Path $root 'bin\tunnel-client.exe') -or $tunnel.ParentProcessId -ne $helper.ProcessId -or -not $tunnel.CommandLine.Contains($alias) -or -not $tunnel.CommandLine.Contains((Join-Path $root 'tunnel\profiles'))){throw 'Tunnel is not the exact helper child'}
  }
  $serverCommand=$server.CommandLine.Replace('/','\')
  if($server.Name -ine 'node.exe' -or $server.ParentProcessId -ne $supervisor.ProcessId -or $serverCommand -notmatch 'components[\\/]workspace-mcp[\\/]server\.mjs' -or -not $serverCommand.Contains((Join-Path $root 'config.json'))){throw 'Workspace server identity differs'}
  if($supervisor.ProcessId -ne $tunnelPid){
    $supervisorCommand=$supervisor.CommandLine.Replace('/','\')
    $gateway=$registry.components.'unified-mcp'
    $managedGateway=$gateway -and $supervisorCommand.Contains($gateway.entry)
    if($managedGateway -and (-not $gateway.entry.StartsWith((Join-Path $taskHome '.ai-control-center\releases\unified-mcp\'),[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $gateway.entry).LinkType -or (Get-FileHash -LiteralPath $gateway.entry -Algorithm SHA256).Hash.ToLowerInvariant() -cne $gateway.entryHash)){throw 'Managed gateway fingerprint differs'}
    if($supervisor.Name -ine 'node.exe' -or $supervisor.ParentProcessId -ne $tunnelPid -or (-not $managedGateway -and -not $supervisorCommand.Contains((Join-Path $taskHome '.codex-chatgpt-web\unified-mcp\releases'))) -or $supervisor.CommandLine -notmatch 'gateway\.cjs'){throw 'Unified supervisor is not the exact Tunnel child'}
  }
  if($orphaned){$helper=$supervisor} # Only the proven orphan's subtree can be stopped.
  $sha=[Security.Cryptography.SHA256]::Create()
  try{
    foreach($pair in @(@($server,$marker.process.processStartToken),@($supervisor,$marker.supervisor.processStartToken))){
      $ticks=[Diagnostics.Process]::GetProcessById([int]$pair[0].ProcessId).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
      $token=[Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$($pair[0].ProcessId)`0win32-start-ticks:$ticks"))).ToLowerInvariant()
      if($token -cne $pair[1]){throw 'Workspace process start token changed'}
    }
    $owned=@{};$owned[[int]$helper.ProcessId]=$helper
    do{
      $added=0
      foreach($item in $all){if($owned.ContainsKey([int]$item.ParentProcessId) -and -not $owned.ContainsKey([int]$item.ProcessId)){$owned[[int]$item.ProcessId]=$item;$added++}}
    }while($added -gt 0)
    if((-not $orphaned -and -not $owned.ContainsKey($tunnelPid)) -or -not $owned.ContainsKey([int]$server.ProcessId)){throw 'Ownership tree is incomplete'}
    $snapshots=@(foreach($childInfo in $owned.Values){
      if($null -eq $childInfo.CommandLine -and $childInfo.Name -ine 'conhost.exe'){
        if(-not (Get-Process -Id $childInfo.ProcessId -ErrorAction SilentlyContinue)){continue}
        throw 'Owned child command identity is unavailable'
      }
      @{pid=[int]$childInfo.ProcessId;parent=[int]$childInfo.ParentProcessId;created=$childInfo.CreationDate.ToUniversalTime().Ticks.ToString();
        image=$childInfo.ExecutablePath;commandHash=[Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$childInfo.CommandLine))).ToLowerInvariant()}
    }) | Sort-Object pid
    return @{surface=$Surface;helperPid=[int]$helper.ProcessId;tunnelPid=$tunnelPid;serverPid=[int]$server.ProcessId;instanceId=$marker.instanceId;processes=$snapshots;orphaned=$orphaned}
  }finally{$sha.Dispose()}
}
function Stop-WorkspaceOwnedRuntime($Snapshot){
  $alive=@(Get-CimInstance Win32_Process | Where-Object {
    $taskCurrent=$_
    @($Snapshot.processes | Where-Object { $_.pid -eq $taskCurrent.ProcessId -and $_.created -ceq $taskCurrent.CreationDate.ToUniversalTime().Ticks.ToString() }).Count -gt 0
  })
  if($alive.Count -eq 0){return @{stopped=$true;processCount=$Snapshot.processes.Count;instanceId=$Snapshot.instanceId}}
  $fresh=Get-WorkspaceOwnedRuntime $Snapshot.surface
  if($fresh.helperPid -ne $Snapshot.helperPid -or $fresh.instanceId -cne $Snapshot.instanceId -or $fresh.processes.Count -ne $Snapshot.processes.Count){throw 'Runtime ownership changed before stop'}
  foreach($expected in $Snapshot.processes){
    $actual=@($fresh.processes | Where-Object pid -eq $expected.pid)
    if($actual.Count -ne 1 -or $actual[0].created -cne $expected.created -or $actual[0].commandHash -cne $expected.commandHash -or $actual[0].image -cne $expected.image){throw 'Owned process identity changed before stop'}
  }
  & taskkill.exe /PID $fresh.helperPid /T /F | Out-Null
  $taskKillExit=$LASTEXITCODE
  for($attempt=0;$attempt -lt 30;$attempt++){
    $remaining=@(Get-CimInstance Win32_Process | Where-Object {
      $taskCurrent=$_
      @($Snapshot.processes | Where-Object { $_.pid -eq $taskCurrent.ProcessId -and $_.created -ceq $taskCurrent.CreationDate.ToUniversalTime().Ticks.ToString() }).Count -gt 0
    })
    if($remaining.Count -eq 0){return @{stopped=$true;processCount=$Snapshot.processes.Count;instanceId=$Snapshot.instanceId}}
    Start-Sleep -Milliseconds 500
  }
  if($taskKillExit -ne 0){throw 'Exact Workspace tree stop failed; owned processes remain'}
  throw 'Owned Workspace child processes remain; no restart'
}
if($MyInvocation.InvocationName -ne '.'){
  $snapshot=Get-WorkspaceOwnedRuntime $OwnedRuntimeSurface
  @{terminal='DRY_RUN';ownership=$snapshot} | ConvertTo-Json -Depth 6
}
