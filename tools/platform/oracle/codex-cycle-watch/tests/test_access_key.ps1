#requires -Version 7.0
$ErrorActionPreference='Stop'
$source = Join-Path $PSScriptRoot '..\access_key.ps1'
$testParent = Join-Path ([IO.Path]::GetTempPath()) ('aicc-key-test-'+[guid]::NewGuid().ToString('N'))
$testRoot = Join-Path $testParent 'oracle-a1-access'
$null = New-Item -ItemType Directory -Path $testParent
try {
    $dry = & $source -Action init -Target a1 -Root $testRoot -DryRun | ConvertFrom-Json
    if ($dry.mutation -or (Test-Path -LiteralPath $testRoot)) { throw 'Dry-run mutated.' }
    $created = & $source -Action init -Target a1 -Root $testRoot | ConvertFrom-Json
    if (-not $created.ok) { throw 'Init failed.' }
    $keyPath = Join-Path $testRoot 'id_rsa'
    $initialHash = (Get-FileHash -LiteralPath $keyPath).Hash
    $exactKey = (Resolve-Path -LiteralPath $keyPath).Path
    if ($exactKey -ne $keyPath -or -not $exactKey.StartsWith($testParent+[IO.Path]::DirectorySeparatorChar)) { throw 'Invalid test key target.' }
    Remove-Item -LiteralPath $exactKey
    $restored = & $source -Action restore -Target a1 -Root $testRoot | ConvertFrom-Json
    if (-not $restored.ok -or (Get-FileHash -LiteralPath $keyPath).Hash -ne $initialHash) { throw 'Recovery mismatch.' }
    $refused=$false
    try { & $source -Action restore -Target a1 -Root $testRoot | Out-Null } catch { $refused=$true }
    if (-not $refused) { throw 'Existing key overwritten.' }
    @{ok=$true;cases=4;restoredSameKey=$true} | ConvertTo-Json -Compress
} finally {
    $resolved = (Resolve-Path -LiteralPath $testParent).Path
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolved.StartsWith($tempRoot) -and (Split-Path $resolved -Leaf) -match '^aicc-key-test-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    } else { throw 'Test cleanup boundary refused.' }
}
