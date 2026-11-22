#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SnapshotPath,[string]$SearchAcceptancePath,[string]$ControlPlaneAcceptancePath,[string]$UserInstallDecisionPath,[ValidateSet('2.81.0','2.96.0')][string]$SupplierVersion='2.81.0',[string]$CompatibilityAcceptancePath)
$ErrorActionPreference='Stop'
if($SupplierVersion -eq '2.96.0'){
  if(-not $CompatibilityAcceptancePath -or $UserInstallDecisionPath -or $SearchAcceptancePath -or $ControlPlaneAcceptancePath){throw '2.96 requires its complete current isolated acceptance; legacy/unverified modes cannot substitute'}
  & (Join-Path $PSScriptRoot 'New-AiccAcceptedOcxRelease.ps1') -SnapshotPath $SnapshotPath -CompatibilityAcceptancePath $CompatibilityAcceptancePath
  return
}
if($UserInstallDecisionPath){
  if($SearchAcceptancePath -or $ControlPlaneAcceptancePath){throw 'User install decision and fixture acceptance are distinct modes'}
  & (Join-Path $PSScriptRoot 'New-AiccUserApprovedOcxRelease.ps1') -SnapshotPath $SnapshotPath -UserInstallDecisionPath $UserInstallDecisionPath
  return
}
$owner=[Environment]::GetFolderPath('UserProfile')
$store=Join-Path $owner '.ai-control-center\opencodex-native'
$supplier=Join-Path $store 'candidates\2.81.0\package'
$artifact=Join-Path $store 'registry-artifacts\2.81.0\d2a5764a8183acca\package.tgz'
$evidence=Join-Path $owner '.codex\ops\ocx-upstream-separation\20261009'
function Hash($path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Json($path){Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json -DateKind String}
function WriteJson($path,$data){[IO.File]::WriteAllText($path,($data|ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false))}
$searchAcceptance=$null
if($SearchAcceptancePath){
  $searchAcceptance=Json $SearchAcceptancePath
  if($searchAcceptance.status -cne 'PASS' -or $searchAcceptance.scope -cne 'isolated-official-alpha-search' -or $searchAcceptance.network -cne 'fixture-only' -or $searchAcceptance.supplierVersion -cne '2.81.0'){throw 'Exact scoped search acceptance required'}
  foreach($name in @('external-stock-dispatch.ts','external-http-boundary.ts','external-runtime.ts','probe-external-search.ts')){
    if((Hash (Join-Path $PSScriptRoot $name)) -cne $searchAcceptance.sourceSha256.$name){throw 'Search acceptance source changed'}
  }
} elseif((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'external-stock-dispatch.ts') -Raw).Contains("load('src/server/search.ts')")){
  throw 'New search relay requires its current scoped acceptance; historical receipts are insufficient'
}
$controlPlaneAcceptance=$null
if($ControlPlaneAcceptancePath){
  $controlPlaneAcceptance=Json $ControlPlaneAcceptancePath
  if($controlPlaneAcceptance.status -cne 'PASS' -or $controlPlaneAcceptance.scope -cne 'official-hidden-control-plane-and-account-admission' -or $controlPlaneAcceptance.network -cne 'fixture-only-no-inference' -or $controlPlaneAcceptance.supplierVersion -cne '2.81.0' -or $controlPlaneAcceptance.runtimeChanged -cne $false -or @($controlPlaneAcceptance.checks).Count -ne 8){throw 'Exact scoped control-plane acceptance required'}
  foreach($name in @('external-stock-dispatch.ts','external-pool-state.ts','external-account-picker.ts','external-credential-owner.ts','external-request-body.ts','window-inflight-monitor.ts','probe-external-control-plane.ts')){
    if((Hash (Join-Path $PSScriptRoot $name)) -cne $controlPlaneAcceptance.sourceSha256.$name){throw 'Control-plane acceptance source changed'}
  }
} elseif((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'external-pool-state.ts') -Raw -Encoding UTF8).Contains('controlPlaneModel')){
  throw 'Hidden control-plane admission requires its current scoped acceptance; observation projections are insufficient'
}
$artifactReceipt=Json (Join-Path (Split-Path $artifact -Parent) 'upstream-artifact.json')
if((Get-FileHash -LiteralPath $artifact -Algorithm SHA512).Hash.ToLowerInvariant() -cne $artifactReceipt.sha512){throw 'Registry artifact changed'}
$stream=[IO.File]::OpenRead($artifact)
$gzip=[IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionMode]::Decompress)
$tar=[System.Formats.Tar.TarReader]::new($gzip)
$verified=0
try{
  while($entry=$tar.GetNextEntry()){
    if($null -eq $entry.DataStream){continue}
    if(-not $entry.Name.StartsWith('package/') -or $entry.Name.Contains('..')){throw 'Unexpected supplier archive entry'}
    $name=$entry.Name.Substring(8)
    $path=Join-Path $supplier $name
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$archiveHash=([BitConverter]::ToString($sha.ComputeHash($entry.DataStream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    if((Hash $path) -cne $archiveHash){throw 'Clean supplier differs from official archive'}
    $verified++
  }
}finally{$tar.Dispose();$gzip.Dispose();$stream.Dispose()}
if($verified -lt 20 -or (Json (Join-Path $supplier 'package.json')).version -cne '2.81.0'){throw 'Supplier identity unknown'}
$receipts=@{}
foreach($name in @('boundary','stock','pool','management','socket','live','wire')){
  $path=Join-Path $evidence ('external-'+$name+'-acceptance.json')
  if((Json $path).status -cne 'PASS'){throw 'Compatibility evidence not PASS'}
  $receipts[$name]=$path
}
$snapshot=Json (Join-Path $SnapshotPath 'snapshot.json')
foreach($file in $snapshot.files){if((Hash (Join-Path $SnapshotPath $file.backupFile)) -cne $file.sha256 -or (Hash $file.path) -cne $file.sha256){throw 'Fresh software preimage differs'}}
$recovery=Get-ChildItem -LiteralPath $evidence -Directory -Filter 'recovery-fixture-*'|Where-Object{Test-Path -LiteralPath (Join-Path $_.FullName 'operations')}|Sort-Object LastWriteTime -Descending|Select-Object -First 1
$resultFile=Get-ChildItem -LiteralPath (Join-Path $recovery.FullName 'operations') -Filter result.json -Recurse|Select-Object -First 1
$result=Json $resultFile.FullName
if($result.state -cne 'RECOVERED' -or @(Get-Content -LiteralPath (Join-Path $resultFile.DirectoryName 'fixture-runs.txt')).Count -ne 1){throw 'Isolated exactly-once recovery proof required'}
$checks=[ordered]@{}
$mapping=[ordered]@{stockArtifact=$artifact;credentialOwner=$receipts.boundary;windowAdmission=$receipts.boundary;inflightLifetime=$receipts.boundary;manualAccountPolicy=$receipts.pool;modelEntitlements=$receipts.pool;nativeIsolation=$receipts.live;catalogParity=$receipts.stock;continuationParity=$receipts.stock;transportParity=$receipts.socket;managementParity=$receipts.management;softwareRollback=(Join-Path $SnapshotPath 'snapshot.json');requestCompression=$receipts.wire;legacyManagementAuth=$receipts.wire}
foreach($key in $mapping.Keys){$checks[$key]=@{status='PASS';evidence=$mapping[$key];sha256=Hash $mapping[$key]}}
if($searchAcceptance){$checks['searchRelay']=@{status='PASS';evidence=$SearchAcceptancePath;sha256=Hash $SearchAcceptancePath;scope='isolated official search relay only; live search pending'}}
if($controlPlaneAcceptance){$checks['controlPlaneAdmission']=@{status='PASS';evidence=$ControlPlaneAcceptancePath;sha256=Hash $ControlPlaneAcceptancePath;scope='isolated official hidden control-plane admission only; live approval review pending'}}
$acceptance=@{schema='aicc-external-ocx-acceptance/v1';accepted=$true;supplierVersion='2.81.0';checks=$checks;stockArchiveFilesVerified=$verified;rollbackProof=@{scope='four-file verified fresh preimage and isolated exactly-once worker; production restoration verified after cutover';fixture=$resultFile.FullName;runtimeCyclePending=$true};createdAt=[DateTime]::UtcNow.ToString('o')}
if($searchAcceptance){$acceptance['changeScope']=@{kind='alpha-search-relay';currentEvidence=$SearchAcceptancePath;baselineEvidence='Historical compatibility receipts retained, not rerun or relabeled as new validation';liveSearchVerified=$false}}
if($controlPlaneAcceptance){$acceptance['changeScope']=@{kind='hidden-control-plane-admission';currentEvidence=$ControlPlaneAcceptancePath;searchEvidence=$SearchAcceptancePath;baselineEvidence='Historical compatibility receipts retained, not rerun or relabeled as new validation';liveApprovalReviewVerified=$false;liveSearchVerified=$false}}
$adapterFiles=[ordered]@{}
foreach($file in @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'external-*.ts')+(Get-Item -LiteralPath (Join-Path $PSScriptRoot 'window-inflight-monitor.ts'))|Sort-Object Name){$adapterFiles[$file.Name]=Hash $file.FullName}
$sha=[Security.Cryptography.SHA256]::Create()
try{$releaseId=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($adapterFiles|ConvertTo-Json -Compress))))).Replace('-','').ToLowerInvariant().Substring(0,16)}finally{$sha.Dispose()}
$root=Join-Path $store ('external-candidates\2.81.0\'+$releaseId)
if(Test-Path -LiteralPath $root){throw 'Immutable release already exists; preserve it'}
New-Item -ItemType Directory -Path $root|Out-Null
foreach($name in $adapterFiles.Keys){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root $name)}
$acceptanceFile=Join-Path $root 'compatibility-acceptance.json'
WriteJson $acceptanceFile $acceptance
$supplierFiles=[ordered]@{}
foreach($file in Get-ChildItem -LiteralPath $supplier -File -Recurse|Sort-Object FullName){
  if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked supplier file refused'}
  $name=[IO.Path]::GetRelativePath($supplier,$file.FullName).Replace('\','/')
  $supplierFiles[$name]=Hash $file.FullName
}
$manifest=@{schema='aicc-external-ocx-release/v1';supplierVersion='2.81.0';supplierRoot=$supplier;adapterVersion='0.1.1';requestExecution='windows-local';credentialWriter='a1';nativeExcluded=$true;codexClientVersion='0.162.0-alpha.2';adapterFiles=$adapterFiles;supplierFiles=$supplierFiles;acceptanceSha256=Hash $acceptanceFile;registryIntegrity=$artifactReceipt.integrity}
$manifestPath=Join-Path $root 'release-manifest.json'
WriteJson $manifestPath $manifest
@{status='PASS';releaseManifest=$manifestPath;officialArchiveFilesVerified=$verified;supplierFilesPinned=$supplierFiles.Count;adapterFiles=$adapterFiles.Count;runtimeActivated=$false}|ConvertTo-Json
