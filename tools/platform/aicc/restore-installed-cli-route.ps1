param(
  [Parameter(Mandatory = $true)]
  [string]$BackupTarget,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-fA-F0-9]{64}$')]
  [string]$ExpectedManifestSha256
)

$ErrorActionPreference = 'Stop'

function Resolve-AbsolutePath([string]$Value, [string]$Label) {
  if (-not [IO.Path]::IsPathFullyQualified($Value)) { throw "$Label must be absolute" }
  return [IO.Path]::GetFullPath($Value)
}

function Resolve-LinkTarget([System.IO.FileSystemInfo]$Item) {
  $raw = @($Item.Target)[0]
  if (-not $raw) { throw 'route entry has no link target' }
  if ([IO.Path]::IsPathFullyQualified($raw)) { return [IO.Path]::GetFullPath($raw) }
  return [IO.Path]::GetFullPath((Join-Path $Item.DirectoryName $raw))
}

$backup = (Resolve-Path -LiteralPath $BackupTarget).Path
$manifestPath = Join-Path $backup 'manifest.json'
$actualManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
if ($actualManifestHash -ne $ExpectedManifestSha256.ToLowerInvariant()) { throw 'backup manifest hash mismatch' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.component -ne 'installed-cli-route') { throw 'backup manifest identity mismatch' }

$entry = Resolve-AbsolutePath ([string]$manifest.entryPath) 'entryPath'
$source = Resolve-AbsolutePath ([string]$manifest.sourceTarget) 'sourceTarget'
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'source target is unavailable' }
$entryParent = [IO.Path]::GetDirectoryName($entry)
if (-not (Test-Path -LiteralPath $entryParent -PathType Container)) { throw 'entry parent is unavailable' }

$current = Get-Item -LiteralPath $entry -Force
if ($current.LinkType -notin @('Junction', 'SymbolicLink')) { throw 'installed entry is not a link' }
$currentTarget = Resolve-LinkTarget $current
if ([StringComparer]::OrdinalIgnoreCase.Equals($currentTarget, $source)) {
  [pscustomobject]@{ terminal = 'ROLLED_BACK'; reason = 'already_at_source'; entry = $entry; source = $source } | ConvertTo-Json -Compress
  exit 0
}

$token = [Guid]::NewGuid().ToString('N')
$temporary = Join-Path $entryParent ".aicc-route-rollback-$token"
$displaced = Join-Path $backup "recovery-displaced-$token"
if (Test-Path -LiteralPath $temporary) { throw 'temporary path collision' }
if (Test-Path -LiteralPath $displaced) { throw 'displaced path collision' }

$moved = $false
try {
  New-Item -ItemType Junction -Path $temporary -Target $source | Out-Null
  Move-Item -LiteralPath $entry -Destination $displaced
  $moved = $true
  try {
    Move-Item -LiteralPath $temporary -Destination $entry
  } catch {
    Move-Item -LiteralPath $displaced -Destination $entry
    $moved = $false
    throw
  }
  $verified = Get-Item -LiteralPath $entry -Force
  if ($verified.LinkType -notin @('Junction', 'SymbolicLink')) { throw 'restored entry is not a link' }
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals((Resolve-LinkTarget $verified), $source)) { throw 'restored target mismatch' }
  [pscustomobject]@{ terminal = 'ROLLED_BACK'; reason = 'source_target_restored'; entry = $entry; source = $source; displaced = $displaced } | ConvertTo-Json -Compress
} catch {
  if ($moved -and -not (Test-Path -LiteralPath $entry) -and (Test-Path -LiteralPath $displaced)) {
    Move-Item -LiteralPath $displaced -Destination $entry
  }
  throw
} finally {
  if (Test-Path -LiteralPath $temporary) {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporary)
    if ([IO.Path]::GetDirectoryName($resolvedTemporary) -ne $entryParent) { throw 'unsafe temporary cleanup target' }
    Remove-Item -LiteralPath $resolvedTemporary -Force
  }
}
