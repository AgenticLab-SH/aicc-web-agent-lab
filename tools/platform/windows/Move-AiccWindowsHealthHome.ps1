#requires -Version 7.0
$ErrorActionPreference='Stop'
$ownerRoot=[Environment]::GetFolderPath('UserProfile')
$stateRoot=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path $ownerRoot '.ai-control-center'}
$oldHome=Join-Path $ownerRoot '.codex\windows-health';$newHome=Join-Path $stateRoot 'runtime\windows-health'
$oldReceipt=Join-Path $oldHome 'install-state.json';$newReceipt=Join-Path $newHome 'install-state.json'
if(Test-Path -LiteralPath $newReceipt){@{changed=$false;alreadyMigrated=$true}|ConvertTo-Json;return}
$registryFile=Join-Path $stateRoot 'runtime\components.json'
$lock=[IO.File]::Open($registryFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
  $registryBefore=[IO.File]::ReadAllText($registryFile);$registry=$registryBefore|ConvertFrom-Json -AsHashtable
  if($registry.schemaVersion -ne 1 -or $registry.root -ne $stateRoot){throw 'Unknown home registry'}
  $before=[IO.File]::ReadAllText($oldReceipt);$health=$before|ConvertFrom-Json -AsHashtable
  if($health.schemaVersion -ne 1 -or $health.releaseHash -notmatch '^[a-f0-9]{64}$' -or $health.releaseDir -ne (Join-Path $oldHome ('releases\'+$health.releaseHash))){throw 'Unknown health ownership'}
  $oldRelease=$health.releaseDir;$newRelease=Join-Path $stateRoot ('releases\windows-health\'+$health.releaseHash)
  if((Get-Item -LiteralPath $oldRelease).LinkType -or (Get-ChildItem -LiteralPath $oldRelease -Recurse -Force|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}|Select-Object -First 1)){throw 'Linked health release refused'}
  if(Test-Path -LiteralPath $newRelease){throw 'Unknown health candidate preserved'}
  New-Item -ItemType Directory -Path (Split-Path $newRelease -Parent) -Force|Out-Null
  Copy-Item -LiteralPath $oldRelease -Destination $newRelease -Recurse
  $manifest=Get-Content -LiteralPath (Join-Path $newRelease 'manifest.json') -Raw|ConvertFrom-Json -AsHashtable
  foreach($relative in $manifest.files.Keys){$target=[IO.Path]::GetFullPath((Join-Path $newRelease $relative));if(-not $target.StartsWith($newRelease+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.files[$relative]){throw 'Health copy failed; no entry change'}}
  foreach($record in $health.changedFiles.Values){
    if(-not $record.preimage.exists){continue}
    $oldBackup=[IO.Path]::GetFullPath($record.preimage.path)
    if(-not $oldBackup.StartsWith((Join-Path $oldHome 'backups')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $oldBackup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.preimage.sha256){throw 'Health recovery source changed'}
    $newBackup=Join-Path $newHome ([IO.Path]::GetRelativePath($oldHome,$oldBackup));New-Item -ItemType Directory -Path (Split-Path $newBackup -Parent) -Force|Out-Null;Copy-Item -LiteralPath $oldBackup -Destination $newBackup
    $record.preimage.path=$newBackup
  }
  $wrapper=Join-Path $health.installDir 'aicc.ps1';$wrapperBefore=[IO.File]::ReadAllText($wrapper)
  if((Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $health.changedFiles['aicc.ps1'].installedSha256){throw 'Health wrapper changed before relocation'}
  $oldRunner=Join-Path $oldRelease 'run-windows-health.mjs';$newRunner=Join-Path $newRelease 'run-windows-health.mjs'
  if(($wrapperBefore.Split($oldRunner,[StringSplitOptions]::None)).Count -ne 2){throw 'Exact health runner branch required'}
  $wrapperAfter=$wrapperBefore.Replace($oldRunner,$newRunner)
  $backupRoot=Join-Path $stateRoot ('backups\runtime-layout\windows-health-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $backupRoot -Force|Out-Null
  Copy-Item -LiteralPath $wrapper -Destination (Join-Path $backupRoot 'aicc.ps1.before');Copy-Item -LiteralPath $oldReceipt -Destination (Join-Path $backupRoot 'install-state.before.json')
  if([IO.File]::ReadAllText($oldReceipt) -cne $before -or [IO.File]::ReadAllText($registryFile) -cne $registryBefore -or [IO.File]::ReadAllText($wrapper) -cne $wrapperBefore){throw 'Health relocation generation changed'}
  $health.releaseDir=$newRelease;$health.relocatedAt=[DateTimeOffset]::Now.ToString('o')
  $temporary=$wrapper+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($temporary,$wrapperAfter,[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $wrapper -Force
  try{
    $health.changedFiles['aicc.ps1'].installedSha256=(Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant()
    New-Item -ItemType Directory -Path $newHome -Force|Out-Null;[IO.File]::WriteAllText($newReceipt,($health|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))
    $registry.components['windows-health']=@{entry=$newRunner;runtime=$registry.components.cli.runtime;releaseRoot=$newRelease;location='managed';releaseHash=$health.releaseHash;previousRelease=$oldRelease;recovery=$backupRoot}
    $temporary=$registryFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($temporary,($registry|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $registryFile -Force
  }catch{Copy-Item -LiteralPath (Join-Path $backupRoot 'aicc.ps1.before') -Destination $wrapper -Force;throw}
  @{migrated=$true;release=$newRelease;state=$newReceipt;sourcePreserved=$true;healthBranchPreserved=$true;recovery=$backupRoot}|ConvertTo-Json
}finally{$lock.Dispose()}
