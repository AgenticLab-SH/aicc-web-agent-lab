# 관제 실행 그룹의 터미널 탭 하나만 닫는다(일반 권한 탭용. 관리자 탭은 Request-ElevatedKiro.ps1 -CloseOnly).
# 대상은 실제 "--resume-id <ID>"(kiro) 또는 "exec resume <ID>"(codex) 인수를 가진 프로세스뿐이며,
# 이 스크립트를 띄운 자기 계보는 제외한다(지시문에 다른 세션 ID가 들어 있는 관제 창 오폐쇄 방지).
# Kiro는 차례 진행 중(session.json status=in_progress + .lock 생존)이면 닫지 않는다. Windows PowerShell 5.1 / 7 호환.
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$SessionId,
 [ValidateSet('kiro','codex')][string]$Runner='kiro'
)
$ErrorActionPreference='Stop'
if($Runner -eq 'codex'){throw 'codex_close_not_supported: 기존 mux에서 Codex를 정상 종료하세요. 프로세스 종료로 차례를 중단하지 않습니다.'}
if($Runner -eq 'kiro' -and $SessionId -notmatch '^sess_[0-9a-f-]{36}$'){ throw 'Kiro 세션 ID 형식이 아닙니다.' }
if($Runner -eq 'codex' -and $SessionId -notmatch '^[0-9a-fA-F-]{36}$'){ throw 'Codex 세션 ID 형식이 아닙니다.' }
if($Runner -eq 'kiro'){
 $dir=Get-ChildItem -Path (Join-Path $env:USERPROFILE '.kiro\sessions') -Directory -Filter $SessionId -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1
 if($dir){
  $meta=$null; try{ $meta=[IO.File]::ReadAllText((Join-Path $dir.FullName 'session.json'),[Text.Encoding]::UTF8)|ConvertFrom-Json }catch{}
  $alive=$false; try{ $alive=[bool](Get-Process -Id ((Get-Content -Raw -LiteralPath (Join-Path $dir.FullName '.lock')|ConvertFrom-Json).pid) -ErrorAction SilentlyContinue) }catch{}
  if($meta -and $meta.status -eq 'in_progress' -and $alive){ [pscustomobject]@{state='HOLD_ACTIVE_TURN';sessionId=$SessionId}|ConvertTo-Json -Compress; exit 3 }
 }
 $name='kiro-cli.exe'; $pattern='--resume-id\s+'+[regex]::Escape($SessionId)+'(\s|$)'
} else {
 $name='codex.exe'; $pattern='exec\s+resume\s+'+[regex]::Escape($SessionId)+'(\s|$)'
}
$mine=@(); $x=$PID; for($i=0;$i -lt 12 -and $x;$i++){ $mine+=$x; $q=Get-CimInstance Win32_Process -Filter "ProcessId=$x"; if(-not $q){break}; $x=$q.ParentProcessId }
$owners=@(Get-CimInstance Win32_Process -Filter "Name='$name'" | Where-Object { $_.CommandLine -match $pattern -and $_.CommandLine -notmatch 'windows-kas-process' -and $mine -notcontains $_.ProcessId })
function Get-Tree([int]$Id){ $Id; Get-CimInstance Win32_Process -Filter "ParentProcessId=$Id" | ForEach-Object { Get-Tree $_.ProcessId } }
$tree=@($owners | ForEach-Object { Get-Tree $_.ProcessId }) | Where-Object { $mine -notcontains $_ } | Select-Object -Unique
[array]::Reverse($tree)
foreach($id in $tree){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
$until=(Get-Date).AddSeconds(20)
while((Get-Date) -lt $until){ if(-not @(Get-CimInstance Win32_Process -Filter "Name='$name'" | Where-Object { $_.CommandLine -match $pattern -and $mine -notcontains $_.ProcessId }).Count){break}; Start-Sleep -Milliseconds 500 }
$left=@(Get-CimInstance Win32_Process -Filter "Name='$name'" | Where-Object { $_.CommandLine -match $pattern -and $mine -notcontains $_.ProcessId }).Count
[pscustomobject]@{state=$(if($left){'PARTIAL'}elseif($owners.Count){'CLOSED'}else{'NO_TAB'});sessionId=$SessionId;runner=$Runner;closed=$owners.Count;remaining=$left}|ConvertTo-Json -Compress
if($left){ exit 4 }
