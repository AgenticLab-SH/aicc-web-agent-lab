#requires -Version 7.3
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$planner = Join-Path $repoRoot 'tools/platform/opencodex/New-AiccOcxCompatibilityPlan.ps1'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $tempRoot ('aicc-ocx-compat-plan-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$checks = [Collections.Generic.List[string]]::new()
function WriteJson($Path,$Value) { [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false)) }
function Hash($Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert($Condition,$Message) { if(-not $Condition){throw $Message} }
try {
    $sourceRoot = Join-Path $fixtureRoot 'source'
    [IO.Directory]::CreateDirectory($sourceRoot) | Out-Null
    $sourcePath = Join-Path $sourceRoot 'external-runtime.ts'
    [IO.File]::WriteAllText($sourcePath, "load('src/index.ts');", [Text.UTF8Encoding]::new($false))
    $baselinePath = Join-Path $fixtureRoot 'release-manifest.json'
    $registryPath = Join-Path $fixtureRoot 'current.json'
    $receiptPath = Join-Path $fixtureRoot 'upstream-artifact.json'
    $archivePath = Join-Path $fixtureRoot 'package.tgz'
    $baseline = @{schema='aicc-external-ocx-release/v1'; supplierVersion='2.81.0'; adapterFiles=@{'external-runtime.ts'=(Hash $sourcePath)}; supplierFiles=@{'src/index.ts'=('0'*64);'package.json'=('1'*64);'removed.ts'=('2'*64)}}
    $registry = @{schemaVersion=1;requestExecution='windows-local';credentialWriter='a1';version='2.81.0';adapterManifest=$baselinePath}
    WriteJson $baselinePath $baseline
    WriteJson $registryPath $registry
    function NewArchive([string]$Version='2.96.0',[string]$ExtraPath='package/src/index.ts',[switch]$Duplicate,[switch]$Link) {
        $stream=[IO.File]::Create($archivePath)
        $gzip=[IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionMode]::Compress)
        $writer=[System.Formats.Tar.TarWriter]::new($gzip)
        try {
            $packageText=@{name='@bitkyc08/opencodex';version=$Version}|ConvertTo-Json -Compress
            $entries=@(@{name='package/package.json';text=$packageText},@{name=$ExtraPath;text='export const fixture = true;'})
            if($Duplicate){$entries+=@{name=$ExtraPath;text='duplicate'}}
            foreach($data in $entries){
                $entry=[System.Formats.Tar.PaxTarEntry]::new([System.Formats.Tar.TarEntryType]::RegularFile,$data.name)
                $content=[IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($data.text))
                try{$entry.DataStream=$content;$writer.WriteEntry($entry)}finally{$content.Dispose()}
            }
            if($Link){
                $entry=[System.Formats.Tar.PaxTarEntry]::new([System.Formats.Tar.TarEntryType]::SymbolicLink,'package/linked.ts')
                $entry.LinkName='../outside.ts'
                $writer.WriteEntry($entry)
            }
        } finally {$writer.Dispose();$gzip.Dispose();$stream.Dispose()}
        $digest=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA512).Hash.ToLowerInvariant()
        $script:receipt=@{schemaVersion=1;name='@bitkyc08/opencodex';version='2.96.0';registry='https://registry.npmjs.org';tarball='https://registry.npmjs.org/@bitkyc08/opencodex/-/opencodex-2.96.0.tgz';integrity=('sha512-'+[Convert]::ToBase64String([Convert]::FromHexString($digest)));sha512=$digest;scope='unmodified-upstream-archive';packageModified=$false;runtimeActivated=$false;dependenciesInstalled=$false}
        WriteJson $receiptPath $script:receipt
    }
    function Plan { & $planner -TargetVersion 2.96.0 -ArtifactReceiptPath $receiptPath -RuntimeRegistryPath $registryPath -AdapterSourceRoot $sourceRoot | ConvertFrom-Json }
    function Refuses([string]$Name,[string]$Pattern) {
        $caught=$null
        try { $ignored=Plan } catch { $caught=$_.Exception.Message }
        Assert ($caught -and $caught -match $Pattern) ('Expected refusal: '+$Name+'; '+$caught)
        $checks.Add($Name)
    }
    NewArchive
    $before=@{}; Get-ChildItem -LiteralPath $fixtureRoot -File -Recurse | ForEach-Object { $before[$_.FullName]=Hash $_.FullName }
    $plan=Plan
    Assert ($plan.status -eq 'PREPARED_CONTRACT_REVIEW_REQUIRED' -and -not $plan.canActivate -and -not $plan.compatibility.accepted -and $plan.compatibility.verification -eq 'NOT_RUN') 'Plan must not authorize installation'
    Assert ($plan.inventoryDelta.changedCommon -eq 2 -and $plan.inventoryDelta.baselineOnly -eq 1 -and -not $plan.inventoryDelta.isUpstreamChangelog -and $plan.inventoryDelta.missingImports -eq 0) 'Inventory delta differs'
    Assert ($plan.adapterSourceSha256.'external-runtime.ts' -eq (Hash $sourcePath) -and $plan.target.supplierFiles.'src/index.ts') 'Source/supplier pins missing'
    foreach($name in $before.Keys){Assert ((Hash $name) -eq $before[$name]) 'Read-only planner changed an input'}
    Assert (@(Get-ChildItem -LiteralPath $fixtureRoot -File -Recurse).Count -eq $before.Count) 'Planner wrote or extracted a file'
    $checks.Add('valid plan is pinned, read-only and never acceptance')
    NewArchive
    $receipt.sha512='0'*128; $receipt.integrity='sha512-'+[Convert]::ToBase64String([byte[]]::new(64)); WriteJson $receiptPath $receipt
    Refuses 'archive digest mismatch' 'archive SHA512 differs'
    NewArchive
    $receipt.integrity='sha512-'+[Convert]::ToBase64String([byte[]]::new(64)); WriteJson $receiptPath $receipt
    Refuses 'SRI and receipt digest mismatch' 'SHA512 and SRI differ'
    NewArchive -Version 2.95.0
    Refuses 'archive package identity mismatch' 'package identity differs'
    NewArchive -ExtraPath 'package/../escape.ts'
    Refuses 'archive traversal' 'Unsafe or duplicate archive path'
    NewArchive -ExtraPath 'package/src/INDEX.ts' -Duplicate
    Refuses 'duplicate archive entry' 'Unsafe or duplicate archive path'
    NewArchive -Link
    Refuses 'archive link' 'Unsafe archive entry type'
    NewArchive
    $receipt.Remove('packageModified'); WriteJson $receiptPath $receipt
    Refuses 'missing preparation ownership flag' 'Exact prepared upstream receipt'
    NewArchive
    $registry.version='2.96.0'; WriteJson $registryPath $registry
    Refuses 'unrecognized running baseline' 'Known 2.81 local runtime baseline'
    $registry.version='2.81.0'; WriteJson $registryPath $registry
    NewArchive -ExtraPath 'package/src/replacement.ts'
    $plan=Plan
    Assert ($plan.inventoryDelta.missingImports -eq 1 -and $plan.supplierImportReview[0].state -eq 'MISSING' -and -not $plan.canActivate) 'Missing import must remain explicit review work'
    $checks.Add('missing imports reported without acceptance')
    $entryPoint=Join-Path $repoRoot 'tools/platform/opencodex/Prepare-AiccOcxUpstream.ps1'
    $caught=$null
    try{$ignored=& $entryPoint -Action PlanCompatibility -TargetVersion latest -ArtifactReceiptPath $receiptPath}catch{$caught=$_.Exception.Message}
    Assert ($caught -match 'exact target') 'Offline entrypoint must reject latest before network/owner reads'
    $checks.Add('existing prepare entrypoint rejects unpinned latest offline')
    @{status='PASS';checks=$checks.Count;names=$checks}|ConvertTo-Json -Depth 4
} finally {
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    if(-not $resolved.StartsWith($tempRoot.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
       (Split-Path $resolved -Leaf) -notmatch '^aicc-ocx-compat-plan-[a-f0-9]{32}$' -or
       ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe fixture cleanup target' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
