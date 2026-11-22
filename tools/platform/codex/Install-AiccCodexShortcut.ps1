#requires -Version 5.1
[CmdletBinding()]
param([string]$DestinationDirectory = '')
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'Start-AiccCodexMux.ps1'
$sourceItem = Get-Item -LiteralPath $source -ErrorAction Stop
if ($sourceItem.PSIsContainer -or $sourceItem.LinkType) { throw '정본 실행 파일이 필요합니다.' }
if (-not $DestinationDirectory) {
    $aicc = Get-Command aicc -ErrorAction Stop | Select-Object -First 1
    if ($aicc.CommandType -notin @('ExternalScript','Application')) { throw '기존 aicc 설치 경로를 확인해야 합니다.' }
    $DestinationDirectory = Split-Path -Parent $aicc.Source
}
$directory = Get-Item -LiteralPath (Resolve-Path -LiteralPath $DestinationDirectory).Path -ErrorAction Stop
if (-not $directory.PSIsContainer -or $directory.LinkType) { throw '기존 실제 설치 폴더만 사용할 수 있습니다.' }
$destination = [IO.Path]::GetFullPath((Join-Path $directory.FullName 'acx.ps1'))
$bytes = [IO.File]::ReadAllBytes($sourceItem.FullName)
# CreateNew preserves any existing command. No PATH/profile/runtime modification.
$stream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
finally { $stream.Dispose() }
[pscustomobject]@{
    command='acx'; path=$destination; state='SHORTCUT_WRITTEN_NOT_EXECUTED'
    existingAiccChanged=$false; pathChanged=$false; modelRuntimeChanged=$false
    verification='NOT_RUN'
} | ConvertTo-Json -Compress