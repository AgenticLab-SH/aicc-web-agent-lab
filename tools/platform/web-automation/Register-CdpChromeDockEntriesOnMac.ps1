#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$ApplicationsRoot = "$HOME/Applications",
    [string[]]$OnlyPorts = @('9224', '9225'),
    [switch]$RefreshExisting,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
if (-not $IsMacOS) { throw 'This Dock registrar is only for macOS.' }

$catalog = @{
    '9224' = [ordered]@{
        name = 'CDP Chrome 9224'
        bundle = 'com.aicc.chrome.cdp.9224'
        path = (Join-Path $ApplicationsRoot 'CDP Chrome 9224.app')
    }
    '9225' = [ordered]@{
        name = 'CDP Chrome 9225'
        bundle = 'com.aicc.chrome.cdp.9225'
        path = (Join-Path $ApplicationsRoot 'CDP Chrome 9225.app')
    }
}

$requested = @($OnlyPorts | ForEach-Object {
    foreach ($part in ([string]$_ -split ',')) {
        if ($part.Trim()) { $part.Trim() }
    }
} | Sort-Object -Unique)
if ($requested.Count -eq 0 -or @($requested | Where-Object { -not $catalog.ContainsKey($_) }).Count -gt 0) {
    throw 'Only registered ports 9224 and 9225 may be appended by this helper.'
}
$items = @($requested | ForEach-Object { $catalog[$_] })
foreach ($item in $items) {
    $item.path = [IO.Path]::GetFullPath($item.path)
    if (-not (Test-Path -LiteralPath $item.path -PathType Container)) {
        throw "Dock application missing: $($item.path)"
    }
    $plist = Join-Path $item.path 'Contents/Info.plist'
    $actualBundle = [string](& /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' $plist 2>$null)
    if ($actualBundle -ne $item.bundle) {
        throw "Dock bundle mismatch for $($item.name): expected=$($item.bundle); actual=$actualBundle"
    }
}

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupRoot = Join-Path $HOME ".ai-control-center/backups/browser-launchers/${timestamp}_append-cdp-dock"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backup = Join-Path $backupRoot 'com.apple.dock.before.plist'
& /usr/bin/defaults export com.apple.dock $backup
if ($LASTEXITCODE -ne 0) { throw 'Failed to back up Dock preferences.' }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("aicc-dock-{0}.plist" -f [Guid]::NewGuid().ToString('N'))
Copy-Item -LiteralPath $backup -Destination $temporary
$added = @()
$alreadyPresent = @()
$refreshed = @()
try {
    $entries = @()
    for ($index = 0; $index -lt 500; $index++) {
        $bundle = [string](& /usr/libexec/PlistBuddy -c "Print :persistent-apps:${index}:tile-data:bundle-identifier" $temporary 2>$null)
        if ($LASTEXITCODE -ne 0) { break }
        $url = [string](& /usr/libexec/PlistBuddy -c "Print :persistent-apps:${index}:tile-data:file-data:_CFURLString" $temporary 2>$null)
        $entries += [pscustomobject]@{ index = $index; bundle = $bundle; url = $url }
    }

    foreach ($item in $items) {
        $expectedUrl = [Uri]::new([string]$item.path).AbsoluteUri.TrimEnd('/') + '/'
        $matches = @($entries | Where-Object { $_.bundle -eq $item.bundle })
        if ($matches.Count -gt 0) {
            if (@($matches | Where-Object { $_.url.TrimEnd('/') + '/' -eq $expectedUrl }).Count -eq 0) {
                throw "Dock already contains bundle $($item.bundle) at a different path; refusing to replace it."
            }
            if ($matches.Count -gt 1) {
                throw "Dock contains more than one entry for bundle $($item.bundle); refusing to refresh an ambiguous tile."
            }
            if ($RefreshExisting) {
                $matchIndex = $matches[0].index
                # Recreate only the exact stale tile at the same index. Dock's
                # bookmark can retain an old bundle icon after an in-place app
                # replacement; a same-position rebuild forces a fresh resolve
                # while preserving every other Dock item and its order.
                & /usr/libexec/PlistBuddy -c "Delete :persistent-apps:${matchIndex}" $temporary
                & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${matchIndex} dict" $temporary
                & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${matchIndex}:tile-type string file-tile" $temporary
                & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${matchIndex}:tile-data dict" $temporary
                & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${matchIndex}:tile-data:bundle-identifier string $($item.bundle)" $temporary
                & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${matchIndex}:tile-data:dock-extra bool false" $temporary
                & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${matchIndex}:tile-data:file-data dict" $temporary
                & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${matchIndex}:tile-data:file-data:_CFURLString string $expectedUrl" $temporary
                & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${matchIndex}:tile-data:file-data:_CFURLStringType integer 15" $temporary
                & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${matchIndex}:tile-data:file-label string $($item.name)" $temporary
                & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${matchIndex}:tile-data:file-type integer 41" $temporary
                if ($LASTEXITCODE -ne 0) { throw "Failed to refresh Dock entry metadata: $($item.name)" }
                $refreshed += $item.name
            }
            $alreadyPresent += $item.name
            continue
        }

        $index = $entries.Count + $added.Count
        & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${index} dict" $temporary
        & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${index}:tile-type string file-tile" $temporary
        & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${index}:tile-data dict" $temporary
        & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${index}:tile-data:bundle-identifier string $($item.bundle)" $temporary
        & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${index}:tile-data:dock-extra bool false" $temporary
        & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${index}:tile-data:file-data dict" $temporary
        & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${index}:tile-data:file-data:_CFURLString string $expectedUrl" $temporary
        & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${index}:tile-data:file-data:_CFURLStringType integer 15" $temporary
        & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${index}:tile-data:file-label string $($item.name)" $temporary
        & /usr/libexec/PlistBuddy -c "Add :persistent-apps:${index}:tile-data:file-type integer 41" $temporary
        if ($LASTEXITCODE -ne 0) { throw "Failed to append Dock entry: $($item.name)" }
        $added += $item.name
    }

    if ($added.Count -gt 0 -or $refreshed.Count -gt 0) {
        & /usr/bin/plutil -lint $temporary | Out-Null
        & /usr/bin/defaults import com.apple.dock $temporary
        if ($LASTEXITCODE -ne 0) { throw 'Failed to import the append-only Dock update.' }
        & /usr/bin/killall Dock 2>$null
    }
} finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}

$result = [ordered]@{
    ok = $true
    added = $added
    refreshed = $refreshed
    already_present = $alreadyPresent
    preserved_other_entries = $true
    backup = $backup
}
if ($AsJson) { $result | ConvertTo-Json -Compress -Depth 4 } else { $result | ConvertTo-Json -Depth 4 }
