#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SnapshotPath,[Parameter(Mandatory)][string]$UserInstallDecisionPath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$utf8=[Text.UTF8Encoding]::new($false)
function Digest([byte[]]$Bytes){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()}
function ReadRegular([string]$Path){
  $full=[IO.Path]::GetFullPath($Path)
  for($cursor=$full;$cursor;$cursor=Split-Path -Parent $cursor){
    $item=Get-Item -LiteralPath $cursor -Force
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked install input refused'}
  }
  if((Get-Item -LiteralPath $full).PSIsContainer){throw 'Regular install input required'}
  return ,([IO.File]::ReadAllBytes($full))
}
function ReadRecord([string]$Path){$utf8.GetString((ReadRegular $Path)) | ConvertFrom-Json -AsHashtable -DateKind String}
function ExactMap($Left,$Right){
  if($Left -isnot [Collections.IDictionary] -or $Right -isnot [Collections.IDictionary] -or $Left.Count -ne $Right.Count -or $Left.Count -eq 0){return $false}
  foreach($name in $Left.Keys){if(-not $Right.Contains($name) -or $Left[$name] -cne $Right[$name]){return $false}}
  return $true
}
$decisionBytes=ReadRegular $UserInstallDecisionPath
$decision=$utf8.GetString($decisionBytes) | ConvertFrom-Json -AsHashtable -DateKind String
$isCurrentDelta=$decision.schema -ceq 'aicc-exact-ocx-user-install-decision/v2'
if($isCurrentDelta -and ($decision.scopeRevision -cne 'g1-rotation-lifecycle-r2-r3' -or $decision.operationId -notmatch '^[a-z0-9][a-z0-9-]{7,120}$')){throw 'Exact current G1 delta operation required'}
if(($decision.schema -cne 'aicc-exact-ocx-user-install-decision/v1' -and -not $isCurrentDelta) -or $decision.action -cne 'INSTALL_EXACT_UNVERIFIED_OCX_DELTA' -or $decision.installationExplicitlyRequested -cne $true -or $decision.target -cne 'ocx-only' -or $decision.verification -cne 'NOT_RUN' -or $decision.userInstruction -isnot [string] -or [string]::IsNullOrWhiteSpace($decision.userInstruction) -or $decision.controllerThreadId -notmatch '^[a-f0-9-]{36}$'){throw 'Exact current user install decision required'}
if($decision.inputPackSha256 -notmatch '^[a-f0-9]{64}$' -or $decision.previousManifestSha256 -notmatch '^[a-f0-9]{64}$' -or (-not $isCurrentDelta -and $decision.originalRuntimeSha256 -notmatch '^[a-f0-9]{64}$')){throw 'Exact adopted input identities required'}
$packBytes=ReadRegular $decision.inputPackPath
if((Digest $packBytes) -cne $decision.inputPackSha256){throw 'Adopted input pack changed'}
$pack=$utf8.GetString($packBytes) | ConvertFrom-Json -AsHashtable -DateKind String
if($isCurrentDelta){
  if($pack.schema -cne 'aicc-ocx-frozen-input-pack/v2' -or $pack.scopeRevision -cne $decision.scopeRevision -or $pack.controllerThreadId -cne $decision.controllerThreadId -or $pack.state -cne 'FROZEN_SOURCE_INPUT_NOT_BUILT_NOT_INSTALLED'){throw 'Exact current frozen source pack required'}
  if($pack.pending.manifestSha256 -notmatch '^[a-f0-9]{64}$' -or (Digest (ReadRegular $pack.pending.manifestPath)) -cne $pack.pending.manifestSha256){throw 'Frozen current draft manifest changed'}
}
$draft=ReadRecord $pack.pending.manifestPath
$baselineManifest=Join-Path $pack.baseline.root 'release-manifest.json'
if((Digest (ReadRegular $baselineManifest)) -cne $decision.previousManifestSha256 -or $pack.baseline.manifestSha256 -cne $decision.previousManifestSha256){throw 'Previous immutable release differs'}
$baseline=ReadRecord $baselineManifest
if($baseline.schema -cne 'aicc-external-ocx-release/v1' -or $baseline.supplierVersion -cne '2.81.0' -or $draft.supplierRoot -ine $baseline.supplierRoot -or -not (ExactMap $draft.supplierFiles $baseline.supplierFiles)){throw 'Sealed supplier inventory differs'}
$baselineAcceptancePath=Join-Path $pack.baseline.root 'compatibility-acceptance.json'
$baselineAcceptance=ReadRecord $baselineAcceptancePath
if((Digest (ReadRegular $baselineAcceptancePath)) -cne $baseline.acceptanceSha256 -or $baselineAcceptance.accepted -cne $true){throw 'Historical release identity differs'}
$snapshot=ReadRecord (Join-Path $SnapshotPath 'snapshot.json')
if($snapshot.schema -cne 'aicc-ocx-software-snapshot/v1' -or @($snapshot.files).Count -ne 4 -or $snapshot.previous.adapterManifest -ine $baselineManifest){throw 'Exact current software snapshot required'}
foreach($file in $snapshot.files){
  if($file.backupFile -notmatch '^[0-3]\.preimage$' -or (Digest (ReadRegular (Join-Path $SnapshotPath $file.backupFile))) -cne $file.sha256 -or (Digest (ReadRegular $file.path)) -cne $file.sha256){throw 'Current software preimage changed'}
}
if($draft.requestExecution -cne 'windows-local' -or $draft.credentialWriter -cne 'a1' -or $draft.nativeExcluded -cne $true){throw 'Runtime authority contract differs'}
foreach($name in $draft.supplierFiles.Keys){
  if($name.StartsWith('/') -or $name.Contains('..') -or $name.Contains('\') -or $draft.supplierFiles[$name] -notmatch '^[a-f0-9]{64}$'){throw 'Supplier inventory path refused'}
  if((Digest (ReadRegular (Join-Path $draft.supplierRoot $name))) -cne $draft.supplierFiles[$name]){throw 'Sealed supplier changed'}
}
$names=@($draft.adapterFiles.Keys | Sort-Object)
if($decision.sourceSha256 -isnot [Collections.IDictionary] -or $decision.sourceSha256.Count -ne $names.Count){throw 'Exact complete approved input inventory required'}
if($isCurrentDelta){
  # Keep every baseline adapter; add the lifecycle fence explicitly. No runtime-only substitution.
  foreach($name in $baseline.adapterFiles.Keys){if($name -cnotin $names){throw 'Current delta cannot drop an installed adapter'}}
  if($names.Count -lt 14 -or $names.Count -gt 32 -or 'external-conversation-lifecycle.ts' -cnotin $names -or 'window-inflight-monitor.ts' -cnotin $names){throw 'Current rotation/lifecycle closure required'}
  foreach($name in $names){if($name -cnotmatch '^(?:external-[a-z0-9-]+|window-inflight-monitor|window-policy-settings)\.ts$'){throw 'Non-runtime input refused'}}
  if(-not (ExactMap $draft.adapterFiles $decision.sourceSha256)){throw 'Frozen current delta differs from approved inputs'}
}else{
  if($names.Count -ne 13){throw 'Legacy runtime-only contract requires its original thirteen inputs'}
}
$buffers=@{};$adapterFiles=[ordered]@{}
foreach($name in $names){
  if($name -notmatch '^[\w.-]+\.ts$' -or -not $decision.sourceSha256.Contains($name)){throw 'Unexpected adapter input'}
  $inputPath=Join-Path $pack.adapterInputRoot $name
  $originalBytes=ReadRegular $inputPath
  if((Digest $originalBytes) -cne $draft.adapterFiles[$name]){throw 'Original adopted input changed'}
  if(-not $isCurrentDelta -and $name -ceq 'external-runtime.ts'){
    if($draft.adapterFiles[$name] -cne $decision.originalRuntimeSha256){throw 'Original runtime input differs'}
    $buffers[$name]=ReadRegular (Join-Path $PSScriptRoot $name)
  }else{$buffers[$name]=$originalBytes}
  $adapterFiles[$name]=Digest $buffers[$name]
  if($adapterFiles[$name] -cne $decision.sourceSha256[$name]){throw 'Explicitly approved adapter input changed'}
}
$inventoryText=$adapterFiles | ConvertTo-Json -Compress
$releaseId=(Digest $utf8.GetBytes($inventoryText)).Substring(0,16)
$candidateRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) ('.ai-control-center\opencodex-native\external-candidates\2.81.0\'+$releaseId)
if(Test-Path -LiteralPath $candidateRoot){throw 'Immutable candidate already exists; preserve and reconcile, do not replay'}
$checks=[ordered]@{}
foreach($key in @('stockArtifact','credentialOwner','windowAdmission','inflightLifetime','manualAccountPolicy','modelEntitlements','nativeIsolation','catalogParity','continuationParity','transportParity','managementParity','softwareRollback','requestCompression','legacyManagementAuth','searchRelay','controlPlaneAdmission','safeFailureTuple','automaticQuotaOrder')){$checks[$key]=@{status='NOT_RUN'}}
$acceptance=[ordered]@{schema='aicc-external-ocx-user-install-acceptance/v1';supplierVersion='2.81.0';accepted=$true;acceptanceMeaning='user explicitly authorized installation; no compatibility test success asserted';verification='NOT_RUN';compatibilityPassed=$false;checks=$checks;sourceSha256=$adapterFiles;userDecisionSha256=(Digest $decisionBytes);historicalBaseline=@{manifestSha256=$decision.previousManifestSha256;acceptanceSha256=$baseline.acceptanceSha256;appliesTo='previous release only; not proof of this delta'};snapshotPath=$SnapshotPath;createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
$acceptanceBytes=$utf8.GetBytes(($acceptance | ConvertTo-Json -Depth 12))
$manifest=[ordered]@{}
foreach($key in @('schema','supplierVersion','supplierRoot','adapterVersion','requestExecution','credentialWriter','nativeExcluded','codexClientVersion','supplierFiles','registryIntegrity')){$manifest[$key]=$baseline[$key]}
$manifest.adapterFiles=$adapterFiles;$manifest.acceptanceSha256=Digest $acceptanceBytes
if($isCurrentDelta){$manifest.scopeRevision=$decision.scopeRevision;$manifest.operationId=$decision.operationId}
$manifest.installationAdmission='USER_AUTHORIZED_UNVERIFIED';$manifest.userDecisionSha256=Digest $decisionBytes
$manifestBytes=$utf8.GetBytes(($manifest | ConvertTo-Json -Depth 15))
New-Item -ItemType Directory -Path $candidateRoot | Out-Null
foreach($name in $names){[IO.File]::WriteAllBytes((Join-Path $candidateRoot $name),$buffers[$name])}
[IO.File]::WriteAllBytes((Join-Path $candidateRoot 'user-install-decision.json'),$decisionBytes)
[IO.File]::WriteAllBytes((Join-Path $candidateRoot 'compatibility-acceptance.json'),$acceptanceBytes)
[IO.File]::WriteAllBytes((Join-Path $candidateRoot 'release-manifest.json'),$manifestBytes)
@{state='USER_AUTHORIZED_UNVERIFIED_CANDIDATE_COMPOSED';releaseId=$releaseId;releaseManifest=(Join-Path $candidateRoot 'release-manifest.json');manifestWriteInputSha256=(Digest $manifestBytes);acceptanceWriteInputSha256=(Digest $acceptanceBytes);userDecisionSha256=(Digest $decisionBytes);adapterFiles=$names.Count;runtimeActivated=$false;verification='NOT_RUN'} | ConvertTo-Json -Compress
