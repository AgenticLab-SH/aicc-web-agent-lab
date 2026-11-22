#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Plan','Apply')][string]$Action='Plan')
$ErrorActionPreference='Stop'
$ownerRoot=[Environment]::GetFolderPath('UserProfile')
$stateRoot=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path $ownerRoot '.ai-control-center'}
$registry=Join-Path $stateRoot 'runtime\components.json'
$plan=@{home=$stateRoot;bin=(Join-Path $stateRoot 'bin');releases=(Join-Path $stateRoot 'releases');registry=$registry;liveMoves=$false;authMoves=$false;legacyRebind='idle-only component installer';action=$Action}
if($Action -eq 'Apply'){
  foreach($relative in @('bin','releases','runtime','backups\runtime-layout')){
    $target=Join-Path $stateRoot $relative
    if((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).LinkType){throw 'Linked AICC runtime directory refused'}
    New-Item -ItemType Directory -Path $target -Force|Out-Null
  }
  $registryLock=[IO.File]::Open($registry+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
  if(-not(Test-Path -LiteralPath $registry)){
    $content=@{schemaVersion=1;root=$stateRoot;components=@{}}|ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($registry,$content+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  }
  $before=[IO.File]::ReadAllText($registry)
  $current=$before|ConvertFrom-Json -AsHashtable
  if($current.schemaVersion -ne 1 -or $current.root -ne $stateRoot){throw 'Unknown registry preserved'}
  $node=(Get-Command node.exe -ErrorAction Stop|Select-Object -First 1).Source
  $sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
  $homeSources=@('src/runtime-layout.mjs','src/private-home.mjs','tools/platform/windows/home-control.mjs')
  $homeHashes=[ordered]@{};foreach($relative in $homeSources){$homeHashes[$relative]=(Get-FileHash -LiteralPath (Join-Path $sourceRoot $relative) -Algorithm SHA256).Hash}
  $hasher=[Security.Cryptography.SHA256]::Create();try{$homeReleaseHash=[Convert]::ToHexString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($homeHashes|ConvertTo-Json -Compress)))).ToLowerInvariant()}finally{$hasher.Dispose()}
  $homeRelease=Join-Path $stateRoot ('releases\home-control\'+$homeReleaseHash.Substring(0,16))
  foreach($relative in $homeSources){$destination=Join-Path $homeRelease $relative;New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force|Out-Null;if(-not(Test-Path -LiteralPath $destination)){Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $destination}elseif((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $homeHashes[$relative]){throw 'Immutable home control changed'}}
  $current.components['home-control']=@{entry=(Join-Path $homeRelease 'tools\platform\windows\home-control.mjs');runtime=$node;releaseRoot=$homeRelease;location='managed';sourceHashes=$homeHashes}
  $module=Join-Path (Split-Path $node -Parent) 'node_modules\open-aicc'
  if(Test-Path -LiteralPath $module){
    $item=Get-Item -LiteralPath $module
    if($item.LinkType){
      $cliRoot=[IO.Path]::GetFullPath(@($item.Target)[0]);$legacy=Join-Path $ownerRoot '.codex\releases\open-aicc'
      if($cliRoot.StartsWith($legacy+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and (-not $current.components.cli -or $current.components.cli.location -eq 'legacy-frozen')){
        $current.components.cli=@{entry=(Join-Path $cliRoot 'bin\aicc');runtime=$node;location='legacy-frozen';migration='idle component copy and owner rebind; no junction move'}
      }
    }
  }
  $temporary=$registry+'.'+[guid]::NewGuid().ToString()+'.tmp'
  [IO.File]::WriteAllText($temporary,($current|ConvertTo-Json -Depth 10)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  if([IO.File]::ReadAllText($registry) -cne $before){Remove-Item -LiteralPath $temporary;throw 'Component registry changed; preserved without overwrite'}
  Move-Item -LiteralPath $temporary -Destination $registry -Force
  }finally{$registryLock.Dispose()}
  $homeLauncher=Join-Path $stateRoot 'bin\Invoke-AiccHomeComponent.ps1'
  if(Test-Path -LiteralPath $homeLauncher){Copy-Item -LiteralPath $homeLauncher -Destination (Join-Path $stateRoot ('backups\runtime-layout\home-launcher-'+[guid]::NewGuid().ToString('N')+'.ps1'))}
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Invoke-AiccHomeComponent.ps1') -Destination $homeLauncher -Force
  $cliLauncher=Join-Path $stateRoot 'bin\aicc-home.cmd'
  $launcherText='@echo off'+[Environment]::NewLine+'pwsh.exe -NoLogo -NoProfile -File "%~dp0Invoke-AiccHomeComponent.ps1" -Component cli %*'+[Environment]::NewLine+'exit /b %errorlevel%'+[Environment]::NewLine
  [IO.File]::WriteAllText($cliLauncher,$launcherText,[Text.UTF8Encoding]::new($false))
  # Native services remain in place; upcoming installers own their component cutover.
  $plan.initialized=$true
}
$plan|ConvertTo-Json -Depth 4
