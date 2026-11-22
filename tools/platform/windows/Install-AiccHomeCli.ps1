#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Stage','Activate')][string]$Action='Stage',[switch]$WebSupervisorUi,[switch]$WebStatusOnly)
$ErrorActionPreference='Stop'
$ownerRoot=[Environment]::GetFolderPath('UserProfile')
$aiccHome=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path $ownerRoot '.ai-control-center'}
$registryFile=Join-Path $aiccHome 'runtime\components.json'
function Install-WebSupervisorUi {
  $canonical=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
  $cli=$registry.components.cli
  if($cli.location -ne 'managed'){throw 'Managed CLI baseline required'}
  $source=[IO.Path]::GetFullPath($cli.releaseRoot);$registeredSource=$source
  $managedRoot=[IO.Path]::GetFullPath((Join-Path $aiccHome 'releases\cli'))
  if(-not $source.StartsWith($managedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $source).LinkType){throw 'Unknown managed CLI baseline'}
  $manifest=Get-Content -LiteralPath (Join-Path $source '.aicc-release.json') -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  if($manifest.schemaVersion -ne 1 -or -not $manifest.files){throw 'Baseline manifest required'}
  if($manifest.component -ceq 'web-supervisor-ui'){
    foreach($record in $manifest.files){$file=[IO.Path]::GetFullPath((Join-Path $source $record.path));if(-not $file.StartsWith($source+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256.ToLowerInvariant()){throw 'Installed UI manifest differs'}}
    $source=[IO.Path]::GetFullPath($manifest.baseline)
    if(-not $source.StartsWith($managedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $source).LinkType){throw 'Unknown UI baseline'}
    $manifest=Get-Content -LiteralPath (Join-Path $source '.aicc-release.json') -Raw|ConvertFrom-Json -AsHashtable -DateKind String
    if($manifest.schemaVersion -ne 1 -or -not $manifest.files -or $manifest.component -ceq 'web-supervisor-ui'){throw 'Original managed UI baseline required'}
  }
  function Between([string]$text,[string]$start,[string]$end){$a=$text.IndexOf($start);$b=$text.IndexOf($end,$a);if($a -lt 0 -or $b -lt 0){throw 'Exact source section not found'};$text.Substring($a,$b-$a)}
  function Once([string]$text,[string]$beforeText,[string]$afterText){if(($text.Split([string[]]@($beforeText),[StringSplitOptions]::None)).Count -ne 2){throw 'Exact baseline anchor changed'};$text.Replace($beforeText,$afterText)}
  $overrides=@{}
  $overrides['src/web-jjonku-monitor-config.mjs']=[IO.File]::ReadAllText((Join-Path $canonical 'src\web-jjonku-monitor-config.mjs'))
  $overrides['tools/platform/core/Read-AiccCoordination.ps1']=[IO.File]::ReadAllText((Join-Path $canonical 'tools\platform\core\Read-AiccCoordination.ps1'))
  $server=[IO.File]::ReadAllText((Join-Path $source 'src\server.mjs'))
  if($server.Contains("from './web-jjonku-monitor-config.mjs'")){throw 'Already installed or changed UI baseline; inspect current release'}
  $server="import { createWebJjonkuMonitorConfig } from './web-jjonku-monitor-config.mjs';"+[Environment]::NewLine+$server
  $server=Once $server 'function requestAllowed(req, res) {' 'function requestAllowed(req, res, { jsonRequired = true } = {}) {'
  $server=Once $server "if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {" "if (jsonRequired && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {"
  $server=Once $server 'export function createServer(options = {}) {' ("export function createServer(options = {}) {"+[Environment]::NewLine+"  const webJjonkuMonitorConfig = createWebJjonkuMonitorConfig(options.webJjonkuMonitorConfig);")
  $anchor="    if (req.method === 'GET' && url.pathname === '/api/monitoring') {"
  $routes=@'
    if (req.method === 'GET' && url.pathname === '/api/web-jjonku-monitor/config') {
      if (!requestAllowed(req, res, { jsonRequired: false })) return;
      try { return json(res, 200, webJjonkuMonitorConfig.status()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/web-jjonku-monitor/config') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, webJjonkuMonitorConfig.save(await readJson(req, 32_768))); }
      catch (error) { return serviceFailure(res, error); }
    }
'@
  $overrides['src/server.mjs']=Once $server $anchor ($routes+[Environment]::NewLine+$anchor)
  $html=[IO.File]::ReadAllText((Join-Path $source 'public\index.html'))
  $section=Between ([IO.File]::ReadAllText((Join-Path $canonical 'public\index.html'))) '        <article class="web-jjonku-config panel"' '        <article class="project-service-control panel"'
  $overrides['public/index.html']=Once $html '        <article class="project-service-control panel"' ($section+'        <article class="project-service-control panel"')
  $js=[IO.File]::ReadAllText((Join-Path $source 'public\app.js'))
  $currentJs=[IO.File]::ReadAllText((Join-Path $canonical 'public\app.js'))
  $declarations=Between $currentJs "const webJjonkuConfigStatus = " "const monitoringLayers = "
  $logicStart=$currentJs.IndexOf('function selectedWebTargets() {')
  $logicEnd="webJjonkuConfigForm?.addEventListener('submit', saveWebJjonkuSettings);"
  $logic=$currentJs.Substring($logicStart,$currentJs.IndexOf($logicEnd,$logicStart)+$logicEnd.Length-$logicStart)
  $overrides['public/app.js']=$js+[Environment]::NewLine+$declarations+[Environment]::NewLine+'let webJjonkuConfigReady = false;'+[Environment]::NewLine+$logic+[Environment]::NewLine+"loadWebJjonkuConfig().catch(error => { webJjonkuConfigMessage.textContent = error.message; });"+[Environment]::NewLine
  $currentCss=[IO.File]::ReadAllText((Join-Path $canonical 'public\styles.css'));$cssStart=$currentCss.IndexOf('.web-jjonku-config { margin:');if($cssStart -lt 0){throw 'UI style section missing'};$css=$currentCss.Substring($cssStart)
  $overrides['public/styles.css']=[IO.File]::ReadAllText((Join-Path $source 'public\styles.css'))+[Environment]::NewLine+$css
  $sourcePins=[ordered]@{};foreach($relative in @($overrides.Keys|Sort-Object)){$sourcePins[$relative]=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($overrides[$relative]))).ToLowerInvariant()}
  $candidateHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($source+'|'+($sourcePins|ConvertTo-Json -Compress))))).ToLowerInvariant()
  $destination=Join-Path $managedRoot ('web-supervisor-ui-'+$candidateHash.Substring(0,16))
  if(-not(Test-Path -LiteralPath $destination)){
    if(Get-ChildItem -LiteralPath $source -Recurse -Force|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}|Select-Object -First 1){throw 'Linked baseline refused'}
    foreach($record in $manifest.files){$file=[IO.Path]::GetFullPath((Join-Path $source $record.path));if(-not $file.StartsWith($source+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256.ToLowerInvariant()){throw 'Baseline manifest differs'}}
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
    foreach($relative in $overrides.Keys){$target=Join-Path $destination $relative;New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force|Out-Null;[IO.File]::WriteAllText($target,$overrides[$relative],[Text.UTF8Encoding]::new($false))}
    $files=@(Get-ChildItem -LiteralPath $destination -Recurse -File -Force|Where-Object Name -ne '.aicc-release.json'|ForEach-Object {@{path=([IO.Path]::GetRelativePath($destination,$_.FullName).Replace('\','/'));sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant();size=$_.Length}}|Sort-Object path)
    $nextManifest=@{schemaVersion=1;component='web-supervisor-ui';sourceRevision=$manifest.sourceRevision;baseline=$source;candidateHash=$candidateHash;overrides=$sourcePins;files=$files;fileCount=$files.Count;totalBytes=($files|Measure-Object size -Sum).Sum}
    [IO.File]::WriteAllText((Join-Path $destination '.aicc-release.json'),($nextManifest|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  }
  foreach($relative in $sourcePins.Keys){if((Get-FileHash -LiteralPath (Join-Path $destination $relative)).Hash.ToLowerInvariant() -cne $sourcePins[$relative]){throw 'Immutable UI candidate differs'}}
  if($Action -eq 'Activate'){
    $inUse=Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -and $_.ProcessId -ne $PID -and ($_.CommandLine.Contains($source) -or $_.CommandLine.Contains($registeredSource))}
    if($inUse){throw 'Current CLI in use; no stop or activation'}
    if([IO.File]::ReadAllText($registryFile) -cne $before){throw 'Registry CAS changed'}
    $backup=Join-Path $aiccHome ('backups\runtime-layout\components-ui-'+[guid]::NewGuid().ToString('N')+'.json')
    New-Item -ItemType Directory -Path (Split-Path $backup -Parent) -Force|Out-Null
    [IO.File]::WriteAllText($backup,$before,[Text.UTF8Encoding]::new($false))
    $registry.components.cli=@{entry=(Join-Path $destination 'bin\aicc');runtime=$cli.runtime;location='managed';releaseRoot=$destination;previousEntry=$cli.entry;sourceRelease=(Split-Path $destination -Leaf);sourceHashes=$sourcePins}
    $temp=$registryFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($temp,($registry|ConvertTo-Json -Depth 14),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temp -Destination $registryFile -Force
  }
  @{candidate=$destination;candidateHash=$candidateHash;action=$Action;activated=($Action -eq 'Activate');changedFiles=@($sourcePins.Keys);backup=$backup;servicesRestarted=0}|ConvertTo-Json -Depth 5
}
function Install-WebStatusReader {
  if($WebSupervisorUi){throw 'Select one CLI overlay'}
  $cli=$registry.components.cli
  $managedRoot=[IO.Path]::GetFullPath((Join-Path $aiccHome 'releases\cli'))
  $source=[IO.Path]::GetFullPath($cli.releaseRoot)
  if($cli.location -ne 'managed' -or -not $source.StartsWith($managedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $source).LinkType){throw 'Registered managed CLI required'}
  $manifest=Get-Content -LiteralPath (Join-Path $source '.aicc-release.json') -Raw | ConvertFrom-Json -AsHashtable -DateKind String
  if($manifest.schemaVersion -ne 1 -or -not $manifest.files){throw 'CLI source manifest required'}
  if(Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint} | Select-Object -First 1){throw 'Linked CLI baseline refused'}
  foreach($record in $manifest.files){
    $file=[IO.Path]::GetFullPath((Join-Path $source $record.path))
    if(-not $file.StartsWith($source+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256.ToLowerInvariant()){throw 'CLI baseline hash changed'}
  }
  $text=[IO.File]::ReadAllText((Join-Path $source 'src\cli.mjs'))
  $before="      const status = await collectStatus();"+"`n"+"      const result = status.components.find(component => component.id === 'web-gpt');"
  $text=$text.Replace("`r`n","`n")
  if($text.Contains("const result = await webGptStatus();")){
    @{changed=$false;entry=$cli.entry;servicesRestarted=0}|ConvertTo-Json;return
  }
  if($text.Split([string[]]@($before),[StringSplitOptions]::None).Count -ne 2 -or $text.Contains("import { webGptStatus }")){throw 'Exact old Web status branch required'}
  $text="import { webGptStatus } from './adapters/web-gpt.mjs';"+"`n"+$text.Replace($before,'      const result = await webGptStatus();')
  $fileHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()
  $identity=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($source+'|web-status|'+$fileHash))).ToLowerInvariant()
  $destination=Join-Path $managedRoot ('web-status-'+$identity.Substring(0,16))
    foreach($record in $manifest.files){if($record.path -eq 'src/cli.mjs'){$record.sha256=$fileHash;$record.size=[Text.Encoding]::UTF8.GetByteCount($text)}}
    $manifest.component='web-status-reader';$manifest.baseline=$source;$manifest.candidateHash=$identity
  if(-not(Test-Path -LiteralPath $destination)){
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
    [IO.File]::WriteAllText((Join-Path $destination 'src\cli.mjs'),$text,[Text.UTF8Encoding]::new($false))

    [IO.File]::WriteAllText((Join-Path $destination '.aicc-release.json'),($manifest|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
  }
  foreach($record in $manifest.files){if((Get-FileHash -LiteralPath (Join-Path $destination $record.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256.ToLowerInvariant()){throw 'Immutable Web status candidate differs'}}
  if($Action -eq 'Activate'){
    $inUse=Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($source)}
    if($inUse){throw 'CLI baseline in use; activation preserved'}
    if([IO.File]::ReadAllText($registryFile) -cne $beforeRegistry){throw 'CLI registry changed'}
    $backup=Join-Path $aiccHome ('backups\runtime-layout\components-web-status-'+[guid]::NewGuid().ToString('N')+'.json')
    [IO.File]::WriteAllText($backup,$beforeRegistry,[Text.UTF8Encoding]::new($false))
    $next=@{};foreach($key in $cli.Keys){$next[$key]=$cli[$key]}
    $next.entry=Join-Path $destination 'bin\aicc';$next.releaseRoot=$destination;$next.previousEntry=$cli.entry;$next.sourceRelease=Split-Path $destination -Leaf
    $pins=@{};foreach($key in $cli.sourceHashes.Keys){$pins[$key]=$cli.sourceHashes[$key]};$pins['src/cli.mjs']=$fileHash
    $next.sourceHashes=$pins;$registry.components.cli=$next
    $temp=$registryFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    [IO.File]::WriteAllText($temp,($registry|ConvertTo-Json -Depth 14),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temp -Destination $registryFile -Force
  }
  @{candidate=$destination;activated=($Action -eq 'Activate');changedFiles=@('src/cli.mjs');backup=$backup;servicesRestarted=0}|ConvertTo-Json
}
$registryLock=[IO.File]::Open($registryFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
  $before=[IO.File]::ReadAllText($registryFile);$registry=$before|ConvertFrom-Json -AsHashtable
  if($registry.schemaVersion -ne 1 -or $registry.root -ne $aiccHome){throw 'Unknown component registry preserved'}
  if($WebStatusOnly){$beforeRegistry=$before;Install-WebStatusReader;return}
  if($WebSupervisorUi){Install-WebSupervisorUi;return}
  $cli=$registry.components.cli
  if($cli.location -eq 'managed'){@{changed=$false;location='managed';entry=$cli.entry}|ConvertTo-Json;return}
  if($cli.location -ne 'legacy-frozen'){throw 'Only the registered immutable legacy CLI can be migrated'}
  $source=[IO.Path]::GetFullPath((Split-Path (Split-Path $cli.entry -Parent) -Parent))
  $legacy=[IO.Path]::GetFullPath((Join-Path $ownerRoot '.codex\releases\open-aicc'))
  if(-not $source.StartsWith($legacy+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $source).LinkType -or -not(Test-Path -LiteralPath (Join-Path $source '.aicc-release.json') -PathType Leaf)){throw 'Unknown legacy release preserved'}
  $releaseName=Split-Path $source -Leaf
  if($releaseName -notmatch '^controlplane-[a-f0-9]{8,64}$'){throw 'Unrecognized immutable release name'}
  $destination=[IO.Path]::GetFullPath((Join-Path $aiccHome ('releases\cli\'+$releaseName)))
  $managedRoot=[IO.Path]::GetFullPath((Join-Path $aiccHome 'releases\cli'))
  if(-not $destination.StartsWith($managedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Release path escaped AICC home'}
  $copyReceiptRoot=Join-Path $aiccHome 'runtime\cli-copies'
  New-Item -ItemType Directory -Path $copyReceiptRoot -Force|Out-Null
  $copyReceipt=Join-Path $copyReceiptRoot ($releaseName+'.json')
  if(-not(Test-Path -LiteralPath $copyReceipt)){
    if(Test-Path -LiteralPath $destination){throw 'Incomplete or unknown candidate preserved; no overwrite'}
    # Only the attested code release is copied. Native credentials and state homes are outside it.
    if(Get-ChildItem -LiteralPath $source -Recurse -Force|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}|Select-Object -First 1){throw 'Linked release tree refused'}
    $files=Get-ChildItem -LiteralPath $source -Recurse -File -Force
    $hashes=[ordered]@{};foreach($file in $files){$relative=[IO.Path]::GetRelativePath($source,$file.FullName);$hashes[$relative]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash}
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force|Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
    foreach($relative in $hashes.Keys){if((Get-FileHash -LiteralPath (Join-Path $destination $relative) -Algorithm SHA256).Hash -ne $hashes[$relative]){throw 'Incomplete release copy preserved; no activation'}}
    [IO.File]::WriteAllText($copyReceipt,(@{schemaVersion=1;source=$source;sourceFiles=$hashes}|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  }
  if($Action -eq 'Activate'){
    $receipt=Get-Content -LiteralPath $copyReceipt -Raw|ConvertFrom-Json -AsHashtable
    if($receipt.schemaVersion -ne 1 -or $receipt.source -ne $source){throw 'Unknown copy receipt preserved'}
    foreach($relative in $receipt.sourceFiles.Keys){
      $target=[IO.Path]::GetFullPath((Join-Path $destination $relative))
      if(-not $target.StartsWith($destination+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $receipt.sourceFiles[$relative]){throw 'Staged component changed; preserved without activation'}
    }
    $inUse=Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($source,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.ProcessId -ne $PID}
    if($inUse){throw 'Legacy release still in use; no stop and no activation'}
    if([IO.File]::ReadAllText($registryFile) -cne $before){throw 'Component registry changed; preserved without activation'}
    $backup=Join-Path $aiccHome ('backups\runtime-layout\components-'+[guid]::NewGuid().ToString('N')+'.json')
    [IO.File]::WriteAllText($backup,$before,[Text.UTF8Encoding]::new($false))
    $registry.components.cli=@{entry=(Join-Path $destination 'bin\aicc');runtime=$cli.runtime;location='managed';releaseRoot=$destination;previousEntry=$cli.entry;sourceRelease=$releaseName}
    $temporary=$registryFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    [IO.File]::WriteAllText($temporary,($registry|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $registryFile -Force
  }
  @{action=$Action;candidate=$destination;activated=($Action -eq 'Activate');legacyPreserved=$true;globalShimChanged=$false;authMoved=$false}|ConvertTo-Json
}finally{$registryLock.Dispose()}
