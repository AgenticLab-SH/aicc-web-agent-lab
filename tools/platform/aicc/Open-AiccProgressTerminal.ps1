[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('[가-힣]')][ValidateLength(2, 80)][string]$Title,
    [Parameter(Mandatory = $true)][ValidatePattern('[가-힣]')][ValidateLength(2, 160)][string]$Purpose,
    [Parameter(Mandatory = $true)][string]$Progress,
    [Parameter(Mandatory = $true)][string]$Result,
    [Parameter(Mandatory = $true)][string]$Processes,
    [string]$NodePath = '',
    [ValidateRange(0, 30)][int]$CloseDelaySeconds = 3,
    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Resolve-AbsolutePath([string]$Value, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [System.IO.Path]::IsPathFullyQualified($Value)) {
        throw "$Name 경로는 절대 경로여야 합니다."
    }
    return [System.IO.Path]::GetFullPath($Value)
}

foreach ($text in @($Title, $Purpose)) {
    if ($text -match '[\x00-\x1f\x7f]') { throw '제목과 용도에는 제어 문자를 넣을 수 없습니다.' }
}

$progressPath = Resolve-AbsolutePath $Progress '진행 상태'
$resultPath = Resolve-AbsolutePath $Result '결과'
$processesPath = Resolve-AbsolutePath $Processes '프로세스'
$rendererPath = Join-Path $PSScriptRoot 'render-terminal-progress.mjs'
$presenterPath = Join-Path $PSScriptRoot 'Show-AiccProgressTerminal.ps1'

if (-not (Test-Path -LiteralPath $rendererPath -PathType Leaf)) { throw "진행 표시기를 찾지 못했습니다: $rendererPath" }
if (-not (Test-Path -LiteralPath $presenterPath -PathType Leaf)) { throw "터미널 표시 스크립트를 찾지 못했습니다: $presenterPath" }

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }
    $NodePath = $nodeCommand.Source
}
$nodeResolved = Resolve-AbsolutePath $NodePath 'Node 실행 파일'
if (-not (Test-Path -LiteralPath $nodeResolved -PathType Leaf)) { throw "Node 실행 파일을 찾지 못했습니다: $nodeResolved" }

$pwshCommand = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if ($null -eq $pwshCommand) { $pwshCommand = Get-Command pwsh -ErrorAction Stop }
$pwshPath = $pwshCommand.Source

$arguments = @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $presenterPath,
    '-Title', $Title, '-Purpose', $Purpose,
    '-Progress', $progressPath, '-Result', $resultPath, '-Processes', $processesPath,
    '-NodePath', $nodeResolved, '-RendererPath', $rendererPath,
    '-CloseDelaySeconds', [string]$CloseDelaySeconds
)

$summary = [ordered]@{
    ok = $true
    mode = 'foreground-visible'
    title = $Title
    purpose = $Purpose
    progress = $progressPath
    result = $resultPath
    processes = $processesPath
    shell = $pwshPath
    presenter = $presenterPath
    renderer = $rendererPath
}

if ($Plan) {
    [Console]::Out.Write(($summary | ConvertTo-Json -Compress))
    return
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $pwshPath
$startInfo.UseShellExecute = $true
foreach ($argument in $arguments) { [void]$startInfo.ArgumentList.Add($argument) }
$process = [System.Diagnostics.Process]::Start($startInfo)
if ($null -eq $process) { throw '진행 터미널을 시작하지 못했습니다.' }
$summary.processId = $process.Id
$summary.started = $true
[Console]::Out.Write(($summary | ConvertTo-Json -Compress))
