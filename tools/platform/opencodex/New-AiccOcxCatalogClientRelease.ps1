#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$CodexPath)
$ErrorActionPreference='Stop'
# Metadata-only revision of an already accepted immutable runtime. Never import
# current dirty adapters, alter accounts or activate a service here.
function Digest([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Regular([string]$Path){
 if(-not [IO.Path]::IsPathFullyQualified($Path)){throw 'Absolute file required'}
 for($cursor=[IO.Path]::GetFullPath($Path);$cursor;$cursor=Split-Path $cursor -Parent){
  if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked input refused'}
 }
 if((Get-Item -LiteralPath $Path).PSIsContainer){throw 'Regular file required'}
}
function Json([string]$Path){Regular $Path;Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function WriteNew([string]$Path,$Value){
 $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 24));$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function VerifiedClientVersion([string]$Text,[string]$Baseline){
 if($Text -cnotmatch '^codex-cli (\d+\.\d+\.\d+)$'){throw 'Actual official CLI version required'}
 $version=$Matches[1]
 if($Baseline -notmatch '^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$' -or [version]$version -lt [version]($Baseline -replace '[-+].*$','')){throw 'Client version downgrade refused'}
 return $version
}
$owner=[Environment]::GetFolderPath('UserProfile')
$registryPath=Join-Path $owner '.ai-control-center/runtime/ocx-local/current.json'
$registrySha=Digest $registryPath;$registry=Json $registryPath
if($registry.schemaVersion -ne 1 -or $registry.version -cne '2.96.0' -or $registry.requestExecution -cne 'windows-local' -or $registry.credentialWriter -cne 'a1'){throw 'Registered accepted local runtime required'}
$manifestPath=$registry.adapterManifest;$manifestSha=Digest $manifestPath;$manifest=Json $manifestPath
$root=Split-Path $manifestPath -Parent
$acceptancePath=Join-Path $root 'compatibility-acceptance.json';$acceptance=Json $acceptancePath
if($manifest.schema -cne 'aicc-external-ocx-release/v1' -or $manifest.supplierVersion -cne '2.96.0' -or
 $manifest.Contains('sharedLauncher') -or $manifest.adapterFiles.Count -lt 14 -or $manifest.supplierFiles.Count -lt 1 -or
 $acceptance.schema -cne 'aicc-external-ocx-acceptance/v1' -or $acceptance.accepted -cne $true -or
 $acceptance.verification -cne 'FIXTURE_PASS' -or $acceptance.fixtureOnly -cne $false -or
 (Digest $acceptancePath) -cne $manifest.acceptanceSha256){throw 'Accepted unchanged standalone baseline required'}
foreach($pair in @(@($manifest.adapterFiles,$acceptance.sourceSha256),@($manifest.supplierFiles,$acceptance.supplierFiles))){
 if($pair[0].Count -ne $pair[1].Count){throw 'Baseline acceptance inventory mismatch'}
 foreach($key in $pair[0].Keys){if($pair[0][$key] -cne $pair[1][$key]){throw 'Baseline acceptance pin mismatch'}}
}
foreach($inventory in @(@($root,$manifest.adapterFiles),@($manifest.supplierRoot,$manifest.supplierFiles))){
 foreach($name in $inventory[1].Keys){
  if($name -match '(^/|\\|:|(^|/)\.\.?(/|$)|[\x00-\x1f])'){throw 'Unsafe baseline member'}
  $file=Join-Path $inventory[0] $name;Regular $file
  if((Digest $file) -cne $inventory[1][$name]){throw 'Installed baseline file changed'}
 }
}
Regular $CodexPath;$clientSha=Digest $CodexPath
$signature=Get-AuthenticodeSignature -LiteralPath $CodexPath
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O="?OpenAI OpCo, LLC"?(?:,|$)'){throw 'Valid OpenAI signed CLI required'}
$versionText=(& $CodexPath --version|Out-String).Trim()
if($LASTEXITCODE -ne 0){throw 'Official CLI version failed'}
$version=VerifiedClientVersion $versionText $manifest.codexClientVersion
if($version -ceq $manifest.codexClientVersion){throw 'Client metadata already current; no duplicate release'}
$receipt=@{schema='aicc-ocx-client-metadata/v1';baselineManifestSha256=$manifestSha;registrySha256=$registrySha;
 cliPath=[IO.Path]::GetFullPath($CodexPath);cliSha256=$clientSha;signature='Valid';signer=$signature.SignerCertificate.Subject;
 clientVersion=$version;previousClientVersion=$manifest.codexClientVersion;scope='model-metadata-client-version-only';
 adapterChanges=0;supplierChanges=0;accountChanges=0;modelCalls=0;createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
$id=('catalog-client-'+$version+'-'+$manifestSha.Substring(0,12)+'-'+$clientSha.Substring(0,12))
$release=Join-Path $owner ('.ai-control-center/opencodex-native/external-candidates/2.96.0/'+$id)
if(Test-Path -LiteralPath $release){throw 'Immutable client release exists; reconcile original result'}
if((Digest $registryPath) -cne $registrySha -or (Digest $manifestPath) -cne $manifestSha -or (Digest $CodexPath) -cne $clientSha){throw 'Client release inputs changed'}
New-Item -ItemType Directory -Path $release|Out-Null
foreach($name in $manifest.adapterFiles.Keys){
 Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $release $name)
 if((Digest (Join-Path $release $name)) -cne $manifest.adapterFiles[$name]){throw 'Copied baseline adapter changed'}
}
WriteNew (Join-Path $release 'client-metadata.json') $receipt
$acceptance.clientMetadataSha256=Digest (Join-Path $release 'client-metadata.json')
$acceptance.previousAcceptanceSha256=Digest $acceptancePath
WriteNew (Join-Path $release 'compatibility-acceptance.json') $acceptance
$manifest.codexClientVersion=$version;$manifest.acceptanceSha256=Digest (Join-Path $release 'compatibility-acceptance.json')
$manifest.clientMetadataSha256=$acceptance.clientMetadataSha256
WriteNew (Join-Path $release 'release-manifest.json') $manifest
@{state='PREPARED_NOT_ACTIVE';releaseManifest=(Join-Path $release 'release-manifest.json');clientVersion=$version;
 previousClientVersion=$receipt.previousClientVersion;adapterChanges=0;supplierChanges=0;modelCalls=0;runtimeChanged=$false}|ConvertTo-Json
