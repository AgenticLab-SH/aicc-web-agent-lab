#requires -Version 5.1
<#
Prepare an existing owner-bound manager request using workspace-local files only.
This helper performs no browser, network, backup upload, or remote mutation.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [ValidateSet('Inventory', 'Prepare')][string]$Action = 'Inventory',
    [string]$InputPath = '',
    [string]$CandidateId = '',
    [string]$CatalogPath = 'web-asset-requests/catalog.json'
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$hashPattern = '^[a-f0-9]{64}$'
$readActions = @('project-inspect','project-status','project-source-read','instructions-inspect','personal-skill-list','personal-skill-inspect','personal-skill-plan-add-file','personal-skill-plan-file')
$actions = $readActions + @('project-create','project-update','project-upload','project-source-delete','project-delete','plugin-delete','instructions-update','personal-skill-upload','personal-skill-update','personal-skill-update-body','personal-skill-add-file','personal-skill-delete')

function Hash-Bytes([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function Convert-Map($Value) {
    if ($Value -is [Management.Automation.PSCustomObject]) {
        $map = [ordered]@{}
        foreach ($p in $Value.PSObject.Properties) { $map[$p.Name] = Convert-Map $p.Value }
        return $map
    }
    if ($Value -is [Array]) { return ,@(foreach ($v in $Value) { Convert-Map $v }) }
    return $Value
}
function Read-Json([string]$File) {
    $item = Get-Item -LiteralPath $File
    if ($item.Length -gt 4MB) { throw 'HOLD_JSON_TOO_LARGE' }
    return Convert-Map ($utf8.GetString([IO.File]::ReadAllBytes($File)).TrimStart([char]0xFEFF) | ConvertFrom-Json)
}
function Assert-NoLink([string]$File) {
    $cursor = $File
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'HOLD_LINKED_PATH' }
        }
        if ($cursor -eq $script:root) { break }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Workspace-File([string]$Value, [switch]$MayCreate) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'HOLD_FILE_REQUIRED' }
    $file = if ([IO.Path]::IsPathRooted($Value)) { [IO.Path]::GetFullPath($Value) } else { [IO.Path]::GetFullPath((Join-Path $script:root $Value)) }
    if (-not $file.StartsWith($script:rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'HOLD_FILE_OUTSIDE_MANAGEMENT_WORKSPACE' }
    $relative = $file.Substring($script:rootPrefix.Length)
    foreach ($part in ($relative -split '[\\/]')) {
        if (-not $part -or $part.StartsWith('.') -or $part -match '[<>:"|?*\x00-\x1f]|[. ]$' -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([.]|$)') { throw 'HOLD_NON_REGULAR_WORKSPACE_PATH' }
    }
    Assert-NoLink $file
    if (-not $MayCreate -and -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'HOLD_WORKSPACE_FILE_MISSING' }
    return $file
}
function File-Digest([string]$File, [long]$Maximum) {
    if ((Get-Item -LiteralPath $File).Length -gt $Maximum) { throw 'HOLD_FILE_TOO_LARGE' }
    return Hash-Bytes ([IO.File]::ReadAllBytes($File))
}
function Pin-File($Object, [string]$Key, [long]$Maximum) {
    if (-not $Object.Contains($Key)) { return }
    $file = Workspace-File ([string]$Object[$Key])
    $digest = File-Digest $file $Maximum
    $hashKey = $Key + 'SHA256'
    if ($Object.Contains($hashKey) -and $Object[$hashKey] -cne $digest) { throw "HOLD_FILE_HASH_CHANGED: $Key" }
    $Object[$Key] = $file
    $Object[$hashKey] = $digest
}
function Write-Once([string]$File, [byte[]]$Bytes) {
    if (Test-Path -LiteralPath $File) {
        if ((Hash-Bytes ([IO.File]::ReadAllBytes($File))) -cne (Hash-Bytes $Bytes)) { throw 'HOLD_EXISTING_ARTIFACT_DIFFERS' }
        return
    }
    $stream = [IO.File]::Open($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
}
function Assert-Receipt($Request, [string]$Account) {
    $receiptPath = Workspace-File ([string]$Request.backupReceipt)
    # The original receipt path is the mutation journal's identity. Never relocate it.
    foreach ($suffix in @('.operation.json','.operation.lock')) {
        if (Test-Path -LiteralPath ($receiptPath + $suffix)) { throw 'HOLD_PRIOR_ATTEMPT_RECONCILE_SAME_RECEIPT' }
    }
    $receipt = Read-Json $receiptPath
    if ($receipt.schemaVersion -ne 1 -or $receipt.githubStatus -cne 'VERIFIED' -or $receipt.notionStatus -cne 'VERIFIED' -or -not $receipt.githubBlobSHA -or -not $receipt.notionPageId -or (-not $receipt.notionFileUploadId -and $receipt.notionFormat -cne 'INLINE_JSON')) { throw 'HOLD_BACKUP_INCOMPLETE' }
    $bundlePath = Workspace-File ([string]$receipt.bundlePath)
    if ((File-Digest $bundlePath 4MB) -cne $receipt.bundleSHA256) { throw 'HOLD_BACKUP_BUNDLE_CHANGED' }
    if ($receipt.notionFormat -ceq 'INLINE_JSON') {
        $null = Workspace-File ([string]$receipt.notionRecoveryProofPath)
        $null = Workspace-File ([string]$receipt.notionPageReadPath)
    }
    $bundle = Read-Json $bundlePath
    $empty = Hash-Bytes ([byte[]]@())
    $preimage = $Request.preimageSHA256
    $required = @()
    $recovery = $false
    switch ($Request.action) {
        'project-create' {
            $asset = 'project|' + $Account + '|' + $Request.name; $operation = 'create'; $preimage = $empty
            $spec = [ordered]@{name=$Request.name;memory=$Request.memory;instructions=$Request.instructions;sources=@($Request.sources)}
            $desired = Hash-Bytes ($utf8.GetBytes((ConvertTo-Json -InputObject $spec -Depth 30 -Compress)))
        }
        'project-update' {
            $asset = 'project|' + $Account + '|' + $Request.remoteId; $operation = 'update'
            if (-not $Request.desired.Contains('name') -or -not $Request.desired.Contains('instructions')) { throw 'HOLD_EXPLICIT_PROJECT_DESIRED_FIELDS_REQUIRED' }
            $spec = [ordered]@{name=$Request.desired.name;instructions=$Request.desired.instructions}
            $desired = Hash-Bytes ($utf8.GetBytes((ConvertTo-Json -InputObject $spec -Depth 30 -Compress)))
        }
        'project-upload' {
            $asset = 'project|' + $Account + '|' + $Request.remoteId; $operation = 'source-update'
            $spec = @(foreach ($s in $Request.sources) { [ordered]@{filename=$s.filename;sha256=$s.sha256;sizeBytes=$s.sizeBytes} })
            $required = @($Request.sources | ForEach-Object { $_.sha256 })
            $desired = Hash-Bytes ($utf8.GetBytes((ConvertTo-Json -InputObject $spec -Depth 30 -Compress)))
        }
        'project-source-delete' {
            $asset = 'project|' + $Account + '|' + $Request.remoteId + '|source|' + $Request.source.filename
            $operation = 'delete'; $desired = $empty; $recovery = $true; $required = @($Request.source.sha256)
        }
        'project-delete' { $asset = 'project|' + $Account + '|' + $Request.remoteId; $operation = 'delete'; $desired = $empty; $recovery = $true }
        'plugin-delete' { $asset = 'plugin|' + $Request.remoteId; $operation = 'delete'; $desired = $empty; $recovery = $true; $required = @($Request.preimageSHA256) }
        'instructions-update' {
            $asset = 'instructions|' + $Account + '|personalization'; $operation = 'instructions-update'
            $desired = Hash-Bytes ($utf8.GetBytes((ConvertTo-Json -InputObject @($Request.desiredFields) -Depth 30 -Compress)))
        }
        default {
            $s = $Request.skill; $command = $Request.action.Substring('personal-skill-'.Length)
            if ($command -ceq 'plan-file') { $command = 'update-body' }
            if ($command -ceq 'plan-add-file') { $command = 'add-file' }
            $target = if ($command -ceq 'upload') { $s.name } else { $s.skillId }
            $asset = 'skill|' + $Account + '|' + $target; $operation = $command; $preimage = $s.expectedCurrentSha
            switch ($command) {
                'upload' { $operation = 'create'; $preimage = $empty; $desired = $s.fileSHA256; $required = @($desired) }
                'update' { $desired = $s.descriptionFileSHA256; $required = @($desired) }
                'update-body' {
                    $body = $utf8.GetString([IO.File]::ReadAllBytes($s.bodyFile)).TrimStart([char]0xFEFF).Replace("`r`n", "`n")
                    $desired = Hash-Bytes ($utf8.GetBytes($body)); $required = @($desired)
                }
                'add-file' {
                    $operation = 'create'; $preimage = $empty
                    $body = $utf8.GetString([IO.File]::ReadAllBytes($s.bodyFile)).TrimStart([char]0xFEFF).Replace("`r`n", "`n")
                    $desired = Hash-Bytes ($utf8.GetBytes($body)); $required = @($desired)
                    if (-not @($bundle.files | Where-Object { $_.path -ceq ('desired/' + $s.filePath) -and $_.sha256 -ceq $desired }).Count) { throw 'HOLD_BACKUP_PATH_BINDING' }
                }
                'delete' { $desired = $empty; $recovery = $true }
            }
        }
    }
    foreach ($pair in @(@('assetKey',$asset),@('operation',$operation),@('preimageSHA256',$preimage),@('desiredSHA256',$desired))) {
        if (-not $pair[1] -or $receipt[$pair[0]] -cne $pair[1] -or $bundle[$pair[0]] -cne $pair[1]) { throw ('HOLD_BACKUP_BINDING_MISMATCH: ' + $pair[0]) }
    }
    if ($recovery -and ($receipt.recoveryComplete -ne $true -or $bundle.recoveryComplete -ne $true)) { throw 'HOLD_FULL_RECOVERY_REQUIRED' }
    if (@($bundle.files).Count -eq 0) { throw 'HOLD_EMPTY_BACKUP' }
    $hashes = @{}
    foreach ($f in $bundle.files) {
        if ((Hash-Bytes ([Convert]::FromBase64String($f.contentBase64))) -cne $f.sha256) { throw 'HOLD_BACKUP_BYTES_CHANGED' }
        $hashes[$f.sha256] = $true
    }
    foreach ($h in $required) { if (-not $hashes.ContainsKey($h)) { throw 'HOLD_BACKUP_MISSING_DESIRED_BYTES' } }
    $Request.backupReceipt = $receiptPath
}

try {
    $script:root = (Resolve-Path -LiteralPath $WorkspaceRoot).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
    $script:rootPrefix = $script:root + [IO.Path]::DirectorySeparatorChar
    if (-not (Test-Path -LiteralPath $script:root -PathType Container) -or $script:root.Length -lt 4) { throw 'HOLD_EXACT_MANAGEMENT_WORKSPACE_REQUIRED' }
    Assert-NoLink $script:root
    $catalog = Read-Json (Workspace-File $CatalogPath)
    if ($catalog.schemaVersion -ne 1 -or $catalog.kind -cne 'aicc-web-asset-package-catalog' -or -not $catalog.execution.accountAlias) { throw 'HOLD_CATALOG_BINDING_REQUIRED' }
    if ($Action -ceq 'Inventory') {
        [ordered]@{status='LOCAL_CANDIDATES_ONLY';execution=$catalog.execution;candidates=@($catalog.candidates);remoteInspectionPerformed=$false} | ConvertTo-Json -Depth 30
        exit 0
    }
    if ($CandidateId) {
        $candidates = @($catalog.candidates | Where-Object { $_.id -ceq $CandidateId })
        if ($candidates.Count -ne 1) { throw 'HOLD_EXACT_CANDIDATE_REQUIRED' }
        $candidate = $candidates[0]
        # A candidate is not an upload instruction, even if it has a complete ZIP.
        throw ('HOLD_CANDIDATE_REQUIRES_EXPLICIT_REQUEST: ' + $candidate.status + '; inspect existing remote ID and prepare InputPath; do not infer upload')
    }
    $request = Read-Json (Workspace-File $InputPath)
    $keys = @('schemaVersion','action','remoteId','name','memory','instructions','sources','source','expectedName','expectedVersion','preimageSHA256','instructionsSHA256','sourceCount','includeActionMenu','desired','confirm','conversationCount','desiredFields','commit','backupReceipt','skill')
    if ($request -isnot [Collections.IDictionary] -or @($request.Keys | Where-Object { $_ -cnotin $keys }).Count -or $request.schemaVersion -ne 1 -or $request.action -cnotin $actions) { throw 'HOLD_UNKNOWN_REQUEST_FIELD_OR_ACTION' }
    $mutating = $request.action -cnotin $readActions
    if ($request.action.StartsWith('personal-skill-')) {
        if (-not $request.Contains('skill')) { $request.skill = [ordered]@{} }
        $s = $request.skill
        $skillKeys = @('name','displayName','skillId','expectedCurrentSha','expectedTreeSha','file','fileSHA256','bodyFile','bodyFileSHA256','descriptionFile','descriptionFileSHA256','filePath','includeBody','includeFiles','planRequestId','planSHA256')
        if ($s -isnot [Collections.IDictionary] -or @($s.Keys | Where-Object { $_ -cnotin $skillKeys }).Count) { throw 'HOLD_UNKNOWN_SKILL_FIELD' }
        if ($request.action -cne 'personal-skill-list' -and (-not $s.name -or -not $s.displayName)) { throw 'HOLD_SKILL_NAME_AND_DISPLAY_NAME_REQUIRED' }
        if ($request.action -cnotin @('personal-skill-list','personal-skill-upload','personal-skill-inspect') -and $s.skillId -cnotmatch '^[A-Za-z0-9_-]{8,200}$') { throw 'HOLD_EXACT_SKILL_ID_REQUIRED' }
        if ($s.skillId -and $s.skillId -cnotmatch '^[A-Za-z0-9_-]{8,200}$') { throw 'HOLD_INVALID_SKILL_ID' }
        if ($mutating) {
            foreach ($candidate in $catalog.candidates) {
                $same = ($s.skillId -and $candidate.remoteId -ceq $s.skillId) -or ($s.name -and $candidate.slug -ceq $s.name)
                if ($same -and $candidate.status -cmatch '^HOLD_(SECURITY|UNCERTAIN)') { throw 'HOLD_RECORDED_DENIAL_OR_UNKNOWN: reconcile original operation; do not prepare another route' }
                if ($same -and $request.action -ceq 'personal-skill-upload' -and $candidate.remoteId) { throw 'HOLD_EXISTING_SKILL_USE_EXACT_ID_UPDATE' }
            }
        }
        Pin-File $s 'file' 25MB
        Pin-File $s 'bodyFile' 100000
        Pin-File $s 'descriptionFile' 8000
        if ($request.action -cin @('personal-skill-plan-add-file','personal-skill-add-file')) {
            if ($s.name -cnotmatch '^[a-z0-9][a-z0-9-]{1,63}$' -or $s.displayName.Length -gt 150 -or $s.filePath -cnotmatch '^references/[a-z0-9][a-z0-9-]{0,62}[.]md$' -or -not $s.bodyFile -or $s.Contains('planRequestId') -or $s.Contains('planSHA256')) { throw 'HOLD_EXACT_NEW_REFERENCE_FILE_REQUIRED' }
            if ($mutating) {
                if ($s.expectedCurrentSha -cnotmatch $hashPattern -or $s.expectedTreeSha -cnotmatch $hashPattern -or $request.confirm -cne ('ADD-FILE:' + $s.skillId + ':' + $s.filePath)) { throw 'HOLD_ADD_FILE_PREIMAGE_AND_CONFIRM_REQUIRED' }
            } elseif (($request.Contains('commit') -and $request.commit -ne $false) -or $request.Contains('confirm')) { throw 'HOLD_ADD_FILE_PLAN_IS_READ_ONLY' }
        }
        if ($request.action -ceq 'personal-skill-plan-file') {
            if ($request.Contains('commit') -and $request.commit -ne $false) { throw 'HOLD_FILE_PLAN_IS_READ_ONLY' }
            if ($s.filePath -cnotmatch '^references/[A-Za-z0-9][A-Za-z0-9._/-]*[.]md$' -or $s.filePath -match '(^|/)\.\.?(/|$)' -or $s.expectedCurrentSha -cnotmatch $hashPattern -or -not $s.bodyFile) { throw 'HOLD_EXACT_EXISTING_SUPPORT_FILE_REQUIRED' }
            if ($s.planRequestId -or $s.planSHA256) { throw 'HOLD_PLAN_CANNOT_USE_PRIOR_PLAN' }
        }
        if ($request.action -ceq 'personal-skill-update-body' -and ($s.planRequestId -or $s.planSHA256)) {
            if ($s.planRequestId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$' -or $s.planSHA256 -cnotmatch $hashPattern -or -not $s.filePath -or -not $s.bodyFile) { throw 'HOLD_EXACT_FILE_PLAN_REQUIRED' }
        }
    }
    if ($request.action -ceq 'project-create' -and ($request.memory -cne 'default' -or $request.name -cnotmatch '^w-(?![wl]-)\S' -or @($request.sources).Count -ne 0)) { throw 'HOLD_CREATE_DEFAULT_MEMORY_SHELL_FIRST' }
    if ($request.action.StartsWith('project-') -and $request.action -cne 'project-create' -and $request.remoteId -cnotmatch '^g-p-[A-Za-z0-9_-]+$') { throw 'HOLD_EXACT_PROJECT_ID_REQUIRED' }
    if ($request.action -ceq 'project-source-read') {
        $source = $request.source
        if (($request.Contains('commit') -and $request.commit -ne $false) -or -not $request.expectedName -or $request.preimageSHA256 -cnotmatch $hashPattern -or $source -isnot [Collections.IDictionary] -or @($source.Keys | Where-Object { $_ -cnotin @('filename','includeBody','maxBytes','expectedSha256') }).Count -or $source.filename -cnotmatch '^[^\\/\x00-\x1f]+[.]md$' -or $source.includeBody -ne $true -or ($source.maxBytes -isnot [int] -and $source.maxBytes -isnot [long]) -or $source.maxBytes -lt 1 -or $source.maxBytes -gt 262144 -or ($source.Contains('expectedSha256') -and $source.expectedSha256 -cnotmatch $hashPattern)) { throw 'HOLD_EXACT_BOUNDED_SOURCE_READ_REQUIRED' }
    }
    if ($request.action -ceq 'plugin-delete' -and ($request.remoteId -cnotmatch '^(Plugin_|plugin_|plugins_)[A-Za-z0-9_-]{8,120}$' -or -not $request.expectedName -or -not $request.expectedVersion -or $request.preimageSHA256 -cnotmatch $hashPattern)) { throw 'HOLD_EXACT_PLUGIN_VERSION_AND_ARCHIVE_REQUIRED' }
    if ($request.Contains('sources')) {
        foreach ($source in $request.sources) {
            $source.path = Workspace-File ([string]$source.path)
            $digest = File-Digest $source.path 25MB
            if ($source.sha256 -and $source.sha256 -cne $digest) { throw 'HOLD_SOURCE_BYTES_CHANGED' }
            $source.sha256 = $digest
            $source.sizeBytes = (Get-Item -LiteralPath $source.path).Length
        }
    }
    if ($mutating) {
        if ($request.commit -ne $true) { throw 'HOLD_EXPLICIT_COMMIT_REQUIRED' }
        if ($request.action -cin @('project-delete','plugin-delete','personal-skill-delete')) {
            $id = if ($request.action -ceq 'personal-skill-delete') { $request.skill.skillId } else { $request.remoteId }
            if ($request.confirm -cne ('DELETE:' + $id)) { throw 'HOLD_EXACT_DELETE_CONFIRM_REQUIRED' }
            if ($request.action -ceq 'project-delete' -and ($request.conversationCount -ne 0 -or $request.sourceCount -ne 0)) { throw 'HOLD_ONLY_EMPTY_PROJECT_DELETE_SUPPORTED' }
        }
        Assert-Receipt $request ([string]$catalog.execution.accountAlias)
    }
    if ($request.action -cin @('personal-skill-plan-file','personal-skill-plan-add-file')) { Assert-Receipt $request ([string]$catalog.execution.accountAlias) }
    $bytes = $utf8.GetBytes((ConvertTo-Json -InputObject $request -Depth 40 -Compress))
    if ($bytes.Length -gt 1MB) { throw 'HOLD_REQUEST_TOO_LARGE' }
    $digest = Hash-Bytes $bytes
    $relative = 'web-asset-requests/requests/' + $digest + '.json'
    $output = Workspace-File $relative -MayCreate
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output))
    Write-Once $output $bytes
    # A mutation keeps the same operation ID for the same exact request bytes.
    $id = if ($mutating) { 'asset-' + $digest.Substring(0,40) } elseif ($request.action -ceq 'project-source-read') { 'read-' + $digest.Substring(0,40) } else { 'read-' + [Guid]::NewGuid().ToString('N') }
    [ordered]@{status='REQUEST_PREPARED_NOT_DISPATCHED';workspaceAlias=$catalog.execution.workspaceAlias;request_id=$id;operation_id=$id;request_path=$relative;request_sha256=$digest;action=$request.action;remoteMutationPerformed=$false;next='Call existing aicc_web_management_start once. If already started, retrieve aicc_web_management_status for this operation_id.'} | ConvertTo-Json -Depth 8
}
catch {
    [ordered]@{status='HOLD_LOCAL_PREPARATION';reason=$_.Exception.Message;remoteMutationPerformed=$false;automaticRetry=$false} | ConvertTo-Json -Depth 4
    exit 2
}
