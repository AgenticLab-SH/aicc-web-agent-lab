#requires -Version 7.5
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidateSet('Prepare','Apply','Rollback')][string]$Mode,
 [Parameter(Mandatory)][string]$OperationDirectory,
 [string]$CandidateReceipt,
 [string]$ExpectedCandidateSha256,
 [string]$ExpectedPlanSha256,
 [string]$ReadyFile,
 [string]$ChangeBackupReceipt,
 [string]$MaintenanceStateFile,
 [switch]$UserConfirmedNoOtherWork
)
$ErrorActionPreference='Stop'
$stateRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$taskName='AgenticLab-AICC-Workspace-Tunnel'
$registryFile=Join-Path $stateRoot 'runtime\components.json'
$configFile=Join-Path $stateRoot 'workspace-mcp\config.json'
$profileFile=Join-Path $stateRoot 'workspace-mcp\tunnel\profiles\aicc-workspace.yaml'
$receiptFile=Join-Path $stateRoot ('backups\workspace-tunnel-windows-task\'+$taskName+'.install.json')
$launcherFile=Join-Path $stateRoot 'workspace-mcp\runtime\aicc-workspace.hidden.ps1'
. (Join-Path $PSScriptRoot 'Stop-WorkspaceOwnedRuntime.ps1')
. (Join-Path $PSScriptRoot 'GptQueueRuntimeDeployment.ps1')
function Regular([string]$Path){
 $full=[IO.Path]::GetFullPath($Path);$item=Get-Item -LiteralPath $full -Force
 if($item.PSIsContainer -or $item.LinkType){throw 'A regular non-linked file is required'}
 for($parent=$item.Directory;$parent;$parent=$parent.Parent){if($parent.LinkType){throw 'Linked ancestor refused'}}
 return $full
}
function Hash([string]$Path){(Get-FileHash -LiteralPath (Regular $Path) -Algorithm SHA256).Hash.ToLowerInvariant()}
function Json($Value){ConvertTo-Json -InputObject $Value -Depth 60 -Compress}
function Read([string]$Path){Get-Content -LiteralPath (Regular $Path) -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function Same($Left,$Right){
 if($null -eq $Left -or $null -eq $Right){return ($null -eq $Left -and $null -eq $Right)}
 if($Left -is [Collections.IDictionary] -and $Right -is [Collections.IDictionary]){if($Left.Count -ne $Right.Count){return $false};foreach($key in $Left.Keys){if(-not $Right.Contains($key) -or -not (Same $Left[$key] $Right[$key])){return $false}};return $true}
 if($Left -is [array] -and $Right -is [array]){if($Left.Count -ne $Right.Count){return $false};for($i=0;$i -lt $Left.Count;$i++){if(-not (Same $Left[$i] $Right[$i])){return $false}};return $true}
 return (Json $Left) -ceq (Json $Right)
}
function New-Text([string]$Path,[string]$Text){$stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes($Text);$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}}
function Atomic([string]$Path,[string]$Text){$null=Regular $Path;$temp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp';New-Text $temp $Text;Move-Item -LiteralPath $temp -Destination $Path -Force}
function Same-ExactPath([string]$Left,[string]$Right,[ValidateSet('file','directory')][string]$Kind){
 foreach($value in @($Left,$Right)){
  if(-not [IO.Path]::IsPathFullyQualified($value)){throw 'Absolute exact path required'}
  $full=[IO.Path]::GetFullPath($value);$item=Get-Item -LiteralPath $full -Force
  if(($Kind -ceq 'file' -and $item.PSIsContainer) -or ($Kind -ceq 'directory' -and -not $item.PSIsContainer) -or $item.LinkType){throw 'Exact non-linked path kind required'}
  for($ancestor=$(if($item.PSIsContainer){$item}else{$item.Directory});$ancestor;$ancestor=$ancestor.Parent){if($ancestor.LinkType){throw 'Linked ancestor refused'}}
 }
 return [string]::Equals([IO.Path]::GetFullPath($Left).TrimEnd('\'),[IO.Path]::GetFullPath($Right).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)
}
function Assert-HostMaintenance($Plan,$Candidate,[string]$StateFile){
 if(-not $StateFile){throw 'Fresh exact gateway maintenance state required for host bootstrap'}
 $full=Regular $StateFile;$parent=(Join-Path $stateRoot 'runtime\unified-mcp-maintenance').TrimEnd('\')+'\'
 if(-not $full.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($full) -cne 'state.json'){throw 'Exact owner-local gateway state required'}
 $state=Read $full;$identity=Read (Join-Path (Split-Path $full -Parent) 'identity.json')
 $marker=Read (Join-Path $stateRoot 'workspace-mcp\runtime\remote-authority-status.json')
 if(-not (Same $state.identity $identity) -or -not (Same-ExactPath $identity.instanceDirectory (Split-Path $full -Parent) 'directory') -or @($Plan.ownership.processes|Where-Object pid -EQ $identity.gateway.pid).Count -ne 1 -or $identity.gateway.pid -ne $marker.supervisor.pid -or -not (Same-ExactPath $identity.configPath (Join-Path $Candidate.oldGateway 'config.json') 'file') -or $identity.configSha256 -cne (Hash $identity.configPath)){throw 'Maintenance state differs from current owned gateway'}
 if($state.phase -cne 'CONSUMED' -or $state.closed -cne $true -or $state.initialized -cne $true -or $state.fault -or $state.expired -or $state.consumedSnapshotSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Current gateway drain must be consumed without active or unknown calls'}
 if($state.operation.operationId -cne $Plan.request_id -or $state.operation.nonce -cne $Plan.challenge -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($state.operation.operationExpiresAt) -or [DateTimeOffset]::Parse($state.operation.operationExpiresAt) -gt [DateTimeOffset]::Parse($Plan.expires_at)){throw 'Gateway drain operation differs from fresh plan'}
 if((@($state.providers.Keys|Sort-Object) -join ',') -cne 'host,native,workspace' -or @($state.calls).Count -ne 0 -or @($state.unknown).Count -ne 0){throw 'Exact three-provider empty drain required'}
 foreach($provider in $state.providers.Values){foreach($key in @('active','unknown','reconnecting')){if(-not $provider.Contains($key) -or ($provider[$key] -isnot [long] -and $provider[$key] -isnot [int]) -or $provider[$key] -ne 0){throw 'Current gateway provider work must remain preserved; host bootstrap blocked'}}}
 return @{stateFile=$full;stateSha256=(Hash $full);gateway=$identity.gateway;activeCount=0;unknownCount=0;consumedSnapshotSha256=$state.consumedSnapshotSha256;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
}
function Assert-HostOverlayProvenance($Candidate,$OriginalManifest){
 $current=Join-Path $Candidate.oldGateway 'config.json'
 if((Hash $current) -cne $Candidate.oldGatewayConfigSHA256){throw 'Reviewed installed gateway graph changed'}
 if((Hash $current) -ceq $OriginalManifest.files['config.json']){return}
 $proof=$Candidate.manifestProvenance
 if($proof.kind -cne 'completed-workspace-provider-overlay' -or $proof.installedConfigSHA256 -cne (Hash $current)){throw 'Exact completed overlay provenance required for legacy manifest'}
 $directory=[IO.Path]::GetFullPath($proof.directory);$parent=(Join-Path $stateRoot 'backups').TrimEnd('\')+'\'
 if(-not $directory.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase)){throw 'Existing owner backup operation required'}
 foreach($pin in $proof.files){if((Hash $pin.path) -cne $pin.sha256){throw 'Original overlay evidence changed'}}
 $plan=Read (Join-Path $directory 'plan.json');$before=Read (Join-Path $directory 'registry.before.json');$journal=Read (Join-Path $directory 'journal.json')
 $consumeRecord=Read (Join-Path $directory 'gateway-consume.json');$consumed=Read $consumeRecord.client.responseFile;$request=Read $consumeRecord.client.requestFile
 if($plan.status -cne 'START_ACCEPTED_RUNTIME_UNOBSERVED' -or $journal.status -cne $plan.status -or $journal.startAttempts -ne 1 -or $journal.rollbackStartAttempts -ne 0 -or $journal.operationId -cne $plan.operationId -or $proof.operationId -cne $plan.operationId -or $plan.gatewayCandidate -cne $Candidate.oldGateway -or -not (Same $plan.beforeGateway $before.components['unified-mcp']) -or -not (Same $plan.beforeWorkspace $before.components.workspace) -or @($plan.modelRoutesChanged).Count -ne 0){throw 'Completed exact overlay operation required'}
 if($plan.configBeforeSha256 -cne (Hash $configFile) -or $plan.configBeforeSha256 -cne (Hash (Join-Path $directory 'config.before.json')) -or $plan.desiredConfigSha256 -cne (Hash $configFile) -or (Hash $plan.desiredConfig) -cne (Hash $configFile) -or $plan.gatewayEntryHash -cne (Hash (Join-Path $Candidate.oldGateway 'gateway.cjs'))){throw 'Original overlay owner/config preimage changed'}
 $baseConfig=Join-Path $plan.beforeGateway.releaseRoot 'config.json'
 if($consumed.ok -cne $true -or $consumed.action -cne 'consume' -or $consumed.phase -cne 'CONSUMED' -or $consumed.operation.operationId -cne $plan.operationId -or $request.operationId -cne $plan.operationId -or $request.action -cne 'consume' -or (Hash $consumeRecord.client.requestFile) -cne $consumeRecord.client.requestSha256 -or $request.readySnapshotSha256 -cne $consumed.consumedSnapshotSha256 -or [IO.Path]::GetFullPath($consumed.identity.configPath) -ine [IO.Path]::GetFullPath($baseConfig) -or $consumed.identity.configSha256 -cne (Hash $baseConfig) -or (Hash (Join-Path $plan.beforeGateway.releaseRoot 'manifest.json')) -cne $Candidate.oldGatewayManifestSHA256){throw 'Original consumed gateway/config proof changed'}
 $expected=Read $baseConfig;$workspace=@($expected.providers|Where-Object id -CEQ 'workspace')
 if($workspace.Count -ne 1){throw 'One overlay Workspace provider required'}
 $workspace=$workspace[0];$workspace.entrypoint=$workspace.entrypoint.Replace($plan.beforeWorkspace.releaseRoot,$plan.workspaceCandidate)
 $workspace.args=@($workspace.args|ForEach-Object {$_.Replace($plan.beforeWorkspace.releaseRoot,$plan.workspaceCandidate)})
 foreach($pin in $workspace.files){if($pin.path.StartsWith($plan.beforeWorkspace.releaseRoot+'\',[StringComparison]::OrdinalIgnoreCase)){$pin.path=$pin.path.Replace($plan.beforeWorkspace.releaseRoot,$plan.workspaceCandidate);$pin.sha256=Hash $pin.path}}
 if(-not (Same $expected (Read $current))){throw 'Original Workspace overlay does not close to installed graph'}
}
# In addition to named manager upgrades, this updater supports exactly one explicit
# owner-approved registration. It is not a general owner-config edit capability.
function Assert-LocalSkillsRegistration($Candidate,$Before,$After){
 $root=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agents\skills'
 $directory=Get-Item -LiteralPath $root -Force
 if(-not $directory.PSIsContainer -or $directory.LinkType){throw 'Exact existing local skills directory required'}
 for($ancestor=$directory;$ancestor;$ancestor=$ancestor.Parent){if($ancestor.LinkType){throw 'Linked local skills ancestor refused'}}
 if($Before.surfaceProfile -cne 'business-full' -or @($Before.skillRoots|Where-Object {$_ -ieq $root}).Count -ne 1){throw 'Existing business-full local skill reader registration required'}
 if(@($Before.workspaces|Where-Object {$_.alias -ieq 'local-skills' -or $_.root -ieq $root}).Count){throw 'Local skills registration already exists; reconcile instead of replacing'}
 $expected=Read (Join-Path (Split-Path $CandidateReceipt -Parent) 'workspace-config.before.json')
 $expected.workspaces=@($expected.workspaces)+@(@{alias='local-skills';label='Local Skills';root=$root})
 if(-not (Same $expected $After)){throw 'Local skills registration exceeds the single exact added alias'}
 if($Candidate.bindingFile -cne $Before.webManagement.bindingFile -or $Candidate.bindingSHA256 -cne $Before.webManagement.bindingSha256){throw 'Local skills registration must preserve the complete installed manager binding'}
 $registry=Read $registryFile
 if($Candidate.backend -cne $registry.components.workspace.releaseRoot -or $Candidate.baseline -cne $Candidate.backend -or $Candidate.oldGateway -cne $registry.components['unified-mcp'].releaseRoot){throw 'Local skills registration must preserve the installed backend'}
}
function Assert-BackendPolicyUpdate($Candidate,$Before,$After){
 if((Hash $Candidate.contractFile) -cne $Candidate.contractSHA256){throw 'Exact deployment contract bytes required'}
 $contract=Read $Candidate.contractFile
 if($contract.kind -cne 'deployment-required-contract' -or $contract.closureVerified -cne $true -or $contract.toolCalls -ne 0 -or $contract.leasesOpened -ne 0 -or $contract.toolHash -cne $Candidate.toolHash){throw 'Candidate must pin its actual reviewed read-only MCP contract'}
 if($Before.surfaceProfile -cne 'business-full' -or $Candidate.bindingFile -cne $Before.webManagement.bindingFile -or $Candidate.bindingSHA256 -cne $Before.webManagement.bindingSha256){throw 'Policy update must preserve exact business-full manager binding'}
 $expected=Read (Join-Path (Split-Path $CandidateReceipt -Parent) 'workspace-config.before.json')
 $expected.remoteAuthority.readExpirySeconds=7200;$expected.remoteAuthority.writeExpirySeconds=7200;$expected.permissions.commandTimeoutMs=7200000
 if(-not (Same $expected $After)){throw 'Policy update permits only two lease durations and command duration'}
 $allowed=@('components/workspace-mcp/server.mjs','components/workspace-mcp/input-schemas.mjs','components/workspace-mcp/remote-authority.mjs','components/workspace-mcp/bounded-file-read.mjs','components/workspace-mcp/runtime-integrity.mjs','src/workspace-mcp.mjs','.aicc-release.json','workspace-drive-manifest.json')
 if(-not (Same (@($Candidate.changedFiles|Sort-Object)) (@($allowed|Sort-Object)))){throw 'Exact bounded-read policy file set required'}
 $registry=Read $registryFile
 if($Candidate.baseline -cne $registry.components.workspace.releaseRoot -or $Candidate.oldGateway -cne $registry.components['unified-mcp'].releaseRoot){throw 'Policy baseline must equal current installed registration'}
 $beforeFiles=@{};$afterFiles=@{}
 foreach($pair in @(@($Candidate.baseline,$beforeFiles),@($Candidate.backend,$afterFiles))){
  $prefix=[IO.Path]::GetFullPath($pair[0]).TrimEnd('\')+'\'
  foreach($item in Get-ChildItem -LiteralPath $pair[0] -Recurse -Force){
   if($item.LinkType){throw 'Linked backend entry refused'}
   if(-not $item.PSIsContainer){$relative=$item.FullName.Substring($prefix.Length).Replace('\','/');$pair[1][$relative]=Hash $item.FullName}
  }
 }
 foreach($relative in $beforeFiles.Keys){
  if(-not $afterFiles.ContainsKey($relative)){throw 'Original backend file removed'}
  if($relative -cnotin $allowed -and $beforeFiles[$relative] -cne $afterFiles[$relative]){throw "Unrelated backend changed: $relative"}
 }
 foreach($relative in $afterFiles.Keys){if(-not $beforeFiles.ContainsKey($relative) -and $relative -cne 'components/workspace-mcp/bounded-file-read.mjs'){throw 'Unexpected backend addition'}}
 foreach($pin in $Candidate.policyPins){if($pin.path -cnotin $allowed -or $afterFiles[$pin.path] -cne $pin.sha256){throw 'Policy source pin changed'}}
 if(@($Candidate.policyPins).Count -ne $allowed.Count){throw 'Every policy overlay requires a pin'}
 $gateway=Read (Join-Path $Candidate.gateway 'config.json');$expectedGateway=Read (Join-Path $Candidate.oldGateway 'config.json')
 if((Hash (Join-Path $Candidate.gateway 'gateway.cjs')) -cne (Hash (Join-Path $Candidate.oldGateway 'gateway.cjs'))){throw 'Gateway code must remain identical'}
 $workspace=@($expectedGateway.providers|Where-Object id -CEQ 'workspace')[0]
 foreach($pin in $workspace.files){
  if($pin.path -ieq $configFile){$pin.sha256=$Candidate.configDesiredSHA256}
  elseif($pin.path.StartsWith($Candidate.baseline+'\',[StringComparison]::OrdinalIgnoreCase)){$relative=$pin.path.Substring($Candidate.baseline.Length+1);$pin.path=Join-Path $Candidate.backend $relative;$pin.sha256=Hash $pin.path}
 }
 $newPath=Join-Path $Candidate.backend 'components/workspace-mcp/bounded-file-read.mjs'
 if($newPath -cnotin @($workspace.files.path)){$workspace.files=@($workspace.files)+@(@{path=$newPath;sha256=(Hash $newPath)})}
 $workspace.toolHash=$Candidate.toolHash
$workspace.entrypoint=$workspace.entrypoint.Replace($Candidate.baseline,$Candidate.backend)
 $workspace.args=@($workspace.args|ForEach-Object {if($_ -is [string]){$_.Replace($Candidate.baseline,$Candidate.backend)}else{$_}})
 if(-not (Same $expectedGateway $gateway)){throw 'Gateway graph must preserve Native and only repin reviewed Workspace backend/config'}
}


function Assert-BrokerInventory([string]$Root,[string]$InventoryFile,[string]$ExpectedHash){
 if((Hash $InventoryFile) -cne $ExpectedHash){throw 'Broker inventory bytes changed'}
 $null=Same-ExactPath $Root $Root 'directory'
 $prefix=[IO.Path]::GetFullPath($Root).TrimEnd('\')+'\';$files=@{}
 foreach($row in @(Read $InventoryFile)){
  if(-not $row.path -or $row.path.Contains('\') -or $row.path -cmatch '(^|/)(\.|\.\.)($|/)' -or $files.ContainsKey($row.path)){throw 'Exact unique relative inventory paths required'}
  $target=[IO.Path]::GetFullPath((Join-Path $Root $row.path))
  if(-not $target.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or (Hash $target) -cne $row.sha256 -or (Get-Item -LiteralPath $target).Length -ne $row.size){throw 'Broker full inventory differs from actual bytes'}
  $files[$row.path]=$row
 }
 $actual=0
 foreach($entry in Get-ChildItem -LiteralPath $Root -Recurse -Force){if($entry.LinkType){throw 'Linked broker release entry refused'};if(-not $entry.PSIsContainer){$actual++}}
 if($actual -ne $files.Count){throw 'Uninventoried broker release entry refused'}
 return $files
}
function Assert-OwnerCommandApproval($Candidate){
 if($Candidate.kind -cnotin @('workspace-patch-parent-update','workspace-owner-environment-update') -or -not $Candidate.ownerCommandApprovalFile -or (Hash $Candidate.ownerCommandApprovalFile) -cne $Candidate.ownerCommandApprovalSHA256){throw 'Exact explicit owner command approval required'}
 $a=Read $Candidate.ownerCommandApprovalFile
 $now=[DateTimeOffset]::UtcNow
 if($a.kind -cne 'workspace-owner-command-approval/v1' -or $a.source -cne 'explicit-user-message' -or $a.owner_task_id -cne $env:CODEX_THREAD_ID -or $a.permission -cne 'owner-unrestricted-windows' -or $a.githubBackup -cne 'DEFERRED_BY_USER' -or $a.baseline -cne $Candidate.baseline -or $a.backend -cne $Candidate.backend -or $a.configBeforeSHA256 -cne $Candidate.configBeforeSHA256 -or $a.configDesiredSHA256 -cne $Candidate.configDesiredSHA256 -or [DateTimeOffset]::Parse($a.expiresAt) -le $now -or [DateTimeOffset]::Parse($a.expiresAt) -gt $now.AddHours(2)){throw 'Owner command approval scope, owner or expiry differs'}
 return $a
}
function Assert-BrokerSecurityDelta($Candidate,$Before,$After){
 $proof=$Candidate.brokerSecurity;$patchParents=$Candidate.kind -ceq 'workspace-patch-parent-update';$ownerEnv=$Candidate.kind -ceq 'workspace-owner-environment-update';$storeCheckpoint=$Candidate.kind -ceq 'workspace-store-checkpoint-update';$lifecycle=$Candidate.kind -ceq 'workspace-process-lifecycle-update'
 $broker=if($lifecycle){'components/workspace-mcp/server.mjs'}elseif($storeCheckpoint){'src/jobs/durable-store.mjs'}elseif($ownerEnv){'components/workspace-mcp/server.mjs'}elseif($patchParents){'components/workspace-mcp/platform-ops.mjs'}else{'tools/platform/windows/Invoke-AiccWorkspaceSandbox.ps1'}
 $overlayKey=if($lifecycle){'processLifecycleOverlay'}elseif($storeCheckpoint){'storeCheckpointOverlay'}elseif($ownerEnv){'ownerEnvironmentOverlay'}elseif($patchParents){'patchParentOverlay'}else{'brokerSecurityOverlay'}
 $allowed=@($broker,'.aicc-release.json','workspace-drive-manifest.json')
 $ownerModule='components/workspace-mcp/windows-owner-environment.mjs'
 $ownerIntegrity='components/workspace-mcp/runtime-integrity.mjs'
 if($ownerEnv){$allowed+=@($ownerModule,$ownerIntegrity)}
 if(-not (Same @($Candidate.changedFiles|Sort-Object) @($allowed|Sort-Object))){throw 'Exact three-file broker security delta required'}
 $expectedConfig=$Before|ConvertTo-Json -Depth 60|ConvertFrom-Json -AsHashtable -DateKind String
 if($Candidate.ownerCommandApprovalFile){
  $null=Assert-OwnerCommandApproval $Candidate
  $requiredMode=if($ownerEnv){'owner-unrestricted-windows'}else{'appcontainer-windows'}
  if($Before.permissions.commandIsolation -cne $requiredMode -or $Before.permissions.commands -cne $true -or $Before.permissions.network -cne $true){throw 'Owner mode requires existing explicit commands and network permissions'}
  $expectedConfig.permissions.commandIsolation='owner-unrestricted-windows'
 }elseif($Candidate.configBeforeSHA256 -cne $Candidate.configDesiredSHA256){throw 'Unapproved owner config change'}
 if($Before.surfaceProfile -cne 'business-full' -or -not (Same $expectedConfig $After) -or $Candidate.bindingFile -cne $Before.webManagement.bindingFile -or $Candidate.bindingSHA256 -cne $Before.webManagement.bindingSha256){throw 'Broker security must preserve exact owner config and manager binding'}
 if($proof.schemaVersion -ne 1 -or $proof.baseline -cne $Candidate.baseline -or $proof.oldGateway -cne $Candidate.oldGateway -or $proof.brokerRelative -cne $broker -or $proof.configSHA256 -cne $Candidate.configBeforeSHA256 -or $proof.profileSHA256 -cne $Candidate.profileBeforeSHA256 -or $proof.baselineInventorySHA256 -cne $proof.inventoryBeforeSHA256){throw 'Broker security proof differs from candidate'}
 $beforeFiles=Assert-BrokerInventory $Candidate.baseline $proof.inventoryBeforeFile $proof.inventoryBeforeSHA256
 $afterFiles=Assert-BrokerInventory $Candidate.backend $proof.inventoryDesiredFile $proof.inventoryDesiredSHA256
 $expectedKeys=@($beforeFiles.Keys);if($ownerEnv){if($beforeFiles.ContainsKey($ownerModule)){throw 'Owner environment module already installed'};$expectedKeys+=@($ownerModule)}
 if(-not (Same @($expectedKeys|Sort-Object) @($afterFiles.Keys|Sort-Object))){throw 'Broker security file set changed'}
 $changed=@($afterFiles.Keys|Where-Object {-not $beforeFiles.ContainsKey($_) -or $beforeFiles[$_].sha256 -cne $afterFiles[$_].sha256 -or $beforeFiles[$_].size -ne $afterFiles[$_].size}|Sort-Object)
 if(-not (Same $changed @($allowed|Sort-Object)) -or $beforeFiles[$broker].sha256 -cne $proof.brokerBefore -or $afterFiles[$broker].sha256 -cne $proof.brokerAfter){throw 'Broker security exceeds exact approved delta'}
 $overlay=@{};foreach($key in $proof.Keys){if($key -cnotin @('inventoryBeforeFile','inventoryBeforeSHA256','inventoryDesiredFile','inventoryDesiredSHA256')){$overlay[$key]=$proof[$key]}}
 $expected=Read (Join-Path $Candidate.baseline '.aicc-release.json');$rows=@($expected.files|Where-Object path -CEQ $broker)
 if($rows.Count -ne 1 -or $rows[0].sha256 -cne $proof.brokerBefore){throw 'Exact broker release preimage required'}
 $rows[0].sha256=$proof.brokerAfter;$rows[0].size=$afterFiles[$broker].size
 if($ownerEnv){
  $integrity=Read (Join-Path $Candidate.baseline '.aicc-release.json');$integrity=@($integrity.files|Where-Object path -CEQ $ownerIntegrity)
  if($integrity.Count -ne 1 -or $integrity[0].sha256 -cne $beforeFiles[$ownerIntegrity].sha256){throw 'Exact runtime integrity preimage required'}
  $anchor="  'components/workspace-mcp/runtime-marker.mjs',"
  $originalIntegrity=[IO.File]::ReadAllText((Join-Path $Candidate.baseline $ownerIntegrity))
  if($originalIntegrity.Split([string[]]@($anchor),[StringSplitOptions]::None).Count -ne 2 -or [IO.File]::ReadAllText((Join-Path $Candidate.backend $ownerIntegrity)) -cne $originalIntegrity.Replace($anchor,$anchor+"`n  'components/workspace-mcp/windows-owner-environment.mjs',")){throw 'Runtime integrity update exceeds its exact declared module'}
  $row=@($expected.files|Where-Object path -CEQ $ownerIntegrity)[0];$row.sha256=$afterFiles[$ownerIntegrity].sha256;$row.size=$afterFiles[$ownerIntegrity].size
  $expected.files=@($expected.files)+@(@{path=$ownerModule;sha256=$proof.ownerModuleSHA256;size=$afterFiles[$ownerModule].size})
 }
 $expected.fileCount=@($expected.files).Count;$expected.totalBytes=[long](($expected.files|Measure-Object -Property size -Sum).Sum);$expected[$overlayKey]=$overlay
 if(-not (Same $expected (Read (Join-Path $Candidate.backend '.aicc-release.json')))){throw 'Broker release metadata exceeds exact overlay'}
 $expected=Read (Join-Path $Candidate.baseline 'workspace-drive-manifest.json')
 if($expected.files[$broker] -cne $proof.brokerBefore){throw 'Exact broker drive preimage required'}
 $expected.baseline=$Candidate.baseline;$expected.release=$Candidate.backend;$expected.files[$broker]=$proof.brokerAfter;$expected.files['.aicc-release.json']=$afterFiles['.aicc-release.json'].sha256;$expected[$overlayKey]=$overlay
 if($ownerEnv){$expected.files[$ownerModule]=$proof.ownerModuleSHA256;$expected.files[$ownerIntegrity]=$afterFiles[$ownerIntegrity].sha256}
 if(-not (Same $expected (Read (Join-Path $Candidate.backend 'workspace-drive-manifest.json')))){throw 'Broker drive metadata exceeds exact overlay'}
 if((Hash (Join-Path $Candidate.oldGateway 'config.json')) -cne $Candidate.oldGatewayConfigSHA256 -or (Hash (Join-Path $Candidate.oldGateway 'manifest.json')) -cne $Candidate.oldGatewayManifestSHA256){throw 'Original broker gateway changed'}
 foreach($root in @($Candidate.oldGateway,$Candidate.gateway)){
  $null=Same-ExactPath $root $root 'directory'
  if(-not (Same @(Get-ChildItem -LiteralPath $root -Force|ForEach-Object {if($_.PSIsContainer -or $_.LinkType){throw 'Exact gateway regular closure required'};$_.Name}|Sort-Object) @('config.json','gateway.cjs','manifest.json'))){throw 'Exact gateway three-file closure required'}
 }
 $expected=Read (Join-Path $Candidate.oldGateway 'config.json');$workspace=@($expected.providers|Where-Object id -CEQ 'workspace')
 if($expected.hostControl -cne 'task-owned-v1' -or -not (Same @($expected.providers.id|Sort-Object) @('host','native','workspace')) -or $workspace.Count -ne 1){throw 'Existing three-provider broker graph required'}
 $workspace=$workspace[0];$prefix=$Candidate.baseline.TrimEnd('\')+'\'
 if(-not $workspace.entrypoint.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Workspace entry must belong to exact broker baseline'}
 $workspace.entrypoint=$Candidate.backend+$workspace.entrypoint.Substring($Candidate.baseline.Length)
 $workspace.args=@($workspace.args|ForEach-Object {if($_ -is [string] -and $_.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$Candidate.backend+$_.Substring($Candidate.baseline.Length)}else{$_}})
 foreach($pin in $workspace.files){if($pin.path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$relative=$pin.path.Substring($prefix.Length).Replace('\','/');if(-not $afterFiles.ContainsKey($relative)){throw 'Broker graph dependency missing from full inventory'};$pin.path=Join-Path $Candidate.backend $relative;$pin.sha256=$afterFiles[$relative].sha256}elseif($Candidate.ownerCommandApprovalFile -and $pin.path -ieq $configFile){$pin.sha256=$Candidate.configDesiredSHA256}}
 if($ownerEnv){$workspace.files=@($workspace.files)+@(@{path=(Join-Path $Candidate.backend $ownerModule);sha256=$proof.ownerModuleSHA256})}
 if(-not (Same $expected (Read (Join-Path $Candidate.gateway 'config.json')))){throw 'Broker graph must preserve host/native/tool authority and only rebind Workspace backend'}
 $expected=Read (Join-Path $Candidate.oldGateway 'manifest.json')
 foreach($relative in $expected.files.Keys){if($relative -cnotin @('config.json','gateway.cjs') -or (Hash (Join-Path $Candidate.oldGateway $relative)) -cne $expected.files[$relative]){throw 'Original broker gateway manifest pin differs'}}
 $expected.files['config.json']=$Candidate.gatewayConfigSHA256;$expected.releaseHash=$Candidate.gatewayConfigSHA256
 if(-not (Same $expected (Read (Join-Path $Candidate.gateway 'manifest.json'))) -or (Hash (Join-Path $Candidate.gateway 'gateway.cjs')) -cne (Hash (Join-Path $Candidate.oldGateway 'gateway.cjs'))){throw 'Broker gateway code or unrelated manifest metadata changed'}
 $text=[IO.File]::ReadAllText($profileFile)
 $spellings=@(@($Candidate.oldGateway,$Candidate.oldGateway.Replace('\','/'),$Candidate.oldGateway.Replace('\','\\'))|Select-Object -Unique|Where-Object {$text.Contains($_)})
 if($spellings.Count -ne 1 -or $text.Split([string[]]@($spellings[0]),[StringSplitOptions]::None).Count -ne 3){throw 'Exact broker gateway profile binding required'}
 $spelling=$spellings[0];$replacement=if($spelling -ceq $Candidate.oldGateway){$Candidate.gateway}elseif($spelling -ceq $Candidate.oldGateway.Replace('\','/')){$Candidate.gateway.Replace('\','/')}else{$Candidate.gateway.Replace('\','\\')}
 if([IO.File]::ReadAllText($Candidate.profileDesiredFile) -cne $text.Replace($spelling,$replacement)){throw 'Broker profile exceeds exact gateway path replacement'}
}
function Assert-BrokerSecurityUpdate($Candidate,$Before,$After){
 $proof=$Candidate.brokerSecurity
 if($Candidate.kind -ceq 'workspace-process-lifecycle-update'){
  if($Candidate.ownerCommandApprovalFile -or $Candidate.configBeforeSHA256 -cne $Candidate.configDesiredSHA256){throw 'Process lifecycle must preserve owner permissions exactly'}
  if($proof.brokerBefore -cne '2da4070c6c7f1150cefecc0ce55ddc0a3e1dd26dcb6142fa92f646a5b36c56b7' -or $proof.brokerAfter -cne 'fee332972d428d2179fd087461bfd92563b0153d5044c124f2a3afa40511cfe3' -or (Hash $proof.sourceBroker) -cne $proof.brokerAfter -or (Hash $proof.acceptanceFile) -cne $proof.acceptanceSHA256){throw 'Exact reviewed process lifecycle revision and test receipt required'}
  $accepted=Read $proof.acceptanceFile
  if($accepted.state -cne 'PROCESS_LIFECYCLE_SOURCE_ACCEPTED' -or $accepted.exitCode -ne 0 -or $accepted.sourceSHA256 -cne $proof.brokerAfter -or $accepted.pass -ne 15 -or $accepted.fail -ne 0 -or (Hash $accepted.testFile) -cne $accepted.testSHA256 -or (Hash $accepted.outputFile) -cne $accepted.outputSHA256){throw 'Actual exact process exit, stream closure and stop response tests required'}
  $graph=Read (Join-Path $Candidate.gateway 'config.json');$node=@($graph.providers|Where-Object id -CEQ 'workspace')[0].command
  $auditModule=([uri](Join-Path $Candidate.backend 'components/workspace-mcp/runtime-integrity.mjs')).AbsoluteUri
  $audit=& $node --input-type=module -e 'const m=await import(process.argv[1]);const a=m.workspaceMcpRuntimeClosureAudit(process.argv[2]);process.stdout.write(JSON.stringify({ok:a.ok,missing:a.missing,extra:a.extra}));if(!a.ok)process.exitCode=7' $auditModule $Candidate.backend
  if($LASTEXITCODE -ne 0 -or -not $audit -or ($audit|ConvertFrom-Json -AsHashtable).ok -cne $true){throw 'Actual process lifecycle candidate static import closure must pass'}
 }elseif($Candidate.kind -ceq 'workspace-store-checkpoint-update'){
  if($Candidate.ownerCommandApprovalFile -or $Candidate.configBeforeSHA256 -cne $Candidate.configDesiredSHA256){throw 'Store checkpoint must preserve owner permissions exactly'}
  if($proof.brokerBefore -cne 'e870a356b5a5431df430ff69f91e7501a55486b26deb35e4834ef3e2b57edc39' -or $proof.brokerAfter -cne '80f8037b943254c792e76d18bfa8167cc1a39819e9b189cd16d047863c9a1933' -or (Hash $proof.sourceBroker) -cne $proof.brokerAfter -or (Hash $proof.acceptanceFile) -cne $proof.acceptanceSHA256){throw 'Exact reviewed store checkpoint revision and test receipt required'}
  $accepted=Read $proof.acceptanceFile
  if($accepted.state -cne 'STORE_CHECKPOINT_SOURCE_ACCEPTED' -or $accepted.exitCode -ne 0 -or $accepted.sourceSHA256 -cne $proof.brokerAfter -or $accepted.pass -ne 9 -or $accepted.fail -ne 0 -or (Hash $accepted.testFile) -cne $accepted.testSHA256 -or (Hash $accepted.outputFile) -cne $accepted.outputSHA256){throw 'Actual exact store checkpoint crash, contention and preservation tests required'}
 }elseif($Candidate.kind -ceq 'workspace-owner-environment-update'){
  $null=Assert-OwnerCommandApproval $Candidate
  if($proof.brokerBefore -cne '6cc8309ce3f36f5f14540fe33441024983f1fab017aeb42a6b99e0d233171393' -or $proof.brokerAfter -cne '2da4070c6c7f1150cefecc0ce55ddc0a3e1dd26dcb6142fa92f646a5b36c56b7' -or $proof.ownerModuleSHA256 -cne 'b8f7e9459afdb044c70a51c8aee3cbfc71e79d97c1bdefb12907c9edc978d70a' -or (Hash $proof.sourceBroker) -cne $proof.brokerAfter -or (Hash $proof.sourceOwnerModule) -cne $proof.ownerModuleSHA256 -or (Hash $proof.acceptanceFile) -cne $proof.acceptanceSHA256){throw 'Exact reviewed owner environment revision required'}
  $accepted=Read $proof.acceptanceFile
  if($accepted.state -cne 'OWNER_ENVIRONMENT_SOURCE_ACCEPTED' -or $accepted.exitCode -ne 0 -or $accepted.sourceSHA256 -cne $proof.brokerAfter -or $accepted.moduleSHA256 -cne $proof.ownerModuleSHA256 -or $accepted.pass -ne 3 -or $accepted.fail -ne 0 -or (Hash $accepted.testFile) -cne $accepted.testSHA256 -or (Hash $accepted.outputFile) -cne $accepted.outputSHA256){throw 'Actual owner environment source acceptance required'}
  $graph=Read (Join-Path $Candidate.gateway 'config.json');$node=@($graph.providers|Where-Object id -CEQ 'workspace')[0].command
  $auditModule=([uri](Join-Path $Candidate.backend 'components/workspace-mcp/runtime-integrity.mjs')).AbsoluteUri
  $audit=& $node --input-type=module -e 'const m=await import(process.argv[1]);const a=m.workspaceMcpRuntimeClosureAudit(process.argv[2]);process.stdout.write(JSON.stringify({ok:a.ok,missing:a.missing,extra:a.extra}));if(!a.ok)process.exitCode=7' $auditModule $Candidate.backend
  if($LASTEXITCODE -ne 0 -or -not $audit -or ($audit|ConvertFrom-Json -AsHashtable).ok -cne $true){throw 'Actual candidate static import closure must pass before maintenance'}
 }elseif($Candidate.kind -ceq 'workspace-patch-parent-update'){
  if($proof.brokerBefore -cne 'd132a4f6e3aebe1688b84c852d7662a6381d7f66811f03073cc3320992712291' -or $proof.brokerAfter -cne '0f1c782e6f34e5bb26b6fa62430b6e9341b7534d27cd2439227b41bf81f0b1b3' -or (Hash $proof.sourceBroker) -cne $proof.brokerAfter -or (Hash $proof.acceptanceFile) -cne $proof.acceptanceSHA256){throw 'Exact reviewed patch-parent revision and test receipt required'}
  $accepted=Read $proof.acceptanceFile
  if($accepted.state -cne 'PATCH_PARENT_SOURCE_ACCEPTED' -or $accepted.exitCode -ne 0 -or $accepted.sourceSHA256 -cne $proof.brokerAfter -or $accepted.pass -ne 4 -or $accepted.fail -ne 0 -or (Hash $accepted.testFile) -cne $accepted.testSHA256 -or (Hash $accepted.outputFile) -cne $accepted.outputSHA256){throw 'Actual exact patch-parent source test evidence required'}
 }else{
 if($proof.brokerBefore -cne 'bdd8ca28226bbcc345d146696a300c251dd00f024a8bb3bfbe93cfdec864bb54' -or $proof.brokerAfter -cne 'de42e8086615d20178dff7c2a1126ea42949c2bb268d697b2e9275a4bc0b5714' -or (Hash $proof.sourceBroker) -cne $proof.brokerAfter -or (Hash $proof.acceptanceFile) -cne $proof.acceptanceSHA256){throw 'Exact reviewed broker security revision and source acceptance required'}
 $accepted=Read $proof.acceptanceFile
 if($accepted.state -cne 'SOURCE_STANDARD_SECURITY_ACCEPTED' -or $accepted.elevated -cne $false -or $accepted.exitCode -ne 0 -or $accepted.sourceHelperSHA256 -cne $proof.brokerAfter -or $accepted.output -cne "ENV_OPEN_DENIED_BYTES_READ_0_UTF8_WRITE_OK`r`n"){throw 'Exact standard-user source security acceptance required'}
 }
 $registry=Read $registryFile
 if((Hash $registryFile) -cne $proof.registrySHA256 -or $Candidate.baseline -cne $registry.components.workspace.releaseRoot -or $Candidate.oldGateway -cne $registry.components['unified-mcp'].releaseRoot -or (Hash $configFile) -cne $proof.configSHA256 -or (Hash $profileFile) -cne $proof.profileSHA256){throw 'Broker security live preimage changed'}
 Assert-BrokerSecurityDelta $Candidate $Before $After
}
function Assert-ChangeBackupPolicy($Candidate,$Backup){
 $ownerLocal=$Candidate.kind -cin @('workspace-patch-parent-update','workspace-owner-environment-update') -and $Backup.kind -ceq 'workspace-owner-approved-local-backup/v1'
 if($ownerLocal){$null=Assert-OwnerCommandApproval $Candidate;if($Backup.githubStatus -cne 'DEFERRED_BY_USER' -or $Backup.localStatus -cne 'PREPARED'){throw 'Actual user-deferred GitHub and prepared local backup required'}}
 if(($Candidate.kind -ceq 'host-runtime-update' -and $Backup.kind -ceq 'host-runtime-local-backup/v1') -or $ownerLocal){
  if($Backup.localStatus -cne 'PREPARED'){throw 'Actual prepared local host recovery bundle required'}
  $bundleFile=Regular $Backup.bundlePath
  if((Hash $bundleFile) -cne $Backup.bundleSHA256){throw 'Local recovery inventory changed'}
  $bundle=Read $bundleFile
  if($bundle.schemaVersion -ne 1 -or $bundle.kind -cne $Backup.kind){throw 'Exact local recovery inventory required'}
  $base=(Split-Path $bundleFile -Parent).TrimEnd('\')+'\'
  $sources=@{}
  foreach($row in $bundle.files){
   if(-not [IO.Path]::IsPathFullyQualified($row.path) -or [IO.Path]::IsPathRooted($row.backupFile)){throw 'Exact source and relative backup required'}
   $copy=[IO.Path]::GetFullPath((Join-Path $base $row.backupFile))
   if(-not $copy.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or (Hash $copy) -cne $row.sha256){throw 'Actual local recovery bytes differ'}
   $sources[[IO.Path]::GetFullPath($row.path)]=$row.sha256
  }
  $required=@($PSCommandPath,$CandidateReceipt,$registryFile,$configFile,$profileFile,$receiptFile,$launcherFile,(Join-Path $Candidate.oldGateway 'config.json'),(Join-Path $Candidate.oldGateway 'manifest.json'),(Join-Path $Candidate.gateway 'config.json'),(Join-Path $Candidate.gateway 'manifest.json'))
  if($ownerLocal){$required+=@($Candidate.ownerCommandApprovalFile,$Candidate.configDesiredFile,$Candidate.profileDesiredFile)}else{$required+=Join-Path $Candidate.hostRoot 'host.cjs'}
  if($Candidate.kind -ceq 'host-runtime-update' -and $Candidate.hostConfigUnchanged -ceq $false){
   $required+=@($Candidate.oldHostConfigFile,$Candidate.hostConfigDesiredFile,$Candidate.cdpBinding.bindingFile,
     $Candidate.cdpBinding.coordinationFile,$Candidate.preparerSourceFile,(Join-Path $Candidate.hostRoot 'manifest.json'))
   # Raw npm/pnpm Playwright and audit entries may be HardLinks. They are
   # *source provenance*, not recoverable executables; the immutable copied
   # closure enters the regular-only backup instead.
   $raw=@($Candidate.cdpBinding.bindingFile|ForEach-Object {(Read $_).cdp.playwrightModule;(Read $_).cdp.identityAuditModule})
   $required+=@($Candidate.cdpBinding.dependencies|Where-Object {$_.file -cnotin $raw}|ForEach-Object {$_.file})
   $required+=@($Candidate.dependencyMaterialization.files.Keys|ForEach-Object {Join-Path $Candidate.hostRoot ($_.Replace('/','\'))})
   $required+=$Candidate.dependencyMaterialization.manifestFile
   $required+=@($Candidate.hostSourceClosure.pins|ForEach-Object {Join-Path $Candidate.hostSourceRoot $_.relative})
  }
  $original=Read (Join-Path $Candidate.oldGateway 'config.json')
  $required+=@($original.providers|Where-Object id -CEQ 'host'|ForEach-Object entrypoint)
  foreach($file in $required){$full=[IO.Path]::GetFullPath($file);if(-not $sources.ContainsKey($full) -or (Hash $full) -cne $sources[$full]){throw 'Required host recovery source is missing or changed'}}
  return
 }
 if($Backup.githubStatus -cne 'VERIFIED' -or $Backup.notionStatus -cne 'VERIFIED'){throw 'Actual two-destination change backup required'}
}
function Assert-BrokerSecurityBackup($Candidate,$Backup){
 if($Candidate.kind -cnotin @('workspace-broker-security-update','workspace-patch-parent-update','workspace-owner-environment-update','workspace-store-checkpoint-update','workspace-process-lifecycle-update')){return}
 $proof=$Candidate.brokerSecurity;$bundle=Read $Backup.bundlePath;$hashes=@($bundle.files.sha256)
 $required=@($PSCommandPath,$CandidateReceipt,$proof.inventoryBeforeFile,$proof.inventoryDesiredFile,$proof.sourceBroker,$proof.acceptanceFile,$registryFile,$configFile,$profileFile,$receiptFile,$launcherFile,$Candidate.profileDesiredFile,$Candidate.bindingFile)
 foreach($root in @($Candidate.baseline,$Candidate.backend)){foreach($relative in $Candidate.changedFiles){if($Candidate.kind -ceq 'workspace-owner-environment-update' -and $root -ceq $Candidate.baseline -and $relative -ceq 'components/workspace-mcp/windows-owner-environment.mjs'){continue};$required+=Join-Path $root $relative}}
 foreach($root in @($Candidate.oldGateway,$Candidate.gateway)){foreach($relative in @('config.json','manifest.json')){$required+=Join-Path $root $relative}}
 foreach($file in $required){if((Hash $file) -cnotin $hashes){throw 'Broker security backup must contain exact new helper, candidate, proof and recovery delta'}}
 if($Candidate.kind -cin @('workspace-patch-parent-update','workspace-owner-environment-update','workspace-store-checkpoint-update','workspace-process-lifecycle-update')){$accepted=Read $proof.acceptanceFile;foreach($file in @($accepted.testFile,$accepted.outputFile)){if((Hash $file) -cnotin $hashes){throw 'Patch-parent backup must contain actual tests and output'}}}
 if($Candidate.kind -ceq 'workspace-owner-environment-update' -and (Hash $proof.sourceOwnerModule) -cnotin $hashes){throw 'Owner environment module must have actual recovery bytes'}
}

function Get-HostCdpRegisteredSlots([string]$CoordinationFile){
 $section='';$values=@{}
 foreach($raw in [IO.File]::ReadAllLines((Regular $CoordinationFile))){
  $line=$raw.Trim()
  if(-not $line -or $line.StartsWith('#')){continue}
  if($line -cmatch '^\[([^\]]+)\]$'){$section=$Matches[1];continue}
  if($section -cne 'browser' -or $line -cnotmatch '^([A-Za-z0-9_]+)\s*=\s*(.*)$'){continue}
  $key=$Matches[1];$value=$Matches[2].Trim()
  if($key -cnotmatch '^cdp_slot(?:_count|[0-9]+_)'){continue}
  if($values.ContainsKey($key)){throw 'CDP_COORDINATION_DUPLICATE_SLOT_FIELD'}
  if($value -cmatch '^"([^"]*)"\s*(?:#.*)?$'){$values[$key]=$Matches[1]}
  elseif($value -cmatch '^([0-9]+)\s*(?:#.*)?$'){$values[$key]=$Matches[1]}
  else{$values[$key]=$null}
 }
 $count=0
 if(-not [int]::TryParse([string]$values['cdp_slot_count'],[ref]$count) -or $count -lt 1 -or $count -gt 32){throw 'CDP_COORDINATION_COUNT_UNPROVEN'}
 $slots=@()
 for($i=1;$i -le $count;$i++){
  $p='cdp_slot'+$i+'_';$slot=@{}
  foreach($key in @('port','profile_dir','profile_directory','account_alias','workspace','usage')){$slot[$key]=$values[$p+$key]}
  $port=0
  if(-not [int]::TryParse([string]$slot.port,[ref]$port) -or $port -lt 1024 -or $port -gt 65535 -or
     -not $slot.profile_dir -or -not $slot.account_alias -or -not $slot.workspace -or -not $slot.usage){throw 'CDP_COORDINATION_REGISTRATION_INCOMPLETE'}
  $slot.port=$port;$slots+=,$slot
 }
 return ,$slots
}
function Assert-HostCdpBinding($Candidate,$OldHost,$NewHost){
 $proof=$Candidate.cdpBinding
 if($Candidate.hostConfigUnchanged -cne $false -or $proof.schemaVersion -ne 1 -or $proof.kind -cne 'host-cdp-owner-binding/v1' -or
   $Candidate.oldHostConfigFile -cne $OldHost.args[2] -or $Candidate.oldHostConfigSHA256 -cne (Hash $OldHost.args[2]) -or
   $Candidate.hostConfigDesiredFile -cne (Join-Path $Candidate.hostRoot 'host-config.json') -or
   $NewHost.args[2] -cne $Candidate.hostConfigDesiredFile -or
   $Candidate.hostConfigDesiredSHA256 -cne (Hash $Candidate.hostConfigDesiredFile)){throw 'Exact immutable host CDP config candidate required'}
 $root=[IO.Path]::GetFullPath($Candidate.hostSourceRoot)
 if(-not (Same-ExactPath $root $root 'directory')){throw 'Exact source root required'}
 if($Candidate.preparerSourceFile -cne (Join-Path $root 'components\host-control\prepare-update.mjs') -or
    (Hash $Candidate.preparerSourceFile) -cne $Candidate.preparerSourceSHA256){throw 'Exact Host CDP preparer source changed'}
 $sourceFiles=@('components/host-control/server.mjs','components/host-control/cdp-browser.mjs','src/browser/cdp-lease-provider.mjs','src/browser/session-broker.mjs')
 if(-not (Same @($Candidate.hostSourceClosure.pins.relative|Sort-Object) @($sourceFiles|Sort-Object))){throw 'Exact host source closure required'}
 foreach($pin in $Candidate.hostSourceClosure.pins){
  if((Hash (Join-Path $root $pin.relative)) -cne $pin.sha256){throw 'Host CDP source closure pin changed'}
 }
 $expectedBindingKeys=@('schemaVersion','kind','hostConfigBeforeSha256','coordinationFile','coordinationSha256','cdp')
 $binding=Read $proof.bindingFile
 if(-not (Same @($binding.Keys|Sort-Object) @($expectedBindingKeys|Sort-Object)) -or
   $binding.kind -cne $proof.kind -or $binding.schemaVersion -ne 1 -or
   $binding.hostConfigBeforeSha256 -cne $Candidate.oldHostConfigSHA256 -or
   (Hash $proof.bindingFile) -cne $proof.bindingSha256 -or
   $proof.coordinationFile -cne (Join-Path $stateRoot 'guidance\coordination.toml') -or
   $binding.coordinationFile -cne $proof.coordinationFile -or
   $binding.coordinationSha256 -cne $proof.coordinationSha256 -or
   (Hash $proof.coordinationFile) -cne $proof.coordinationSha256){throw 'Exact owner-local CDP binding and coordination pin required'}
 $privateParent=[IO.Path]::GetFullPath($stateRoot).TrimEnd('\')+'\'
 if(-not [IO.Path]::GetFullPath($proof.bindingFile).StartsWith($privateParent,[StringComparison]::OrdinalIgnoreCase)){throw 'Owner CDP binding outside private state root'}
 $before=Read $OldHost.args[2];$after=Read $Candidate.hostConfigDesiredFile
 if($before.Contains('cdp') -or $before.schemaVersion -ne 1 -or $before.scope -cne 'task-owned-v1' -or $binding.cdp.enabled -cne $true){throw 'CDP must only be added to the original host config'}
 $allowedCdp=@('enabled','identities','leaseHelper','leaseHelperSha256','identityGuard','identityGuardSha256','powershellSha256','playwrightModule','playwrightModuleSha256','identityAuditModule','identityAuditModuleSha256','downloadRoot')
 if(@($binding.cdp.Keys|Where-Object {$_ -cnotin $allowedCdp}).Count -ne 0 -or
   @($allowedCdp|Where-Object {$_ -cne 'downloadRoot' -and -not $binding.cdp.Contains($_)}).Count -ne 0 -or
   @($binding.cdp.identities).Count -lt 1 -or @($binding.cdp.identities).Count -gt 16){throw 'CDP config scope or identity list unproven'}
 $materialized=$Candidate.dependencyMaterialization
 $kind=[string]$materialized.packageKind
 $entryRelative=switch -CaseSensitive ($kind){
  'playwright-core-only' {'node_modules\playwright-core\index.js';break}
  'playwright-plus-core' {'node_modules\playwright\index.js';break}
  default {throw 'Only the two official CDP Playwright package kinds are allowed'}
 }
 if($materialized.schemaVersion -ne 1 -or $materialized.kind -cne 'host-cdp-dependency-materialization/v1' -or
    $materialized.playwrightModule -cne (Join-Path $Candidate.hostRoot $entryRelative) -or
    -not $materialized.identityAuditModule.StartsWith((Join-Path $Candidate.hostRoot 'cdp-audit')+'\',[StringComparison]::OrdinalIgnoreCase)){
  throw 'Exact materialized CDP entry and package kind required'
 }
 $packageProof=Read $materialized.manifestFile
 $expectedPackages=if($kind -ceq 'playwright-core-only'){@('playwright-core')}else{@('playwright','playwright-core')}
 if($packageProof.packageKind -cne $kind -or
    $packageProof.playwrightRelative -cne $entryRelative.Replace('\','/') -or
    -not (Same @($packageProof.packageInfo.name|Sort-Object) @($expectedPackages|Sort-Object))){
  throw 'Exact Playwright source package kind and provenance required'
 }
 $expected=Read $OldHost.args[2];$expected['cdp']=($binding.cdp|ConvertTo-Json -Depth 60|ConvertFrom-Json -AsHashtable -DateKind String)
 $expected.cdp.playwrightModule=$materialized.playwrightModule
 $expected.cdp.playwrightModuleSha256=Hash $materialized.playwrightModule
 $expected.cdp.identityAuditModule=$materialized.identityAuditModule
 $expected.cdp.identityAuditModuleSha256=Hash $materialized.identityAuditModule
 if(-not (Same $expected $after)){throw 'Host config contains unrelated changes beyond additive materialized CDP'}
 $expectedHelper=Join-Path $root 'tools\platform\web-automation\Manage-CdpChromeSlotLease.ps1'
 $expectedGuard=Join-Path $root 'tools\platform\web-automation\Assert-CdpEndpointIdentity.ps1'
 if($binding.cdp.leaseHelper -cne $expectedHelper -or $binding.cdp.identityGuard -cne $expectedGuard){throw 'Official registered CDP helpers required'}
 foreach($pair in @(
   @($expectedHelper,$binding.cdp.leaseHelperSha256),@($expectedGuard,$binding.cdp.identityGuardSha256),
   @($before.powershell,$binding.cdp.powershellSha256),
   @($binding.cdp.playwrightModule,$binding.cdp.playwrightModuleSha256),
   @($binding.cdp.identityAuditModule,$binding.cdp.identityAuditModuleSha256)
  )){
   if($pair[1] -cnotmatch '^[a-f0-9]{64}$'){throw 'Official CDP dependency pin format drift'}
   # The raw npm/pnpm entrypoint may be a HardLink; the pinned JS
   # materialization verifier checks its SHA and full closure read-only.
   if($pair[0] -cnotin @($binding.cdp.playwrightModule,$binding.cdp.identityAuditModule) -and
     (Hash $pair[0]) -cne $pair[1]){throw 'Official CDP dependency pin drift'}
  }
 if($binding.cdp.Contains('downloadRoot')){
  if(-not [IO.Path]::IsPathFullyQualified($binding.cdp.downloadRoot) -or
     -not [IO.Path]::GetFullPath($binding.cdp.downloadRoot).StartsWith($privateParent,[StringComparison]::OrdinalIgnoreCase) -or
     -not (Same-ExactPath $binding.cdp.downloadRoot $binding.cdp.downloadRoot 'directory')){throw 'CDP download root outside owner-private scope'}
 }
 $slots=Get-HostCdpRegisteredSlots $proof.coordinationFile
 $seenIds=@{};$seenPorts=@{};$seenRoots=@{}
 $identityKeys=@('identityId','role','engine','appIdentity','executable','executableSha256','userDataRoot','profile','cdpEndpoint','accountAlias','workspaceAlias','owner','ownershipPolicy','sessionIdentityHash','workspaceIdentityHash')
 foreach($id in $binding.cdp.identities){
  if(-not (Same @($id.Keys|Sort-Object) @($identityKeys|Sort-Object)) -or
    $id.identityId -cnotmatch '^[a-zA-Z0-9_-]{1,64}$' -or $id.role -cne 'registered-cdp' -or
    $id.engine -cne 'chrome' -or $id.appIdentity -cne 'Google Chrome' -or
    $id.ownershipPolicy -cne 'task-created-target-only' -or -not $id.owner -or
    $id.sessionIdentityHash -cnotmatch '^[a-f0-9]{64}$' -or
    ($null -ne $id.workspaceIdentityHash -and $id.workspaceIdentityHash -cnotmatch '^[a-f0-9]{64}$') -or
    $id.cdpEndpoint -cnotmatch '^http://127\.0\.0\.1:([0-9]{4,5})$' -or
    -not [IO.Path]::IsPathFullyQualified($id.userDataRoot) -or -not [IO.Path]::IsPathFullyQualified($id.executable)){throw 'CDP identity format or authorization invalid'}
  $port=([Uri]$id.cdpEndpoint).Port
  $slot=@($slots|Where-Object { $_.port -eq $port})
  $profilePath=[IO.Path]::GetFullPath($id.userDataRoot)
  if($slot.Count -ne 1 -or $seenIds.ContainsKey($id.identityId) -or $seenPorts.ContainsKey($port) -or
    $seenRoots.ContainsKey($profilePath.ToLowerInvariant()) -or $id.accountAlias -cne $slot[0].account_alias -or
    $id.workspaceAlias -cne $slot[0].workspace -or
    $id.profile -cne $(if($slot[0].profile_directory){$slot[0].profile_directory}else{'Default'}) -or
    -not [string]::Equals($profilePath,[IO.Path]::GetFullPath($slot[0].profile_dir),[StringComparison]::OrdinalIgnoreCase) -or
    $slot[0].usage -match '(?i)pending|disabled|reserved|telegram_admin|admin_reserved' -or
    $id.executableSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    (Hash $id.executable) -cne $id.executableSha256 -or
    -not (Same-ExactPath $id.userDataRoot $id.userDataRoot 'directory')){throw 'CDP identity not registered to exact account, workspace, profile and port'}
  $seenIds[$id.identityId]=$true;$seenPorts[$port]=$true;$seenRoots[$profilePath.ToLowerInvariant()]=$true
 }
 $expectedDependencies=@()
 foreach($pair in @(@($binding.cdp.leaseHelper,$binding.cdp.leaseHelperSha256),
  @($binding.cdp.identityGuard,$binding.cdp.identityGuardSha256),
  @($before.powershell,$binding.cdp.powershellSha256),
  @($binding.cdp.playwrightModule,$binding.cdp.playwrightModuleSha256),
  @($binding.cdp.identityAuditModule,$binding.cdp.identityAuditModuleSha256))){
  $expectedDependencies+=@{file=[string]$pair[0];sha256=[string]$pair[1]}
 }
 foreach($id in $binding.cdp.identities){$expectedDependencies+=@{file=[string]$id.executable;sha256=[string]$id.executableSha256}}
 $dependencies=@($proof.dependencies)
 if($expectedDependencies.Count -ne $dependencies.Count){throw 'Exact owner CDP dependency receipt count required'}
 for($i=0;$i -lt $expectedDependencies.Count;$i++){
  if($expectedDependencies[$i].file -cne $dependencies[$i].file -or
     $expectedDependencies[$i].sha256 -cne $dependencies[$i].sha256){throw ('Exact owner CDP dependency receipt mismatch at '+$i+' pathEq='+($expectedDependencies[$i].file -ceq $dependencies[$i].file)+' shaEq='+($expectedDependencies[$i].sha256 -ceq $dependencies[$i].sha256))}
 }
 foreach($pair in @(@($binding.cdp.leaseHelper,$binding.cdp.leaseHelperSha256),
  @($binding.cdp.identityGuard,$binding.cdp.identityGuardSha256),
  @($before.powershell,$binding.cdp.powershellSha256),
  @($binding.cdp.playwrightModule,$binding.cdp.playwrightModuleSha256),
  @($binding.cdp.identityAuditModule,$binding.cdp.identityAuditModuleSha256))){
  if(@($dependencies|Where-Object {$_.file -ceq $pair[0] -and $_.sha256 -ceq $pair[1]}).Count -lt 1){throw 'CDP dependency receipt missing exact pin'}
 }
 foreach($id in $binding.cdp.identities){
  if(@($dependencies|Where-Object {$_.file -ceq $id.executable -and $_.sha256 -ceq $id.executableSha256}).Count -lt 1){throw 'CDP executable receipt pin missing'}
 }
 foreach($pin in $dependencies){
  if($pin.file -cnotin @($binding.cdp.playwrightModule,$binding.cdp.identityAuditModule) -and
    (Hash $pin.file) -cne $pin.sha256){throw 'CDP receipt dependency changed'}
 }
 # The existing pinned Node runtime runs a pure source/closure verifier.
 # Regular() stays strict for every installed executable/recovery byte;
 # raw HardLinks are inspected read-only, never used for launch/rollback.
 $verifyScript='(async()=>{const u=await import("node:url");const m=await import(u.pathToFileURL(process.argv[2]).href);const r=m.verifyMaterializedCdpRelease(process.argv[1]);process.stdout.write(JSON.stringify(r));})().catch(e=>{console.error(e.message);process.exitCode=1;});'
 $verification=& $OldHost.command --input-type=module -e $verifyScript $CandidateReceipt $Candidate.preparerSourceFile
 if($LASTEXITCODE -ne 0 -or -not $verification){throw 'Pinned Host CDP materialization closure verification failed'}
 $verified=$verification|ConvertFrom-Json -AsHashtable -DateKind String
 if($verified.ok -cne $true -or $verified.kind -cne 'host-cdp-dependency-materialization/v1' -or
   $verified.packageKind -cne $kind -or
   $verified.sourceClosureSHA256 -cne $materialized.sourceClosureSHA256){throw 'CDP materialization proof identity or import closure differs'}
 $hostManifest=Read (Join-Path $Candidate.hostRoot 'manifest.json')
 $expectedHostKeys=@('host-config.json','host.cjs')+@($materialized.files.Keys)
 if(-not (Same @($hostManifest.files.Keys|Sort-Object) @($expectedHostKeys|Sort-Object)) -or
   $hostManifest.files['host-config.json'] -cne $Candidate.hostConfigDesiredSHA256 -or
   $hostManifest.files['host.cjs'] -cne $Candidate.hostEntrySHA256){throw 'Immutable host release manifest must pin all CDP closure entries'}
 foreach($relative in $materialized.files.Keys){if($hostManifest.files[$relative] -cne $materialized.files[$relative]){throw 'Immutable Host dependency closure pin changed'}}
 $oldConfigPins=@($OldHost.files|Where-Object path -CEQ $OldHost.args[2])
 $newConfigPins=@($NewHost.files|Where-Object path -CEQ $NewHost.args[2])
 if($oldConfigPins.Count -ne 1 -or $newConfigPins.Count -ne 1 -or
    $oldConfigPins[0].sha256 -cne $Candidate.oldHostConfigSHA256 -or
    $newConfigPins[0].sha256 -cne $Candidate.hostConfigDesiredSHA256 -or
    @($NewHost.files|Where-Object path -CEQ $OldHost.args[2]).Count -ne 0){throw 'Only one config pin may move from original to immutable CDP config'}
}
function Assert-HostCdpRecoveryPreimage($Candidate,[string]$OperationDir){
 if($Candidate.kind -cne 'host-runtime-update' -or $Candidate.hostConfigUnchanged -cne $false){return}
 $file=Join-Path $OperationDir 'host-config.before'
 if((Hash $file) -cne $Candidate.oldHostConfigSHA256 -or
   (Hash $Candidate.oldHostConfigFile) -cne $Candidate.oldHostConfigSHA256){throw 'Original Host config recovery preimage changed'}
}

function Validate-Candidate($Candidate){
 $localSkillsRegistration=$Candidate.kind -ceq 'local-skills-registration'
 $backendPolicyUpdate=$Candidate.kind -ceq 'backend-policy-update'
 $hostRuntimeUpdate=$Candidate.kind -ceq 'host-runtime-update'
 $gptQueueUpdate=$Candidate.kind -ceq 'workspace-gpt-queue-update'
 $gptQueueReplacement=$Candidate.kind -ceq 'workspace-gpt-queue-owner-replacement'
 $brokerSecurityUpdate=$Candidate.kind -cin @('workspace-broker-security-update','workspace-patch-parent-update','workspace-owner-environment-update','workspace-store-checkpoint-update','workspace-process-lifecycle-update')
 if($Candidate.kind -and -not $localSkillsRegistration -and -not $backendPolicyUpdate -and -not $hostRuntimeUpdate -and -not $brokerSecurityUpdate -and -not $gptQueueUpdate -and -not $gptQueueReplacement){throw 'Unsupported explicit owner registration kind'}
 if($Candidate.schemaVersion -ne 1 -or $Candidate.status -cne 'PREPARED_NOT_ACTIVE' -or $Candidate.configFile -ine $configFile -or $Candidate.profile -ine $profileFile){throw 'Exact named-management candidate required'}
 foreach($pair in @(@($Candidate.backend,'workspace'),@($Candidate.gateway,'unified-mcp'))){
  $full=[IO.Path]::GetFullPath($pair[0]);$parent=(Join-Path $stateRoot ('releases\'+$pair[1])).TrimEnd('\')+'\'
  if(-not $full.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $full).LinkType){throw 'Managed candidate root required'}
 }
 foreach($pair in @(@($Candidate.configDesiredFile,$Candidate.configDesiredSHA256),@($Candidate.profileDesiredFile,$Candidate.profileDesiredSHA256),@($Candidate.bindingFile,$Candidate.bindingSHA256),@((Join-Path $Candidate.gateway 'config.json'),$Candidate.gatewayConfigSHA256))){if((Hash $pair[0]) -cne $pair[1]){throw 'Candidate pin changed'}}
 $before=Read (Join-Path (Split-Path $CandidateReceipt -Parent) 'workspace-config.before.json');$after=Read $Candidate.configDesiredFile
 if((Hash (Join-Path (Split-Path $CandidateReceipt -Parent) 'workspace-config.before.json')) -cne $Candidate.configBeforeSHA256){throw 'Candidate before config bytes changed'}
 if($gptQueueReplacement){Assert-GptQueueOwnerReplacementCandidate $Candidate $before $after;return}
 if($gptQueueUpdate){Assert-GptQueueRuntimeCandidate $Candidate $before $after;return}
 if($hostRuntimeUpdate){
  if($Candidate.backend -cne $Candidate.baseline -or $Candidate.configDesiredSHA256 -cne $Candidate.configBeforeSHA256 -or -not (Same $before $after)){throw 'Host update must preserve exact Workspace owner config and backend'}
  $original=Read (Join-Path $Candidate.oldGateway 'config.json');$gateway=Read (Join-Path $Candidate.gateway 'config.json')
  if($original.hostControl -cne 'task-owned-v1' -or $gateway.providers.Count -ne 3 -or (@($gateway.providers.id|Sort-Object) -join ',') -cne 'host,native,workspace'){throw 'Existing three-provider host graph required'}
  if((Hash (Join-Path $Candidate.gateway 'gateway.cjs')) -cne (Hash (Join-Path $Candidate.oldGateway 'gateway.cjs'))){throw 'Host update must preserve exact gateway code'}
  $oldManifest=Read (Join-Path $Candidate.oldGateway 'manifest.json');$nextManifest=Read (Join-Path $Candidate.gateway 'manifest.json')
  if((Hash (Join-Path $Candidate.oldGateway 'manifest.json')) -cne $Candidate.oldGatewayManifestSHA256){throw 'Original gateway manifest changed'}
  Assert-HostOverlayProvenance $Candidate $oldManifest
  $expectedManifest=Read (Join-Path $Candidate.oldGateway 'manifest.json');$expectedManifest.files['config.json']=$Candidate.gatewayConfigSHA256;$expectedManifest.releaseHash=$Candidate.gatewayConfigSHA256
  if(-not (Same $expectedManifest $nextManifest)){throw 'Candidate manifest must preserve unrelated metadata and pins'}
  if(-not (Same @($oldManifest.files.Keys|Sort-Object) @($nextManifest.files.Keys|Sort-Object))){throw 'Gateway manifest file set changed'}
  foreach($relative in $nextManifest.files.Keys){
   $target=[IO.Path]::GetFullPath((Join-Path $Candidate.gateway $relative));$parent=$Candidate.gateway.TrimEnd('\')+'\'
   if(-not $target.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -or (Hash $target) -cne $nextManifest.files[$relative]){throw 'Candidate gateway manifest pin changed'}
   if($relative -cne 'config.json' -and (Hash $target) -cne $oldManifest.files[$relative]){throw 'Unrelated gateway file changed'}
  }
  $oldHost=@($original.providers|Where-Object id -CEQ 'host');$newHost=@($gateway.providers|Where-Object id -CEQ 'host')
  if($oldHost.Count -ne 1 -or $newHost.Count -ne 1){throw 'One existing host provider required'}
  $oldHost=$oldHost[0];$newHost=$newHost[0]
  $hostRoot=[IO.Path]::GetFullPath($Candidate.hostRoot);$hostParent=(Join-Path $stateRoot 'releases\host-control').TrimEnd('\')+'\'
  if(-not $hostRoot.StartsWith($hostParent,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $hostRoot).LinkType -or $newHost.entrypoint -cne (Join-Path $hostRoot 'host.cjs') -or (Hash $newHost.entrypoint) -cne $Candidate.hostEntrySHA256){throw 'Managed immutable host candidate required'}
  if($oldHost.args.Count -ne 3 -or $newHost.args.Count -ne 3 -or $oldHost.args[1] -cne '--config' -or $newHost.args[1] -cne '--config'){throw 'Existing host arguments and scope must remain pinned'}
  if($Candidate.hostConfigUnchanged -ceq $true){
   if($oldHost.args[2] -cne $newHost.args[2] -or $Candidate.cdpBinding){throw 'Unbound Host update must preserve exact installed config'}
  }else{Assert-HostCdpBinding $Candidate $oldHost $newHost}
  $tools=@('aicc_host_capabilities','aicc_host_open','aicc_host_sessions','aicc_host_wait','aicc_host_observe','aicc_host_act','aicc_host_close','aicc_host_operation_status')
  if(-not (Same @($newHost.toolNames|Sort-Object) @($tools|Sort-Object)) -or $newHost.toolHash -cne $Candidate.toolHash){throw 'Exact eight-tool host contract required'}
  $expected=Read (Join-Path $Candidate.oldGateway 'config.json');$expectedHost=@($expected.providers|Where-Object id -CEQ 'host')[0]
  $expectedHost.entrypoint=$newHost.entrypoint;$expectedHost.args[0]=$newHost.entrypoint;$expectedHost.toolNames=$newHost.toolNames;$expectedHost.toolHash=$newHost.toolHash
  $entryPins=@($expectedHost.files|Where-Object path -CEQ $oldHost.entrypoint)
  if($entryPins.Count -ne 1){throw 'One original host entry pin required'}
  $entryPins[0].path=$newHost.entrypoint;$entryPins[0].sha256=$Candidate.hostEntrySHA256
  if($Candidate.hostConfigUnchanged -ceq $false){
   $configPins=@($expectedHost.files|Where-Object path -CEQ $oldHost.args[2])
   if($configPins.Count -ne 1){throw 'One original Host config pin required'}
   $expectedHost.args[2]=$newHost.args[2]
   $configPins[0].path=$newHost.args[2];$configPins[0].sha256=$Candidate.hostConfigDesiredSHA256
   foreach($relative in $Candidate.dependencyMaterialization.files.Keys){
    $expectedHost.files+=@{path=(Join-Path $Candidate.hostRoot ($relative.Replace('/','\')));sha256=$Candidate.dependencyMaterialization.files[$relative]}
   }
  }
  if(-not (Same $expected $gateway)){throw 'Host update exceeds existing host entrypoint and tool contract; other providers must remain exact'}
  foreach($provider in $gateway.providers){foreach($pin in $provider.files){if((Hash $pin.path) -cne $pin.sha256){throw 'Host candidate provider dependency changed'}}}
  $expectedProfile=[IO.File]::ReadAllText($profileFile)
  $spellings=@(@($Candidate.oldGateway,$Candidate.oldGateway.Replace('\','/'),$Candidate.oldGateway.Replace('\','\\'))|Select-Object -Unique|Where-Object {$expectedProfile.Contains($_)})
  if($spellings.Count -ne 1 -or $expectedProfile.Split([string[]]@($spellings[0]),[StringSplitOptions]::None).Count -ne 3){throw 'Exact original gateway profile binding required'}
  $spelling=$spellings[0]
  $replacement=if($spelling -ceq $Candidate.oldGateway){$Candidate.gateway}elseif($spelling -ceq $Candidate.oldGateway.Replace('\','/')){$Candidate.gateway.Replace('\','/')}else{$Candidate.gateway.Replace('\','\\')}
  if([IO.File]::ReadAllText($Candidate.profileDesiredFile) -cne $expectedProfile.Replace($spelling,$replacement)){throw 'Host profile update exceeds exact gateway path replacement'}
  return
 }
 if($localSkillsRegistration){Assert-LocalSkillsRegistration $Candidate $before $after}
 if($backendPolicyUpdate){Assert-BackendPolicyUpdate $Candidate $before $after}
 if($brokerSecurityUpdate){Assert-BrokerSecurityUpdate $Candidate $before $after}
 if($before.Contains('webManagement')){
  if($before.webManagement.enabled -cne $true -or $before.executionBoundary.webAssetManagement -cne 'owner-registered-fixed-web-manager' -or (Hash $before.webManagement.bindingFile) -cne $before.webManagement.bindingSha256){throw 'Existing named owner binding changed'}
  $previous=Read $before.webManagement.bindingFile;$next=Read $Candidate.bindingFile
  # Named read-only action; existing owner identity, denial lists and cutover gates still apply.
  $additions=@('project-source-read','personal-skill-plan-file','personal-skill-plan-add-file','personal-skill-add-file','personal-skill-list','personal-skill-inspect','personal-skill-upload','personal-skill-update','personal-skill-update-body','personal-skill-delete','title-inventory','title-read','title-rename')
  foreach($action in $previous.allowedActions){if($action -cnotin $next.allowedActions){throw 'Existing management actions must be preserved'}}
  foreach($action in $next.allowedActions){if($action -cnotin $previous.allowedActions -and $action -cnotin $additions){throw 'Unapproved management action expansion'}}
  foreach($key in @('blockedRequestHashes','blockedAssetKeys')){foreach($value in $previous[$key]){if($value -cnotin $next[$key]){throw 'Original denied operation must remain blocked'}}}
  $oldManager=Read $previous.config;$newManager=Read $next.config
  if((Hash $previous.config) -cne $previous.configSha256){throw 'Existing fixed account config changed'}
  foreach($key in @('leaseHelper','personalSkillRunner','backupGate')){$null=$oldManager.Remove($key);$null=$newManager.Remove($key)}
  if(-not (Same $oldManager $newManager)){throw 'Manager account authority must be preserved'}
  foreach($key in @('entry','entrySha256','config','configSha256','dependencyPins','allowedActions','blockedRequestHashes','blockedAssetKeys')){$null=$previous.Remove($key);$null=$next.Remove($key)}
  if(-not (Same $previous $next)){throw 'Existing management identity, owner, limits and records must be preserved'}
  $null=$before.Remove('webManagement');$null=$before.executionBoundary.Remove('webAssetManagement')
 }
 if($after.webManagement.enabled -cne $true -or $after.webManagement.bindingFile -cne $Candidate.bindingFile -or $after.webManagement.bindingSha256 -cne $Candidate.bindingSHA256 -or $after.executionBoundary.webAssetManagement -cne 'owner-registered-fixed-web-manager'){throw 'Named management authority differs'}
 $null=$after.Remove('webManagement');$null=$after.executionBoundary.Remove('webAssetManagement')
 if($localSkillsRegistration){$after.workspaces=@($after.workspaces|Where-Object alias -CNE 'local-skills')}
 if($backendPolicyUpdate){$after.remoteAuthority.readExpirySeconds=$before.remoteAuthority.readExpirySeconds;$after.remoteAuthority.writeExpirySeconds=$before.remoteAuthority.writeExpirySeconds;$after.permissions.commandTimeoutMs=$before.permissions.commandTimeoutMs}
 if($brokerSecurityUpdate -and $Candidate.ownerCommandApprovalFile){$null=Assert-OwnerCommandApproval $Candidate;$after.permissions.commandIsolation=$before.permissions.commandIsolation}
 if(-not (Same $before $after)){throw 'Candidate changes unrelated owner configuration'}
 $gateway=Read (Join-Path $Candidate.gateway 'config.json');$original=Read (Join-Path $Candidate.oldGateway 'config.json')
 if($localSkillsRegistration){
  if((Hash (Join-Path $Candidate.gateway 'gateway.cjs')) -cne (Hash (Join-Path $Candidate.oldGateway 'gateway.cjs'))){throw 'Registration must reuse identical gateway code'}
  $expectedGateway=Read (Join-Path $Candidate.oldGateway 'config.json')
  $ownerPins=@($expectedGateway.providers|Where-Object id -CEQ 'workspace'|ForEach-Object {$_.files}|Where-Object path -IEQ $configFile)
  if($ownerPins.Count -ne 1){throw 'One original owner config pin required'}
  $ownerPins[0].sha256=$Candidate.configDesiredSHA256
  if(-not (Same $expectedGateway $gateway)){throw 'Registration gateway change exceeds one owner config pin'}
 }
 foreach($provider in $gateway.providers){
  if(-not $provider.args.Count -or $provider.args[0] -cne $provider.entrypoint -or $provider.entrypoint -cnotin @($provider.files.path) -or $provider.command -cnotin @($provider.files.path)){throw 'Gateway executable and entrypoint must match exact pinned launch arguments before maintenance'}
 }
 if(-not (Same (@($gateway.providers|Where-Object id -eq 'native')[0]) (@($original.providers|Where-Object id -eq 'native')[0]))){throw 'Native provider must be preserved'}
 foreach($provider in $gateway.providers){foreach($pin in $provider.files){
  # The active config is replaced during cutover. Validate its future bytes,
  # while every other dependency must already match its installed bytes.
  if([IO.Path]::GetFullPath($pin.path) -ieq $configFile){
   if($provider.id -cne 'workspace' -or $pin.sha256 -cne $Candidate.configDesiredSHA256 -or (Hash $Candidate.configDesiredFile) -cne $pin.sha256){throw 'Gateway must pin the exact post-cutover owner config'}
  }elseif((Hash $pin.path) -cne $pin.sha256){throw 'Gateway dependency pin changed'}
 }}
 $binding=Read $Candidate.bindingFile
 foreach($pair in @(@($binding.node,$binding.nodeSha256),@($binding.entry,$binding.entrySha256),@($binding.config,$binding.configSha256))){if((Hash $pair[0]) -cne $pair[1]){throw 'Fixed manager pin changed'}}
 foreach($pin in $binding.dependencyPins){if((Hash $pin.path) -cne $pin.sha256){throw 'Fixed manager dependency changed'}}
}
$OperationDirectory=[IO.Path]::GetFullPath($OperationDirectory)
$allowed=(Join-Path $stateRoot 'asset-control').TrimEnd('\')+'\'
if(-not $OperationDirectory.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Existing private asset-control operation directory required'}
if($Mode -eq 'Prepare'){
 if(Test-Path -LiteralPath $OperationDirectory){throw 'Operation already exists; reconcile it'}
 if(-not $env:CODEX_THREAD_ID){throw 'Task identity required'}
 if((Hash $CandidateReceipt) -cne $ExpectedCandidateSha256){throw 'Exact reviewed candidate required'}
 $candidate=Read $CandidateReceipt;Validate-Candidate $candidate
 if($candidate.kind -cnotin @('local-skills-registration','backend-policy-update','host-runtime-update','workspace-broker-security-update','workspace-patch-parent-update','workspace-owner-environment-update','workspace-store-checkpoint-update','workspace-process-lifecycle-update','workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement') -and -not $UserConfirmedNoOtherWork){throw 'Explicit no-other-work confirmation required for management runtime upgrades'}
 $backup=Read $ChangeBackupReceipt
 Assert-ChangeBackupPolicy $candidate $backup
 $bundle=Read $backup.bundlePath;if((Hash $backup.bundlePath) -cne $backup.bundleSHA256 -or (Hash $PSCommandPath) -cnotin @($bundle.files.sha256)){throw 'Preview backup must contain exact updater bytes'}
 Assert-BrokerSecurityBackup $candidate $backup
 if($candidate.kind -cin @('workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement')){Assert-GptQueueRuntimeBackup $candidate $backup}
 $registry=Read $registryFile
 if($registry.components.workspace.releaseRoot -cne $candidate.baseline -or $registry.components['unified-mcp'].releaseRoot -cne $candidate.oldGateway -or (Hash $configFile) -cne $candidate.configBeforeSHA256 -or (Hash $profileFile) -cne $candidate.profileBeforeSHA256){throw 'Live owner preimage changed'}
 $task=Get-ScheduledTask -TaskName $taskName;if(-not $task.Settings.Enabled -or $task.State -cne 'Running'){throw 'Expected enabled running Task required'}
 $ownership=Get-WorkspaceOwnedRuntime 'business-full'
 New-Item -ItemType Directory -Path $OperationDirectory|Out-Null
 foreach($pair in @(@('registry',$registryFile),@('config',$configFile),@('profile',$profileFile),@('receipt',$receiptFile),@('launcher',$launcherFile))){Copy-Item -LiteralPath $pair[1] -Destination (Join-Path $OperationDirectory ($pair[0]+'.before'))}
 New-Text (Join-Path $OperationDirectory 'task.before.xml') (Export-ScheduledTask -TaskName $taskName)
 if($candidate.kind -ceq 'host-runtime-update' -and $candidate.hostConfigUnchanged -ceq $false){
  Copy-Item -LiteralPath (Regular $candidate.oldHostConfigFile) -Destination (Join-Path $OperationDirectory 'host-config.before')
  Assert-HostCdpRecoveryPreimage $candidate $OperationDirectory
 }
 $afterWorkspace=Read (Join-Path $OperationDirectory 'registry.before');$afterWorkspace=$afterWorkspace.components.workspace
 if($candidate.kind -cnotin @('host-runtime-update','workspace-gpt-queue-owner-replacement') -or $candidate.queueCombinedIssuerProviderUpdate -ceq $true){$afterWorkspace.previousRelease=$candidate.baseline;$afterWorkspace.releaseRoot=$candidate.backend;$afterWorkspace.recovery=$OperationDirectory}
 if($afterWorkspace.Contains('entry')){$afterWorkspace.entry=([string]$afterWorkspace.entry).Replace($candidate.baseline,$candidate.backend);if($afterWorkspace.Contains('entryHash')){$afterWorkspace.entryHash=Hash $afterWorkspace.entry}}
 $afterGateway=Read (Join-Path $OperationDirectory 'registry.before');$afterGateway=$afterGateway.components['unified-mcp']
 $afterGateway.previousRelease=$candidate.oldGateway;$afterGateway.releaseRoot=$candidate.gateway;$afterGateway.entry=Join-Path $candidate.gateway 'gateway.cjs';$afterGateway.entryHash=Hash $afterGateway.entry;$afterGateway.recovery=$OperationDirectory
 $plan=@{schemaVersion=1;changeKind=$(if($candidate.kind){$candidate.kind}else{'web-management-runtime'});owner_task_id=$env:CODEX_THREAD_ID;request_id=('workspace-management-'+[guid]::NewGuid().ToString('N'));challenge=[guid]::NewGuid().ToString('N');target=$taskName;rollback_ref=$OperationDirectory;expires_at=[DateTimeOffset]::UtcNow.AddMinutes(25).ToString('o');candidateReceipt=(Regular $CandidateReceipt);candidateReceiptSha256=$ExpectedCandidateSha256;changeBackupReceipt=(Regular $ChangeBackupReceipt);changeBackupReceiptSha256=(Hash $ChangeBackupReceipt);scriptSha256=(Hash $PSCommandPath);beforeWorkspace=$registry.components.workspace;beforeGateway=$registry.components['unified-mcp'];beforeHost=$registry.components['workspace-host'];afterWorkspace=$afterWorkspace;afterGateway=$afterGateway;ownership=$ownership;userConfirmation=$(if($candidate.kind -ceq 'backend-policy-update'){'사용자가 lease/파일/장기명령 정책 수정을 명시 승인; 작업 없음은 fresh gateway admission으로만 판단'}elseif($candidate.kind -ceq 'local-skills-registration'){'사용자가 로컬 스킬 쓰기 등록을 명시 승인; 실행 무작업 여부는 fresh gateway admission 근거로만 판단'}else{'현재 실행 중인 작업 없음'});activeCount=$null;unknownCount=$null;lastResult='UNCONFIRMED_PRESERVED';stopMode='planned-maintenance-stop';allowed_recovery=@('stop-exact-owned-candidate-runtime','restore-workspace-and-gateway-components-with-cas','restore-named-config-profile-and-task-receipt-preimages','start-original-task-once-after-owned-runtime-stopped')}
 if($candidate.kind -ceq 'host-runtime-update'){
  $plan.challenge=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
  $plan.stopMode='bootstrap-planned-maintenance-stop'
  if($candidate.hostConfigUnchanged -ceq $false){$plan.hostConfigBeforeSHA256=$candidate.oldHostConfigSHA256;$plan.hostConfigDesiredSHA256=$candidate.hostConfigDesiredSHA256}
  $plan.userConfirmation='사용자 승인 호스트 교체; exact gateway maintenance active/unknown=0 및 독립 READY 후 계획 정비 중단. 정상 drain/정상 프로세스 종료와 구별.'
 }
 if($candidate.kind -cin @('workspace-broker-security-update','workspace-patch-parent-update','workspace-owner-environment-update','workspace-store-checkpoint-update','workspace-process-lifecycle-update','workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement')){
  $plan.challenge=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
  $plan.userConfirmation='사용자가 exact broker 보안 수정을 승인; 새 소스 표준사용자 수용과 설치판 수용은 별도. fresh consumed gateway active/unknown=0 및 독립 READY 필수.'
  $plan.sourceAcceptance='SOURCE_ONLY_INSTALLED_ACCEPTANCE_NOT_RUN'
  $plan.brokerSecurityRestorePins=@(@('registry.before','config.before','profile.before','receipt.before','launcher.before','task.before.xml')|ForEach-Object {@{name=$_;sha256=(Hash (Join-Path $OperationDirectory $_))}})
 }
 if($candidate.kind -cin @('workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement')){$plan.queueDeploymentHelperSHA256=Hash (Join-Path $PSScriptRoot 'GptQueueRuntimeDeployment.ps1')}
 New-Text (Join-Path $OperationDirectory 'plan.json') (Json $plan)
 New-Text (Join-Path $OperationDirectory 'journal.json') (Json @{phase='PREPARED';startAttempts=0;rollbackStartAttempts=0})
 @{status='PREPARED';planSha256=(Hash (Join-Path $OperationDirectory 'plan.json'));request_id=$plan.request_id;challenge=$plan.challenge;expires_at=$plan.expires_at}|ConvertTo-Json -Compress
 exit
}
$planFile=Join-Path $OperationDirectory 'plan.json';$journalFile=Join-Path $OperationDirectory 'journal.json'
if((Hash $planFile) -cne $ExpectedPlanSha256){throw 'Exact operation plan required'}
$plan=Read $planFile;if((Hash $PSCommandPath) -cne $plan.scriptSha256){throw 'Updater changed after preview'}
$CandidateReceipt=$plan.candidateReceipt;$candidate=Read $CandidateReceipt
if($candidate.kind -cin @('workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement') -and (Hash (Join-Path $PSScriptRoot 'GptQueueRuntimeDeployment.ps1')) -cne $plan.queueDeploymentHelperSHA256){throw 'Queue deployment helper changed after preview'}
$lock=[IO.File]::Open((Join-Path $OperationDirectory 'operation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$registryLock=$null
try{
 $registryLock=[IO.File]::Open($registryFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $journal=Read $journalFile;$registry=Read $registryFile
 if($Mode -eq 'Rollback'){
  if($journal.phase -in @('PREPARED','ROLLED_BACK_START_ACCEPTED','ROLLBACK_START_INTENT')){throw 'Rollback not applicable or start outcome needs reconciliation'}
  Assert-HostCdpRecoveryPreimage $candidate $OperationDirectory
  if($candidate.kind -cin @('workspace-broker-security-update','workspace-patch-parent-update','workspace-owner-environment-update','workspace-store-checkpoint-update','workspace-process-lifecycle-update','workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement')){
   if((Hash $CandidateReceipt) -cne $plan.candidateReceiptSha256 -or $plan.changeKind -cne $candidate.kind -or -not (Same @($plan.brokerSecurityRestorePins.name|Sort-Object) @('config.before','launcher.before','profile.before','receipt.before','registry.before','task.before.xml'))){throw 'Exact broker recovery plan required'}
   foreach($pin in $plan.brokerSecurityRestorePins){if($pin.name -cnotin @('registry.before','config.before','profile.before','receipt.before','launcher.before','task.before.xml') -or (Hash (Join-Path $OperationDirectory $pin.name)) -cne $pin.sha256){throw 'Broker recovery preimage changed'}}
   $recoveryProof=if($candidate.kind -cin @('workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement')){$candidate.gptQueueRecovery}else{$candidate.brokerSecurity}
   $null=Assert-BrokerInventory $candidate.baseline $recoveryProof.inventoryBeforeFile $recoveryProof.inventoryBeforeSHA256
   if((Hash (Join-Path $OperationDirectory 'registry.before')) -cne $recoveryProof.registrySHA256 -or (Hash (Join-Path $candidate.oldGateway 'config.json')) -cne $candidate.oldGatewayConfigSHA256 -or (Hash (Join-Path $candidate.oldGateway 'manifest.json')) -cne $candidate.oldGatewayManifestSHA256){throw 'Original broker runtime recovery bytes changed'}
   $oldManifest=Read (Join-Path $candidate.oldGateway 'manifest.json')
   foreach($relative in $oldManifest.files.Keys){if($relative -cnotin @('config.json','gateway.cjs') -or (Hash (Join-Path $candidate.oldGateway $relative)) -cne $oldManifest.files[$relative]){throw 'Original broker recovery gateway dependency changed'}}
   foreach($name in @('workspace','unified-mcp')){$before=if($name -eq 'workspace'){$plan.beforeWorkspace}else{$plan.beforeGateway};$after=if($name -eq 'workspace'){$plan.afterWorkspace}else{$plan.afterGateway};if(-not (Same $registry.components[$name] $before) -and -not (Same $registry.components[$name] $after)){throw 'Broker recovery component changed outside operation'}}
   if(-not (Same $registry.components['workspace-host'] $plan.beforeHost) -or (Hash $launcherFile) -cne (Hash (Join-Path $OperationDirectory 'launcher.before')) -or (Export-ScheduledTask -TaskName $taskName).Trim() -cne ([IO.File]::ReadAllText((Join-Path $OperationDirectory 'task.before.xml'))).Trim()){throw 'Broker recovery must preserve exact host, launcher and task'}
   foreach($pair in @(@('config',$configFile,$candidate.configDesiredSHA256),@('profile',$profileFile,$candidate.profileDesiredSHA256))){if((Hash $pair[1]) -cnotin @((Hash (Join-Path $OperationDirectory ($pair[0]+'.before'))),$pair[2])){throw 'Broker recovery owner file changed outside operation'}}
  }
  Disable-ScheduledTask -TaskName $taskName|Out-Null
  $current=$null;try{$current=Get-WorkspaceOwnedRuntime 'business-full'}catch{}
  if($current){
   $marker=Read (Join-Path $stateRoot 'workspace-mcp\runtime\remote-authority-status.json')
   $knownRoot=Split-Path $marker.installedIdentity.lockfileRealpath -Parent
   if($knownRoot -cne $candidate.backend){throw 'Exact candidate runtime ownership is unknown; preserve for recovery'}
   $stopped=Stop-WorkspaceOwnedRuntime $current;if($stopped.stopped -cne $true){throw 'Candidate stop unconfirmed'}
  }else{
   $helper=$plan.beforeHost.entry
   $remaining=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -and ($_.CommandLine.Contains($helper) -or $_.CommandLine.Contains($candidate.backend) -or $_.CommandLine.Contains($candidate.gateway))})
   if($remaining.Count){throw 'Partial candidate ownership is unknown; preserve for recovery'}
  }
  Stop-ScheduledTask -TaskName $taskName
  foreach($name in @('workspace','unified-mcp')){$before=if($name -eq 'workspace'){$plan.beforeWorkspace}else{$plan.beforeGateway};$after=if($name -eq 'workspace'){$plan.afterWorkspace}else{$plan.afterGateway};if(-not (Same $registry.components[$name] $before) -and -not (Same $registry.components[$name] $after)){throw 'Component changed outside this operation'};$registry.components[$name]=$before}
  foreach($pair in @(@('config',$configFile,$candidate.configDesiredSHA256),@('profile',$profileFile,$candidate.profileDesiredSHA256))){$original=Join-Path $OperationDirectory ($pair[0]+'.before');if((Hash $pair[1]) -cnotin @((Hash $original),$pair[2])){throw 'Owner file changed outside operation'};Atomic $pair[1] ([IO.File]::ReadAllText($original))}
  $receipt=Read $receiptFile;$originalReceipt=Read (Join-Path $OperationDirectory 'receipt.before');if($receipt.profileSha256 -cnotin @($candidate.profileBeforeSHA256,$candidate.profileDesiredSHA256)){throw 'Task receipt changed outside operation'};$receipt.profileSha256=$originalReceipt.profileSha256
  Atomic $registryFile (Json $registry);Atomic $receiptFile (Json $receipt)
  if($journal.rollbackStartAttempts -ne 0){throw 'Original task start already attempted'}
  $journal.phase='ROLLBACK_START_INTENT';$journal.rollbackStartAttempts=1;Atomic $journalFile (Json $journal)
  Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
  $journal.phase='ROLLED_BACK_START_ACCEPTED';Atomic $journalFile (Json $journal)
  @{status=$journal.phase;request_id=$plan.request_id}|ConvertTo-Json -Compress;exit
 }
 if($journal.phase -cne 'PREPARED' -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($plan.expires_at)){throw 'Operation expired or already attempted'}
 $ready=Read $ReadyFile
 foreach($key in @('owner_task_id','request_id','challenge','target','rollback_ref')){if($ready[$key] -cne $plan[$key]){throw ('Independent READY mismatch: '+$key)}}
 if($ready.status -cne 'READY' -or $ready.independent -cne $true -or $ready.plan_sha256 -cne $ExpectedPlanSha256 -or $ready.script_sha256 -cne $plan.scriptSha256 -or -not (Same $ready.allowed_recovery $plan.allowed_recovery) -or [DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($ready.expires_at) -or [DateTimeOffset]::Parse($ready.expires_at) -gt [DateTimeOffset]::Parse($plan.expires_at)){throw 'Fresh independent operation READY required'}
 if((Hash $CandidateReceipt) -cne $plan.candidateReceiptSha256){throw 'Candidate receipt changed'};Validate-Candidate $candidate
 Assert-HostCdpRecoveryPreimage $candidate $OperationDirectory
 if($candidate.kind -ceq 'host-runtime-update' -and $candidate.hostConfigUnchanged -ceq $false -and
    ($plan.hostConfigBeforeSHA256 -cne $candidate.oldHostConfigSHA256 -or $plan.hostConfigDesiredSHA256 -cne $candidate.hostConfigDesiredSHA256)){throw 'Owner Host CDP plan binding changed'}
 if((Regular $ChangeBackupReceipt) -cne $plan.changeBackupReceipt -or (Hash $ChangeBackupReceipt) -cne $plan.changeBackupReceiptSha256){throw 'Reviewed change backup receipt changed'}
 $backup=Read $ChangeBackupReceipt
 Assert-ChangeBackupPolicy $candidate $backup
 $bundle=Read $backup.bundlePath;if((Hash $backup.bundlePath) -cne $backup.bundleSHA256 -or $plan.scriptSha256 -cnotin @($bundle.files.sha256)){throw 'Change backup must contain exact updater bytes'}
 Assert-BrokerSecurityBackup $candidate $backup
 if($candidate.kind -cin @('workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement')){Assert-GptQueueRuntimeBackup $candidate $backup}
 foreach($name in @('workspace','unified-mcp','workspace-host')){$before=if($name -eq 'workspace'){$plan.beforeWorkspace}elseif($name -eq 'unified-mcp'){$plan.beforeGateway}else{$plan.beforeHost};if(-not (Same $registry.components[$name] $before)){throw 'Runtime component preimage changed'}}
 foreach($pair in @(@('config',$configFile),@('profile',$profileFile),@('receipt',$receiptFile),@('launcher',$launcherFile))){if((Hash $pair[1]) -cne (Hash (Join-Path $OperationDirectory ($pair[0]+'.before')))){throw 'Live owner file preimage changed'}}
 if((Export-ScheduledTask -TaskName $taskName).Trim() -cne ([IO.File]::ReadAllText((Join-Path $OperationDirectory 'task.before.xml'))).Trim()){throw 'Task definition changed'}
 if(-not (Same (Get-WorkspaceOwnedRuntime 'business-full') $plan.ownership)){throw 'Runtime ownership changed'}
 if($candidate.kind -ceq 'host-runtime-update'){
  $maintenance=Assert-HostMaintenance $plan $candidate $MaintenanceStateFile
  $journal.hostMaintenance=$maintenance;$journal.stopMode='bootstrap-planned-maintenance-stop';$journal.normalProcessStop=$false
  Atomic $journalFile (Json $journal)
 }
 if($candidate.kind -cin @('workspace-broker-security-update','workspace-patch-parent-update','workspace-owner-environment-update','workspace-store-checkpoint-update','workspace-process-lifecycle-update','workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement')){
  $maintenance=Assert-HostMaintenance $plan $candidate $MaintenanceStateFile
  $journal.brokerSecurityMaintenance=$maintenance;$journal.activeCount=0;$journal.unknownCount=0
  Atomic $journalFile (Json $journal)
 }
 $journal.phase='MAINTENANCE_STOP_INTENT';Atomic $journalFile (Json $journal)
 Disable-ScheduledTask -TaskName $taskName|Out-Null
 $stopped=Stop-WorkspaceOwnedRuntime $plan.ownership;if($stopped.stopped -cne $true){throw 'Exact runtime stop unconfirmed'};Stop-ScheduledTask -TaskName $taskName
 $journal.phase='STOPPED';Atomic $journalFile (Json $journal)
 $registry=Read $registryFile
 foreach($name in @('workspace','unified-mcp','workspace-host')){$before=if($name -eq 'workspace'){$plan.beforeWorkspace}elseif($name -eq 'unified-mcp'){$plan.beforeGateway}else{$plan.beforeHost};if(-not (Same $registry.components[$name] $before)){throw 'Target component changed during stop'}}
 foreach($pair in @(@('config',$configFile),@('profile',$profileFile),@('receipt',$receiptFile),@('launcher',$launcherFile))){if((Hash $pair[1]) -cne (Hash (Join-Path $OperationDirectory ($pair[0]+'.before')))){throw 'Owner file changed during stop'}}
 if($candidate.kind -cin @('workspace-broker-security-update','workspace-patch-parent-update','workspace-owner-environment-update','workspace-store-checkpoint-update','workspace-process-lifecycle-update','workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement')){Validate-Candidate $candidate}
 $registry.components.workspace=$plan.afterWorkspace;$registry.components['unified-mcp']=$plan.afterGateway
 $receipt=Read $receiptFile;$receipt.profileSha256=$candidate.profileDesiredSHA256
 $journal.phase='APPLY_INTENT';Atomic $journalFile (Json $journal)
 Atomic $configFile ([IO.File]::ReadAllText((Regular $candidate.configDesiredFile)))
 Atomic $profileFile ([IO.File]::ReadAllText((Regular $candidate.profileDesiredFile)))
 Atomic $registryFile (Json $registry);Atomic $receiptFile (Json $receipt)
 $gateway=Read (Join-Path $candidate.gateway 'config.json')
 foreach($provider in $gateway.providers){foreach($pin in $provider.files){if((Hash $pin.path) -cne $pin.sha256){throw 'Applied gateway dependency differs; recover before starting'}}}
 $journal.phase='START_INTENT';$journal.startAttempts=1;Atomic $journalFile (Json $journal)
 Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
 $journal.phase='START_ACCEPTED';Atomic $journalFile (Json $journal)
 @{status='START_ACCEPTED_RUNTIME_UNOBSERVED';request_id=$plan.request_id;recovery=$OperationDirectory}|ConvertTo-Json -Compress
}finally{if($registryLock){$registryLock.Dispose()};$lock.Dispose()}
