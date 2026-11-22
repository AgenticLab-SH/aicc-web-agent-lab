#requires -Version 7.5
[CmdletBinding(DefaultParameterSetName='Legacy')]
param(
 [Parameter(Mandatory,ParameterSetName='Legacy')][string]$PublicEntry,
 [Parameter(Mandatory,ParameterSetName='Legacy')][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedEntrySha256,
 [Parameter(Mandatory,ParameterSetName='Lifecycle')][string]$RuntimeConfig,
 [Parameter(Mandatory,ParameterSetName='Lifecycle')][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedRuntimeConfigSha256,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedBaseManifestSha256,
 [Parameter(Mandatory)][string]$OperationRoot,
 [string]$SourceRoot=(Join-Path $PSScriptRoot '../../..'),
 [string]$NodeExecutable,
 [switch]$Assemble
)
$ErrorActionPreference='Stop'
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$releaseBoundary=[IO.Path]::GetFullPath((Join-Path $owner 'releases\cli'))+[IO.Path]::DirectorySeparatorChar
$backupBoundary=[IO.Path]::GetFullPath((Join-Path $owner 'backups'))+[IO.Path]::DirectorySeparatorChar
function Regular([string]$File){
 $full=(Resolve-Path -LiteralPath $File).Path
 for($p=$full;;$p=Split-Path -Parent $p){
  $item=Get-Item -LiteralPath $p -Force
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_preparation_path_preserved'}
  $parent=Split-Path -Parent $p
  if(-not $parent -or $parent -eq $p){break}
 }
 if((Get-Item -LiteralPath $full).PSIsContainer){throw 'regular_preparation_file_required'}
 return $full
}
$operation=[IO.Path]::GetFullPath($OperationRoot)
if(-not $operation.StartsWith($backupBoundary,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $operation)){throw 'new_exact_operation_directory_required'}
$lifecycle=$PSCmdlet.ParameterSetName -ceq 'Lifecycle'
$entry=$null;$registeredConfig=$null;$existingConfig=$null
if($lifecycle){
 $registeredConfig=Regular $RuntimeConfig
 $configBoundary=[IO.Path]::GetFullPath((Join-Path $owner 'control-plane\mobile-public-runtime'))+[IO.Path]::DirectorySeparatorChar
 if(-not $registeredConfig.StartsWith($configBoundary,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $registeredConfig).Hash.ToLowerInvariant() -cne $ExpectedRuntimeConfigSha256){throw 'registered_runtime_config_pin_required'}
 $existingConfig=Get-Content -LiteralPath $registeredConfig -Raw|ConvertFrom-Json -AsHashtable
 if($existingConfig.schemaVersion -ne 1 -or $existingConfig.runtimeId -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $existingConfig.port -ne 4383 -or $existingConfig.releaseManifestSha256 -cne $ExpectedBaseManifestSha256){throw 'existing_lifecycle_binding_required'}
 $origin=[uri]$existingConfig.remoteOrigin
 if(-not $origin.IsAbsoluteUri -or $origin.Scheme -cne 'https' -or $origin.UserInfo -or $origin.GetLeftPart([UriPartial]::Authority) -cne $existingConfig.remoteOrigin){throw 'existing_https_origin_required'}
 $base=(Resolve-Path -LiteralPath $existingConfig.releaseRoot).Path
}else{
$entry=Regular $PublicEntry
if(-not $entry.StartsWith($backupBoundary,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $entry).Hash.ToLowerInvariant() -cne $ExpectedEntrySha256){throw 'registered_public_entry_pin_required'}
$entryText=[IO.File]::ReadAllText($entry)
$match=[regex]::Match($entryText,"import\s*\{\s*startServer\s*\}\s*from\s*'(?<uri>file:///[^']+/src/server\.mjs)'")
if(-not $match.Success){throw 'existing_public_import_not_recognized'}
$base=[IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent ([uri]$match.Groups['uri'].Value).LocalPath)))
}
if(-not $base.StartsWith($releaseBoundary,[StringComparison]::OrdinalIgnoreCase)){throw 'managed_public_baseline_required'}
$manifestFile=Regular (Join-Path $base '.aicc-release.json')
if((Get-FileHash -LiteralPath $manifestFile).Hash.ToLowerInvariant() -cne $ExpectedBaseManifestSha256){throw 'public_baseline_manifest_changed'}
$manifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json -AsHashtable
$trust=$null
if($lifecycle){
 if($manifest.schemaVersion -ne 1 -or $manifest.component -cne 'mobile-public-control' -or -not $manifest.files.Count){throw 'existing_lifecycle_manifest_required'}
}else{
 $trust=Get-Content -LiteralPath (Regular (Join-Path $base '.aicc-device-trust-overlay.json')) -Raw|ConvertFrom-Json -AsHashtable
 if($manifest.schemaVersion -ne 1 -or $manifest.component -ne 'mobile-control' -or $trust.kind -ne 'standalone-mobile-device-trust'){throw 'existing_trusted_device_baseline_required'}
}
$source=(Resolve-Path -LiteralPath $SourceRoot).Path
$overlay=@('src/server.mjs','src/mobile-control.mjs','src/dashboard-workspace.mjs','public/dashboard-workspace.js','public/dashboard-workspace.css','public/aicc.webmanifest','public/aicc-sw.js','public/favicon.svg','src/goals/service.mjs','src/goals/user-action-ledger.mjs','public/mobile.html','public/mobile.js','public/mobile.css','public/ai-cowork.js','public/ai-cowork.json','tools/platform/windows/mobile-public-runner.mjs','tools/platform/windows/Start-AiccMobilePublicRuntime.ps1','tools/platform/windows/Request-AiccMobilePublicStop.ps1','tools/platform/windows/Install-AiccMobilePublicRuntime.ps1','src/supervised-runs/state.mjs','src/supervised-runs/runners.mjs','src/supervised-runs/service.mjs','src/supervised-runs/cli.mjs','src/codex-task-callback.mjs','public/supervise.html','public/supervise.js','public/supervise.css')
# mobile-control imports this read-only owner projection; preserve it in the pinned candidate.
$overlay += @('public/aicc-icon-192.png','public/aicc-icon-512.png')
$overlay += 'public/install.html'
$overlay += 'public/install.js'
# APK delivery is optional until a signed release has been built and verified.
foreach($asset in @('public/downloads/aicc-mobile.apk','public/downloads/aicc-mobile.json')){
 if(Test-Path -LiteralPath (Join-Path $source $asset) -PathType Leaf){$overlay += $asset}
}
$overlay += 'src/management-overview.mjs'
$overlay += 'src/mobile-app-catalog.mjs'
$overlay += @('src/portfolio-overview.mjs','public/portfolio-overview.js','public/portfolio-overview.css')
$overlay += 'src/jobs/status.mjs'
$overlay += @('src/jobs/registered-codex-activity.mjs','components/workspace-mcp/codex-session-activity.mjs')
$overlay += @('src/control-plane/pending-work.mjs','src/control-plane/pending-work-status.mjs')
# PC and mobile share the same dashboard entry assets in this release.
$overlay += @('public/index.html','public/app.js','public/styles.css','src/dashboard-product.mjs')
$overlay += @('src/control-plane/report-store.mjs','src/control-plane-report-command.mjs','contracts/control-report.schema.json')
$overlay += 'docs/dashboard-product-spec.md'
$overlay += 'src/dashboard-terminal.mjs'
$overlay += 'src/dashboard-queue-preflight.mjs'
$overlay += @('src/dashboard-queue-sender.mjs','tools/platform/windows/Invoke-AiccCodexContinuity.ps1')
$overlay += 'tools/platform/windows/MobilePublicTransition.psm1'
$overlay += 'tools/platform/windows/MobilePublicStopCompatibility.psm1'
$overlay += 'tools/platform/windows/Restore-AiccMobilePublicRuntime.ps1'
$overlay += @('src/mobile-tray-tools.mjs','src/ocx-quota-dashboard.mjs','src/adapters/codex-app-server-proxy.mjs','src/runtime-layout.mjs','tools/platform/windows/tray-status.mjs','public/mobile-quota.js','public/mobile-quota.css','public/mobile-tools.js')
function Pin($file,$relative){$item=Get-Item -LiteralPath (Regular $file);@{path=$relative;size=$item.Length;sha256=(Get-FileHash -LiteralPath $item.FullName).Hash.ToLowerInvariant()}}
if(-not $NodeExecutable){throw 'existing_node_executable_required'}
$nodePath=(Resolve-Path -LiteralPath $NodeExecutable).Path
$nodePin=Pin $nodePath 'node.exe'
if($lifecycle -and ($nodePath -cne $existingConfig.nodeExecutable -or $nodePin.sha256 -cne $existingConfig.nodeSha256)){throw 'existing_node_pin_required'}
$all=@(Get-ChildItem -LiteralPath $base -Force -Recurse)
if(@($all|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'linked_baseline_preserved'}
$baselinePins=@($all|Where-Object {-not $_.PSIsContainer}|ForEach-Object {Pin $_.FullName ([IO.Path]::GetRelativePath($base,$_.FullName).Replace('\','/'))})
$sourcePins=@($overlay|ForEach-Object {Pin (Join-Path $source $_) $_})
$checker=Regular (Join-Path $source 'scripts/check-mobile-runtime-candidate.mjs')
$checkerSha256=(Get-FileHash -LiteralPath $checker).Hash.ToLowerInvariant()
$baselineMap=@{};foreach($pin in $baselinePins){$baselineMap[$pin.path]=$pin}
$declared=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($old in $manifest.files){
 $full=[IO.Path]::GetFullPath((Join-Path $base $old.path))
 if(-not $full.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::IsPathRooted($old.path) -or $old.path -match '(^|[/\\])\.\.([/\\]|$)|:' -or -not $declared.Add($old.path) -or $old.sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'invalid_baseline_pin_path'}
}
$changed=@(foreach($old in $manifest.files){$actual=$baselineMap[$old.path];if(-not $actual -or $actual.sha256 -cne $old.sha256 -or $actual.size -ne $old.size){$old.path}})
if($lifecycle){
 if($changed.Count -or @($baselinePins|Where-Object {$_.path -cne '.aicc-release.json' -and -not $declared.Contains($_.path)}).Count){throw 'lifecycle_baseline_drift_preserved'}
}elseif(@($changed|Where-Object {$_ -notin $trust.changedFiles}).Count){throw 'baseline_drift_outside_declared_device_overlay'}
$operationId=[guid]::NewGuid().ToString()
$candidate=Join-Path $owner ('releases\cli\mobile-public-lifecycle-'+$operationId.Replace('-',''))
$plan=@{schemaVersion=1;operationId=$operationId;state='PREPARED_NOT_APPLIED';publicEntry=$entry;publicEntrySha256=$ExpectedEntrySha256;baseRoot=$base;baseManifestSha256=$ExpectedBaseManifestSha256;baselinePins=$baselinePins;baselineManifestDriftPreserved=$changed;baselineProvenance='installed-public-runner-and-declared-device-trust-overlay';candidateRoot=$candidate;sourceRoot=$source;overlays=$sourcePins;runtimeApplied=$false;validation='NOT_RUN';deviceStoreCopied=$false;modelRoutesChanged=$false;existingPublicRuntimeNormalStop='UNSUPPORTED_BY_CURRENT_RUNNER';applyGate='Fresh independent recovery if affected, current public runner exact ownership/normal stop ACK, no pending mobile outcomes; no force stop or old-release overwrite';lifecycle='Future runner accepts only generation/PID/manifest/nonce-bound stdin drain-and-stop; no public shutdown endpoint'}
$plan.stoppedServiceActivation=@{contractVersion=1;installer='tools/platform/windows/Install-AiccMobilePublicRuntime.ps1';requires='Explicit ActivateStoppedService, fresh task XML pin and Ready/no running instances, exact entry/parent absence, empty 4383, pinned candidate/config/launchers and scoped durable outcomes';historicalNormalStopAck='UNAVAILABLE_NOT_SYNTHESIZED';journalScope='status-tray/requests/mobile-32hex.json only; not global unknown=0';start='Durable once-only attempt; preserve unknown result and never replay';rollback='Preserve original task XML, entry, release and external device store; no forced stop or stale trust restoration'}
if($lifecycle){
 $plan.Remove('publicEntry');$plan.Remove('publicEntrySha256');$plan.Remove('stoppedServiceActivation')
 $plan.baselineProvenance='registered-lifecycle-config-and-exact-release-manifest'
 $plan.existingPublicRuntimeNormalStop='GENERATION_BOUND_PROTOCOL_REQUIRES_FRESH_OWNER_ACK'
 $plan.runtimeConfig=$registeredConfig;$plan.runtimeConfigSha256=$ExpectedRuntimeConfigSha256;$plan.baselineRuntimeId=$existingConfig.runtimeId
 $plan.activationMode='PREPARE_ONLY_CURRENT_LIFECYCLE';$plan.activationSupported=$false
 $plan.lifecycleTransition=@{contractVersion=1;installer='tools/platform/windows/Install-AiccMobilePublicRuntime.ps1';installerSha256=(Get-FileHash -LiteralPath (Join-Path $source 'tools/platform/windows/Install-AiccMobilePublicRuntime.ps1')).Hash.ToLowerInvariant();moduleSha256=(Get-FileHash -LiteralPath (Join-Path $source 'tools/platform/windows/MobilePublicTransition.psm1')).Hash.ToLowerInvariant();mode='ActivateNormallyStoppedLifecycle';stop='Consume an existing generation-bound normal-stop ACK/request/claim plus actual exit; never submit stop here';recovery='Fresh independent tool READY/readback bound to plan/task/config/stop operation; never synthesize';rollback='Keep task XML/config/release preimages; reconcile unknown before explicit CAS recovery; no automatic replay'}
 $plan.lifecycleTransition.rollbackSha256=(Get-FileHash -LiteralPath (Join-Path $source 'tools/platform/windows/Restore-AiccMobilePublicRuntime.ps1')).Hash.ToLowerInvariant()
 $plan.applyGate='Lifecycle transition contract available in source; actual use requires fresh exact idle/drain/normal-stop ACK, independent recovery and task/config CAS. Do not use legacy stopped-service mode.'
}else{
 $plan.legacyLaunchers=@(foreach($file in @([IO.Path]::ChangeExtension($entry,'hidden.vbs'),(Join-Path (Split-Path -Parent $entry) 'Start-MobilePublicControl.ps1'))){if(Test-Path -LiteralPath $file -PathType Leaf){Pin $file ([IO.Path]::GetRelativePath((Split-Path -Parent $entry),$file))}})
}
if($lifecycle -and (Get-FileHash -LiteralPath (Regular $registeredConfig)).Hash.ToLowerInvariant() -cne $ExpectedRuntimeConfigSha256){throw 'runtime_config_changed_before_preparation'}
New-Item -ItemType Directory -Path $operation|Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
$plan.state='DEPENDENCY_CHECK_PENDING';$plan.validation='STATIC_DEPENDENCIES_PENDING'
[IO.File]::WriteAllText((Join-Path $operation 'plan.json'),($plan|ConvertTo-Json -Depth 12),$utf8)
function CheckDependencies([hashtable]$InputValue,[string]$Name){
 if((Get-FileHash -LiteralPath (Regular $checker)).Hash.ToLowerInvariant() -cne $checkerSha256 -or (Get-FileHash -LiteralPath (Regular $nodePath)).Hash.ToLowerInvariant() -cne $nodePin.sha256){throw 'dependency_checker_pin_changed'}
 $inputFile=Join-Path $operation ($Name+'.input.json')
 $reportFile=Join-Path $operation ($Name+'.report.json')
 [IO.File]::WriteAllText($inputFile,($InputValue|ConvertTo-Json -Depth 12),$utf8)
 $priorNativePreference=$PSNativeCommandUseErrorActionPreference
 try{$PSNativeCommandUseErrorActionPreference=$false;$null=& $nodePath $checker $inputFile $reportFile 2>&1;$checkerExit=$LASTEXITCODE}finally{$PSNativeCommandUseErrorActionPreference=$priorNativePreference}
 if($checkerExit -ne 0 -or -not(Test-Path -LiteralPath $reportFile)){throw 'candidate_dependency_check_failed'}
 $report=Get-Content -LiteralPath (Regular $reportFile) -Raw|ConvertFrom-Json -AsHashtable
 if($report.ok -ne $true -or $report.candidateCodeExecuted -ne $false -or (Get-FileHash -LiteralPath (Regular $checker)).Hash.ToLowerInvariant() -cne $checkerSha256){throw 'candidate_dependency_check_failed'}
 return @{mode=$report.mode;modulesParsed=$report.modulesParsed;filesRead=$report.filesRead;computedImports=$report.computedImports;reportFile=$reportFile;reportSha256=(Get-FileHash -LiteralPath $reportFile).Hash.ToLowerInvariant();checkerSha256=$checkerSha256;candidateCodeExecuted=$false}
}
try{$plan.staticPreflight=CheckDependencies @{mode='projection';baseRoot=$base;sourceRoot=$source;baselinePins=$baselinePins;overlays=$sourcePins} 'dependency-preflight'}catch{
 $plan.state='HOLD_DEPENDENCY_CHECK';$plan.validation='STATIC_DEPENDENCIES_FAILED'
 [IO.File]::WriteAllText((Join-Path $operation 'plan.json'),($plan|ConvertTo-Json -Depth 12),$utf8)
 throw
}
$plan.state='PREPARED_NOT_APPLIED';$plan.validation='STATIC_PREFLIGHT_PASS_NOT_RUNTIME'
[IO.File]::WriteAllText((Join-Path $operation 'plan.json'),($plan|ConvertTo-Json -Depth 12),$utf8)
if($Assemble){
 if(Test-Path -LiteralPath $candidate){throw 'new_candidate_required'}
 New-Item -ItemType Directory -Path $candidate|Out-Null
 foreach($pin in $baselinePins){$from=Join-Path $base $pin.path;if((Get-FileHash -LiteralPath $from).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'baseline_changed_before_copy'};$dest=Join-Path $candidate $pin.path;New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force|Out-Null;Copy-Item -LiteralPath $from -Destination $dest}
 Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $candidate '.aicc-public-baseline-release.json')
 $pins=@{};foreach($pin in $baselinePins){if($pin.path -ne '.aicc-release.json'){$pins[$pin.path]=$pin}}
 $pins['.aicc-public-baseline-release.json']=Pin (Join-Path $candidate '.aicc-public-baseline-release.json') '.aicc-public-baseline-release.json'
 foreach($pin in $sourcePins){$from=Join-Path $source $pin.path;if((Get-FileHash -LiteralPath $from).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'source_changed_before_copy'};$dest=Join-Path $candidate $pin.path;New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force|Out-Null;Copy-Item -LiteralPath $from -Destination $dest;$pins[$pin.path]=$pin}
 $files=@($pins.Values|Sort-Object path)
 $next=@{schemaVersion=1;component='mobile-public-control';createdAt=[DateTimeOffset]::UtcNow.ToString('o');operationId=$operationId;baseline=$base;baselineManifestSha256=$ExpectedBaseManifestSha256;baselineDriftPreserved=$changed;fileCount=$files.Count;totalBytes=($files|Measure-Object size -Sum).Sum;files=$files;overlays=$sourcePins;validation='NOT_RUN';runtimeApplied=$false}
 [IO.File]::WriteAllText((Join-Path $candidate '.aicc-release.json'),($next|ConvertTo-Json -Depth 12),$utf8)
 $plan.candidateManifestSha256=(Get-FileHash -LiteralPath (Join-Path $candidate '.aicc-release.json')).Hash.ToLowerInvariant()
 try{$plan.staticCandidateCheck=CheckDependencies @{mode='sealed';candidateRoot=$candidate;expectedManifestSha256=$plan.candidateManifestSha256} 'dependency-candidate'}catch{
  $plan.state='HOLD_CANDIDATE_DEPENDENCIES';$plan.validation='STATIC_CANDIDATE_FAILED'
  [IO.File]::WriteAllText((Join-Path $operation 'plan.json'),($plan|ConvertTo-Json -Depth 12),$utf8)
  throw
 }
 $plan.state='ASSEMBLED_NOT_APPLIED';$plan.validation='STATIC_DEPENDENCIES_PASS_NOT_RUNTIME'
 $runtimeId=[guid]::NewGuid().ToString()
 $remoteOrigin=if($lifecycle){$existingConfig.remoteOrigin}else{'https://aicc.example.invalid'}
 $config=@{schemaVersion=1;runtimeId=$runtimeId;releaseRoot=$candidate;releaseManifestSha256=$plan.candidateManifestSha256;port=4383;remoteOrigin=$remoteOrigin;statusFile=(Join-Path $owner ('runtime\mobile-public-control\'+$runtimeId+'\status.json'));nodeExecutable=$nodePath;nodeSha256=$nodePin.sha256;controlNonce=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()}
 $preparedConfig=Join-Path $operation 'prepared-runtime-config.json'
 [IO.File]::WriteAllText($preparedConfig,($config|ConvertTo-Json -Depth 5),$utf8)
 $plan.preparedConfig=$preparedConfig
 $plan.configSha256=(Get-FileHash -LiteralPath $preparedConfig).Hash.ToLowerInvariant()
 $plan.futureConfigPath=Join-Path $owner ('control-plane\mobile-public-runtime\'+$runtimeId+'\runtime.json')
 $plan.lifecycleSupervisor=Join-Path $candidate 'tools\platform\windows\Start-AiccMobilePublicRuntime.ps1'
 $plan.activation='Not installed. Preserve current public runner; reconcile exact ownership and supported normal stop plus pending outcomes before installing this generation config and hidden supervisor. Do not print the config nonce or reuse a stop claim.'
 if(-not $lifecycle){$plan.stoppedServiceInstaller=Join-Path $candidate 'tools/platform/windows/Install-AiccMobilePublicRuntime.ps1'}
 if((Get-FileHash -LiteralPath (Regular $manifestFile)).Hash.ToLowerInvariant() -cne $ExpectedBaseManifestSha256 -or ($lifecycle -and (Get-FileHash -LiteralPath (Regular $registeredConfig)).Hash.ToLowerInvariant() -cne $ExpectedRuntimeConfigSha256)){throw 'baseline_binding_changed_after_assembly'}
 [IO.File]::WriteAllText((Join-Path $operation 'plan.json'),($plan|ConvertTo-Json -Depth 12),$utf8)
}
@{operationId=$operationId;state=$plan.state;planFile=(Join-Path $operation 'plan.json');candidateRoot=$candidate;runtimeApplied=$false;validation=$plan.validation}|ConvertTo-Json -Compress
