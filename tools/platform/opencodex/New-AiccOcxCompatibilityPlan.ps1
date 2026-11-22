#requires -Version 7.3
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$TargetVersion,
    [Parameter(Mandatory)][string]$ArtifactReceiptPath,
    [string]$RuntimeRegistryPath = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center/runtime/ocx-local/current.json'),
    [string]$AdapterSourceRoot = $PSScriptRoot,
    [string]$ReviewedAdapterAdditionsPath,
    [string]$ExpectedReviewedAdapterAdditionsSha256,
    [switch]$AllowSameSupplierAdapterRevision
)
$ErrorActionPreference = 'Stop'
# Preparation only: read existing software evidence; never import supplier code,
# extract archives, install dependencies, call the network or mutate any owner.
function RegularFile([string]$Path) {
    if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw 'Absolute input path required' }
    $full = [IO.Path]::GetFullPath($Path)
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer) { throw 'Regular input file required' }
    $ancestor = $full
    while ($ancestor) {
        if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked input path refused' }
        $parent = Split-Path $ancestor -Parent
        if ($parent -eq $ancestor) { break }
        $ancestor = $parent
    }
    return $full
}
function Sha256([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
function ReadPinnedJson([string]$Path) {
    $full = RegularFile $Path
    $bytes = [IO.File]::ReadAllBytes($full)
    return @{ path=$full; sha256=(Sha256 $bytes); value=([Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xfeff) | ConvertFrom-Json -AsHashtable) }
}
function SafeRelative([string]$Name) {
    return $Name -and $Name -notmatch '[:\\\x00-\x1f]' -and $Name -notmatch '^/|/$' -and @($Name.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -eq 0
}
function RegularDirectory([string]$Path) {
    if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw 'Absolute installed supplier root required' }
    $full = [IO.Path]::GetFullPath($Path)
    $item = Get-Item -LiteralPath $full -Force
    if (-not $item.PSIsContainer) { throw 'Installed supplier directory required' }
    for ($ancestor=$full; $ancestor;) {
        if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Linked installed supplier root refused'
        }
        $parent = Split-Path $ancestor -Parent
        if ($parent -eq $ancestor) { break }
        $ancestor = $parent
    }
    return $full
}
function HashFile([string]$Path) {
    $stream=[IO.File]::OpenRead($Path)
    try { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
    finally { $stream.Dispose() }
}
function InstalledSupplierTree([string]$Root) {
    $full=RegularDirectory $Root
    $found=[ordered]@{}
    $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($item in Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction Stop) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked supplier file or junction refused' }
        $relative=[IO.Path]::GetRelativePath($full,$item.FullName).Replace('\','/')
        if (-not (SafeRelative $relative)) { throw 'Unsafe installed supplier relative path' }
        if ($item.PSIsContainer) { continue }
        if (-not $names.Add($relative) -or $found.Count -ge 50000) { throw 'Duplicate or oversized installed supplier tree' }
        $found[$relative]=HashFile $item.FullName
    }
    return $found
}
$receipt = ReadPinnedJson $ArtifactReceiptPath
$r = $receipt.value
$expectedUrl = 'https://registry.npmjs.org/@bitkyc08/opencodex/-/opencodex-' + $TargetVersion + '.tgz'
if ($r.schemaVersion -ne 1 -or $r.name -cne '@bitkyc08/opencodex' -or $r.version -cne $TargetVersion -or
    $r.registry -cne 'https://registry.npmjs.org' -or $r.tarball -cne $expectedUrl -or
    $r.scope -cne 'unmodified-upstream-archive' -or $r.packageModified -cne $false -or
    $r.runtimeActivated -cne $false -or $r.dependenciesInstalled -cne $false -or
    $r.sha512 -cnotmatch '^[a-f0-9]{128}$' -or $r.integrity -cnotmatch '^sha512-([A-Za-z0-9+/=]+)$') {
    throw 'Exact prepared upstream receipt required'
}
$integrityHash = [Convert]::ToHexString([Convert]::FromBase64String($Matches[1])).ToLowerInvariant()
if ($integrityHash -cne $r.sha512) { throw 'Receipt SHA512 and SRI differ' }
$runtime = ReadPinnedJson $RuntimeRegistryPath
$registered = $runtime.value
if ($registered.schemaVersion -ne 1 -or $registered.requestExecution -cne 'windows-local' -or
    $registered.credentialWriter -cne 'a1' -or ($registered.version -cne '2.81.0' -and
    -not ($registered.version -ceq '2.96.0' -and $AllowSameSupplierAdapterRevision -and
      $ReviewedAdapterAdditionsPath))) { throw 'Known 2.81 local runtime baseline required' }
$baseline = ReadPinnedJson ([string]$registered.adapterManifest)
$b = $baseline.value
if ($b.schema -cne 'aicc-external-ocx-release/v1' -or $b.supplierVersion -cne $registered.version -or
    $b.supplierFiles -isnot [System.Collections.IDictionary] -or $b.supplierFiles.Count -eq 0 -or
    $b.adapterFiles -isnot [System.Collections.IDictionary] -or $b.adapterFiles.Count -eq 0) { throw 'Sealed baseline inventory required' }
$sameSupplierRevision = [version]$TargetVersion -eq [version]$registered.version
if ([version]$TargetVersion -lt [version]$registered.version -or
    ($sameSupplierRevision -and (-not $AllowSameSupplierAdapterRevision -or -not $ReviewedAdapterAdditionsPath)) -or
    ($AllowSameSupplierAdapterRevision -and -not $sameSupplierRevision)) {
    throw 'Newer supplier target or explicit same-supplier reviewed adapter revision required'
}
if ([bool]$ReviewedAdapterAdditionsPath -ne [bool]$ExpectedReviewedAdapterAdditionsSha256) {
    throw 'Exact reviewed adapter receipt and SHA must be supplied together'
}
if ($ExpectedReviewedAdapterAdditionsSha256 -and $ExpectedReviewedAdapterAdditionsSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Reviewed adapter receipt SHA invalid'
}
foreach ($name in $b.supplierFiles.Keys) {
    if (-not (SafeRelative $name) -or $b.supplierFiles[$name] -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid baseline supplier pin' }
}
$reviewedPins = [ordered]@{}
$reviewedReceipt = $null
if ($ReviewedAdapterAdditionsPath) {
    if ($b.adapterFiles.Count -notin @(14,15) -or @('external-runtime.ts','external-pool-state.ts',
      'external-http-boundary.ts','external-conversation-lifecycle.ts','window-inflight-monitor.ts' |
      Where-Object { -not $b.adapterFiles.Contains($_) }).Count -ne 0) {
        throw 'Exact installed 14-module OCX baseline required for reviewed additions'
    }
    $reviewedReceipt = ReadPinnedJson $ReviewedAdapterAdditionsPath
    if ($reviewedReceipt.sha256 -cne $ExpectedReviewedAdapterAdditionsSha256) {
        throw 'Reviewed additions receipt SHA changed'
    }
    $v = $reviewedReceipt.value
    $revisionOnly = $v.kind -ceq 'aicc-ocx-reviewed-existing-adapter-revision/v1'
    if ($v.schemaVersion -ne 1 -or
        ($v.kind -cne 'aicc-ocx-reviewed-adapter-additions/v1' -and -not $revisionOnly) -or
        $v.runtimeRegistrySha256 -cne $runtime.sha256 -or
        $v.baselineManifestSha256 -cne $baseline.sha256 -or
        $v.targetSupplierVersion -cne $TargetVersion -or
        $v.adapterFiles -isnot [Collections.IDictionary] -or
        $v.adapterFiles.Count -gt 8 -or
        (-not $revisionOnly -and $v.adapterFiles.Count -lt 1)) {
        throw 'Exact reviewed additions identity and source pins required'
    }
    if ($revisionOnly) {
        if (-not $sameSupplierRevision -or $b.adapterFiles.Count -ne 15 -or $v.adapterFiles.Count -ne 0 -or
            -not $b.adapterFiles.Contains('external-original-quota-receipt.ts') -or
            $v.sourceSha256 -isnot [Collections.IDictionary] -or $v.sourceSha256.Count -ne 15) {
            throw 'Exact existing 15-module revision receipt required'
        }
        foreach ($name in $b.adapterFiles.Keys) {
            if (-not $v.sourceSha256.Contains($name) -or $v.sourceSha256[$name] -cnotmatch '^[a-f0-9]{64}$' -or
                (Sha256 ([IO.File]::ReadAllBytes((RegularFile (Join-Path $AdapterSourceRoot $name))))) -cne $v.sourceSha256[$name]) {
                throw 'Reviewed existing adapter revision source SHA changed'
            }
        }
    } elseif ($b.adapterFiles.Count -notin @(14,15) -or
        ($b.adapterFiles.Count -eq 15 -and -not $b.adapterFiles.Contains('external-original-quota-receipt.ts'))) {
        throw 'Exact installed 14/15-module OCX baseline required for reviewed additions'
    }
    foreach ($name in @($v.adapterFiles.Keys | Sort-Object)) {
        if ($name -cnotmatch '^(external-[a-z-]+|window-inflight-monitor)\.ts$' -or
            $b.adapterFiles.Contains($name) -or $v.adapterFiles[$name] -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Reviewed addition overlaps baseline or has unsafe member'
        }
        $reviewedPins[$name] = [string]$v.adapterFiles[$name]
    }
}
$sourcePins = [ordered]@{}
$relativeImports = [ordered]@{}
$imports = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$allNames = @($b.adapterFiles.Keys) + @($reviewedPins.Keys)
foreach ($name in @($allNames | Sort-Object -Unique -CaseSensitive)) {
    if ($name -cnotmatch '^(external-[a-z-]+|window-inflight-monitor)\.ts$') {
        throw 'Unsafe adapter member'
    }
    if ($b.adapterFiles.Contains($name) -and $b.adapterFiles[$name] -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Invalid baseline adapter pin'
    }
    $sourcePath = RegularFile (Join-Path $AdapterSourceRoot $name)
    $bytes = [IO.File]::ReadAllBytes($sourcePath)
    $sha = Sha256 $bytes
    if ($reviewedPins.Contains($name) -and $sha -cne $reviewedPins[$name]) {
        throw 'Reviewed adapter addition source SHA changed'
    }
    $sourcePins[$name] = $sha
    $body = [Text.Encoding]::UTF8.GetString($bytes)
    $dependencies = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    # Literal static ESM imports/exports include named imports spanning lines.
    $matches = [regex]::Matches($body, '(?m)^[ \t]*(?:import|export)[ \t]+(?:[^;''"]*?\s+from\s*)?[''"](?<spec>[^''"\r\n]+)[''"]')
    foreach ($match in $matches) {
        $specifier = $match.Groups['spec'].Value
        if ($specifier.StartsWith('.', [StringComparison]::Ordinal)) {
            if ($specifier -cnotmatch '^\./(?<member>external-[a-z-]+|window-inflight-monitor)(?:\.ts)?$') {
                throw 'Unsafe or unsupported relative adapter dependency'
            }
            $dependency = $Matches['member'] + '.ts'
            if ($dependency -cnotin $allNames) { throw 'Unpinned relative adapter dependency' }
            [void]$dependencies.Add($dependency)
        }
    }
    if ([regex]::IsMatch($body, 'import\s*\(\s*[''"]\.\.?/') -or
        [regex]::IsMatch($body, 'require\s*\(\s*[''"]\.\.?/')) {
        throw 'Dynamic relative adapter import requires separate review'
    }
    $relativeImports[$name] = @($dependencies | Sort-Object -CaseSensitive)
    # Literal supplier imports define review scope, not export/API compatibility.
    foreach ($match in [regex]::Matches($body, '[''"](?<path>src/[^''"\r\n]+\.(?:ts|js))[''"]')) {
        $relative = $match.Groups['path'].Value
        if (-not (SafeRelative $relative)) { throw 'Unsafe literal supplier import' }
        [void]$imports.Add($relative)
    }
}
$reachable = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$work = [Collections.Generic.Queue[string]]::new()
foreach ($name in $b.adapterFiles.Keys) { $work.Enqueue([string]$name) }
while ($work.Count) {
    $name = $work.Dequeue()
    if (-not $reachable.Add($name)) { continue }
    foreach ($dependency in $relativeImports[$name]) { $work.Enqueue($dependency) }
}
foreach ($name in $reviewedPins.Keys) {
    if (-not $reachable.Contains($name)) { throw 'Unreachable reviewed adapter addition refused' }
}
if ($imports.Count -eq 0) { throw 'No supplier import review scope found' }
$artifactPath = RegularFile (Join-Path (Split-Path $receipt.path -Parent) 'package.tgz')
$files = [ordered]@{}
$names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$packageJson = $null
$stream = [IO.File]::Open($artifactPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $actual = [Convert]::ToHexString([Security.Cryptography.SHA512]::HashData($stream)).ToLowerInvariant()
    if ($actual -cne $r.sha512) { throw 'Prepared archive SHA512 differs' }
    $stream.Position = 0
    $gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionMode]::Decompress, $true)
    try {
        $tar = [System.Formats.Tar.TarReader]::new($gzip, $true)
        try {
            while ($entry = $tar.GetNextEntry()) {
                if ($entry.EntryType -eq [System.Formats.Tar.TarEntryType]::Directory) {
                    $directory = $entry.Name.TrimEnd('/')
                    if ($directory -cne 'package' -and (-not $directory.StartsWith('package/', [StringComparison]::Ordinal) -or -not (SafeRelative $directory.Substring(8)))) { throw 'Unsafe archive directory' }
                    continue
                }
                if ($entry.EntryType -notin @([System.Formats.Tar.TarEntryType]::RegularFile, [System.Formats.Tar.TarEntryType]::V7RegularFile) -or
                    -not $entry.Name.StartsWith('package/', [StringComparison]::Ordinal)) { throw 'Unsafe archive entry type or prefix' }
                $relative = $entry.Name.Substring(8)
                if (-not (SafeRelative $relative) -or -not $names.Add($relative)) { throw 'Unsafe or duplicate archive path' }
                if ($entry.Length -gt 67108864 -or $files.Count -ge 50000) { throw 'Archive review limit exceeded' }
                if ($relative -ceq 'package.json') {
                    if ($entry.Length -gt 1048576) { throw 'Oversized package identity' }
                    $buffer = [IO.MemoryStream]::new()
                    try {
                        $entry.DataStream.CopyTo($buffer)
                        $bytes = $buffer.ToArray()
                        $files[$relative] = Sha256 $bytes
                        $packageJson = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -AsHashtable
                    } finally { $buffer.Dispose() }
                } else {
                    $files[$relative] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($entry.DataStream)).ToLowerInvariant()
                }
            }
        } finally { $tar.Dispose() }
    } finally { $gzip.Dispose() }
} finally { $stream.Dispose() }
if ($null -eq $packageJson -or $packageJson.name -cne $r.name -or $packageJson.version -cne $TargetVersion) { throw 'Archive package identity differs' }
$installedSupplierReuse=$null
$installedSupplierReuseSha256=$null
if ($sameSupplierRevision) {
    if ($b.supplierRoot -isnot [string] -or $b.acceptanceSha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Exact installed supplier root and previous acceptance pin required'
    }
    $installedRoot=RegularDirectory ([string]$b.supplierRoot)
    $oldAcceptance=RegularFile (Join-Path (Split-Path $baseline.path -Parent) 'compatibility-acceptance.json')
    if ((HashFile $oldAcceptance) -cne $b.acceptanceSha256) {
        throw 'Previous supplier release acceptance changed'
    }
    $dependencyPins=[ordered]@{}
    foreach ($name in $b.supplierFiles.Keys) {
        if ($files.Contains($name)) {
            if ($files[$name] -cne $b.supplierFiles[$name]) {
                throw 'Same-version official archive SHA differs from installed manifest'
            }
        } else {
            if ($name -cnotmatch '^node_modules/[^/].+' -or -not (SafeRelative $name)) {
                throw 'Same-version manifest-only non-dependency file refused'
            }
            $dependencyPins[$name]=$b.supplierFiles[$name]
        }
    }
    foreach ($name in $files.Keys) {
        if (-not $b.supplierFiles.Contains($name)) {
            throw 'Same-version official archive-only member refused'
        }
    }
    if ($b.supplierFiles.Count -ne $files.Count + $dependencyPins.Count) {
        throw 'Same-version installed dependency partition changed'
    }
    $observed=InstalledSupplierTree $installedRoot
    if ($observed.Count -ne $b.supplierFiles.Count) {
        throw 'Installed supplier root member count differs from manifest'
    }
    foreach ($name in $b.supplierFiles.Keys) {
        if (-not $observed.Contains($name) -or $observed[$name] -cne $b.supplierFiles[$name]) {
            throw 'Installed supplier root dependency/source SHA changed'
        }
    }
    $installedSupplierReuse=[ordered]@{
        kind='aicc-ocx-installed-supplier-dependencies-reuse/v1'
        installedSupplierRoot=$installedRoot
        runtimeRegistrySha256=$runtime.sha256
        baselineManifestSha256=$baseline.sha256
        previousAcceptanceSha256=$b.acceptanceSha256
        officialArchiveReceiptSha256=$receipt.sha256
        officialArchiveReceiptPath=$receipt.path
        officialArchivePath=$artifactPath
        officialArchiveSha512=$actual
        officialArchiveFiles=$files
        installedSupplierFiles=$b.supplierFiles
        installedDependencyFiles=$dependencyPins
        officialArchiveCount=$files.Count
        installedFileCount=$b.supplierFiles.Count
        installedDependencyCount=$dependencyPins.Count
        supplierReinstallAllowed=$false
        activationAllowed=$false
    }
    $installedSupplierReuseSha256=Sha256 ([Text.Encoding]::UTF8.GetBytes(
        ($installedSupplierReuse | ConvertTo-Json -Depth 12 -Compress)))
}
$review = @(foreach ($name in @($imports | Sort-Object)) {
    $targetHash = $files[$name]
    $previousHash = $b.supplierFiles[$name]
    [ordered]@{ path=$name; baselineSha256=$previousHash; targetSha256=$targetHash; state=if (-not $targetHash) { 'MISSING' } elseif ($targetHash -ceq $previousHash) { 'UNCHANGED' } else { 'CHANGED_REVIEW_REQUIRED' } }
})
$changed = @($files.Keys | Where-Object { $b.supplierFiles.Contains($_) -and $files[$_] -cne $b.supplierFiles[$_] }).Count
$added = @($files.Keys | Where-Object { -not $b.supplierFiles.Contains($_) }).Count
$baselineOnly = @($b.supplierFiles.Keys | Where-Object { -not $files.Contains($_) })
# Bind software evidence again; this is not an active-turn, auth or idle check.
if ((Sha256 ([IO.File]::ReadAllBytes($runtime.path))) -cne $runtime.sha256 -or
    (Sha256 ([IO.File]::ReadAllBytes($baseline.path))) -cne $baseline.sha256 -or
    (Sha256 ([IO.File]::ReadAllBytes($receipt.path))) -cne $receipt.sha256) { throw 'Preparation input changed during review' }
foreach ($name in $sourcePins.Keys) {
    if ((Sha256 ([IO.File]::ReadAllBytes((RegularFile (Join-Path $AdapterSourceRoot $name))))) -cne $sourcePins[$name]) { throw 'Adapter source changed during review' }
}
if ($reviewedReceipt -and (Sha256 ([IO.File]::ReadAllBytes((RegularFile $reviewedReceipt.path)))) -cne $reviewedReceipt.sha256) {
    throw 'Reviewed additions receipt changed during review'
}
if ($sameSupplierRevision) {
    if ((HashFile $oldAcceptance) -cne $b.acceptanceSha256) { throw 'Previous installed acceptance changed during review' }
    $archiveAtEnd=(Get-FileHash -LiteralPath (RegularFile $artifactPath) -Algorithm SHA512).Hash.ToLowerInvariant()
    if ($archiveAtEnd -cne $actual) { throw 'Official archive changed during dependency evidence review' }
}
$closure = [ordered]@{
    kind='aicc-ocx-reviewed-adapter-closure/v1'
    optIn=($null -ne $reviewedReceipt)
    receiptSha256=if ($reviewedReceipt) { $reviewedReceipt.sha256 } else { $null }
    baselineManifestSha256=$baseline.sha256
    runtimeRegistrySha256=$runtime.sha256
    targetSupplierVersion=$TargetVersion
    sameSupplierAdapterRevision=$sameSupplierRevision
    adapterFiles=$sourcePins
    reviewedAdditions=$reviewedPins
    relativeImports=$relativeImports
}
$closureSha256 = Sha256 ([Text.Encoding]::UTF8.GetBytes(($closure | ConvertTo-Json -Depth 12 -Compress)))
[ordered]@{
    schema='aicc-ocx-compatibility-plan/v1'; status='PREPARED_CONTRACT_REVIEW_REQUIRED'
    baseline=@{ supplierVersion=$registered.version; registrySha256=$runtime.sha256; manifestSha256=$baseline.sha256; installedFilesRehashed=$sameSupplierRevision; adapterFiles=$b.adapterFiles }
    target=@{ supplierVersion=$TargetVersion; receiptSha256=$receipt.sha256; archiveSha512=$actual; registryRevalidated=$false; supplierFiles=$files }
    adapterSourceSha256=$sourcePins; reviewedAdapterClosure=$closure; reviewedAdapterClosureSha256=$closureSha256; supplierImportReview=$review
    installedSupplierReuse=$installedSupplierReuse; installedSupplierReuseSha256=$installedSupplierReuseSha256
    inventoryDelta=@{ scope=if($sameSupplierRevision){'official-archive-versus-installed-manifest-plus-pinned-dependencies'}else{'baseline-manifest-tree-versus-target-archive'}; isUpstreamChangelog=$false; changedCommon=$changed; targetOnly=$added; baselineOnly=$baselineOnly.Count; baselineOnlyDependencyFiles=@($baselineOnly | Where-Object { $_ -like 'node_modules/*' }).Count; missingImports=@($review | Where-Object state -EQ 'MISSING').Count }
    compatibility=@{ verification='NOT_RUN'; accepted=$false; importsPresentDoNotProveExports=$true; releaseBuilderSupportedVersion=if($sameSupplierRevision){'2.96.0-source-only'}else{'2.81.0'}; transitionSupportedVersion=if($sameSupplierRevision){'2.96.0-requires-independent-install-gates'}else{'2.81.0'} }
    nextSteps=@('Review changed/missing supplier imports and exports against the pinned adapter sources.', 'Run isolated fixture-only contracts with separate fake credentials/state; do not execute the archive against an owner home.', 'Introduce version-bound builder/acceptance/rollback support in a separately reviewed change; do not relabel 2.81 receipts.', 'Central coordinates the later runtime owner handoff, current affected activity and proportional recovery before any service transition.')
    canActivate=$false; runtimeActivated=$false; dependenciesInstalled=$false; archiveExtracted=$false; servicesRestarted=$false; accountStateChanged=$false
} | ConvertTo-Json -Depth 12
