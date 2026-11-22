#requires -Version 7.0
[CmdletBinding()]
param([switch]$CheckOnly,[ValidateSet('dashboard','codex-auth','usage','logs','models','providers')][string]$Page='dashboard')
$ErrorActionPreference='Stop'

$owner=[Environment]::GetFolderPath('UserProfile')
$local=Join-Path $owner '.ai-control-center/runtime/ocx-local/current.json'
if(Test-Path -LiteralPath $local){
  # On Windows, 10100/10101 serve local OCX data and a connected-client GUI.
  # The account owner and full management GUI remain on A1 through SSH 10102.
  $clientFile=Join-Path $owner '.opencodex/config.json'
  $client=Get-Content -LiteralPath $clientFile -Raw -Encoding UTF8|ConvertFrom-Json
  $target='http://localhost:10102'
  if($client.runtimeRole -cne 'client' -or $client.client.managementTransport -cne 'relay' -or
     $client.client.managementUrl -cne $target){
    throw 'OCX management owner differs; not opening an unverified dashboard.'
  }
  $listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 10102 -State Listen -ErrorAction SilentlyContinue)
  if($listeners.Count -ne 1){throw 'A1 hub tunnel (10102) is unavailable; local 10100 is not the management dashboard.'}
  $ownerProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listeners[0].OwningProcess) -ErrorAction Stop
  if($ownerProcess.Name -cne 'ssh.exe' -or
     $ownerProcess.CommandLine -notmatch 'HostKeyAlias=aicc-oracle-a1' -or
     $ownerProcess.CommandLine -notmatch '127\.0\.0\.1:10102:127\.0\.0\.1:10102'){
    throw 'Port 10102 is not owned by the registered A1 management tunnel.'
  }
  $response=Invoke-WebRequest -Uri 'http://127.0.0.1:10102/' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
  if([int]$response.StatusCode -ne 200 -or
     [string]$response.Content -notmatch '(?i)opencodex-runtime-role[^>]*content="hub"'){
    throw 'The A1 management dashboard did not identify itself as an OCX hub.'
  }
  if($CheckOnly){
    [pscustomobject]@{status='PASS';opensBrowser=$false;managementUrl=$target;
       role='hub';transport='registered-ssh-tunnel';localInferencePorts=@(10100,10101)}|ConvertTo-Json -Compress
    return
  }
  $chrome=Get-Command chrome.exe -ErrorAction SilentlyContinue|Select-Object -First 1
  $browser=if($chrome){$chrome.Source}else{@(
    (Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google/Chrome/Application/chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google/Chrome/Application/chrome.exe')
  )|Where-Object {Test-Path -LiteralPath $_ -PathType Leaf}|Select-Object -First 1}
  if(-not $browser){throw 'Chrome is unavailable; open http://localhost:10102 manually.'}
  Start-Process -FilePath $browser -ArgumentList '--new-tab',($target+'/#'+$Page)
  return
}
if($CheckOnly){throw 'No registered Windows OCX client was found.'}
if($PSBoundParameters.ContainsKey('Page')){throw 'A registered management owner is required for a dashboard page.'}
$dependency=Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'
if(-not(Test-Path -LiteralPath $dependency)){throw 'Registered browser runtime is missing; use aicc repair.'}
node (Join-Path $PSScriptRoot 'verify-client-dashboard.mjs') $dependency --open
exit $LASTEXITCODE
