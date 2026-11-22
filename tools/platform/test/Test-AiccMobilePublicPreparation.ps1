#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath $AiccRoot).Path
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('aicc-mobile-prepare-'+[guid]::NewGuid().ToString('N'))
$owner=Join-Path $fixtureRoot 'owner'
$base=Join-Path $owner 'releases/cli/baseline'
$configDir=Join-Path $owner 'control-plane/mobile-public-runtime/synthetic'
$backups=Join-Path $owner 'backups'
foreach($dir in @($base,$configDir,$backups)){New-Item -ItemType Directory -Path $dir -Force|Out-Null}
$utf8=[Text.UTF8Encoding]::new($false)
$nodeFile=(Get-Command node -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
$serverFile=Join-Path $base 'baseline.txt'
[IO.File]::WriteAllText($serverFile,'synthetic immutable baseline')
$manifestFile=Join-Path $base '.aicc-release.json'
$configFile=Join-Path $configDir 'runtime.json'
function Hash([string]$file){(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
function WriteFixture {
 $manifest=@{schemaVersion=1;component='mobile-public-control';files=@(@{path='baseline.txt';size=(Get-Item -LiteralPath $serverFile).Length;sha256=(Hash $serverFile)})}
 [IO.File]::WriteAllText($manifestFile,($manifest|ConvertTo-Json -Depth 6),$utf8)
 $cfg=@{schemaVersion=1;runtimeId=[guid]::NewGuid().ToString();releaseRoot=$base;releaseManifestSha256=(Hash $manifestFile);port=4383;remoteOrigin='https://synthetic.invalid';nodeExecutable=$nodeFile;nodeSha256=(Hash $nodeFile);controlNonce=('a'*64)}
 [IO.File]::WriteAllText($configFile,($cfg|ConvertTo-Json -Depth 6),$utf8)
}
WriteFixture
# Only the owner-root expression is substituted in an isolated copy of the exact
# production preparer. The installed Node runs only the source-text checker.
# Candidate fixtures are inert; no real owner, runner, task or sender is used.
$source=[IO.File]::ReadAllText((Join-Path $repo 'tools/platform/windows/Prepare-AiccMobilePublicRuntime.ps1'))
$syntheticSource=Join-Path $fixtureRoot 'source'
$overlayMatch=[regex]::Match($source,'(?s)\$overlay=@\(.*?(?=function Pin)')
foreach($match in [regex]::Matches($overlayMatch.Value,"'(?<path>(?:src|public|tools|contracts|docs)/[^']+)'")){
 $relative=$match.Groups['path'].Value;$file=Join-Path $syntheticSource $relative
 New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force|Out-Null
 $content=if($relative -like '*.webmanifest'){'{"icons":[{"src":"/favicon.svg"}]}'}elseif($relative -like '*.json'){'{}'}elseif($relative -like '*.html'){'<script type="module" src="/dashboard-workspace.js"></script>'}else{'/* synthetic inert fixture */'}
 [IO.File]::WriteAllText($file,$content,$utf8)
}
New-Item -ItemType Directory -Path (Join-Path $syntheticSource 'scripts') -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'scripts/check-mobile-runtime-candidate.mjs') -Destination (Join-Path $syntheticSource 'scripts/check-mobile-runtime-candidate.mjs')
New-Item -ItemType Directory -Path (Join-Path $syntheticSource 'node_modules') -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'node_modules/acorn') -Destination (Join-Path $syntheticSource 'node_modules/acorn') -Recurse
$ownerLine='$owner=Join-Path ([Environment]::GetFolderPath(''UserProfile'')) ''.ai-control-center'''
if(($source.Split($ownerLine).Count-1) -ne 1){throw 'test_owner_expression_changed'}
$isolated=Join-Path $fixtureRoot 'isolated-preparer.ps1'
[IO.File]::WriteAllText($isolated,$source.Replace($ownerLine,('$owner='''+$owner.Replace("'","''")+"'")),$utf8)
$passed=0
function InvokePreparation([hashtable]$Overrides=@{}) {
 $params=@{RuntimeConfig=$configFile;ExpectedRuntimeConfigSha256=(Hash $configFile);ExpectedBaseManifestSha256=(Hash $manifestFile);OperationRoot=(Join-Path $backups ([guid]::NewGuid().ToString('N')));SourceRoot=$syntheticSource;NodeExecutable=$nodeFile;Assemble=$true}
 foreach($key in $Overrides.Keys){$params[$key]=$Overrides[$key]}
 & $isolated @params | ConvertFrom-Json -AsHashtable
}
function ExpectRefusal([string]$Expected,[hashtable]$Overrides=@{}) {
 try { $null=InvokePreparation $Overrides; throw 'unexpected_test_success' }
 catch { if($_.Exception.Message -cne $Expected){throw}; $script:passed++ }
}
$goodConfig=Hash $configFile
ExpectRefusal 'registered_runtime_config_pin_required' @{ExpectedRuntimeConfigSha256=('f'*64)}
[IO.File]::WriteAllText($serverFile,'tampered synthetic baseline')
ExpectRefusal 'lifecycle_baseline_drift_preserved'
[IO.File]::WriteAllText($serverFile,'synthetic immutable baseline')
$extra=Join-Path $base 'untracked.txt';[IO.File]::WriteAllText($extra,'preserve')
ExpectRefusal 'lifecycle_baseline_drift_preserved'
# Preserve the unexpected file and declare it explicitly for subsequent fixtures.
$cfg=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json -AsHashtable
$manifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json -AsHashtable
$manifest.files+=@{path='untracked.txt';size=(Get-Item -LiteralPath $extra).Length;sha256=(Hash $extra)}
[IO.File]::WriteAllText($manifestFile,($manifest|ConvertTo-Json -Depth 6),$utf8)
$cfg.releaseManifestSha256=Hash $manifestFile
[IO.File]::WriteAllText($configFile,($cfg|ConvertTo-Json -Depth 6),$utf8)
$validManifest=[IO.File]::ReadAllText($manifestFile)
$manifest.files+=@{path='../escape.txt';size=1;sha256=('a'*64)}
[IO.File]::WriteAllText($manifestFile,($manifest|ConvertTo-Json -Depth 6),$utf8)
$cfg.releaseManifestSha256=Hash $manifestFile
[IO.File]::WriteAllText($configFile,($cfg|ConvertTo-Json -Depth 6),$utf8)
ExpectRefusal 'invalid_baseline_pin_path'
[IO.File]::WriteAllText($manifestFile,$validManifest,$utf8)
$cfg.releaseManifestSha256=Hash $manifestFile
$cfg.nodeSha256='b'*64
[IO.File]::WriteAllText($configFile,($cfg|ConvertTo-Json -Depth 6),$utf8)
ExpectRefusal 'existing_node_pin_required'
$cfg.nodeSha256=Hash $nodeFile
[IO.File]::WriteAllText($configFile,($cfg|ConvertTo-Json -Depth 6),$utf8)
$configBefore=Hash $configFile;$manifestBefore=Hash $manifestFile
$result=InvokePreparation
$plan=Get-Content -LiteralPath $result.planFile -Raw|ConvertFrom-Json -AsHashtable
if($result.state -cne 'ASSEMBLED_NOT_APPLIED' -or $plan.activationSupported -ne $false -or $plan.ContainsKey('stoppedServiceActivation') -or $plan.ContainsKey('stoppedServiceInstaller') -or $plan.ContainsKey('publicEntry')){throw 'lifecycle_candidate_must_not_claim_legacy_activation'}
if($plan.lifecycleTransition.contractVersion -ne 1 -or $plan.lifecycleTransition.mode -cne 'ActivateNormallyStoppedLifecycle'){throw 'lifecycle_transition_contract_missing'}
if($plan.validation -cne 'STATIC_DEPENDENCIES_PASS_NOT_RUNTIME' -or $plan.staticPreflight.candidateCodeExecuted -ne $false -or $plan.staticCandidateCheck.candidateCodeExecuted -ne $false){throw 'static_gates_required'}
if((Hash $configFile) -cne $configBefore -or (Hash $manifestFile) -cne $manifestBefore){throw 'baseline_changed'}
$candidateConfig=Get-Content -LiteralPath $plan.preparedConfig -Raw|ConvertFrom-Json -AsHashtable
if($candidateConfig.remoteOrigin -cne $cfg.remoteOrigin -or (Test-Path -LiteralPath $plan.futureConfigPath)){throw 'candidate_installed_or_origin_changed'}
$candidateManifest=Get-Content -LiteralPath (Join-Path $result.candidateRoot '.aicc-release.json') -Raw|ConvertFrom-Json -AsHashtable
foreach($pin in $candidateManifest.files){if((Hash (Join-Path $result.candidateRoot $pin.path)) -cne $pin.sha256){throw 'candidate_pin_mismatch'}}
if(-not @($candidateManifest.files|Where-Object path -CEQ 'src/dashboard-workspace.mjs').Count){throw 'dashboard_missing'}
if(-not @($candidateManifest.files|Where-Object path -CEQ 'docs/dashboard-product-spec.md').Count){throw 'dashboard_description_missing'}
foreach($required in @('src/mobile-tray-tools.mjs','src/ocx-quota-dashboard.mjs','src/adapters/codex-app-server-proxy.mjs','src/runtime-layout.mjs','tools/platform/windows/tray-status.mjs','public/mobile-quota.js','public/mobile-quota.css','public/mobile-tools.js')){if(-not @($candidateManifest.files|Where-Object path -CEQ $required).Count){throw 'mobile_dependency_missing'}}
$passed++
$legacyEntry=Join-Path $backups 'legacy-public.mjs'
$legacyUri=([uri](Join-Path $base 'src/server.mjs')).AbsoluteUri
[IO.File]::WriteAllText($legacyEntry,("import { startServer } from '"+$legacyUri+"';"),$utf8)
$legacyManifest=@{schemaVersion=1;component='mobile-control';files=@(@{path='baseline.txt';size=(Get-Item -LiteralPath $serverFile).Length;sha256=(Hash $serverFile)})}
[IO.File]::WriteAllText($manifestFile,($legacyManifest|ConvertTo-Json -Depth 6),$utf8)
[IO.File]::WriteAllText((Join-Path $base '.aicc-device-trust-overlay.json'),'{"kind":"standalone-mobile-device-trust","changedFiles":[]}',$utf8)
$legacyParams=@{PublicEntry=$legacyEntry;ExpectedEntrySha256=(Hash $legacyEntry);ExpectedBaseManifestSha256=(Hash $manifestFile);OperationRoot=(Join-Path $backups ([guid]::NewGuid().ToString('N')));SourceRoot=$syntheticSource;NodeExecutable=$nodeFile}
$legacyResult=& $isolated @legacyParams|ConvertFrom-Json -AsHashtable
$legacyPlan=Get-Content -LiteralPath $legacyResult.planFile -Raw|ConvertFrom-Json -AsHashtable
if($legacyResult.state -cne 'PREPARED_NOT_APPLIED' -or $legacyPlan.stoppedServiceActivation.contractVersion -ne 1 -or $legacyPlan.publicEntry -cne $legacyEntry){throw 'legacy_preparation_contract_regressed'}
$passed++
[IO.File]::WriteAllText((Join-Path $syntheticSource 'src/mobile-control.mjs'),"import './missing-transitive.mjs';",$utf8)
$legacyParams.OperationRoot=Join-Path $backups ([guid]::NewGuid().ToString('N'))
try{$null=& $isolated @legacyParams;throw 'unexpected_missing_dependency_success'}catch{if($_.Exception.Message -cne 'candidate_dependency_check_failed'){throw}}
$blockedPlan=Get-Content -LiteralPath (Join-Path $legacyParams.OperationRoot 'plan.json') -Raw|ConvertFrom-Json -AsHashtable
if($blockedPlan.state -cne 'HOLD_DEPENDENCY_CHECK' -or (Test-Path -LiteralPath $blockedPlan.candidateRoot) -or $blockedPlan.ContainsKey('preparedConfig')){throw 'missing_dependency_must_block_before_candidate'}
$passed++
[IO.File]::WriteAllText($serverFile,'unapproved legacy baseline drift')
$legacyParams.OperationRoot=Join-Path $backups ([guid]::NewGuid().ToString('N'))
try{$null=& $isolated @legacyParams;throw 'unexpected_legacy_drift_success'}catch{if($_.Exception.Message -cne 'baseline_drift_outside_declared_device_overlay'){throw};$passed++}
@{passed=$passed;failed=0;synthetic=$true;serviceStarts=0;taskChanges=0;modelCalls=0;externalMessages=0;fixturePreserved=$true}|ConvertTo-Json -Compress
