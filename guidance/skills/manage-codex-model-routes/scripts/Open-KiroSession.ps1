[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$WorkingDirectory,
 [Parameter(Mandatory)][string]$Agent,
 [Parameter(Mandatory)][string]$PromptFile,
 [string]$SessionId,
 [string]$Model='claude-opus-5.5',
 [string]$Effort='high',
 [switch]$InWindow
)
$ErrorActionPreference='Stop'
$kiroRetiredFile=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AICC\elevated-kiro\retired.json'
if(Test-Path -LiteralPath $kiroRetiredFile){
 [pscustomobject]@{state='RETIRED_BY_USER';kiroStarted=$false;requestWritten=$false;taskStarted=$false;reason='Kiro event ended; use Codex and ordinary Chat+AICC. Reactivation requires explicit user instruction.'}
 return
}
$WorkingDirectory=(Resolve-Path -LiteralPath $WorkingDirectory).Path
$PromptFile=(Resolve-Path -LiteralPath $PromptFile).Path
if(-not $InWindow){
 $shellExe=(Get-Process -Id $PID).Path
 if([IO.Path]::GetFileName($shellExe) -notin @('pwsh.exe','powershell.exe')){throw 'PowerShell에서 실행하세요.'}
 $launchArgs=@('-NoLogo','-File',('"'+$PSCommandPath+'"'),'-WorkingDirectory',('"'+$WorkingDirectory+'"'),'-Agent',$Agent,'-PromptFile',('"'+$PromptFile+'"'),'-Model',$Model,'-Effort',$Effort,'-InWindow')
 if($SessionId){$launchArgs+=@('-SessionId',$SessionId)}
 $wt=(Get-Command wt.exe -ErrorAction Stop).Source
 # 같은 이름의 창(AICC-Kiro)에 탭을 추가한다. 관리자 실행 중이면 관리자 창, 일반이면 일반 창에 붙는다.
 $wtArgs=@('-w','AICC-Kiro','new-tab','--title',('Kiro-'+$Agent),'-d',('"'+$WorkingDirectory+'"'),('"'+$shellExe+'"'))+$launchArgs
 $p=Start-Process -FilePath $wt -ArgumentList $wtArgs -PassThru
 [pscustomobject]@{pid=$p.Id;agent=$Agent;cwd=$WorkingDirectory;resumeId=$SessionId;state='WINDOW_STARTED'}
 return
}
$cli=Join-Path $env:LOCALAPPDATA 'Kiro-Cli\kiro-cli.exe'
if(-not(Test-Path -LiteralPath $cli -PathType Leaf)){throw 'Kiro CLI가 없습니다. IDE의 kiro 명령과 구분하세요.'}
$hash=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($WorkingDirectory.ToLowerInvariant()))) -replace '-','')
$mutex=[Threading.Mutex]::new($false,('Local\KiroWorkspace-'+$hash.Substring(0,20)))
$owned=$false
try {
 try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
 if(-not $owned){throw '같은 작업 폴더의 관리형 Kiro 창이 이미 열려 있습니다.'}
 $Host.UI.RawUI.WindowTitle='Kiro '+$Agent+' | '+$Model+' '+$Effort
 $prompt=Get-Content -LiteralPath $PromptFile -Raw
 # 지시를 대화형 창의 첫 메시지로 입력한다. 화면 없는 실행(--no-interactive) 후 빈 창을 다시 여는 방식은 쓰지 않는다.
 $chatArgs=@('chat','--v3','--agent',$Agent,'--model',$Model,'--effort',$Effort,'--trust-all-tools','--trust-workspace')
 if($SessionId){$chatArgs+=@('--resume-id',$SessionId)}
 $chatArgs+=@($prompt)
 Push-Location -LiteralPath $WorkingDirectory
 try{& $cli @chatArgs; if($LASTEXITCODE -ne 0){Write-Warning "Kiro exit=$LASTEXITCODE. 원요청을 재전송하지 않습니다."}}finally{Pop-Location}
}finally{if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}

