#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PreimageRoot)
$ErrorActionPreference='Stop'
$canonical=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$ownerRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$PreimageRoot=[IO.Path]::GetFullPath($PreimageRoot)
if(-not $PreimageRoot.StartsWith((Join-Path $ownerRoot 'backups')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Owner-local preimages required'}
$review=Join-Path $PreimageRoot 'review';$receiptFile=Join-Path $review 'runtime-stage.json'
if(Test-Path -LiteralPath $receiptFile){throw 'Candidate exists; reconcile instead of restaging'}
$utf8=[Text.UTF8Encoding]::new($false)
function Json([string]$File,$Value){[IO.File]::WriteAllText($File,($Value|ConvertTo-Json -Depth 60),$utf8)}
function Hash([string]$File){(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
function Plain([string]$File){
 $full=[IO.Path]::GetFullPath($File);$item=Get-Item -LiteralPath $full -Force
 for($cursor=$item;$cursor;$cursor=if($cursor.PSIsContainer){$cursor.Parent}else{$cursor.Directory}){if($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked deployment path refused'}}
 return $full
}
function Merge-Delta([string]$Relative,[string]$Destination){
 $src=Plain (Join-Path $canonical $Relative);$old=Join-Path $PreimageRoot $Relative;$target=Join-Path $Destination $Relative
 $null=New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force
 if($Relative -in @('components/workspace-mcp/runtime-marker.mjs','src/workspace-mcp.mjs','tools/platform/chatgpt/Prepare-AiccWorkspacePublish.mjs')){
  $text=[IO.File]::ReadAllText($target)
  if($text.Contains('codexCliAvailable:')){return}
  if($Relative -eq 'tools/platform/chatgpt/Prepare-AiccWorkspacePublish.mjs'){
   $anchor='webManagementAvailable: runtime.hostCapabilities?.webManagement === true'
   if($text.Split([string[]]@($anchor),[StringSplitOptions]::None).Count -ne 3){
    $options='surfaceProfile, commandSandboxAvailable: runtime.hostCapabilities?.commands === true, webManagementAvailable: runtime.hostCapabilities?.webManagement === true'
    foreach($call in @('recordWorkspacePublication({ ...evidence, surfaceProfile })','workspacePublicationStatus({ surfaceProfile })')){
     if($text.Split([string[]]@($call),[StringSplitOptions]::None).Count -ne 2){throw 'Installed publication call anchor differs'}
     $text=$text.Replace($call,$call.Replace('surfaceProfile',$options))
    }
   }
   $text=$text.Replace($anchor,$anchor+', codexCliAvailable: runtime.hostCapabilities?.codexCli === true')
  }else{
   $anchor='webManagementAvailable: config.webManagement?.enabled === true'
   if($text.Split([string[]]@($anchor),[StringSplitOptions]::None).Count -ne 2){throw ('Capability anchor differs: '+$Relative)}
   $text=$text.Replace($anchor,$anchor+', codexCliAvailable: config.codexCli?.enabled === true')
   if($Relative -eq 'src/workspace-mcp.mjs'){
    $anchor='webManagement: config.webManagement?.enabled === true'
    if($text.Split([string[]]@($anchor),[StringSplitOptions]::None).Count -ne 2){throw 'Host capability anchor differs'}
    $text=$text.Replace($anchor,$anchor+', codexCli: config?.codexCli?.enabled === true')
   }
  }
  [IO.File]::WriteAllText($target,$text,$utf8);return
 }
 if($Relative -eq 'components/workspace-mcp/runtime-integrity.mjs'){
  $text=[IO.File]::ReadAllText($target).Replace("`r`n","`n")
  if($text.Contains("'components/workspace-mcp/codex-cli-provider.mjs'")){return}
  $anchor="  'components/workspace-mcp/web-management-provider.mjs',"
  if($text.Split([string[]]@($anchor),[StringSplitOptions]::None).Count -ne 2){throw 'Installed integrity array anchor differs'}
  $addition=@("  'components/workspace-mcp/codex-cli-provider.mjs',","  'src/codex-cli-routes.mjs',","  'src/native-rescue.mjs',","  'src/codex-route-launchers.mjs',") -join "`n"
  [IO.File]::WriteAllText($target,$text.Replace($anchor,$anchor+"`n"+$addition),$utf8);return
 }
 if($Relative -eq 'components/workspace-mcp/server.mjs'){
  $text=[IO.File]::ReadAllText($target).Replace("`r`n","`n")
  if($text.Contains("from './codex-cli-provider.mjs'")){return}
  function Once([string]$a,[string]$b){
   if($script:serverText.Split([string[]]@($a),[StringSplitOptions]::None).Count -ne 2){throw ('Installed server anchor differs: '+$a)}
   $script:serverText=$script:serverText.Replace($a,$b)
  }
  $script:serverText=$text
  $a="import { createWebManagementExecutor } from './web-management-provider.mjs';"
  Once $a ($a+"`n"+"import { createCodexCliExecutor } from './codex-cli-provider.mjs';")
  $a='const processSessions = new Map();';Once $a ($a+"`n"+'const codexCliExecutors = new Set();')
  $a='  const fastRead = options.fastReadCoordinator ?? null;'
  Once $a ($a+"`n"+'  const codexCli = !personalReadFetch && config.codexCli?.enabled === true ? createCodexCliExecutor(config) : null;'+"`n"+'  if (codexCli) codexCliExecutors.add(codexCli);')
  $a="      stopSessionsForLease(record.leaseId, 'lease_expired');"
  Once $a ($a+"`n"+'      codexCli?.stopLease(record.leaseId);')
  Once '  const withLease = (requiredMode, callback, { consumeRequest = () => true } = {}) => async input => {' '  const withLease = (requiredMode, callback, { consumeRequest = () => true, codexDispatch = false } = {}) => async input => {'
  $a='      const workspace = resolveWorkspace(config, input.workspace_id);'
  Once $a ($a+"`n"+"      if (requiredMode === 'write' && !codexDispatch) codexCli?.assertNoWriter(workspace);")
  Once 'if (running.length > 0) throw' 'if (running.length > 0 || codexCli?.activeForLease(lease.leaseId)) throw'
  $desired=[IO.File]::ReadAllText($src).Replace("`r`n","`n")
  $start=$desired.IndexOf('  if (codexCli) {')
  $end=$desired.IndexOf('  if (!personalReadFetch && config.webManagement?.enabled === true) {',$start)
  if($start -lt 0 -or $end -le $start){throw 'Source registration boundaries missing'}
  $a='  if (!personalReadFetch && config.webManagement?.enabled === true) {'
  Once $a ($desired.Substring($start,$end-$start)+$a)
  $a='webManagementAvailable: config.webManagement?.enabled === true'
  Once $a ($a+','+"`n"+'        codexCliAvailable: config.codexCli?.enabled === true')
  $shutdown=$script:serverText.IndexOf('function shutdown() {')
  $session=$script:serverText.IndexOf('  for (const session of processSessions.values()) {',$shutdown)
  if($shutdown -lt 0 -or $session -le $shutdown){throw 'Installed shutdown boundary missing'}
  $script:serverText=$script:serverText.Insert($session,'  for (const executor of codexCliExecutors) executor.stopLease(null);'+"`n")
  [IO.File]::WriteAllText($target,$script:serverText,$utf8)
  return
 }
 if($Relative -in @('components/workspace-mcp/codex-cli-provider.mjs','tools/platform/workspace-mcp/Invoke-AiccCodexWorkspaceJob.ps1') -or -not(Test-Path -LiteralPath $old)){
  if(Test-Path -LiteralPath $target){if((Hash $target) -ceq (Hash $src)){return};throw ('New file collides: '+$Relative)}
  Copy-Item -LiteralPath $src -Destination $target;return
 }
 if($Relative -eq 'src/codex-cli-routes.mjs' -and -not(Test-Path -LiteralPath $target)){
  $cliRoot=$receipt.components.cli.candidate
  Copy-Item -LiteralPath (Join-Path $cliRoot $Relative) -Destination $target
  foreach($dependency in @('src/native-rescue.mjs','src/codex-route-launchers.mjs','tools/platform/codex/codex-native-rescue','tools/platform/codex/codex-native-rescue.cmd','tools/platform/codex/codex-aicc','tools/platform/codex/codex-aicc.cmd','tools/platform/codex/codex-web','tools/platform/codex/codex-web.cmd','tools/platform/codex/codex-ocx','tools/platform/codex/codex-ocx.cmd')){
   $dependencySource=Join-Path $cliRoot $dependency
   if(Test-Path -LiteralPath $dependencySource){
    $dependencyTarget=Join-Path $Destination $dependency
    $null=New-Item -ItemType Directory -Path (Split-Path $dependencyTarget -Parent) -Force
    Copy-Item -LiteralPath $dependencySource -Destination $dependencyTarget -Force
   }
  }
  return
 }
 $null=Plain $old;$null=Plain $target
 $diff=@(& git -c core.quotepath=false diff --no-index --unified=3 -- $old $src 2>$null)
 if($LASTEXITCODE -notin @(0,1)){throw ('Cannot compose delta: '+$Relative)}
 if(-not $diff.Count){return}
 $text=[IO.File]::ReadAllText($target).Replace("`r`n","`n")
 $chunks=[Collections.Generic.List[object]]::new();$before=[Collections.Generic.List[string]]::new();$after=[Collections.Generic.List[string]]::new();$inside=$false
 foreach($line in $diff){
  if($line.StartsWith('@@ ')){
   if($inside){$chunks.Add(@{before=($before -join "`n")+"`n";after=($after -join "`n")+"`n"});$before.Clear();$after.Clear()}
   $inside=$true;continue
  }
  if(-not $inside -or $line.StartsWith('\ No newline')){continue}
  if($line.StartsWith(' ')){$before.Add($line.Substring(1));$after.Add($line.Substring(1))}
  elseif($line.StartsWith('-')){$before.Add($line.Substring(1))}
  elseif($line.StartsWith('+')){$after.Add($line.Substring(1))}
 }
 if($inside){$chunks.Add(@{before=($before -join "`n")+"`n";after=($after -join "`n")+"`n"})}
 foreach($chunk in $chunks){
  if($text.Split([string[]]@($chunk.before),[StringSplitOptions]::None).Count -ne 2){if($text.Split([string[]]@($chunk.after),[StringSplitOptions]::None).Count -eq 2){continue};throw ('Installed context differs; candidate remains inactive: '+$Relative)}
  $text=$text.Replace($chunk.before,$chunk.after)
 }
 [IO.File]::WriteAllText($target,$text,$utf8)
}
$paths=@('src/codex-cli-routes.mjs','src/cli.mjs','components/workspace-mcp/codex-cli-provider.mjs','components/workspace-mcp/input-schemas.mjs','components/workspace-mcp/tool-manifest.mjs','components/workspace-mcp/server.mjs','components/workspace-mcp/runtime-integrity.mjs','components/workspace-mcp/runtime-marker.mjs','src/workspace-mcp.mjs','tools/platform/chatgpt/Prepare-AiccWorkspacePublish.mjs','tools/platform/workspace-mcp/Invoke-AiccCodexWorkspaceJob.ps1')
$registry=Get-Content -LiteralPath (Plain (Join-Path $ownerRoot 'runtime\components.json')) -Raw|ConvertFrom-Json -AsHashtable
$name='codex-cli-'+(Split-Path $PreimageRoot -Leaf).Replace('codex-cli-dispatch-','')+'-r3'
$receipt=@{schemaVersion=1;status='STAGING';verification='NOT_RUN';components=@{};changedFiles=$paths;ownerTask=$env:CODEX_THREAD_ID;createdAt=[DateTimeOffset]::Now.ToString('o')}
Json (Join-Path $review 'runtime-stage.intent.json') $receipt
foreach($componentName in @('cli','workspace')){
 $component=$registry.components[$componentName];$baseline=Plain $component.releaseRoot
 $managed=Join-Path $ownerRoot ('releases\'+$componentName)
 if($component.location -cne 'managed' -or -not $baseline.StartsWith($managed+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Managed baseline required'}
 $candidate=Join-Path $managed $name
 if(Test-Path -LiteralPath $candidate){if(-not(Test-Path -LiteralPath (Join-Path $review 'runtime-stage.intent.json'))){throw 'Unowned candidate preserved'}}
 if(Get-ChildItem -LiteralPath $baseline -Recurse -Force|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}|Select-Object -First 1){throw 'Linked baseline refused'}
 if(-not(Test-Path -LiteralPath $candidate)){Copy-Item -LiteralPath $baseline -Destination $candidate -Recurse}
 $componentPaths=if($componentName -eq 'cli'){@('src/codex-cli-routes.mjs','src/cli.mjs')}else{@($paths|Where-Object {$_ -ne 'src/cli.mjs'})}
 foreach($relative in $componentPaths){Merge-Delta $relative $candidate}
 $oldManifest=Get-Content -LiteralPath (Join-Path $baseline '.aicc-release.json') -Raw|ConvertFrom-Json -AsHashtable
 $files=@(Get-ChildItem -LiteralPath $candidate -Recurse -File -Force|Where-Object Name -ne '.aicc-release.json'|ForEach-Object {@{path=[IO.Path]::GetRelativePath($candidate,$_.FullName).Replace('\','/');sha256=(Hash $_.FullName);size=$_.Length}})
 Json (Join-Path $candidate '.aicc-release.json') @{schemaVersion=1;component='codex-cli-scoped-overlay';sourceRevision=$oldManifest.sourceRevision;baseline=$baseline;files=$files;fileCount=$files.Count;totalBytes=($files|Measure-Object size -Sum).Sum;verification='NOT_RUN'}
 $receipt.components[$componentName]=@{before=$component;candidate=$candidate;entry=(Join-Path $candidate 'bin\aicc');pins=@{}}
 foreach($relative in $componentPaths){$receipt.components[$componentName].pins[$relative]=Hash (Join-Path $candidate $relative)}
 Json (Join-Path $review 'runtime-stage.intent.json') $receipt
}
$receipt.status='STAGED_NOT_ACTIVE';Json $receiptFile $receipt
@{status=$receipt.status;receipt=$receiptFile;verification='NOT_RUN'}|ConvertTo-Json -Compress