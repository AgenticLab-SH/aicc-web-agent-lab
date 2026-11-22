#requires -Version 7.0
$ErrorActionPreference='Stop'
$ownerRoot=[Environment]::GetFolderPath('UserProfile');$stateRoot=Join-Path $ownerRoot '.ai-control-center'
$oldPointer=Join-Path $ownerRoot '.codex-chatgpt-web\app-manager\current.json'
$newState=Join-Path $stateRoot 'runtime\app-manager';$newPointer=Join-Path $newState 'current.json'
if(Test-Path -LiteralPath $newPointer){throw 'Existing managed pointer must be reconciled, never overwritten'}
$pointerBefore=[IO.File]::ReadAllText($oldPointer);$pointer=$pointerBefore|ConvertFrom-Json -AsHashtable
if($pointer.releaseHash -notmatch '^[a-f0-9]{64}$' -or $pointer.release -ine (Join-Path $ownerRoot ('.codex-chatgpt-web\app-manager\releases\'+$pointer.releaseHash)) -or (Get-Item -LiteralPath $pointer.release).LinkType){throw 'Exact original sealed manager required'}
if(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -and ($_.CommandLine.Contains($pointer.release) -or $_.CommandLine.Contains('manage-chatgpt-apps.ps1')) -and $_.ProcessId -ne $PID}){throw 'Manager owner is active'}
$registryFile=Join-Path $stateRoot 'runtime\components.json'
$lock=[IO.File]::Open($registryFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
function Hash-File([string]$File){(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
try{
  $registryBefore=[IO.File]::ReadAllText($registryFile);$registry=$registryBefore|ConvertFrom-Json -AsHashtable
  $manifest=Get-Content -LiteralPath (Join-Path $pointer.release 'manifest.json') -Raw|ConvertFrom-Json -AsHashtable
  if((Hash-File (Join-Path $pointer.release 'manifest.json')) -cne $pointer.manifestSha256 -or $manifest.releaseHash -cne $pointer.releaseHash){throw 'Original manifest changed'}
  $release=Join-Path $stateRoot ('releases\app-manager\'+$pointer.releaseHash)
  if(Test-Path -LiteralPath $release){throw 'Unknown manager candidate preserved'}
  New-Item -ItemType Directory -Path (Split-Path $release -Parent) -Force|Out-Null
  Copy-Item -LiteralPath $pointer.release -Destination $release -Recurse
  foreach($name in $manifest.files.Keys){if($name -notin @('manager.mjs','chatgpt-app-sync-worker.mjs','driver.mjs') -or (Hash-File (Join-Path $release $name)) -cne $manifest.files[$name]){throw 'Sealed manager copy changed'}}
  $runtimeDir=Join-Path $ownerRoot 'AppData\Local\Programs\AICC-Tools\node-v22.23.2-win-x64'
  $shim=Join-Path $runtimeDir 'aicc-apps.ps1';$shimBefore=[IO.File]::ReadAllText($shim)
  $sourceRunner='C:\demo\projects\ai-platform\repos\codex-chatgpt-web-private\scripts\manage-chatgpt-apps.ps1'
  if($shimBefore.Split($sourceRunner,[StringSplitOptions]::None).Count -ne 2){throw 'Original manager launcher changed'}
  $runnerHash=Hash-File $sourceRunner;$runnerRoot=Join-Path $stateRoot ('releases\app-manager-launcher\'+$runnerHash)
  New-Item -ItemType Directory -Path $runnerRoot -Force|Out-Null
  $runner=Join-Path $runnerRoot 'manage-chatgpt-apps.ps1'
  if(Test-Path -LiteralPath $runner){if((Hash-File $runner) -cne $runnerHash){throw 'Immutable runner changed'}}else{Copy-Item -LiteralPath $sourceRunner -Destination $runner}
  $policyBytes=[IO.File]::ReadAllBytes($pointer.policyFile)
  $policyObject=[Text.Encoding]::UTF8.GetString($policyBytes)|ConvertFrom-Json
  if($policyObject.schemaVersion -ne 1){throw 'Original policy schema unknown'}
  $backup=Join-Path $stateRoot ('backups\runtime-layout\app-manager-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $backup|Out-Null
  Copy-Item -LiteralPath $oldPointer -Destination (Join-Path $backup 'pointer.before.json');Copy-Item -LiteralPath $shim -Destination (Join-Path $backup 'launcher.before.ps1');Copy-Item -LiteralPath $registryFile -Destination (Join-Path $backup 'components.before.json')
  if([IO.File]::ReadAllText($oldPointer) -cne $pointerBefore -or [IO.File]::ReadAllText($shim) -cne $shimBefore -or [IO.File]::ReadAllText($registryFile) -cne $registryBefore -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($pointer.policyFile)) -cne [Convert]::ToBase64String($policyBytes)){throw 'Manager relocation generation changed'}
  New-Item -ItemType Directory -Path $newState -Force|Out-Null
  $policyFile=Join-Path $newState 'policy.json';[IO.File]::WriteAllBytes($policyFile,$policyBytes)
  $pointer.release=$release;$pointer.driverFile=Join-Path $release 'driver.mjs';$pointer.policyFile=$policyFile
  [IO.File]::WriteAllText($newPointer,($pointer|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
  try{
    [IO.File]::WriteAllText($shim,$shimBefore.Replace($sourceRunner,$runner),[Text.UTF8Encoding]::new($false))
    $registry.components['app-manager']=@{location='managed';entry=(Join-Path $release 'manager.mjs');releaseRoot=$release;releaseHash=$pointer.releaseHash;pointer=$newPointer;policy=$policyFile;previousPointer=$oldPointer;recovery=$backup;browserLeaseOwner='unchanged-native-home'}
    $registry.components['app-manager-launcher']=@{location='managed';entry=$runner;entryHash=$runnerHash;releaseRoot=$runnerRoot;recovery=$backup}
    $temporary=$registryFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($temporary,($registry|ConvertTo-Json -Depth 18),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $registryFile -Force
  }catch{Copy-Item -LiteralPath (Join-Path $backup 'launcher.before.ps1') -Destination $shim -Force;Move-Item -LiteralPath $newPointer -Destination (Join-Path $backup 'pointer.failed.json');throw}
  @{terminal='PASS_RELOCATED_MANAGER';release=$release;pointer=$newPointer;policyBytesPreserved=$true;remoteMutation=$false;browserStatePreserved=$true;recovery=$backup}|ConvertTo-Json
}finally{$lock.Dispose()}
