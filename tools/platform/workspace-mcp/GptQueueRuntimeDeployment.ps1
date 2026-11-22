# Queue-only extension of the existing managed Workspace updater. This helper
# does not stop, launch, register, or write a service. All cutover and rollback
# operations stay in Update-AiccWebManagementRuntime with READY and drain gates.
# Accept only fixed enum diagnostic; never print command/stdout/stderr/lease bytes.
function Assert-GptQueueIssuerDiagnostic($Result){
 if($null -ne $Result -and $Result.ok -ceq $false){
  $code=[string]$Result.diagnosticCode
  if($code -cnotmatch '^QUEUE_CURRENT_ISSUER_(TARGET_CLOSED_OR_UNPROVEN|LEASE_EXPIRED|LEASE_UNPROVEN|LEASE_CHANGED|IDENTITY_HOLD|ARGUMENTS_HOLD|INSPECT_UNPROVEN|INSPECT_NONZERO|INSPECT_MALFORMED|INSPECT_TIMEOUT|INSPECT_LAUNCH_FAILED|INSPECT_OVERFLOW|TARGET_MISMATCH|STALE|ROLE_MISMATCH|REQUEST_MISMATCH|DEFINITION_MISMATCH|CONTRACT_INVALID|PRIVATE_FILE_REQUIRED|REQUEST_BOUNDARY|EXECUTABLE_BOUNDARY)$'){
   throw 'QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN'
  }
  throw $code
 }
}
function Assert-GptQueueTargetProofFreshness($Binding,[DateTimeOffset]$Now=[DateTimeOffset]::UtcNow){
 if(@($Binding.targets).Count -ne 2 -or (@($Binding.targets.slot) -join ',') -cne '9222,9223'){throw 'Original two-target queue proof required'}
 foreach($target in $Binding.targets){
  if((Hash $target.proofFile) -cne $target.proofSha256){throw 'Original target proof changed'}
  $proof=Read $target.proofFile
  if($proof.kind -cne 'aicc-queue-exact-target-proof' -or $proof.state -cne 'OWNED_ACTIVE' -or
     $proof.bindingId -cne $Binding.bindingId -or $proof.ownerId -cne $Binding.ownerId -or
     $proof.originalRequestSha256 -cne $Binding.originalRequestSha256 -or
     $proof.ownerIdentityHash -cne $Binding.ownerIdentityHash){throw 'Original queue proof owner changed'}
  foreach($key in @('slot','targetId','targetNonce','conversationId','originalLeaseSha256','accountAlias','accountIdentityHash','workspaceIdentityHash')){
   if(-not $target.Contains($key) -or -not $proof.Contains($key) -or $target[$key] -cne $proof[$key]){throw 'Original queue target proof differs'}
  }
  try{$observed=[DateTimeOffset]::Parse($proof.observedAt);$expires=[DateTimeOffset]::Parse($proof.expiresAt)}catch{throw 'Fresh queue owner proof required'}
  if($observed -gt $Now -or $expires -le $observed -or ($expires-$observed).TotalSeconds -gt 180){throw 'Fresh queue owner proof required; invalid historical observation'}
  # A current-issuer contract preserves this historical evidence and MUST be
  # consumed after the expensive inventory checks below. Legacy bindings still
  # require a currently unexpired immutable proof.
  if(-not $Binding.currentIssuer -and (($Now-$observed).TotalSeconds -gt 120 -or $expires -le $Now)){throw 'Fresh queue owner proof required; reacquire exact owner targets before deployment'}
 }
}
# Upgrade the immutable issuer *generation*, never patch an installed helper.
# Both previous and new helper/guard pairs remain hash-pinned; the new pair
# must be byte-identical to the reviewed sibling source files in open-AICC.
function Assert-GptQueueIssuerHelperUpgrade($Previous,$Next,$Prepared,[bool]$Enabled){
 if(-not $Enabled){
  if($Next.issuerHelperUpgrade -or $Prepared.issuerHelperUpgrade){
   throw 'HOLD_ISSUER_HELPER_UPGRADE_EXPLICIT_MODE_REQUIRED'
  }
  return
 }
 $old=$Previous.currentIssuer;$new=$Next.currentIssuer
 $pin=$Next.issuerHelperUpgrade
 if(-not $old -or -not $new -or -not $pin -or
    -not (Same $pin $Prepared.issuerHelperUpgrade) -or
    $pin.kind -cne 'aicc-queue-current-issuer-helper-upgrade/v1' -or
    $pin.requiredArgument -cne 'QueueOwnerRequestFile' -or
    $pin.targetLifecycle -cne 'queue-owner-keep-target-before-registration/v1' -or
    $Next.targetLifecycle -cne $pin.targetLifecycle -or
    $old.kind -cne 'registered-cdp-current-issuer/v1' -or $new.kind -cne $old.kind -or
    $old.powershellFile -cne $new.powershellFile -or
    $old.powershellSha256 -cne $new.powershellSha256 -or
    $old.requestSha256 -cne $Previous.originalRequestSha256 -or
    $new.requestSha256 -cne $Next.originalRequestSha256){
  throw 'HOLD_ISSUER_HELPER_UPGRADE_OWNER_OR_MODE_CHANGED'
 }
 $required=@('kind','previousHelperSha256','previousGuardSha256',
  'nextHelperSha256','nextGuardSha256','sourceHelperFile','sourceHelperSha256',
  'sourceGuardFile','sourceGuardSha256','powershellSha256',
  'requiredArgument','targetLifecycle')
 if(-not (Same @($pin.Keys|Sort-Object) @($required|Sort-Object))){
  throw 'HOLD_ISSUER_HELPER_UPGRADE_METADATA_SCHEMA_CHANGED'
 }
 $sourceHelper=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../web-automation/Manage-CdpChromeSlotLease.ps1'))
 $sourceGuard=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../web-automation/Assert-CdpEndpointIdentity.ps1'))
 if([IO.Path]::GetFullPath([string]$pin.sourceHelperFile) -ine $sourceHelper -or
    [IO.Path]::GetFullPath([string]$pin.sourceGuardFile) -ine $sourceGuard -or
    $pin.previousHelperSha256 -cne $old.helperSha256 -or
    $pin.previousGuardSha256 -cne $old.identityGuardSha256 -or
    $pin.nextHelperSha256 -cne $new.helperSha256 -or
    $pin.nextGuardSha256 -cne $new.identityGuardSha256 -or
    $pin.sourceHelperSha256 -cne $new.helperSha256 -or
    $pin.sourceGuardSha256 -cne $new.identityGuardSha256 -or
    $pin.powershellSha256 -cne $old.powershellSha256 -or
    $old.helperSha256 -ceq $new.helperSha256){
  throw 'HOLD_ISSUER_HELPER_UPGRADE_PROVENANCE_OR_PIN_CHANGED'
 }
 $pairs=@(@($old.helperFile,$old.helperSha256),@($old.identityGuardFile,$old.identityGuardSha256),
  @($new.helperFile,$new.helperSha256),@($new.identityGuardFile,$new.identityGuardSha256),
  @($new.powershellFile,$new.powershellSha256),
  @($sourceHelper,$pin.sourceHelperSha256),@($sourceGuard,$pin.sourceGuardSha256))
 foreach($pair in $pairs){
  if([string]$pair[1] -cnotmatch '^[a-f0-9]{64}$' -or
     (Hash (Regular $pair[0])) -cne [string]$pair[1]){
   throw 'HOLD_ISSUER_HELPER_UPGRADE_IMMUTABLE_BYTES_CHANGED'
  }
 }
 foreach($issuer in @($old,$new)){
  if((Split-Path $issuer.helperFile -Parent) -ine (Split-Path $issuer.identityGuardFile -Parent) -or
     (Split-Path $issuer.helperFile -Leaf) -cne 'Manage-CdpChromeSlotLease.ps1' -or
     (Split-Path $issuer.identityGuardFile -Leaf) -cne 'Assert-CdpEndpointIdentity.ps1'){
   throw 'HOLD_ISSUER_HELPER_UPGRADE_SIBLING_GUARD_REQUIRED'
  }
 }
 $token=$null;$errors=$null
 $ast=[Management.Automation.Language.Parser]::ParseFile($new.helperFile,[ref]$token,[ref]$errors)
 if(@($errors).Count -ne 0 -or -not $ast.ParamBlock -or
    @($ast.ParamBlock.Parameters|Where-Object {
      $_.Name.VariablePath.UserPath -ceq 'QueueOwnerRequestFile'
    }).Count -ne 1 -or
    @($ast.FindAll({param($node)
      $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -ceq 'Get-QueueOriginalRequestBinding'
    },$true)).Count -ne 1 -or
    @($ast.FindAll({param($node)
      $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -ceq 'Write-KeepTargetHistory'
    },$true)).Count -ne 1 -or
    $ast.Extent.Text -cnotmatch 'QueueOwnerInspect'){
   throw 'HOLD_ISSUER_HELPER_REQUIRED_ARGUMENT_UNSUPPORTED'
 }
}
function Assert-GptQueueProviderOnlyStage($Candidate,$Stage){
 $provider='components/workspace-mcp/gpt-queue-provider.mjs'
 $runtime='components/workspace-mcp/runtime-integrity.mjs'
 $allowed=@($provider,'.aicc-release.json','workspace-drive-manifest.json')
 $pins=$Candidate.queueProviderUpdatePins
 if($Stage.overlayMode -cne 'installed-provider-only' -or
    -not (Same @($Stage.actualChangedFiles|Sort-Object) @($allowed|Sort-Object)) -or
    -not (Same @($Candidate.changedFiles|Sort-Object) @($allowed|Sort-Object)) -or
    $Stage.installedConfigSHA256 -cne $pins.installedConfigSHA256 -or
    $Stage.baselineProviderSHA256 -cne $pins.baselineProviderSHA256 -or
    $Stage.desiredProviderSHA256 -cne $pins.desiredProviderSHA256 -or
    $Stage.installedReleaseSHA256 -cne $pins.installedReleaseSHA256 -or
    $Stage.installedDriveManifestSHA256 -cne $pins.installedDriveManifestSHA256 -or
    $Candidate.configBeforeSHA256 -cne $pins.installedConfigSHA256 -or
    ($Candidate.queueCombinedIssuerProviderUpdate -cne $true -and $Candidate.configDesiredSHA256 -cne $pins.installedConfigSHA256) -or
    $Candidate.backend -ceq $Candidate.baseline){
  throw 'HOLD_PROVIDER_UPDATE_EXPLICIT_STAGE_OR_CONFIG_CAS'
 }
 if((Hash (Join-Path $Candidate.baseline $provider)) -cne $pins.baselineProviderSHA256 -or
    (Hash (Join-Path $Candidate.backend $provider)) -cne $pins.desiredProviderSHA256 -or
    $pins.baselineProviderSHA256 -ceq $pins.desiredProviderSHA256 -or
    (Hash (Join-Path $Candidate.baseline $runtime)) -cne $pins.runtimeIntegritySHA256 -or
    (Hash (Join-Path $Candidate.backend $runtime)) -cne $pins.runtimeIntegritySHA256 -or
    (Hash (Join-Path $Candidate.baseline '.aicc-release.json')) -cne $pins.installedReleaseSHA256 -or
    (Hash (Join-Path $Candidate.baseline 'workspace-drive-manifest.json')) -cne $pins.installedDriveManifestSHA256){
  throw 'HOLD_PROVIDER_UPDATE_BASELINE_RUNTIME_INTEGRITY_OR_RELEASE_CAS'
 }
 $release=Read (Join-Path $Candidate.baseline '.aicc-release.json')
 $drive=Read (Join-Path $Candidate.baseline 'workspace-drive-manifest.json')
 $oldProviderRows=@($release.files|Where-Object path -CEQ $provider)
 if($oldProviderRows.Count -ne 1 -or
    $oldProviderRows[0].sha256 -cne $pins.baselineProviderSHA256 -or
    $drive.files[$provider] -cne $pins.baselineProviderSHA256 -or
    $release.gptQueueOverlay.kind -cne 'workspace-gpt-queue-overlay/v1'){
  throw 'HOLD_PROVIDER_UPDATE_ORIGINAL_MANIFEST_PIN_UNPROVEN'
 }
 $receiptDir=Split-Path $Candidate.queueStageFile -Parent
 $oldRows=@(Read (Join-Path $receiptDir 'inventory.before.json'))
 $newRows=@(Read (Join-Path $receiptDir 'inventory.desired.json'))
 if((Hash (Join-Path $receiptDir 'inventory.before.json')) -cne $Stage.inventoryBeforeSha256 -or
    (Hash (Join-Path $receiptDir 'inventory.desired.json')) -cne $Stage.inventoryDesiredSha256 -or
    $oldRows.Count -ne $newRows.Count -or $oldRows.Count -eq 0){
  throw 'HOLD_PROVIDER_UPDATE_INVENTORY_CAS'
 }
 $beforeMap=@{}
 foreach($row in $oldRows){
  if(!$row.path -or $beforeMap.ContainsKey($row.path)){throw 'HOLD_PROVIDER_UPDATE_DUPLICATE_INVENTORY'}
  $beforeMap[$row.path]=$row
 }
 $actual=@()
 foreach($row in $newRows){
  if(!$row.path -or -not $beforeMap.ContainsKey($row.path)){throw 'HOLD_PROVIDER_UPDATE_UNREVIEWED_FILE'}
  $old=$beforeMap[$row.path]
  if((Hash (Join-Path $Candidate.baseline $row.path)) -cne $old.sha256 -or
     (Hash (Join-Path $Candidate.backend $row.path)) -cne $row.sha256 -or
     (Get-Item -LiteralPath (Join-Path $Candidate.baseline $row.path)).Length -ne $old.size -or
     (Get-Item -LiteralPath (Join-Path $Candidate.backend $row.path)).Length -ne $row.size){
   throw 'HOLD_PROVIDER_UPDATE_INVENTORY_BYTES_CHANGED'
  }
  if($old.sha256 -cne $row.sha256){$actual+=,$row.path}
  $null=$beforeMap.Remove($row.path)
 }
 if($beforeMap.Count -ne 0 -or -not (Same @($actual|Sort-Object) @($allowed|Sort-Object))){
  throw 'HOLD_PROVIDER_UPDATE_EXACT_THREE_FILE_DELTA_REQUIRED'
 }
 if($Stage.baselineReconciliation){
  $reconcile=$Stage.baselineReconciliation
  if(-not (Same $reconcile $Candidate.queueProviderBaselineReconciliation) -or
     $reconcile.kind -cne 'workspace-provider-baseline-reconciliation/v1' -or
     $reconcile.path -cne 'components/workspace-mcp/web-management-provider.mjs' -or
     $reconcile.baseline -cne $Candidate.baseline -or
     $reconcile.mismatchCount -ne 1 -or
     $reconcile.sourceOwnerVerified -cne $true -or
     $reconcile.operatingWrites -ne 0 -or
     $reconcile.originalReleaseSHA256 -cne $pins.installedReleaseSHA256 -or
     $reconcile.originalDriveSHA256 -cne $pins.installedDriveManifestSHA256 -or
     $reconcile.registryFile -cne $registryFile -or
     (Hash $reconcile.registryFile) -cne $reconcile.registrySHA256 -or
     (Hash $reconcile.graphConfigFile) -cne $reconcile.graphConfigSHA256 -or
     (Hash $reconcile.graphManifestFile) -cne $reconcile.graphManifestSHA256 -or
     (Hash $reconcile.priorReceiptFile) -cne $reconcile.priorReceiptSHA256 -or
     (Hash $reconcile.priorPreparedFile) -cne $reconcile.priorPreparedSHA256 -or
     (Hash $reconcile.sealedInventoryFile) -cne $reconcile.sealedInventorySHA256){
   throw 'HOLD_PROVIDER_BASELINE_RECONCILIATION_CAS_OR_RECEIPT_DRIFT'
  }
  $registered=Read $reconcile.registryFile
  $registeredGraph=Read $reconcile.graphConfigFile
  $workspace=@($registeredGraph.providers|Where-Object id -CEQ 'workspace')
  $target=Join-Path $Candidate.baseline $reconcile.path
  $graphPin=@($workspace[0].files|Where-Object path -IEQ $target)
  $receipt=Read $reconcile.priorReceiptFile
  $prepared=Read $reconcile.priorPreparedFile
  $stageRelease=Read (Join-Path $Candidate.backend '.aicc-release.json')
  $stageDrive=Read (Join-Path $Candidate.backend 'workspace-drive-manifest.json')
  if($registered.components.workspace.releaseRoot -cne $Candidate.baseline -or
     $registered.components['unified-mcp'].releaseRoot -cne (Split-Path $reconcile.graphConfigFile -Parent) -or
     $registeredGraph.hostControl -cne 'task-owned-v1' -or
     (@($registeredGraph.providers.id|Sort-Object) -join ',') -cne 'host,native,workspace' -or
     $workspace.Count -ne 1 -or $graphPin.Count -ne 1 -or
     $graphPin[0].sha256 -cne $reconcile.actualFileSHA256 -or
     (Hash $target) -cne $reconcile.actualFileSHA256 -or
     $receipt.backend -cne $Candidate.baseline -or
     $receipt.gptQueueRecovery.inventoryBeforeSHA256 -cne $reconcile.sealedInventorySHA256 -or
     $prepared.candidateSHA256 -cne $reconcile.priorReceiptSHA256 -or
     -not (Same $stageRelease.gptQueueOverlay.baselineReconciliation $reconcile) -or
     -not (Same $stageDrive.gptQueueOverlay.baselineReconciliation $reconcile)){
   throw 'HOLD_PROVIDER_BASELINE_RECONCILIATION_REGISTERED_SOURCE_OR_STAGE_PROOF'
  }
 }elseif($Candidate.queueProviderBaselineReconciliation){
  throw 'HOLD_PROVIDER_BASELINE_RECONCILIATION_UNREQUESTED'
 }
}
function Assert-GptQueueRuntimeCandidate($Candidate,$Before,$After){
 if($Candidate.kind -cne 'workspace-gpt-queue-update' -or $Before.surfaceProfile -cne 'business-full'){throw 'Exact business-full queue update required'}
 if($null -ne $Candidate.queueProviderOnlyUpdate -and $Candidate.queueProviderOnlyUpdate -cne $true){
  throw 'HOLD_PROVIDER_UPDATE_MODE_NOT_BOOLEAN'
 }
 $providerOnly=$Candidate.queueProviderOnlyUpdate -ceq $true
 if($Candidate.bindingFile -cne $Before.webManagement.bindingFile -or $Candidate.bindingSHA256 -cne $Before.webManagement.bindingSha256){throw 'Queue update must preserve manager binding'}
 $expected=Read (Join-Path (Split-Path $CandidateReceipt -Parent) 'workspace-config.before.json')
 if($providerOnly){
  if(-not $expected.gptQueue -or
     -not (Same $expected $Before) -or -not (Same $Before $After)){
   throw 'HOLD_PROVIDER_UPDATE_MUST_PRESERVE_INSTALLED_OWNER_CONFIG'
  }
 }elseif($expected.gptQueue){throw 'Existing queue binding requires a separate explicit replacement operation'}
 if($After.gptQueue.enabled -cne $true -or @($After.gptQueue.Keys).Count -ne 3 -or
    -not $After.gptQueue.bindingFile -or (Hash $After.gptQueue.bindingFile) -cne $After.gptQueue.bindingSha256){throw 'Exact pinned owner queue binding required'}
 if(-not $providerOnly){$expected.gptQueue=$After.gptQueue}
 if(-not (Same $expected $After)){throw 'Queue update changes unrelated owner configuration'}
 $binding=Read $After.gptQueue.bindingFile
 Assert-GptQueueTargetProofFreshness $binding
 if($binding.kind -cne 'aicc-gpt-queue-owner-binding' -or $binding.schemaVersion -ne 1 -or
    @($After.workspaces|Where-Object {$_.alias -ceq $binding.workspaceAlias -and $_.root -ceq $binding.workspaceRoot}).Count -ne 1){throw 'Exact registered queue workspace required'}
 $prepared=Read $Candidate.queueOwnerPreparedFile
 if((Hash $Candidate.queueOwnerPreparedFile) -cne $Candidate.queueOwnerPreparedSHA256 -or
    $prepared.kind -cne 'aicc-gpt-queue-owner-prepared' -or $prepared.bindingSha256 -cne $After.gptQueue.bindingSha256 -or
    $prepared.originalRequestSha256 -cne $binding.originalRequestSha256 -or $prepared.ownerIdentityHash -cne $binding.ownerIdentityHash -or
    $prepared.inspectedTargets -ne 2 -or $prepared.originalRequestDispatched -cne $false){throw 'Original owner preparation receipt differs'}
 foreach($pair in @(@($binding.nativeExecutable,$binding.nativeExecutableSha256),@($binding.nativeConfig,$binding.nativeConfigSha256),@($binding.nativeManifest,$binding.nativeManifestSha256))){if((Hash $pair[0]) -cne $pair[1]){throw 'Installed native queue pins changed'}}
 $nativeKey='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.agenticfabworks.webgpt_queue'
 if([string](Get-ItemProperty -LiteralPath $nativeKey).'(default)' -cne $binding.nativeManifest){throw 'Registered native queue release changed'}
 foreach($target in $binding.targets){if((Hash $target.proofFile) -cne $target.proofSha256){throw 'Original target proof changed'}}
 if(@($binding.targets).Count -ne 2 -or (@($binding.targets.slot) -join ',') -cne '9222,9223'){throw 'Original two-target binding required'}
 $stage=Read $Candidate.queueStageFile
 if((Hash $Candidate.queueStageFile) -cne $Candidate.queueStageSHA256 -or $stage.owner -cne $env:CODEX_THREAD_ID -or
    $stage.baseline -cne $Candidate.baseline -or $stage.backend -cne $Candidate.backend){throw 'Exact reviewed queue stage required'}
 if($providerOnly){
  Assert-GptQueueProviderOnlyStage $Candidate $stage
 }elseif($stage.overlayMode -ceq 'installed-provider-only'){
  throw 'HOLD_PROVIDER_UPDATE_REQUIRES_EXPLICIT_CANDIDATE_MODE'
 }
 if((Hash $Candidate.queueVerifierFile) -cne $Candidate.queueVerifierSHA256){throw 'Queue verifier changed'}
 $registry=Read $registryFile
 if($registry.components.workspace.releaseRoot -cne $Candidate.baseline -or $registry.components['unified-mcp'].releaseRoot -cne $Candidate.oldGateway){throw 'Queue installed generation changed'}
 $verification=& $registry.components.workspace.runtime $Candidate.queueVerifierFile $Candidate.queueStageFile
 if($LASTEXITCODE -ne 0 -or !$verification){throw 'Exact queue overlay verification failed'}
 $verified=$verification|ConvertFrom-Json -AsHashtable -DateKind String
 if($verified.ok -cne $true -or $verified.closureVerified -cne $true -or $verified.manifestsPreserved -cne $true -or
    $verified.receiptSha256 -cne $Candidate.queueStageSHA256 -or $verified.toolCalls -ne 0 -or $verified.leasesOpened -ne 0){throw 'Queue candidate contract differs'}
 $prefix=$Candidate.baseline.TrimEnd('\')+'\'
 $expectedGateway=Read (Join-Path $Candidate.oldGateway 'config.json');$gateway=Read (Join-Path $Candidate.gateway 'config.json')
 if((@($expectedGateway.providers.id|Sort-Object)-join ',') -cne 'host,native,workspace' -or
    $expectedGateway.hostControl -cne 'task-owned-v1'){throw 'Exact three-provider graph required'}
 $workspace=@($expectedGateway.providers|Where-Object id -CEQ 'workspace')[0]
 $priorToolHash=$workspace.toolHash;$priorToolNames=@($workspace.toolNames)
 foreach($pin in $workspace.files){
  if($pin.path -ieq $configFile){$pin.sha256=$Candidate.configDesiredSHA256}
  elseif($pin.path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$pin.path=Join-Path $Candidate.backend $pin.path.Substring($prefix.Length);$pin.sha256=Hash $pin.path}
 }
 $workspace.entrypoint=$workspace.entrypoint.Replace($Candidate.baseline,$Candidate.backend)
 $workspace.args=@($workspace.args|ForEach-Object {if($_ -is [string] -and $_.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$Candidate.backend+$_.Substring($Candidate.baseline.Length)}else{$_}})
 $queueModule=Join-Path $Candidate.backend 'components/workspace-mcp/gpt-queue-provider.mjs'
 if($providerOnly){
  $pins=@($workspace.files|Where-Object path -IEQ $queueModule)
  if($pins.Count -ne 1 -or $pins[0].sha256 -cne (Hash $queueModule)){
   throw 'HOLD_PROVIDER_UPDATE_EXISTING_TOOL_PIN_UNPROVEN'
  }
 }else{
  if($queueModule -cin @($workspace.files.path)){throw 'Duplicate queue module pin'}
  $workspace.files+=@{path=$queueModule;sha256=(Hash $queueModule)}
 }
 # Recompute the complete tool contract with the desired existing permissions.
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
 $contract=& $registry.components.workspace.runtime --input-type=module -e $contractScript $Candidate.backend $Candidate.configDesiredFile
 if($LASTEXITCODE -ne 0 -or !$contract){throw 'Desired queue tool contract unavailable'}
 $contract=$contract|ConvertFrom-Json -AsHashtable -DateKind String
 if($providerOnly -and
   ($contract.hash -cne $priorToolHash -or
    -not (Same @($priorToolNames|Sort-Object) @($contract.tools.name|Sort-Object)))){
  throw 'HOLD_PROVIDER_UPDATE_ACTUAL_TOOL_SCHEMA_CHANGED'
 }
 $workspace.toolHash=$contract.hash;$workspace.toolNames=@($contract.tools.name)
 if($Candidate.toolHash -cne $contract.hash -or -not (Same $expectedGateway $gateway)){throw 'Queue update exceeds exact Workspace path, config and five tools'}
 foreach($provider in $gateway.providers){foreach($pin in $provider.files){if($pin.path -ieq $configFile){if($provider.id -cne 'workspace' -or $pin.sha256 -cne $Candidate.configDesiredSHA256){throw 'Future queue config pin differs'}}elseif((Hash $pin.path) -cne $pin.sha256){throw 'Queue provider dependency changed'}}}
 if((Hash (Join-Path $Candidate.oldGateway 'config.json')) -cne $Candidate.oldGatewayConfigSHA256 -or
    (Hash (Join-Path $Candidate.oldGateway 'manifest.json')) -cne $Candidate.oldGatewayManifestSHA256 -or
    (Hash (Join-Path $Candidate.oldGateway 'gateway.cjs')) -cne (Hash (Join-Path $Candidate.gateway 'gateway.cjs'))){throw 'Queue gateway preimage or code changed'}
 $manifest=Read (Join-Path $Candidate.oldGateway 'manifest.json');Assert-HostOverlayProvenance $Candidate $manifest
 $manifest.files['config.json']=$Candidate.gatewayConfigSHA256;$manifest.releaseHash=$Candidate.gatewayConfigSHA256
 if(-not (Same $manifest (Read (Join-Path $Candidate.gateway 'manifest.json')))){throw 'Queue gateway metadata changed'}
 $profile=[IO.File]::ReadAllText($profileFile)
 $spellings=@(@($Candidate.oldGateway,$Candidate.oldGateway.Replace('\','/'),$Candidate.oldGateway.Replace('\','\\'))|Select-Object -Unique|Where-Object {$profile.Contains($_)})
 if($spellings.Count -ne 1 -or $profile.Split([string[]]@($spellings[0]),[StringSplitOptions]::None).Count -ne 3){throw 'Exact queue profile preimage required'}
 $spelling=$spellings[0];$replacement=if($spelling -ceq $Candidate.oldGateway){$Candidate.gateway}elseif($spelling -ceq $Candidate.oldGateway.Replace('\','/')){$Candidate.gateway.Replace('\','/')}else{$Candidate.gateway.Replace('\','\\')}
 if([IO.File]::ReadAllText($Candidate.profileDesiredFile) -cne $profile.Replace($spelling,$replacement)){throw 'Queue profile changes unrelated configuration'}
 if($Candidate.gptQueueRecovery.registrySHA256 -cne (Hash $registryFile) -or
    $Candidate.gptQueueRecovery.inventoryBeforeFile -cne (Join-Path (Split-Path $Candidate.queueStageFile -Parent) 'inventory.before.json') -or
    $Candidate.gptQueueRecovery.inventoryBeforeSHA256 -cne $stage.inventoryBeforeSha256){throw 'Queue rollback evidence differs'}
 if($binding.currentIssuer){
  $verifyCurrent=@'
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const [root,file]=process.argv.slice(1),config=JSON.parse(fs.readFileSync(file,'utf8'));
const binding=JSON.parse(fs.readFileSync(config.gptQueue.bindingFile,'utf8'));
const workspace=config.workspaces.find(w=>w.alias===binding.workspaceAlias&&w.root===binding.workspaceRoot);
if(!workspace)throw Error('Exact queue workspace missing');
const {verifyGptQueueOwnerConfig}=await import(pathToFileURL(path.join(root,'components/workspace-mcp/gpt-queue-provider.mjs')).href);
try{
  process.stdout.write(JSON.stringify(await verifyGptQueueOwnerConfig(config,workspace)));
}catch(error){
  const allowed=/^QUEUE_CURRENT_ISSUER_(?:TARGET_CLOSED_OR_UNPROVEN|LEASE_EXPIRED|LEASE_UNPROVEN|LEASE_CHANGED|IDENTITY_HOLD|ARGUMENTS_HOLD|INSPECT_UNPROVEN|INSPECT_NONZERO|INSPECT_MALFORMED|INSPECT_TIMEOUT|INSPECT_LAUNCH_FAILED|INSPECT_OVERFLOW|TARGET_MISMATCH|STALE|ROLE_MISMATCH|REQUEST_MISMATCH|DEFINITION_MISMATCH|CONTRACT_INVALID|PRIVATE_FILE_REQUIRED|REQUEST_BOUNDARY|EXECUTABLE_BOUNDARY)$/;
  const code=allowed.test(error?.code??'')?error.code:'QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN';
  process.stdout.write(JSON.stringify({ok:false,status:'HOLD',diagnosticCode:code,
    filesWritten:0,executionAuthorized:false,dispatched:false}));
}
'@
  $current=& $registry.components.workspace.runtime --input-type=module -e $verifyCurrent $Candidate.backend $Candidate.configDesiredFile
  if($LASTEXITCODE -ne 0 -or !$current){throw 'Current original queue issuer verification failed'}
  $current=$current|ConvertFrom-Json -AsHashtable -DateKind String
  Assert-GptQueueIssuerDiagnostic $current
  if($current.ok -cne $true -or $current.status -cne 'CURRENT_ORIGINAL_ISSUER_VERIFIED_READ_ONLY' -or
     $current.originalRequestSha256 -cne $binding.originalRequestSha256 -or
     $current.ownerIdentityHash -cne $binding.ownerIdentityHash -or
     $current.definitionSha256 -cne $binding.definitionSha256 -or $current.targetCount -ne 2 -or
     $current.filesWritten -ne 0 -or $current.executionAuthorized -cne $false -or $current.dispatched -cne $false){throw 'Current original queue issuer result differs'}
  if(@($current.observations).Count -ne 2 -or (@($current.observations.slot) -join ',') -cne '9222,9223'){throw 'Current original queue observations missing'}
  $now=[DateTimeOffset]::UtcNow
  foreach($observation in $current.observations){
   try{$at=[DateTimeOffset]::Parse($observation.observedAt);$expires=[DateTimeOffset]::Parse($observation.expiresAt)}catch{throw 'Current original queue observation dates invalid'}
   if($at -gt $now -or ($now-$at).TotalSeconds -gt 120 -or $expires -le $now -or $expires -le $at -or ($expires-$at).TotalSeconds -gt 120){throw 'Current original queue observations stale'}
  }
 }else{Assert-GptQueueTargetProofFreshness $binding}
}
function Get-GptQueueReplacementNativeReadback($PreviousBindingFile,$NextBindingFile,$Backend,$Runtime,$LegacyCancelReceiptFile='',$LegacyCancelReceiptSHA256=''){
 # Read-only native operations. Old and new operation IDs must never be replayed.
 $nativeReadScript=@'
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [root,oldFile,newFile,cancelFile,cancelSha]=process.argv.slice(1);
const old=JSON.parse(fs.readFileSync(oldFile,'utf8'));
const next=JSON.parse(fs.readFileSync(newFile,'utf8'));
const sha=s=>createHash('sha256').update(s).digest('hex');
const runId=b=>'gptq_'+sha(b.bindingId+'\0'+b.ownerIdentityHash).slice(0,24)+'_'+b.operationId;
const fail=s=>{throw Error(s)};
const {nativeGptQueueExchange}=await import(pathToFileURL(path.join(root,'components/workspace-mcp/gpt-queue-provider.mjs')).href);
const read=async(type,fields={})=>{
 const result=await nativeGptQueueExchange({...next,executable:next.nativeExecutable},{type,...fields});
 if(!result||typeof result.ok!=='boolean')fail('HOLD_NATIVE_RESULT_UNKNOWN');
 return result;
};
try{
 if(old.operationId===next.operationId||old.bindingId===next.bindingId||
    old.originalRequestSha256===next.originalRequestSha256)fail('HOLD_REPLACEMENT_REUSED_ORIGINAL');
 const capabilities=await read('orchestration_capabilities');
 if(!capabilities.ok||capabilities.payload?.ownerBoundActivation!==true||
    capabilities.payload?.pausedRegistration!==true||capabilities.payload?.revisionFencedCancel!==true)
   fail('HOLD_NATIVE_OWNER_ACTIVATION_UNSUPPORTED');
 const previous=await read('orchestration_get',{runId:runId(old)});
 const run=previous.ok&&previous.payload?.run;
 if(!run||run.id!==runId(old)||run.registrationOnly!==true||
    !Number.isSafeInteger(previous.payload.revision)||
    !Array.isArray(run.roles)||run.roles.length!==2||
    run.roles.some((r,i)=>r.id!==old.targets[i].roleId||r.slot!==old.targets[i].slot||
      r.targetNonce!==old.targets[i].targetNonce||r.conversationId!==old.targets[i].conversationId))
   fail('HOLD_PREVIOUS_NATIVE_RUN_UNPROVEN');
 const legacy=!Object.hasOwn(run,'ownerBinding');
 if(!legacy&&(!run.ownerBinding||run.ownerBinding.originalRequestSha256!==old.originalRequestSha256||
    run.ownerBinding.ownerIdentityHash!==old.ownerIdentityHash||
    run.ownerBinding.definitionSha256!==old.definitionSha256))fail('HOLD_PREVIOUS_NATIVE_RUN_UNPROVEN');
 if(legacy){
  // Old registration-only hosts omitted ownerBinding and zero-valued fields.
  // Accept only sealed, never-claimed cancellation, with the exact original
  // request and immutable cancellation receipt; never repair the old ledger.
  const sealed=(file,expected)=>{
   if(typeof file!=='string'||!path.isAbsolute(file)||!/^[a-f0-9]{64}$/.test(expected??''))
    fail('HOLD_LEGACY_SEALED_EVIDENCE_REQUIRED');
   for(let p=path.resolve(file);;p=path.dirname(p)){
    if(fs.lstatSync(p).isSymbolicLink())fail('HOLD_LEGACY_LINKED_EVIDENCE');
    if(p===path.dirname(p))break;
   }
   const stat=fs.statSync(file);if(!stat.isFile()||stat.size>65536)fail('HOLD_LEGACY_EVIDENCE_BOUND');
   const bytes=fs.readFileSync(file);if(sha(bytes)!==expected)fail('HOLD_LEGACY_EVIDENCE_SHA_CHANGED');
   return JSON.parse(bytes);
  };
  const request=sealed(old.currentIssuer?.requestFile,old.originalRequestSha256);
  const receipt=sealed(cancelFile,cancelSha);
  const role=r=>({id:r.id,slot:r.slot,targetNonce:r.targetNonce,conversationId:r.conversationId,prompt:r.prompt});
  if(request.kind!=='aicc-gpt-queue-original-owner-request'||request.operationId!==old.operationId||
     request.bindingId!==old.bindingId||request.ownerId!==old.ownerId||
     request.ownerIdentityHash!==old.ownerIdentityHash||request.workspaceAlias!==old.workspaceAlias||
     typeof request.workspaceRoot!=='string'||typeof old.workspaceRoot!=='string'||
     !path.isAbsolute(request.workspaceRoot)||!path.isAbsolute(old.workspaceRoot)||
     path.resolve(request.workspaceRoot)!==path.resolve(old.workspaceRoot)||
     !Array.isArray(request.roles)||request.roles.length!==2||
     sha(JSON.stringify({title:request.title,roles:request.roles.map(role)}))!==old.definitionSha256||
     sha(JSON.stringify({title:run.title,roles:run.roles.map(role)}))!==old.definitionSha256)
    fail('HOLD_LEGACY_DEFINITION_UNPROVEN');
  const forbidden=['executionAuthorized','activationRequestId','activatedAt','dispatchCount','submissionUncertain',
   'userMessageId','assistantMessageId','claimToken','workerId','claimedAt','claimExpiresAt','dispatchedAt',
   'completedAt','failedAt','errorCode','result','dispatchState'];
  if(run.status!=='cancelled'||run.paused!==true||!run.cancelledAt||
     forbidden.some(k=>Object.hasOwn(run,k))||run.roles.some((r,i)=>r.status!=='cancelled'||
      r.position!==i||r.attempt!==0||!Array.isArray(r.history)||r.history.length!==0||
      forbidden.some(k=>Object.hasOwn(r,k))))fail('HOLD_LEGACY_NOT_PRISTINE_CANCELLED');
  const final=receipt.result,prior=receipt.before;
  const receiptRoles=(x,terminal)=>Array.isArray(x?.roles)&&x.roles.length===2&&x.roles.every((r,i)=>
    r.id===old.targets[i].roleId&&r.slot===old.targets[i].slot&&r.dispatchCount===0&&
    r.submissionUncertain===false&&r.conversationRecorded===true&&r.userMessageRecorded===false&&r.assistantMessageRecorded===false&&
    r.errorCode===null&&r.structuredResult===null&&
    (terminal?r.status==='cancelled':['ready','blocked'].includes(r.status)));
  if(prior?.ok!==true||prior.operationId!==old.operationId||prior.status!=='paused'||prior.paused!==true||
     prior.registrationOnly!==true||prior.dispatchState!=='NOT_DISPATCHED'||prior.executionAuthorized!==false||
     !Number.isSafeInteger(prior.revision)||prior.revision<1||!receiptRoles(prior,false)||
     final?.ok!==true||final.operationId!==old.operationId||final.status!=='cancelled'||final.paused!==true||
     final.registrationOnly!==true||final.dispatchState!=='NOT_DISPATCHED'||final.executionAuthorized!==false||
     final.cancel!=='CANCELLED_UNSENT'||final.revision!==prior.revision+1||
     final.revision!==previous.payload.revision||!receiptRoles(final,true))fail('HOLD_LEGACY_CANCEL_RECEIPT_UNPROVEN');
 }
 if(!['cancelled','completed'].includes(run.status))fail('HOLD_PREVIOUS_OPERATION_NOT_TERMINAL');
 if(/UNKNOWN|UNCERTAIN|UNCONFIRMED/i.test(String(run.dispatchState??'')+' '+String(run.errorCode??''))||
    run.roles.some(r=>r.submissionUncertain===true||
      /UNKNOWN|UNCERTAIN|UNCONFIRMED/i.test(String(r.dispatchState??'')+' '+String(r.errorCode??''))||
      ['unknown','active','running','dispatching'].includes(r.status)))
   fail('HOLD_PREVIOUS_DISPATCH_UNKNOWN');
 if(!legacy&&run.status==='cancelled'&&run.roles.some(r=>r.dispatchCount!==0||
    r.userMessageId||r.assistantMessageId||r.claimToken||r.workerId))
   fail('HOLD_PREVIOUS_CANCEL_NOT_UNSENT');
 if(run.status==='completed'&&run.roles.some(r=>r.status!=='completed'||
    r.dispatchCount!==1||!r.userMessageId||!r.assistantMessageId))
   fail('HOLD_PREVIOUS_COMPLETION_UNPROVEN');
 const fresh=await read('orchestration_get',{runId:runId(next)});
 if(fresh.ok!==false||fresh.error!=='WEBGPT_ORCHESTRATION_RUN_NOT_FOUND')
   fail('HOLD_NEW_OPERATION_REGISTERED_OR_UNKNOWN');
 process.stdout.write(JSON.stringify({status:'PREVIOUS_TERMINAL_NEW_ABSENT',
   previousOperationId:old.operationId,previousRunId:runId(old),previousStatus:run.status,
   previousDispatchUnknown:false,nextOperationId:next.operationId,nextRunId:runId(next),
   nextRegistered:false,nativeOwnerBoundActivation:true,readOnly:true,
   ...(legacy?{previousProof:'SEALED_LEGACY_CANCELLED_UNSENT',legacyCancelReceiptSha256:cancelSha}:{} )}));
}catch(e){process.stderr.write(String(e.message).replace(/[^A-Z0-9_]/g,'').slice(0,100));process.exitCode=1;}
'@
 $result=& $Runtime --input-type=module -e $nativeReadScript $Backend $PreviousBindingFile $NextBindingFile $LegacyCancelReceiptFile $LegacyCancelReceiptSHA256
 if($LASTEXITCODE -ne 0 -or !$result){throw 'Native terminal, capabilities or new operation absence unverified'}
 $proof=$result|ConvertFrom-Json -AsHashtable -DateKind String
 if($proof.status -cne 'PREVIOUS_TERMINAL_NEW_ABSENT' -or $proof.readOnly -cne $true -or
    $proof.nextRegistered -cne $false -or $proof.previousDispatchUnknown -cne $false -or
    $proof.nativeOwnerBoundActivation -cne $true){throw 'Native replacement readback differs'}
 return $proof
}
function Get-GptQueueUnregisteredRebindNativeReadback($PreviousBindingFile,$NextBindingFile,$PreviousPreparedFile,$NextPreparedFile,$Backend,$Runtime,[bool]$UpgradeIssuerHelper=$false,$PreviousHelperSha256='',$NextHelperSha256='',$NextGuardSha256=''){
 # Separate from terminal replacement: no registered Native run is permitted.
 # The exact previous/new request and two sealed prepared receipts are read-only.
 $rebindNativeScript=@'
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [root,oldFile,nextFile,priorFile,preparedFile,upgradeFlag,
  expectedOldHelperSha,expectedNewHelperSha,expectedNewGuardSha,
  trustedSourceHelper,trustedSourceGuard]=process.argv.slice(1);
const issuerUpgrade=upgradeFlag==='true';
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=s=>{throw Error(s)};
const read=file=>{
 if(typeof file!=='string'||!path.isAbsolute(file))fail('HOLD_REBIND_SEALED_FILE_REQUIRED');
 for(let p=path.resolve(file);;p=path.dirname(p)){
  if(fs.lstatSync(p).isSymbolicLink())fail('HOLD_REBIND_SEALED_LINK_REFUSED');
  if(p===path.dirname(p))break;
 }
 const stat=fs.statSync(file);
 if(!stat.isFile()||stat.size<=0||stat.size>65536)fail('HOLD_REBIND_SEALED_FILE_BOUND');
 const raw=fs.readFileSync(file);
 return {path:path.resolve(file),sha256:sha(raw),value:JSON.parse(raw)};
};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const role=r=>({id:r.id,slot:r.slot,targetNonce:r.targetNonce,
 conversationId:r.conversationId,prompt:r.prompt});
const stableRole=r=>({id:r.id,slot:r.slot,conversationId:r.conversationId,
 prompt:r.prompt,accountAlias:r.accountAlias,browserWorkspace:r.browserWorkspace});
const installedKeys=['nativeExecutable','nativeExecutableSha256','nativeConfig',
 'nativeConfigSha256','nativeManifest','nativeManifestSha256','baseDirectory'];
try{
 const old=read(oldFile),next=read(nextFile),prior=read(priorFile),prepared=read(preparedFile);
 const a=old.value,b=next.value,p=prior.value,q=prepared.value;
 if(a.kind!=='aicc-gpt-queue-owner-binding'||b.kind!==a.kind||
    a.schemaVersion!==1||b.schemaVersion!==1||
    a.operationId!==b.operationId||a.bindingId!==b.bindingId||
    a.ownerId!==b.ownerId||a.ownerIdentityHash!==b.ownerIdentityHash||
    a.workspaceAlias!==b.workspaceAlias||a.workspaceRoot!==b.workspaceRoot||
    a.originalRequestSha256===b.originalRequestSha256||
    installedKeys.some(k=>a[k]!==b[k])||
    !a.currentIssuer||!b.currentIssuer)
  fail('HOLD_REBIND_OPERATION_OR_OWNER_CHANGED');
 const oldRequest=read(a.currentIssuer.requestFile);
 const newRequest=read(b.currentIssuer.requestFile);
 const r=oldRequest.value,s=newRequest.value;
 if(oldRequest.sha256!==a.originalRequestSha256||
    newRequest.sha256!==b.originalRequestSha256||
    a.currentIssuer.requestSha256!==oldRequest.sha256||
    b.currentIssuer.requestSha256!==newRequest.sha256||
    !same(Object.fromEntries(Object.entries(a.currentIssuer).filter(([k])=>
      !['requestFile','requestSha256',...(issuerUpgrade?[
      'helperFile','helperSha256','identityGuardFile','identityGuardSha256']:[])].includes(k))),
          Object.fromEntries(Object.entries(b.currentIssuer).filter(([k])=>
      !['requestFile','requestSha256',...(issuerUpgrade?[
      'helperFile','helperSha256','identityGuardFile','identityGuardSha256']:[])].includes(k))))||
    r.schemaVersion!==1||s.schemaVersion!==1||
    r.kind!=='aicc-gpt-queue-original-owner-request'||s.kind!==r.kind||
    !same(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='roles')),
          Object.fromEntries(Object.entries(s).filter(([k])=>k!=='roles')))||
    r.operationId!==a.operationId||r.bindingId!==a.bindingId||
    r.ownerId!==a.ownerId||r.ownerIdentityHash!==a.ownerIdentityHash||
    r.workspaceAlias!==a.workspaceAlias||path.resolve(r.workspaceRoot)!==path.resolve(a.workspaceRoot)||
    !Array.isArray(r.roles)||!Array.isArray(s.roles)||r.roles.length!==2||s.roles.length!==2||
    !Array.isArray(a.targets)||!Array.isArray(b.targets)||a.targets.length!==2||b.targets.length!==2||
    !same(r.roles.map(stableRole),s.roles.map(stableRole))||
    !same(r.roles.map(x=>x.slot),['9222','9223'])||
    sha(JSON.stringify({title:r.title,roles:r.roles.map(role)}))!==a.definitionSha256||
    sha(JSON.stringify({title:s.title,roles:s.roles.map(role)}))!==b.definitionSha256)
  fail('HOLD_REBIND_SEMANTIC_IDENTITY_OR_REQUEST_SHA_CHANGED');
 for(let i=0;i<2;i++){
  const previous=r.roles[i],current=s.roles[i],oldTarget=a.targets[i],newTarget=b.targets[i];
  if(previous.targetId===current.targetId||
     previous.leaseToken===current.leaseToken||
     previous.targetNonce===current.targetNonce||
     !/^[a-f0-9]{64}$/.test(previous.targetNonce??'')||
     !/^[a-f0-9]{64}$/.test(current.targetNonce??'')||
     oldTarget.roleId!==previous.id||newTarget.roleId!==current.id||
     oldTarget.slot!==previous.slot||newTarget.slot!==current.slot||
     oldTarget.targetId!==previous.targetId||newTarget.targetId!==current.targetId||
     oldTarget.targetNonce!==previous.targetNonce||newTarget.targetNonce!==current.targetNonce||
     oldTarget.conversationId!==previous.conversationId||newTarget.conversationId!==current.conversationId||
     oldTarget.accountAlias!==previous.accountAlias||newTarget.accountAlias!==current.accountAlias||
     oldTarget.browserWorkspace!==previous.browserWorkspace||
     newTarget.browserWorkspace!==current.browserWorkspace||
     oldTarget.originalLeaseSha256!==sha(previous.leaseToken)||
     newTarget.originalLeaseSha256!==sha(current.leaseToken)||
     oldTarget.accountIdentityHash!==newTarget.accountIdentityHash||
     oldTarget.workspaceIdentityHash!==newTarget.workspaceIdentityHash)
   fail('HOLD_REBIND_ROLE_OR_TARGET_IDENTITY_CHANGED');
 }
 if(p.kind!=='aicc-gpt-queue-owner-prepared'||q.kind!==p.kind||
    p.schemaVersion!==1||q.schemaVersion!==1||
    p.inspectedTargets!==2||q.inspectedTargets!==2||
    p.originalRequestDispatched!==false||q.originalRequestDispatched!==false||
    p.bindingSha256!==old.sha256||q.bindingSha256!==next.sha256||
    p.originalRequestSha256!==oldRequest.sha256||
    q.originalRequestSha256!==newRequest.sha256||
    p.ownerIdentityHash!==a.ownerIdentityHash||q.ownerIdentityHash!==a.ownerIdentityHash||
    q.reboundUnregisteredRequest!==true||
    q.refreshedByOriginalIssuer!==true||
    q.priorReceiptSha256!==prior.sha256||
    path.resolve(q.priorReceiptPath??'')!==prior.path||
    q.priorBindingSha256!==old.sha256||
    q.priorOriginalRequestSha256!==oldRequest.sha256||
    q.nativePinned!==true||q.sourceOnly!==true||
    q.installedWorkspaceProvider!==false||q.toolPublished!==false)
   fail('HOLD_REBIND_SEALED_PREPARED_CHAIN_CHANGED');
 const helperPin=(file,expected)=>{
  if(typeof file!=='string'||!path.isAbsolute(file)||
    !/^[a-f0-9]{64}$/.test(expected??''))fail('HOLD_REBIND_ISSUER_HELPER_PIN_REQUIRED');
  for(let p=path.resolve(file);;p=path.dirname(p)){
    if(fs.lstatSync(p).isSymbolicLink())fail('HOLD_REBIND_ISSUER_HELPER_LINK_REFUSED');
    if(p===path.dirname(p))break;
  }
  const stat=fs.statSync(file);
  if(!stat.isFile()||stat.size<=0||stat.size>1024*1024)
    fail('HOLD_REBIND_ISSUER_HELPER_FILE_BOUND');
  const bytes=fs.readFileSync(file);
  if(sha(bytes)!==expected)fail('HOLD_REBIND_ISSUER_HELPER_BYTES_CHANGED');
  return bytes;
 };
 if(issuerUpgrade){
  const u=b.issuerHelperUpgrade;
  const keys=['kind','previousHelperSha256','previousGuardSha256',
    'nextHelperSha256','nextGuardSha256','sourceHelperFile','sourceHelperSha256',
    'sourceGuardFile','sourceGuardSha256','powershellSha256',
    'requiredArgument','targetLifecycle'];
  if(!u||Object.keys(u).length!==keys.length||
    keys.some(k=>!Object.hasOwn(u,k))||
    !same(u,q.issuerHelperUpgrade)||
    u.kind!=='aicc-queue-current-issuer-helper-upgrade/v1'||
    u.requiredArgument!=='QueueOwnerRequestFile'||
    u.targetLifecycle!=='queue-owner-keep-target-before-registration/v1'||
    b.targetLifecycle!==u.targetLifecycle||
    expectedOldHelperSha!==a.currentIssuer.helperSha256||
    expectedNewHelperSha!==b.currentIssuer.helperSha256||
    expectedNewGuardSha!==b.currentIssuer.identityGuardSha256||
    u.previousHelperSha256!==expectedOldHelperSha||
    u.previousGuardSha256!==a.currentIssuer.identityGuardSha256||
    u.nextHelperSha256!==expectedNewHelperSha||
    u.nextGuardSha256!==expectedNewGuardSha||
    u.sourceHelperSha256!==expectedNewHelperSha||
    u.sourceGuardSha256!==expectedNewGuardSha||
    u.powershellSha256!==a.currentIssuer.powershellSha256||
    path.resolve(u.sourceHelperFile??'')!==path.resolve(trustedSourceHelper??'')||
    path.resolve(u.sourceGuardFile??'')!==path.resolve(trustedSourceGuard??'')||
    expectedOldHelperSha===expectedNewHelperSha){
    fail('HOLD_REBIND_ISSUER_HELPER_UPGRADE_CHAIN_CHANGED');
  }
  const pair=issuer=>{
    if(path.dirname(issuer.helperFile)!==path.dirname(issuer.identityGuardFile)||
      path.basename(issuer.helperFile)!=='Manage-CdpChromeSlotLease.ps1'||
      path.basename(issuer.identityGuardFile)!=='Assert-CdpEndpointIdentity.ps1')
      fail('HOLD_REBIND_ISSUER_SIBLING_GUARD_CHANGED');
    helperPin(issuer.helperFile,issuer.helperSha256);
    helperPin(issuer.identityGuardFile,issuer.identityGuardSha256);
  };
  pair(a.currentIssuer);pair(b.currentIssuer);
  const sourceBytes=helperPin(trustedSourceHelper,u.sourceHelperSha256);
  helperPin(trustedSourceGuard,u.sourceGuardSha256);
  const helperText=sourceBytes.toString('utf8');
  if(!/^\s*\[string\]\$QueueOwnerRequestFile\s*=/m.test(helperText)||
    !helperText.includes("if ($Action -eq 'QueueOwnerInspect')")||
    !helperText.includes('Get-QueueOriginalRequestBinding')||
    !helperText.includes('Write-KeepTargetHistory'))
    fail('HOLD_REBIND_ISSUER_REQUIRED_ARGUMENT_UNSUPPORTED');
 }else if(b.issuerHelperUpgrade!==undefined||q.issuerHelperUpgrade!==undefined){
  fail('HOLD_REBIND_ISSUER_HELPER_UNREQUESTED');
 }
 const runId='gptq_'+sha(a.bindingId+'\0'+a.ownerIdentityHash).slice(0,24)+'_'+a.operationId;
 const {nativeGptQueueExchange}=await import(pathToFileURL(path.join(root,'components/workspace-mcp/gpt-queue-provider.mjs')).href);
 const readNative=async(type,fields={})=>{
  const result=await nativeGptQueueExchange({...b,executable:b.nativeExecutable},{type,...fields});
  if(!result||typeof result.ok!=='boolean')fail('HOLD_REBIND_NATIVE_OUTCOME_UNKNOWN');
  return result;
 };
 const capability=await readNative('orchestration_capabilities');
 if(capability.ok!==true||capability.payload?.pausedRegistration!==true||
   capability.payload?.ownerBoundActivation!==true||
   capability.payload?.revisionFencedCancel!==true)
  fail('HOLD_REBIND_NATIVE_CAPABILITY_UNPROVEN');
 for(let i=0;i<2;i++){
  const result=await readNative('orchestration_get',{runId});
  if(result.ok!==false||
     result.error!=='WEBGPT_ORCHESTRATION_RUN_NOT_FOUND')
   fail('HOLD_REBIND_NATIVE_NOT_ABSENT_OR_UNKNOWN');
 }
 process.stdout.write(JSON.stringify({
  status:'UNREGISTERED_SAME_OPERATION_REBOUND_ABSENT',
  operationId:a.operationId,bindingId:a.bindingId,
  previousRequestSha256:oldRequest.sha256,nextRequestSha256:newRequest.sha256,
  previousPreparedSHA256:prior.sha256,nextPreparedSHA256:prepared.sha256,
  previousBindingSHA256:old.sha256,nextBindingSHA256:next.sha256,
  nativeReadCount:2,nativeRegistration:'NOT_FOUND',dispatched:false,
  readOnly:true,executionAuthorized:false,ownerBoundActivation:true,
  ...(issuerUpgrade?{issuerHelperUpgrade:true,
    previousHelperSha256:expectedOldHelperSha,
    nextHelperSha256:expectedNewHelperSha,
    nextGuardSha256:expectedNewGuardSha}:{} )
 }));
}catch(e){process.stderr.write(String(e.message).replace(/[^A-Z0-9_]/g,'').slice(0,110));process.exitCode=1;}
'@
 $sourceHelper=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../web-automation/Manage-CdpChromeSlotLease.ps1'))
 $sourceGuard=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../web-automation/Assert-CdpEndpointIdentity.ps1'))
 $result=& $Runtime --input-type=module -e $rebindNativeScript $Backend $PreviousBindingFile $NextBindingFile $PreviousPreparedFile $NextPreparedFile $(if($UpgradeIssuerHelper){'true'}else{'false'}) $PreviousHelperSha256 $NextHelperSha256 $NextGuardSha256 $sourceHelper $sourceGuard
 if($LASTEXITCODE -ne 0 -or !$result){throw 'HOLD_REBIND_SEMANTIC_CHAIN_OR_NATIVE_NOT_FOUND_UNVERIFIED'}
 $proof=$result|ConvertFrom-Json -AsHashtable -DateKind String
 if($proof.status -cne 'UNREGISTERED_SAME_OPERATION_REBOUND_ABSENT' -or
    $proof.nativeRegistration -cne 'NOT_FOUND' -or $proof.nativeReadCount -ne 2 -or
    $proof.readOnly -cne $true -or $proof.executionAuthorized -cne $false -or
    $proof.dispatched -cne $false -or $proof.ownerBoundActivation -cne $true -or
    ($UpgradeIssuerHelper -and ($proof.issuerHelperUpgrade -cne $true -or
      $proof.previousHelperSha256 -cne $PreviousHelperSha256 -or
      $proof.nextHelperSha256 -cne $NextHelperSha256 -or
      $proof.nextGuardSha256 -cne $NextGuardSha256)) -or
    (-not $UpgradeIssuerHelper -and $proof.issuerHelperUpgrade)){

  throw 'HOLD_REBIND_NATIVE_READBACK_INCOMPLETE'
 }
 return $proof
}
function Assert-GptQueueReplacementActualTools($Candidate,$Runtime){
 $contractScript=@'
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const [root,file]=process.argv.slice(1),config=JSON.parse(fs.readFileSync(file,'utf8'));
const load=p=>import(pathToFileURL(path.join(root,p)).href);
const {createWorkspaceMcpServer}=await load('components/workspace-mcp/server.mjs');
const {Client}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {InMemoryTransport}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
const runtimeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-queue-owner-contract-'));
const server=createWorkspaceMcpServer(config,{runtimeRoot,remoteAuthority:{reconcileStartup(){}}});
const client=new Client({name:'queue-owner-replacement',version:'1.0.0'});
const [st,ct]=InMemoryTransport.createLinkedPair();
const canonical=v=>Array.isArray(v)?v.map(canonical):
 v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
try{
 await server.connect(st);await client.connect(ct);
 const tools=[];let cursor;const seen=new Set();
 do{const page=await client.listTools(cursor?{cursor}:{});tools.push(...page.tools);
 cursor=page.nextCursor;
 if(cursor&&(seen.has(cursor)||seen.size>=20))throw Error('Incomplete actual tool list');
 if(cursor)seen.add(cursor);}while(cursor);
 const digest=createHash('sha256').update(JSON.stringify(canonical([...tools].sort((a,b)=>a.name.localeCompare(b.name))))).digest('hex');
 process.stdout.write(JSON.stringify({hash:digest,names:tools.map(t=>t.name),toolCalls:0,leasesOpened:0}));
}finally{await client.close();await server.close();}
'@
 $result=& $Runtime --input-type=module -e $contractScript $Candidate.backend $Candidate.configDesiredFile
 if($LASTEXITCODE -ne 0 -or !$result){throw 'Actual replacement MCP tool contract unavailable'}
 $verified=$result|ConvertFrom-Json -AsHashtable -DateKind String
 if($verified.hash -cne $Candidate.toolHash -or
    -not (Same @($verified.names|Sort-Object) @($Candidate.queueToolNames|Sort-Object)) -or
    $verified.toolCalls -ne 0 -or $verified.leasesOpened -ne 0 -or
    @($verified.names|Where-Object {$_ -like 'aicc_gpt_queue_*'}).Count -ne 5){
  throw 'Replacement changes actual queue tool hash, scope or schema'
 }
}
function Assert-GptQueueNativeUpgradeEvidence($Candidate,$Previous,$Next){
 if((Hash $Candidate.nativeUpgradeEvidenceFile) -cne $Candidate.nativeUpgradeEvidenceSHA256){
  throw 'Exact native upgrade evidence changed'
 }
 $evidence=Read $Candidate.nativeUpgradeEvidenceFile
 if($evidence.kind -cne 'aicc-gpt-queue-native-upgrade-readback/v1' -or
    $evidence.status -cne 'INSTALLED_VERIFIED' -or $evidence.ownerBoundActivation -cne $true -or
    $evidence.previousBindingSha256 -cne $Candidate.queuePreviousBindingSHA256 -or
    $evidence.installedExecutableSha256 -cne $Next.nativeExecutableSha256 -or
    $evidence.installedConfigSha256 -cne $Next.nativeConfigSha256 -or
    $evidence.installedManifestSha256 -cne $Next.nativeManifestSha256 -or
    $evidence.registeredManifest -cne $Next.nativeManifest -or
    $evidence.currentGraphFile -cne (Join-Path $Candidate.oldGateway 'config.json') -or
    $evidence.currentGraphSha256 -cne $Candidate.oldGatewayConfigSHA256 -or
    -not $evidence.installReceiptFile -or -not $evidence.installReceiptSha256 -or
    (Hash $evidence.installReceiptFile) -cne $evidence.installReceiptSha256 -or
    (Hash $evidence.currentGraphFile) -cne $evidence.currentGraphSha256){
  throw 'Exact Native install receipt or registered graph evidence missing'
 }
 foreach($pair in @(@($Next.nativeExecutable,$Next.nativeExecutableSha256),
                    @($Next.nativeConfig,$Next.nativeConfigSha256),
                    @($Next.nativeManifest,$Next.nativeManifestSha256))){
  if((Hash $pair[0]) -cne $pair[1]){throw 'Installed Native pin changed'}
 }
 $manifest=Read $Next.nativeManifest;$installed=Read $Next.nativeConfig
 if($manifest.name -cne 'com.agenticfabworks.webgpt_queue' -or $manifest.type -cne 'stdio' -or
    $manifest.path -cne $Next.nativeExecutable -or
    $installed.baseDirectory -cne $Next.baseDirectory -or
    $Previous.baseDirectory -cne $Next.baseDirectory){
  throw 'Native registered manifest or original ledger identity differs'
 }
 $nativeKey='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.agenticfabworks.webgpt_queue'
 if([string](Get-ItemProperty -LiteralPath $nativeKey).'(default)' -cne $Next.nativeManifest){
  throw 'Registered Native host points to another manifest'
 }
}
function Assert-GptQueueCombinedProviderStage($Candidate){
 if($Candidate.kind -cne 'workspace-gpt-queue-owner-replacement' -or
    $Candidate.queueCombinedIssuerProviderUpdate -cne $true -or
    $Candidate.queueUpgradeCurrentIssuerHelper -cne $true -or
    $Candidate.queueRebindUnregisteredSameOperation -cne $true -or
    $Candidate.queueProviderOnlyUpdate -or
    (Hash (Regular $Candidate.queueStageFile)) -cne $Candidate.queueStageSHA256){
  throw 'HOLD_COMBINED_ISSUER_PROVIDER_STAGE_REQUIRED'
 }
 $stage=Read $Candidate.queueStageFile
 if($stage.kind -cne 'workspace-gpt-queue-source-stage/v1' -or
    $stage.status -cne 'STAGED_NOT_INSTALLED' -or $stage.owner -cne $env:CODEX_THREAD_ID -or
    $stage.baseline -cne $Candidate.baseline -or $stage.backend -cne $Candidate.backend){
  throw 'HOLD_COMBINED_ISSUER_PROVIDER_STAGE_OWNER_CHANGED'
 }
 $sourceProvider=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../components/workspace-mcp/gpt-queue-provider.mjs'))
 $providerPins=@($stage.sourcePins|Where-Object path -IEQ $sourceProvider)
 if($providerPins.Count -ne 1 -or
    $providerPins[0].sha256 -cne $stage.desiredProviderSHA256 -or
    (Hash $sourceProvider) -cne $stage.desiredProviderSHA256){throw 'HOLD_COMBINED_ISSUER_PROVIDER_SOURCE_PIN_CHANGED'}
 foreach($pin in $stage.sourcePins){if((Hash (Regular $pin.path)) -cne $pin.sha256){throw 'HOLD_COMBINED_ISSUER_PROVIDER_SOURCE_PIN_CHANGED'}}
 Assert-GptQueueProviderOnlyStage $Candidate $stage
}
function Assert-GptQueueOwnerReplacementCandidate($Candidate,$Before,$After){
 $combined=$Candidate.queueCombinedIssuerProviderUpdate -ceq $true
 if($null -ne $Candidate.queueCombinedIssuerProviderUpdate -and -not $combined){throw 'HOLD_COMBINED_ISSUER_PROVIDER_MODE_INVALID'}
 if($combined){Assert-GptQueueCombinedProviderStage $Candidate}
 if(($combined -and $Candidate.baseline -ceq $Candidate.backend) -or
    (-not $combined -and ($Candidate.baseline -cne $Candidate.backend -or @($Candidate.changedFiles).Count -ne 0)) -or
    $Before.surfaceProfile -cne 'business-full'){throw 'Owner replacement must keep the installed backend or an exact combined provider delta'}
 $expected=Read (Join-Path (Split-Path $CandidateReceipt -Parent) 'workspace-config.before.json')
 if(-not (Same $expected $Before) -or -not $Before.gptQueue -or
    $Before.gptQueue.enabled -cne $true -or @($Before.gptQueue.Keys).Count -ne 3 -or
    $Before.gptQueue.bindingFile -cne $Candidate.queuePreviousBindingFile -or
    $Before.gptQueue.bindingSha256 -cne $Candidate.queuePreviousBindingSHA256 -or
    (Hash $Before.gptQueue.bindingFile) -cne $Before.gptQueue.bindingSha256){
  throw 'Previous installed owner binding preimage changed'
 }
 if($After.gptQueue.enabled -cne $true -or @($After.gptQueue.Keys).Count -ne 3 -or
    $After.gptQueue.bindingFile -cne $Candidate.queueNextBindingFile -or
    $After.gptQueue.bindingSha256 -cne $Candidate.queueNextBindingSHA256 -or
    (Hash $After.gptQueue.bindingFile) -cne $After.gptQueue.bindingSha256){
  throw 'New owner binding candidate not pinned'
 }
 $expected.gptQueue=$After.gptQueue
 if(-not (Same $expected $After) -or
    $Candidate.bindingFile -cne $Before.webManagement.bindingFile -or
    $Candidate.bindingSHA256 -cne $Before.webManagement.bindingSha256){
  throw 'Replacement changes unrelated owner config or manager binding'
 }
 $old=Read $Candidate.queuePreviousBindingFile;$next=Read $Candidate.queueNextBindingFile
 if($old.kind -cne 'aicc-gpt-queue-owner-binding' -or $next.kind -cne $old.kind -or
    $old.schemaVersion -ne 1 -or $next.schemaVersion -ne 1 -or
    $next.ownerId -cne $old.ownerId -or $next.ownerIdentityHash -cne $old.ownerIdentityHash -or
    $next.workspaceAlias -cne $old.workspaceAlias -or
    $next.workspaceRoot -cne $old.workspaceRoot -or
    @($After.workspaces|Where-Object {$_.alias -ceq $next.workspaceAlias -and $_.root -ceq $next.workspaceRoot}).Count -ne 1){
  throw 'Replacement changes original owner/workspace'
 }
 if($Candidate.queueRebindUnregisteredSameOperation -ceq $true){
  if($next.operationId -cne $old.operationId -or $next.bindingId -cne $old.bindingId -or
     $next.originalRequestSha256 -ceq $old.originalRequestSha256 -or
     $Candidate.queuePreviousOriginalRequestSHA256 -cne $old.originalRequestSha256 -or
     $Candidate.queueNextOriginalRequestSHA256 -cne $next.originalRequestSha256 -or
     $Candidate.legacyCancelReceiptFile -or $Candidate.legacyCancelReceiptSHA256){
   throw 'HOLD_REBIND_EXACT_SAME_OPERATION_DIFFERENT_REQUEST_NO_TERMINAL_REQUIRED'
  }
 }elseif($Candidate.queueRebindUnregisteredSameOperation -ceq $false -or
          $null -eq $Candidate.queueRebindUnregisteredSameOperation){
  if($next.operationId -ceq $old.operationId -or $next.bindingId -ceq $old.bindingId -or
     $next.originalRequestSha256 -ceq $old.originalRequestSha256){
   throw 'Replacement reuses original operation or binding'
  }
 }else{throw 'HOLD_REBIND_EXPLICIT_MODE_INVALID'}
 foreach($target in $old.targets){
  if((Hash $target.proofFile) -cne $target.proofSha256){throw 'Previous sealed target proof changed'}
 }
 $prior=Read $Candidate.queuePreviousPreparedFile
 if((Hash $Candidate.queuePreviousPreparedFile) -cne $Candidate.queuePreviousPreparedSHA256 -or
    $prior.kind -cne 'aicc-gpt-queue-owner-prepared' -or
    $prior.bindingSha256 -cne $Candidate.queuePreviousBindingSHA256 -or
    $prior.originalRequestSha256 -cne $old.originalRequestSha256 -or
    $prior.ownerIdentityHash -cne $old.ownerIdentityHash){
  throw 'Previous owner preparation is not immutable'
 }
 $prepared=Read $Candidate.queueOwnerPreparedFile
 if((Hash $Candidate.queueOwnerPreparedFile) -cne $Candidate.queueOwnerPreparedSHA256 -or
    $prepared.kind -cne 'aicc-gpt-queue-owner-prepared' -or
    $prepared.inspectedTargets -ne 2 -or $prepared.originalRequestDispatched -cne $false -or
    $prepared.bindingSha256 -cne $Candidate.queueNextBindingSHA256 -or
    $prepared.originalRequestSha256 -cne $next.originalRequestSha256 -or
    $prepared.ownerIdentityHash -cne $next.ownerIdentityHash -or -not $next.currentIssuer){
  throw 'Fresh independent new two-target owner preparation required'
 }
 Assert-GptQueueTargetProofFreshness $next
 if($Candidate.queueUpgradeCurrentIssuerHelper -ceq $true){
  if($Candidate.queueRebindUnregisteredSameOperation -cne $true -or
     $Candidate.queuePreviousIssuerHelperSHA256 -cne $old.currentIssuer.helperSha256 -or
     $Candidate.queueNextIssuerHelperSHA256 -cne $next.currentIssuer.helperSha256 -or
     $Candidate.queueNextIssuerGuardSHA256 -cne $next.currentIssuer.identityGuardSha256){
   throw 'HOLD_ISSUER_HELPER_UPGRADE_APPLY_CANDIDATE_PIN_CHANGED'
  }
 }elseif($Candidate.queueUpgradeCurrentIssuerHelper -ceq $false -or
          $null -eq $Candidate.queueUpgradeCurrentIssuerHelper){
  if($Candidate.queuePreviousIssuerHelperSHA256 -or
     $Candidate.queueNextIssuerHelperSHA256 -or
     $Candidate.queueNextIssuerGuardSHA256){
   throw 'HOLD_ISSUER_HELPER_UPGRADE_EXPLICIT_MODE_REQUIRED'
  }
 }else{throw 'HOLD_ISSUER_HELPER_UPGRADE_MODE_INVALID'}
 Assert-GptQueueIssuerHelperUpgrade $old $next $prepared ([bool]$Candidate.queueUpgradeCurrentIssuerHelper)
 Assert-GptQueueNativeUpgradeEvidence $Candidate $old $next
 $registry=Read $registryFile
 if((Hash $registryFile) -cne $Candidate.gptQueueRecovery.registrySHA256 -or
    $registry.components.workspace.releaseRoot -cne $Candidate.baseline -or
    $registry.components['unified-mcp'].releaseRoot -cne $Candidate.oldGateway -or
    (Hash (Join-Path $Candidate.baseline '.aicc-release.json')) -cne $Candidate.queueBackendManifestSHA256 -or
    (Hash (Join-Path $Candidate.baseline 'workspace-drive-manifest.json')) -cne $Candidate.queueDriveManifestSHA256){
  throw 'Installed Workspace registry/runtime/manifest CAS differs'
 }
 $null=Assert-BrokerInventory $Candidate.baseline $Candidate.gptQueueRecovery.inventoryBeforeFile $Candidate.gptQueueRecovery.inventoryBeforeSHA256
 $graph=Read (Join-Path $Candidate.oldGateway 'config.json')
 $gateway=Read (Join-Path $Candidate.gateway 'config.json')
 if((Hash (Join-Path $Candidate.oldGateway 'config.json')) -cne $Candidate.oldGatewayConfigSHA256 -or
    (Hash (Join-Path $Candidate.oldGateway 'manifest.json')) -cne $Candidate.oldGatewayManifestSHA256 -or
    (@($graph.providers.id|Sort-Object) -join ',') -cne 'host,native,workspace' -or
    $graph.hostControl -cne 'task-owned-v1'){throw 'Installed three-provider gateway CAS differs'}
 $workspace=@($graph.providers|Where-Object id -CEQ 'workspace')
 if($workspace.Count -ne 1 -or $workspace[0].toolHash -cne $Candidate.toolHash -or
    -not (Same @($workspace[0].toolNames|Sort-Object) @($Candidate.queueToolNames|Sort-Object))){
  throw 'Installed actual queue tool hash or names differs'
 }
 $configPins=@($workspace[0].files|Where-Object path -IEQ $configFile)
 if($configPins.Count -ne 1 -or $configPins[0].sha256 -cne $Candidate.configBeforeSHA256){
  throw 'Gateway original owner config pin differs'
 }
 $configPins[0].sha256=$Candidate.configDesiredSHA256
 if($combined){
  $prefix=$Candidate.baseline.TrimEnd('\')+'\'
  $workspace[0].entrypoint=$Candidate.backend+$workspace[0].entrypoint.Substring($Candidate.baseline.Length)
  $workspace[0].args=@($workspace[0].args|ForEach-Object {if($_ -is [string] -and $_.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$Candidate.backend+$_.Substring($Candidate.baseline.Length)}else{$_}})
  foreach($pin in $workspace[0].files){if($pin.path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$pin.path=Join-Path $Candidate.backend $pin.path.Substring($prefix.Length);$pin.sha256=Hash $pin.path}}
 }
 if(-not (Same $graph $gateway) -or
    (Hash (Join-Path $Candidate.gateway 'gateway.cjs')) -cne (Hash (Join-Path $Candidate.oldGateway 'gateway.cjs'))){
  throw 'Replacement changes Native/Host/tool graph or gateway code'
 }
 foreach($provider in $gateway.providers){foreach($pin in $provider.files){
  if($pin.path -ieq $configFile){
   if($provider.id -cne 'workspace' -or $pin.sha256 -cne $Candidate.configDesiredSHA256){throw 'Future owner config pin differs'}
  }elseif((Hash $pin.path) -cne $pin.sha256){throw 'Gateway provider dependency pin changed'}
 }}
 $manifest=Read (Join-Path $Candidate.oldGateway 'manifest.json')
 Assert-HostOverlayProvenance $Candidate $manifest
 $manifest.files['config.json']=$Candidate.gatewayConfigSHA256
 $manifest.releaseHash=$Candidate.gatewayConfigSHA256
 if(-not (Same $manifest (Read (Join-Path $Candidate.gateway 'manifest.json')))){
  throw 'Gateway manifest differs outside exact config pin'
 }
 $profile=[IO.File]::ReadAllText($profileFile)
 $spellings=@(@($Candidate.oldGateway,$Candidate.oldGateway.Replace('\','/'),$Candidate.oldGateway.Replace('\','\\'))|Select-Object -Unique|Where-Object {$profile.Contains($_)})
 if($spellings.Count -ne 1 -or $profile.Split([string[]]@($spellings[0]),[StringSplitOptions]::None).Count -ne 3){
  throw 'Exact two gateway profile preimages required'
 }
 $spelling=$spellings[0]
 $replacement=if($spelling -ceq $Candidate.oldGateway){$Candidate.gateway}elseif($spelling -ceq $Candidate.oldGateway.Replace('\','/')){$Candidate.gateway.Replace('\','/')}else{$Candidate.gateway.Replace('\','\\')}
 if([IO.File]::ReadAllText($Candidate.profileDesiredFile) -cne $profile.Replace($spelling,$replacement)){
  throw 'Replacement profile changes unrelated settings'
 }
 Assert-GptQueueReplacementActualTools $Candidate $registry.components.workspace.runtime
 $native=if($Candidate.queueRebindUnregisteredSameOperation -ceq $true){
  Get-GptQueueUnregisteredRebindNativeReadback $Candidate.queuePreviousBindingFile $Candidate.queueNextBindingFile $Candidate.queuePreviousPreparedFile $Candidate.queueOwnerPreparedFile $Candidate.backend $registry.components.workspace.runtime ([bool]$Candidate.queueUpgradeCurrentIssuerHelper) $Candidate.queuePreviousIssuerHelperSHA256 $Candidate.queueNextIssuerHelperSHA256 $Candidate.queueNextIssuerGuardSHA256
 }else{
  Get-GptQueueReplacementNativeReadback $Candidate.queuePreviousBindingFile $Candidate.queueNextBindingFile $Candidate.backend $registry.components.workspace.runtime $Candidate.legacyCancelReceiptFile $Candidate.legacyCancelReceiptSHA256
 }
 if((Hash $Candidate.queueNativeReadbackFile) -cne $Candidate.queueNativeReadbackSHA256 -or
    -not (Same $native (Read $Candidate.queueNativeReadbackFile))){
  throw 'Native terminal or new acceptance absence changed since preparation'
 }
 # Fresh target issuer verification must be consumed after the full inventory.
 $verifyCurrent=@'
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const [root,file]=process.argv.slice(1),config=JSON.parse(fs.readFileSync(file,'utf8'));
const binding=JSON.parse(fs.readFileSync(config.gptQueue.bindingFile,'utf8'));
const workspace=config.workspaces.find(w=>w.alias===binding.workspaceAlias&&w.root===binding.workspaceRoot);
if(!workspace)throw Error('Exact queue workspace missing');
const {verifyGptQueueOwnerConfig}=await import(pathToFileURL(path.join(root,'components/workspace-mcp/gpt-queue-provider.mjs')).href);
try{
  process.stdout.write(JSON.stringify(await verifyGptQueueOwnerConfig(config,workspace)));
}catch(error){
  const allowed=/^QUEUE_CURRENT_ISSUER_(?:TARGET_CLOSED_OR_UNPROVEN|LEASE_EXPIRED|LEASE_UNPROVEN|LEASE_CHANGED|IDENTITY_HOLD|ARGUMENTS_HOLD|INSPECT_UNPROVEN|INSPECT_NONZERO|INSPECT_MALFORMED|INSPECT_TIMEOUT|INSPECT_LAUNCH_FAILED|INSPECT_OVERFLOW|TARGET_MISMATCH|STALE|ROLE_MISMATCH|REQUEST_MISMATCH|DEFINITION_MISMATCH|CONTRACT_INVALID|PRIVATE_FILE_REQUIRED|REQUEST_BOUNDARY|EXECUTABLE_BOUNDARY)$/;
  const code=allowed.test(error?.code??'')?error.code:'QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN';
  process.stdout.write(JSON.stringify({ok:false,status:'HOLD',diagnosticCode:code,
    filesWritten:0,executionAuthorized:false,dispatched:false}));
}
'@
 $result=& $registry.components.workspace.runtime --input-type=module -e $verifyCurrent $Candidate.backend $Candidate.configDesiredFile
 if($LASTEXITCODE -ne 0 -or !$result){throw 'Current replacement target issuer unavailable'}
 $current=$result|ConvertFrom-Json -AsHashtable -DateKind String
 Assert-GptQueueIssuerDiagnostic $current
 if($current.ok -cne $true -or $current.status -cne 'CURRENT_ORIGINAL_ISSUER_VERIFIED_READ_ONLY' -or
    $current.originalRequestSha256 -cne $next.originalRequestSha256 -or
    $current.ownerIdentityHash -cne $next.ownerIdentityHash -or
    $current.definitionSha256 -cne $next.definitionSha256 -or
    $current.targetCount -ne 2 -or $current.executionAuthorized -cne $false -or
    $current.dispatched -cne $false -or $current.filesWritten -ne 0 -or
    (@($current.observations.slot) -join ',') -cne '9222,9223'){
  throw 'Current replacement target issuer result differs'
 }
 $now=[DateTimeOffset]::UtcNow
 foreach($observation in $current.observations){
  try{$at=[DateTimeOffset]::Parse($observation.observedAt);$expires=[DateTimeOffset]::Parse($observation.expiresAt)}catch{throw 'Current target issuer time invalid'}
  if($at -gt $now -or ($now-$at).TotalSeconds -gt 120 -or $expires -le $now -or
     $expires -le $at -or ($expires-$at).TotalSeconds -gt 120){
   throw 'Current replacement target closed or expired'
  }
 }
}
function Assert-GptQueueRuntimeBackup($Candidate,$Backup){
 if($Candidate.kind -ceq 'workspace-gpt-queue-owner-replacement'){
  if($Backup.githubStatus -cne 'VERIFIED' -or $Backup.notionStatus -cne 'VERIFIED'){
   throw 'Exact reviewed two-destination replacement backup required'
  }
  $bundle=Read $Backup.bundlePath
  $previous=Read $Candidate.queuePreviousBindingFile
  $next=Read $Candidate.queueNextBindingFile
  $upgrade=Read $Candidate.nativeUpgradeEvidenceFile
  $required=@(
   $PSCommandPath,(Join-Path $PSScriptRoot 'GptQueueRuntimeDeployment.ps1'),
   $CandidateReceipt,$Candidate.configDesiredFile,$Candidate.profileDesiredFile,
   $Candidate.queuePreviousBindingFile,$Candidate.queuePreviousPreparedFile,
   $Candidate.queueNextBindingFile,$Candidate.queueOwnerPreparedFile,
   $Candidate.queueNativeReadbackFile,$Candidate.nativeUpgradeEvidenceFile,
   $upgrade.installReceiptFile,$upgrade.currentGraphFile,$Candidate.bindingFile,
   $registryFile,$configFile,$profileFile,$receiptFile,$launcherFile,
   $Candidate.gptQueueRecovery.inventoryBeforeFile,
   (Join-Path $Candidate.baseline '.aicc-release.json'),
   (Join-Path $Candidate.baseline 'workspace-drive-manifest.json')
  )
  if($Candidate.queueCombinedIssuerProviderUpdate -ceq $true){
   Assert-GptQueueCombinedProviderStage $Candidate
   $stage=Read $Candidate.queueStageFile
   $required+=@($Candidate.queueStageFile,
    (Join-Path (Split-Path $Candidate.queueStageFile -Parent) 'inventory.before.json'),
    (Join-Path (Split-Path $Candidate.queueStageFile -Parent) 'inventory.desired.json'))
   foreach($pin in $stage.sourcePins){$required+=$pin.path}
   foreach($root in @($Candidate.baseline,$Candidate.backend)){foreach($relative in $Candidate.changedFiles){$required+=Join-Path $root $relative}}
  }
  if($Candidate.legacyCancelReceiptFile){
   if((Hash $Candidate.legacyCancelReceiptFile) -cne $Candidate.legacyCancelReceiptSHA256){throw 'Legacy cancellation backup pin changed'}
   $required+=$Candidate.legacyCancelReceiptFile
  }
  foreach($binding in @($previous,$next)){
   $required+=@($binding.targets.proofFile)
  }
  $required+=@($next.nativeExecutable,$next.nativeConfig,$next.nativeManifest)
  if($next.currentIssuer){
   $required+=@($next.currentIssuer.helperFile,$next.currentIssuer.identityGuardFile,$next.currentIssuer.powershellFile)
  }
  if($Candidate.queueUpgradeCurrentIssuerHelper -ceq $true){
   $required+=@($previous.currentIssuer.helperFile,$previous.currentIssuer.identityGuardFile,
    $next.issuerHelperUpgrade.sourceHelperFile,$next.issuerHelperUpgrade.sourceGuardFile)
  }
  foreach($root in @($Candidate.oldGateway,$Candidate.gateway)){
   foreach($name in @('config.json','gateway.cjs','manifest.json')){$required+=Join-Path $root $name}
  }
  foreach($file in $required){
   if((Hash $file) -cnotin @($bundle.files.sha256)){
    throw 'Exact immutable owner replacement/recovery source missing from reviewed backup'
   }
  }
  return
 }
 if($Backup.githubStatus -cne 'VERIFIED' -or $Backup.notionStatus -cne 'VERIFIED'){throw 'Actual existing two-destination backup required for queue update'}
 $bundle=Read $Backup.bundlePath;$hashes=@($bundle.files.sha256)
 $required=@($PSCommandPath,(Join-Path $PSScriptRoot 'GptQueueRuntimeDeployment.ps1'),$CandidateReceipt,$Candidate.queueVerifierFile,$Candidate.queueStageFile,$Candidate.queueOwnerPreparedFile,$Candidate.configDesiredFile,$Candidate.profileDesiredFile,$Candidate.bindingFile,$registryFile,$configFile,$profileFile,$receiptFile,$launcherFile,$Candidate.gptQueueRecovery.inventoryBeforeFile)
 $owner=Read (Read $Candidate.configDesiredFile).gptQueue.bindingFile
 $required+=@((Read $Candidate.configDesiredFile).gptQueue.bindingFile)+@($owner.targets.proofFile)
 # The request contains local lease credentials and stays in the sealed local
 # owner store. Remote recovery bundles contain its hash, never those bytes.
 if($owner.currentIssuer){$required+=@($owner.currentIssuer.helperFile,$owner.currentIssuer.identityGuardFile)}
 foreach($root in @($Candidate.baseline,$Candidate.backend)){foreach($relative in $Candidate.changedFiles){if(Test-Path -LiteralPath (Join-Path $root $relative)){$required+=Join-Path $root $relative}}}
 foreach($root in @($Candidate.oldGateway,$Candidate.gateway)){foreach($name in @('config.json','gateway.cjs','manifest.json')){$required+=Join-Path $root $name}}
 foreach($pin in (Read $Candidate.queueStageFile).sourcePins){$required+=$pin.path}
 if($Candidate.queueProviderBaselineReconciliation){
  $evidence=$Candidate.queueProviderBaselineReconciliation
  if(-not (Same (Read $Candidate.queueStageFile).baselineReconciliation $evidence)){
   throw 'HOLD_PROVIDER_BASELINE_RECONCILIATION_BACKUP_SOURCE_DRIFT'
  }
  $required+=@($evidence.priorReceiptFile,$evidence.priorPreparedFile,
    $evidence.sealedInventoryFile,$evidence.registryFile,
    $evidence.graphConfigFile,$evidence.graphManifestFile,
    (Join-Path $Candidate.baseline '.aicc-release.json'),
    (Join-Path $Candidate.baseline 'workspace-drive-manifest.json'))
 }
 foreach($file in $required){if((Hash $file) -cnotin $hashes){throw 'Exact queue update and rollback source missing from backup'}}
}
