#requires -Version 7.5
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$OperationDirectory,
 [switch]$UpdateInstalledProvider,
 [string]$ExpectedInstalledConfigSha256,
 [string]$ExpectedInstalledProviderSha256,
 [string]$ExpectedSourceProviderSha256,
 [string]$ExpectedInstalledReleaseSha256,
 [string]$ExpectedInstalledDriveManifestSha256,
 [switch]$ReconcileInstalledBaseline,
 [string]$BaselineEvidenceReceiptFile,
 [string]$ExpectedBaselineEvidenceReceiptSha256,
 [string]$ExpectedInstalledRegistrySha256,
 [string]$ExpectedInstalledGatewayConfigSha256,
 [string]$ExpectedInstalledGatewayManifestSha256
)
$ErrorActionPreference='Stop'
$sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$ownerRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$OperationDirectory=[IO.Path]::GetFullPath($OperationDirectory)
$boundary=(Join-Path $ownerRoot 'asset-control').TrimEnd('\')+'\'
if(!$OperationDirectory.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase)){throw 'Exact owner asset-control operation directory required'}
if(Test-Path -LiteralPath $OperationDirectory){throw 'Original staging operation exists; reconcile instead of restaging'}
if(!$env:CODEX_THREAD_ID){throw 'Exact owner thread required'}
function Plain([string]$p){
 $full=[IO.Path]::GetFullPath($p);$item=Get-Item -LiteralPath $full -Force
 for($cursor=$item;$cursor;$cursor=$(if($cursor.PSIsContainer){$cursor.Parent}else{$cursor.Directory})){if($cursor.LinkType){throw 'Linked staging source refused'}}
 return $full
}
function Hash([string]$p){(Get-FileHash -LiteralPath (Plain $p)).Hash.ToLowerInvariant()}
function Read([string]$p){Get-Content -LiteralPath (Plain $p) -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function WriteNew([string]$p,$value){
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Depth 80))
 $stream=[IO.File]::Open($p,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
$registryFile=Join-Path $ownerRoot 'runtime/components.json';$registryHash=Hash $registryFile;$registry=Read $registryFile
$component=$registry.components.workspace;$baseline=Plain $component.releaseRoot
$managed=(Join-Path $ownerRoot 'releases/workspace').TrimEnd('\')+'\'
if($component.location -cne 'managed' -or !$baseline.StartsWith($managed,[StringComparison]::OrdinalIgnoreCase)){throw 'Current managed Workspace generation required'}
$node=Plain $component.runtime
$module=Plain (Join-Path $sourceRoot 'components/workspace-mcp/gpt-queue-runtime-overlay.mjs')
$mode=if($UpdateInstalledProvider){'installed-provider-only'}else{'initial-install'}
$providerRelative='components/workspace-mcp/gpt-queue-provider.mjs'
$providerBefore=Join-Path $baseline $providerRelative
$providerSource=Plain (Join-Path $sourceRoot $providerRelative)
$configFile=Join-Path $ownerRoot 'workspace-mcp/config.json'
$configSha=Hash $configFile;$config=Read $configFile
$releaseFile=Join-Path $baseline '.aicc-release.json'
$driveFile=Join-Path $baseline 'workspace-drive-manifest.json'
if($ReconcileInstalledBaseline -and -not $UpdateInstalledProvider){throw 'HOLD_BASELINE_RECONCILIATION_REQUIRES_PROVIDER_UPDATE'}
if(-not $ReconcileInstalledBaseline -and ($BaselineEvidenceReceiptFile -or $ExpectedBaselineEvidenceReceiptSha256 -or $ExpectedInstalledRegistrySha256 -or $ExpectedInstalledGatewayConfigSha256 -or $ExpectedInstalledGatewayManifestSha256)){throw 'HOLD_BASELINE_RECONCILIATION_EXPLICIT_OPT_IN_REQUIRED'}
if($UpdateInstalledProvider){
 foreach($expected in @($ExpectedInstalledConfigSha256,$ExpectedInstalledProviderSha256,
   $ExpectedSourceProviderSha256,$ExpectedInstalledReleaseSha256,$ExpectedInstalledDriveManifestSha256)){
  if($expected -cnotmatch '^[a-f0-9]{64}$'){throw 'HOLD_PROVIDER_UPDATE_EXACT_CAS_REQUIRED'}
 }
 if($configSha -cne $ExpectedInstalledConfigSha256 -or
   (Hash $providerBefore) -cne $ExpectedInstalledProviderSha256 -or
   (Hash $providerSource) -cne $ExpectedSourceProviderSha256 -or
   (Hash $releaseFile) -cne $ExpectedInstalledReleaseSha256 -or
   (Hash $driveFile) -cne $ExpectedInstalledDriveManifestSha256){
  throw 'HOLD_PROVIDER_UPDATE_INSTALLED_SOURCE_CAS_CHANGED'
 }
 if($config.surfaceProfile -cne 'business-full' -or $config.gptQueue.enabled -cne $true -or
   (Hash $config.gptQueue.bindingFile) -cne $config.gptQueue.bindingSha256){
  throw 'HOLD_PROVIDER_UPDATE_CURRENT_OWNER_CONFIG_UNPROVEN'
 }
 $preRelease=Read $releaseFile;$preDrive=Read $driveFile
 $rows=@($preRelease.files|Where-Object path -CEQ $providerRelative)
 if($rows.Count -ne 1 -or $rows[0].sha256 -cne $ExpectedInstalledProviderSha256 -or
   $preDrive.files[$providerRelative] -cne $ExpectedInstalledProviderSha256 -or
   $preRelease.gptQueueOverlay.kind -cne 'workspace-gpt-queue-overlay/v1'){
  throw 'HOLD_PROVIDER_UPDATE_INSTALLED_MANIFEST_PIN'
 }
 $baselineReconciliation=$null
 if($ReconcileInstalledBaseline){
  foreach($sha in @($ExpectedBaselineEvidenceReceiptSha256,$ExpectedInstalledRegistrySha256,
    $ExpectedInstalledGatewayConfigSha256,$ExpectedInstalledGatewayManifestSha256)){
   if($sha -cnotmatch '^[a-f0-9]{64}$'){throw 'HOLD_BASELINE_RECONCILIATION_EXACT_PINS_REQUIRED'}
  }
  $evidenceFile=Plain $BaselineEvidenceReceiptFile
  $evidenceRoot=(Join-Path $ownerRoot 'asset-control').TrimEnd('\')+'\'
  if(-not $evidenceFile.StartsWith($evidenceRoot,[StringComparison]::OrdinalIgnoreCase) -or
     [IO.Path]::GetFileName($evidenceFile) -cne 'candidate.json' -or
     (Hash $evidenceFile) -cne $ExpectedBaselineEvidenceReceiptSha256 -or
     $registryHash -cne $ExpectedInstalledRegistrySha256){
   throw 'HOLD_BASELINE_RECONCILIATION_SEALED_SOURCE_OR_REGISTRY_CHANGED'
  }
  $evidence=Read $evidenceFile
  $evidenceDir=Split-Path $evidenceFile -Parent
  $evidenceInventory=Join-Path $evidenceDir 'inventory.before.json'
  $evidencePrepared=Join-Path $evidenceDir 'prepared.json'
  if($evidence.kind -cne 'workspace-gpt-queue-owner-replacement' -or
     $evidence.status -cne 'PREPARED_NOT_ACTIVE' -or
     $evidence.backend -cne $baseline -or $evidence.baseline -cne $baseline -or
     $evidence.configDesiredSHA256 -cne $configSha -or
     $evidence.queueBackendManifestSHA256 -cne (Hash $releaseFile) -or
     $evidence.queueDriveManifestSHA256 -cne (Hash $driveFile) -or
     $evidence.gptQueueRecovery.inventoryBeforeFile -cne $evidenceInventory -or
     (Hash $evidenceInventory) -cne $evidence.gptQueueRecovery.inventoryBeforeSHA256){
   throw 'HOLD_BASELINE_RECONCILIATION_EXACT_PREVIOUS_RECEIPT_REQUIRED'
  }
  $priorPrepared=Read $evidencePrepared
  if($priorPrepared.status -cne 'VALIDATED_NOT_ACTIVE' -or
     $priorPrepared.candidateReceipt -cne $evidenceFile -or
     $priorPrepared.candidateSHA256 -cne $ExpectedBaselineEvidenceReceiptSha256){
   throw 'HOLD_BASELINE_RECONCILIATION_PREVIOUS_PREPARED_RECEIPT_REQUIRED'
  }
  # Immutable prior inventory must cover every installed file, including
  # unlisted additions. A new file is never an approved manifest exception.
  $evidenceRows=@(Read $evidenceInventory)
  $evidenceIndex=@{}
  foreach($row in $evidenceRows){
   $relative=[string]$row.path
   if(!$relative -or $relative.Contains('\') -or $relative.StartsWith('/') -or
      $relative -match '(^|/)\.\.?(/|$)' -or $evidenceIndex.ContainsKey($relative)){
    throw 'HOLD_BASELINE_RECONCILIATION_SEALED_INVENTORY_AMBIGUOUS'
   }
   $evidenceIndex[$relative]=$row
   $full=Join-Path $baseline $relative
   if((Hash $full) -cne $row.sha256 -or (Get-Item -LiteralPath $full).Length -ne $row.size){
    throw 'HOLD_BASELINE_RECONCILIATION_SEALED_INVENTORY_SOURCE_DRIFT'
   }
  }
  $installedFiles=@(Get-ChildItem -LiteralPath $baseline -Recurse -File -Force)
  if($installedFiles.Count -ne $evidenceIndex.Count){
   throw 'HOLD_BASELINE_RECONCILIATION_UNSEALED_ADDITION_OR_REMOVAL'
  }
  foreach($item in $installedFiles){
   $relative=[IO.Path]::GetRelativePath($baseline,$item.FullName).Replace('\','/')
   if(-not $evidenceIndex.ContainsKey($relative)){
    throw 'HOLD_BASELINE_RECONCILIATION_UNSEALED_ADDITION_OR_REMOVAL'
   }
  }
  $registeredGateway=Plain $registry.components['unified-mcp'].releaseRoot
  $gatewayConfigFile=Join-Path $registeredGateway 'config.json'
  $gatewayManifestFile=Join-Path $registeredGateway 'manifest.json'
  if((Hash $gatewayConfigFile) -cne $ExpectedInstalledGatewayConfigSha256 -or
     (Hash $gatewayManifestFile) -cne $ExpectedInstalledGatewayManifestSha256){
   throw 'HOLD_BASELINE_RECONCILIATION_CURRENT_GRAPH_CAS'
  }
  $graph=Read $gatewayConfigFile;$graphManifest=Read $gatewayManifestFile
  if($graph.hostControl -cne 'task-owned-v1' -or
     (@($graph.providers.id|Sort-Object) -join ',') -cne 'host,native,workspace' -or
     $graphManifest.files['config.json'] -cne $ExpectedInstalledGatewayConfigSha256){
   throw 'HOLD_BASELINE_RECONCILIATION_REGISTERED_GRAPH_UNPROVEN'
  }
  $workspace=@($graph.providers|Where-Object id -CEQ 'workspace')
  $mismatchRelative='components/workspace-mcp/web-management-provider.mjs'
  $mismatchFile=Join-Path $baseline $mismatchRelative
  $graphPins=@($workspace[0].files|Where-Object path -IEQ $mismatchFile)
  $record=@($preRelease.files|Where-Object path -CEQ $mismatchRelative)
  $sealedRows=@(Read $evidenceInventory|Where-Object path -CEQ $mismatchRelative)
  $actualSha=Hash $mismatchFile;$actualSize=(Get-Item -LiteralPath $mismatchFile).Length
  if($workspace.Count -ne 1 -or $graphPins.Count -ne 1 -or
     $graphPins[0].sha256 -cne $actualSha -or $record.Count -ne 1 -or
     $record[0].sha256 -ceq $actualSha -or
     $sealedRows.Count -ne 1 -or $sealedRows[0].sha256 -cne $actualSha -or
     $sealedRows[0].size -ne $actualSize -or
     -not $preDrive.files.ContainsKey($mismatchRelative) -or
     $preDrive.files[$mismatchRelative] -ceq $actualSha){
   throw 'HOLD_BASELINE_RECONCILIATION_EXACT_ONE_FILE_GRAPH_AND_INVENTORY_PROOF'
  }
  foreach($provider in $graph.providers){foreach($pin in $provider.files){
   if((Hash $pin.path) -cne $pin.sha256){
    throw 'HOLD_BASELINE_RECONCILIATION_REGISTERED_GRAPH_FILE_PIN_CHANGED'
   }
  }}
  $baselineReconciliation=@{
   kind='workspace-provider-baseline-reconciliation/v1';path=$mismatchRelative;baseline=$baseline;
   priorReceiptFile=$evidenceFile;priorReceiptSHA256=$ExpectedBaselineEvidenceReceiptSha256;
   priorPreparedFile=$evidencePrepared;priorPreparedSHA256=(Hash $evidencePrepared);
   sealedInventoryFile=$evidenceInventory;sealedInventorySHA256=(Hash $evidenceInventory);
   registryFile=$registryFile;registrySHA256=$registryHash;graphConfigFile=$gatewayConfigFile;
   graphConfigSHA256=$ExpectedInstalledGatewayConfigSha256;
   graphManifestFile=$gatewayManifestFile;graphManifestSHA256=$ExpectedInstalledGatewayManifestSha256;
   originalReleaseSHA256=(Hash $releaseFile);originalDriveSHA256=(Hash $driveFile);
   originalReleaseFileSHA256=$record[0].sha256;originalReleaseFileSize=$record[0].size;
   originalDriveFileSHA256=$preDrive.files[$mismatchRelative];
   actualFileSHA256=$actualSha;actualFileSize=$actualSize;
   mismatchCount=1;sourceOwnerVerified=$true;operatingWrites=0
  }
 }
 $seen=@{}
 $releaseMismatches=@()
 foreach($pin in @($preRelease.files)){
  $relative=[string]$pin.path
  if(!$relative -or $relative.Contains('\') -or $relative.StartsWith('/') -or
     $relative -match '(^|/)\.\.?(/|$)' -or $seen.ContainsKey($relative)){
   throw 'HOLD_PROVIDER_UPDATE_RELEASE_FILE_ALLOWLIST_AMBIGUOUS'
  }
  $seen[$relative]=$true
  $installed=Join-Path $baseline $relative
  if((Hash $installed) -cne $pin.sha256 -or
     (Get-Item -LiteralPath $installed).Length -ne $pin.size){
   if(-not $baselineReconciliation -or $relative -cne $baselineReconciliation.path){
    throw 'HOLD_PROVIDER_UPDATE_RELEASE_FILE_PREIMAGE_CHANGED'
   }
   $releaseMismatches+=,$relative
  }
 }
}else{
 if($config.gptQueue -or (Test-Path -LiteralPath $providerBefore)){
  throw 'Existing queue provider requires explicit UpdateInstalledProvider and SHA pins'
 }
}
$script=@'
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const [module,baseline,source,mode]=process.argv.slice(1);
const m=await import(pathToFileURL(module).href);const before={},desired={};
for(const p of m.GPT_QUEUE_OVERLAY_FILES){const file=path.join(baseline,p);if(fs.existsSync(file))before[p]=fs.readFileSync(file,'utf8');desired[p]=fs.readFileSync(path.join(source,p),'utf8');}
process.stdout.write(JSON.stringify(m.buildGptQueueRuntimeOverlay(before,desired,{mode})));
'@
$transformed=& $node --input-type=module -e $script $module $baseline $sourceRoot $mode
if($LASTEXITCODE -ne 0 -or !$transformed){throw 'Installed queue overlay transform refused'}
$files=$transformed|ConvertFrom-Json -AsHashtable
$sourcePins=@(@{path=$module;sha256=(Hash $module)})
function Is-QueueAddition([string]$Relative){$Relative -cin @('components/workspace-mcp/gpt-queue-provider.mjs','src/lib/windows-owner-only-acl.mjs','src/lib/windows-pwsh.mjs')}
foreach($relative in $files.Keys){$sourcePins+=@{path=(Join-Path $sourceRoot $relative);sha256=(Hash (Join-Path $sourceRoot $relative))}}
$null=New-Item -ItemType Directory -Path $OperationDirectory
$before=@();foreach($file in Get-ChildItem -LiteralPath $baseline -Recurse -Force){if($file.LinkType){throw 'Linked installed release refused'};if(!$file.PSIsContainer){$before+=@{path=[IO.Path]::GetRelativePath($baseline,$file.FullName).Replace('\','/');sha256=(Hash $file.FullName);size=$file.Length}}}
WriteNew (Join-Path $OperationDirectory 'inventory.before.json') $before
$key=(Get-FileHash -LiteralPath $module).Hash.Substring(0,12).ToLowerInvariant()+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$candidate=Join-Path $managed ('gpt-queue-'+$key)
if(Test-Path -LiteralPath $candidate){throw 'Existing candidate preserved'}
WriteNew (Join-Path $OperationDirectory 'stage.intent.json') @{schemaVersion=1;owner=$env:CODEX_THREAD_ID;baseline=$baseline;candidate=$candidate;sourcePins=$sourcePins;overlayMode=$mode;status='STAGING';installedConfigSHA256=$configSha;installedReleaseSHA256=(Hash $releaseFile);installedDriveManifestSHA256=(Hash $driveFile);activeWrites=0}
Copy-Item -LiteralPath $baseline -Destination $candidate -Recurse
$deltaFiles=if($UpdateInstalledProvider){@($providerRelative)}else{@($files.Keys)}
foreach($relative in $deltaFiles){$target=Join-Path $candidate $relative;$null=New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force;[IO.File]::WriteAllText($target,$files[$relative],[Text.UTF8Encoding]::new($false))}
$release=Read (Join-Path $baseline '.aicc-release.json');$drive=Read (Join-Path $baseline 'workspace-drive-manifest.json')
foreach($relative in $deltaFiles){
 $file=Join-Path $candidate $relative;$rows=@($release.files|Where-Object path -CEQ $relative)
 if($rows.Count -gt 1 -or ($rows.Count -eq 0 -and -not (Is-QueueAddition $relative))){throw 'Ambiguous installed release manifest'}
 if($rows.Count -eq 1){$rows[0].sha256=Hash $file;$rows[0].size=(Get-Item -LiteralPath $file).Length}else{$release.files+=@{path=$relative;sha256=(Hash $file);size=(Get-Item -LiteralPath $file).Length}}
 $drive.files[$relative]=Hash $file
}
if($baselineReconciliation){
 $mismatch=$baselineReconciliation.path
 $row=@($release.files|Where-Object path -CEQ $mismatch)
 if($row.Count -ne 1){throw 'HOLD_BASELINE_RECONCILIATION_CANDIDATE_FILE_NOT_UNIQUE'}
 $row[0].sha256=$baselineReconciliation.actualFileSHA256
 $row[0].size=$baselineReconciliation.actualFileSize
 $drive.files[$mismatch]=$baselineReconciliation.actualFileSHA256
}
$release.fileCount=@($release.files).Count;$release.totalBytes=[long](($release.files|Measure-Object size -Sum).Sum)
$proof=@{schemaVersion=1;kind='workspace-gpt-queue-overlay/v1';owner=$env:CODEX_THREAD_ID;baseline=$baseline;sourcePins=$sourcePins;overlayMode=$mode;previousProviderSHA256=$(if($UpdateInstalledProvider){$ExpectedInstalledProviderSha256}else{''});desiredProviderSHA256=(Hash (Join-Path $candidate $providerRelative));installedConfigSHA256=$configSha;installedConfigChanged=$false;toolCalls=0}
if($baselineReconciliation){$proof.baselineReconciliation=$baselineReconciliation}
$release.gptQueueOverlay=$proof
[IO.File]::WriteAllText((Join-Path $candidate '.aicc-release.json'),($release|ConvertTo-Json -Depth 80),[Text.UTF8Encoding]::new($false))
$drive.baseline=$baseline;$drive.release=$candidate;$drive.files['.aicc-release.json']=Hash (Join-Path $candidate '.aicc-release.json');$drive.gptQueueOverlay=$proof
[IO.File]::WriteAllText((Join-Path $candidate 'workspace-drive-manifest.json'),($drive|ConvertTo-Json -Depth 80),[Text.UTF8Encoding]::new($false))
foreach($pin in $sourcePins){if((Hash $pin.path) -cne $pin.sha256){throw 'Reviewed source changed during staging'}}
$allowed=@($deltaFiles)+@('.aicc-release.json','workspace-drive-manifest.json');$known=@{}
$actualChanged=@()
foreach($row in $before){
 $known[$row.path]=$row
 if((Hash (Join-Path $baseline $row.path)) -cne $row.sha256){throw 'Installed baseline changed after inventory'}
 $afterSha=Hash (Join-Path $candidate $row.path)
 if($afterSha -cne $row.sha256){$actualChanged+=,$row.path}
 if($row.path -cnotin $allowed -and $afterSha -cne $row.sha256){throw 'Unrelated installed file changed'}
}
if($UpdateInstalledProvider -and
  ((@($actualChanged|Sort-Object) -join ',') -cne (@($allowed|Sort-Object) -join ','))){
 throw 'HOLD_PROVIDER_UPDATE_EXACT_DELTA_UNPROVEN'
}
if($UpdateInstalledProvider -and
  ((Hash $configFile) -cne $ExpectedInstalledConfigSha256 -or
   (Hash $providerBefore) -cne $ExpectedInstalledProviderSha256 -or
   (Hash $providerSource) -cne $ExpectedSourceProviderSha256 -or
   (Hash $releaseFile) -cne $ExpectedInstalledReleaseSha256 -or
   (Hash $driveFile) -cne $ExpectedInstalledDriveManifestSha256)){
 throw 'HOLD_PROVIDER_UPDATE_STAGE_CAS_DRIFT'
}
$after=@();foreach($file in Get-ChildItem -LiteralPath $candidate -Recurse -File -Force){$relative=[IO.Path]::GetRelativePath($candidate,$file.FullName).Replace('\','/');if(!$known.ContainsKey($relative) -and -not (Is-QueueAddition $relative)){throw 'Unapproved release addition'};$after+=@{path=$relative;sha256=(Hash $file.FullName);size=$file.Length}}
WriteNew (Join-Path $OperationDirectory 'inventory.desired.json') $after
if((Hash $registryFile) -cne $registryHash){throw 'Registry changed during staging'}
$current=Read $registryFile;if(($current.components.workspace|ConvertTo-Json -Depth 20 -Compress) -cne ($component|ConvertTo-Json -Depth 20 -Compress)){throw 'Current Workspace generation changed during staging'}
$receipt=@{schemaVersion=1;kind='workspace-gpt-queue-source-stage/v1';status='STAGED_NOT_INSTALLED';owner=$env:CODEX_THREAD_ID;baseline=$baseline;backend=$candidate;overlayMode=$mode;changedFiles=@($files.Keys)+@('.aicc-release.json','workspace-drive-manifest.json');actualChangedFiles=$actualChanged;sourcePins=$sourcePins;installedConfigSHA256=$configSha;baselineProviderSHA256=$(if($UpdateInstalledProvider){$ExpectedInstalledProviderSha256}else{''});desiredProviderSHA256=(Hash (Join-Path $candidate $providerRelative));installedReleaseSHA256=(Hash $releaseFile);installedDriveManifestSHA256=(Hash $driveFile);inventoryBeforeSha256=(Hash (Join-Path $OperationDirectory 'inventory.before.json'));inventoryDesiredSha256=(Hash (Join-Path $OperationDirectory 'inventory.desired.json'));activeWrites=0;installed=$false;configChanged=$false;toolPublished=$false;verification='PENDING_CANDIDATE_IMPORT_CLOSURE_AND_TOOL_CONTRACT'}
if($baselineReconciliation){$receipt.baselineReconciliation=$baselineReconciliation}
WriteNew (Join-Path $OperationDirectory 'stage.json') $receipt
@{status=$receipt.status;receipt=(Join-Path $OperationDirectory 'stage.json');candidate=$candidate;activeWrites=0}|ConvertTo-Json -Compress
