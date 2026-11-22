#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')]
    [string]$Session = 'work',
    [string]$Workspace = '',
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')]
    [string]$Namespace = 'aicc-phone',
    [string]$Model = 'gpt-6.1-sol',
    [ValidateSet('low','medium','high','xhigh')]
    [string]$Effort = 'high',
    [switch]$List,
    [switch]$Detached,
    [string]$PsmuxExecutable = '',
    [switch]$InsideMux
)
$ErrorActionPreference = 'Stop'
if (-not $Workspace) { $Workspace = (Get-Location).Path }
$Workspace = (Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw '작업 폴더가 필요합니다.' }

function Find-MuxExecutable {
    if ($PsmuxExecutable) {
        $candidate = (Resolve-Path -LiteralPath $PsmuxExecutable -ErrorAction Stop).Path
    } else {
        $command = Get-Command psmux.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $candidate = if ($command) { $command.Source } else { $null }
        if (-not $candidate -and $env:LOCALAPPDATA) {
            $programRoot = Join-Path $env:LOCALAPPDATA 'Programs\psmux'
            $versions = @(Get-ChildItem -LiteralPath $programRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { -not $_.LinkType -and $_.Name -match '^\d+\.\d+\.\d+$' } |
                Sort-Object { [version]$_.Name } -Descending)
            foreach ($version in $versions) {
                $file = Join-Path $version.FullName 'psmux.exe'
                if (Test-Path -LiteralPath $file -PathType Leaf) { $candidate = $file; break }
            }
        }
    }
    if (-not $candidate) { throw '설치된 psmux.exe를 찾지 못했습니다. -PsmuxExecutable로 기존 실행 파일을 지정하세요.' }
    $item = Get-Item -LiteralPath $candidate -ErrorAction Stop
    if ($item.PSIsContainer -or $item.LinkType) { throw 'psmux 실행 파일의 경로를 확인해야 합니다.' }
    return $item.FullName
}

if ($InsideMux) {
    Set-Location -LiteralPath $Workspace
    $aicc = Get-Command aicc -ErrorAction Stop | Select-Object -First 1
    if ($aicc.CommandType -notin @('ExternalScript','Application')) { throw '등록된 aicc 실행 파일이 필요합니다.' }
    Write-Host 'OCX Codex · 계정 미지정 · 새 대화'
    Write-Host '대화 중 자동 계정 전환 지원 여부는 설치된 OCX가 결정합니다.'
    & $aicc.Source codex ocx --route-model $Model --route-effort $Effort -C $Workspace -a on-request
    $code = $LASTEXITCODE
    Write-Host ("Codex 종료 코드: {0}. 이 PowerShell은 유지됩니다. 자동 재실행하지 않습니다." -f $code)
    return
}

$mux = Find-MuxExecutable
$priorPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $sessions = @(& $mux -L $Namespace list-sessions -F '#{session_name}' 2>&1)
    $listCode = $LASTEXITCODE
} finally { $ErrorActionPreference = $priorPreference }
if ($listCode -ne 0) {
    $detail = ($sessions | ForEach-Object { [string]$_ }) -join ' '
    if ($detail -notmatch '(?i)no server running|no server found|no sessions') {
        throw 'mux 목록 조회 실패입니다. 기존 세션을 닫힌 것으로 간주하거나 새 대화를 만들지 않습니다.'
    }
    $sessions = @()
}
if ($List) {
    if ($sessions.Count) { $sessions | ForEach-Object { Write-Output ([string]$_) } }
    else { Write-Host '열린 mux 세션이 없습니다.' }
    return
}
if (@($sessions | Where-Object { [string]$_ -ceq $Session }).Count -eq 0) {
    # No prompt, resume, account override, replay or global configuration change.
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $aiccCommand = Get-Command aicc -ErrorAction Stop | Select-Object -First 1
    if ($aiccCommand.CommandType -notin @('ExternalScript','Application')) { throw '등록된 aicc 실행 파일이 필요합니다.' }
    & $mux -L $Namespace new-session -d -s $Session -n codex -c $Workspace -- $shell -NoLogo -NoProfile -NoExit -File $PSCommandPath -InsideMux -Session $Session -Namespace $Namespace -Workspace $Workspace -Model $Model -Effort $Effort
    if ($LASTEXITCODE -ne 0) { throw '세션 생성 결과가 불명확합니다. 자동 재시도하지 않습니다.' }
    Write-Host 'mux 세션 생성 명령이 반환됐습니다. 모델 요청 성공을 뜻하지는 않습니다.'
} else {
    Write-Host '기존 세션에 연결합니다. 모델·폴더·대화·입력은 다시 보내지 않습니다.'
}
if ($Detached) { return }
if ($env:TMUX -or $env:PSMUX) {
    & $mux -L $Namespace switch-client -t $Session
} else {
    & $mux -L $Namespace attach-session -t $Session
}
if ($LASTEXITCODE -ne 0) { throw 'mux 연결 결과를 확인해야 합니다. 기존 세션은 재생성하지 않습니다.' }