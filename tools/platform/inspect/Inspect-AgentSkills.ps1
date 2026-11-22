# Read-only validation of the curated active skills and their Codex/Claude copies.

[CmdletBinding()]
param(
    [Alias('Hub')][string]$AiccRoot = (Join-Path $PSScriptRoot '../../..'),
    [string]$CatalogPath = '',
    [string]$UserHome = '',
    [string[]]$TargetGroups = @(),
    [switch]$AllTargets,
    [int]$MaxSkillLines = 500,
    [int]$MaxImplicitSkillBytes = 6144,
    [int]$Top = 30,
    [switch]$SummaryOnly,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$AiccRoot = (Resolve-Path -LiteralPath $AiccRoot).Path
if (-not $CatalogPath) { $CatalogPath = Join-Path $AiccRoot 'guidance/config/agent-catalog.toml' }
$activeRoot = Join-Path $AiccRoot 'guidance/skills'
$modulePath = Join-Path $AiccRoot 'tools/platform/core/AgentHomeDeployment.psm1'
Import-Module $modulePath -Force
$policy = Get-AgentHomeDeploymentPolicy -AiccRoot $AiccRoot -CatalogPath $CatalogPath -UserHome $UserHome
$targets = @(Select-AgentHomeDeploymentTargets -Policy $policy -TargetGroups $TargetGroups -AllTargets:$AllTargets)

function Get-FrontmatterValue {
    param([string]$Raw, [string]$Key)
    if ($Raw -match ("(?m)^" + [regex]::Escape($Key) + ":\s*(.+)$")) { return $Matches[1].Trim().Trim('"').Trim("'") }
    return ''
}

function Get-FrontmatterKeys {
    param([string]$Raw)
    if ($Raw -notmatch '(?s)^---\r?\n(?<body>.*?)\r?\n---(?:\r?\n|$)') { return @() }
    return @([regex]::Matches($Matches['body'], '(?m)^([A-Za-z][A-Za-z0-9_-]*):') |
        ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
}

function Get-LocalResourceReferences {
    param([string]$Raw)
    $matches = [regex]::Matches($Raw, '(?<![A-Za-z0-9_./-])(?<path>(?:references|scripts|assets|batches)/[A-Za-z0-9_.@%+\[\]/-]+)')
    return @($matches | ForEach-Object { $_.Groups['path'].Value.TrimEnd('.', ',', ':', ';', ']') } | Sort-Object -Unique)
}

function Test-SkillInventoryFileExcluded {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Path)
    $relative = [System.IO.Path]::GetRelativePath($Root, $Path) -replace '\\', '/'
    return (
        $relative -match '(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(/|$)' -or
        $relative -match '(?i)\.(pyc|pyo)$' -or
        $relative -match '(^|/)\.DS_Store$'
    )
}

function Get-SkillTreeInventory {
    param([Parameter(Mandatory)][string]$Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { -not (Test-SkillInventoryFileExcluded -Root $Root -Path $_.FullName) } |
        ForEach-Object {
            [pscustomobject]@{
                path = ([System.IO.Path]::GetRelativePath($Root, $_.FullName) -replace '\\', '/')
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
                bytes = $_.Length
            }
        } | Sort-Object path)
}

function Compare-SkillTrees {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Target)
    $sourceMap = @{}
    $targetMap = @{}
    foreach ($item in Get-SkillTreeInventory -Root $Source) { $sourceMap[$item.path] = $item.sha256 }
    foreach ($item in Get-SkillTreeInventory -Root $Target) { $targetMap[$item.path] = $item.sha256 }
    $missing = @($sourceMap.Keys | Where-Object { -not $targetMap.ContainsKey($_) } | Sort-Object)
    $extra = @($targetMap.Keys | Where-Object { -not $sourceMap.ContainsKey($_) } | Sort-Object)
    $changed = @($sourceMap.Keys | Where-Object { $targetMap.ContainsKey($_) -and $sourceMap[$_] -ne $targetMap[$_] } | Sort-Object)
    return [pscustomobject]@{ ok=(-not $missing.Count -and -not $extra.Count -and -not $changed.Count); missing=$missing; extra=$extra; changed=$changed }
}

$skills = @(Get-ChildItem -LiteralPath $activeRoot -Directory | ForEach-Object {
    $skillDir = $_
    $skillFile = Join-Path $skillDir.FullName 'SKILL.md'
    if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) { return }
    $raw = Get-Content -LiteralPath $skillFile -Raw -Encoding UTF8
    $frontmatterKeys = @(Get-FrontmatterKeys $raw)
    $allowedFrontmatterKeys = @('name', 'description')
    $nested = @(Get-ChildItem -LiteralPath $skillDir.FullName -Recurse -File -Filter SKILL.md | Where-Object FullName -ne $skillFile)
    $resourceReferences = @(Get-LocalResourceReferences $raw)
    $missingResources = @($resourceReferences | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $skillDir.FullName $_) -PathType Leaf)
    })
    $agentMetadataPath = Join-Path $skillDir.FullName 'agents/openai.yaml'
    $agentMetadataRaw = if (Test-Path -LiteralPath $agentMetadataPath -PathType Leaf) {
        Get-Content -LiteralPath $agentMetadataPath -Raw -Encoding UTF8
    } else { '' }
    [pscustomobject]@{
        name = $skillDir.Name
        frontmatter_name = Get-FrontmatterValue $raw 'name'
        description = Get-FrontmatterValue $raw 'description'
        frontmatter_envelope_ok = [bool]($raw -match '(?s)^---\r?\n.*?\r?\n---(?:\r?\n|$)')
        unexpected_frontmatter_keys = @($frontmatterKeys | Where-Object { $_ -notin $allowedFrontmatterKeys })
        path = $skillDir.FullName
        sha256 = (Get-FileHash -LiteralPath $skillFile -Algorithm SHA256).Hash
        # Keep the size gate content-based across Git LF and Windows CRLF checkouts.
        # Otherwise the same canonical skill can pass on macOS and fail on Windows.
        byte_count = [System.Text.Encoding]::UTF8.GetByteCount(($raw -replace "`r`n", "`n"))
        line_count = @(Get-Content -LiteralPath $skillFile -Encoding UTF8).Count
        nested_skill_file_count = $nested.Count
        nested_skill_files = @($nested.FullName)
        resource_references = $resourceReferences
        missing_resources = $missingResources
        invalid_absolute_path_count = @([regex]::Matches($raw, '(?:/Users/[^\s`''"<>]+|[A-Za-z]:\\Users\\[^\s`''"<>]+)')).Count
        has_agent_metadata = [bool]$agentMetadataRaw
        implicit_invocation = -not ($agentMetadataRaw -match '(?m)^\s*allow_implicit_invocation:\s*false\s*$')
        agent_metadata_ok = (-not $agentMetadataRaw -or (
            $agentMetadataRaw -match '(?m)^\s*display_name:\s*.+$' -and
            $agentMetadataRaw -match '(?m)^\s*short_description:\s*.+$' -and
            $agentMetadataRaw -match '(?m)^\s*default_prompt:\s*.+$'
        ))
    }
} | Sort-Object name)

$expected = @($skills.name)
$deploymentIssues = @()
$manifestIssues = @()
$targetResults = @()
$intentionalExclusions = @()
$targetComparisonCount = 0
foreach ($target in $targets) {
    $delivery = Get-AgentHomeTargetSkillDelivery -Target $target -AvailableSkillNames $expected
    if ($delivery.unknown_exclusions.Count -gt 0) {
        throw "Unknown classified skill names for deployment target $($target.id): $($delivery.unknown_exclusions -join ', ')"
    }
    $targetExpected = @($delivery.desired_skills)
    $targetSkills = @($skills | Where-Object { $_.name -in $targetExpected })
    $intentionalExclusions += @($delivery.excluded_skills | ForEach-Object {
        [pscustomobject]@{ group = $target.id; skill = $_ }
    })
    foreach ($root in @($target.skills)) {
        $targetComparisonCount += $targetSkills.Count + 1
        $missing = @()
        $mismatch = @()
        $unmanagedExtra = @()
        $exists = Test-Path -LiteralPath $root -PathType Container
        if ($exists) {
            foreach ($skill in $targetSkills) {
                $copyDir = Join-Path $root $skill.name
                $copy = Join-Path $copyDir 'SKILL.md'
                if (-not (Test-Path -LiteralPath $copy -PathType Leaf)) { $missing += $skill.name; continue }
                $treeComparison = Compare-SkillTrees -Source $skill.path -Target $copyDir
                if (-not $treeComparison.ok) {
                    $mismatch += [pscustomobject]@{
                        name = $skill.name
                        missing = $treeComparison.missing
                        extra = $treeComparison.extra
                        changed = $treeComparison.changed
                    }
                }
            }
            $unmanagedExtra = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object {
                $_.Name -notin $targetExpected -and (Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') -PathType Leaf)
            } | Select-Object -ExpandProperty Name | Sort-Object)

            $manifestPath = Join-Path $root $policy.manifest_name
            if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
                $manifestIssues += [pscustomobject]@{ root=$root; issue='missing manifest' }
            } else {
                try {
                    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    $manifestNames = @($manifest.managed_skills.name | Sort-Object -Unique)
                    if (@($targetExpected | Where-Object { $_ -notin $manifestNames }).Count -or @($manifestNames | Where-Object { $_ -notin $targetExpected }).Count) {
                        $manifestIssues += [pscustomobject]@{ root=$root; issue='manifest coverage mismatch' }
                    }
                    foreach ($manifestSkill in @($manifest.managed_skills)) {
                        $targetDir = Join-Path $root ([string]$manifestSkill.name)
                        if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) { continue }
                        $targetInventory = @(Get-SkillTreeInventory -Root $targetDir)
                        $targetMap = @{}
                        foreach ($item in $targetInventory) {
                            $targetMap[$item.path] = "{0}:{1}" -f $item.sha256, $item.bytes
                        }
                        $manifestMap = @{}
                        foreach ($item in @($manifestSkill.files)) {
                            $manifestMap[[string]$item.path] = "{0}:{1}" -f ([string]$item.sha256).ToUpperInvariant(), [long]$item.bytes
                        }
                        $manifestMissing = @($targetMap.Keys | Where-Object { -not $manifestMap.ContainsKey($_) })
                        $manifestExtra = @($manifestMap.Keys | Where-Object { -not $targetMap.ContainsKey($_) })
                        $manifestChanged = @($targetMap.Keys | Where-Object { $manifestMap.ContainsKey($_) -and $targetMap[$_] -ne $manifestMap[$_] })
                        if ($manifestMissing.Count -or $manifestExtra.Count -or $manifestChanged.Count) {
                            $manifestIssues += [pscustomobject]@{
                                root = $root
                                issue = 'manifest file inventory mismatch'
                                skill = [string]$manifestSkill.name
                                missing = @($manifestMissing | Sort-Object)
                                extra = @($manifestExtra | Sort-Object)
                                changed = @($manifestChanged | Sort-Object)
                            }
                        }
                    }
                } catch {
                    $manifestIssues += [pscustomobject]@{ root=$root; issue='invalid manifest' }
                }
            }
        }
        $row = [pscustomobject]@{
            group = $target.id
            root = $root
            exists = $exists
            desired_skills = $targetExpected
            excluded_skills = @($delivery.excluded_skills)
            missing = $missing
            mismatch = $mismatch
            unmanaged_extra = $unmanagedExtra
        }
        $targetResults += $row
        if (-not $exists -or $missing.Count -or $mismatch.Count) { $deploymentIssues += $row }
    }
}

$oversized = @($skills | Where-Object { $_.line_count -gt $MaxSkillLines })
$activeSkillNames = @($targetResults.desired_skills | Sort-Object -Unique)
$implicitOversized = @($skills | Where-Object {
    $_.name -in $activeSkillNames -and
    $_.implicit_invocation -and
    $_.byte_count -gt $MaxImplicitSkillBytes
})
$nested = @($skills | Where-Object { $_.nested_skill_file_count -gt 0 })
$frontmatterIssues = @($skills | Where-Object {
    -not $_.frontmatter_envelope_ok -or
    $_.unexpected_frontmatter_keys.Count -gt 0 -or
    $_.frontmatter_name -ne $_.name -or
    [string]::IsNullOrWhiteSpace($_.description) -or
    $_.description.Length -gt 1024 -or
    $_.description -match '[<>]'
})
$duplicateNames = @($skills | Group-Object frontmatter_name | Where-Object Count -gt 1)
$invalidNames = @($skills | Where-Object { $_.name -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' -or $_.name.Length -gt 64 })
$missingResources = @($skills | Where-Object { $_.missing_resources.Count -gt 0 })
$invalidAbsolutePaths = @($skills | Where-Object { $_.invalid_absolute_path_count -gt 0 })
$agentMetadataIssues = @($skills | Where-Object { -not $_.agent_metadata_ok })
$nativeFirstRedundancy = @($skills | Where-Object { $_.name -in @('coding-expert') })
$retiredSkillNames = @(
    'artifact-studio',
    'presentation-router',
    'route-whale-chrome-work',
    'route-browser-work',
    'web-ai-orchestrator',
    'run-web-gpt-jobs',
    'separate-browser-apps'
)
$retiredReferences = @()
foreach ($skill in $skills) {
    $skillRaw = Get-Content -LiteralPath (Join-Path $skill.path 'SKILL.md') -Raw -Encoding UTF8
    foreach ($retiredName in $retiredSkillNames) {
        if ($skillRaw -match ('(?<![A-Za-z0-9-])' + [regex]::Escape($retiredName) + '(?![A-Za-z0-9-])')) {
            $retiredReferences += [pscustomobject]@{ name=$skill.name; retired_name=$retiredName; path=$skill.path }
        }
    }
}
$failedCount = $deploymentIssues.Count + $manifestIssues.Count + $oversized.Count + $implicitOversized.Count + $nested.Count + $frontmatterIssues.Count + $duplicateNames.Count + $invalidNames.Count + $missingResources.Count + $invalidAbsolutePaths.Count + $agentMetadataIssues.Count + $nativeFirstRedundancy.Count + $retiredReferences.Count
$unmanagedExtraCount = @($targetResults | ForEach-Object { @($_.unmanaged_extra) }).Count

$result = [ordered]@{
    ok = ($failedCount -eq 0)
    generated_at = (Get-Date).ToString('s')
    policy = 'active-only; target-specific standalone delivery; deployment trees and manifests'
    active_root = $activeRoot
    default_target_groups = @($policy.default_groups)
    selected_target_groups = @($targets.id)
    central_skill_count = $skills.Count
    excluded_skill_count = $intentionalExclusions.Count
    target_count = $targetResults.Count
    check_count = $targetComparisonCount
    failed_count = $failedCount
    deployment_issue_count = $deploymentIssues.Count
    unmanaged_extra_count = $unmanagedExtraCount
    manifest_issue_count = $manifestIssues.Count
    optional_target_count = 0
    optional_managed_copy_count = 0
    oversized_count = $oversized.Count
    implicit_oversized_count = $implicitOversized.Count
    nested_skill_issue_count = $nested.Count
    duplicate_frontmatter_name_count = $duplicateNames.Count
    frontmatter_value_issue_count = $frontmatterIssues.Count
    invalid_skill_name_count = $invalidNames.Count
    missing_resource_count = $missingResources.Count
    invalid_absolute_path_count = $invalidAbsolutePaths.Count
    agent_metadata_issue_count = $agentMetadataIssues.Count
    native_first_redundancy_count = $nativeFirstRedundancy.Count
    retired_reference_count = $retiredReferences.Count
    deployment_issues = @($deploymentIssues | Select-Object -First $Top)
    manifest_issues = @($manifestIssues | Select-Object -First $Top)
    oversized = @($oversized | Select-Object -First $Top name,line_count,path)
    implicit_oversized = @($implicitOversized | Select-Object -First $Top name,byte_count,path)
    nested_skill_files = @($nested | Select-Object -First $Top name,nested_skill_files,path)
    frontmatter_value_issues = @($frontmatterIssues | Select-Object -First $Top name,frontmatter_name,description,path)
    invalid_skill_names = @($invalidNames | Select-Object -First $Top name,path)
    missing_resources = @($missingResources | Select-Object -First $Top name,missing_resources,path)
    invalid_absolute_paths = @($invalidAbsolutePaths | Select-Object -First $Top name,path)
    agent_metadata_issues = @($agentMetadataIssues | Select-Object -First $Top name,path)
    native_first_redundancies = @($nativeFirstRedundancy | Select-Object -First $Top name,path)
    retired_references = @($retiredReferences | Select-Object -First $Top)
    intentional_exclusions = $intentionalExclusions
    targets = $targetResults
    skills = @($skills | Select-Object name,frontmatter_name,description,byte_count,line_count,implicit_invocation,path)
}
if ($SummaryOnly) {
    $result.Remove('targets')
    $result.Remove('skills')
    $result.Remove('intentional_exclusions')
}
if ($AsJson) { $result | ConvertTo-Json -Compress -Depth 7 } else { $result | ConvertTo-Json -Depth 7 }
if (-not $result.ok) { exit 1 }
