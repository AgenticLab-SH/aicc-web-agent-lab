#requires -Version 7.0
[CmdletBinding()]
param(
 [ValidateSet('native','ocx')][string]$Route='ocx',
 [Parameter(Mandatory)][string]$Workspace,
 [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$')][string]$Model,
 [ValidateSet('medium','high')][string]$ReasoningEffort,
 [ValidateRange(0,2147483647)][Alias('AccountNumber')][int]$Account=0,
 [ValidateRange(0,2147483647)][int]$PreferredAccount=0,
 [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$')][string]$AccountSelector
)
$ErrorActionPreference='Stop'
if(([int][bool]$Account+[int][bool]$PreferredAccount+[int][bool]$AccountSelector) -gt 1){throw 'Choose one account option.'}
if(($Account -or $PreferredAccount -or $AccountSelector) -and $Route -ne 'ocx'){throw 'Account selection is only supported by OCX.'}
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$stateRoot=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'}
$root=(Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
if(-not(Test-Path -LiteralPath $root -PathType Container) -or (-not(Test-Path -LiteralPath (Join-Path $root '.git')))){throw 'Select the Git repository root (.git directory or worktree file).'}
# All choices use the registered route owner. Bare codex inherits the current
# HOME endpoint, which may still be Web17841 before shared-HOME deployment.
# Selecting OCX in this dialog must retain explicit OCX admission and routing.
$registry=Get-Content -LiteralPath (Join-Path $stateRoot 'runtime\components.json') -Raw|ConvertFrom-Json
$cli=$registry.components.cli
$release=[IO.Path]::GetFullPath($cli.releaseRoot)
$entry=[IO.Path]::GetFullPath($cli.entry)
if($cli.location -cne 'managed' -or -not $release.StartsWith((Join-Path $stateRoot 'releases\cli')+'\',[StringComparison]::OrdinalIgnoreCase) -or $entry -ine (Join-Path $release 'bin\aicc') -or -not(Test-Path -LiteralPath $entry -PathType Leaf)){throw 'Managed AICC CLI is not registered. Apply the existing AICC CLI installation first.'}
foreach($target in @($entry,$cli.runtime)){
 $item=Get-Item -LiteralPath $target -ErrorAction Stop
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Regular installed launcher files required.'}
}
foreach($relative in @('src/cli.mjs','src/codex-cli-routes.mjs')){
 $pin=$cli.sourceHashes.$relative
 if(-not $pin -or (Get-FileHash -LiteralPath (Join-Path $release $relative) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin){throw 'Managed CLI route files differ from their registered pins. Use the existing installer.'}
}
$Host.UI.RawUI.WindowTitle='AICC Codex CLI · '+$Route.ToUpperInvariant()+' · '+$Model+' / '+$ReasoningEffort
Write-Host ('Route: '+$Route+' | Model: '+$Model+' | Effort: '+$ReasoningEffort)
Write-Host ('Workspace: '+$root)
if($Account){Write-Host ('계정: A'+$Account+' 엄격 고정 (다른 계정으로 전환하지 않음)')}
elseif($PreferredAccount){Write-Host ('시작 선호: A'+$PreferredAccount+' · 실제 배정은 OCX 영수증으로 확인합니다. 선호 번호는 고정이 아닙니다.')}
elseif($AccountSelector){Write-Host '계정 고정: 기존 호환 옵션 (다른 계정으로 자동 전환하지 않음)'}
Write-Host 'Only this selected route is used. Read the connection result here; type your task in Codex.'
if($Route -eq 'ocx'){Write-Host '자동/우선 모드의 계정 전환은 OCX가 담당합니다. 같은 대화는 이전 차례 완료와 이동 가능한 기록이 확인된 다음 미전송 요청에서만 이어집니다. 활성 요청·같은 대화의 불명 요청·이동 불가한 파일/서버 참조는 보류합니다. 모든 모드는 현재 OCX 차단 정책(5시간 97%·장기 98%, 명시 월간전용 구분)을 따릅니다.'}
Push-Location -LiteralPath $root
try{
 $launchArgs=@($entry,'codex',$Route)
 if($Model){$launchArgs+=@('--route-model',$Model)}
 if($ReasoningEffort){$launchArgs+=@('--route-effort',$ReasoningEffort)}
 if($Account){$launchArgs+=@('--account',[string]$Account)}
 elseif($PreferredAccount){$launchArgs+=@('--prefer-account',[string]$PreferredAccount)}
 elseif($AccountSelector){$launchArgs+=@('--route-account',$AccountSelector)}
 $launchArgs+=@('-C',$root)
 & $cli.runtime @launchArgs
 if($LASTEXITCODE -ne 0){Write-Host ('Codex exited with code '+$LASTEXITCODE+'. No route fallback or automatic retry was attempted.') -ForegroundColor Yellow}
}finally{Pop-Location}
