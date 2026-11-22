#requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$stateRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$registryFile=Join-Path $stateRoot 'runtime\components.json'
$registry=Get-Content -LiteralPath $registryFile -Raw|ConvertFrom-Json -AsHashtable
$backend=$registry.components.workspace.releaseRoot
$gateway=$registry.components['unified-mcp'].releaseRoot
$hostComponent=$registry.components['workspace-host']
$serverRelative='components\workspace-mcp\server.mjs'
$guardRelative='components\workspace-mcp\destructive-command-guard.mjs'
$integrityRelative='components\workspace-mcp\runtime-integrity.mjs'
$guardSource=Join-Path $PSScriptRoot '..\..\..\components\workspace-mcp\destructive-command-guard.mjs'
function Hash([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function WriteJson([string]$p,$v){[IO.File]::WriteAllText($p,($v|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))}
function CloneRegular([string]$from,[string]$to){
  $items=@(Get-ChildItem -LiteralPath $from -Recurse -Force)
  if((Get-Item -LiteralPath $from).LinkType -or @($items|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Linked code tree preserved; no clone'}
  New-Item -ItemType Directory -Path $to|Out-Null
  foreach($item in $items){
    $target=Join-Path $to ([IO.Path]::GetRelativePath($from,$item.FullName))
    if($item.PSIsContainer){New-Item -ItemType Directory -Path $target -Force|Out-Null}
    else{New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force|Out-Null;Copy-Item -LiteralPath $item.FullName -Destination $target}
  }
}
foreach($pair in @(@($backend,'workspace'),@($gateway,'unified-mcp'))){
  if(-not $pair[0].StartsWith((Join-Path $stateRoot ('releases\'+$pair[1]+'\')),[StringComparison]::OrdinalIgnoreCase)){throw 'Managed code owner required'}
}
$server=[IO.File]::ReadAllText((Join-Path $backend $serverRelative))
if($server.Contains('assertSafeWorkspaceCommand')){throw 'Guard already present; inspect its receipt before preparing'}
$needle='function startCommand(root, runtimeRoot, command, config, yieldTimeMs, remoteLease) {'
if($server.Split($needle,[StringSplitOptions]::None).Count -ne 2){throw 'Baseline dispatch differs'}
$newline=if($server.Contains("`r`n")){"`r`n"}else{"`n"}
$server=$server.Replace("import os from 'node:os';","import os from 'node:os';"+$newline+"import { assertSafeWorkspaceCommand } from './destructive-command-guard.mjs';")
$server=$server.Replace($needle,$needle+$newline+'  assertSafeWorkspaceCommand(command, { workspaceRoot: root, stateRoot: runtimeRoot, home: os.homedir(), env: process.env });')
$integrity=[IO.File]::ReadAllText((Join-Path $backend $integrityRelative))
$integrityNeedle="  'components/workspace-mcp/runtime-marker.mjs',"
if($integrity.Split($integrityNeedle,[StringSplitOptions]::None).Count -ne 2 -or $integrity.Contains("'components/workspace-mcp/destructive-command-guard.mjs'")){throw 'Baseline runtime closure differs'}
$integrity=$integrity.Replace($integrityNeedle,$integrityNeedle+$newline+"  'components/workspace-mcp/destructive-command-guard.mjs',")
$guardHash=Hash $guardSource
$id=(Hash (Join-Path $backend $serverRelative)).Substring(0,8)+'-'+$guardHash.Substring(0,8)+'-closure-v3'
$candidate=Join-Path $stateRoot ('releases\workspace\workspace-command-guard-'+$id)
$newGateway=Join-Path $stateRoot ('releases\unified-mcp\workspace-command-guard-'+$id+'')
if(Test-Path -LiteralPath $newGateway){throw 'Gateway candidate already exists; preserve immutable code'}
if(Test-Path -LiteralPath $candidate){
  $expected=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($server))).ToLowerInvariant()
  $expectedIntegrity=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($integrity))).ToLowerInvariant()
  if((Hash (Join-Path $candidate $serverRelative)) -cne $expected -or (Hash (Join-Path $candidate $guardRelative)) -cne $guardHash -or (Hash (Join-Path $candidate $integrityRelative)) -cne $expectedIntegrity){throw 'Existing backend overlay differs; preserve it'}
}else{
CloneRegular $backend $candidate
[IO.File]::WriteAllText((Join-Path $candidate $serverRelative),$server,[Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $guardSource -Destination (Join-Path $candidate $guardRelative)
[IO.File]::WriteAllText((Join-Path $candidate $integrityRelative),$integrity,[Text.UTF8Encoding]::new($false))
$releaseFile=Join-Path $candidate '.aicc-release.json'
$release=Get-Content -LiteralPath $releaseFile -Raw|ConvertFrom-Json -AsHashtable
foreach($row in $release.files){if($row.path -in @($serverRelative.Replace('\','/'),$integrityRelative.Replace('\','/'))){$updated=Join-Path $candidate $row.path;$row.sha256=Hash $updated;$row.size=(Get-Item -LiteralPath $updated).Length}}
$release.files+=@{path=$guardRelative.Replace('\','/');sha256=$guardHash;size=(Get-Item -LiteralPath $guardSource).Length}
$release.fileCount=$release.files.Count;$release.totalBytes=($release.files|Measure-Object -Property size -Sum).Sum
$release.commandGuardOverlay=@{baseline=$backend;guardSha256=$guardHash;serverSha256=Hash (Join-Path $candidate $serverRelative)}
WriteJson $releaseFile $release
$driveFile=Join-Path $candidate 'workspace-drive-manifest.json'
$drive=Get-Content -LiteralPath $driveFile -Raw|ConvertFrom-Json -AsHashtable
$drive.baseline=$backend;$drive.release=$candidate
foreach($relative in @($serverRelative,$guardRelative,$integrityRelative,'.aicc-release.json')){$drive.files[$relative.Replace('\','/')]=Hash (Join-Path $candidate $relative)}
WriteJson $driveFile $drive
}
CloneRegular $gateway $newGateway
$gatewayConfigFile=Join-Path $newGateway 'config.json'
$configuration=Get-Content -LiteralPath $gatewayConfigFile -Raw|ConvertFrom-Json -AsHashtable
$provider=@($configuration.providers|Where-Object id -eq 'workspace')
if($provider.Count -ne 1){throw 'Exact Workspace provider required'}
$provider=$provider[0]
$provider.entrypoint=([string]$provider.entrypoint).Replace($backend,$candidate)
$provider.args=@($provider.args|ForEach-Object{([string]$_).Replace($backend,$candidate)})
foreach($file in $provider.files){$file.path=$file.path.Replace($backend,$candidate);$file.sha256=Hash $file.path}
$provider.files+=@{path=(Join-Path $candidate $guardRelative);sha256=$guardHash}
$provider.files+=@{path=(Join-Path $candidate $integrityRelative);sha256=(Hash (Join-Path $candidate $integrityRelative))}
WriteJson $gatewayConfigFile $configuration
$profile=Join-Path $stateRoot 'workspace-mcp\tunnel\profiles\aicc-workspace.yaml'
$profileText=[IO.File]::ReadAllText($profile)
if(-not $profileText.Contains($gateway.Replace('\','/'))){throw 'Exact gateway profile differs'}
$newProfile=$profileText.Replace($gateway.Replace('\','/'),$newGateway.Replace('\','/'))
$planFile=Join-Path $stateRoot ('runtime\workspace-home-plan-command-guard-'+$id+'.json')
$stagedProfile=$planFile+'.yaml'
[IO.File]::WriteAllText($stagedProfile,$newProfile,[Text.UTF8Encoding]::new($false))
$plan=@{schemaVersion=1;backend=$candidate;originalBackend=$backend;gateway=$newGateway;oldGateway=$gateway;host=$hostComponent.releaseRoot;helperEntry=$hostComponent.entry;helperHashes=$hostComponent.sourceHashes;profile=$profile;profileBeforeHash=Hash $profile;stagedProfile=$stagedProfile;profileAfterHash=Hash $stagedProfile;commandGuardSha256=$guardHash}
WriteJson $planFile $plan
@{status='PREPARED';planFile=$planFile;backend=$candidate;gateway=$newGateway;runtimeChanged=$false}|ConvertTo-Json
