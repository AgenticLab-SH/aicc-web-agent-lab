# Validate bounded Codex-default, Claude-opt-in guidance deployment policy.

[CmdletBinding()]
param(
    [Alias('Hub')][string]$AiccRoot = '',
    [switch]$FullIntegration,
    [switch]$AsJson,
    [switch]$SummaryOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $AiccRoot) { $AiccRoot = Join-Path $PSScriptRoot '../../..' }
$AiccRoot = (Resolve-Path -LiteralPath $AiccRoot).Path
$modulePath = Join-Path $AiccRoot 'tools/platform/core/AgentHomeDeployment.psm1'
Import-Module $modulePath -Force

$checks = @()
function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $script:checks += [pscustomobject]@{ name=$Name; ok=$Ok; detail=$Detail }
}

function Get-FixtureSkillInventory {
    param([Parameter(Mandatory)][string]$Root)
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Where-Object {
        $relative = [System.IO.Path]::GetRelativePath($Root, $_.FullName) -replace '\\', '/'
        $relative -notmatch '(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(/|$)' -and
        $relative -notmatch '(?i)\.(pyc|pyo)$' -and
        $relative -notmatch '(^|/)\.DS_Store$'
    } | ForEach-Object {
        [ordered]@{
            path = ([System.IO.Path]::GetRelativePath($Root, $_.FullName) -replace '\\', '/')
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            bytes = $_.Length
        }
    } | Sort-Object { [string]$_.path })
}

function Copy-FixtureSkill {
    param([string]$AiccRoot, [string]$UserHome, [string]$Group, [string]$Name)
    $source = Join-Path $AiccRoot "guidance/skills/$Name"
    $destination = Join-Path $UserHome "$(if($Group -eq 'codex'){'.agents'}else{".$Group"})/skills/$Name"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    # Sealed runtime packages are intentionally read-only. Test fixtures must be
    # mutable copies so the negative modification case tests deployment policy,
    # not inherited archive mode bits.
    Get-ChildItem -LiteralPath $destination -Recurse -File -Force | ForEach-Object {
        $_.IsReadOnly = $false
    }
    return $destination
}

function Write-FixtureManifest {
    param([string]$AiccRoot, [string]$UserHome, [string]$Group, [string[]]$SkillNames)
    $skillRoot = Join-Path $UserHome "$(if($Group -eq 'codex'){'.agents'}else{".$Group"})/skills"
    New-Item -ItemType Directory -Force -Path $skillRoot | Out-Null
    $entries = @($SkillNames | ForEach-Object {
        $name = $_
        $source = Join-Path $AiccRoot "guidance/skills/$name"
        $target = Join-Path $skillRoot $name
        [ordered]@{
            name = $name
            source = $source
            source_skill_sha256 = (Get-FileHash -LiteralPath (Join-Path $source 'SKILL.md') -Algorithm SHA256).Hash
            files = @(Get-FixtureSkillInventory -Root $target)
        }
    })
    $manifest = [ordered]@{
        schema_version = 1
        target_group = $Group
        aicc_root = $AiccRoot
        generated_at = (Get-Date).ToString('o')
        deployment_mode = 'full'
        requested_skills = @()
        managed_skills = $entries
    } | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText(
        (Join-Path $skillRoot '.aicc-guidance-deployment.json'),
        ($manifest + "`n"),
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Invoke-FixtureSkillDeployment {
    param(
        [string]$AiccRoot,
        [string]$UserHome,
        [string[]]$TargetGroups = @(),
        [switch]$PruneOptionalTargets,
        [switch]$Plan
    )
    $arguments = @(
        '-NoProfile', '-File', (Join-Path $AiccRoot 'tools/platform/core/deploy_active_skills.ps1'),
        '-AiccRoot', $AiccRoot, '-UserHome', $UserHome, '-PruneManaged', '-AsJson'
    )
    if ($TargetGroups.Count -gt 0) { $arguments += @('-TargetGroups', $TargetGroups) }
    if ($PruneOptionalTargets) { $arguments += '-PruneOptionalTargets' }
    if ($Plan) { $arguments += '-Plan' }
    $raw = @(& pwsh @arguments) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Fixture skill deployment failed for $UserHome" }
    return ($raw | ConvertFrom-Json)
}

$policy = Get-AgentHomeDeploymentPolicy -AiccRoot $AiccRoot
$defaults = @(Select-AgentHomeDeploymentTargets -Policy $policy)
$all = @(Select-AgentHomeDeploymentTargets -Policy $policy -AllTargets)
Add-Check 'default group is exactly Codex' (
    @($defaults.id).Count -eq 1 -and 'codex' -in $defaults.id
) ($defaults.id -join ', ')
Add-Check 'catalog exposes only Codex and Claude deployment groups' (
    $all.Count -eq 2 -and 'codex' -in $all.id -and 'claude' -in $all.id
) ($all.id -join ', ')
Add-Check 'default target exposes one skill root' (@($defaults.skills).Count -eq 1) ([string]@($defaults.skills).Count)
$defaultTarget = @($defaults)[0]
Add-Check 'Codex uses the documented user skill root' ([string]$defaultTarget.skills[0] -match '[\\/]\.agents[\\/]skills$') ([string]$defaultTarget.skills[0])
Add-Check 'Codex declares one ownership-safe legacy skill root' (
    @($defaultTarget.legacy_skills).Count -eq 1 -and [string]$defaultTarget.legacy_skills[0] -match '[\\/]\.codex[\\/]skills$'
) ([string]@($defaultTarget.legacy_skills))
Add-Check 'default target exposes one directive file' (@($defaults.rules).Count -eq 1) ([string]@($defaults.rules).Count)
Add-Check 'Claude deployment is explicit' ($policy.optional_mode -eq 'explicit' -and -not @($all | Where-Object id -eq 'claude')[0].default) $policy.optional_mode
$claudeTarget = @($all | Where-Object id -eq 'claude')[0]
Add-Check 'Claude target exposes one CLAUDE.md entrypoint' (
    @($claudeTarget.rules).Count -eq 1 -and
    [string]$claudeTarget.rules[0] -match '[\\/]\.claude[\\/]CLAUDE\.md$'
) ([string]$claudeTarget.rules[0])
$aggregateGuidancePath = Join-Path $AiccRoot 'tools/platform/test/Test-AiccGuidance.ps1'
$aggregateGuidance = Get-Content -LiteralPath $aggregateGuidancePath -Raw -Encoding UTF8
Add-Check 'aggregate guidance preserves opt-in targets and lossless target binding' (
    $aggregateGuidance -match '\$effectiveTargetGroups\s*=\s*@\(\$policy\.default_groups\)' -and
    $aggregateGuidance -notmatch '\$(autoIncludedOptional|hasManifest)' -and
    $aggregateGuidance -match 'foreach\s*\(\$targetRun\s+in\s+\$targetRuns\)' -and
    $aggregateGuidance -match "@\('-TargetGroups',\s*\[string\]\`$targetRun\)"
) $aggregateGuidancePath
$availableSkillNames = @(Get-ChildItem -LiteralPath (Join-Path $AiccRoot 'guidance/skills') -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') -PathType Leaf } |
    Select-Object -ExpandProperty Name)
foreach ($target in $all) {
    $delivery = Get-AgentHomeTargetSkillDelivery -Target $target -AvailableSkillNames $availableSkillNames
    Add-Check "$($target.id) uses an explicit active-skill allowlist" (
        $delivery.classification -eq 'explicit-active' -and @($target.active_skills).Count -gt 0
    ) ("classification={0}; active={1}" -f $delivery.classification, (@($target.active_skills) -join ','))
    Add-Check "$($target.id) deploys high-risk-change implicitly" (
        'high-risk-change' -in @($delivery.desired_skills) -and
        'high-risk-change' -notin @($delivery.excluded_skills)
    ) ("desired={0}; excluded={1}" -f ($delivery.desired_skills -join ','), ($delivery.excluded_skills -join ','))
    $unclassified = Get-AgentHomeTargetSkillDelivery -Target $target -AvailableSkillNames @($availableSkillNames + 'fixture-new-skill')
    Add-Check "$($target.id) keeps a new unclassified skill cold" (
        'fixture-new-skill' -notin @($unclassified.desired_skills) -and
        'fixture-new-skill' -in @($unclassified.excluded_skills)
    ) ("desired={0}" -f ($unclassified.desired_skills -join ','))
}
$highRiskMetadataPath = Join-Path $AiccRoot 'guidance/skills/high-risk-change/agents/openai.yaml'
$highRiskMetadata = Get-Content -LiteralPath $highRiskMetadataPath -Raw -Encoding UTF8
Add-Check 'high-risk-change allows implicit invocation' (
    $highRiskMetadata -notmatch '(?m)^\s*allow_implicit_invocation:\s*false\s*$'
) $highRiskMetadataPath
foreach ($skillName in @('distill-conversation-archives', 'generate-images-with-web-gpt')) {
    $metadataPath = Join-Path $AiccRoot "guidance/skills/$skillName/agents/openai.yaml"
    $metadata = if (Test-Path -LiteralPath $metadataPath -PathType Leaf) {
        Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8
    } else { '' }
    Add-Check "$skillName is explicit-only" (
        $metadata -match '(?m)^\s*allow_implicit_invocation:\s*false\s*$'
    ) $metadataPath
}
Add-Check 'all target rule/generated pairs align' (@($all | Where-Object { $_.rules.Count -ne $_.generated.Count }).Count -eq 0)

$userHome = $policy.user_home
foreach ($target in $all) {
    foreach ($path in @($target.skills + $target.legacy_skills + $target.rules)) {
        Add-Check "$($target.id) home target is bounded: $path" (Test-AgentHomeDeploymentDescendant -Root $userHome -Path $path)
    }
    foreach ($path in $target.generated) {
        Add-Check "$($target.id) generated target is bounded: $path" (Test-AgentHomeDeploymentDescendant -Root $AiccRoot -Path $path)
    }
}

$unknownRejected = $false
try { Select-AgentHomeDeploymentTargets -Policy $policy -TargetGroups @('unknown-agent') | Out-Null } catch { $unknownRejected = $true }
Add-Check 'unknown target group is rejected' $unknownRejected

$fixtureRoot = $null
if ($FullIntegration) {
    $fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("aicc-guidance-policy-{0}" -f [guid]::NewGuid().ToString('N'))
    $orchestratorSkill = 'web-gpt-orchestrator'
    $ordinarySkill = 'use-web-gpt'
    try {
    $planHome = Join-Path $fixtureRoot 'plan-home'
    New-Item -ItemType Directory -Force -Path (Join-Path $planHome '.codex'), (Join-Path $planHome '.claude') | Out-Null
    $skillPlan = Invoke-FixtureSkillDeployment -AiccRoot $AiccRoot -UserHome $planHome -Plan
    $codexPlan = @($skillPlan.targets | Where-Object group -eq 'codex')[0]
    $claudeSkillPlan = Invoke-FixtureSkillDeployment -AiccRoot $AiccRoot -UserHome $planHome -TargetGroups @('claude') -Plan
    $claudePlan = @($claudeSkillPlan.targets | Where-Object group -eq 'claude')[0]
    Add-Check 'skill deploy dry-run selects only defaults' (
        @($skillPlan.selected_groups).Count -eq 1 -and 'codex' -in $skillPlan.selected_groups
    ) ($skillPlan.selected_groups -join ', ')
    Add-Check 'Claude skill deploy requires explicit selection' (
        @($claudeSkillPlan.selected_groups).Count -eq 1 -and 'claude' -in $claudeSkillPlan.selected_groups
    ) ($claudeSkillPlan.selected_groups -join ', ')
    Add-Check 'skill deploy dry-run performs no writes' ([bool]$skillPlan.dry_run) ([string]$skillPlan.status)
    Add-Check 'Codex standalone delivery excludes the plugin-delivered orchestrator' (
        $orchestratorSkill -in $codexPlan.excluded_skills -and
        $orchestratorSkill -notin $codexPlan.desired_skills -and
        $orchestratorSkill -notin $codexPlan.planned_deploy_skills
    ) ("desired={0}; excluded={1}" -f @($codexPlan.desired_skills).Count, ($codexPlan.excluded_skills -join ','))
    Add-Check 'Claude standalone delivery also keeps the orchestrator cold' (
        $orchestratorSkill -in $claudePlan.excluded_skills -and
        $orchestratorSkill -notin $claudePlan.desired_skills -and
        $orchestratorSkill -notin $claudePlan.planned_deploy_skills
    ) ($claudePlan.excluded_skills -join ', ')
    Add-Check 'plan visibly reports the target policy exclusion without duplicate action rows' (
        $orchestratorSkill -in $codexPlan.policy_skipped_skills -and
        @($codexPlan.actions | Where-Object { $_.skill -eq $orchestratorSkill }).Count -eq 0
    ) ($codexPlan.policy_skipped_skills -join ', ')

    $ownedHome = Join-Path $fixtureRoot 'owned-home'
    New-Item -ItemType Directory -Force -Path (Join-Path $ownedHome '.codex'), (Join-Path $ownedHome '.claude') | Out-Null
    Copy-FixtureSkill -AiccRoot $AiccRoot -UserHome $ownedHome -Group 'codex' -Name $orchestratorSkill | Out-Null
    Copy-FixtureSkill -AiccRoot $AiccRoot -UserHome $ownedHome -Group 'codex' -Name $ordinarySkill | Out-Null
    Write-FixtureManifest -AiccRoot $AiccRoot -UserHome $ownedHome -Group 'codex' -SkillNames @($orchestratorSkill, $ordinarySkill)
    $ownedPlan = Invoke-FixtureSkillDeployment -AiccRoot $AiccRoot -UserHome $ownedHome -Plan
    $ownedCodexPlan = @($ownedPlan.targets | Where-Object group -eq 'codex')[0]
    Add-Check 'plan reports a manifest-owned matching exclusion as prunable' (
        $orchestratorSkill -in $ownedCodexPlan.planned_prune_skills -and
        @($ownedCodexPlan.actions | Where-Object { $_.skill -eq $orchestratorSkill -and $_.action -eq 'prune' -and $_.reason -eq 'manifest-owned-match' }).Count -eq 1
    ) ($ownedCodexPlan.planned_prune_skills -join ', ')

    $ownedDeploy = Invoke-FixtureSkillDeployment -AiccRoot $AiccRoot -UserHome $ownedHome
    $ownedCodexDeploy = @($ownedDeploy.targets | Where-Object group -eq 'codex')[0]
    Add-Check 'deploy prunes only the matching manifest-owned Codex standalone copy' (
        $orchestratorSkill -in $ownedCodexDeploy.pruned_skills -and
        -not (Test-Path -LiteralPath (Join-Path $ownedHome ".agents/skills/$orchestratorSkill"))
    ) ($ownedCodexDeploy.pruned_skills -join ', ')
    Add-Check 'deploy excludes the cold orchestrator from Codex' (
        $orchestratorSkill -notin $ownedCodexDeploy.deployed_skills
    ) ("codex={0}" -f ($ownedCodexDeploy.deployed_skills -join ','))
    Add-Check 'prune preserves unrelated managed skills' (
        Test-Path -LiteralPath (Join-Path $ownedHome ".agents/skills/$ordinarySkill/SKILL.md") -PathType Leaf
    ) $ordinarySkill

    $ownedManifestPath = Join-Path $ownedHome '.agents/skills/.aicc-guidance-deployment.json'
    $ordinarySkillPath = Join-Path $ownedHome ".agents/skills/$ordinarySkill/SKILL.md"
    $manifestBeforeNoOp = [System.IO.File]::ReadAllBytes($ownedManifestPath)
    $ordinaryHashBeforeNoOp = (Get-FileHash -LiteralPath $ordinarySkillPath -Algorithm SHA256).Hash
    $ownedNoOp = Invoke-FixtureSkillDeployment -AiccRoot $AiccRoot -UserHome $ownedHome
    $ownedNoOpTarget = @($ownedNoOp.targets | Where-Object group -eq 'codex')[0]
    Add-Check 'exact source and target trees skip copying' (
        @($ownedNoOp.planned_deploy_skills).Count -eq 0 -and
        @($ownedNoOp.deployed_skills).Count -eq 0 -and
        $ordinarySkill -in @($ownedNoOp.unchanged_skills) -and
        @($ownedNoOpTarget.actions | Where-Object { $_.skill -eq $ordinarySkill -and $_.action -eq 'unchanged' }).Count -eq 1 -and
        (Get-FileHash -LiteralPath $ordinarySkillPath -Algorithm SHA256).Hash -eq $ordinaryHashBeforeNoOp
    ) (($ownedNoOpTarget.actions | ConvertTo-Json -Compress -Depth 5) -join '')
    Add-Check 'exact deployment preserves manifest bytes' (
        -not [bool]$ownedNoOp.manifest_update_planned -and
        [int]$ownedNoOp.manifest_update_count -eq 0 -and
        @($ownedNoOp.manifests_written).Count -eq 0 -and
        [Convert]::ToBase64String($manifestBeforeNoOp) -ceq
            [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($ownedManifestPath))
    ) ("planned={0}; written={1}" -f $ownedNoOp.manifest_update_planned, @($ownedNoOp.manifests_written).Count)

    $userOwnedSkill = 'user-owned-fixture'
    $userOwnedSkillPath = Join-Path $ownedHome ".agents/skills/$userOwnedSkill"
    New-Item -ItemType Directory -Force -Path $userOwnedSkillPath | Out-Null
    Set-Content -LiteralPath (Join-Path $userOwnedSkillPath 'SKILL.md') -Encoding UTF8 -Value @"
---
name: $userOwnedSkill
description: User-managed fixture outside the AICC catalog.
---

# User-owned fixture
"@

    $inspectRaw = @(& pwsh -NoProfile -File (Join-Path $AiccRoot 'tools/platform/inspect/Inspect-AgentSkills.ps1') -AiccRoot $AiccRoot -UserHome $ownedHome -AsJson) -join "`n"
    $inspectExit = $LASTEXITCODE
    $inspect = $inspectRaw | ConvertFrom-Json
    $inspectCodex = @($inspect.targets | Where-Object group -eq 'codex')[0]
    $expectedExcludedCount = @($codexPlan.excluded_skills).Count
    Add-Check 'check accepts the intentional cold Codex catalog' (
        $inspectExit -eq 0 -and [bool]$inspect.ok -and [int]$inspect.excluded_skill_count -eq $expectedExcludedCount -and
        $orchestratorSkill -in $inspectCodex.excluded_skills -and $orchestratorSkill -notin $inspectCodex.desired_skills
    ) ("exit={0}; excluded={1}; failures={2}" -f $inspectExit, $inspect.excluded_skill_count, $inspect.failed_count)
    Add-Check 'check reports a user-managed extra without failing AICC delivery' (
        $inspectExit -eq 0 -and [bool]$inspect.ok -and [int]$inspect.unmanaged_extra_count -eq 1 -and
        $userOwnedSkill -in @($inspectCodex.unmanaged_extra)
    ) ("exit={0}; unmanaged={1}; failures={2}" -f $inspectExit, $inspect.unmanaged_extra_count, $inspect.failed_count)

    Remove-Item -LiteralPath (Join-Path $ownedHome ".agents/skills/$ordinarySkill") -Recurse -Force
    $missingRaw = @(& pwsh -NoProfile -File (Join-Path $AiccRoot 'tools/platform/inspect/Inspect-AgentSkills.ps1') -AiccRoot $AiccRoot -UserHome $ownedHome -SummaryOnly -AsJson) -join "`n"
    $missingExit = $LASTEXITCODE
    $missingCheck = $missingRaw | ConvertFrom-Json
    Add-Check 'check still fails on a missing non-excluded Codex skill' (
        $missingExit -ne 0 -and -not [bool]$missingCheck.ok -and [int]$missingCheck.deployment_issue_count -gt 0
    ) ("exit={0}; deployment_issues={1}" -f $missingExit, $missingCheck.deployment_issue_count)

    $modifiedHome = Join-Path $fixtureRoot 'modified-home'
    New-Item -ItemType Directory -Force -Path (Join-Path $modifiedHome '.codex'), (Join-Path $modifiedHome '.claude') | Out-Null
    $modifiedSkillPath = Copy-FixtureSkill -AiccRoot $AiccRoot -UserHome $modifiedHome -Group 'codex' -Name $orchestratorSkill
    Copy-FixtureSkill -AiccRoot $AiccRoot -UserHome $modifiedHome -Group 'codex' -Name $ordinarySkill | Out-Null
    Write-FixtureManifest -AiccRoot $AiccRoot -UserHome $modifiedHome -Group 'codex' -SkillNames @($orchestratorSkill, $ordinarySkill)
    Add-Content -LiteralPath (Join-Path $modifiedSkillPath 'SKILL.md') -Value "`nfixture modification" -Encoding UTF8
    $modifiedDeploy = Invoke-FixtureSkillDeployment -AiccRoot $AiccRoot -UserHome $modifiedHome
    $modifiedRefusal = @($modifiedDeploy.refused | Where-Object { $_.group -eq 'codex' -and $_.skill -eq $orchestratorSkill -and $_.action -eq 'prune' })
    Add-Check 'modified manifest-owned excluded content is refused and preserved' (
        $modifiedRefusal.Count -eq 1 -and
        $modifiedRefusal[0].reason -eq 'manifest-content-mismatch' -and
        (Test-Path -LiteralPath (Join-Path $modifiedSkillPath 'SKILL.md') -PathType Leaf)
    ) (($modifiedRefusal | ConvertTo-Json -Compress) -join '')
    Add-Check 'modified refusal does not remove unrelated skills' (
        Test-Path -LiteralPath (Join-Path $modifiedHome ".agents/skills/$ordinarySkill/SKILL.md") -PathType Leaf
    ) $ordinarySkill

    $unownedHome = Join-Path $fixtureRoot 'unowned-home'
    New-Item -ItemType Directory -Force -Path (Join-Path $unownedHome '.codex'), (Join-Path $unownedHome '.claude') | Out-Null
    $unownedSkillPath = Copy-FixtureSkill -AiccRoot $AiccRoot -UserHome $unownedHome -Group 'codex' -Name $orchestratorSkill
    $unownedDeploy = Invoke-FixtureSkillDeployment -AiccRoot $AiccRoot -UserHome $unownedHome
    $unownedRefusal = @($unownedDeploy.refused | Where-Object { $_.group -eq 'codex' -and $_.skill -eq $orchestratorSkill -and $_.action -eq 'prune' })
    Add-Check 'unowned excluded content is refused and preserved' (
        $unownedRefusal.Count -eq 1 -and
        $unownedRefusal[0].reason -eq 'unowned' -and
        (Test-Path -LiteralPath (Join-Path $unownedSkillPath 'SKILL.md') -PathType Leaf)
    ) (($unownedRefusal | ConvertTo-Json -Compress) -join '')
    Add-Check 'unowned refusal does not prevent unrelated desired deployment' (
        Test-Path -LiteralPath (Join-Path $unownedHome ".agents/skills/$ordinarySkill/SKILL.md") -PathType Leaf
    ) $ordinarySkill
    } finally {
        if (Test-Path -LiteralPath $fixtureRoot -PathType Container) {
            Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
        }
    }
}

$skillDeployerText = Get-Content -LiteralPath (Join-Path $AiccRoot 'tools/platform/core/deploy_active_skills.ps1') -Raw -Encoding UTF8
Add-Check 'skill deployment excludes runtime caches from copies and manifests' (
    $skillDeployerText -match 'Test-SkillDeploymentFileExcluded' -and
    $skillDeployerText -match '__pycache__' -and
    $skillDeployerText -match '\\.\(pyc\|pyo\)' -and
    $skillDeployerText -match '\\.DS_Store'
) 'cache filters are applied by copy and inventory paths'

$skillInspectorText = Get-Content -LiteralPath (Join-Path $AiccRoot 'tools/platform/inspect/Inspect-AgentSkills.ps1') -Raw -Encoding UTF8
Add-Check 'skill inspection compares full trees and manifest file inventories' (
    $skillInspectorText -match 'Compare-SkillTrees' -and
    $skillInspectorText -match 'Get-SkillTreeInventory' -and
    $skillInspectorText -match 'manifest file inventory mismatch'
) 'source, deployed target, and manifest files are path/hash/size checked'

$mixedManifestEntries = @(
    [pscustomobject]@{ name = 'preserved-skill' },
    [ordered]@{ name = 'updated-skill' },
    [pscustomobject]@{ name = 'preserved-skill' }
)
$mixedManifestNames = @($mixedManifestEntries | Sort-Object { [string]$_.name } -Unique | ForEach-Object { [string]$_.name })
Add-Check 'partial skill manifest sort preserves mixed object entries' (
    $mixedManifestNames.Count -eq 2 -and
    'preserved-skill' -in $mixedManifestNames -and
    'updated-skill' -in $mixedManifestNames
) ($mixedManifestNames -join ', ')

$directivePlanRaw = @(& pwsh -NoProfile -File (Join-Path $AiccRoot 'tools/platform/core/deploy_directives.ps1') -AiccRoot $AiccRoot -Plan -AsJson) -join "`n"
$directivePlan = $directivePlanRaw | ConvertFrom-Json
Add-Check 'directive deploy dry-run selects only defaults' (
    @($directivePlan.selected_groups).Count -eq 1 -and 'codex' -in $directivePlan.selected_groups
) ($directivePlan.selected_groups -join ', ')
Add-Check 'directive deploy dry-run performs no writes' ([bool]$directivePlan.dry_run) ([string]$directivePlan.status)
$claudeDirectivePlanRaw = @(& pwsh -NoProfile -File (Join-Path $AiccRoot 'tools/platform/core/deploy_directives.ps1') -AiccRoot $AiccRoot -TargetGroups @('claude') -Plan -SummaryOnly -AsJson) -join "`n"
$claudeDirectivePlan = $claudeDirectivePlanRaw | ConvertFrom-Json
Add-Check 'explicit Claude directive plan writes one file' (
    @($claudeDirectivePlan.selected_groups).Count -eq 1 -and
    'claude' -in $claudeDirectivePlan.selected_groups -and
    [int]$claudeDirectivePlan.write_count -eq 1
) ($claudeDirectivePlanRaw)

$commonDirectiveText = Get-Content -LiteralPath (Join-Path $AiccRoot 'guidance/directives/fragments/common.md') -Raw -Encoding UTF8
$placementRulesText = Get-Content -LiteralPath (Join-Path $AiccRoot 'guidance/skills/aicc-guidance-review/references/placement-rules.md') -Raw -Encoding UTF8
Add-Check 'cold workflow lookup stays outside always-loaded guidance' (
    $commonDirectiveText -notmatch 'aicc guidance find' -and
    $placementRulesText -match 'aicc guidance find' -and
    $placementRulesText -match '등록하지 않는다'
) 'cold workflow lookup lives in the review policy only'
Add-Check 'placement policy avoids mid-task global capability restarts' (
    $placementRulesText -match '별도 프로세스' -and
    $placementRulesText -match '현재 대화를 멈춰' -and
    $placementRulesText -match '재시작'
) 'use active bounded tools or an isolated process/new task first'

$failed = @($checks | Where-Object { -not $_.ok })
$result = [ordered]@{
    ok = ($failed.Count -eq 0)
    mode = if ($FullIntegration) { 'full-integration' } else { 'fast-drift' }
    default_groups = @($defaults.id)
    all_groups = @($all.id)
    check_count = $checks.Count
    failed_count = $failed.Count
    checks = @($checks)
}
if ($SummaryOnly) {
    $result = [ordered]@{
        ok = ($failed.Count -eq 0)
        mode = if ($FullIntegration) { 'full-integration' } else { 'fast-drift' }
        default_groups = @($defaults.id)
        all_groups = @($all.id)
        check_count = $checks.Count
        failed_count = $failed.Count
        failed_checks = @($failed | Select-Object -First 20)
    }
}
if ($AsJson) { $result | ConvertTo-Json -Compress -Depth 7 } else { $result | ConvertTo-Json -Depth 7 }
if (-not $result.ok) { exit 1 }
