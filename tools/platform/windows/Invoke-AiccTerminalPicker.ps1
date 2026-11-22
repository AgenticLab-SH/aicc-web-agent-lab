param([ValidateSet('Snapshot','Open','AttachOnly','CheckResume','ResumeChecked','Connect','PowerShell')][string]$Action='Snapshot',
      [ValidatePattern('^[a-f0-9]{32}$')][string]$RecordId,
      [string]$Binding,[switch]$Refresh,
      [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedReleaseSha256)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$source=Join-Path $PSScriptRoot '..\codex\Select-PhoneTerminal.ps1'
. ([IO.Path]::GetFullPath($source))
if($Action -eq 'Snapshot'){$snapshot=Get-PhonePickerSnapshot -Refresh:$Refresh;$snapshot|Add-Member -NotePropertyName attachOnlySupported -NotePropertyValue $true;$snapshot|ConvertTo-Json -Depth 8;return}
if($Action -eq 'PowerShell'){
    $shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Start-Process -FilePath $shell -ArgumentList @('-NoLogo','-NoExit') -WindowStyle Normal|Out-Null
    @{state='POWERSHELL_OPEN_REQUESTED';modelRequests=0}|ConvertTo-Json;return
}
if(-not $RecordId){throw '기존 record ID가 필요합니다.'}
if($Action -in @('AttachOnly','CheckResume','ResumeChecked')){Update-PhoneHistory}
$records=@((Read-PhoneHistory).items|Where-Object id -eq $RecordId)
if($records.Count -ne 1){throw '선택 항목이 바뀌었습니다. 새로 고침하세요.'};$record=$records[0]
if(($record.key+'|'+$record.threadId) -cne $Binding){throw '선택한 대화 결속이 바뀌었습니다. 원 요청은 실행하지 않았습니다.'}
if($Action -in @('CheckResume','ResumeChecked')){
    if($record.pending -or ($record.present -and -not $record.dead) -or $record.codex -ne 'YES'){throw '닫힌 exact Codex 기록과 불명 요청 없음이 필요합니다.'}
    if(@((Read-PhoneHistory).items|Where-Object threadId -CEQ $record.threadId).Count -ne 1){throw '같은 대화의 여러 기록을 먼저 조정해야 합니다.'}
    if($record.threadId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw '정확한 대화 UUID가 필요합니다.'}
    $known=Assert-PhoneResumeRelease $record
    $releaseSha=[string]$record.resumeRelease.sha256
    if($ExpectedReleaseSha256 -and $ExpectedReleaseSha256 -cne $releaseSha){throw '조회 이후 해제 영수증이 바뀌었습니다.'}
    $expires=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$known.release.expiresAt).ToString('o')
    if($Action -eq 'CheckResume'){
        @{schemaVersion=1;kind='aicc-terminal-resume-check';recordId=$record.id;threadId=$record.threadId;binding=$Binding;releaseSha256=$releaseSha;expiresAt=$expires;provider=[string]$known.meta.model_provider;model=[string]$known.context.model;effort=[string]$known.context.effort;normalExit=$true;writerReleased=$true;activeCount=0;unknownCount=0;newConversationCreated=$false;promptReplayed=$false}|ConvertTo-Json -Depth 4;return
    }
    if(-not $ExpectedReleaseSha256){throw '조회한 해제 영수증 SHA가 필요합니다.'}
    # Existing Start/Resume performs another live check and writer CAS before CLI dispatch.
}
if($Action -eq 'Connect'){Connect-PhoneRecord $record;return}
if($Action -eq 'AttachOnly'){
    if($record.pending -or -not $record.present -or $record.dead -or $record.codex -ne 'YES' -or $record.threadId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw '기존 exact Codex 터미널이 열려 있어야 합니다. 재개·새 생성은 하지 않습니다.'}
    $opened=$record
}elseif($Action -eq 'ResumeChecked'){$opened=Start-PhoneRecord $record -Detached -ExpectedResumeReleaseSha256 $ExpectedReleaseSha256}
else{$opened=Start-PhoneRecord $record -Detached}
if(-not $opened -or -not $opened.present -or $opened.dead){throw '열기 결과 불명: 재시도하지 않습니다.'}
$shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$childArgs=@('-NoLogo','-NoProfile','-File',('"'+$PSCommandPath+'"'),'-Action','Connect','-RecordId',$opened.id,'-Binding',('"'+$opened.key+'|'+$opened.threadId+'"'))
$priorMux=$env:TMUX;$priorPsmux=$env:PSMUX
try{
    $env:TMUX=$null;$env:PSMUX=$null
    Start-Process -FilePath $shell -ArgumentList $childArgs -WindowStyle Normal|Out-Null
}finally{$env:TMUX=$priorMux;$env:PSMUX=$priorPsmux}
@{state='ATTACH_WINDOW_REQUESTED';newConversationCreated=$false;promptReplayed=$false}|ConvertTo-Json
