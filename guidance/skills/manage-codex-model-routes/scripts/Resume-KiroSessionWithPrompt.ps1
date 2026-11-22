# 대기 중인 기존 Kiro 대화를 다음 지시와 함께 보이는 탭으로 다시 연다(관제가 하위 관제/작업 대화를 재개할 때).
# 순서: 대화의 마지막 차례가 끝났는지 확인 → 그 대화를 연 대기 창만 닫음 → 같은 세션 ID로 새 탭을 열고 지시를 첫 메시지로 입력.
# 차례가 진행 중이면 HOLD_ACTIVE_TURN으로 멈춘다. 한 대화에 창 하나(작성자 하나)만 둔다.
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidatePattern('^sess_[0-9a-f-]{36}$')][string]$SessionId,
 [Parameter(Mandatory)][string]$Agent,
 [Parameter(Mandatory)][string]$WorkingDirectory,
 [Parameter(Mandatory)][string]$PromptFile,
 [string]$Model='claude-opus-5.5',
 [string]$Effort='high',
 [switch]$Elevated,
 # 차례가 진행 중이면 HOLD 대신 Send-KiroTurnEndInstruction.ps1로 "이번 차례 끝에 같은 탭으로 1회 전달"을 맡긴다.
 [switch]$QueueIfActive
)
$ErrorActionPreference='Stop'
$kiroRetiredFile=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AICC\elevated-kiro\retired.json'
if(Test-Path -LiteralPath $kiroRetiredFile){
 [pscustomobject]@{state='RETIRED_BY_USER';kiroStarted=$false;requestWritten=$false;taskStarted=$false;reason='Kiro event ended; use Codex and ordinary Chat+AICC. Reactivation requires explicit user instruction.'}
 return
}
$sessionDir=Get-ChildItem -Path (Join-Path $env:USERPROFILE '.kiro\sessions') -Directory -Filter $SessionId -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1
if(-not $sessionDir){[pscustomobject]@{state='HOLD_SESSION_NOT_FOUND';sessionId=$SessionId};return}
$messages=Join-Path $sessionDir.FullName 'messages.jsonl'
$last=Get-Content -LiteralPath $messages -Tail 3 -Encoding UTF8 | ForEach-Object { try{($_|ConvertFrom-Json).payload}catch{} }
$ended=@($last | Where-Object { $_.type -eq 'turn_end' -or ($_.type -eq 'session_event' -and $_.category -eq 'session_pause') }).Count -gt 0
if(-not $ended){
 if($QueueIfActive){ $q=& (Join-Path $PSScriptRoot 'Send-KiroTurnEndInstruction.ps1') -SessionId $SessionId -PromptFile $PromptFile; return $q }
 [pscustomobject]@{state='HOLD_ACTIVE_TURN';sessionId=$SessionId;next='차례가 끝난 뒤 다시 호출하거나 -QueueIfActive'};return
}
# 관리자 경로: 기존 탭 닫기와 재오픈을 관리자 예약 작업이 함께 처리한다(일반 권한은 관리자 탭을 닫지 못함).
if($Elevated){
 $req=Join-Path $env:USERPROFILE '.codex\skills\launch-admin-powershell\scripts\Request-ElevatedKiro.ps1'
 $r=& $req -WorkingDirectory $WorkingDirectory -Agent $Agent -PromptFile $PromptFile -SessionId $SessionId -Model $Model -Effort $Effort -Replace
 [pscustomobject]@{state=$(if($r.state -eq 'LAUNCHED'){'REOPENED'}else{$r.state});sessionId=$SessionId;elevated=$true;launch=$r}
 return
}
# 이 세션을 연 kiro-cli 대화 프로세스(창)만 닫는다. 다른 세션·다른 창은 건드리지 않는다.
# 대상은 실제 "--resume-id <ID>" 인수로만 찾는다. 지시문에 ID 문자열이 들어 있는 관제 창이나
# 이 스크립트를 부른 호출자 자신의 프로세스 계보는 대상에서 뺀다(2026-10-31 S0 창 종료 결함).
$mine=@(); $x=$PID; for($i=0;$i -lt 12 -and $x;$i++){ $mine+=[int]$x; $q=Get-CimInstance Win32_Process -Filter "ProcessId=$x"; if(-not $q){break}; $x=$q.ParentProcessId }
$pattern='--resume-id\s+"?'+[regex]::Escape($SessionId)+'"?(\s|$)'
$owners=@(Get-CimInstance Win32_Process -Filter "Name='kiro-cli.exe'" | Where-Object { $_.CommandLine -match $pattern -and $_.CommandLine -notmatch 'windows-kas-process' -and $mine -notcontains [int]$_.ProcessId })
$lockFile=Join-Path $sessionDir.FullName '.lock'
if(Test-Path -LiteralPath $lockFile){
 try{$lockPid=(Get-Content -Raw -LiteralPath $lockFile | ConvertFrom-Json).pid; $lp=Get-CimInstance Win32_Process -Filter "ProcessId=$lockPid"; if($lp -and $lp.ParentProcessId){$parent=Get-CimInstance Win32_Process -Filter "ProcessId=$($lp.ParentProcessId)"; if($parent -and $parent.Name -eq 'kiro-cli.exe' -and $mine -notcontains [int]$parent.ProcessId -and -not($owners.ProcessId -contains $parent.ProcessId)){$owners+=$parent}}}catch{}
}
function Get-Tree([int]$Id){ $Id; Get-CimInstance Win32_Process -Filter "ParentProcessId=$Id" | ForEach-Object { Get-Tree $_.ProcessId } }
$tree=@(@($owners | ForEach-Object { Get-Tree $_.ProcessId } | Where-Object { $mine -notcontains [int]$_ }) | Select-Object -Unique)
# 자식(bun·KAS)부터 닫아 세션 잠금을 남기지 않는다.
if($tree.Count -gt 1){[array]::Reverse($tree)}
foreach($id in $tree){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
$deadline=(Get-Date).AddSeconds(20)
while((Get-Date) -lt $deadline){
 $alive=@(Get-CimInstance Win32_Process -Filter "Name='kiro-cli.exe'" | Where-Object { $_.CommandLine -match $pattern -and $mine -notcontains [int]$_.ProcessId })
 if(-not $alive.Count){break}; Start-Sleep -Milliseconds 500
}
Start-Sleep -Seconds 2
if($Elevated){
 $req=Join-Path $env:USERPROFILE '.codex\skills\launch-admin-powershell\scripts\Request-ElevatedKiro.ps1'
 $r=& $req -WorkingDirectory $WorkingDirectory -Agent $Agent -PromptFile $PromptFile -SessionId $SessionId -Model $Model -Effort $Effort
} else {
 $r=& (Join-Path $PSScriptRoot 'Open-KiroSession.ps1') -WorkingDirectory $WorkingDirectory -Agent $Agent -PromptFile $PromptFile -SessionId $SessionId -Model $Model -Effort $Effort
}
[pscustomobject]@{state='REOPENED';sessionId=$SessionId;closedWindows=$owners.Count;elevated=[bool]$Elevated;launch=$r}
