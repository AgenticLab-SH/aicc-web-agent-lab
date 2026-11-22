Set-StrictMode -Version Latest
# Windows PowerShell 5.1 does not define the automatic IsWindows variable.
if ($PSVersionTable.PSEdition -eq 'Desktop') { $script:IsWindows = $true }

function Get-AgentHomeUniqueStable {
    param([object[]]$Values)

    $seen = [System.Collections.Generic.HashSet[string]]::new(
        $(if ($IsWindows) { [StringComparer]::OrdinalIgnoreCase } else { [StringComparer]::Ordinal })
    )
    $result = @()
    foreach ($value in @($Values)) {
        $text = [string]$value
        if ($text -and $seen.Add($text)) { $result += $text }
    }
    return $result
}

function ConvertFrom-AgentHomeTomlValue {
    param([Parameter(Mandatory)][string]$ValueText)

    $value = $ValueText.Trim()
    if ($value -match '^\[(.*)\]$') {
        $items = @()
        foreach ($part in ($Matches[1] -split ',')) {
            $item = $part.Trim().Trim('"').Trim("'")
            if ($item) { $items += $item }
        }
        return ,$items
    }
    if ($value -match '^(true|false)$') { return ($value -eq 'true') }
    if ($value -match '^"(.*)"$') { return $Matches[1] }
    if ($value -match '^\d+$') { return [int]$value }
    return $value
}

function Resolve-AgentHomeDeploymentPath {
    param(
        [Parameter(Mandatory)][string]$PathText,
        [Parameter(Mandatory)][ValidateSet('home', 'aicc')][string]$RootKind,
        [Parameter(Mandatory)][string]$UserHome,
        [Parameter(Mandatory)][string]$AiccRoot
    )

    if ([System.IO.Path]::IsPathRooted($PathText)) {
        throw "Deployment paths must be relative to the user home or AICC: $PathText"
    }
    $root = if ($RootKind -eq 'home') { $UserHome } else { $AiccRoot }
    $relative = if ($IsWindows) { $PathText -replace '/', '\' } else { $PathText -replace '\\', '/' }
    return [System.IO.Path]::GetFullPath((Join-Path $root $relative))
}

function Test-AgentHomeDeploymentDescendant {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Path
    )

    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    if ($pathFull.Equals($rootFull, $comparison)) { return $true }
    $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    return $pathFull.StartsWith($prefix, $comparison)
}

function Get-AgentHomeDeploymentPolicy {
    [CmdletBinding()]
    param(
        [Alias('Hub')][Parameter(Mandatory)][string]$AiccRoot,
        [string]$CatalogPath = '',
        [string]$UserHome = ''
    )

    $aiccPath = (Resolve-Path -LiteralPath $AiccRoot).Path
    if (-not $CatalogPath) { $CatalogPath = Join-Path $aiccPath 'guidance/config/agent-catalog.toml' }
    if (-not (Test-Path -LiteralPath $CatalogPath -PathType Leaf)) { throw "Missing deployment catalog: $CatalogPath" }
    if (-not $UserHome) { $UserHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile) }
    if (-not $UserHome) { $UserHome = $HOME }
    $userHomePath = [System.IO.Path]::GetFullPath($UserHome)

    $policy = [ordered]@{}
    $targets = @()
    $currentTarget = $null
    $section = ''

    foreach ($line in Get-Content -LiteralPath $CatalogPath -Encoding UTF8) {
        $trim = $line.Trim()
        if (-not $trim -or $trim.StartsWith('#')) { continue }
        if ($trim -eq '[[deployment_targets]]') {
            if ($currentTarget) { $targets += [pscustomobject]$currentTarget }
            $currentTarget = [ordered]@{}
            $section = 'deployment_target'
            continue
        }
        if ($trim -match '^\[(.+)\]$') {
            if ($currentTarget) {
                $targets += [pscustomobject]$currentTarget
                $currentTarget = $null
            }
            $section = $Matches[1]
            continue
        }
        if ($trim -notmatch '^([A-Za-z0-9_\-]+)\s*=\s*(.+)$') { continue }
        $key = $Matches[1]
        $value = ConvertFrom-AgentHomeTomlValue -ValueText $Matches[2]
        if ($section -eq 'deployment_policy') {
            $policy[$key] = $value
        } elseif ($section -eq 'deployment_target' -and $currentTarget) {
            $currentTarget[$key] = $value
        }
    }
    if ($currentTarget) { $targets += [pscustomobject]$currentTarget }

    if ($targets.Count -eq 0) { throw "No [[deployment_targets]] entries in $CatalogPath" }
    $duplicateIds = @($targets | Group-Object id | Where-Object Count -gt 1)
    if ($duplicateIds.Count -gt 0) { throw "Duplicate deployment target ids: $($duplicateIds.Name -join ', ')" }

    $resolvedTargets = @()
    foreach ($target in $targets) {
        $id = [string]$target.id
        if (-not $id -or $id -notmatch '^[a-z0-9-]+$') { throw "Invalid deployment target id: $id" }
        $skills = @($target.skills | ForEach-Object {
            Resolve-AgentHomeDeploymentPath -PathText ([string]$_) -RootKind home -UserHome $userHomePath -AiccRoot $aiccPath
        })
        $legacySkillValue = if ($target.PSObject.Properties['legacy_skills']) { $target.legacy_skills } else { @() }
        $legacySkills = @($legacySkillValue | ForEach-Object {
            Resolve-AgentHomeDeploymentPath -PathText ([string]$_) -RootKind home -UserHome $userHomePath -AiccRoot $aiccPath
        })
        $rules = @($target.rules | ForEach-Object {
            Resolve-AgentHomeDeploymentPath -PathText ([string]$_) -RootKind home -UserHome $userHomePath -AiccRoot $aiccPath
        })
        $generated = @($target.generated | ForEach-Object {
            Resolve-AgentHomeDeploymentPath -PathText ([string]$_) -RootKind aicc -UserHome $userHomePath -AiccRoot $aiccPath
        })
        $hasActiveSkills = [bool]$target.PSObject.Properties['active_skills']
        $targetActiveValue = if ($hasActiveSkills) { $target.active_skills } else { @() }
        $activeSkills = @(Get-AgentHomeUniqueStable -Values @($targetActiveValue | ForEach-Object { [string]$_ }))
        $targetExcludedValue = if ($target.PSObject.Properties['excluded_skills']) { $target.excluded_skills } else { @() }
        $excludedSkills = @(Get-AgentHomeUniqueStable -Values @($targetExcludedValue | ForEach-Object { [string]$_ }))
        if ($hasActiveSkills -and $excludedSkills.Count -gt 0) {
            throw "Deployment target ${id} must use active_skills or excluded_skills, not both"
        }
        $invalidSkillNames = @($activeSkills + $excludedSkills | Where-Object { $_ -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' })
        if ($invalidSkillNames.Count -gt 0) {
            throw "Invalid skill names for deployment target ${id}: $($invalidSkillNames -join ', ')"
        }
        foreach ($path in @($skills + $legacySkills + $rules)) {
            if (-not (Test-AgentHomeDeploymentDescendant -Root $userHomePath -Path $path)) {
                throw "Deployment target escapes the user home: $path"
            }
        }
        foreach ($path in $generated) {
            if (-not (Test-AgentHomeDeploymentDescendant -Root $aiccPath -Path $path)) {
                throw "Generated target escapes AICC: $path"
            }
        }
        $resolvedTargets += [pscustomobject]@{
            id = $id
            default = [bool]$target.default
            # Preserve catalog order: rules[n] and generated[n] are an explicit pair.
            skills = @(Get-AgentHomeUniqueStable -Values $skills)
            legacy_skills = @(Get-AgentHomeUniqueStable -Values $legacySkills)
            active_skills = $activeSkills
            uses_explicit_active_skills = $hasActiveSkills
            excluded_skills = $excludedSkills
            rules = @(Get-AgentHomeUniqueStable -Values $rules)
            generated = @(Get-AgentHomeUniqueStable -Values $generated)
        }
    }

    $defaultGroups = @($policy.default_groups | ForEach-Object { [string]$_ } | Where-Object { $_ } | Sort-Object -Unique)
    if ($defaultGroups.Count -eq 0) {
        $defaultGroups = @($resolvedTargets | Where-Object default | Select-Object -ExpandProperty id)
    }
    $knownIds = @($resolvedTargets | Select-Object -ExpandProperty id)
    $unknownDefaults = @($defaultGroups | Where-Object { $_ -notin $knownIds })
    if ($unknownDefaults.Count -gt 0) { throw "Unknown default deployment groups: $($unknownDefaults -join ', ')" }

    return [pscustomobject]@{
        aicc_root = $aiccPath
        user_home = $userHomePath
        catalog_path = [System.IO.Path]::GetFullPath($CatalogPath)
        default_groups = $defaultGroups
        optional_mode = [string]$policy.optional_mode
        manifest_name = if ($policy.manifest_name) { [string]$policy.manifest_name } else { '.aicc-guidance-deployment.json' }
        legacy_manifest_names = @($policy.legacy_manifest_names | ForEach-Object { [string]$_ } | Where-Object { $_ })
        prune_policy = [string]$policy.prune_policy
        targets = $resolvedTargets
    }
}

function Get-AgentHomeTargetSkillDelivery {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Target,
        [Parameter(Mandatory)][string[]]$AvailableSkillNames
    )

    $available = @($AvailableSkillNames | Where-Object { $_ } | Sort-Object -Unique)
    $usesExplicitActiveSkills = $Target.PSObject.Properties['uses_explicit_active_skills'] -and $Target.uses_explicit_active_skills
    $targetActiveValue = if ($Target.PSObject.Properties['active_skills']) { $Target.active_skills } else { @() }
    $configuredActive = @($targetActiveValue | ForEach-Object { [string]$_ } | Where-Object { $_ } | Sort-Object -Unique)
    $unknownActive = @($configuredActive | Where-Object { $_ -notin $available })
    $targetExcludedValue = if ($Target.PSObject.Properties['excluded_skills']) { $Target.excluded_skills } else { @() }
    $configuredExclusions = @($targetExcludedValue | ForEach-Object { [string]$_ } | Where-Object { $_ } | Sort-Object -Unique)
    $unknownExclusions = @($configuredExclusions | Where-Object { $_ -notin $available })
    $desired = if ($usesExplicitActiveSkills) {
        @($available | Where-Object { $_ -in $configuredActive })
    } else {
        @($available | Where-Object { $_ -notin $configuredExclusions })
    }
    $excluded = @($available | Where-Object { $_ -notin $desired })
    return [pscustomobject]@{
        target_group = [string]$Target.id
        classification = if ($usesExplicitActiveSkills) { 'explicit-active' } else { 'legacy-exclusion' }
        desired_skills = $desired
        excluded_skills = $excluded
        unknown_exclusions = @($unknownActive + $unknownExclusions | Sort-Object -Unique)
    }
}

function Select-AgentHomeDeploymentTargets {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Policy,
        [string[]]$TargetGroups = @(),
        [switch]$AllTargets
    )

    if ($AllTargets -and $TargetGroups.Count -gt 0) {
        throw 'Use either -AllTargets or -TargetGroups, not both.'
    }
    $selectedIds = if ($AllTargets) {
        @($Policy.targets | Select-Object -ExpandProperty id)
    } elseif ($TargetGroups.Count -gt 0) {
        @($TargetGroups | Where-Object { $_ } | Sort-Object -Unique)
    } else {
        @($Policy.default_groups)
    }
    $knownIds = @($Policy.targets | Select-Object -ExpandProperty id)
    $unknown = @($selectedIds | Where-Object { $_ -notin $knownIds })
    if ($unknown.Count -gt 0) { throw "Unknown deployment target groups: $($unknown -join ', ')" }
    $selected = @($Policy.targets | Where-Object { $_.id -in $selectedIds })
    if ($selected.Count -eq 0) { throw 'No deployment targets were selected.' }
    return $selected
}

Export-ModuleMember -Function Get-AgentHomeDeploymentPolicy, Get-AgentHomeTargetSkillDelivery, Select-AgentHomeDeploymentTargets, Test-AgentHomeDeploymentDescendant
