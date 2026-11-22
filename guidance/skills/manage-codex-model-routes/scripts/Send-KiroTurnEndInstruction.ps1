# 진행 중인 기존 Kiro 대화에 다음 지시를 "이번 차례가 끝나는 순간 같은 탭에서" 1회 전달하도록 맡긴다.
# 전달은 그 대화의 Stop hook(kiro-stop-mailbox.mjs)이 한다(공식 계약: Stop hook이 decision=block과 reason을 출력하면
# reason이 그 대화로 돌아가 에이전트가 이어서 진행). 창·키 입력·포커스는 건드리지 않는다.
# 한 대화에 대기 지시는 1개만. 이미 대기 중이면 덮어쓰지 않고 HOLD한다. 이미 대기(idle) 중인 대화는
# Stop이 다시 오지 않으므로 이 경로로는 전달되지 않는다 → Resume-KiroSessionWithPrompt.ps1(탭 교체)을 쓴다.
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidatePattern('^sess_[0-9a-f-]{36}$')][string]$SessionId,
 [Parameter(Mandatory)][string]$PromptFile,
 [ValidateRange(5,1440)][int]$ExpiresMinutes=180,
 [string]$MailboxRoot=$(if($env:KIRO_TURN_MAILBOX_ROOT){$env:KIRO_TURN_MAILBOX_ROOT}else{Join-Path $env:USERPROFILE '.codex\ops\kiro-turn-mailbox'}),
 [switch]$AllowIdle
)
$ErrorActionPreference='Stop'
$kiroRetiredFile=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AICC\elevated-kiro\retired.json'
if(Test-Path -LiteralPath $kiroRetiredFile){
 [pscustomobject]@{state='RETIRED_BY_USER';kiroStarted=$false;requestWritten=$false;taskStarted=$false;reason='Kiro event ended; use Codex and ordinary Chat+AICC. Reactivation requires explicit user instruction.'}
 return
}
$sessionDir=Get-ChildItem -Path (Join-Path $env:USERPROFILE '.kiro\sessions') -Directory -Filter $SessionId -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1
if(-not $sessionDir){[pscustomobject]@{state='HOLD_SESSION_NOT_FOUND';sessionId=$SessionId};return}
# 진행 중 판정(Wake-KiroSupervisor와 같은 기준): Kiro가 쓰는 session.json status=in_progress이고 세션 잠금 프로세스가 살아 있음.
$meta=$null; try{ $meta=Get-Content -Raw -LiteralPath (Join-Path $sessionDir.FullName 'session.json') -Encoding UTF8 | ConvertFrom-Json }catch{}
$lockAlive=$false
$lockFile=Join-Path $sessionDir.FullName '.lock'
if(Test-Path -LiteralPath $lockFile){ try{ $lp=(Get-Content -Raw -LiteralPath $lockFile | ConvertFrom-Json).pid; $lockAlive=[bool](Get-Process -Id $lp -ErrorAction SilentlyContinue) }catch{} }
# 비대화형 실행은 .lock을 늦게 쓰거나 쓰지 않을 수 있다: 그 세션을 정확한 --resume-id로 연 kiro-cli 프로세스도 생존 근거로 본다.
if(-not $lockAlive){ $pattern='--resume-id\s+"?'+[regex]::Escape($SessionId)+'"?(\s|$)'; $lockAlive=@(Get-CimInstance Win32_Process -Filter "Name='kiro-cli.exe'" | Where-Object { $_.CommandLine -match $pattern }).Count -gt 0 }
$active=($meta -and $meta.status -eq 'in_progress') -and $lockAlive
if(-not $active -and -not $AllowIdle){[pscustomobject]@{state='HOLD_NOT_IN_TURN';sessionId=$SessionId;status=$meta.status;lockAlive=$lockAlive;next='대기 중인 대화는 Resume-KiroSessionWithPrompt.ps1로 탭을 교체해 전달'};return}
$instruction=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $PromptFile).Path,[Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
if(-not $instruction.Trim() -or $instruction.Length -gt 24000){throw 'Prompt must be 1..24000 characters'}
$sha=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($instruction)))).Replace('-','').ToLowerInvariant()
[IO.Directory]::CreateDirectory($MailboxRoot)|Out-Null
$target=Join-Path $MailboxRoot "$SessionId.json"
if(Test-Path -LiteralPath $target){[pscustomobject]@{state='HOLD_PENDING_EXISTS';sessionId=$SessionId;mailbox=$target;next='기존 대기 지시가 전달되거나 사람이 지운 뒤 다시 호출'};return}
$id='turnend-'+(Get-Date -Format 'yyyyMMddHHmmss')+'-'+$sha.Substring(0,8)
$item=[ordered]@{schemaVersion=1;id=$id;sessionId=$SessionId;instruction=$instruction;instructionSha256=$sha;createdAt=(Get-Date).ToUniversalTime().ToString('o');expiresAt=(Get-Date).AddMinutes($ExpiresMinutes).ToUniversalTime().ToString('o')}
$tmp=Join-Path $MailboxRoot ("$SessionId."+[guid]::NewGuid().ToString('N')+'.tmp')
[IO.File]::WriteAllText($tmp,($item|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
try{ [IO.File]::Move($tmp,$target) }catch{ Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue; [pscustomobject]@{state='HOLD_PENDING_EXISTS';sessionId=$SessionId};return }
[pscustomobject]@{state='QUEUED_FOR_TURN_END';sessionId=$SessionId;id=$id;instructionSha256=$sha;mailbox=$target;expiresAt=$item.expiresAt;delivery='해당 대화의 Stop hook이 이번 차례 끝에 같은 탭으로 1회 전달. 영수증 receipts.jsonl'}
