# Deploy AICC-managed guidance skills to selected agent homes.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Alias('Hub')][string]$AiccRoot = (Join-Path $PSScriptRoot '../../..'),
    [string]$CatalogPath = '',
    [string]$UserHome = '',
    [string[]]$TargetGroups = @(),
    [switch]$AllTargets,
    [string[]]$SkillNames = @(),
    [string]$WebSyncManifest = $env:AICC_WEB_SKILL_SYNC_MANIFEST,
    [switch]$Plan,
    [switch]$PruneManaged,
    [switch]$PruneOptionalTargets,
    [switch]$RetireSelectedTargets,
    [switch]$SummaryOnly,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $AiccRoot -PathType Container)) {
    $candidates = @($env:AICC_ROOT, (Join-Path $PSScriptRoot '../../..')) | Where-Object { $_ }
    $AiccRoot = @($candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'guidance/skills') -PathType Container } | Select-Object -First 1)
}
if (-not $AiccRoot) { throw 'Canonical AICC root was not found.' }
$AiccRoot = (Resolve-Path -LiteralPath $AiccRoot).Path
$activeRoot = Join-Path $AiccRoot 'guidance/skills'
$modulePath = Join-Path $AiccRoot 'tools/platform/core/AgentHomeDeployment.psm1'
if (-not (Test-Path -LiteralPath $activeRoot -PathType Container)) { throw "Missing active skill root: $activeRoot" }
if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) { throw "Missing deployment module: $modulePath" }
Import-Module $modulePath -Force

if (-not $CatalogPath) { $CatalogPath = Join-Path $AiccRoot 'guidance/config/agent-catalog.toml' }
function Get-SkillSourceMap {
    param([string]$Root)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $map }
    foreach ($dir in Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue) {
        $skillMd = Join-Path $dir.FullName 'SKILL.md'
        if (Test-Path -LiteralPath $skillMd -PathType Leaf) { $map[$dir.Name] = $dir.FullName }
    }
    return $map
}

function Get-DirectoryFileInventory {
    param([Parameter(Mandatory)][string]$Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { -not (Test-SkillDeploymentFileExcluded -Root $Root -Path $_.FullName) } |
        ForEach-Object {
        $relative = [System.IO.Path]::GetRelativePath($Root, $_.FullName) -replace '\\', '/'
        [ordered]@{ path = $relative; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash; bytes = $_.Length }
    } | Sort-Object { [string]$_.path })
}

function Get-ManagedSkillSourceInventory {
    param([Parameter(Mandatory)][string]$Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { -not (Test-SkillDeploymentFileExcluded -Root $Root -Path $_.FullName) } |
        ForEach-Object {
        $relative = [System.IO.Path]::GetRelativePath($Root, $_.FullName) -replace '\\', '/'
        if ($relative -eq 'SKILL.md') {
            $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
            $text = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
                [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
            } else {
                [System.Text.Encoding]::UTF8.GetString($bytes)
            }
            $deployedBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($text)
            $hash = [System.Security.Cryptography.SHA256]::HashData($deployedBytes)
            [ordered]@{
                path = $relative
                sha256 = [Convert]::ToHexString($hash)
                bytes = $deployedBytes.Length
            }
        } else {
            [ordered]@{
                path = $relative
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
                bytes = $_.Length
            }
        }
    } | Sort-Object { [string]$_.path })
}

function Convert-InventoryToComparableRows {
    param($Inventory)
    return @($Inventory | ForEach-Object {
        "{0}`t{1}`t{2}" -f ([string]$_.path), ([string]$_.sha256).ToUpperInvariant(), [long]$_.bytes
    } | Sort-Object)
}

function Test-InventoryMatch {
    param($ReferenceInventory, $DifferenceInventory)
    $reference = @(Convert-InventoryToComparableRows -Inventory $ReferenceInventory)
    $difference = @(Convert-InventoryToComparableRows -Inventory $DifferenceInventory)
    return @(Compare-Object -ReferenceObject $reference -DifferenceObject $difference -CaseSensitive).Count -eq 0
}

function Get-ComparableManifestJson {
    param($Manifest)
    if ($null -eq $Manifest) { return '' }
    $managed = @($Manifest.managed_skills | ForEach-Object {
        [ordered]@{
            name = [string]$_.name
            source = [string]$_.source
            source_skill_sha256 = ([string]$_.source_skill_sha256).ToUpperInvariant()
            files = @($_.files | Sort-Object { [string]$_.path } | ForEach-Object {
                [ordered]@{
                    path = [string]$_.path
                    sha256 = ([string]$_.sha256).ToUpperInvariant()
                    bytes = [long]$_.bytes
                }
            })
        }
    } | Sort-Object { [string]$_.name })
    $comparable = [ordered]@{
        schema_version = [int]$Manifest.schema_version
        target_group = [string]$Manifest.target_group
        aicc_root = [string]$Manifest.aicc_root
        deployment_mode = [string]$Manifest.deployment_mode
        requested_skills = @($Manifest.requested_skills | ForEach-Object { [string]$_ })
        desired_skills = @($Manifest.desired_skills | ForEach-Object { [string]$_ })
        excluded_skills = @($Manifest.excluded_skills | ForEach-Object { [string]$_ })
        managed_skills = $managed
    }
    return ($comparable | ConvertTo-Json -Compress -Depth 8)
}

function Test-SkillDeploymentFileExcluded {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Path)
    $relative = [System.IO.Path]::GetRelativePath($Root, $Path) -replace '\\', '/'
    return (
        $relative -match '(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(/|$)' -or
        $relative -match '(?i)\.(pyc|pyo)$' -or
        $relative -match '(^|/)\.DS_Store$'
    )
}

function Read-DeploymentManifest {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { throw "Invalid deployment manifest: $Path - $($_.Exception.Message)" }
}

function Test-DeploymentManifestIdentity {
    param($Manifest, [string]$TargetGroup, [string]$ExpectedAiccRoot)
    if ($null -eq $Manifest) { return $false }
    if (-not $Manifest.PSObject.Properties['schema_version']) { return $false }
    try { $schemaVersion = [int]$Manifest.schema_version } catch { return $false }
    if ($schemaVersion -ne 1) { return $false }
    if (-not $Manifest.PSObject.Properties['target_group'] -or [string]$Manifest.target_group -ne $TargetGroup) { return $false }
    if (-not $Manifest.PSObject.Properties['aicc_root']) { return $false }
    try {
        $manifestRoot = [System.IO.Path]::GetFullPath([string]$Manifest.aicc_root)
        $expectedRoot = [System.IO.Path]::GetFullPath($ExpectedAiccRoot)
    } catch { return $false }
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    return $manifestRoot.Equals($expectedRoot, $comparison)
}

function Compare-ManifestOwnedSkillContent {
    param($Manifest, [string]$Name, [string]$TargetDir)

    if ($null -eq $Manifest) {
        return [pscustomobject]@{ owned = $false; matches = $false; reason = 'unowned' }
    }
    if (-not $Manifest.PSObject.Properties['managed_skills']) {
        return [pscustomobject]@{ owned = $false; matches = $false; reason = 'unowned' }
    }
    $entries = @($Manifest.managed_skills | Where-Object { [string]$_.name -eq $Name })
    if ($entries.Count -ne 1) {
        return [pscustomobject]@{ owned = $false; matches = $false; reason = 'unowned' }
    }
    $entry = $entries[0]
    if (-not $entry.PSObject.Properties['files']) {
        return [pscustomobject]@{ owned = $true; matches = $false; reason = 'manifest-inventory-missing' }
    }
    try {
        $manifestInventory = @($entry.files | ForEach-Object {
            if (-not $_.PSObject.Properties['path'] -or -not $_.PSObject.Properties['sha256'] -or -not $_.PSObject.Properties['bytes']) {
                throw 'incomplete manifest inventory entry'
            }
            $path = [string]$_.path
            $sha256 = ([string]$_.sha256).ToUpperInvariant()
            $bytes = [long]$_.bytes
            if (-not $path -or $sha256 -notmatch '^[A-F0-9]{64}$' -or $bytes -lt 0) { throw 'invalid manifest inventory entry' }
            "${path}`t${sha256}`t${bytes}"
        } | Sort-Object)
    } catch {
        return [pscustomobject]@{ owned = $true; matches = $false; reason = 'manifest-inventory-invalid' }
    }
    if ($manifestInventory.Count -eq 0 -or @($manifestInventory | Sort-Object -Unique).Count -ne $manifestInventory.Count) {
        return [pscustomobject]@{ owned = $true; matches = $false; reason = 'manifest-inventory-invalid' }
    }
    $targetInventory = @(Get-DirectoryFileInventory -Root $TargetDir | ForEach-Object {
        "{0}`t{1}`t{2}" -f ([string]$_.path), ([string]$_.sha256).ToUpperInvariant(), [long]$_.bytes
    } | Sort-Object)
    $difference = @(Compare-Object -ReferenceObject $manifestInventory -DifferenceObject $targetInventory -CaseSensitive)
    if ($difference.Count -gt 0) {
        return [pscustomobject]@{ owned = $true; matches = $false; reason = 'manifest-content-mismatch' }
    }
    return [pscustomobject]@{ owned = $true; matches = $true; reason = 'manifest-owned-match' }
}

function Write-Utf8NoBom {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Copy-ManagedSkill {
    param([Parameter(Mandatory)][string]$SourceDir, [Parameter(Mandatory)][string]$DestinationDir)
    if (Test-Path -LiteralPath $DestinationDir) { Remove-Item -LiteralPath $DestinationDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
    $sourceMd = Join-Path $SourceDir 'SKILL.md'
    $bytes = [System.IO.File]::ReadAllBytes($sourceMd)
    $text = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    } else {
        [System.Text.Encoding]::UTF8.GetString($bytes)
    }
    if (-not $text.StartsWith('---')) { throw "Skill markdown missing YAML frontmatter: $sourceMd" }
    Write-Utf8NoBom -Path (Join-Path $DestinationDir 'SKILL.md') -Content $text
    # Preserve upstream license, notice and provenance beside the entrypoint.
    foreach ($sourceFile in Get-ChildItem -LiteralPath $SourceDir -File -Force) {
        if ($sourceFile.Name -eq 'SKILL.md' -or (Test-SkillDeploymentFileExcluded -Root $SourceDir -Path $sourceFile.FullName)) { continue }
        Copy-Item -LiteralPath $sourceFile.FullName -Destination (Join-Path $DestinationDir $sourceFile.Name) -Force
    }
    foreach ($childName in @('agents', 'assets', 'references', 'scripts', 'batches', 'tests')) {
        $sourceChild = Join-Path $SourceDir $childName
        if (Test-Path -LiteralPath $sourceChild -PathType Container) {
            foreach ($sourceFile in Get-ChildItem -LiteralPath $sourceChild -Recurse -File -Force -ErrorAction SilentlyContinue) {
                if (Test-SkillDeploymentFileExcluded -Root $SourceDir -Path $sourceFile.FullName) { continue }
                $relative = [System.IO.Path]::GetRelativePath($SourceDir, $sourceFile.FullName)
                $destinationFile = Join-Path $DestinationDir $relative
                $destinationParent = Split-Path -Parent $destinationFile
                New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
                Copy-Item -LiteralPath $sourceFile.FullName -Destination $destinationFile -Force
            }
        }
    }
}

$policy = Get-AgentHomeDeploymentPolicy -AiccRoot $AiccRoot -CatalogPath $CatalogPath -UserHome $UserHome
$selectedGroups = @(Select-AgentHomeDeploymentTargets -Policy $policy -TargetGroups $TargetGroups -AllTargets:$AllTargets)
$selectedIds = @($selectedGroups.id)
if ($PruneOptionalTargets -and ($RetireSelectedTargets -or $AllTargets)) {
    throw '-PruneOptionalTargets cannot be combined with -RetireSelectedTargets or -AllTargets.'
}
$retirementGroups = if ($PruneOptionalTargets) {
    @($policy.targets | Where-Object { $_.id -notin $selectedIds })
} else { @() }
$processingGroups = @($selectedGroups + $retirementGroups)
$selectedSkillRoots = @($selectedGroups | ForEach-Object skills | Sort-Object -Unique)
$selectedLegacySkillRoots = @($selectedGroups | ForEach-Object legacy_skills | Sort-Object -Unique)
if ($selectedSkillRoots.Count -eq 0) { throw 'Selected deployment groups have no skill roots.' }
foreach ($root in $selectedSkillRoots) {
    if (-not (Test-AgentHomeDeploymentDescendant -Root $policy.user_home -Path $root)) { throw "Skill target escapes the user home: $root" }
    $parent = Split-Path -Parent $root
    if (-not (Test-Path -LiteralPath $parent -PathType Container) -and -not $Plan -and $PSCmdlet.ShouldProcess($parent, 'Create selected skill target parent')) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    if (Test-Path -LiteralPath $root) {
        $item = Get-Item -LiteralPath $root -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing a symlink/reparse skill target: $root" }
    } elseif (-not $RetireSelectedTargets -and -not $Plan -and $PSCmdlet.ShouldProcess($root, 'Create selected skill target')) {
        New-Item -ItemType Directory -Force -Path $root | Out-Null
    }
}

foreach ($root in $selectedLegacySkillRoots) {
    if (-not (Test-AgentHomeDeploymentDescendant -Root $policy.user_home -Path $root)) { throw "Legacy skill target escapes the user home: $root" }
    if ($root -in $selectedSkillRoots) { throw "Legacy skill target overlaps the current target: $root" }
}

$activeMap = Get-SkillSourceMap -Root $activeRoot
$allActiveNames = @($activeMap.Keys | Sort-Object)

$requestedNames = @($SkillNames | Where-Object { $_ } | Sort-Object -Unique)
$unknownRequested = @($requestedNames | Where-Object { -not $activeMap.ContainsKey($_) })
if ($unknownRequested.Count -gt 0) { throw "Unknown skill names: $($unknownRequested -join ', ')" }
$deployNames = @($allActiveNames | Where-Object { $requestedNames.Count -eq 0 -or $_ -in $requestedNames })

$actions = @()
$refused = @()
$manifestsWritten = @()
$targetResults = @()
foreach ($group in $processingGroups) {
    $retireGroup = [bool]$RetireSelectedTargets -or ($PruneOptionalTargets -and $group.id -notin $selectedIds)
    $delivery = Get-AgentHomeTargetSkillDelivery -Target $group -AvailableSkillNames $allActiveNames
    if ($delivery.unknown_exclusions.Count -gt 0) {
        throw "Unknown classified skill names for deployment target $($group.id): $($delivery.unknown_exclusions -join ', ')"
    }
    $targetDeployNames = @($deployNames | Where-Object { $_ -in $delivery.desired_skills })
    $policySkippedNames = if ($retireGroup) { @() } else { @($deployNames | Where-Object { $_ -in $delivery.excluded_skills }) }
    foreach ($root in $group.skills) {
        $rootActions = @()
        $rootRefused = @()
        $plannedDeployNames = @()
        $appliedDeployNames = @()
        $unchangedNames = @()
        $plannedPruneNames = @()
        $appliedPruneNames = @()
        $manifestUpdatePlanned = $false
        $manifestUpdated = $false
        $manifestPath = Join-Path $root $policy.manifest_name
        $manifest = Read-DeploymentManifest -Path $manifestPath
        $legacyManifestPaths = @($policy.legacy_manifest_names | ForEach-Object { Join-Path $root $_ })
        if (-not $manifest) {
            foreach ($legacyPath in $legacyManifestPaths) {
                $legacyManifest = Read-DeploymentManifest -Path $legacyPath
                if ($legacyManifest) { $manifest = $legacyManifest; break }
            }
        }
        $trustedManifest = if (Test-DeploymentManifestIdentity -Manifest $manifest -TargetGroup $group.id -ExpectedAiccRoot $AiccRoot) { $manifest } else { $null }
        $managedEntries = @()

        if ($retireGroup) {
            if (Test-Path -LiteralPath $root -PathType Container) {
                $retireNames = if ($trustedManifest -and $trustedManifest.PSObject.Properties['managed_skills']) {
                    @($trustedManifest.managed_skills | ForEach-Object { [string]$_.name } | Where-Object { $_ } | Sort-Object -Unique)
                } else { @() }
                foreach ($name in $retireNames) {
                    $destination = Join-Path $root $name
                    if (-not (Test-Path -LiteralPath $destination -PathType Container)) { continue }
                    $ownership = Compare-ManifestOwnedSkillContent -Manifest $trustedManifest -Name $name -TargetDir $destination
                    if (-not $ownership.matches) {
                        $rootRefused += [ordered]@{ group = $group.id; root = $root; skill = $name; action = 'retire'; reason = $ownership.reason }
                        continue
                    }
                    $outcome = 'planned'
                    if (-not $Plan) {
                        if ($PSCmdlet.ShouldProcess($destination, 'Retire AICC-managed skill from optional target')) {
                            Remove-Item -LiteralPath $destination -Recurse -Force
                            $outcome = 'applied'
                        } else { $outcome = 'skipped' }
                    }
                    $rootActions += [ordered]@{ group = $group.id; root = $root; skill = $name; action = 'retire'; outcome = $outcome }
                }
                if ($rootRefused.Count -eq 0 -and $trustedManifest -and (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
                    $outcome = 'planned'
                    if (-not $Plan) {
                        if ($PSCmdlet.ShouldProcess($manifestPath, 'Remove retired deployment manifest')) {
                            Remove-Item -LiteralPath $manifestPath -Force
                            $outcome = 'applied'
                        } else { $outcome = 'skipped' }
                    }
                    $rootActions += [ordered]@{ group = $group.id; root = $root; action = 'retire-manifest'; path = $manifestPath; outcome = $outcome }
                }
            }
            $actions += $rootActions
            $refused += $rootRefused
            $targetResults += [ordered]@{
                group = $group.id
                root = $root
                desired_skills = @()
                excluded_skills = @()
                policy_skipped_skills = @()
                planned_deploy_skills = @()
                deployed_skills = @()
                unchanged_skills = @()
                planned_prune_skills = @()
                pruned_skills = @()
                manifest_update_planned = $false
                manifest_updated = $false
                actions = $rootActions
                refused = $rootRefused
            }
            continue
        }

        if ($PruneManaged) {
            $manifestNames = if ($trustedManifest -and $trustedManifest.PSObject.Properties['managed_skills']) {
                @($trustedManifest.managed_skills | ForEach-Object { [string]$_.name } | Where-Object { $_ })
            } else { @() }
            $staleManaged = @($manifestNames | Where-Object { $_ -notin $delivery.desired_skills })
            $presentExcluded = @($delivery.excluded_skills | Where-Object { Test-Path -LiteralPath (Join-Path $root $_) -PathType Container })
            $rootPruneCandidates = @($staleManaged + $presentExcluded | Sort-Object -Unique)
            foreach ($name in $rootPruneCandidates) {
                $destination = Join-Path $root $name
                if (-not (Test-Path -LiteralPath $destination -PathType Container)) { continue }
                $ownership = Compare-ManifestOwnedSkillContent -Manifest $trustedManifest -Name $name -TargetDir $destination
                if (-not $ownership.matches) {
                    $rootRefused += [ordered]@{ group = $group.id; root = $root; skill = $name; action = 'prune'; reason = $ownership.reason }
                    continue
                }
                $plannedPruneNames += $name
                $outcome = 'planned'
                if (-not $Plan) {
                    if ($PSCmdlet.ShouldProcess($destination, 'Remove stale manifest-owned AICC skill')) {
                        Remove-Item -LiteralPath $destination -Recurse -Force
                        $appliedPruneNames += $name
                        $outcome = 'applied'
                    } else { $outcome = 'skipped' }
                }
                $rootActions += [ordered]@{ group = $group.id; root = $root; skill = $name; action = 'prune'; outcome = $outcome; reason = $ownership.reason }
            }
        }

        foreach ($name in $targetDeployNames) {
            $sourceDir = [string]$activeMap[$name]
            $destination = Join-Path $root $name
            $sourceInventory = @(Get-ManagedSkillSourceInventory -Root $sourceDir)
            $targetInventory = @(Get-DirectoryFileInventory -Root $destination)
            $contentMatches = Test-InventoryMatch -ReferenceInventory $sourceInventory -DifferenceInventory $targetInventory
            if ($contentMatches) {
                $unchangedNames += $name
                $rootActions += [ordered]@{
                    group = $group.id
                    root = $root
                    skill = $name
                    action = 'unchanged'
                    outcome = 'unchanged'
                    reason = 'source-target-match'
                }
            } else {
                $actionName = if (Test-Path -LiteralPath $destination) { 'update' } else { 'create' }
                $plannedDeployNames += $name
                $outcome = 'planned'
                if (-not $Plan) {
                    if ($PSCmdlet.ShouldProcess($destination, "Deploy AICC skill $name")) {
                        Copy-ManagedSkill -SourceDir $sourceDir -DestinationDir $destination
                        $appliedDeployNames += $name
                        $outcome = 'applied'
                    } else { $outcome = 'skipped' }
                }
                $rootActions += [ordered]@{ group = $group.id; root = $root; skill = $name; action = $actionName; outcome = $outcome }
            }
            $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $sourceDir 'SKILL.md')).Hash
            $files = if ($Plan -or $contentMatches) { $sourceInventory } else { Get-DirectoryFileInventory -Root $destination }
            $managedEntries += [ordered]@{ name = $name; source = $sourceDir; source_skill_sha256 = $sourceHash; files = $files }
        }

        $preserved = @()
        if ($trustedManifest -and $trustedManifest.PSObject.Properties['managed_skills']) {
            $preserved = @($trustedManifest.managed_skills | Where-Object {
                $_.name -notin $targetDeployNames -and (Test-Path -LiteralPath (Join-Path $root $_.name) -PathType Container)
            })
        }
        $manifestObject = [ordered]@{
            schema_version = 1
            target_group = $group.id
            aicc_root = $AiccRoot
            generated_at = (Get-Date).ToString('o')
            deployment_mode = if ($requestedNames.Count) { 'partial' } else { 'full' }
            requested_skills = $requestedNames
            desired_skills = @($delivery.desired_skills)
            excluded_skills = @($delivery.excluded_skills)
            managed_skills = @($preserved + $managedEntries | Sort-Object { [string]$_.name } -Unique)
        }
        $manifestUpdatePlanned = $null -eq $trustedManifest -or
            (Get-ComparableManifestJson -Manifest $trustedManifest) -cne (Get-ComparableManifestJson -Manifest $manifestObject)
        if (-not $Plan -and $manifestUpdatePlanned) {
            $manifestBody = $manifestObject | ConvertTo-Json -Depth 8
            if ($PSCmdlet.ShouldProcess($manifestPath, 'Write AICC guidance deployment manifest')) {
                Write-Utf8NoBom -Path $manifestPath -Content ($manifestBody + "`n")
                $manifestsWritten += $manifestPath
                $manifestUpdated = $true
                foreach ($legacyPath in $legacyManifestPaths) {
                    if (Test-Path -LiteralPath $legacyPath -PathType Leaf) { Remove-Item -LiteralPath $legacyPath -Force }
                }
            }
        }
        $actions += $rootActions
        $refused += $rootRefused
        $targetResults += [ordered]@{
            group = $group.id
            root = $root
            desired_skills = @($delivery.desired_skills)
            excluded_skills = @($delivery.excluded_skills)
            policy_skipped_skills = $policySkippedNames
            planned_deploy_skills = @($plannedDeployNames | Sort-Object -Unique)
            deployed_skills = @($appliedDeployNames | Sort-Object -Unique)
            unchanged_skills = @($unchangedNames | Sort-Object -Unique)
            planned_prune_skills = @($plannedPruneNames | Sort-Object -Unique)
            pruned_skills = @($appliedPruneNames | Sort-Object -Unique)
            manifest_update_planned = [bool]$manifestUpdatePlanned
            manifest_updated = [bool]$manifestUpdated
            actions = $rootActions
            refused = $rootRefused
        }
    }
}

$plannedLegacyRetireNames = @()
$appliedLegacyRetireNames = @()
foreach ($group in $selectedGroups) {
    $delivery = Get-AgentHomeTargetSkillDelivery -Target $group -AvailableSkillNames $allActiveNames
    $migrationNames = if ($requestedNames.Count) {
        @($requestedNames | Where-Object { $_ -in $delivery.desired_skills })
    } else { @($delivery.desired_skills) }
    foreach ($legacyRoot in @($group.legacy_skills)) {
        if (-not (Test-Path -LiteralPath $legacyRoot -PathType Container)) { continue }
        $manifestPath = Join-Path $legacyRoot $policy.manifest_name
        $manifest = Read-DeploymentManifest -Path $manifestPath
        $trustedManifest = if (Test-DeploymentManifestIdentity -Manifest $manifest -TargetGroup $group.id -ExpectedAiccRoot $AiccRoot) { $manifest } else { $null }
        if (-not $trustedManifest) {
            if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
                $item = [ordered]@{ group = $group.id; root = $legacyRoot; action = 'migrate-retire'; reason = 'untrusted-legacy-manifest' }
                $refused += $item
                $actions += $item
            }
            continue
        }
        $remainingEntries = @($trustedManifest.managed_skills)
        foreach ($name in $migrationNames) {
            $targetVerified = [bool]$Plan
            if (-not $Plan) {
                $targetVerified = $true
                foreach ($currentRoot in @($group.skills)) {
                    $sourceInventory = @(Get-ManagedSkillSourceInventory -Root ([string]$activeMap[$name]))
                    $targetInventory = @(Get-DirectoryFileInventory -Root (Join-Path $currentRoot $name))
                    if (-not (Test-InventoryMatch -ReferenceInventory $sourceInventory -DifferenceInventory $targetInventory)) {
                        $targetVerified = $false
                        break
                    }
                }
            }
            if (-not $targetVerified) {
                $item = [ordered]@{ group = $group.id; root = $legacyRoot; skill = $name; action = 'migrate-retire'; reason = 'new-target-not-verified' }
                $refused += $item
                $actions += $item
                continue
            }
            if (-not @($remainingEntries | Where-Object { [string]$_.name -eq $name }).Count) { continue }
            $destination = Join-Path $legacyRoot $name
            $ownership = Compare-ManifestOwnedSkillContent -Manifest $trustedManifest -Name $name -TargetDir $destination
            if (-not $ownership.matches) {
                $sourceInventory = @(Get-ManagedSkillSourceInventory -Root ([string]$activeMap[$name]))
                $legacyInventory = @(Get-DirectoryFileInventory -Root $destination)
                if (-not (Test-InventoryMatch -ReferenceInventory $sourceInventory -DifferenceInventory $legacyInventory)) {
                    $item = [ordered]@{ group = $group.id; root = $legacyRoot; skill = $name; action = 'migrate-retire'; reason = $ownership.reason }
                    $refused += $item
                    $actions += $item
                    continue
                }
                $ownership = [pscustomobject]@{ matches = $true; reason = 'canonical-content-match-after-manifest-drift' }
            }
            $plannedLegacyRetireNames += $name
            $outcome = 'planned'
            if (-not $Plan -and $PSCmdlet.ShouldProcess($destination, 'Retire verified manifest-owned skill from legacy root')) {
                Remove-Item -LiteralPath $destination -Recurse -Force
                $remainingEntries = @($remainingEntries | Where-Object { [string]$_.name -ne $name })
                $appliedLegacyRetireNames += $name
                $outcome = 'applied'
            }
            $actions += [ordered]@{ group = $group.id; root = $legacyRoot; skill = $name; action = 'migrate-retire'; outcome = $outcome; reason = $ownership.reason }
        }
        if (-not $Plan -and @($remainingEntries).Count -ne @($trustedManifest.managed_skills).Count) {
            if (@($remainingEntries).Count -eq 0) {
                if ($PSCmdlet.ShouldProcess($manifestPath, 'Remove empty legacy deployment manifest')) { Remove-Item -LiteralPath $manifestPath -Force }
            } else {
                $trustedManifest.managed_skills = @($remainingEntries)
                $trustedManifest.generated_at = (Get-Date).ToString('o')
                if ($PSCmdlet.ShouldProcess($manifestPath, 'Update legacy deployment manifest after migration')) {
                    Write-Utf8NoBom -Path $manifestPath -Content (($trustedManifest | ConvertTo-Json -Depth 8) + "`n")
                }
            }
        }
    }
}

$report = [ordered]@{
    status = if ($Plan) { 'planned' } else { 'ok' }
    dry_run = [bool]$Plan
    aicc_root = $AiccRoot
    catalog_path = $policy.catalog_path
    default_groups = $policy.default_groups
    selected_groups = @($selectedGroups.id)
    selected_skill_roots = $selectedSkillRoots
    selected_legacy_skill_roots = $selectedLegacySkillRoots
    requested_skills = $requestedNames
    planned_deploy_skills = @($targetResults.planned_deploy_skills | Sort-Object -Unique)
    deployed_skills = @($targetResults.deployed_skills | Sort-Object -Unique)
    unchanged_skills = @($targetResults.unchanged_skills | Sort-Object -Unique)
    planned_prune_skills = @($targetResults.planned_prune_skills | Sort-Object -Unique)
    pruned_skills = @($targetResults.pruned_skills | Sort-Object -Unique)
    planned_legacy_retire_skills = @($plannedLegacyRetireNames | Sort-Object -Unique)
    legacy_retired_skills = @($appliedLegacyRetireNames | Sort-Object -Unique)
    manifest_update_planned = @($targetResults | Where-Object manifest_update_planned).Count -gt 0
    manifest_update_count = @($targetResults | Where-Object manifest_updated).Count
    prune_managed = [bool]$PruneManaged
    prune_optional_targets = [bool]$PruneOptionalTargets
    optional_retired_groups = @($retirementGroups | ForEach-Object id)
    retire_selected_targets = [bool]$RetireSelectedTargets
    targets = $targetResults
    actions = $actions
    refused = $refused
    manifests_written = $manifestsWritten
}
if ($SummaryOnly) {
    $report = [ordered]@{
        status = $report.status
        dry_run = $report.dry_run
        selected_groups = $report.selected_groups
        planned_deploy_skills = $report.planned_deploy_skills
        deployed_skills = $report.deployed_skills
        unchanged_skills = $report.unchanged_skills
        planned_prune_skills = $report.planned_prune_skills
        pruned_skills = $report.pruned_skills
        planned_legacy_retire_skills = $report.planned_legacy_retire_skills
        legacy_retired_skills = $report.legacy_retired_skills
        manifest_update_planned = $report.manifest_update_planned
        manifest_update_count = $report.manifest_update_count
        prune_optional_targets = $report.prune_optional_targets
        optional_retired_groups = $report.optional_retired_groups
        retired_skill_count = @($actions | Where-Object action -eq 'retire').Count
        refused_count = $refused.Count
        manifests_written = $manifestsWritten
    }
}
# Web semantics are assessed in the private manifest; unchanged content stays off-model.
if (!$PSBoundParameters.ContainsKey('WebSyncManifest') -and !$WebSyncManifest) { $WebSyncManifest = [Environment]::GetEnvironmentVariable('AICC_WEB_SKILL_SYNC_MANIFEST', 'User') }
$report.web_sync = @{ status = 'MANIFEST_NOT_CONFIGURED'; actual_invocation = 'NOT_REQUESTED' }
if ($WebSyncManifest -and !$PruneManaged -and !$RetireSelectedTargets) {
    try {
        $syncRunner = Join-Path $activeRoot 'manage-chatgpt-skills/scripts/Sync-LocalToWeb.ps1'
        $syncArgs = @{ ManifestPath = $WebSyncManifest; Plan = [bool]$Plan }
        if ($requestedNames.Count) { $syncArgs.SkillNames = @($requestedNames) }
        $report.web_sync = ((& $syncRunner @syncArgs) -join "`n") | ConvertFrom-Json -AsHashtable
    } catch {
        $report.web_sync = @{ status = 'SYNC_INCOMPLETE'; reason = $_.Exception.Message; local_deployment_preserved = $true }
    }
}
if ($AsJson) { $report | ConvertTo-Json -Compress -Depth 9 } else { $report | ConvertTo-Json -Depth 9 }
