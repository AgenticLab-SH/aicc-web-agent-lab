# 상위 관제(S0) 자동 깨우기. 예약 작업이 정해진 간격으로 1회씩 실행한다. 모델을 직접 부르지 않는다.
# 판정:
#  - S0 진행 중 → 아무것도 안 함. 단 마지막 기록이 staleMinutes 이상 멈춰 있으면 정체로 보고 강제로 다시 연다.
#  - S0가 차례 도중 비정상 종료(잠금 프로세스 없음) → 다시 연다.
#  - 그룹이 진행 중이고 새로 끝난 차례·정체·비정상 종료가 없음 → 아무것도 안 함.
#  - 그 밖(그룹이 새로 끝남, 정체·비정상 종료 의심, 또는 모두 대기) → S0를 "점검" 지시와 함께 관리자 탭으로 다시 연다.
# 기한이 지나면 자기 예약 작업을 끄고 끝낸다. 깨울 때만 기록한다. Windows PowerShell 5.1 호환.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigFile)
$ErrorActionPreference='Stop'
$kiroRetiredFile=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AICC\elevated-kiro\retired.json'
if(Test-Path -LiteralPath $kiroRetiredFile){
 [pscustomobject]@{state='RETIRED_BY_USER';kiroStarted=$false;requestWritten=$false;taskStarted=$false;reason='Kiro event ended; use Codex and ordinary Chat+AICC. Reactivation requires explicit user instruction.'}
 return
}
$utf8=New-Object Text.UTF8Encoding($false)
$cfg=[IO.File]::ReadAllText($ConfigFile,[Text.Encoding]::UTF8)|ConvertFrom-Json
$base=Split-Path -Parent $ConfigFile
$stateFile=Join-Path $base 'wake-state.json'
$logFile=Join-Path $base 'wake-log.md'
$sessions=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.kiro\sessions'
$staleMin=if($cfg.staleMinutes){[double]$cfg.staleMinutes}else{45}
function Log([string]$Text){ [IO.File]::AppendAllText($logFile,('| '+(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')+' | '+$Text+" |`n"),$utf8) }
function Get-SessionState([string]$Id){
 # 진행 여부는 Kiro가 쓰는 session.json status(in_progress)와 세션 잠금 프로세스 생존으로 판단한다.
 # 긴 차례는 messages.jsonl 끝 몇십 줄 안에 turn_start가 없으므로 이벤트 꼬리로 판단하지 않는다(2026-11-01 결함).
 $none=[pscustomobject]@{found=$false;active=$false;crashed=$false;stale=$false;lastEnd=$null}
 if($Id -notmatch '^sess_[0-9a-f-]{36}$'){ return $none }
 $dir=Get-ChildItem -Path $sessions -Directory -Filter $Id -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1
 if(-not $dir){ return $none }
 $meta=$null; try{ $meta=[IO.File]::ReadAllText((Join-Path $dir.FullName 'session.json'),[Text.Encoding]::UTF8)|ConvertFrom-Json }catch{}
 $running=($meta -and $meta.status -eq 'in_progress')
 $alive=$false
 $lock=Join-Path $dir.FullName '.lock'
 if(Test-Path -LiteralPath $lock){ try{ $lp=(Get-Content -Raw -LiteralPath $lock|ConvertFrom-Json).pid; $alive=[bool](Get-Process -Id $lp -ErrorAction SilentlyContinue) }catch{} }
 $msgFile=Join-Path $dir.FullName 'messages.jsonl'
 $lastWrite=(Get-Item -LiteralPath $msgFile).LastWriteTime
 $lastEnd=$null
 $lines=@(Get-Content -LiteralPath $msgFile -Tail 400 -Encoding UTF8)
 for($i=$lines.Count-1;$i -ge 0;$i--){ if($lines[$i] -match '"type":"turn_end"'){ try{ $lastEnd=[string](($lines[$i]|ConvertFrom-Json).timestamp) }catch{}; break } }
 $active=($running -and $alive)
 $stale=($active -and ((Get-Date)-$lastWrite).TotalMinutes -ge $staleMin)
 [pscustomobject]@{found=$true;active=$active;crashed=($running -and -not $alive);stale=$stale;lastEnd=$lastEnd}
}
$now=Get-Date
if($now -ge [datetime]$cfg.deadline){
 try{ Disable-ScheduledTask -TaskName $cfg.taskName | Out-Null }catch{}
 Log '기한 도달 · 자동 깨우기 종료'; return
}
$state=if(Test-Path -LiteralPath $stateFile){[IO.File]::ReadAllText($stateFile,[Text.Encoding]::UTF8)|ConvertFrom-Json}else{[pscustomobject]@{lastWakeAt=$null;seen=$null}}
$seen=@{}; if($state.seen){ $state.seen.PSObject.Properties | ForEach-Object { $seen[$_.Name]=$_.Value } }; $oldSeen=$state.seen
$force=$false; $reasons=@()
$s0=Get-SessionState $cfg.s0.sessionId
if($s0.active){
 if(-not $s0.stale){ return }
 $force=$true; $reasons+=('S0 정체 '+$staleMin+'분 이상')
}
if($s0.crashed){ $reasons+='S0 비정상 종료' }
$anyActive=$false; $newFinish=@()
foreach($g in $cfg.groups){
 if(-not $g.sessionId){ continue }  # 아직 S0가 열지 않은 그룹
 $st=Get-SessionState $g.sessionId
 if($st.active -and -not $st.stale){ $anyActive=$true }
 if($st.stale){ $reasons+=($g.name+' 정체 의심') }
 if($st.crashed){ $reasons+=($g.name+' 비정상 종료 의심') }
 if($st.lastEnd -and $st.lastEnd -ne $seen[$g.name]){ $newFinish+=$g.name; $seen[$g.name]=$st.lastEnd }
}
if($newFinish.Count){ $reasons+=('새로 끝난 차례: '+($newFinish -join ',')) }
if(-not $force -and $anyActive -and -not $reasons.Count){ return }
if(-not $force -and $state.lastWakeAt -and ($now-[datetime]$state.lastWakeAt).TotalMinutes -lt [double]$cfg.minGapMinutes){ return }
if(-not $reasons.Count){ $reasons+='모두 대기' }
$req=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\skills\launch-admin-powershell\scripts\Request-ElevatedKiro.ps1'
$args1=@{WorkingDirectory=$cfg.s0.workingDirectory;Agent=$cfg.s0.agent;PromptFile=$cfg.s0.wakePrompt;SessionId=$cfg.s0.sessionId;Model=$cfg.s0.model;Effort=$cfg.s0.effort;Replace=$true}
if($force){ $args1.Force=$true }
$r=& $req @args1
Log ('S0 깨움 · '+($reasons -join ' / ')+' · 결과 '+$r.state)
if($r.state -eq 'LAUNCHED'){ $state=[pscustomobject]@{lastWakeAt=$now.ToString('o');seen=$seen} } else { $state=[pscustomobject]@{lastWakeAt=$state.lastWakeAt;seen=$oldSeen} }
[IO.File]::WriteAllText($stateFile,($state|ConvertTo-Json -Compress),$utf8)
