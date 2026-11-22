#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Check','Prepare','PlanCompatibility')][string]$Action='Check',[string]$TargetVersion='latest',[string]$ArtifactReceiptPath,
    [string]$ReviewedAdapterAdditionsPath,[string]$ExpectedReviewedAdapterAdditionsSha256,
    [switch]$AllowSameSupplierAdapterRevision)
$ErrorActionPreference='Stop'
if($Action -eq 'PlanCompatibility'){
    if(-not $ArtifactReceiptPath -or $TargetVersion -eq 'latest'){throw 'Offline compatibility planning requires an exact target and existing artifact receipt.'}
    & (Join-Path $PSScriptRoot 'New-AiccOcxCompatibilityPlan.ps1') -TargetVersion $TargetVersion -ArtifactReceiptPath $ArtifactReceiptPath `
      -ReviewedAdapterAdditionsPath $ReviewedAdapterAdditionsPath `
      -ExpectedReviewedAdapterAdditionsSha256 $ExpectedReviewedAdapterAdditionsSha256 `
      -AllowSameSupplierAdapterRevision:$AllowSameSupplierAdapterRevision
    return
}
if($ReviewedAdapterAdditionsPath -or $ExpectedReviewedAdapterAdditionsSha256 -or $AllowSameSupplierAdapterRevision){
    throw 'Reviewed adapter closure inputs are limited to offline PlanCompatibility'
}
if($TargetVersion -ne 'latest' -and $TargetVersion -notmatch '^\d+\.\d+\.\d+$'){throw 'Exact stable upstream version or latest required.'}
$ownerHome=[Environment]::GetFolderPath('UserProfile')
$homeRoot=Join-Path $ownerHome '.ai-control-center'
$registryPath=Join-Path $homeRoot 'runtime/ocx-local/current.json'
$registered=Get-Content -LiteralPath $registryPath -Raw|ConvertFrom-Json
if($registered.schemaVersion -ne 1 -or $registered.requestExecution -ne 'windows-local' -or $registered.credentialWriter -ne 'a1'){
    throw 'Managed local OCX owner differs; no software mutation.'
}
# A custom suffix describes ownership; compare the exact upstream base.
$installed=[string]$registered.version
if($installed -notmatch '^(\d+\.\d+\.\d+)(?:-aicc\.[A-Za-z0-9.-]+)?$'){
    throw 'Installed upstream base unknown; do not report already latest.'
}
$upstreamBase=$Matches[1]
$metadata=Invoke-RestMethod ('https://registry.npmjs.org/@bitkyc08%2fopencodex/'+$TargetVersion) -TimeoutSec 20
$latest=[string]$metadata.version
if($metadata.name -cne '@bitkyc08/opencodex' -or $latest -notmatch '^\d+\.\d+\.\d+$' -or
   ($TargetVersion -ne 'latest' -and $latest -cne $TargetVersion)){
    throw 'Exact upstream registry identity differs.'
}
$expectedUrl='https://registry.npmjs.org/@bitkyc08/opencodex/-/opencodex-'+$latest+'.tgz'
if($metadata.dist.tarball -cne $expectedUrl -or $metadata.dist.integrity -notmatch '^sha512-([A-Za-z0-9+/=]+)$'){
    throw 'Official registry artifact or integrity unknown.'
}
$expectedHash=[Convert]::ToHexString([Convert]::FromBase64String($Matches[1])).ToLowerInvariant()
if($expectedHash.Length -ne 128){throw 'Exact SHA512 integrity required.'}
$newer=[version]$latest -gt [version]$upstreamBase
$external=$null -ne $registered.PSObject.Properties['adapterManifest'] -and $installed -ceq $upstreamBase
$result=[ordered]@{
    terminal=if($newer){'UPDATE_AVAILABLE_COMPATIBILITY_REQUIRED'}elseif($external){'CLEAN_UPSTREAM_CURRENT'}else{'UPSTREAM_BASE_CURRENT_COMPATIBILITY_REQUIRED'}
    installedRuntimeVersion=$installed;installedUpstreamVersion=$upstreamBase;latestVersion=$latest;updateAvailable=$newer
    ownership=if($external){'clean-upstream-with-independent-aicc-adapter'}else{'aicc-managed-fork'};updateMode='separate-unmodified-upstream-archive';canPrepare=$true;canActivate=$false
    reason=if($external -and -not $newer){'Official supplier version is current; AICC policy is external. Future versions require compatibility acceptance.'}else{'Prepare the official archive independently; activation requires accepted external adapter contracts.'}
    source='https://registry.npmjs.org/@bitkyc08%2fopencodex'
    changed=$false;runtimeActivated=$false;servicesRestarted=$false;accountStateChanged=$false;nativeConfigChanged=$false
}
if($Action -eq 'Check'){$result|ConvertTo-Json -Compress;return}

# This store contains only upstream archives. It is separate from the running
# fork, global Bun install, OCX accounts, Native, model bridge and A1 service.
$store=[IO.Path]::GetFullPath((Join-Path $homeRoot 'opencodex-native/registry-artifacts'))
$artifactRoot=Join-Path (Join-Path $store $latest) $expectedHash.Substring(0,16)
$artifactPath=Join-Path $artifactRoot 'package.tgz'
$ancestor=$artifactRoot
while($ancestor){
    if((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint)){
        throw 'Linked artifact path refused.'
    }
    $parent=Split-Path $ancestor -Parent
    if($parent -eq $ancestor){break}
    $ancestor=$parent
}
$lock=$null
try{
    New-Item -Path $artifactRoot -ItemType Directory -Force|Out-Null
    $lockPath=Join-Path $artifactRoot 'prepare.lock'
    if((Test-Path -LiteralPath $lockPath) -and ((Get-Item -LiteralPath $lockPath).Attributes -band [IO.FileAttributes]::ReparsePoint)){
        throw 'Linked preparation lock refused.'
    }
    $lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $reused=Test-Path -LiteralPath $artifactPath
    if($reused){
        $item=Get-Item -LiteralPath $artifactPath
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Regular artifact required.'}
        if((Get-FileHash -LiteralPath $artifactPath -Algorithm SHA512).Hash.ToLowerInvariant() -cne $expectedHash){
            throw 'Existing artifact integrity differs; preserve it for diagnosis.'
        }
    }else{
        $download=Join-Path $artifactRoot ('.download-'+[guid]::NewGuid().ToString('N')+'.tgz')
        Invoke-WebRequest -Uri $expectedUrl -OutFile $download -TimeoutSec 90
        if((Get-FileHash -LiteralPath $download -Algorithm SHA512).Hash.ToLowerInvariant() -cne $expectedHash){
            throw 'Downloaded artifact integrity differs; do not execute or activate it.'
        }
        Move-Item -LiteralPath $download -Destination $artifactPath
    }
    $receipt=[ordered]@{
        schemaVersion=1;name=$metadata.name;version=$latest;registry='https://registry.npmjs.org'
        tarball=$expectedUrl;integrity=$metadata.dist.integrity;sha512=$expectedHash
        scope='unmodified-upstream-archive';packageModified=$false;runtimeActivated=$false;dependenciesInstalled=$false
        verifiedAtKst=[DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(9)).ToString('o')
    }
    $receiptPath=Join-Path $artifactRoot 'upstream-artifact.json'
    if((Test-Path -LiteralPath $receiptPath) -and ((Get-Item -LiteralPath $receiptPath).Attributes -band [IO.FileAttributes]::ReparsePoint)){
        throw 'Linked artifact receipt refused.'
    }
    $receiptTemp=Join-Path $artifactRoot ('.receipt-'+[guid]::NewGuid().ToString('N')+'.json')
    $receipt|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $receiptTemp -Encoding utf8
    Move-Item -LiteralPath $receiptTemp -Destination $receiptPath -Force
    $result.terminal='UPSTREAM_PREPARED_RUNTIME_MIGRATION_REQUIRED'
    $result.changed=-not $reused
    $result.artifactPath=$artifactPath
    $result.registryIntegrityMatched=$true
    $result|ConvertTo-Json -Compress
}finally{if($lock){$lock.Dispose()}}
