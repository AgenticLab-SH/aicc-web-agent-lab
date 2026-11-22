#requires -Version 7.5
<# Reuse the installed public runner, task, trust and normal-stop protocol.
   A view-only update: no account, model, tunnel, device-store or queue mutation.
   Packaging and activation guards are required; functional verification is separate. #>
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ConfigFile,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedConfigSha256,
 [Parameter(Mandatory)][string]$OperationRoot,
 [string]$SourceRoot=(Join-Path $PSScriptRoot '../../..'),
 [switch]$ResumePrepared
)
$ErrorActionPreference='Stop'
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$utf8=[Text.UTF8Encoding]::new($false)
function Within($root,$file){[IO.Path]::GetFullPath($file).StartsWith([IO.Path]::GetFullPath($root)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)}
function Regular($file){
 $full=(Resolve-Path -LiteralPath $file).Path
 for($p=$full;;$p=Split-Path -Parent $p){$item=Get-Item -LiteralPath $p -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_path_preserved'};$parent=Split-Path -Parent $p;if(-not $parent -or $parent -eq $p){break}}
 if((Get-Item -LiteralPath $full).PSIsContainer){throw 'regular_file_required'}
 $full
}
function Hash($file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function TextHash($text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($text))).ToLowerInvariant()}
function NewText($file,$text){$stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=$utf8.GetBytes($text);$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}}
$config=Regular $ConfigFile
if(-not (Within (Join-Path $owner 'control-plane/mobile-public-runtime') $config) -or (Hash $config) -cne $ExpectedConfigSha256){throw 'exact_existing_config_required'}
$cfg=[IO.File]::ReadAllText($config)|ConvertFrom-Json -AsHashtable
if($cfg.schemaVersion -ne 1 -or $cfg.port -ne 4383 -or $cfg.remoteOrigin -cne 'https://aicc.example.invalid'){throw 'existing_public_runtime_required'}
$base=[IO.Path]::GetFullPath($cfg.releaseRoot)
if(-not (Within (Join-Path $owner 'releases/cli') $base)){throw 'managed_baseline_required'}
$manifestFile=Regular (Join-Path $base '.aicc-release.json')
if((Hash $manifestFile) -cne $cfg.releaseManifestSha256){throw 'baseline_manifest_changed'}
$manifest=[IO.File]::ReadAllText($manifestFile)|ConvertFrom-Json -AsHashtable
if($manifest.component -cne 'mobile-public-control' -or $manifest.schemaVersion -ne 1){throw 'public_manifest_required'}
$taskName='AgenticLab-AICC-Mobile-Public-Control'
$task=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
$xml=Export-ScheduledTask -InputObject $task
$xmlHash=TextHash $xml
if(@($task.Actions).Count -ne 1 -or [IO.Path]::GetFileName($task.Actions.Execute) -ine 'wscript.exe'){throw 'existing_single_launcher_required'}
$match=[regex]::Match([string]$task.Actions.Arguments,'^/b /nologo "(?<path>[^"\r\n]+\.vbs)"$')
if(-not $match.Success){throw 'existing_launcher_arguments_required'}
$oldLauncher=Regular $match.Groups['path'].Value
if(-not (Within (Join-Path $owner 'backups') $oldLauncher) -or -not [IO.File]::ReadAllText($oldLauncher).Contains($config)){throw 'exact_runtime_launcher_required'}
$operation=[IO.Path]::GetFullPath($OperationRoot)
if(-not (Within (Join-Path $owner 'backups') $operation) -or ((Test-Path -LiteralPath $operation) -and -not $ResumePrepared)){throw 'fresh_owned_operation_required'}
$lockRoot=Join-Path $owner 'control-plane/mobile-public-runtime'
$lock=[IO.File]::Open((Join-Path $lockRoot 'activation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
 if($ResumePrepared){
  $receiptFile=Regular (Join-Path $operation 'activation.json')
  $receipt=[IO.File]::ReadAllText($receiptFile)|ConvertFrom-Json -AsHashtable
  if($receipt.state -cne 'PREPARED' -or $receipt.normalStopAck -or $receipt.taskUpdated -or $receipt.startAttempted -or $receipt.startAccepted -or $receipt.previousConfig -cne $config -or $receipt.previousConfigSha256 -cne $ExpectedConfigSha256){throw 'prepared_without_dispatch_required'}
  if([IO.File]::ReadAllText((Regular (Join-Path $operation 'task.before.xml'))) -cne $xml){throw 'prepared_task_preimage_changed'}
  $op=$receipt.operationId;$release=[IO.Path]::GetFullPath($receipt.candidateRoot)
  $nextFile=Regular $receipt.newConfig;$nextHash=$receipt.newConfigSha256
  if(-not (Within (Join-Path $owner 'control-plane/mobile-public-runtime') $nextFile) -or (Hash $nextFile) -cne $nextHash -or -not (Within (Join-Path $owner 'releases/cli') $release)){throw 'prepared_candidate_changed'}
  $next=[IO.File]::ReadAllText($nextFile)|ConvertFrom-Json -AsHashtable
  if($next.releaseRoot -cne $release -or $next.port -ne $cfg.port -or $next.remoteOrigin -cne $cfg.remoteOrigin -or $next.nodeExecutable -cne $cfg.nodeExecutable -or $next.nodeSha256 -cne $cfg.nodeSha256){throw 'prepared_runtime_scope_changed'}
  $newManifest=Regular (Join-Path $release '.aicc-release.json')
  if((Hash $newManifest) -cne $next.releaseManifestSha256){throw 'prepared_manifest_changed'}
  $manifest=[IO.File]::ReadAllText($newManifest)|ConvertFrom-Json -AsHashtable
  if($manifest.component -cne 'mobile-public-control' -or $manifest.operationId -cne $op){throw 'prepared_operation_changed'}
  foreach($pin in $manifest.files){$file=[IO.Path]::GetFullPath((Join-Path $release $pin.path));if(-not (Within $release $file) -or (Hash (Regular $file)) -cne $pin.sha256 -or (Get-Item -LiteralPath $file).Length -ne $pin.size){throw 'prepared_file_changed'}}
  $launcher=Regular (Join-Path $operation 'mobile-public-runtime.hidden.vbs')
  $pwsh=Regular (Join-Path $PSHOME 'pwsh.exe');$supervisor=Regular (Join-Path $release 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1')
  $command='"'+$pwsh+'" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$supervisor+'" -ConfigFile "'+$nextFile+'" -ExpectedConfigSha256 '+$nextHash
  $expectedLauncher="Option Explicit`r`nDim shell`r`nSet shell = CreateObject(""WScript.Shell"")`r`nWScript.Quit shell.Run("""+$command.Replace('"','""')+""",0,True)`r`n"
  if([IO.File]::ReadAllText($launcher) -cne $expectedLauncher){throw 'prepared_launcher_changed'}
  if(Test-Path -LiteralPath (Join-Path (Split-Path -Parent $config) ('stop-requests/'+$op+'/request.json'))){throw 'original_stop_request_preserved_no_replay'}
 }else{
 New-Item -ItemType Directory -Path $operation|Out-Null
 $operation= (Resolve-Path -LiteralPath $operation).Path
 NewText (Join-Path $operation 'task.before.xml') $xml
 NewText (Join-Path $operation 'config.before.json') ([IO.File]::ReadAllText($config))
 $op=[guid]::NewGuid().ToString();$runtimeId=[guid]::NewGuid().ToString()
 $release=Join-Path $owner ('releases/cli/mobile-cowork-'+$runtimeId.Replace('-',''))
 New-Item -ItemType Directory -Path $release|Out-Null
 $pins=[ordered]@{}
 foreach($pin in $manifest.files){
  $file=[IO.Path]::GetFullPath((Join-Path $base $pin.path))
  if(-not (Within $base $file) -or $pins.Contains($pin.path)){throw 'invalid_baseline_pin'}
  $file=Regular $file
  if((Get-Item -LiteralPath $file).Length -ne $pin.size -or (Hash $file) -cne $pin.sha256){throw 'baseline_file_changed'}
  $target=Join-Path $release $pin.path;New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null
  Copy-Item -LiteralPath $file -Destination $target
  $pins[$pin.path]=$pin
 }
 foreach($relative in @('public/ai-cowork.js','public/ai-cowork.json','src/management-overview.mjs')){
  $file=Regular (Join-Path $SourceRoot $relative);$target=Join-Path $release $relative
  Copy-Item -LiteralPath $file -Destination $target -Force
  $pins[$relative]=@{path=$relative;size=(Get-Item -LiteralPath $file).Length;sha256=(Hash $file)}
 }
 # Preserve the older public UI and APIs; add only the guide to that version.
 $guideSource=[IO.File]::ReadAllText((Regular (Join-Path $SourceRoot 'public/mobile.html')))
 $guide=[regex]::Match($guideSource,'<section id="cowork">[\s\S]*?</section>').Value
 if(-not $guide){throw 'guide_section_required'}
 $target=Join-Path $release 'public/mobile.html';$text=[IO.File]::ReadAllText($target)
 if(-not $text.Contains('</nav>')){throw 'existing_public_navigation_not_recognized'}
 $hiddenGuide=$guide.Replace('<section id="cowork">','<section id="cowork" hidden>')
 if($text.Contains('id="cowork"')){
  $pattern='<section id="cowork"(?: hidden)?>[\s\S]*?</section>'
  if([regex]::Matches($text,$pattern).Count -ne 1){throw 'single_existing_guide_required'}
  $text=[regex]::Replace($text,$pattern,[Text.RegularExpressions.MatchEvaluator]{param($match)$hiddenGuide})
  $text=$text.Replace('<a href="#cowork">AI 협업</a>','<a href="#cowork">AICC 관리기</a>')
 }else{$text=$text.Replace('</nav>','<a href="#cowork">AICC 관리기</a></nav>'+[Environment]::NewLine+$hiddenGuide)}
 [IO.File]::WriteAllText($target,$text,$utf8)
 $target=Join-Path $release 'public/mobile.js';$text=[IO.File]::ReadAllText($target)
 $extension=@'
import { createCoworkView } from '/ai-cowork.js';
const coworkGuide=createCoworkView();
function showCoworkGuide(){const active=location.hash==='#cowork';document.body.classList.toggle('cowork-view',active);document.getElementById('cowork').hidden=!active;if(active)void coworkGuide.load();}
window.addEventListener('hashchange',showCoworkGuide);showCoworkGuide();
'@
 if(-not $text.Contains("import { createCoworkView } from '/ai-cowork.js';")){$text+=[Environment]::NewLine+$extension}
 [IO.File]::WriteAllText($target,$text,$utf8)
 $target=Join-Path $release 'public/mobile.css';$text=[IO.File]::ReadAllText($target)
 $text+=[Environment]::NewLine+'body.cowork-view main>section:not(#cowork){display:none}#cowork dt{font-weight:600;overflow-wrap:anywhere}#cowork dd{margin:.35rem 0 1.2rem;overflow-wrap:anywhere}#cowork h3{margin-top:1.4rem}#cowork .list-toolbar{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}'
 $managerStyle=[regex]::Match([IO.File]::ReadAllText((Regular (Join-Path $SourceRoot 'public/mobile.css'))),'(?m)^\.cowork-manager-tabs[^\r\n]*').Value
 if(-not $managerStyle){throw 'manager_navigation_style_required'}
 if($text -match '(?m)^\.cowork-manager-tabs[^\r\n]*'){$text=[regex]::Replace($text,'(?m)^\.cowork-manager-tabs[^\r\n]*',[Text.RegularExpressions.MatchEvaluator]{param($match)$managerStyle})}else{$text+=[Environment]::NewLine+$managerStyle}
 [IO.File]::WriteAllText($target,$text,$utf8)
 # Keep the installed backend bytes except the two new static resource names.
 $relative='src/mobile-control.mjs';$target=Join-Path $release $relative;$text=[IO.File]::ReadAllText($target)
 $oldList="['/mobile.html','/mobile.js','/mobile.css'].includes(url.pathname)"
 $currentList="['/mobile.html','/mobile.js','/mobile.css','/mobile-quota.js','/mobile-quota.css','/mobile-tools.js'].includes(url.pathname)"
 $guideList="['/mobile.html','/mobile.js','/mobile.css','/ai-cowork.js','/ai-cowork.json'].includes(url.pathname)"
 $fullGuideList="['/mobile.html','/mobile.js','/mobile.css','/mobile-quota.js','/mobile-quota.css','/mobile-tools.js','/ai-cowork.js','/ai-cowork.json'].includes(url.pathname)"
 if(-not $text.Contains($oldList) -and -not $text.Contains($currentList) -and -not $text.Contains($guideList) -and -not $text.Contains($fullGuideList)){throw 'installed_static_allowlist_not_recognized'}
 $text=$text.Replace($oldList,"['/mobile.html','/mobile.js','/mobile.css','/ai-cowork.js','/ai-cowork.json'].includes(url.pathname)").Replace($currentList,"['/mobile.html','/mobile.js','/mobile.css','/mobile-quota.js','/mobile-quota.css','/mobile-tools.js','/ai-cowork.js','/ai-cowork.json'].includes(url.pathname)")
 $import="import { readManagementOverview } from './management-overview.mjs';"
 if(-not $text.Contains($import)){$text=$import+[Environment]::NewLine+$text}
 $route="        if (req.method === 'GET' && url.pathname === '/api/mobile/management') { send(res, 200, readManagementOverview(owner)); return true; }"
 if(-not $text.Contains("url.pathname === '/api/mobile/management'")){
  $anchor="        if (req.method === 'GET' && url.pathname === '/api/mobile/web')"
  if($text.Split([string[]]@($anchor),[StringSplitOptions]::None).Count -ne 2){throw 'authenticated_management_route_anchor_required'}
  $text=$text.Replace($anchor,$route+[Environment]::NewLine+$anchor)
 }
 [IO.File]::WriteAllText($target,$text,$utf8)
 $pins[$relative]=@{path=$relative;size=(Get-Item -LiteralPath $target).Length;sha256=(Hash $target)}
 foreach($relative in @('public/mobile.html','public/mobile.js','public/mobile.css')){$target=Join-Path $release $relative;$pins[$relative]=@{path=$relative;size=(Get-Item -LiteralPath $target).Length;sha256=(Hash $target)}}
 $manifest.operationId=$op;$manifest.baseline=$base;$manifest.files=@($pins.Values);$manifest.fileCount=$pins.Count
 $newManifest=Join-Path $release '.aicc-release.json';NewText $newManifest ($manifest|ConvertTo-Json -Depth 12)
 $newConfigRoot=Join-Path $lockRoot $runtimeId;New-Item -ItemType Directory -Path $newConfigRoot|Out-Null
 $next=$cfg.Clone();$next.runtimeId=$runtimeId;$next.releaseRoot=$release;$next.releaseManifestSha256=Hash $newManifest
 $next.controlNonce=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
 $next.statusFile=Join-Path $owner ('runtime/mobile-public-control/'+$runtimeId+'/status.json')
 $nextFile=Join-Path $newConfigRoot 'runtime.json';NewText $nextFile ($next|ConvertTo-Json -Depth 8);$nextHash=Hash $nextFile
 $supervisor=Regular (Join-Path $release 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1')
 $pwsh=Regular (Join-Path $PSHOME 'pwsh.exe');$launcher=Join-Path $operation 'mobile-public-runtime.hidden.vbs'
 if(@($pwsh,$supervisor,$nextFile,$launcher)|Where-Object {$_ -match '["\r\n]'}){throw 'unsafe_launcher_argument'}
 $command='"'+$pwsh+'" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$supervisor+'" -ConfigFile "'+$nextFile+'" -ExpectedConfigSha256 '+$nextHash
 NewText $launcher ("Option Explicit`r`nDim shell`r`nSet shell = CreateObject(""WScript.Shell"")`r`nWScript.Quit shell.Run("""+$command.Replace('"','""')+""",0,True)`r`n")
 $receipt=@{operationId=$op;state='PREPARED';previousConfig=$config;previousConfigSha256=$ExpectedConfigSha256;candidateRoot=$release;newConfig=$nextFile;newConfigSha256=$nextHash;normalStopAck=$false;taskUpdated=$false;startAttempted=$false;startAccepted=$false;verification='NOT_RUN';automaticReplay=$false;deviceTrustChanged=$false;modelRouteChanged=$false;publicOriginChanged=$false}
 $receiptFile=Join-Path $operation 'activation.json'
 }
 function Record{$temp=$receiptFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp';NewText $temp ($receipt|ConvertTo-Json -Depth 8);[IO.File]::Move($temp,$receiptFile,$true)}
 Record
 # Pin/CAS immediately before the one supported normal-stop request.
 if((Hash $config) -cne $ExpectedConfigSha256 -or (TextHash (Export-ScheduledTask -InputObject (Get-ScheduledTask -TaskName $taskName -TaskPath '\'))) -cne $xmlHash){throw 'original_runtime_changed'}
 $receipt.state='NORMAL_STOP_REQUESTED';Record
 $stop=& (Join-Path $PSScriptRoot 'Request-AiccMobilePublicStop.ps1') -ConfigFile $config -ExpectedConfigSha256 $ExpectedConfigSha256 -OperationId $op -Submit -WaitSeconds 15 |ConvertFrom-Json
 if(-not $stop.transitionReady){$receipt.state='HOLD_NORMAL_STOP_UNCONFIRMED';Record;throw 'normal_stop_not_confirmed_no_replay'}
 $receipt.normalStopAck=$true;Record
 $deadline=[DateTimeOffset]::UtcNow.AddSeconds(15)
 while((Get-ScheduledTask -TaskName $taskName).State -ne 'Ready' -and [DateTimeOffset]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 250}
 if((Get-ScheduledTask -TaskName $taskName).State -ne 'Ready' -or (TextHash (Export-ScheduledTask -InputObject (Get-ScheduledTask -TaskName $taskName -TaskPath '\'))) -cne $xmlHash){throw 'stopped_task_changed'}
 if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -EQ 4383).Count){throw 'listener_preserved_no_start'}
 $doc=[xml]::new();$doc.XmlResolver=$null;$doc.LoadXml($xml)
 $ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('t',$doc.DocumentElement.NamespaceURI)
 $exec=$doc.SelectSingleNode('/t:Task/t:Actions/t:Exec',$ns);$exec.SelectSingleNode('t:Arguments',$ns).InnerText='/b /nologo "'+$launcher+'"'
 $working=$exec.SelectSingleNode('t:WorkingDirectory',$ns);if($working){$working.InnerText=$operation}
 $receipt.state='TASK_UPDATE_ATTEMPTED';Record
 $null=Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $doc.OuterXml -Force
 $receipt.taskUpdated=$true;$receipt.startAttempted=$true;$receipt.state='START_OUTCOME_UNKNOWN';Record
 Start-ScheduledTask -TaskName $taskName -TaskPath '\'
 $receipt.startAccepted=$true;$receipt.state='START_ACCEPTED_FUNCTION_UNOBSERVED';Record
 @{state=$receipt.state;receipt=$receiptFile;releaseRoot=$release;normalStopAck=$true;startAccepted=$true;verification='NOT_RUN'}|ConvertTo-Json -Compress
}finally{$lock.Dispose()}
