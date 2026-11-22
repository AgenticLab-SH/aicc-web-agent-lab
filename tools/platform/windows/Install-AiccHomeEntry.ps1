#requires -Version 7.0
param([string]$ReconcileBackup,[switch]$WebStatusOnly)
$ErrorActionPreference='Stop'
$ownerRoot=[Environment]::GetFolderPath('UserProfile')
$stateRoot=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path $ownerRoot '.ai-control-center'}
$registry=Get-Content -LiteralPath (Join-Path $stateRoot 'runtime\components.json') -Raw|ConvertFrom-Json -AsHashtable
if($registry.schemaVersion -ne 1 -or $registry.root -ne $stateRoot -or $registry.components.cli.location -ne 'managed'){throw 'Managed home CLI required'}
$runtimeDirectory=Split-Path $registry.components.cli.runtime -Parent
$healthReceipt=Join-Path $stateRoot 'runtime\windows-health\install-state.json'
if(-not(Test-Path -LiteralPath $healthReceipt)){$healthReceipt=Join-Path $ownerRoot '.codex\windows-health\install-state.json'}
$healthBefore=if(Test-Path -LiteralPath $healthReceipt){[IO.File]::ReadAllText($healthReceipt)}else{$null}
$health=if($healthBefore){$healthBefore|ConvertFrom-Json -AsHashtable}else{$null}
if($ReconcileBackup){$ReconcileBackup=[IO.Path]::GetFullPath($ReconcileBackup);if(-not $ReconcileBackup.StartsWith((Join-Path $stateRoot 'backups\runtime-layout\home-entry-'),[StringComparison]::OrdinalIgnoreCase)){throw 'Owner home entry backup required'}}
$backupRoot=Join-Path $stateRoot ('backups\runtime-layout\home-entry-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backupRoot -Force|Out-Null
$psBranch=@'
# AICC_HOME_ENTRY_V1
if ($args.Count -gt 0 -and $args[0] -eq 'home') {
  $aiccEntryRoot=if($env:AICC_STATE_ROOT){$env:AICC_STATE_ROOT}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'}
  & (Join-Path $aiccEntryRoot 'bin\Invoke-AiccHomeComponent.ps1') -Component cli @args
  exit $LASTEXITCODE
}
'@
$cmdBranch=@'
REM AICC_HOME_ENTRY_V1
IF /I "%~1"=="home" GOTO aicc_home_entry
GOTO aicc_home_entry_end
:aicc_home_entry
IF DEFINED AICC_STATE_ROOT (CALL "%AICC_STATE_ROOT%\bin\aicc-home.cmd" %*) ELSE (CALL "%USERPROFILE%\.ai-control-center\bin\aicc-home.cmd" %*)
EXIT /B %ERRORLEVEL%
:aicc_home_entry_end
'@
foreach($name in @('aicc.ps1','aicc.cmd')){
  $file=Join-Path $runtimeDirectory $name
  if((Get-Item -LiteralPath $file).LinkType){throw 'Linked CLI shim preserved'}
  $liveBefore=[IO.File]::ReadAllText($file)
  if($WebStatusOnly -and $ReconcileBackup){throw 'Select one home entry action'}
  if($WebStatusOnly -and $liveBefore.Contains('AICC_HOME_WEB_STATUS_V1')){continue}
  if($liveBefore.Contains('AICC_HOME_ENTRY_V1') -and -not $ReconcileBackup -and -not $WebStatusOnly){continue}
  $before=if($ReconcileBackup){[IO.File]::ReadAllText((Join-Path $ReconcileBackup $name))}else{$liveBefore}
  if(-not $before.Contains('node_modules/open-aicc/bin/aicc') -and -not $before.Contains('node_modules\open-aicc\bin\aicc')){throw 'Unknown CLI shim preserved'}
  Copy-Item -LiteralPath $file -Destination (Join-Path $backupRoot $name)
  if($WebStatusOnly){
    if(-not $before.Contains('AICC_HOME_ENTRY_V1')){throw 'Existing owned home extension required'}
    if($name -eq 'aicc.ps1'){
      $anchor="if (`$args.Count -gt 0 -and `$args[0] -eq 'home') {"
      if($before.Split([string[]]@($anchor),[StringSplitOptions]::None).Count -ne 2){throw 'Exact owned home PowerShell branch required'}
      $body=$before.Replace($anchor,"# AICC_HOME_WEB_STATUS_V1"+[Environment]::NewLine+"if ((`$args.Count -gt 0 -and `$args[0] -eq 'home') -or (`$args.Count -ge 2 -and `$args[0] -eq 'web-gpt' -and `$args[1] -eq 'status')) {")
    }else{
      $anchor='IF /I "%~1"=="home" GOTO aicc_home_entry'
      if($before.Split([string[]]@($anchor),[StringSplitOptions]::None).Count -ne 2){throw 'Exact owned home CMD branch required'}
      $body=$before.Replace($anchor,$anchor+[Environment]::NewLine+'REM AICC_HOME_WEB_STATUS_V1'+[Environment]::NewLine+'IF /I "%~1"=="web-gpt" IF /I "%~2"=="status" GOTO aicc_home_entry')
    }
  }elseif($name -eq 'aicc.ps1'){
    if(-not $before.StartsWith('#!/usr/bin/env pwsh')){throw 'Unknown PowerShell entry preserved'}
    $body=$before.Replace('#!/usr/bin/env pwsh','#!/usr/bin/env pwsh'+[Environment]::NewLine+$psBranch)
  }else{
    if($before -notmatch '(?i)^@echo off'){throw 'Unknown cmd entry preserved'}
    $body=$before.Substring(0,9)+[Environment]::NewLine+$cmdBranch+$before.Substring(9)
  }
  if($ReconcileBackup -and $body -cne $liveBefore){throw 'Current home entry differs from exact owner extension; preserved'}
  if([IO.File]::ReadAllText($file) -cne $liveBefore){throw 'CLI entry changed before dispatch; preserved'}
  if($health -and $health.changedFiles.ContainsKey($name)){
    $originalHasher=[Security.Cryptography.SHA256]::Create();try{$beforeHash=[Convert]::ToHexString($originalHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($before))).ToLowerInvariant()}finally{$originalHasher.Dispose()}
    if($health.changedFiles[$name].installedSha256 -ne $beforeHash){throw 'Health owner wrapper changed before home extension; preserved'}
  }
  $temporary=$file+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temporary,$body,[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $file -Force
  if($health -and $health.changedFiles.ContainsKey($name)){$health.changedFiles[$name].installedSha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
}
if($health){
  if([IO.File]::ReadAllText($healthReceipt) -cne $healthBefore){throw 'Health receipt changed; reconcile before another operation'}
  Copy-Item -LiteralPath $healthReceipt -Destination (Join-Path $backupRoot 'health-install-state.before.json')
  $health.homeEntryComposition=@{version=1;backup=$backupRoot;ownedExtension='AICC_HOME_ENTRY_V1'}
  $temporary=$healthReceipt+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($temporary,($health|ConvertTo-Json -Depth 14),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $healthReceipt -Force
}
@{installed=$true;homeCommand='aicc home status --json';existingHealthBranchPreserved=$true;backup=$backupRoot}|ConvertTo-Json
