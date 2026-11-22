#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Stage','Activate')][string]$Action='Stage')
$ErrorActionPreference='Stop'
$ownerRoot=[Environment]::GetFolderPath('UserProfile')
$stateRoot=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path $ownerRoot '.ai-control-center'}
$sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$registryFile=Join-Path $stateRoot 'runtime/components.json'
$managedRoot=[IO.Path]::GetFullPath((Join-Path $stateRoot 'releases/cli'))
$lock=[IO.File]::Open($registryFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
 $before=[IO.File]::ReadAllBytes($registryFile)
 $beforeText=[Text.Encoding]::UTF8.GetString($before)
 $registry=$beforeText|ConvertFrom-Json -AsHashtable
 $cli=$registry.components.cli
 $baseline=[IO.Path]::GetFullPath($cli.releaseRoot)
 if($registry.schemaVersion -ne 1 -or $cli.location -ne 'managed' -or !$baseline.StartsWith($managedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $baseline).LinkType){throw 'Registered immutable CLI baseline required'}
 $manifest=Get-Content -LiteralPath (Join-Path $baseline '.aicc-release.json') -Raw|ConvertFrom-Json -AsHashtable
 if($manifest.schemaVersion -ne 1 -or !$manifest.files){throw 'Baseline release manifest required'}
 foreach($row in $manifest.files){
  $file=[IO.Path]::GetFullPath((Join-Path $baseline $row.path))
  if(!$file.StartsWith($baseline+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $file).LinkType -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $row.sha256.ToLowerInvariant()){throw 'Baseline manifest differs; preserve current CLI'}
 }
 if(Get-ChildItem -LiteralPath $baseline -Recurse -Force|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}|Select-Object -First 1){throw 'Linked baseline refused'}
 $sourceRoute=Join-Path $sourceRoot 'src/codex-cli-routes.mjs'
 $routeBytes=[IO.File]::ReadAllBytes($sourceRoute)
 $text=[IO.File]::ReadAllText((Join-Path $baseline 'src/cli.mjs')).Replace("`r`n","`n")
 function Once([string]$value,[string]$old,[string]$new){if($value.Split([string[]]@($old),[StringSplitOptions]::None).Count -ne 2){throw 'Installed CLI contract differs; no overwrite'};return $value.Replace($old,$new)}
 $oldImport="import { codexCliRouteStatus, launchCodexCli, parseCodexRouteArguments } from './codex-cli-routes.mjs';"
 $newImport="import { codexCliRouteStatus, launchCodexCli, parseCodexRouteArguments, ocxCliAccountSelectors } from './codex-cli-routes.mjs';"
 if($text.Contains($oldImport)){$text=Once $text $oldImport $newImport}elseif(!$text.Contains($newImport)){throw 'Installed CLI import differs; no overwrite'}
 $oldHelp='aicc codex ocx [--route-model MODEL] [--route-effort medium] [Codex 인자]'
 $pinHelp='aicc codex ocx [--route-model MODEL] [--route-effort medium] [--route-account SELECTOR] [Codex 인자]'
 $numberHelp='aicc codex ocx [--route-model MODEL] [--route-effort medium] [--account N] [Codex 인자]'
 $preferredHelp='aicc codex ocx [--route-model MODEL] [--route-effort medium] [--account N|--prefer-account N] [Codex 인자]'
 if($text.Contains($oldHelp)){$text=Once $text $oldHelp $preferredHelp}elseif($text.Contains($pinHelp)){$text=Once $text $pinHelp $preferredHelp}elseif($text.Contains($numberHelp)){$text=Once $text $numberHelp $preferredHelp}elseif(!$text.Contains($preferredHelp)){throw 'Installed CLI help differs; no overwrite'}
 $anchor="    const subcommand = process.argv[3] || 'status';"
 $branch=@'
    if (subcommand === 'accounts') {
      const result = ocxCliAccountSelectors();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else for (const row of result.accounts) console.log(`${row.label}${row.paused ? ' · 일시 정지' : ''}`);
      return;
    }
'@
 $codexAnchor="  if (command === 'codex') {`n"+$anchor
 if(!$text.Contains("if (subcommand === 'accounts')")){
  $text=Once $text $codexAnchor ($codexAnchor+"`n"+$branch)
 }else{
  $oldList='else for (const row of result.accounts) console.log(`${row.selector}\t${row.label}${row.paused ? '' · paused'' : ''''}`);'
  $oldEscapedList=$oldList.Replace('\t','\\t')
  $newList='else for (const row of result.accounts) console.log(`${row.label}${row.paused ? '' · 일시 정지'' : ''''}`);'
  if($text.Contains($oldList)){$text=Once $text $oldList $newList}elseif($text.Contains($oldEscapedList)){$text=Once $text $oldEscapedList $newList}elseif(!$text.Contains($newList)){throw 'Installed CLI account listing differs; no overwrite'}
 }
 $oldOptions='reasoningEffort: selection.reasoningEffort ?? undefined });'
 $numberOptions='reasoningEffort: selection.reasoningEffort ?? undefined, accountSelector: selection.accountSelector ?? undefined });'
 $preferredOptions='reasoningEffort: selection.reasoningEffort ?? undefined, accountSelector: selection.accountSelector ?? undefined, preferredAccount: selection.preferredAccount ?? undefined });'
 if($text.Contains($oldOptions)){$text=Once $text $oldOptions $preferredOptions}elseif($text.Contains($numberOptions)){$text=Once $text $numberOptions $preferredOptions}elseif(!$text.Contains($preferredOptions)){throw 'Installed CLI route options differ; no overwrite'}
 $overrides=@{'src/codex-cli-routes.mjs'=$routeBytes;'src/cli.mjs'=[Text.Encoding]::UTF8.GetBytes($text)}
 $pins=@{};foreach($rel in $overrides.Keys){$pins[$rel]=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($overrides[$rel])).ToLowerInvariant()}
 $identity=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($baseline+'|'+($pins|ConvertTo-Json -Compress)))).ToLowerInvariant()
 $destination=Join-Path $managedRoot ('ocx-account-number-'+$identity.Substring(0,16))
 if(Test-Path -LiteralPath $destination){throw 'Candidate already exists; reconcile existing operation rather than overwrite'}
 Copy-Item -LiteralPath $baseline -Destination $destination -Recurse
 foreach($rel in $overrides.Keys){[IO.File]::WriteAllBytes((Join-Path $destination $rel),$overrides[$rel])}
 foreach($row in $manifest.files){if($overrides.ContainsKey($row.path)){$row.sha256=$pins[$row.path];$row.size=$overrides[$row.path].Length}}
 $manifest.component='ocx-account-number-cli';$manifest.baseline=$baseline;$manifest.candidateHash=$identity
 [IO.File]::WriteAllText((Join-Path $destination '.aicc-release.json'),($manifest|ConvertTo-Json -Depth 18),[Text.UTF8Encoding]::new($false))
 $backup=$null
 if($Action -eq 'Activate'){
  # Only the entry for future CLI invocations changes. Existing CLI/model/service processes keep their immutable baseline.
  $inUse=Get-CimInstance Win32_Process|Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($baseline)}
  if($inUse){throw 'Current CLI baseline is in use; no stop or activation'}
  if([IO.File]::ReadAllText($registryFile) -cne $beforeText){throw 'Registry changed; preserve newer registration'}
  $backupRoot=Join-Path $stateRoot 'backups/runtime-layout'
  [IO.Directory]::CreateDirectory($backupRoot)|Out-Null
  $backup=Join-Path $backupRoot ('components-ocx-account-number-'+[guid]::NewGuid().ToString('N')+'.json')
  [IO.File]::WriteAllBytes($backup,$before)
  $next=@{};foreach($key in $cli.Keys){$next[$key]=$cli[$key]}
  $next.entry=Join-Path $destination 'bin/aicc';$next.releaseRoot=$destination;$next.previousEntry=$cli.entry;$next.sourceRelease=Split-Path $destination -Leaf
  $nextPins=@{};if($cli.sourceHashes){foreach($key in $cli.sourceHashes.Keys){$nextPins[$key]=$cli.sourceHashes[$key]}}
  foreach($rel in $pins.Keys){$nextPins[$rel]=$pins[$rel]};$next.sourceHashes=$nextPins;$registry.components.cli=$next
  $temp=$registryFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temp,($registry|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
  if([IO.File]::ReadAllText($registryFile) -cne $beforeText){throw 'Registry changed during staging; preserve newer registration'}
  [IO.File]::Replace($temp,$registryFile,$backup+'.replaced')
 }
 @{state=if($Action -eq 'Activate'){'APPLIED_NOT_VERIFIED'}else{'STAGED_NOT_ACTIVE'};candidate=$destination;previous=$baseline;registryBackup=$backup;changedFiles=@($pins.Keys);servicesRestarted=0;globalAccountChanged=$false;inferenceStarted=$false;verification='NOT_RUN'}|ConvertTo-Json -Depth 5
}finally{$lock.Dispose()}
