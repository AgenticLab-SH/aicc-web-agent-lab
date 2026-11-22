#requires -Version 7.5
[CmdletBinding()]
param(
 [string]$StageReceipt,
 [Parameter(Mandatory)][string]$OwnerPreparedReceipt,
 [Parameter(Mandatory)][string]$ExpectedOwnerPreparedSha256,
 [Parameter(Mandatory)][string]$OperationDirectory,
 [switch]$ReplaceExistingOwnerBinding,
 [switch]$RebindUnregisteredSameOperation,
 [switch]$UpgradeCurrentIssuerHelper,
 [switch]$UpgradeIssuerAndProviderTogether,
 [string]$ExpectedPriorIssuerHelperSha256,
 [string]$ExpectedNextIssuerHelperSha256,
 [string]$ExpectedNextIssuerGuardSha256,
 [switch]$UpdateInstalledProvider,
 [string]$ExpectedInstalledConfigSha256,
 [string]$ExpectedInstalledRegistrySha256,
 [string]$ExpectedInstalledBackendReleaseSha256,
 [string]$ExpectedInstalledDriveManifestSha256,
 [string]$ExpectedInstalledGatewayConfigSha256,
 [string]$ExpectedInstalledGatewayManifestSha256,
 [string]$ExpectedPreviousBindingSha256,
 [string]$PreviousOwnerPreparedReceipt,
 [string]$ExpectedPreviousOwnerPreparedSha256,
 [string]$NativeUpgradeEvidenceFile,
 [string]$ExpectedNativeUpgradeEvidenceSha256,
 [string]$LegacyCancelReceiptFile,
 [string]$ExpectedLegacyCancelReceiptSha256
)
$ErrorActionPreference='Stop'
$stateRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$registryFile=Join-Path $stateRoot 'runtime/components.json'
$configFile=Join-Path $stateRoot 'workspace-mcp/config.json'
$profileFile=Join-Path $stateRoot 'workspace-mcp/tunnel/profiles/aicc-workspace.yaml'
$updater=Join-Path $PSScriptRoot 'Update-AiccWebManagementRuntime.ps1'
# Load only the updater's existing validation functions, never its entry point.
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($updater,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Updater syntax differs'}
foreach($statement in $ast.EndBlock.Statements){
 if($statement -is [Management.Automation.Language.FunctionDefinitionAst]){
  . ([scriptblock]::Create($statement.Extent.Text))
 }
}
. (Join-Path $PSScriptRoot 'GptQueueRuntimeDeployment.ps1')
$OperationDirectory=[IO.Path]::GetFullPath($OperationDirectory)
$boundary=(Join-Path $stateRoot 'asset-control').TrimEnd('\')+'\'
if(!$OperationDirectory.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase) -or
   (Test-Path -LiteralPath $OperationDirectory)){throw 'New exact owner operation directory required'}
if(!$env:CODEX_THREAD_ID){throw 'Exact owner thread required'}
if((Hash $OwnerPreparedReceipt) -cne $ExpectedOwnerPreparedSha256){throw 'Original owner preparation changed'}
$prepared=Read $OwnerPreparedReceipt
if($prepared.kind -cne 'aicc-gpt-queue-owner-prepared' -or $prepared.inspectedTargets -ne 2 -or
   $prepared.originalRequestDispatched -cne $false){throw 'Actual original two-target owner preparation required'}
$ownerBinding=Join-Path (Split-Path $OwnerPreparedReceipt -Parent) 'binding.json'
if((Hash $ownerBinding) -cne $prepared.bindingSha256){throw 'Exact owner binding changed'}
$binding=Read $ownerBinding
Assert-GptQueueTargetProofFreshness $binding
if($UpgradeIssuerAndProviderTogether -and
   (-not $ReplaceExistingOwnerBinding -or -not $UpgradeCurrentIssuerHelper -or
    -not $RebindUnregisteredSameOperation -or -not $StageReceipt -or $UpdateInstalledProvider)){
 throw 'HOLD_COMBINED_ISSUER_PROVIDER_EXPLICIT_MODE_REQUIRED'
}
if($RebindUnregisteredSameOperation -and -not $ReplaceExistingOwnerBinding){
 throw 'HOLD_REBIND_EXPLICIT_REPLACEMENT_OPT_IN_REQUIRED'
}
if($UpgradeCurrentIssuerHelper -and
   (-not $ReplaceExistingOwnerBinding -or -not $RebindUnregisteredSameOperation -or
    $UpdateInstalledProvider)){
 throw 'HOLD_ISSUER_HELPER_UPGRADE_ONLY_EXPLICIT_UNREGISTERED_REBIND'
}
if(-not $UpgradeCurrentIssuerHelper -and
   ($ExpectedPriorIssuerHelperSha256 -or $ExpectedNextIssuerHelperSha256 -or $ExpectedNextIssuerGuardSha256)){
 throw 'HOLD_ISSUER_HELPER_UPGRADE_EXPLICIT_MODE_REQUIRED'
}
if($UpgradeCurrentIssuerHelper){
 foreach($sha in @($ExpectedPriorIssuerHelperSha256,$ExpectedNextIssuerHelperSha256,
  $ExpectedNextIssuerGuardSha256)){
  if($sha -cnotmatch '^[a-f0-9]{64}$'){throw 'HOLD_ISSUER_HELPER_UPGRADE_EXACT_SHA_REQUIRED'}
 }
}
if($RebindUnregisteredSameOperation -and ($LegacyCancelReceiptFile -or $ExpectedLegacyCancelReceiptSha256)){
 throw 'HOLD_REBIND_TERMINAL_REPLACEMENT_MIXED'
}
if($UpdateInstalledProvider -and ($ReplaceExistingOwnerBinding -or $RebindUnregisteredSameOperation)){
 throw 'HOLD_QUEUE_PROVIDER_UPDATE_MIXED_WITH_OWNER_REPLACEMENT'
}
if($ReplaceExistingOwnerBinding){
 foreach($sha in @($ExpectedInstalledConfigSha256,$ExpectedInstalledRegistrySha256,
  $ExpectedInstalledBackendReleaseSha256,$ExpectedInstalledDriveManifestSha256,
  $ExpectedInstalledGatewayConfigSha256,$ExpectedInstalledGatewayManifestSha256,
  $ExpectedPreviousBindingSha256,$ExpectedPreviousOwnerPreparedSha256,
  $ExpectedNativeUpgradeEvidenceSha256)){
  if($sha -cnotmatch '^[a-f0-9]{64}$'){throw 'Explicit exact installed/predecessor/native SHA required'}
 }
 if(-not $PreviousOwnerPreparedReceipt -or -not $NativeUpgradeEvidenceFile){
  throw 'Previous immutable preparation and Native upgrade evidence are required'
 }
 if((Hash $configFile) -cne $ExpectedInstalledConfigSha256 -or
    (Hash $registryFile) -cne $ExpectedInstalledRegistrySha256){
  throw 'Installed owner config/registry CAS changed'
 }
 $before=Read $configFile;$registry=Read $registryFile
 if($before.surfaceProfile -cne 'business-full' -or
    $before.gptQueue.enabled -cne $true -or @($before.gptQueue.Keys).Count -ne 3 -or
    $before.gptQueue.bindingSha256 -cne $ExpectedPreviousBindingSha256 -or
    (Hash $before.gptQueue.bindingFile) -cne $ExpectedPreviousBindingSha256){
  throw 'Existing exact queue owner binding required for replacement'
 }
 $priorBindingFile=Regular $before.gptQueue.bindingFile
 $old=Read $priorBindingFile;$next=Read $ownerBinding
 if($old.kind -cne 'aicc-gpt-queue-owner-binding' -or $next.kind -cne $old.kind -or
    $old.ownerId -cne $next.ownerId -or $old.ownerIdentityHash -cne $next.ownerIdentityHash -or
    $old.workspaceAlias -cne $next.workspaceAlias -or $old.workspaceRoot -cne $next.workspaceRoot){
  throw 'Replacement cannot transfer owner/workspace'
 }
 if($RebindUnregisteredSameOperation){
  if($old.operationId -cne $next.operationId -or $old.bindingId -cne $next.bindingId -or
     $old.originalRequestSha256 -ceq $next.originalRequestSha256){
   throw 'HOLD_REBIND_IDENTICAL_OPERATION_AND_NEW_REQUEST_REQUIRED'
  }
 }elseif($old.operationId -ceq $next.operationId -or $old.bindingId -ceq $next.bindingId -or
         $old.originalRequestSha256 -ceq $next.originalRequestSha256){
  throw 'Replacement cannot replay old operation or binding'
 }
 if((Hash $PreviousOwnerPreparedReceipt) -cne $ExpectedPreviousOwnerPreparedSha256){
  throw 'Previous immutable receipt SHA changed'
 }
 $prior=Read $PreviousOwnerPreparedReceipt
 if($prior.kind -cne 'aicc-gpt-queue-owner-prepared' -or
    $prior.bindingSha256 -cne $ExpectedPreviousBindingSha256 -or
    $prior.originalRequestSha256 -cne $old.originalRequestSha256 -or
    $prior.ownerIdentityHash -cne $old.ownerIdentityHash){
  throw 'Exact previous prepared receipt required'
 }
 if((Hash $NativeUpgradeEvidenceFile) -cne $ExpectedNativeUpgradeEvidenceSha256){
  throw 'Native upgrade evidence SHA changed'
 }
 $backend=$registry.components.workspace.releaseRoot
 $baseline=$backend
 $combinedStage=$null
 if($UpgradeIssuerAndProviderTogether){
  $combinedStage=Read $StageReceipt
  if($combinedStage.owner -cne $env:CODEX_THREAD_ID -or
     $combinedStage.kind -cne 'workspace-gpt-queue-source-stage/v1' -or
     $combinedStage.status -cne 'STAGED_NOT_INSTALLED' -or
     $combinedStage.baseline -cne $baseline -or $combinedStage.backend -ceq $baseline -or
     $combinedStage.overlayMode -cne 'installed-provider-only'){
   throw 'HOLD_COMBINED_ISSUER_PROVIDER_STAGE_REQUIRED'
  }
  $null=Regular (Join-Path $combinedStage.backend 'components/workspace-mcp/gpt-queue-provider.mjs')
  $backend=$combinedStage.backend
 }
 $oldGateway=$registry.components['unified-mcp'].releaseRoot
 if((Hash (Join-Path $baseline '.aicc-release.json')) -cne $ExpectedInstalledBackendReleaseSha256 -or
    (Hash (Join-Path $baseline 'workspace-drive-manifest.json')) -cne $ExpectedInstalledDriveManifestSha256 -or
    (Hash (Join-Path $oldGateway 'config.json')) -cne $ExpectedInstalledGatewayConfigSha256 -or
    (Hash (Join-Path $oldGateway 'manifest.json')) -cne $ExpectedInstalledGatewayManifestSha256){
  throw 'Installed backend/manifest/gateway generation CAS differs'
 }
 $graph=Read (Join-Path $oldGateway 'config.json')
 $manifest=Read (Join-Path $oldGateway 'manifest.json')
 if($manifest.files['config.json'] -cne $ExpectedInstalledGatewayConfigSha256 -or
    (@($graph.providers.id|Sort-Object) -join ',') -cne 'host,native,workspace' -or
    $graph.hostControl -cne 'task-owned-v1'){throw 'Current registered three-provider graph unverified'}
 $w=@($graph.providers|Where-Object id -CEQ 'workspace')
 if($w.Count -ne 1 -or @($w[0].toolNames|Where-Object {$_ -like 'aicc_gpt_queue_*'}).Count -ne 5 -or
    @($w[0].files|Where-Object path -IEQ $configFile).Count -ne 1 -or
    (@($w[0].files|Where-Object path -IEQ $configFile)[0].sha256) -cne $ExpectedInstalledConfigSha256){
  throw 'Existing five queue tools and owner config graph pin required'
 }
 foreach($provider in $graph.providers){foreach($pin in $provider.files){
  if((Hash $pin.path) -cne $pin.sha256){throw 'Installed native/host/provider file pin changed'}
 }}
 # Verify both the immutable old helper and the exact reviewed new source
 # generation BEFORE Native readback or candidate/Gateway writes.
 Assert-GptQueueIssuerHelperUpgrade $old $next $prepared ([bool]$UpgradeCurrentIssuerHelper)
 if($UpgradeCurrentIssuerHelper -and
    ($old.currentIssuer.helperSha256 -cne $ExpectedPriorIssuerHelperSha256 -or
     $next.currentIssuer.helperSha256 -cne $ExpectedNextIssuerHelperSha256 -or
     $next.currentIssuer.identityGuardSha256 -cne $ExpectedNextIssuerGuardSha256)){
  throw 'HOLD_ISSUER_HELPER_UPGRADE_CANDIDATE_CAS_CHANGED'
 }
 # This is an owner-only native read, not queue register, activation or dispatch.
 if($LegacyCancelReceiptFile -or $ExpectedLegacyCancelReceiptSha256){
  if((Hash $LegacyCancelReceiptFile) -cne $ExpectedLegacyCancelReceiptSha256){throw 'Legacy cancel receipt SHA changed'}
 }
 $native=if($RebindUnregisteredSameOperation){
  Get-GptQueueUnregisteredRebindNativeReadback $priorBindingFile $ownerBinding $PreviousOwnerPreparedReceipt $OwnerPreparedReceipt $backend $registry.components.workspace.runtime ([bool]$UpgradeCurrentIssuerHelper) $ExpectedPriorIssuerHelperSha256 $ExpectedNextIssuerHelperSha256 $ExpectedNextIssuerGuardSha256
 }else{
  Get-GptQueueReplacementNativeReadback $priorBindingFile $ownerBinding $backend $registry.components.workspace.runtime $LegacyCancelReceiptFile $ExpectedLegacyCancelReceiptSha256
 }
 $gateway=Join-Path $stateRoot ('releases/unified-mcp/gpt-queue-owner-'+(Hash $OwnerPreparedReceipt).Substring(0,12)+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
 $after=Read $configFile
 $after.gptQueue=@{enabled=$true;bindingFile=$ownerBinding;bindingSha256=$prepared.bindingSha256}
 # The optional provider delta stays in this same reviewed rollback transaction.
 $null=New-Item -ItemType Directory -Path $OperationDirectory
 New-Text (Join-Path $OperationDirectory 'prepare.intent.json') (Json @{
  kind='workspace-gpt-queue-owner-replacement-preparation/v1';owner=$env:CODEX_THREAD_ID;
  previousOperationId=$old.operationId;nextOperationId=$next.operationId;backend=$backend;
  gateway=$gateway;installedConfigSHA256=$ExpectedInstalledConfigSha256;liveWrites=0;dispatched=$false
 })
 Copy-Item -LiteralPath $configFile -Destination (Join-Path $OperationDirectory 'workspace-config.before.json')
 $desired=Join-Path $OperationDirectory 'workspace-config.desired.json'
 New-Text $desired (Json $after)
 New-Text (Join-Path $OperationDirectory 'native-readback.json') (Json $native)
 $w[0].files|Where-Object path -IEQ $configFile|ForEach-Object {$_.sha256=Hash $desired}
 if($combinedStage){
  $prefix=$baseline.TrimEnd('\')+'\'
  $w[0].entrypoint=$backend+$w[0].entrypoint.Substring($baseline.Length)
  $w[0].args=@($w[0].args|ForEach-Object {if($_ -is [string] -and $_.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$backend+$_.Substring($baseline.Length)}else{$_}})
  foreach($pin in $w[0].files){if($pin.path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$pin.path=Join-Path $backend $pin.path.Substring($prefix.Length);$pin.sha256=Hash $pin.path}}
 }
 $null=New-Item -ItemType Directory -Path $gateway
 New-Text (Join-Path $gateway 'config.json') (Json $graph)
 Copy-Item -LiteralPath (Join-Path $oldGateway 'gateway.cjs') -Destination (Join-Path $gateway 'gateway.cjs')
 $manifest.files['config.json']=Hash (Join-Path $gateway 'config.json')
 $manifest.releaseHash=$manifest.files['config.json']
 New-Text (Join-Path $gateway 'manifest.json') (Json $manifest)
 $profileText=[IO.File]::ReadAllText($profileFile)
 $spellings=@(@($oldGateway,$oldGateway.Replace('\','/'),$oldGateway.Replace('\','\\'))|Select-Object -Unique|Where-Object {$profileText.Contains($_)})
 if($spellings.Count -ne 1 -or $profileText.Split([string[]]@($spellings[0]),[StringSplitOptions]::None).Count -ne 3){
  throw 'Current gateway profile must have exactly two path references'
 }
 $spelling=$spellings[0]
 $replacement=if($spelling -ceq $oldGateway){$gateway}elseif($spelling -ceq $oldGateway.Replace('\','/')){$gateway.Replace('\','/')}else{$gateway.Replace('\','\\')}
 $profileDesired=Join-Path $OperationDirectory 'workspace-profile.desired.yaml'
 New-Text $profileDesired ($profileText.Replace($spelling,$replacement))
 # Full installed inventory is pinned for the existing updater rollback, not staged anew.
 $prefix=[IO.Path]::GetFullPath($baseline).TrimEnd('\')+'\'
 $inventory=@()
 foreach($item in Get-ChildItem -LiteralPath $baseline -Recurse -Force){
  if($item.LinkType){throw 'Linked installed backend entry refused'}
  if(-not $item.PSIsContainer){
   $inventory+=@{path=$item.FullName.Substring($prefix.Length).Replace('\','/');sha256=(Hash $item.FullName);size=$item.Length}
  }
 }
 $inventoryFile=Join-Path $OperationDirectory 'inventory.before.json'
 New-Text $inventoryFile (Json @($inventory|Sort-Object path))
 $CandidateReceipt=Join-Path $OperationDirectory 'candidate.json'
 $candidate=@{
  schemaVersion=1;kind='workspace-gpt-queue-owner-replacement';status='PREPARED_NOT_ACTIVE';
  baseline=$baseline;backend=$backend;oldGateway=$oldGateway;gateway=$gateway;
  configFile=$configFile;profile=$profileFile;configBeforeSHA256=$ExpectedInstalledConfigSha256;
  configDesiredFile=$desired;configDesiredSHA256=(Hash $desired);
  profileBeforeSHA256=(Hash $profileFile);profileDesiredFile=$profileDesired;profileDesiredSHA256=(Hash $profileDesired);
  bindingFile=$before.webManagement.bindingFile;bindingSHA256=$before.webManagement.bindingSha256;
  gatewayConfigSHA256=(Hash (Join-Path $gateway 'config.json'));
  oldGatewayConfigSHA256=$ExpectedInstalledGatewayConfigSha256;
  oldGatewayManifestSHA256=$ExpectedInstalledGatewayManifestSha256;
  queueBackendManifestSHA256=$ExpectedInstalledBackendReleaseSha256;
  queueDriveManifestSHA256=$ExpectedInstalledDriveManifestSha256;
  changedFiles=@();toolHash=$w[0].toolHash;queueToolNames=@($w[0].toolNames);
  queuePreviousBindingFile=$priorBindingFile;queuePreviousBindingSHA256=$ExpectedPreviousBindingSha256;
  queuePreviousPreparedFile=(Regular $PreviousOwnerPreparedReceipt);queuePreviousPreparedSHA256=$ExpectedPreviousOwnerPreparedSha256;
  queueNextBindingFile=$ownerBinding;queueNextBindingSHA256=$prepared.bindingSha256;
  queueOwnerPreparedFile=(Regular $OwnerPreparedReceipt);queueOwnerPreparedSHA256=$ExpectedOwnerPreparedSha256;
  nativeUpgradeEvidenceFile=(Regular $NativeUpgradeEvidenceFile);nativeUpgradeEvidenceSHA256=$ExpectedNativeUpgradeEvidenceSha256;
  queueNativeReadbackFile=(Join-Path $OperationDirectory 'native-readback.json');
  queueNativeReadbackSHA256=(Hash (Join-Path $OperationDirectory 'native-readback.json'));
  queueRebindUnregisteredSameOperation=[bool]$RebindUnregisteredSameOperation;
  queueUpgradeCurrentIssuerHelper=[bool]$UpgradeCurrentIssuerHelper;
  queuePreviousIssuerHelperSHA256=$ExpectedPriorIssuerHelperSha256;
  queueNextIssuerHelperSHA256=$ExpectedNextIssuerHelperSha256;
  queueNextIssuerGuardSHA256=$ExpectedNextIssuerGuardSha256;
  queuePreviousOriginalRequestSHA256=$old.originalRequestSha256;
  queueNextOriginalRequestSHA256=$next.originalRequestSha256;
  legacyCancelReceiptFile=$LegacyCancelReceiptFile;legacyCancelReceiptSHA256=$ExpectedLegacyCancelReceiptSha256;
  gptQueueRecovery=@{registrySHA256=$ExpectedInstalledRegistrySha256;inventoryBeforeFile=$inventoryFile;inventoryBeforeSHA256=(Hash $inventoryFile)}
 }
 if($combinedStage){
  $candidate.queueCombinedIssuerProviderUpdate=$true
  $candidate.queueStageFile=Regular $StageReceipt
  $candidate.queueStageSHA256=Hash $StageReceipt
  $candidate.changedFiles=@($combinedStage.actualChangedFiles)
  if($combinedStage.baselineReconciliation){$candidate.queueProviderBaselineReconciliation=$combinedStage.baselineReconciliation}
  $candidate.queueProviderUpdatePins=@{
   installedConfigSHA256=$combinedStage.installedConfigSHA256;
   baselineProviderSHA256=$combinedStage.baselineProviderSHA256;
   desiredProviderSHA256=$combinedStage.desiredProviderSHA256;
   installedReleaseSHA256=$combinedStage.installedReleaseSHA256;
   installedDriveManifestSHA256=$combinedStage.installedDriveManifestSHA256;
   runtimeIntegritySHA256=(Hash (Join-Path $baseline 'components/workspace-mcp/runtime-integrity.mjs'))
  }
  Assert-GptQueueCombinedProviderStage $candidate
 }
 New-Text $CandidateReceipt (Json $candidate)
 Validate-Candidate $candidate
 if((Hash $registryFile) -cne $ExpectedInstalledRegistrySha256 -or
    (Hash $configFile) -cne $ExpectedInstalledConfigSha256 -or
    (Hash (Join-Path $oldGateway 'config.json')) -cne $ExpectedInstalledGatewayConfigSha256){
  throw 'Live installed CAS changed during owner replacement preparation'
 }
 New-Text (Join-Path $OperationDirectory 'prepared.json') (Json @{
  status='VALIDATED_NOT_ACTIVE';candidateReceipt=$CandidateReceipt;
  candidateSHA256=(Hash $CandidateReceipt);liveWrites=0;dispatched=$false;
  next='Existing reviewed backup -> updater Prepare -> independent READY -> consumed drain -> updater Apply'
 })
 @{status='VALIDATED_NOT_ACTIVE';candidateReceipt=$CandidateReceipt;
   candidateSHA256=(Hash $CandidateReceipt);liveWrites=0;dispatched=$false}|ConvertTo-Json -Compress
 exit
}
if(!$StageReceipt){throw 'Original uninstalled owner stage receipt required'}
$stage=Read $StageReceipt
$registryHash=Hash $registryFile;$configHash=Hash $configFile;$profileHash=Hash $profileFile
$registry=Read $registryFile;$config=Read $configFile
if($stage.owner -cne $env:CODEX_THREAD_ID -or $stage.status -cne 'STAGED_NOT_INSTALLED' -or
   $stage.baseline -cne $registry.components.workspace.releaseRoot -or
   $stage.backend -ceq $stage.baseline){throw 'Exact staged owner generation required'}
if($UpdateInstalledProvider){
 $providerRelative='components/workspace-mcp/gpt-queue-provider.mjs'
 $delta=@($providerRelative,'.aicc-release.json','workspace-drive-manifest.json')
 if($stage.overlayMode -cne 'installed-provider-only' -or
    -not (Same @($stage.actualChangedFiles|Sort-Object) @($delta|Sort-Object)) -or
    $config.gptQueue.enabled -cne $true -or
    $config.gptQueue.bindingFile -cne $ownerBinding -or
    $config.gptQueue.bindingSha256 -cne $prepared.bindingSha256 -or
    $stage.installedConfigSHA256 -cne $configHash -or
    $stage.baselineProviderSHA256 -cne (Hash (Join-Path $stage.baseline $providerRelative)) -or
    $stage.desiredProviderSHA256 -cne (Hash (Join-Path $stage.backend $providerRelative)) -or
    $stage.installedReleaseSHA256 -cne (Hash (Join-Path $stage.baseline '.aicc-release.json')) -or
    $stage.installedDriveManifestSHA256 -cne (Hash (Join-Path $stage.baseline 'workspace-drive-manifest.json'))){
  throw 'HOLD_QUEUE_PROVIDER_ONLY_STAGE_CAS_OR_OWNER_MISMATCH'
 }
}elseif($config.gptQueue -or ($stage.overlayMode -and $stage.overlayMode -cne 'initial-install')){
 throw 'Original uninstalled owner generation required'
}
$verifier=Join-Path $PSScriptRoot 'Verify-AiccGptQueueRuntime.mjs'
$verified=& $registry.components.workspace.runtime $verifier (Regular $StageReceipt)
if($LASTEXITCODE -ne 0 -or !$verified){throw 'Staged queue verification failed'}
$verified=$verified|ConvertFrom-Json -AsHashtable -DateKind String
if($verified.ok -cne $true -or $verified.receiptSha256 -cne (Hash $StageReceipt) -or
   $verified.liveConfigWrites -ne 0 -or $verified.toolCalls -ne 0){throw 'Exact staged verification required'}
$oldGateway=$registry.components['unified-mcp'].releaseRoot
$graph=Read (Join-Path $oldGateway 'config.json')
$oldManifest=Read (Join-Path $oldGateway 'manifest.json')
if((Hash (Join-Path $oldGateway 'config.json')) -cne $oldManifest.files['config.json']){throw 'Original gateway manifest provenance requires reconciliation'}
$gateway=Join-Path $stateRoot ('releases/unified-mcp/gpt-queue-'+(Hash $StageReceipt).Substring(0,12)+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
$after=Read $configFile
if(-not $UpdateInstalledProvider){
 $after.gptQueue=@{enabled=$true;bindingFile=$ownerBinding;bindingSha256=$prepared.bindingSha256}
}
$null=New-Item -ItemType Directory -Path $OperationDirectory
New-Text (Join-Path $OperationDirectory 'prepare.intent.json') (Json @{kind='workspace-gpt-queue-deployment-preparation/v1';owner=$env:CODEX_THREAD_ID;stage=(Regular $StageReceipt);ownerPrepared=(Regular $OwnerPreparedReceipt);gateway=$gateway;liveWrites=0})
Copy-Item -LiteralPath $configFile -Destination (Join-Path $OperationDirectory 'workspace-config.before.json')
$desired=Join-Path $OperationDirectory 'workspace-config.desired.json'
if($UpdateInstalledProvider){Copy-Item -LiteralPath $configFile -Destination $desired}else{New-Text $desired (Json $after)}
if($UpdateInstalledProvider -and (Hash $desired) -cne $configHash){throw 'HOLD_QUEUE_PROVIDER_ONLY_CONFIG_BYTE_DRIFT'}
$workspace=@($graph.providers|Where-Object id -CEQ 'workspace')
if($workspace.Count -ne 1){throw 'Exact Workspace provider required'}
$workspace=$workspace[0];$prefix=$stage.baseline.TrimEnd('\')+'\'
$priorToolHash=$workspace.toolHash;$priorToolNames=@($workspace.toolNames)
if($UpdateInstalledProvider){
 $existingPin=Join-Path $stage.baseline 'components/workspace-mcp/gpt-queue-provider.mjs'
 $matched=@($workspace.files|Where-Object path -IEQ $existingPin)
 if($matched.Count -ne 1 -or $matched[0].sha256 -cne $stage.baselineProviderSHA256){
  throw 'HOLD_PROVIDER_UPDATE_INSTALLED_TOOL_PIN_UNKNOWN'
 }
}
foreach($pin in $workspace.files){
 if($pin.path -ieq $configFile){$pin.sha256=Hash $desired}
 elseif($pin.path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$pin.path=Join-Path $stage.backend $pin.path.Substring($prefix.Length);$pin.sha256=Hash $pin.path}
}
$workspace.entrypoint=$workspace.entrypoint.Replace($stage.baseline,$stage.backend)
$workspace.args=@($workspace.args|ForEach-Object {if($_ -is [string] -and $_.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$stage.backend+$_.Substring($stage.baseline.Length)}else{$_}})
$queueModule=Join-Path $stage.backend 'components/workspace-mcp/gpt-queue-provider.mjs'
if($UpdateInstalledProvider){
 $pins=@($workspace.files|Where-Object path -IEQ $queueModule)
 if($pins.Count -ne 1 -or $pins[0].sha256 -cne (Hash $queueModule)){
  throw 'HOLD_PROVIDER_UPDATE_REPIN_NOT_EXACT'
 }
}else{
 $workspace.files+=@{path=$queueModule;sha256=(Hash $queueModule)}
}
$contractScript=@'
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const [root,file]=process.argv.slice(1),c=JSON.parse(fs.readFileSync(file,'utf8'));
const load=p=>import(pathToFileURL(path.join(root,p)).href);
const {createWorkspaceMcpServer}=await load('components/workspace-mcp/server.mjs');
const {Client}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {InMemoryTransport}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
const runtimeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-queue-actual-contract-'));
const server=createWorkspaceMcpServer(c,{runtimeRoot,remoteAuthority:{reconcileStartup(){}}});
const client=new Client({name:'queue-deployment-contract',version:'1.0.0'});
const [st,ct]=InMemoryTransport.createLinkedPair();
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
try{
 await server.connect(st);await client.connect(ct);
 const tools=[];let cursor;const seen=new Set();
 do{const page=await client.listTools(cursor?{cursor}:{});tools.push(...page.tools);cursor=page.nextCursor;if(cursor&&(seen.has(cursor)||seen.size>=20))throw Error('Incomplete queue tool contract');if(cursor)seen.add(cursor);}while(cursor);
 const hash=createHash('sha256').update(JSON.stringify(canonical([...tools].sort((a,b)=>a.name.localeCompare(b.name))))).digest('hex');
 process.stdout.write(JSON.stringify({hash,tools,toolCalls:0,leasesOpened:0,temporaryDirectory:runtimeRoot}));
}finally{await client.close();await server.close();}
'@
$contract=& $registry.components.workspace.runtime --input-type=module -e $contractScript $stage.backend $desired
if($LASTEXITCODE -ne 0 -or !$contract){throw 'Desired queue tool contract unavailable'}
$contract=$contract|ConvertFrom-Json -AsHashtable
if($UpdateInstalledProvider -and
  ($contract.hash -cne $priorToolHash -or
   -not (Same @($priorToolNames|Sort-Object) @($contract.tools.name|Sort-Object)))){
 throw 'HOLD_PROVIDER_UPDATE_SCHEMA_OR_TOOL_HASH_CHANGED'
}
$workspace.toolHash=$contract.hash;$workspace.toolNames=@($contract.tools.name)
$null=New-Item -ItemType Directory -Path $gateway
New-Text (Join-Path $gateway 'config.json') (Json $graph)
Copy-Item -LiteralPath (Join-Path $oldGateway 'gateway.cjs') -Destination (Join-Path $gateway 'gateway.cjs')
$oldManifest.files['config.json']=Hash (Join-Path $gateway 'config.json');$oldManifest.releaseHash=$oldManifest.files['config.json']
New-Text (Join-Path $gateway 'manifest.json') (Json $oldManifest)
$profileText=[IO.File]::ReadAllText($profileFile)
$spellings=@(@($oldGateway,$oldGateway.Replace('\','/'),$oldGateway.Replace('\','\\'))|Select-Object -Unique|Where-Object {$profileText.Contains($_)})
if($spellings.Count -ne 1 -or $profileText.Split([string[]]@($spellings[0]),[StringSplitOptions]::None).Count -ne 3){throw 'Exact two profile bindings required'}
$spelling=$spellings[0];$replacement=if($spelling -ceq $oldGateway){$gateway}elseif($spelling -ceq $oldGateway.Replace('\','/')){$gateway.Replace('\','/')}else{$gateway.Replace('\','\\')}
$profileDesired=Join-Path $OperationDirectory 'workspace-profile.desired.yaml'
New-Text $profileDesired ($profileText.Replace($spelling,$replacement))
$CandidateReceipt=Join-Path $OperationDirectory 'candidate.json'
$candidate=@{schemaVersion=1;kind='workspace-gpt-queue-update';status='PREPARED_NOT_ACTIVE';baseline=$stage.baseline;backend=$stage.backend;oldGateway=$oldGateway;gateway=$gateway;configFile=$configFile;profile=$profileFile;configBeforeSHA256=$configHash;configDesiredFile=$desired;configDesiredSHA256=(Hash $desired);profileBeforeSHA256=$profileHash;profileDesiredFile=$profileDesired;profileDesiredSHA256=(Hash $profileDesired);bindingFile=$config.webManagement.bindingFile;bindingSHA256=$config.webManagement.bindingSha256;gatewayConfigSHA256=(Hash (Join-Path $gateway 'config.json'));oldGatewayConfigSHA256=(Hash (Join-Path $oldGateway 'config.json'));oldGatewayManifestSHA256=(Hash (Join-Path $oldGateway 'manifest.json'));changedFiles=$stage.changedFiles;toolHash=$contract.hash;queueStageFile=(Regular $StageReceipt);queueStageSHA256=(Hash $StageReceipt);queueVerifierFile=$verifier;queueVerifierSHA256=(Hash $verifier);queueOwnerPreparedFile=(Regular $OwnerPreparedReceipt);queueOwnerPreparedSHA256=$ExpectedOwnerPreparedSha256;gptQueueRecovery=@{registrySHA256=$registryHash;inventoryBeforeFile=(Join-Path (Split-Path $StageReceipt -Parent) 'inventory.before.json');inventoryBeforeSHA256=$stage.inventoryBeforeSha256}}
if($UpdateInstalledProvider){
 $candidate.queueProviderOnlyUpdate=$true
 if($stage.baselineReconciliation){$candidate.queueProviderBaselineReconciliation=$stage.baselineReconciliation}
 $candidate.changedFiles=@($stage.actualChangedFiles)
 $candidate.queueProviderUpdatePins=@{
  installedConfigSHA256=$stage.installedConfigSHA256;
  baselineProviderSHA256=$stage.baselineProviderSHA256;
  desiredProviderSHA256=$stage.desiredProviderSHA256;
  installedReleaseSHA256=$stage.installedReleaseSHA256;
  installedDriveManifestSHA256=$stage.installedDriveManifestSHA256;
  runtimeIntegritySHA256=(Hash (Join-Path $stage.baseline 'components/workspace-mcp/runtime-integrity.mjs'))
 }
}
New-Text $CandidateReceipt (Json $candidate)
Validate-Candidate $candidate
if((Hash $registryFile) -cne $registryHash -or (Hash $configFile) -cne $configHash -or (Hash $profileFile) -cne $profileHash){throw 'Installed preimage changed during preparation'}
New-Text (Join-Path $OperationDirectory 'prepared.json') (Json @{status='VALIDATED_NOT_ACTIVE';candidateReceipt=$CandidateReceipt;candidateSHA256=(Hash $CandidateReceipt);liveWrites=0;dispatched=$false;next='Reviewed two-destination backup, existing updater Prepare, fresh independent READY and consumed drain, Apply and actual Chat tool readback'})
@{status='VALIDATED_NOT_ACTIVE';candidateReceipt=$CandidateReceipt;candidateSHA256=(Hash $CandidateReceipt);liveWrites=0;dispatched=$false}|ConvertTo-Json -Compress
