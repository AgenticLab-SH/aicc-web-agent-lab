#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SnapshotPath,[Parameter(Mandatory)][string]$CompatibilityAcceptancePath,
  [string]$FixtureOwnerHome)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Assert-AiccOcxShippingAcceptance.ps1')
function Hash([string]$Path){$s=[IO.File]::OpenRead($Path);try{[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($s)).ToLowerInvariant()}finally{$s.Dispose()}}
function Regular([string]$Path){
  if(-not [IO.Path]::IsPathFullyQualified($Path)){throw 'Absolute input required'}
  for($p=[IO.Path]::GetFullPath($Path);$p;$p=Split-Path $p -Parent){if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked release input refused'}}
  if((Get-Item -LiteralPath $Path).PSIsContainer){throw 'Regular release input required'}
}
function Json([string]$Path){Regular $Path;Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function WriteJson([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))}
function ReviewedSharedLauncher($Intake) {
  $item=$Intake.sharedLauncherClosure
  if(-not $item){return $null}
  $operating=$item.artifactContract -ceq 'shipping-cli-appserver/v2'
  $shipping=$operating -or $item.artifactContract -ceq 'shipping-cli-appserver/v1'
  $members=@('original-issuer-bootstrap.node','original-issuer-shared-launcher.exe')
  if($shipping){$members+=@('codex.exe','codex-app-server.exe')}
  if($item -isnot [Collections.IDictionary] -or
     $item.protocol -cne 'retained-child-bootstrap/v1' -or
     ($item.artifactContract -and -not $shipping) -or
     $item.originalTuiAttachment -cne $(if($operating){'ACTUAL_SHIPPING_ACCEPTED'}elseif($shipping){'SHIPPING_BUILD_CANDIDATE_ONLY'}else{'NOT_IMPLEMENTED'}) -or
     $item.files -isnot [Collections.IDictionary] -or $item.files.Count -ne $members.Count){
    throw 'Exact shared launcher closure contract required'
  }
  $pins=[ordered]@{};$sources=[ordered]@{}
  foreach($name in $members){
    $file=$item.files[$name]
    if($file -isnot [Collections.IDictionary] -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$'){
      throw 'Exact shared launcher artifact pin required'
    }
    Regular $file.path
    if((Hash $file.path) -cne $file.sha256){throw 'Shared launcher artifact changed'}
    $pins[$name]=$file.sha256;$sources[$name]=$file.path
  }
  if($item.bunSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Shared launcher Bun pin required'}
  $policy=@{protocol=$item.protocol;bunSha256=$item.bunSha256;
    originalTuiAttachment=$item.originalTuiAttachment;canActivate=$false}
  if($shipping){
    $policy.artifactContract=$item.artifactContract
    $proof=$item.shippingBuild
    if($proof -isnot [Collections.IDictionary] -or $proof.sha256 -cnotmatch '^[a-f0-9]{64}$'){
      throw 'Pinned shipping build receipt required'
    }
    Regular $proof.path
    if((Hash $proof.path) -cne $proof.sha256){throw 'Shipping build receipt changed'}
    $build=Get-Content -LiteralPath $proof.path -Raw|ConvertFrom-Json -AsHashtable -DateKind String
    if($build.exitCode -cne 0 -or $build.installed -cne $false -or @($build.artifacts).Count -ne 2){
      throw 'Successful uninstalled shipping build receipt required'
    }
    foreach($name in @('codex.exe','codex-app-server.exe')){
      $artifacts=@($build.artifacts|Where-Object {$_.path -ceq $sources[$name]})
      $version=if($name -ceq 'codex.exe'){'codex-cli 0.166.0'}else{'codex-app-server 0.166.0'}
      if($artifacts.Count -ne 1 -or $artifacts[0].sha256 -cne $pins[$name] -or
         $artifacts[0].bytes -cne (Get-Item -LiteralPath $sources[$name]).Length -or
         $artifacts[0].version -cne $version){throw 'Exact version-bound shipping artifact receipt required'}
    }
    $policy.shippingBuildSha256=$proof.sha256
    $policy.codexClientVersion='0.166.0'
  }
  $evidence=$null
  if($operating){
    if(-not (Get-Command Assert-AiccOcxShippingAcceptance -ErrorAction SilentlyContinue)){. (Join-Path $PSScriptRoot 'Assert-AiccOcxShippingAcceptance.ps1')}
    $proof=$item.operatingAcceptance
    if($proof -isnot [Collections.IDictionary]){throw 'Pinned operating acceptance required'}
    $evidence=Assert-AiccOcxShippingAcceptance -Path $proof.path -Sha256 $proof.sha256 -NativePins $pins -AdapterPins $Intake.sourceSha256
    $policy.operatingAcceptanceSha256=$evidence.receiptSha256
    $policy.canActivate=$true
  }
  # Provenance alone remains insufficient; v2 adds actual, artifact-bound evidence.
  return @{pins=$pins;sources=$sources;policy=$policy;operatingEvidence=$evidence}
}
function ExactMap($Left,$Right) {
  if($Left -isnot [Collections.IDictionary] -or $Right -isnot [Collections.IDictionary] -or
     $Left.Count -ne $Right.Count){return $false}
  foreach($key in $Left.Keys){
    if(-not $Right.Contains($key) -or $Left[$key] -cne $Right[$key]){return $false}
  }
  return $true
}
function ExactGraph($Left,$Right){
  if($Left -isnot [Collections.IDictionary] -or $Right -isnot [Collections.IDictionary] -or
     $Left.Count -ne $Right.Count){return $false}
  foreach($key in $Left.Keys){
    if(-not $Right.Contains($key) -or
       [string]::Join([char]0,@($Left[$key])) -cne [string]::Join([char]0,@($Right[$key]))){return $false}
  }
  return $true
}
function ReviewedGraph($AdapterNames) {
  $graph=[ordered]@{}
  foreach($name in @($AdapterNames|Sort-Object -CaseSensitive)){
    if($name -cnotmatch '^(external-[a-z-]+|window-inflight-monitor)\.ts$'){
      throw 'Unsafe adapter member in relative dependency closure'
    }
    $source=Join-Path $adapterRoot $name
    Regular $source
    $body=[IO.File]::ReadAllText($source)
    $dependencies=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $matches=[regex]::Matches($body,'(?m)^[ \t]*(?:import|export)[ \t]+(?:[^;''"]*?\s+from\s*)?[''"](?<spec>[^''"\r\n]+)[''"]')
    foreach($match in $matches){
      $specifier=$match.Groups['spec'].Value
      if($specifier.StartsWith('.',[StringComparison]::Ordinal)){
        if($specifier -cnotmatch '^\./(?<member>external-[a-z-]+|window-inflight-monitor)(?:\.ts)?$'){
          throw 'Unsafe or unsupported relative adapter dependency'
        }
        $dependency=$Matches['member']+'.ts'
        if($dependency -cnotin $AdapterNames){throw 'Unpinned relative adapter dependency'}
        [void]$dependencies.Add($dependency)
      }
    }
    if([regex]::IsMatch($body,'import\s*\(\s*[''"]\.\.?/') -or
       [regex]::IsMatch($body,'require\s*\(\s*[''"]\.\.?/')){
      throw 'Dynamic relative adapter import requires separate review'
    }
    $graph[$name]=@($dependencies|Sort-Object -CaseSensitive)
  }
  return $graph
}

function InstalledSupplierRoot([string]$Path) {
  if(-not [IO.Path]::IsPathFullyQualified($Path)){throw 'Absolute installed supplier root required'}
  $full=[IO.Path]::GetFullPath($Path)
  if(-not (Get-Item -LiteralPath $full -Force).PSIsContainer){throw 'Supplier root directory required'}
  for($p=$full;$p;$p=Split-Path $p -Parent){
    if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){
      throw 'Linked installed supplier root refused'
    }
    if((Split-Path $p -Parent) -eq $p){break}
  }
  return $full
}
function InstalledSupplierTree([string]$Root){
  $full=InstalledSupplierRoot $Root
  $found=[ordered]@{}
  $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($entry in Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction Stop){
    if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){
      throw 'Linked supplier file or junction refused'
    }
    $name=[IO.Path]::GetRelativePath($full,$entry.FullName).Replace('\','/')
    if(-not $name -or $name -match '(^/|\\|:|(^|/)\.\.?(/|$)|//|[\x00-\x1f])'){
      throw 'Unsafe installed supplier relative path'
    }
    if($entry.PSIsContainer){continue}
    if(-not $names.Add($name) -or $found.Count -ge 50000){
      throw 'Duplicate or oversized installed supplier tree'
    }
    $found[$name]=Hash $entry.FullName
  }
  return $found
}
$a=Json $CompatibilityAcceptancePath
$required=@('stockArtifact','credentialOwner','windowAdmission','inflightLifetime','manualAccountPolicy','modelEntitlements','nativeIsolation','catalogParity','continuationParity','transportParity','managementParity','softwareRollback','requestCompression','legacyManagementAuth')
if($a.schema -cne 'aicc-ocx-isolated-intake/v1' -or $a.supplierVersion -cne '2.96.0' -or $a.status -cne 'PASS' -or $a.network -cne 'fixture-only-no-inference'){throw 'Current target isolated acceptance required'}
foreach($key in $required){
  $proof=$a.checks[$key]
  if($proof.status -cne 'PASS' -or $proof.sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Incomplete target contract evidence'}
  Regular $proof.evidence;if((Hash $proof.evidence) -cne $proof.sha256){throw 'Target contract evidence changed'}
}
foreach($name in $a.verificationSourceSha256.Keys){
  if($name -notmatch '^(tools/platform/opencodex/[a-zA-Z0-9.-]+|test/[a-zA-Z0-9.-]+)$'){throw 'Unexpected verification source'}
  $path=Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent) $name
  Regular $path;if((Hash $path) -cne $a.verificationSourceSha256[$name]){throw 'Verification source changed after acceptance'}
}
$ownerHome=[Environment]::GetFolderPath('UserProfile')
$adapterRoot=$PSScriptRoot
$fixtureOnly=$false
if($FixtureOwnerHome){
  $full=[IO.Path]::GetFullPath($FixtureOwnerHome)
  $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
  if(-not $full.StartsWith($temp+[IO.Path]::DirectorySeparatorChar,
      [StringComparison]::OrdinalIgnoreCase) -or
      (Split-Path $full -Leaf) -cnotmatch '^aicc-ocx-closure-fixture-[a-f0-9]{32}$'){
    throw 'Fixture-only owner root must be one explicitly named temporary test root'
  }
  $marker=Join-Path $full 'aicc-ocx-closure-fixture.json'
  $proof=Json $marker
  if($proof.kind -cne 'aicc-ocx-offline-fixture/v1' -or $proof.noActivation -cne $true){
    throw 'Explicit non-activatable fixture marker required'
  }
  $ownerHome=$full;$adapterRoot=Join-Path $full 'source';$fixtureOnly=$true
}
$store=Join-Path $ownerHome '.ai-control-center/opencodex-native'
$supplier=Join-Path $store 'candidates/2.96.0/package'
$plan=Json $a.inputPlanPath
if((Hash $a.inputPlanPath) -cne $a.inputPlanSha256 -or $plan.target.supplierVersion -cne '2.96.0'){throw 'Prepared archive plan changed'}
if((Json (Join-Path $supplier 'package.json')).version -cne '2.96.0'){throw 'Supplier identity differs'}
foreach($name in $plan.target.supplierFiles.Keys){
  if($name -match '(^/|\\|:|(^|/)\.\.(/|$))'){throw 'Unsafe pinned archive member'}
  $path=Join-Path $supplier $name;Regular $path
  if((Hash $path) -cne $plan.target.supplierFiles[$name]){throw 'Official supplier source changed'}
}
$snapshot=Json (Join-Path $SnapshotPath 'snapshot.json')
if($snapshot.schema -cne 'aicc-ocx-software-snapshot/v1' -or @($snapshot.files).Count -ne 4 -or $snapshot.previous.version -notin @('2.81.0','2.96.0')){throw 'Fresh supported software snapshot required'}
foreach($file in $snapshot.files){if((Hash $file.path) -cne $file.sha256 -or (Hash (Join-Path $SnapshotPath $file.backupFile)) -cne $file.sha256){throw 'Software snapshot CAS differs'}}
$baseline=Json $snapshot.previous.adapterManifest
if($baseline.schema -cne 'aicc-external-ocx-release/v1' -or
   $baseline.adapterFiles -isnot [Collections.IDictionary] -or
   $baseline.supplierFiles -isnot [Collections.IDictionary] -or
   $baseline.acceptanceSha256 -cnotmatch '^[a-f0-9]{64}$'){
  throw 'Verified previous installed release manifest required'
}
$previousRoot=Split-Path $snapshot.previous.adapterManifest -Parent
$previousAcceptance=Join-Path $previousRoot 'compatibility-acceptance.json'
Regular $previousAcceptance
if((Hash $previousAcceptance) -cne $baseline.acceptanceSha256){
  throw 'Previous release acceptance SHA differs from immutable manifest'
}
foreach($name in $baseline.adapterFiles.Keys){
  if($name -cnotmatch '^(external-[a-z-]+|window-inflight-monitor)\.ts$'){
    throw 'Previous installed adapter inventory unsafe'
  }
  $installedSource=Join-Path $previousRoot $name
  Regular $installedSource
  if((Hash $installedSource) -cne $baseline.adapterFiles[$name]){
    throw 'Previous installed adapter source differs from recorded preimage'
  }
}
$registryToCheck=if($fixtureOnly){Join-Path $ownerHome 'registry.json'}else{
  Join-Path $ownerHome '.ai-control-center/runtime/ocx-local/current.json'
}
Regular $registryToCheck
if($plan.baseline.registrySha256 -cne (Hash $registryToCheck) -or
   $plan.baseline.manifestSha256 -cne (Hash $snapshot.previous.adapterManifest) -or
   $baseline.supplierVersion -cne $snapshot.previous.version -or
   $plan.baseline.supplierVersion -cne $snapshot.previous.version -or
   -not (ExactMap $plan.baseline.adapterFiles $baseline.adapterFiles) -or
   $plan.target.supplierVersion -cne '2.96.0'){
  throw 'Current baseline registry/manifest/supplier CAS changed'
}
$closure=$plan.reviewedAdapterClosure
if($closure.kind -cne 'aicc-ocx-reviewed-adapter-closure/v1' -or
   $plan.reviewedAdapterClosureSha256 -cnotmatch '^[a-f0-9]{64}$' -or
   $a.reviewedAdapterClosureSha256 -cne $plan.reviewedAdapterClosureSha256 -or
   $closure.baselineManifestSha256 -cne $plan.baseline.manifestSha256 -or
   $closure.runtimeRegistrySha256 -cne $plan.baseline.registrySha256 -or
   $closure.targetSupplierVersion -cne $plan.target.supplierVersion -or
   -not (ExactMap $closure.adapterFiles $plan.adapterSourceSha256) -or
   -not (ExactMap $a.sourceSha256 $plan.adapterSourceSha256)){
  throw 'Plan and isolated acceptance adapter closure pins differ'
}
$closureValue=$closure|ConvertTo-Json -Depth 12 -Compress
$closureDigest=[Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($closureValue))
).ToLowerInvariant()
if($closureDigest -cne $plan.reviewedAdapterClosureSha256){
  throw 'Reviewed adapter closure graph SHA changed'
}
$added=$closure.reviewedAdditions
if($added -isnot [Collections.IDictionary] -or
   $closure.optIn -cne [bool]$closure.receiptSha256 -or $added.Count -gt 8 -or
   $closure.sameSupplierAdapterRevision -cne ($snapshot.previous.version -ceq '2.96.0')){
  throw 'Unsupported reviewed adapter revision contract'
}
$reuse=$null
if($closure.sameSupplierAdapterRevision){
  $reuse=$plan.installedSupplierReuse
  if($reuse -isnot [Collections.IDictionary] -or
     $reuse.kind -cne 'aicc-ocx-installed-supplier-dependencies-reuse/v1' -or
     $plan.installedSupplierReuseSha256 -cnotmatch '^[a-f0-9]{64}$'){
    throw 'Same supplier revision requires separate installed dependency reuse evidence'
  }
  $encoded=$reuse|ConvertTo-Json -Depth 12 -Compress
  $reuseSHA=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($encoded))).ToLowerInvariant()
  if($reuseSHA -cne $plan.installedSupplierReuseSha256 -or
     $reuse.runtimeRegistrySha256 -cne $plan.baseline.registrySha256 -or
     $reuse.baselineManifestSha256 -cne $plan.baseline.manifestSha256 -or
     $reuse.previousAcceptanceSha256 -cne $baseline.acceptanceSha256 -or
     $reuse.officialArchiveReceiptSha256 -cne $plan.target.receiptSha256 -or
     $reuse.officialArchiveSha512 -cne $plan.target.archiveSha512 -or
     $reuse.installedSupplierRoot -cne $baseline.supplierRoot -or
     $reuse.supplierReinstallAllowed -cne $false -or
     $reuse.activationAllowed -cne $false -or
     -not (ExactMap $reuse.officialArchiveFiles $plan.target.supplierFiles) -or
     -not (ExactMap $reuse.installedSupplierFiles $baseline.supplierFiles)){
    throw 'Pinned installed supplier and official archive evidence changed'
  }
  $installedRoot=InstalledSupplierRoot $reuse.installedSupplierRoot
  if(-not [string]::Equals($installedRoot,[IO.Path]::GetFullPath($supplier),
    [StringComparison]::OrdinalIgnoreCase)){
    throw 'Installed supplier root differs from registered original supplier'
  }
  Regular $reuse.officialArchiveReceiptPath
  Regular $reuse.officialArchivePath
  if((Hash $reuse.officialArchiveReceiptPath) -cne $plan.target.receiptSha256 -or
     (Get-FileHash -LiteralPath $reuse.officialArchivePath -Algorithm SHA512).Hash.ToLowerInvariant() -cne $plan.target.archiveSha512){
    throw 'Official archive or receipt changed since source review'
  }
  $expectedDependencies=[ordered]@{}
  foreach($name in $baseline.supplierFiles.Keys){
    if($plan.target.supplierFiles.Contains($name)){
      if($baseline.supplierFiles[$name] -cne $plan.target.supplierFiles[$name]){
        throw 'Same-version official archive SHA differs from installed manifest'
      }
    }else{
      if($name -cnotmatch '^node_modules/[^/].+' -or
         $name -match '(^/|\\|:|(^|/)\.\.?(/|$)|//|[\x00-\x1f])'){
        throw 'Manifest-only non-dependency supplier member refused'
      }
      $expectedDependencies[$name]=$baseline.supplierFiles[$name]
    }
  }
  foreach($name in $plan.target.supplierFiles.Keys){
    if(-not $baseline.supplierFiles.Contains($name)){
      throw 'Official archive member is missing from original installed manifest'
    }
  }
  if(-not (ExactMap $reuse.installedDependencyFiles $expectedDependencies) -or
     $reuse.installedDependencyCount -ne $expectedDependencies.Count -or
     $reuse.officialArchiveCount -ne $plan.target.supplierFiles.Count -or
     $reuse.installedFileCount -ne $baseline.supplierFiles.Count -or
     $baseline.supplierFiles.Count -ne $expectedDependencies.Count + $plan.target.supplierFiles.Count){
    throw 'Pinned original node_modules dependency inventory changed'
  }
}elseif($plan.installedSupplierReuse -or $plan.installedSupplierReuseSha256){
  throw 'Unexpected installed dependency reuse on newer supplier path'
}
if($added.Count -gt 0){
  if($baseline.adapterFiles.Count -notin @(14,15) -or
     ($baseline.adapterFiles.Count -eq 15 -and
      -not $baseline.adapterFiles.Contains('external-original-quota-receipt.ts')) -or
     $a.reviewedAdapterAdditionsSha256 -cne $closure.receiptSha256 -or
     $a.reviewedAdapterAdditionsPath -isnot [string]){
    throw 'Exact reviewed 14/15-module baseline and addition receipt required'
  }
  $originalAdditions=Json $a.reviewedAdapterAdditionsPath
  if((Hash $a.reviewedAdapterAdditionsPath) -cne $closure.receiptSha256 -or
     $originalAdditions.kind -cne 'aicc-ocx-reviewed-adapter-additions/v1' -or
     $originalAdditions.schemaVersion -ne 1 -or
     $originalAdditions.runtimeRegistrySha256 -cne $plan.baseline.registrySha256 -or
     $originalAdditions.baselineManifestSha256 -cne $plan.baseline.manifestSha256 -or
     $originalAdditions.targetSupplierVersion -cne '2.96.0' -or
     -not (ExactMap $originalAdditions.adapterFiles $added)){
    throw 'Reviewed addition source preimage receipt changed'
  }
}elseif($closure.sameSupplierAdapterRevision -and $baseline.adapterFiles.Count -eq 15 -and
  $baseline.adapterFiles.Contains('external-original-quota-receipt.ts')){
  $revision=Json $a.reviewedAdapterAdditionsPath
  if((Hash $a.reviewedAdapterAdditionsPath) -cne $closure.receiptSha256 -or
     $a.reviewedAdapterAdditionsSha256 -cne $closure.receiptSha256 -or
     $revision.schemaVersion -ne 1 -or $revision.kind -cne 'aicc-ocx-reviewed-existing-adapter-revision/v1' -or
     $revision.runtimeRegistrySha256 -cne $plan.baseline.registrySha256 -or
     $revision.baselineManifestSha256 -cne $plan.baseline.manifestSha256 -or
     $revision.targetSupplierVersion -cne '2.96.0' -or
     $revision.adapterFiles -isnot [Collections.IDictionary] -or $revision.adapterFiles.Count -ne 0 -or
     -not (ExactMap $revision.sourceSha256 $plan.adapterSourceSha256)){
    throw 'Exact existing adapter revision receipt changed'
  }
}elseif($a.reviewedAdapterAdditionsPath -or $a.reviewedAdapterAdditionsSha256 -or
  $closure.receiptSha256){throw 'Unexpected unreviewed adapter input'}
$allNames=@($baseline.adapterFiles.Keys)+@($added.Keys)
if(@($allNames|Sort-Object -Unique -CaseSensitive).Count -ne $allNames.Count -or
   -not $baseline.adapterFiles.Contains('external-conversation-lifecycle.ts')){
  throw 'Adapter deletion, duplicate or overlapping reviewed addition refused'
}
$adapterFiles=[ordered]@{}
foreach($name in @($allNames|Sort-Object -CaseSensitive)){
  if($name -cnotmatch '^(external-[a-z-]+|window-inflight-monitor)\.ts$' -or
     ($added.Contains($name) -and $baseline.adapterFiles.Contains($name))){
    throw 'Unsafe, missing or duplicate adapter input'
  }
  $file=Join-Path $adapterRoot $name;Regular $file
  $hash=Hash $file
  if($a.sourceSha256[$name] -cne $hash -or
     $plan.adapterSourceSha256[$name] -cne $hash -or
     ($added.Contains($name) -and $added[$name] -cne $hash)){
    throw 'Pinned adapter source changed after isolated acceptance'
  }
  $adapterFiles[$name]=$hash
}
if(-not (ExactMap $adapterFiles $plan.adapterSourceSha256)){
  throw 'Reviewed or original adapter inventory missing'
}
$actualGraph=ReviewedGraph $allNames
if(-not (ExactGraph $actualGraph $closure.relativeImports)){
  throw 'Relative adapter dependency graph changed after intake'
}
$reachable=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$pending=[Collections.Generic.Queue[string]]::new()
foreach($name in $baseline.adapterFiles.Keys){$pending.Enqueue([string]$name)}
while($pending.Count){
  $name=$pending.Dequeue()
  if(-not $reachable.Add($name)){continue}
  foreach($dependency in $actualGraph[$name]){$pending.Enqueue($dependency)}
}
foreach($name in $added.Keys){
  if(-not $reachable.Contains($name)){throw 'Reviewed addition no longer imported by baseline graph'}
}
# Full scan includes directory junctions, symlinks, hidden files and exact
# original node_modules pins. Never install or resolve dependency versions.
$supplierFiles=InstalledSupplierTree $supplier
if($closure.sameSupplierAdapterRevision){
  if(-not (ExactMap $supplierFiles $reuse.installedSupplierFiles) -or
     -not (ExactMap $supplierFiles $baseline.supplierFiles)){
    throw 'Installed supplier dependency file added, missing or altered'
  }
}else{
  if(-not (ExactMap $supplierFiles $plan.target.supplierFiles)){
    throw 'Actual official supplier tree has added, missing or altered members'
  }
}
if((Hash $a.inputPlanPath) -cne $a.inputPlanSha256 -or
   (Hash $registryToCheck) -cne $plan.baseline.registrySha256 -or
   (Hash $snapshot.previous.adapterManifest) -cne $plan.baseline.manifestSha256 -or
   (Hash $previousAcceptance) -cne $baseline.acceptanceSha256 -or
   ($closure.receiptSha256 -and (Hash $a.reviewedAdapterAdditionsPath) -cne $closure.receiptSha256) -or
   ($closure.sameSupplierAdapterRevision -and (
      (Hash $reuse.officialArchiveReceiptPath) -cne $reuse.officialArchiveReceiptSha256 -or
      (Get-FileHash -LiteralPath $reuse.officialArchivePath -Algorithm SHA512).Hash.ToLowerInvariant() -cne $reuse.officialArchiveSha512))){
  throw 'Release inputs changed at final immutable candidate CAS'
}
$sharedLauncher=ReviewedSharedLauncher $a
if($sharedLauncher){
  $bunFile=Join-Path $supplier 'node_modules/@oven/bun-windows-x64/bin/bun.exe';Regular $bunFile
  if((Hash $bunFile) -cne $sharedLauncher.policy.bunSha256){throw 'Shared launcher supplier Bun changed'}
}
$identityFields=[ordered]@{supplierVersion='2.96.0';adapterFiles=$adapterFiles;supplierFiles=$supplierFiles;intakeSha256=(Hash $CompatibilityAcceptancePath);reviewedAdapterClosureSha256=$plan.reviewedAdapterClosureSha256;baselineManifestSha256=$plan.baseline.manifestSha256}
if($sharedLauncher){$identityFields.nativeAdapterFiles=$sharedLauncher.pins;$identityFields.sharedLauncher=$sharedLauncher.policy}
if($reuse){$identityFields.installedSupplierReuseSha256=$plan.installedSupplierReuseSha256}
$identity=$identityFields|ConvertTo-Json -Depth 7 -Compress
$id=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($identity))).ToLowerInvariant().Substring(0,16)
$release=Join-Path $store ('external-candidates/2.96.0/'+$id)
if(Test-Path -LiteralPath $release){throw 'Immutable accepted release already exists; reconcile it instead of rebuilding'}
[IO.Directory]::CreateDirectory($release)|Out-Null
foreach($name in $adapterFiles.Keys){
  Copy-Item -LiteralPath (Join-Path $adapterRoot $name) -Destination (Join-Path $release $name)
  if((Hash (Join-Path $release $name)) -cne $adapterFiles[$name]){
    throw 'Candidate copied adapter differs from reviewed source SHA'
  }
}
if($sharedLauncher){
  foreach($name in $sharedLauncher.pins.Keys){
    if((Hash $sharedLauncher.sources[$name]) -cne $sharedLauncher.pins[$name]){throw 'Shared launcher input changed before copy'}
    Copy-Item -LiteralPath $sharedLauncher.sources[$name] -Destination (Join-Path $release $name)
    if((Hash (Join-Path $release $name)) -cne $sharedLauncher.pins[$name]){throw 'Copied shared launcher artifact changed'}
  }
  if($sharedLauncher.operatingEvidence){
    $evidenceRoot=Join-Path $release 'shipping-evidence'
    New-Item -ItemType Directory -Path $evidenceRoot|Out-Null
    foreach($name in $sharedLauncher.operatingEvidence.files.Keys){
      $evidenceInput=$sharedLauncher.operatingEvidence.files[$name]
      if((Hash $evidenceInput) -cne $sharedLauncher.operatingEvidence.hashes[$name]){throw 'Shipping evidence changed before immutable copy'}
      Copy-Item -LiteralPath $evidenceInput -Destination (Join-Path $evidenceRoot $name)
    }
    $null=Assert-AiccOcxShippingAcceptance -Path (Join-Path $evidenceRoot 'shipping-operating-acceptance.json') -Sha256 $sharedLauncher.policy.operatingAcceptanceSha256 -NativePins $sharedLauncher.pins -AdapterPins $adapterFiles
  }
}
$acceptance=@{schema='aicc-external-ocx-acceptance/v1';supplierVersion='2.96.0';accepted=(-not $fixtureOnly);verification='FIXTURE_PASS';checks=$a.checks;sourceSha256=$adapterFiles;supplierFiles=$supplierFiles;intakeSha256=(Hash $CompatibilityAcceptancePath);reviewedAdapterClosureSha256=$plan.reviewedAdapterClosureSha256;reviewedAdapterAdditionsSha256=$closure.receiptSha256;baselineManifestSha256=$plan.baseline.manifestSha256;fixtureOnly=$fixtureOnly;officialArchiveFilesVerified=$plan.target.supplierFiles.Count;liveModelCanary='NOT_RUN';rollbackScope='actual transition CAS branch with fake services; live recovery worker required at activation';createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
if($sharedLauncher){$acceptance.accepted=(-not $fixtureOnly -and $sharedLauncher.policy.canActivate);$acceptance.nativeAdapterFiles=$sharedLauncher.pins;$acceptance.sharedLauncher=$sharedLauncher.policy}
if($reuse){
  $acceptance.installedSupplierReuseSha256=$plan.installedSupplierReuseSha256
  $acceptance.officialArchiveFilesVerified=$reuse.officialArchiveCount
  $acceptance.installedDependenciesReused=$reuse.installedDependencyCount
  $acceptance.installedSupplierFilesVerified=$reuse.installedFileCount
}
$acceptanceFile=Join-Path $release 'compatibility-acceptance.json';WriteJson $acceptanceFile $acceptance
$manifest=@{schema='aicc-external-ocx-release/v1';supplierVersion='2.96.0';supplierRoot=$supplier;adapterVersion='0.2.0';requestExecution='windows-local';credentialWriter='a1';nativeExcluded=$true;codexClientVersion=$baseline.codexClientVersion;adapterFiles=$adapterFiles;supplierFiles=$supplierFiles;reviewedAdapterClosureSha256=$plan.reviewedAdapterClosureSha256;baselineManifestSha256=$plan.baseline.manifestSha256;acceptanceSha256=(Hash $acceptanceFile);registryIntegrity=('sha512-'+[Convert]::ToBase64String([Convert]::FromHexString($plan.target.archiveSha512)))}
if($sharedLauncher){$manifest.nativeAdapterFiles=$sharedLauncher.pins;$manifest.sharedLauncher=$sharedLauncher.policy}
if($sharedLauncher -and $sharedLauncher.policy.artifactContract -in @('shipping-cli-appserver/v1','shipping-cli-appserver/v2')){
  $manifest.codexClientVersion=$sharedLauncher.policy.codexClientVersion
}
if($reuse){
  $manifest.installedSupplierReuseSha256=$plan.installedSupplierReuseSha256
  $manifest.officialArchiveSha512=$reuse.officialArchiveSha512
  $manifest.originalDependencyCount=$reuse.installedDependencyCount
}
$manifestPath=Join-Path $release 'release-manifest.json';WriteJson $manifestPath $manifest
@{status=if(-not $acceptance.accepted){'FIXTURE_PASS_NOT_ACTIVATABLE'}else{'PASS'};supplierVersion='2.96.0';releaseManifest=$manifestPath;releaseId=$id;supplierFiles=$supplierFiles.Count;adapterFiles=$adapterFiles.Count;reviewedAdapterClosureSha256=$plan.reviewedAdapterClosureSha256;fixtureOnly=$fixtureOnly;canActivate=[bool]$acceptance.accepted;runtimeActivated=$false}|ConvertTo-Json -Compress
