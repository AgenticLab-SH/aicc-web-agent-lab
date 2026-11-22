#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigFile,[Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedConfigSha256)
$ErrorActionPreference='Stop'
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
function RequireRegular([string]$File,[long]$Maximum=16777216){
 $resolved=(Resolve-Path -LiteralPath $File).Path
 for($ancestor=$resolved;;$ancestor=Split-Path -Parent $ancestor){
  $item=Get-Item -LiteralPath $ancestor -Force
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_lifecycle_path_preserved'}
  $parent=Split-Path -Parent $ancestor
  if(-not $parent -or $parent -eq $ancestor){break}
 }
 $item=Get-Item -LiteralPath $resolved -Force
 if($item.PSIsContainer -or $item.Length -gt $Maximum){throw 'regular_lifecycle_file_required'}
 return $resolved
}
$boundary=[IO.Path]::GetFullPath((Join-Path $owner 'control-plane\mobile-public-runtime'))+[IO.Path]::DirectorySeparatorChar
$config=RequireRegular $ConfigFile 65536
if(-not $config.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $config).Hash.ToLowerInvariant() -cne $ExpectedConfigSha256){throw 'exact_owned_runtime_config_required'}
$cfg=Get-Content -LiteralPath $config -Raw|ConvertFrom-Json -AsHashtable -DateKind String
if($cfg.schemaVersion -ne 1 -or $cfg.runtimeId -notmatch '^[a-f0-9-]{36}$' -or $cfg.controlNonce -notmatch '^[a-f0-9]{64}$' -or $cfg.releaseManifestSha256 -notmatch '^[a-f0-9]{64}$' -or $cfg.port -ne 4383){throw 'invalid_scoped_mobile_config'}
# An unavailable listener inventory is UNKNOWN, never permission to start a duplicate.
try{$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop)}catch{throw 'public_listener_inventory_unknown'}
if(@($listeners|Where-Object LocalPort -EQ 4383).Count){throw 'existing_public_listener_preserved'}
$releaseBoundary=[IO.Path]::GetFullPath((Join-Path $owner 'releases\cli'))+[IO.Path]::DirectorySeparatorChar
$release=[IO.Path]::GetFullPath($cfg.releaseRoot)
if(-not $release.StartsWith($releaseBoundary,[StringComparison]::OrdinalIgnoreCase)){throw 'managed_public_release_required'}
$manifestFile=RequireRegular (Join-Path $release '.aicc-release.json')
if((Get-FileHash -LiteralPath $manifestFile).Hash.ToLowerInvariant() -cne $cfg.releaseManifestSha256){throw 'prepared_public_manifest_pin_required'}
$manifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json -AsHashtable -DateKind String
$runner=RequireRegular (Join-Path $release 'tools\platform\windows\mobile-public-runner.mjs')
$pin=@($manifest.files|Where-Object path -CEQ 'tools/platform/windows/mobile-public-runner.mjs')
if($manifest.schemaVersion -ne 1 -or $manifest.component -ne 'mobile-public-control' -or $pin.Count -ne 1 -or $pin[0].sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $runner).Hash.ToLowerInvariant() -cne $pin[0].sha256){throw 'prepared_public_runner_pin_required'}
$requestRoot=Join-Path (Split-Path -Parent $config) 'stop-requests'
$nodePath=RequireRegular ([IO.Path]::GetFullPath($cfg.nodeExecutable)) 134217728
if($cfg.nodeSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $nodePath).Hash.ToLowerInvariant() -cne $cfg.nodeSha256){throw 'owned_node_runtime_pin_required'}
$psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$nodePath
$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden;$psi.RedirectStandardInput=$true;$psi.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
$psi.ArgumentList.Add($runner);$psi.ArgumentList.Add($config)
$node=[Diagnostics.Process]::Start($psi)
try {
 while(-not $node.WaitForExit(1000)){
  if(-not (Test-Path -LiteralPath $requestRoot -PathType Container)){continue}
  $requestItems=@(Get-ChildItem -LiteralPath $requestRoot -Directory | Where-Object {$_.Name -match '^[a-f0-9-]{36}$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)} | Sort-Object Name | Select-Object -First 100)
  foreach($requestItem in $requestItems){
  $requestFile=Join-Path $requestItem.FullName 'request.json';$claimFile=Join-Path $requestItem.FullName 'claim.json'
  if(-not (Test-Path -LiteralPath $requestFile -PathType Leaf) -or (Test-Path -LiteralPath $claimFile)){continue}
  try{$requestPath=RequireRegular $requestFile 4096;$requestBytes=[IO.File]::ReadAllBytes($requestPath);$request=[Text.Encoding]::UTF8.GetString($requestBytes)|ConvertFrom-Json -AsHashtable -DateKind String;$expires=[DateTimeOffset]::Parse([string]$request.expiresAt)}catch{continue}
  if(@($request.Keys|Where-Object {$_ -notin @('action','operationId','runtimeId','expectedPid','releaseManifestSha256','expectedStartedAt','expiresAt')}).Count -or $request.action -cne 'drain-and-stop' -or $request.operationId -cne $requestItem.Name -or $request.runtimeId -cne $cfg.runtimeId -or $request.expectedPid -ne $node.Id -or $request.releaseManifestSha256 -cne $cfg.releaseManifestSha256 -or $expires -lt [DateTimeOffset]::UtcNow -or $expires -gt [DateTimeOffset]::UtcNow.AddSeconds(60)){continue}
  $claim=@{schemaVersion=1;operationId=$request.operationId;runtimeId=$cfg.runtimeId;pid=$node.Id;state='CLAIMED_INPUT_OUTCOME_UNKNOWN';at=[DateTimeOffset]::UtcNow.ToString('o');requestSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($requestBytes)).ToLowerInvariant();automaticReplay=$false}
  $stream=[IO.File]::Open($claimFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($claim|ConvertTo-Json -Compress));$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
  $request.controlNonce=$cfg.controlNonce
  $node.StandardInput.WriteLine(($request|ConvertTo-Json -Compress));$node.StandardInput.Flush()
  # Retain the claim on uncertain delivery or refused drain. Never replay it.
  break
  }
 }
 exit $node.ExitCode
}finally{$node.Dispose()}