param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$RecordId,
      [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$AttemptId,
      [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedResumeReleaseSha256)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Select-PhoneTerminal.ps1')
$writerGate=$null;$receiptGate=$null
try {
    $rows=@((Read-PhoneHistory).items|Where-Object id -eq $RecordId)
    if($rows.Count -ne 1){throw '정확한 기록이 없습니다.'};$r=$rows[0]
    $claim=if($r.pending){$r.pending}else{$r.lastAttempt}
    if(-not $claim -or $claim.id -cne $AttemptId){throw '원 재개 요청의 소유권이 다릅니다.'}
    if($ExpectedResumeReleaseSha256 -and $r.resumeRelease.sha256 -cne $ExpectedResumeReleaseSha256){throw '조회한 해제 근거가 자식 실행 전에 바뀌었습니다.'}
    Set-Location -LiteralPath $r.cwd
    if($r.codex -eq 'NO'){Write-Host '작업 폴더를 복원했습니다. 이전 명령은 재실행하지 않습니다.';return}
    $known=Assert-PhoneResumeRelease $r
    $receiptGate=[IO.File]::Open(($r.resumeRelease.path+'.resume.lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $writerPath=[IO.Path]::GetFullPath($known.release.writerRecord.path)
    $writerGate=[IO.File]::Open(($writerPath+'.lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    if($ExpectedResumeReleaseSha256){
        $fresh=@((Read-PhoneHistory).items|Where-Object id -eq $RecordId)
        if($fresh.Count -ne 1 -or $fresh[0].threadId -cne $r.threadId -or $fresh[0].resumeRelease.sha256 -cne $ExpectedResumeReleaseSha256 -or $fresh[0].pending.id -cne $AttemptId){throw '잠금 이후 조회 대상·해제 근거·재개 claim이 바뀌었습니다.'}
    }
    $intent=Join-Path $script:PhoneRoot ($AttemptId+'.resume-intent.json')
    $fd=[IO.File]::Open($intent,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$bytes=[Text.Encoding]::UTF8.GetBytes((@{schemaVersion=1;recordId=$RecordId;attemptId=$AttemptId;threadId=$r.threadId;state='DISPATCHING';automaticRetry=$false}|ConvertTo-Json));$fd.Write($bytes,0,$bytes.Length);$fd.Flush($true)}finally{$fd.Dispose()}
    [void](Assert-PhoneResumeRelease $r)
    # Claim the same exact writer before dispatch. Keep the original and lock on uncertainty.
    [IO.File]::WriteAllBytes((Join-Path $script:PhoneRoot ($AttemptId+'.writer-before.json')),$known.writerBytes)
    $known.writer|Add-Member -NotePropertyName writerReleased -NotePropertyValue $false -Force
    $known.writer|Add-Member -NotePropertyName resumeAttempt -NotePropertyValue ([pscustomobject]@{id=$AttemptId;threadId=$r.threadId;state='DISPATCHING';pid=$PID;automaticRetry=$false}) -Force
    $writerTmp=$writerPath+'.'+$AttemptId+'.tmp'
    [IO.File]::WriteAllText($writerTmp,($known.writer|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
    if((Get-FileHash -LiteralPath $writerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $known.release.writerRecord.sha256){throw '실행 직전 작성권이 바뀌었습니다.'}
    [IO.File]::Replace($writerTmp,$writerPath,(Join-Path ([IO.Path]::GetDirectoryName($writerPath)) ($AttemptId+'.writer-backup.json')))
    $claimedWriterSha=(Get-FileHash -LiteralPath $writerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    # G1-08: the launcher writes a stop receipt from the real exit/PID and this conversation's OCX rows.
    $stopDirectory=Join-Path $script:PhoneRoot ('stops\'+$AttemptId);[void][IO.Directory]::CreateDirectory($stopDirectory)
    $aicc=Join-Path $env:LOCALAPPDATA 'Programs\AICC-Tools\node-v22.23.2-win-x64\aicc.ps1'
    if(-not (Test-Path -LiteralPath $aicc -PathType Leaf)){throw '기존 등록 AICC 실행기가 없습니다.'}
    Write-Host ('기존 대화 열기: '+$r.title)
    Write-Host '추가 프롬프트 없이 exact resume합니다. 원 불명 요청을 다시 보내지 마세요.'
    $launch=@('codex','ocx','--route-model',[string]$known.context.model)
    if($known.context.effort){$launch+=@('--route-effort',[string]$known.context.effort)}
    $launch+=@('--checkpoint-dir',$stopDirectory,'resume',$r.threadId,'-C',$r.cwd,'-a','on-request')
    & $aicc @launch
    $exitCode=$LASTEXITCODE
    try {
    $stops=@(Get-ChildItem -LiteralPath $stopDirectory -Filter '*.stop.json' -File -ErrorAction SilentlyContinue)
    if($exitCode -eq 0 -and $stops.Count -eq 1){
        # Hand the exact writer back only if nobody changed it during the session (CAS on our claim bytes).
        $stopSha=(Get-FileHash -LiteralPath $stops[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $stop=ConvertFrom-PhoneJson ([IO.File]::ReadAllText($stops[0].FullName))
        if($stop.threadId -ceq $r.threadId -and (Get-FileHash -LiteralPath $writerPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $claimedWriterSha){
            $after=ConvertFrom-PhoneJson ([IO.File]::ReadAllText($writerPath))
            $after|Add-Member -NotePropertyName writerReleased -NotePropertyValue $true -Force
            $after.resumeAttempt|Add-Member -NotePropertyName state -NotePropertyValue 'EXITED_NORMAL_STOP_RECORDED' -Force
            $after.resumeAttempt|Add-Member -NotePropertyName stopReceipt -NotePropertyValue ([pscustomobject]@{path=$stops[0].FullName;sha256=$stopSha}) -Force
            $releaseTmp=$writerPath+'.'+$AttemptId+'.release.tmp'
            [IO.File]::WriteAllText($releaseTmp,($after|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
            if((Get-FileHash -LiteralPath $writerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $claimedWriterSha){throw '종료 직후 작성권이 바뀌어 해제하지 않았습니다.'}
            [IO.File]::Replace($releaseTmp,$writerPath,(Join-Path ([IO.Path]::GetDirectoryName($writerPath)) ($AttemptId+'.writer-claimed.json')))
            Invoke-PhoneStore {
                param($state)
                $row=$state.items|Where-Object id -eq $RecordId
                $row|Add-Member -NotePropertyName stopReceipt -NotePropertyValue ([pscustomobject]@{path=$stops[0].FullName;sha256=$stopSha}) -Force
                $row|Add-Member -NotePropertyName writerRecordPath -NotePropertyValue $writerPath -Force
            }
            Write-Host '정상 종료와 이 대화 idle을 기록하고 작성권을 돌려놓았습니다. 다음 재개는 이 영수증으로 새 해제를 만듭니다.'
        } else { Write-Host '종료 중 작성권 또는 대화가 바뀌어 작성권을 잡은 상태로 보존합니다.' -ForegroundColor Yellow }
    } elseif($exitCode -eq 0) { Write-Host '정지 영수증이 없어(대화 불명·진행 중·UNKNOWN) 작성권을 잡은 상태로 보존합니다.' -ForegroundColor Yellow }
    } catch { Write-Host ('작성권 반환 보류: '+$_.Exception.Message+' · 원 영수증과 작성권을 그대로 둡니다.') -ForegroundColor Yellow }
    $result=Join-Path $script:PhoneRoot ($AttemptId+'.resume-result.json')
    $fd=[IO.File]::Open($result,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$bytes=[Text.Encoding]::UTF8.GetBytes((@{schemaVersion=1;attemptId=$AttemptId;threadId=$r.threadId;state='CLI_EXITED_NOT_WORK_COMPLETION';exitCode=$exitCode;automaticRetry=$false}|ConvertTo-Json));$fd.Write($bytes,0,$bytes.Length);$fd.Flush($true)}finally{$fd.Dispose()}
} catch {
    Write-Host ('재개 보류: '+$_.Exception.Message) -ForegroundColor Yellow
    Write-Host '현재 PowerShell을 유지합니다. 새 대화·다른 경로·원문 재전송은 하지 않습니다.'
} finally {if($writerGate){$writerGate.Dispose()};if($receiptGate){$receiptGate.Dispose()}}
