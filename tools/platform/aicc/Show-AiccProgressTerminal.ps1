[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('[가-힣]')][ValidateLength(2, 80)][string]$Title,
    [Parameter(Mandatory = $true)][ValidatePattern('[가-힣]')][ValidateLength(2, 160)][string]$Purpose,
    [Parameter(Mandatory = $true)][string]$Progress,
    [Parameter(Mandatory = $true)][string]$Result,
    [Parameter(Mandatory = $true)][string]$Processes,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$RendererPath,
    [ValidateRange(0, 30)][int]$CloseDelaySeconds = 3
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Host.UI.RawUI.WindowTitle = "$Title · 준비 중"

Write-Host "터미널: $Title"
Write-Host "용도: $Purpose"
Write-Host "상태: 진행 표시 준비 중"
Write-Host "시작: $([DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz'))"

try {
    & $NodePath $RendererPath --label $Title --progress $Progress --result $Result --processes $Processes
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        $Host.UI.RawUI.WindowTitle = "$Title · 완료"
        Write-Host '상태: 완료'
    } else {
        $Host.UI.RawUI.WindowTitle = "$Title · 상태 확인 필요"
        Write-Host "상태: 확인 필요 · 종료 코드 $exitCode"
    }
} catch {
    $exitCode = 1
    $Host.UI.RawUI.WindowTitle = "$Title · 실패"
    Write-Host "상태: 실패 · $($_.Exception.Message)"
} finally {
    if ($CloseDelaySeconds -gt 0) {
        Write-Host "안내: 결과를 $CloseDelaySeconds 초 동안 표시한 뒤 이 창을 닫습니다."
        Start-Sleep -Seconds $CloseDelaySeconds
    }
}

exit $exitCode
