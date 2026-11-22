#requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Key')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Key')][string]$Key,
    [Parameter(Mandatory, ParameterSetName = 'WebGptRole')]
    [ValidateSet('default', 'secondary', 'pro')][string]$WebGptRole,
    [string]$Path = (Join-Path $HOME '.ai-control-center/guidance/coordination.toml')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Private coordination file not found: $Path" }
$values = @{}
$section = ''
foreach ($raw in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    if ($line -match '^\[(?<name>[^\]]+)\]$') { $section = $Matches.name.Trim(); continue }
    if (-not $section -or $line -notmatch '^(?<key>[A-Za-z0-9_]+)\s*=\s*(?<value>.+?)\s*$') { continue }
    $qualifiedKey = "$section.$($Matches.key)"
    $value = $Matches.value
    if ($value -match '^"(?<text>(?:[^"\\]|\\.)*)"\s*(#.*)?$') {
        $values[$qualifiedKey] = $Matches.text
        continue
    }
    $comment = $value.IndexOf('#')
    if ($comment -ge 0) { $value = $value.Substring(0, $comment).Trim() }
    $values[$qualifiedKey] = $value.Trim('"').Trim("'")
}

if ($PSCmdlet.ParameterSetName -eq 'WebGptRole') {
    $prefix = "browser.web_gpt_${WebGptRole}"
    $accountKey = "${prefix}_account_alias"
    $workspaceKey = "${prefix}_workspace"
    if (-not $values.ContainsKey($accountKey) -or -not $values.ContainsKey($workspaceKey)) {
        throw "Coordination Web GPT role is incomplete: $WebGptRole"
    }

    $policy = if ($values.ContainsKey("${prefix}_policy")) { [string]$values["${prefix}_policy"] } else { $null }
    $bindingKeys = [ordered]@{
        schemaVersion = "${prefix}_schema_version"
        bindingId = "${prefix}_binding_id"
        revision = "${prefix}_revision"
        identityScheme = "${prefix}_identity_scheme"
        identityHash = "${prefix}_identity_hash"
        workspaceIdentityHash = "${prefix}_workspace_identity_hash"
        status = "${prefix}_status"
        approvalRef = "${prefix}_approval_ref"
    }
    $presentBindingKeys = @($bindingKeys.Values | Where-Object { $values.ContainsKey($_) })
    if ($presentBindingKeys.Count -eq 0) {
        [pscustomobject]@{
            role = $WebGptRole
            accountAlias = [string]$values[$accountKey]
            workspaceAlias = [string]$values[$workspaceKey]
            policy = $policy
        } | ConvertTo-Json -Compress
        return
    }

    $missingBindingKeys = @($bindingKeys.GetEnumerator() | Where-Object { -not $values.ContainsKey($_.Value) } | ForEach-Object { $_.Key })
    if ($missingBindingKeys.Count -gt 0) {
        throw "Coordination Web GPT approved binding is incomplete: $WebGptRole missing $($missingBindingKeys -join ',')"
    }
    $schemaVersion = 0
    $revision = 0
    if (-not [int]::TryParse([string]$values[$bindingKeys.schemaVersion], [ref]$schemaVersion)) {
        throw "Coordination Web GPT binding schemaVersion is not an integer: $WebGptRole"
    }
    if (-not [int]::TryParse([string]$values[$bindingKeys.revision], [ref]$revision)) {
        throw "Coordination Web GPT binding revision is not an integer: $WebGptRole"
    }
    $workspaceIdentityHash = [string]$values[$bindingKeys.workspaceIdentityHash]
    if ([string]::IsNullOrWhiteSpace($workspaceIdentityHash)) { $workspaceIdentityHash = $null }

    [pscustomobject]@{
        schemaVersion = $schemaVersion
        role = $WebGptRole
        bindingId = [string]$values[$bindingKeys.bindingId]
        revision = $revision
        accountAlias = [string]$values[$accountKey]
        workspaceAlias = [string]$values[$workspaceKey]
        identityScheme = [string]$values[$bindingKeys.identityScheme]
        identityHash = [string]$values[$bindingKeys.identityHash]
        workspaceIdentityHash = $workspaceIdentityHash
        status = [string]$values[$bindingKeys.status]
        approvalRef = [string]$values[$bindingKeys.approvalRef]
        policy = $policy
    } | ConvertTo-Json -Compress
    return
}

$parts = ($Key -replace '-', '.').Split('.', 2)
if ($parts.Count -ne 2) { throw "Key must be section.key: $Key" }
$resolvedKey = "$($parts[0]).$($parts[1])"
if ($values.ContainsKey($resolvedKey)) { $values[$resolvedKey]; return }
throw "Coordination key not found: $Key"
