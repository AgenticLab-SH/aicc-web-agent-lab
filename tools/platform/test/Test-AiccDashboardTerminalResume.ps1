#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath $AiccRoot).Path
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('aicc-resume-check-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture|Out-Null
$source=[IO.File]::ReadAllText((Join-Path $repo 'tools/platform/windows/Invoke-AiccTerminalPicker.ps1'))
$anchor='. ([IO.Path]::GetFullPath($source))'
if(($source.Split($anchor).Count-1) -ne 1){throw 'picker_fixture_anchor_changed'}
$stubs=@'
function Update-PhoneHistory { $global:g3ResumeRefresh++ }
function Read-PhoneHistory { [pscustomobject]@{items=@($global:g3ResumeRecords)} }
function Assert-PhoneResumeRelease { param($Record);$global:g3ResumeAssertions++;if($global:g3ResumeReject){throw 'synthetic_original_release_rejected'};[pscustomobject]@{release=[pscustomobject]@{expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(30).ToUnixTimeMilliseconds()};meta=[pscustomobject]@{model_provider='aicc-ocx'};context=[pscustomobject]@{model='original-model';effort='high'}} }
function Start-PhoneRecord { param($Record,[switch]$Detached,[string]$ExpectedResumeReleaseSha256);$global:g3ResumeStarts++;if($ExpectedResumeReleaseSha256 -cne $Record.resumeRelease.sha256){throw 'checked_pin_not_forwarded'}; $Record.present=$true;$Record.dead=$false; $Record }
function Connect-PhoneRecord { param($Record);throw 'must_not_connect_in_parent' }
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle);$global:g3ResumeWindows++ }
'@
$isolated=Join-Path $fixture 'picker.ps1'
[IO.File]::WriteAllText($isolated,$source.Replace($anchor,$stubs),[Text.UTF8Encoding]::new($false))
$global:g3ResumeRecords=@([pscustomobject]@{id=('a'*32);key='exact';threadId='01234567-89ab-4cde-8012-3456789abcde';pending=$null;present=$false;dead=$true;codex='YES';resumeRelease=@{sha256=('f'*64)}})
$binding='exact|'+$global:g3ResumeRecords[0].threadId
$global:g3ResumeAssertions=0;$global:g3ResumeStarts=0;$global:g3ResumeWindows=0;$global:g3ResumeRefresh=0;$global:g3ResumeReject=$false
$passed=0
$proof=(& $isolated -Action CheckResume -RecordId ('a'*32) -Binding $binding|ConvertFrom-Json)
if($proof.kind -cne 'aicc-terminal-resume-check' -or $proof.releaseSha256 -cne ('f'*64) -or $proof.provider -cne 'aicc-ocx' -or $proof.activeCount -ne 0 -or $proof.unknownCount -ne 0 -or $global:g3ResumeStarts -ne 0 -or $global:g3ResumeWindows -ne 0){throw 'check_must_not_dispatch'};$passed++
foreach($case in @('open','pending','duplicate','release','missing-pin','wrong-pin')){
 $global:g3ResumeRecords=@($global:g3ResumeRecords[0]);$r=$global:g3ResumeRecords[0];$r.present=$false;$r.dead=$true;$r.pending=$null;$global:g3ResumeReject=$false
 $action='CheckResume';$pin=$null
 switch($case){'open'{$r.present=$true;$r.dead=$false};'pending'{$r.pending=@{id='unknown'}};'duplicate'{$global:g3ResumeRecords+= $r};'release'{$global:g3ResumeReject=$true};'missing-pin'{$action='ResumeChecked'};'wrong-pin'{$action='ResumeChecked';$pin='e'*64}}
 $rejected=$false
 try { $params=@{Action=$action;RecordId=('a'*32);Binding=$binding};if($pin){$params.ExpectedReleaseSha256=$pin};$null=& $isolated @params }catch{$rejected=$true}
 if(-not $rejected -or $global:g3ResumeStarts -ne 0 -or $global:g3ResumeWindows -ne 0){throw ('resume_check_failed_'+$case)};$passed++
}
$global:g3ResumeReject=$false
$result=(& $isolated -Action ResumeChecked -RecordId ('a'*32) -Binding $binding -ExpectedReleaseSha256 ('f'*64)|ConvertFrom-Json)
if($result.state -cne 'ATTACH_WINDOW_REQUESTED' -or $global:g3ResumeStarts -ne 1 -or $global:g3ResumeWindows -ne 1){throw 'guarded_resume_not_forwarded'};$passed++
# Invoke the actual Start-PhoneRecord body with fake dependencies. Stop at the
# existing store mutation boundary: no mux, model, process or owner state is used.
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools/platform/codex/Select-PhoneTerminal.ps1'),[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Start-PhoneRecord'},$true)
if(-not $function){throw 'resume_function_missing'}
Invoke-Expression $function.Extent.Text
function Update-PhoneHistory {}
function Read-PhoneHistory { [pscustomobject]@{items=@($global:g3ResumeRecords)} }
function New-PhoneResumeReleaseFromStop { param($Record);$global:g3ResumeMints++;throw 'checked_path_must_not_mint' }
function Assert-PhoneResumeRelease { param($Record);$global:g3ResumeAssertions++;[pscustomobject]@{} }
function Invoke-PhoneStore { param([scriptblock]$Action);throw 'SYNTHETIC_BEFORE_STORE_EFFECT' }
$global:g3ResumeMints=0;$r=$global:g3ResumeRecords[0];$r.present=$false;$r.dead=$true
$r|Add-Member -NotePropertyName cwd -NotePropertyValue $fixture -Force
$r|Add-Member -NotePropertyName stopReceipt -NotePropertyValue @{sha256=('d'*64)} -Force
$rejected=$false
try{$null=Start-PhoneRecord $r -Detached -ExpectedResumeReleaseSha256 ('f'*64)}catch{if($_.Exception.Message -cne 'SYNTHETIC_BEFORE_STORE_EFFECT'){throw};$rejected=$true}
if(-not $rejected -or $global:g3ResumeMints -ne 0){throw 'checked_start_minted_or_dispatched'};$passed++
$rejected=$false
try{$null=Start-PhoneRecord $r -Detached -ExpectedResumeReleaseSha256 ('e'*64)}catch{if($_.Exception.Message -ceq 'SYNTHETIC_BEFORE_STORE_EFFECT'){throw};$rejected=$true}
if(-not $rejected -or $global:g3ResumeMints -ne 0){throw 'checked_start_pin_changed'};$passed++
# Real child script, fake original-owner assertion. Stop before writer claim/CLI.
$child=[IO.File]::ReadAllText((Join-Path $repo 'tools/platform/codex/Resume-PhoneTerminal.ps1'))
$childAnchor=". (Join-Path `$PSScriptRoot 'Select-PhoneTerminal.ps1')"
if(($child.Split($childAnchor).Count-1) -ne 1){throw 'child_fixture_anchor_changed'}
$childStubs=@'
$script:PhoneRoot=$global:g3ResumeChildRoot
function Read-PhoneHistory {
 $global:g3ResumeChildReads++
 if($global:g3ResumeChildChanged -and $global:g3ResumeChildReads -gt 1){$global:g3ResumeChildRecord.resumeRelease.sha256='e'*64}
 [pscustomobject]@{items=@($global:g3ResumeChildRecord)}
}
function Assert-PhoneResumeRelease {
 param($Record);$global:g3ResumeChildChecks++
 if($global:g3ResumeChildChecks -gt 1){throw 'SYNTHETIC_BEFORE_WRITER_CLAIM'}
 [pscustomobject]@{release=[pscustomobject]@{writerRecord=[pscustomobject]@{path=(Join-Path $global:g3ResumeChildRoot 'writer.json')}}}
}
function Write-Host { param($Object,$ForegroundColor);$global:g3ResumeChildMessages+= [string]$Object }
'@
$childFile=Join-Path $fixture 'resume.ps1'
[IO.File]::WriteAllText($childFile,$child.Replace($childAnchor,$childStubs),[Text.UTF8Encoding]::new($false))
foreach($mode in @('wrong','changed','valid')){
 $global:g3ResumeChildRoot=Join-Path $fixture $mode;New-Item -ItemType Directory -Path $global:g3ResumeChildRoot|Out-Null
 $global:g3ResumeChildRecord=[pscustomobject]@{id=('a'*32);threadId='01234567-89ab-4cde-8012-3456789abcde';cwd=$global:g3ResumeChildRoot;codex='YES';pending=@{id=('b'*32)};resumeRelease=@{path=(Join-Path $global:g3ResumeChildRoot 'release.json');sha256=('f'*64)}}
 $global:g3ResumeChildReads=0;$global:g3ResumeChildChecks=0;$global:g3ResumeChildMessages=@();$global:g3ResumeChildChanged=($mode -eq 'changed')
 $expected=if($mode -eq 'wrong'){'e'*64}else{'f'*64}
 & $childFile -RecordId ('a'*32) -AttemptId ('b'*32) -ExpectedResumeReleaseSha256 $expected
 $intent=Test-Path -LiteralPath (Join-Path $global:g3ResumeChildRoot (('b'*32)+'.resume-intent.json'))
 if($mode -eq 'valid'){
   if(-not $intent -or ($global:g3ResumeChildMessages -join ' ') -notmatch 'SYNTHETIC_BEFORE_WRITER_CLAIM'){throw 'valid_child_did_not_stop_before_claim'}
 }elseif($intent){throw ('stale_child_wrote_intent_'+$mode)}
 if(Test-Path -LiteralPath (Join-Path $global:g3ResumeChildRoot (('b'*32)+'.writer-before.json'))){throw 'child_must_not_claim_writer'}
 $passed++
}
Set-Location -LiteralPath $repo
@{passed=$passed;failed=0;synthetic=$true;realWindowsOpened=0;realModelCalls=0;realMessages=0;releaseMints=0;fixturePreserved=$true}|ConvertTo-Json -Compress
