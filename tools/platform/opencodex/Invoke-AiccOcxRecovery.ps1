#requires -Version 7.0
[CmdletBinding()]
param([switch]$Open)
$ErrorActionPreference='Stop'
$localRegistry=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center/runtime/ocx-local/current.json'
if(Test-Path -LiteralPath $localRegistry){
  & (Join-Path $PSScriptRoot 'Invoke-AiccLocalOcx.ps1') -Action Recover
  if($Open){Start-Process 'http://localhost:10100'}
  return
}
# Start only an absent registered owner. Healthy services are left running.
# No account, Native route, service token or package repair is performed here.
$ownerHome=[Environment]::GetFolderPath('UserProfile')
$ocxHome=Join-Path $ownerHome '.opencodex'
$nativeConfig=Join-Path $ownerHome '.codex/config.toml'
function Assert-Regular([string]$Path){
  for($cursor=$Path;;$cursor=Split-Path $cursor -Parent){
    $item=Get-Item -LiteralPath $cursor
    if($item.LinkType){throw 'Linked recovery path refused.'}
    $parent=Split-Path $cursor -Parent
    if(-not $parent -or $parent -eq $cursor){break}
  }
  if((Get-Item -LiteralPath $Path).PSIsContainer){throw 'Regular recovery file required.'}
}
$stateFile=Join-Path $ocxHome 'service-state.json'
$configFile=Join-Path $ocxHome 'config.json'
$launcher=Join-Path $ocxHome 'opencodex-service-launcher.vbs'
$wrapper=Join-Path $ocxHome 'opencodex-service.cmd'
foreach($file in @($stateFile,$configFile,$launcher,$wrapper,$nativeConfig)){Assert-Regular $file}
$nativeHash=(Get-FileHash -LiteralPath $nativeConfig -Algorithm SHA256).Hash
$state=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$config=Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$cli=Join-Path $ownerHome '.bun/install/global/node_modules/@bitkyc08/opencodex/src/cli/index.ts'
$bun=Join-Path $ownerHome '.bun/install/global/node_modules/bun/bin/bun.exe'
if($state.backend -ne 'scheduler' -or $state.ownershipProtocolVersion -ne 1 -or $state.opencodexHome -ine $ocxHome -or $state.codexHome -ine (Join-Path $ownerHome '.codex') -or $state.cliPath -ine $cli -or $state.bunPath -ine $bun){throw 'Stock registered Windows OCX owner differs.'}
foreach($file in @($cli,$bun)){Assert-Regular $file}
if($config.runtimeRole -ne 'client' -or $config.clientIntegrations.codex -ne $false -or $config.client.serverUrl -notin @('http://localhost:10101','http://127.0.0.1:10101')){throw 'Separate upstream-only client is required.'}
$task=Get-ScheduledTask -TaskName 'opencodex-proxy'
if($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32/wscript.exe') -or $task.Actions[0].Arguments -cne ('/b /nologo "'+$launcher+'"')){throw 'Existing task action differs.'}
$preimage=@{}
foreach($file in @($stateFile,$configFile,$launcher,$wrapper)){$preimage[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash}
function Read-Ready{
  try {Invoke-RestMethod -Uri 'http://127.0.0.1:10100/readyz' -TimeoutSec 4 -NoProxy}catch{$null}
}
function Read-Listeners{
  $table=& (Join-Path $env:SystemRoot 'System32/netstat.exe') -ano -p TCP
  if($LASTEXITCODE -ne 0 -or -not $table){throw 'TCP inventory unavailable.'}
  $rows=0
  foreach($line in $table){
    if($line -notmatch '^\s*TCP\s+'){continue}
    if($line -notmatch '^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$'){throw 'TCP inventory malformed.'}
    $rows++
    $local=$Matches[1];$tcpState=$Matches[3];$processId=[int]$Matches[4]
    if($tcpState -notin @('LISTENING','ESTABLISHED','SYN_SENT','SYN_RECEIVED','FIN_WAIT_1','FIN_WAIT_2','CLOSE_WAIT','CLOSING','LAST_ACK','TIME_WAIT','CLOSED','DELETE_TCB')){throw 'TCP inventory state unknown.'}
    if($tcpState -eq 'LISTENING' -and $local -match ':10100$'){$processId}
  }
  if($rows -eq 0){throw 'TCP inventory empty or unknown.'}
}
function Assert-OwnedReady($Ready){
  if(-not $Ready -or $Ready.service -ne 'opencodex' -or $Ready.status -ne 'ready' -or $Ready.role -ne 'client' -or $Ready.port -ne 10100 -or $Ready.pid -le 0){throw 'OCX readiness is unconfirmed; do not repeat start.'}
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$Ready.pid)
  if(-not $process -or $process.ExecutablePath -ine $bun -or -not $process.CommandLine.Contains('"'+$cli+'"') -or $process.CommandLine -notmatch '\bstart --port 10100\b'){throw 'Live OCX owner differs.'}
  $listeners=@(Read-Listeners)
  if($listeners.Count -lt 1 -or @($listeners | Where-Object {$_ -ne $Ready.pid}).Count){throw 'Live OCX listener owner differs.'}
  $current=Get-ScheduledTask -TaskName 'opencodex-proxy'
  if([string]$current.State -ne 'Running'){throw 'Healthy OCX lacks its running registered wrapper; preserve it for inspection.'}
}
# Hub helper attests the existing systemd owner; a healthy hub is a no-op.
$hubText=& (Join-Path $PSScriptRoot 'Invoke-AiccOcxHubAccounts.ps1') -Action recover -Commit
if($LASTEXITCODE -ne 0){throw 'Hub recovery refused; local state was preserved.'}
$hub=$hubText | ConvertFrom-Json
if($hub.terminal -ne 'PASS'){throw 'Hub readiness is unconfirmed.'}
$ready=Read-Ready
$changed=$false
if(-not $ready){
  for($sample=0;$sample -lt 5;$sample++){
    if([string](Get-ScheduledTask -TaskName 'opencodex-proxy').State -ne 'Ready'){throw 'Local task is running or unknown; no duplicate start.'}
    if(@(Read-Listeners).Count){throw 'Unknown local listener; no start.'}
    $owners=@(Get-CimInstance Win32_Process | Where-Object {($_.CommandLine -and ($_.CommandLine.Contains($cli) -or $_.CommandLine.Contains($launcher) -or $_.CommandLine.Contains($wrapper))) -and $_.ProcessId -ne $PID})
    if($owners.Count){throw 'Existing OCX owner remains; no duplicate start.'}
    Start-Sleep -Milliseconds 200
  }
  foreach($file in $preimage.Keys){if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -cne $preimage[$file]){throw 'Recovery preimage changed.'}}
  if(@(Read-Listeners).Count -or [string](Get-ScheduledTask -TaskName 'opencodex-proxy').State -ne 'Ready'){throw 'Owner changed before start.'}
  Start-ScheduledTask -TaskName 'opencodex-proxy'
  $changed=$true
  for($attempt=0;$attempt -lt 25;$attempt++){$ready=Read-Ready;if($ready -and $ready.status -eq 'ready'){break};Start-Sleep -Seconds 1}
}
Assert-OwnedReady $ready
if($nativeHash -and (Get-FileHash -LiteralPath $nativeConfig -Algorithm SHA256).Hash -cne $nativeHash){throw 'Native config changed during recovery.'}
[pscustomobject]@{terminal='PASS';hubChanged=$hub.changed;localChanged=$changed;version=$ready.version;nativeRouteUnchanged=$true;dashboard='http://localhost:10100';authentication='Official hub pairing; new tab or reload may require a fresh code'} | ConvertTo-Json -Compress
if($Open){Start-Process 'http://localhost:10100'}
