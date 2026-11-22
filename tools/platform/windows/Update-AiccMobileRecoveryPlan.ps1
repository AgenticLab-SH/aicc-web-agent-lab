#requires -Version 7.5
# Revision of execution bindings only; never rebuild or modify a sealed candidate.
[CmdletBinding()]param(
 [Parameter(Mandatory)][string]$PlanFile,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPlanSha256,
 [Parameter(Mandatory)][string]$OperationRoot,
 [switch]$Apply,[string]$ExpectedPreviewSha256
)
$ErrorActionPreference='Stop'
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
function Hash($f){(Get-FileHash -LiteralPath $f).Hash.ToLowerInvariant()}
function Regular($f,$root){$p=(Resolve-Path -LiteralPath $f).Path;if(-not $p.StartsWith(($root.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'revision_boundary_invalid'};for($a=$p;$a;$a=Split-Path -Parent $a){if((Get-Item -LiteralPath $a).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'revision_link_denied'};if((Split-Path -Parent $a) -eq $a){break}};return $p}
$backups=Join-Path $owner 'backups';$path=Regular $PlanFile $backups
if((Hash $path) -cne $ExpectedPlanSha256){throw 'revision_original_plan_changed'}
$plan=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json -AsHashtable -DateKind String
if($plan.state -cne 'ASSEMBLED_NOT_APPLIED' -or $plan.runtimeApplied -ne $false -or $plan.lifecycleTransition.contractVersion -ne 1){throw 'revision_unapplied_plan_required'}
$old=Split-Path -Parent $path
foreach($f in @('activation-attempt.json','rollback-attempt.json')){if(Test-Path -LiteralPath (Join-Path $old $f)){throw 'revision_existing_attempt_preserved'}}
foreach($f in @('installer-preflight.json','recovery-preflight.json')){
 $pre=Join-Path $old $f
 if(Test-Path -LiteralPath $pre){$v=Get-Content -LiteralPath $pre -Raw|ConvertFrom-Json -AsHashtable;$id=if($f -eq 'installer-preflight.json'){$v.installerPid}else{$v.restorePid};if(-not $id -or @(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$id) -ErrorAction Stop).Count){throw 'revision_active_or_unknown_verifier_preserved'}}
}
$target=[IO.Path]::GetFullPath($OperationRoot)
if(-not $target.StartsWith(($backups+'\'),[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $target)){throw 'revision_new_operation_directory_required'}
$regFile=Regular (Join-Path $owner 'control-plane/mobile-public-recovery/current.json') (Join-Path $owner 'control-plane/mobile-public-recovery')
$regHash=Hash $regFile;$reg=Get-Content -LiteralPath $regFile -Raw|ConvertFrom-Json
$mf=Regular $reg.manifestFile (Join-Path $owner 'releases/mobile-public-recovery')
if((Hash $mf) -cne $reg.manifestSha256){throw 'revision_install_manifest_changed'}
$manifest=Get-Content -LiteralPath $mf -Raw|ConvertFrom-Json
$release=Split-Path -Parent $mf
foreach($pin in $manifest.files){$f=Regular (Join-Path $release $pin.path) $release;if((Hash $f) -cne $pin.sha256){throw 'revision_installed_tool_changed'}}
$restore=Join-Path $release 'tools/platform/windows/Restore-AiccMobilePublicRuntime.ps1'
$restoreHash=Hash $restore
$moduleHash=Hash (Join-Path $release 'tools/platform/windows/MobilePublicTransition.psm1')
if($moduleHash -cne $plan.lifecycleTransition.moduleSha256){throw 'revision_transition_semantics_changed'}
$prepared=Regular $plan.preparedConfig $old
if((Hash $prepared) -cne $plan.configSha256 -or (Hash $plan.runtimeConfig) -cne $plan.runtimeConfigSha256 -or (Hash (Join-Path $plan.candidateRoot '.aicc-release.json')) -cne $plan.candidateManifestSha256){throw 'revision_candidate_or_owner_changed'}
$preview=@{action='revise-mobile-recovery-executor';originalPlanSha256=$ExpectedPlanSha256;registrySha256=$regHash;rollbackSha256=$restoreHash;operationRoot=$target;candidateManifestSha256=$plan.candidateManifestSha256;candidateModified=$false;attemptsReplayed=$false}
$digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($ExpectedPlanSha256+'|'+$regHash+'|'+$restoreHash+'|'+$target)))).ToLowerInvariant()
if(-not $Apply){@{preview=$preview;previewSha256=$digest}|ConvertTo-Json -Depth 5;return}
if($ExpectedPreviewSha256 -cne $digest){throw 'revision_fresh_preview_required'}
$lock=[IO.File]::Open((Join-Path $owner 'control-plane/mobile-public-runtime/activation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
 if((Hash $path) -cne $ExpectedPlanSha256 -or (Hash $regFile) -cne $regHash -or (Hash $prepared) -cne $plan.configSha256 -or (Test-Path -LiteralPath (Join-Path $old 'activation-attempt.json'))){throw 'revision_final_cas_changed'}
 $null=New-Item -ItemType Directory -Path $target -ErrorAction Stop
 [IO.File]::Copy($path,(Join-Path $target 'plan.before.json'),$false)
 $newConfig=Join-Path $target 'prepared-runtime-config.json';[IO.File]::Copy($prepared,$newConfig,$false)
 $plan.preparedConfig=$newConfig;$plan.lifecycleTransition.rollbackSha256=$restoreHash
 $plan.recoveryRevision=@{schemaVersion=1;originalPlan=$path;originalPlanSha256=$ExpectedPlanSha256;registrySha256=$regHash;restore=$restore;createdAt=[DateTimeOffset]::UtcNow.ToString('o');candidateUnchanged=$true;originalAttemptsPreserved=$true}
 $newPlan=Join-Path $target 'plan.json'
 [IO.File]::WriteAllText($newPlan,($plan|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
 if((Hash $path) -cne $ExpectedPlanSha256 -or (Hash $newConfig) -cne $plan.configSha256){throw 'revision_readback_failed'}
 @{state='REVISED_NOT_APPLIED';planFile=$newPlan;planSha256=Hash $newPlan;candidateRoot=$plan.candidateRoot;restore=$restore;originalPlanSha256=$ExpectedPlanSha256}|ConvertTo-Json
}finally{$lock.Dispose()}
