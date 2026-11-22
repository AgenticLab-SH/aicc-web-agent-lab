#requires -Version 5.1
#requires -RunAsAdministrator
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$admin=[Security.Principal.WindowsPrincipal]$identity
if(-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Windows UAC approval is required'}
$tasks=@(Get-ScheduledTask -TaskName 'Codex-Web-GPT-Logon-*' -ErrorAction Stop | Where-Object {
  try{
    $d=$_.Description|ConvertFrom-Json -ErrorAction Stop
    $d.managedBy -ceq 'codex-chatgpt-web.windows-watch/v2' -and $d.sid -ceq $identity.User.Value
  }catch{$false}
})
if($tasks.Count -ne 1){throw 'One exact current-user managed bridge task is required'}
$task=$tasks[0];$owner=$task.Description|ConvertFrom-Json -ErrorAction Stop
$stateRoot=[IO.Path]::GetFullPath([string]$owner.home)
if($stateRoot -ine (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-chatgpt-web')){
  throw 'Admin account is not the original bridge owner; no cross-account operation'
}
$configPath=Join-Path $stateRoot 'config.json'
$rootItem=Get-Item -LiteralPath $stateRoot -Force -ErrorAction Stop
if(-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe state root'}
$config=Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
if($config.runtimeOwner -cne 'service' -or $config.host -cne '127.0.0.1' -or $config.port -ne 17841 -or
   @($config.runtimeCommand).Count -ne 2){throw 'Installed exact Windows service identity required'}
$runtimeExe=[IO.Path]::GetFullPath([string]$config.runtimeCommand[0])
$runtimeEntry=[IO.Path]::GetFullPath([string]$config.runtimeCommand[1])
if(-not($runtimeExe.StartsWith($stateRoot+'\',[StringComparison]::OrdinalIgnoreCase)) -or
   -not($runtimeEntry.StartsWith($stateRoot+'\',[StringComparison]::OrdinalIgnoreCase))){throw 'Pinned runtime path outside owner root'}
$listeners=@(Get-NetTCPConnection -LocalPort 17841 -State Listen -ErrorAction SilentlyContinue)
$markerPath=Join-Path $stateRoot 'runtime\windows-process.json'
$marker=$null
if(Test-Path -LiteralPath $markerPath){$marker=Get-Content -LiteralPath $markerPath -Raw|ConvertFrom-Json}
$candidates=@(Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='node.exe' OR Name='codex-chatgpt-web.exe' OR Name='Codex Web GPT.exe'" -ErrorAction Stop)
$rows=@(foreach($p in $candidates){
  $exe=if($p.ExecutablePath){[string]$p.ExecutablePath}else{$null}
  $command=if($p.CommandLine){[string]$p.CommandLine}else{$null}
  [ordered]@{
    pid=[int]$p.ProcessId
    parentPid=[int]$p.ParentProcessId
    name=[string]$p.Name
    created=[string]$p.CreationDate.ToUniversalTime().ToString('o')
    imageKnown=[bool]$exe
    commandKnown=[bool]$command
    pinnedBinary=[bool]($exe -and $exe.Equals($runtimeExe,[StringComparison]::OrdinalIgnoreCase))
    ownerScriptArgument=[bool]($command -and $command.IndexOf($runtimeEntry,[StringComparison]::OrdinalIgnoreCase) -ge 0)
    isListener=[bool]@($listeners|Where-Object{$_.OwningProcess -eq $p.ProcessId}).Count
    isMarkerPid=[bool]($marker -and [int]$marker.pid -eq [int]$p.ProcessId)
  }
})
$ambiguous=@($rows|Where-Object{-not $_.imageKnown -or -not $_.commandKnown})
$owners=@($rows|Where-Object{$_.pinnedBinary -or $_.ownerScriptArgument -or $_.isListener -or $_.isMarkerPid})
$summary=[ordered]@{
  schemaVersion=1
  kind='aicc-webbridge-elevated-identity-diagnostic/v1'
  generatedKst=[DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(9)).ToString('o')
  runAsOwnerSidVerified=$true
  noRuntimeOrTaskMutation=$true
  taskName=$task.TaskName
  listenerCount=$listeners.Count
  markerPid=if($marker){[int]$marker.pid}else{$null}
  candidateCount=$rows.Count
  missingIdentityCount=$ambiguous.Count
  matchingRuntimeOrMarkerCount=$owners.Count
  state=if($ambiguous.Count){'HOLD_IDENTITY_UNREADABLE'}elseif($owners.Count -or $listeners.Count){'REVIEW_OWNED_PROCESS_EXISTS'}else{'ELEVATED_DIAGNOSTIC_NO_OWNER_CANDIDATE'}
  processes=$rows
}
$dest=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center\reports\bridge-identity'
if(-not(Test-Path -LiteralPath $dest)){[void](New-Item -ItemType Directory -Path $dest -Force -ErrorAction Stop)}
if((Get-Item -LiteralPath $dest -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked diagnostic directory refused'}
$name='bridge-owner-review-'+[DateTimeOffset]::Now.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)+'.json'
$final=Join-Path $dest $name
$tmp=Join-Path $dest ('.tmp-'+[guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($tmp,($summary|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
[IO.File]::Move($tmp,$final)
Write-Host ('RESULT: '+$summary.state)
Write-Host ('Bridge listeners: '+$listeners.Count+' | identity unreadable: '+$ambiguous.Count+' | owner candidates: '+$owners.Count)
Write-Host ('Read-only report: '+$final)
Write-Host 'No task, service, account, user files or permissions were changed.'
