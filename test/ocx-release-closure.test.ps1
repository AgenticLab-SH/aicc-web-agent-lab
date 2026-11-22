#requires -Version 7.5
param([switch]$WithSharedLauncher,[switch]$WithShippingCaller,[switch]$WithOperatingAcceptance)
$WithShippingCaller=$WithShippingCaller -or $WithOperatingAcceptance
$WithSharedLauncher=$WithSharedLauncher -or $WithShippingCaller
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$planner=Join-Path $repo 'tools/platform/opencodex/New-AiccOcxCompatibilityPlan.ps1'
$builder=Join-Path $repo 'tools/platform/opencodex/New-AiccAcceptedOcxRelease.ps1'
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
$root=Join-Path $temp ('aicc-ocx-closure-fixture-'+[guid]::NewGuid().ToString('N'))
$checks=[Collections.Generic.List[string]]::new()
function Digest([string]$f){(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant()}
function J([string]$f,$v){[IO.File]::WriteAllText($f,($v|ConvertTo-Json -Depth 24),[Text.UTF8Encoding]::new($false))}
function Put([string]$f,[string]$s){[IO.Directory]::CreateDirectory((Split-Path $f -Parent))|Out-Null;[IO.File]::WriteAllText($f,$s,[Text.UTF8Encoding]::new($false))}
function Assert($x,[string]$m){if(-not $x){throw $m}}
function Refuses([scriptblock]$run,[string]$label,[string]$pattern){
  $m=$null;try{$null=& $run}catch{$m=$_.Exception.Message}
  Assert ($m -and $m -match $pattern) ('Expected '+$label+' HOLD: '+$m)
  $checks.Add($label)
}
try {
  [IO.Directory]::CreateDirectory($root)|Out-Null
  J (Join-Path $root 'aicc-ocx-closure-fixture.json') @{kind='aicc-ocx-offline-fixture/v1';noActivation=$true}
  $src=Join-Path $root 'source';$old=Join-Path $root 'previous-release'
  $supplier=Join-Path $root '.ai-control-center/opencodex-native/candidates/2.96.0/package'
  foreach($d in @($src,$old,(Join-Path $supplier 'src'),(Join-Path $root 'snapshot'))){[IO.Directory]::CreateDirectory($d)|Out-Null}
  $names=@('external-account-picker.ts','external-auth.ts','external-broker-transport.ts',
    'external-conversation-lifecycle.ts','external-credential-owner.ts',
    'external-http-boundary.ts','external-pool-state.ts','external-request-body.ts',
    'external-response-socket.ts','external-runtime.ts','external-safe-fault.ts',
    'external-stock-dispatch.ts','external-stock-management.ts','window-inflight-monitor.ts')
  $add='external-original-quota-receipt.ts';$body=@{};$pins=[ordered]@{}
  foreach($name in $names){$body[$name]='export const verified = true;'}
  $body['external-runtime.ts']="import './external-pool-state';"+[Environment]::NewLine+"load('src/index.ts');"
  $body['external-pool-state.ts']="import './external-original-quota-receipt';"+[Environment]::NewLine+'export const selected = true;'
  foreach($name in $names){
    $before=if($name -eq 'external-pool-state.ts'){'export const selected = false;'}else{$body[$name]}
    Put (Join-Path $old $name) $before
    $pins[$name]=Digest (Join-Path $old $name)
    Put (Join-Path $src $name) $body[$name]
  }
  Put (Join-Path $src $add) "import type {Quota} from './window-inflight-monitor';"
  $pkg='{"name":"@bitkyc08/opencodex","version":"2.96.0"}'
  Put (Join-Path $supplier 'package.json') $pkg
  Put (Join-Path $supplier 'src/index.ts') 'export const fixture = true;'
  $supplierPins=[ordered]@{'package.json'=(Digest (Join-Path $supplier 'package.json'))}
  $supplierPins['src/index.ts']=Digest (Join-Path $supplier 'src/index.ts')
  $originalDependency=if($WithSharedLauncher){'node_modules/@oven/bun-windows-x64/bin/bun.exe'}else{'node_modules/fixture-dep/index.js'}
  $dependencyPath=Join-Path $supplier $originalDependency
  Put $dependencyPath 'export const preinstalledDependency = 1;'
  $dependencyBytes=[IO.File]::ReadAllBytes($dependencyPath)
  $supplierPins[$originalDependency]=Digest $dependencyPath
  $prevAcc=Join-Path $old 'compatibility-acceptance.json'
  J $prevAcc @{schema='fixture-old-acceptance'}
  $baselinePath=Join-Path $old 'release-manifest.json'
  J $baselinePath @{schema='aicc-external-ocx-release/v1';supplierVersion='2.96.0';
    adapterFiles=$pins;supplierRoot=$supplier;supplierFiles=$supplierPins;codexClientVersion='0.167.0';acceptanceSha256=(Digest $prevAcc)}
  $registryPath=Join-Path $root 'registry.json'
  J $registryPath @{schemaVersion=1;requestExecution='windows-local';credentialWriter='a1';version='2.96.0';adapterManifest=$baselinePath}
  $reviewFile=Join-Path $root 'reviewed.json'
  $review=@{schemaVersion=1;kind='aicc-ocx-reviewed-adapter-additions/v1';
    runtimeRegistrySha256=(Digest $registryPath);baselineManifestSha256=(Digest $baselinePath);
    targetSupplierVersion='2.96.0';adapterFiles=@{$add=(Digest (Join-Path $src $add))}}
  J $reviewFile $review
  $archive=Join-Path $root 'package.tgz'
  $stream=[IO.File]::Create($archive)
  $zip=[IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionMode]::Compress)
  $tar=[System.Formats.Tar.TarWriter]::new($zip)
  try{
    foreach($v in @(@{name='package/package.json';text=$pkg},@{name='package/src/index.ts';text='export const fixture = true;'})){
      $entry=[System.Formats.Tar.PaxTarEntry]::new([System.Formats.Tar.TarEntryType]::RegularFile,$v.name)
      $buf=[IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($v.text))
      try{$entry.DataStream=$buf;$tar.WriteEntry($entry)}finally{$buf.Dispose()}
    }
  }finally{$tar.Dispose();$zip.Dispose();$stream.Dispose()}
  $sha512=(Get-FileHash $archive -Algorithm SHA512).Hash.ToLowerInvariant()
  $receiptFile=Join-Path $root 'upstream-artifact.json'
  J $receiptFile @{schemaVersion=1;name='@bitkyc08/opencodex';version='2.96.0';
    registry='https://registry.npmjs.org';tarball='https://registry.npmjs.org/@bitkyc08/opencodex/-/opencodex-2.96.0.tgz';
    integrity='sha512-'+[Convert]::ToBase64String([Convert]::FromHexString($sha512));
    sha512=$sha512;scope='unmodified-upstream-archive';packageModified=$false;
    runtimeActivated=$false;dependenciesInstalled=$false}
  function Plan{
    & $planner -TargetVersion '2.96.0' -ArtifactReceiptPath $receiptFile -RuntimeRegistryPath $registryPath -AdapterSourceRoot $src -ReviewedAdapterAdditionsPath $reviewFile -ExpectedReviewedAdapterAdditionsSha256 (Digest $reviewFile) -AllowSameSupplierAdapterRevision | ConvertFrom-Json -AsHashtable
  }
  $plan=Plan
  Assert ($plan.adapterSourceSha256.Count -eq 15 -and
    $plan.adapterSourceSha256[$add] -eq (Digest (Join-Path $src $add)) -and
    $plan.reviewedAdapterClosure.relativeImports['external-pool-state.ts'] -contains $add -and
    $plan.reviewedAdapterClosure.sameSupplierAdapterRevision -eq $true -and
    $plan.installedSupplierReuse.kind -eq 'aicc-ocx-installed-supplier-dependencies-reuse/v1' -and
    $plan.installedSupplierReuse.officialArchiveCount -eq 2 -and
    $plan.installedSupplierReuse.installedFileCount -eq 3 -and
    $plan.installedSupplierReuse.installedDependencyCount -eq 1 -and
    $plan.installedSupplierReuse.installedDependencyFiles[$originalDependency] -eq (Digest $dependencyPath) -and
    $plan.installedSupplierReuseSha256 -match '^[a-f0-9]{64}$' -and
    $plan.canActivate -eq $false) 'Reviewed 14+1 plan closure missing'
  $checks.Add('plan pins the exact 14+1 graph and is not acceptance')
  $actualSource=Join-Path $repo 'tools/platform/opencodex'
  $actualAdded=Join-Path $actualSource $add
  $review.adapterFiles[$add]=Digest $actualAdded
  J $reviewFile $review
  # Current source has new issuer bootstrap/private dependencies. The historical
  # 14+1 review cannot approve them. Verify the real planner refuses that stale
  # intake; the synthetic reviewed closure below still exercises actual build.
  Refuses { & $planner -TargetVersion '2.96.0' -ArtifactReceiptPath $receiptFile -RuntimeRegistryPath $registryPath -AdapterSourceRoot $actualSource -ReviewedAdapterAdditionsPath $reviewFile -ExpectedReviewedAdapterAdditionsSha256 (Digest $reviewFile) -AllowSameSupplierAdapterRevision } 'real expanded source refuses historical 14+1 intake' 'Unpinned relative adapter dependency'
  $review.adapterFiles[$add]=Digest (Join-Path $src $add)
  J $reviewFile $review
  $snapshotDir=Join-Path $root 'snapshot';$snapshotFiles=@()
  for($i=0;$i -lt 4;$i++){
    $source=Join-Path $root ('snapshot-source-'+$i+'.txt');$backup=('backup-'+$i+'.txt')
    Put $source ('snapshot-original-'+$i);Put (Join-Path $snapshotDir $backup) ('snapshot-original-'+$i)
    $snapshotFiles+=@{path=$source;backupFile=$backup;sha256=(Digest $source)}
  }
  J (Join-Path $snapshotDir 'snapshot.json') @{schema='aicc-ocx-software-snapshot/v1';
    previous=@{version='2.96.0';adapterManifest=$baselinePath};files=$snapshotFiles}
  $planPath=Join-Path $root 'plan.json';J $planPath $plan
  $proof=Join-Path $root 'fixture-proof.json';J $proof @{status='PASS';fixtureOnly=$true}
  $required=@('stockArtifact','credentialOwner','windowAdmission','inflightLifetime',
    'manualAccountPolicy','modelEntitlements','nativeIsolation','catalogParity',
    'continuationParity','transportParity','managementParity','softwareRollback',
    'requestCompression','legacyManagementAuth')
  $proofs=@{};foreach($name in $required){$proofs[$name]=@{status='PASS';evidence=$proof;sha256=(Digest $proof)}}
  $intake=@{schema='aicc-ocx-isolated-intake/v1';supplierVersion='2.96.0';
    status='PASS';network='fixture-only-no-inference';checks=$proofs;
    verificationSourceSha256=@{};sourceSha256=$plan.adapterSourceSha256;
    inputPlanPath=$planPath;inputPlanSha256=(Digest $planPath);
    reviewedAdapterClosureSha256=$plan.reviewedAdapterClosureSha256;
    reviewedAdapterAdditionsSha256=(Digest $reviewFile);reviewedAdapterAdditionsPath=$reviewFile}
  $intakePath=Join-Path $root 'intake.json';J $intakePath $intake
  if($WithSharedLauncher){
    $nativeFiles=[ordered]@{}
    foreach($name in @('original-issuer-bootstrap.node','original-issuer-shared-launcher.exe')){
      $path=Join-Path $root $name;Put $path ('test-owned-'+$name)
      $nativeFiles[$name]=@{path=$path;sha256=(Digest $path)}
    }
    $intake.sharedLauncherClosure=@{protocol='retained-child-bootstrap/v1';originalTuiAttachment='NOT_IMPLEMENTED';
      files=$nativeFiles;bunSha256=(Digest $dependencyPath)}
    if($WithShippingCaller){
      $artifacts=@()
      foreach($name in @('codex.exe','codex-app-server.exe')){
        $path=Join-Path $root $name;Put $path ('test-owned-'+$name)
        $nativeFiles[$name]=@{path=$path;sha256=(Digest $path)}
        $artifacts+=@{path=$path;sha256=(Digest $path);bytes=(Get-Item -LiteralPath $path).Length;
          version=$(if($name -ceq 'codex.exe'){'codex-cli 0.166.0'}else{'codex-app-server 0.166.0'})}
      }
      $buildFile=Join-Path $root 'shipping-build.json';J $buildFile @{exitCode=0;installed=$false;artifacts=$artifacts}
      $intake.sharedLauncherClosure.artifactContract='shipping-cli-appserver/v1'
      $intake.sharedLauncherClosure.originalTuiAttachment='SHIPPING_BUILD_CANDIDATE_ONLY'
      $intake.sharedLauncherClosure.shippingBuild=@{path=$buildFile;sha256=(Digest $buildFile)}
      if($WithOperatingAcceptance){
        $evidenceDir=Join-Path $root 'operating-evidence';[IO.Directory]::CreateDirectory($evidenceDir)|Out-Null
        $nativePins=@{};foreach($name in $nativeFiles.Keys){$nativePins[$name]=$nativeFiles[$name].sha256}
        $receipt=@{schema='aicc-ocx-shipping-operating-acceptance/v1';state='PASS';fixtureOnly=$false;
          originalReplay=0;resetCreditConsumption=0;nativeArtifacts=$nativePins;adapterArtifacts=$plan.adapterSourceSha256;checks=@{}}
        foreach($name in @('shippingTuiAttachment','originalIssuerArmCancel','credentialGenerationRefusal','stopUnknownPreservation')){
          $file=Join-Path $evidenceDir ($name+'.json')
          J $file @{schema='aicc-ocx-shipping-check/v1';check=$name;state='PASS';execution='ACTUAL_SHIPPING_BINARY';fixtureOnly=$false;
            originalReplay=0;resetCreditConsumption=0;nativeArtifacts=$nativePins;adapterArtifacts=$plan.adapterSourceSha256;
            armed=$true;cancelled=$true;exactOriginalIssuer=$true;goalPreserved=$true;authenticatedPeer=$true;
            sharedChildSurvived=$true;replacementRefused=$true;stopPreserved=$true;unknownPreserved=$true}
          $receipt.checks[$name]=@{file=($name+'.json');sha256=(Digest $file)}
        }
        $operatingReceiptFile=Join-Path $evidenceDir 'shipping-operating-acceptance.json';J $operatingReceiptFile $receipt
        $intake.sharedLauncherClosure.artifactContract='shipping-cli-appserver/v2'
        $intake.sharedLauncherClosure.originalTuiAttachment='ACTUAL_SHIPPING_ACCEPTED'
        $intake.sharedLauncherClosure.operatingAcceptance=@{path=$operatingReceiptFile;sha256=(Digest $operatingReceiptFile)}
      }
    }
    J $intakePath $intake
  }
  function Build{
    & $builder -SnapshotPath $snapshotDir -CompatibilityAcceptancePath $intakePath -FixtureOwnerHome $root | ConvertFrom-Json -AsHashtable
  }
  $release=Build
  $manifest=Get-Content $release.releaseManifest -Raw|ConvertFrom-Json -AsHashtable
  $releasedDir=Split-Path $release.releaseManifest -Parent
  $releasedAcc=Get-Content (Join-Path $releasedDir 'compatibility-acceptance.json') -Raw|ConvertFrom-Json -AsHashtable
  Assert ($release.status -eq 'FIXTURE_PASS_NOT_ACTIVATABLE' -and $release.canActivate -eq $false -and
    $manifest.adapterFiles.Count -eq 15 -and
    $manifest.adapterFiles[$add] -eq (Digest (Join-Path $releasedDir $add)) -and
    $releasedAcc.accepted -eq $false -and $releasedAcc.fixtureOnly -eq $true -and
    $manifest.supplierFiles.Count -eq 3 -and
    $manifest.supplierFiles[$originalDependency] -eq (Digest $dependencyPath) -and
    $manifest.installedSupplierReuseSha256 -eq $plan.installedSupplierReuseSha256 -and
    $releasedAcc.installedDependenciesReused -eq 1 -and
    $manifest.supplierRoot -eq $supplier) 'Fake release missing pinned dependency or reviewed adapter'
  $checks.Add('immutable fixture candidate includes all 15 and is non-activatable')
  if($WithSharedLauncher){
    $nativeCount=if($WithShippingCaller){4}else{2}
    Assert ($manifest.nativeAdapterFiles.Count -eq $nativeCount -and $releasedAcc.nativeAdapterFiles.Count -eq $nativeCount -and
      $manifest.sharedLauncher.canActivate -ceq [bool]$WithOperatingAcceptance -and $releasedAcc.accepted -ceq $false -and
      $manifest.nativeAdapterFiles['original-issuer-bootstrap.node'] -ceq (Digest (Join-Path $releasedDir 'original-issuer-bootstrap.node')) -and
      $manifest.nativeAdapterFiles['original-issuer-shared-launcher.exe'] -ceq (Digest (Join-Path $releasedDir 'original-issuer-shared-launcher.exe'))) 'Native closure missing exact copied artifacts or became activatable'
    $checks.Add('native two-artifact immutable closure copied and remains non-accepted')
    if($WithShippingCaller){
      foreach($name in @('codex.exe','codex-app-server.exe')){
        Assert ($manifest.nativeAdapterFiles[$name] -ceq (Digest (Join-Path $releasedDir $name))) 'Shipping copied member missing or changed'
      }
      Assert ($manifest.codexClientVersion -ceq '0.166.0' -and
        $manifest.sharedLauncher.shippingBuildSha256 -ceq (Digest $buildFile) -and
        $manifest.sharedLauncher.artifactContract -ceq $(if($WithOperatingAcceptance){'shipping-cli-appserver/v2'}else{'shipping-cli-appserver/v1'})) 'Shipping build provenance lost'
      $checks.Add('four native artifacts and exact shipping build provenance copied without activation')
      if($WithOperatingAcceptance){
        $copied=Join-Path $releasedDir 'shipping-evidence'
        foreach($name in @('shipping-operating-acceptance','shippingTuiAttachment','originalIssuerArmCancel','credentialGenerationRefusal','stopUnknownPreservation')){
          Assert ((Digest (Join-Path $copied ($name+'.json'))) -ceq (Digest (Join-Path $evidenceDir ($name+'.json')))) 'Immutable evidence closure changed'
        }
        $checks.Add('actual builder copies and revalidates all five synthetic v2 evidence files; fixture remains non-accepted')
      }
    }
  }
  Refuses {Build} 'candidate reentry' 'Immutable accepted release already exists'
  if($WithOperatingAcceptance){
    # Later source revisions cannot reuse acceptance for the preceding closure.
    $intake.sharedLauncherClosure.artifactContract='shipping-cli-appserver/v1'
    $intake.sharedLauncherClosure.originalTuiAttachment='SHIPPING_BUILD_CANDIDATE_ONLY'
    $intake.sharedLauncherClosure.Remove('operatingAcceptance');J $intakePath $intake
  }
  # A second release must revise the installed 15-module closure rather than
  # replay the old 14+1 addition receipt or relabel the original acceptance.
  $originalRegistry=[IO.File]::ReadAllBytes($registryPath)
  $originalReview=[IO.File]::ReadAllBytes($reviewFile)
  $originalSnapshot=[IO.File]::ReadAllBytes((Join-Path $snapshotDir 'snapshot.json'))
  $originalPlan=[IO.File]::ReadAllBytes($planPath)
  $originalIntake=[IO.File]::ReadAllBytes($intakePath)
  try {
    J $registryPath @{schemaVersion=1;requestExecution='windows-local';credentialWriter='a1';version='2.96.0';adapterManifest=$release.releaseManifest}
    $snapshot=Get-Content (Join-Path $snapshotDir 'snapshot.json') -Raw|ConvertFrom-Json -AsHashtable
    $snapshot.previous.adapterManifest=$release.releaseManifest;J (Join-Path $snapshotDir 'snapshot.json') $snapshot
    $revision=@{schemaVersion=1;kind='aicc-ocx-reviewed-existing-adapter-revision/v1';
      runtimeRegistrySha256=(Digest $registryPath);baselineManifestSha256=(Digest $release.releaseManifest);
      targetSupplierVersion='2.96.0';adapterFiles=@{};sourceSha256=$plan.adapterSourceSha256.Clone()}
    Put (Join-Path $src $add) ((Get-Content (Join-Path $src $add) -Raw)+[Environment]::NewLine+'export const repeatSafe = true;')
    $revision.sourceSha256[$add]=Digest (Join-Path $src $add);J $reviewFile $revision
    $revPlan=Plan
    Assert ($revPlan.adapterSourceSha256.Count -eq 15 -and $revPlan.reviewedAdapterClosure.reviewedAdditions.Count -eq 0 -and
      $revPlan.canActivate -eq $false) 'Existing revision must preserve exact closure'
    $checks.Add('existing installed 15-module revision plans without adding or deleting modules')
    J $planPath $revPlan
    $revIntake=$intake.Clone();$revIntake.inputPlanSha256=Digest $planPath
    $revIntake.sourceSha256=$revPlan.adapterSourceSha256
    $revIntake.reviewedAdapterClosureSha256=$revPlan.reviewedAdapterClosureSha256
    $revIntake.reviewedAdapterAdditionsSha256=Digest $reviewFile;J $intakePath $revIntake
    $revRelease=Build
    Assert ($revRelease.status -eq 'FIXTURE_PASS_NOT_ACTIVATABLE' -and $revRelease.adapterFiles -eq 15) 'Existing revision candidate failed'
    $checks.Add('existing installed revision builds a distinct non-activatable fixture candidate')
    # Current installed 15-member releases also need reviewed new modules.
    # Planner supports that exact baseline; builder must consume the same proof.
    $preAdditionReview=[IO.File]::ReadAllBytes($reviewFile)
    $preAdditionPlan=[IO.File]::ReadAllBytes($planPath)
    $preAdditionIntake=[IO.File]::ReadAllBytes($intakePath)
    $runtimeFile=Join-Path $src 'external-runtime.ts'
    $preAdditionRuntime=[IO.File]::ReadAllBytes($runtimeFile)
    try {
      $newMember='external-original-issuer-bootstrap.ts'
      Put (Join-Path $src $newMember) 'export const bootstrapFixture = true;'
      Put $runtimeFile ((Get-Content -LiteralPath $runtimeFile -Raw)+[Environment]::NewLine+"import './external-original-issuer-bootstrap';")
      $newReview=@{schemaVersion=1;kind='aicc-ocx-reviewed-adapter-additions/v1';
        runtimeRegistrySha256=(Digest $registryPath);baselineManifestSha256=(Digest $release.releaseManifest);
        targetSupplierVersion='2.96.0';adapterFiles=@{$newMember=(Digest (Join-Path $src $newMember))}}
      J $reviewFile $newReview
      $newPlan=Plan;J $planPath $newPlan
      $newIntake=$intake.Clone();$newIntake.sourceSha256=$newPlan.adapterSourceSha256
      $newIntake.inputPlanSha256=Digest $planPath
      $newIntake.reviewedAdapterClosureSha256=$newPlan.reviewedAdapterClosureSha256
      $newIntake.reviewedAdapterAdditionsSha256=Digest $reviewFile;J $intakePath $newIntake
      $newRelease=Build
      Assert ($newRelease.adapterFiles -eq 16 -and $newRelease.canActivate -ceq $false) 'Installed 15-module reviewed addition was lost or activated'
      $checks.Add('installed 15-module baseline accepts exact reviewed reachable addition without activation')
      $newReview.adapterFiles[$newMember]='0'*64;J $reviewFile $newReview
      Refuses {Plan} 'installed 15-module addition pin drift' 'Reviewed adapter addition source SHA changed'
    } finally {
      [IO.File]::WriteAllBytes($reviewFile,$preAdditionReview)
      [IO.File]::WriteAllBytes($planPath,$preAdditionPlan)
      [IO.File]::WriteAllBytes($intakePath,$preAdditionIntake)
      [IO.File]::WriteAllBytes($runtimeFile,$preAdditionRuntime)
    }
    $revision.sourceSha256[$add]='0'*64;J $reviewFile $revision
    Refuses {Plan} 'existing revision source drift' 'existing adapter revision source SHA changed'
    $revision.sourceSha256[$add]=Digest (Join-Path $src $add)
    $revision.adapterFiles=@{$add=$revision.sourceSha256[$add]};J $reviewFile $revision
    Refuses {Plan} 'existing revision cannot add overlapping modules' 'existing 15-module revision receipt required'
  } finally {
    [IO.File]::WriteAllBytes($registryPath,$originalRegistry);[IO.File]::WriteAllBytes($reviewFile,$originalReview)
    [IO.File]::WriteAllBytes((Join-Path $snapshotDir 'snapshot.json'),$originalSnapshot)
    [IO.File]::WriteAllBytes($planPath,$originalPlan);[IO.File]::WriteAllBytes($intakePath,$originalIntake)
    Put (Join-Path $src $add) "import type {Quota} from './window-inflight-monitor';"
  }
  $reducedPins=[ordered]@{}
  foreach($name in $plan.adapterSourceSha256.Keys){
    if($name -cne $add){$reducedPins[$name]=$plan.adapterSourceSha256[$name]}
  }
  $intake.sourceSha256=$reducedPins;J $intakePath $intake
  Refuses {Build} 'missing intake additional pin' 'Plan and isolated acceptance adapter closure pins differ'
  $intake.sourceSha256=$plan.adapterSourceSha256;J $intakePath $intake
  $poolSrc=Join-Path $src 'external-pool-state.ts';$poolCopy=[IO.File]::ReadAllBytes($poolSrc)
  Put $poolSrc 'export const selected = true;'
  Refuses {Plan} 'missing relative import' 'Unreachable reviewed adapter addition'
  Refuses {Build} 'source import changed after acceptance' 'Pinned adapter source changed'
  [IO.File]::WriteAllBytes($poolSrc,$poolCopy)
  $newSrc=Join-Path $src $add;$newCopy=[IO.File]::ReadAllBytes($newSrc)
  Put $newSrc "import './external-never-reviewed';"
  $review.adapterFiles[$add]=Digest $newSrc;J $reviewFile $review
  Refuses {Plan} 'unreviewed transitive import' 'Unpinned relative adapter dependency'
  [IO.File]::WriteAllBytes($newSrc,$newCopy)
  $review.adapterFiles=@{'../escape.ts'=('a'*64)};J $reviewFile $review
  Refuses {Plan} 'relative path traversal' 'Reviewed addition overlaps baseline or has unsafe member'
  $review.adapterFiles=@{$add=(Digest $newSrc)};J $reviewFile $review
  $previousSource=Join-Path $old 'external-runtime.ts';$originalBytes=[IO.File]::ReadAllBytes($previousSource)
  Put $previousSource 'tampered'
  Refuses {Build} 'previous source modified' 'Previous installed adapter source differs'
  [IO.File]::WriteAllBytes($previousSource,$originalBytes)
  Remove-Item -LiteralPath $previousSource
  Refuses {Build} 'previous source deleted' 'Cannot find path|찾을 수 없습니다|Regular release input|required'
  [IO.File]::WriteAllBytes($previousSource,$originalBytes)
  $acceptanceBytes=[IO.File]::ReadAllBytes($prevAcc);Put $prevAcc 'tampered'
  Refuses {Build} 'previous acceptance changed' 'Previous release acceptance SHA differs'
  [IO.File]::WriteAllBytes($prevAcc,$acceptanceBytes)
  $extra=Join-Path $supplier 'src/extra.ts';Put $extra 'unreviewed'
  Refuses {Build} 'unreviewed supplier file' 'Installed supplier dependency file added, missing or altered'
  Remove-Item -LiteralPath $extra
  Put $dependencyPath 'unreviewed changed original installed dependency'
  Refuses {Plan} 'installed dependency tamper at plan' 'Installed supplier root dependency/source SHA changed'
  Refuses {Build} 'installed dependency tamper at builder' 'Installed supplier dependency file added, missing or altered'
  [IO.File]::WriteAllBytes($dependencyPath,$dependencyBytes)
  Remove-Item -LiteralPath $dependencyPath
  Refuses {Plan} 'installed dependency deleted at plan' 'Installed supplier root member count differs'
  Refuses {Build} 'installed dependency deleted at builder' 'Installed supplier dependency file added, missing or altered'
  [IO.File]::WriteAllBytes($dependencyPath,$dependencyBytes)
  $unreviewedDependency=Join-Path $supplier 'node_modules/fixture-dep/unreviewed.js'
  Put $unreviewedDependency 'unreviewed dependency must not be installed'
  Refuses {Plan} 'installed dependency added at plan' 'Installed supplier root member count differs'
  Refuses {Build} 'installed dependency added at builder' 'Installed supplier dependency file added, missing or altered'
  Remove-Item -LiteralPath $unreviewedDependency
  $supplierSymlinkSaved=Join-Path $root 'unchanged-original-dependency.js'
  [IO.File]::Move($dependencyPath,$supplierSymlinkSaved)
  $depLinkCreated=$false
  try{
    try{[IO.File]::CreateSymbolicLink($dependencyPath,$supplierSymlinkSaved)|Out-Null;$depLinkCreated=$true}catch{}
    if($depLinkCreated){
      Refuses {Plan} 'linked installed dependency at plan' 'Linked supplier file or junction refused'
      Refuses {Build} 'linked installed dependency at builder' 'Linked supplier file or junction refused'
    }else{
      $checks.Add('installed dependency symlink unavailable (existing file symlink rejection retained)')
    }
  }finally{
    if(Test-Path -LiteralPath $dependencyPath){Remove-Item -LiteralPath $dependencyPath -Force}
    [IO.File]::Move($supplierSymlinkSaved,$dependencyPath)
  }
  $junctionTarget=Join-Path $root 'junction-external-target'
  [IO.Directory]::CreateDirectory($junctionTarget)|Out-Null
  Put (Join-Path $junctionTarget 'payload.js') 'linked directory must not enter supplier'
  $junctionPath=Join-Path $supplier 'node_modules/fixture-junction'
  $junctionMade=$false
  try {
    try{New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget -ErrorAction Stop|Out-Null;$junctionMade=$true}catch{}
    if($junctionMade){
      Refuses {Plan} 'installed supplier junction at plan' 'Linked supplier file or junction refused'
      Refuses {Build} 'installed supplier junction at builder' 'Linked supplier file or junction refused'
    }else{
      $checks.Add('junction creation unavailable (supplier directory reparse guard preserved)')
    }
  }finally{
    if(Test-Path -LiteralPath $junctionPath){Remove-Item -LiteralPath $junctionPath -Force}
  }
  $archiveBytes=[IO.File]::ReadAllBytes($archive)
  [IO.File]::WriteAllText($archive,'tampered official archive')
  Refuses {Plan} 'official archive SHA tamper at plan' 'Prepared archive SHA512 differs'
  Refuses {Build} 'official archive SHA tamper at builder' 'Official archive or receipt changed since source review'
  [IO.File]::WriteAllBytes($archive,$archiveBytes)
  $registryBytes=[IO.File]::ReadAllBytes($registryPath)
  J $registryPath @{schemaVersion=1;requestExecution='windows-local';credentialWriter='a1';version='2.96.0';adapterManifest=$baselinePath;registryDrift='tampered'}
  Refuses {Plan} 'current registry CAS drift at plan' 'Exact reviewed additions identity and source pins required'
  Refuses {Build} 'current registry CAS drift at builder' 'Current baseline registry/manifest/supplier CAS changed'
  [IO.File]::WriteAllBytes($registryPath,$registryBytes)
  $intake.reviewedAdapterClosureSha256='0'*64;J $intakePath $intake
  Refuses {Build} 'changed closure SHA' 'Plan and isolated acceptance adapter closure pins differ'
  $intake.reviewedAdapterClosureSha256=$plan.reviewedAdapterClosureSha256;J $intakePath $intake
  $intake.inputPlanSha256='0'*64;J $intakePath $intake
  Refuses {Build} 'changed plan SHA' 'Prepared archive plan changed'
  $intake.inputPlanSha256=Digest $planPath;J $intakePath $intake
  $safe=Join-Path $root 'original-added.ts';[IO.File]::Move($newSrc,$safe)
  $linked=$false
  try {
    try{[IO.File]::CreateSymbolicLink($newSrc,$safe)|Out-Null;$linked=$true}catch{}
    if($linked){Refuses {Plan} 'linked new module' 'Linked input path refused'}
    else{$checks.Add('file symlink unavailable (archive symlink existing regression retained)')}
  }finally{
    if(Test-Path -LiteralPath $newSrc){Remove-Item -LiteralPath $newSrc -Force}
    [IO.File]::Move($safe,$newSrc)
  }
  @{status='PASS';checks=$checks.Count;names=$checks;fakeCandidateAdapterFiles=15;
    fixtureOnly=$true;liveInstall=$false}|ConvertTo-Json -Depth 5
}finally {
  $full=[IO.Path]::GetFullPath($root)
  if(-not $full.StartsWith($temp+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
     (Split-Path $full -Leaf) -cnotmatch '^aicc-ocx-closure-fixture-[a-f0-9]{32}$'){
    throw 'Unsafe fixture cleanup target'
  }
  if(Test-Path -LiteralPath $full){Remove-Item -LiteralPath $full -Recurse -Force}
}
