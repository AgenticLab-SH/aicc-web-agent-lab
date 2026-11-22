#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath $AiccRoot).Path
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('aicc-attach-only-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture|Out-Null
$source=[IO.File]::ReadAllText((Join-Path $repo 'tools/platform/windows/Invoke-AiccTerminalPicker.ps1'))
$anchor='. ([IO.Path]::GetFullPath($source))'
if(($source.Split($anchor).Count-1) -ne 1){throw 'picker_fixture_anchor_changed'}
$stubs=@'
function Update-PhoneHistory { $global:g3AttachFixturerefreshes++ }
function Read-PhoneHistory { [pscustomobject]@{items=@($global:g3AttachFixturerecord)} }
function Get-PhonePickerSnapshot { param([switch]$Refresh); [pscustomobject]@{schemaVersion=1;kind='aicc-terminal-picker';items=@()} }
function Start-PhoneRecord { param($Record,[switch]$Detached); $global:g3AttachFixturestarts++;throw 'must_not_start_or_resume' }
function Connect-PhoneRecord { param($Record);throw 'must_not_block_attach_in_parent' }
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle);$global:g3AttachFixturewindows++;$global:g3AttachFixtureargs=$ArgumentList }
'@
$isolated=Join-Path $fixture 'picker.ps1'
[IO.File]::WriteAllText($isolated,$source.Replace($anchor,$stubs),[Text.UTF8Encoding]::new($false))
$global:g3AttachFixturerecord=[pscustomobject]@{id=('a'*32);key='exact-pane';threadId='01234567-89ab-4cde-8012-3456789abcde';pending=$null;present=$true;dead=$false;codex='YES'}
$binding=$global:g3AttachFixturerecord.key+'|'+$global:g3AttachFixturerecord.threadId
$global:g3AttachFixturestarts=0;$global:g3AttachFixturewindows=0;$global:g3AttachFixturerefreshes=0
$passed=0
$snapshot=(& $isolated -Action Snapshot|ConvertFrom-Json)
if(-not $snapshot.attachOnlySupported){throw 'attach_capability_missing'};$passed++
$result=(& $isolated -Action AttachOnly -RecordId $global:g3AttachFixturerecord.id -Binding $binding|ConvertFrom-Json)
if($result.state -cne 'ATTACH_WINDOW_REQUESTED' -or $result.newConversationCreated -ne $false -or $result.promptReplayed -ne $false -or $global:g3AttachFixturewindows -ne 1 -or $global:g3AttachFixturestarts -ne 0 -or $global:g3AttachFixturerefreshes -ne 1){throw 'attach_only_effect_invalid'}
if(($global:g3AttachFixtureargs -join ' ') -notmatch '-Action Connect'){throw 'connect_child_missing'};$passed++
foreach($case in @('closed','pending','dead','kind','thread','binding')){
 $global:g3AttachFixturerecord.present=$true;$global:g3AttachFixturerecord.pending=$null;$global:g3AttachFixturerecord.dead=$false;$global:g3AttachFixturerecord.codex='YES';$global:g3AttachFixturerecord.threadId='01234567-89ab-4cde-8012-3456789abcde';$global:g3AttachFixturerecord.key='exact-pane'
 switch($case){'closed'{$global:g3AttachFixturerecord.present=$false};'pending'{$global:g3AttachFixturerecord.pending=@{id='uncertain'}};'dead'{$global:g3AttachFixturerecord.dead=$true};'kind'{$global:g3AttachFixturerecord.codex='NO'};'thread'{$global:g3AttachFixturerecord.threadId='other'};'binding'{$global:g3AttachFixturerecord.key='changed'}}
 $rejected=$false
 try{$null=& $isolated -Action AttachOnly -RecordId $global:g3AttachFixturerecord.id -Binding $binding}catch{$rejected=$true}
 if(-not $rejected -or $global:g3AttachFixturewindows -ne 1 -or $global:g3AttachFixturestarts -ne 0){throw ('attach_gate_failed_'+$case)};$passed++
}
# G1-TRAY: real source functions under fake-only process and session fixtures.
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools/platform/codex/Select-PhoneTerminal.ps1'),[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count){throw ('phone_source_parser_error_'+$parseErrors[0].Message)}
foreach($name in @('ConvertFrom-PhoneJson','Split-PhoneNativeCommandLine','Get-PhoneExactResumeId',
                   'Find-PhoneExactRollout','Read-PhoneBoundedText','Get-PhoneKnownContext',
                   'Clear-PhoneCodexBinding','Get-PhoneCodexProcess','Update-PhoneHistory')){
 $matches=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($matches.Count -ne 1){throw ('source_function_missing_'+$name)}
 Invoke-Expression $matches[0].Extent.Text
}
$thread='fedcba98-7654-4c32-8012-abcdef123456'
foreach($case in @(
 @{line=('codex.exe --no-daemon resume '+$thread);id=$thread},
 @{line=('"C:\Program Files\Codex\codex.exe" -C "C:\my project" --no-daemon resume '+$thread);id=$thread},
 @{line=('codex.exe resume --last');id=$null},
 @{line=('codex.exe --no-daemon resume');id=$null},
 @{line=('codex.exe --no-daemon resume '+$thread+' --last');id=$null},
 @{line=('codex.exe resume '+$thread+' resume '+$thread);id=$null},
 @{line=('codex.exe resume '+$thread+' 01234567-89ab-4cde-8012-3456789abcde');id=$null},
 @{line=('codex.exe exec resume '+$thread);id=$null},
 @{line=('codex.exe --label "resume" '+$thread);id=$null},
 @{line=('pwsh.exe -Command "codex.exe resume '+$thread+'"');id=$null},
 @{line=('codex.exe --no-daemon resume not-a-uuid');id=$null},
 @{line=('codex.exe --no-daemon resume "'+$thread);id=$null}
)){
 $actual=Get-PhoneExactResumeId $case.line
 if($actual -cne $case.id){throw ('explicit_resume_parse_case_failed_'+$case.line)}
 $passed++
}
$root=Join-Path $fixture 'sessions'
$day=Join-Path $root '2026\11\06';New-Item -ItemType Directory -Path $day -Force|Out-Null
$rollout=Join-Path $day ('rollout-2026-11-06T08-00-00-'+$thread+'.jsonl')
$meta=@{type='session_meta';payload=@{id=$thread;model_provider='aicc-ocx'}}|ConvertTo-Json -Compress -Depth 5
$turn=@{type='turn_context';payload=@{model='gpt-6.1-sol';effort='high'}}|ConvertTo-Json -Compress -Depth 5
[IO.File]::WriteAllText($rollout,($meta+[Environment]::NewLine+$turn+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
$found=Find-PhoneExactRollout $thread -SessionsRoot $root
if($found -cne $rollout){throw 'exact_rollout_not_found'};$passed++
$known=Get-PhoneKnownContext ([pscustomobject]@{threadId=$thread;rollout=$found}) -SessionsRoot $root
if($known.meta.id -cne $thread -or $known.context.model -cne 'gpt-6.1-sol' -or $known.context.effort -cne 'high'){throw 'rollout_context_mismatch'};$passed++
$originalRollout=[IO.File]::ReadAllBytes($rollout)
try{
 [IO.File]::AppendAllText($rollout,(('x'*1200000)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
 $longKnown=Get-PhoneKnownContext ([pscustomobject]@{threadId=$thread;rollout=$rollout}) -SessionsRoot $root
 if($longKnown.context.model -cne 'gpt-6.1-sol'){throw 'bounded_long_turn_context_missing'};$passed++
}finally{[IO.File]::WriteAllBytes($rollout,$originalRollout)}
# Wrong file boundary and mismatched session_meta are never accepted.
$outside=Join-Path $fixture ('rollout-2026-11-06T08-00-00-'+$thread+'.jsonl')
[IO.File]::Copy($rollout,$outside)
$rejected=$false
try{$null=Get-PhoneKnownContext ([pscustomobject]@{threadId=$thread;rollout=$outside}) -SessionsRoot $root}catch{$rejected=$true}
if(-not $rejected){throw 'outside_sessions_allowed'};$passed++
$wrong=Join-Path $fixture 'mismatch';New-Item -ItemType Directory -Path $wrong|Out-Null
$wrongFile=Join-Path $wrong ([IO.Path]::GetFileName($rollout))
$wrongMeta=@{type='session_meta';payload=@{id='01234567-89ab-4cde-8012-3456789abcde'}}|ConvertTo-Json -Compress
[IO.File]::WriteAllText($wrongFile,($wrongMeta+[Environment]::NewLine+$turn+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
$rejected=$false
try{$null=Get-PhoneKnownContext ([pscustomobject]@{threadId=$thread;rollout=$wrongFile}) -SessionsRoot $wrong}catch{$rejected=$true}
if(-not $rejected){throw 'wrong_session_meta_allowed'};$passed++
$duplicateRoot=Join-Path $fixture 'duplicates';$otherDay=Join-Path $duplicateRoot '2026\11\07'
New-Item -ItemType Directory -Path $otherDay -Force|Out-Null
[IO.File]::Copy($rollout,(Join-Path $otherDay ([IO.Path]::GetFileName($rollout))))
[IO.Directory]::CreateDirectory((Join-Path $duplicateRoot '2026\11\06'))|Out-Null
[IO.File]::Copy($rollout,(Join-Path $duplicateRoot '2026\11\06' ([IO.Path]::GetFileName($rollout))))
$rejected=$false
try{$null=Find-PhoneExactRollout $thread -SessionsRoot $duplicateRoot}catch{$rejected=$true}
if(-not $rejected){throw 'duplicate_exact_rollout_allowed'};$passed++
$link=Join-Path $day ('rollout-2026-11-06T09-00-00-'+$thread+'.jsonl');$linkCreated=$false
try{New-Item -ItemType SymbolicLink -Path $link -Target $rollout -ErrorAction Stop|Out-Null;$linkCreated=$true}catch{}
if($linkCreated){
 $rejected=$false
 try{$null=Get-PhoneKnownContext ([pscustomobject]@{threadId=$thread;rollout=$link}) -SessionsRoot $root}catch{$rejected=$true}
 if(-not $rejected){throw 'reparse_rollout_allowed'}
 if((Find-PhoneExactRollout $thread -SessionsRoot $root) -cne $rollout){throw 'reparse_rollout_displaced_regular'}
 $passed++
}
# No real Windows process, mux, home, terminal or model call: all process data is synthetic.
$index=Join-Path $fixture 'index.jsonl'
$indexRow=@{id=$thread;thread_name='검사 대화 제목'}|ConvertTo-Json -Compress
[IO.File]::WriteAllText($index,($indexRow+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
$global:g3SyntheticPane=[pscustomobject]@{pid=45020;session='fake-session';window='1';pane='0';key='fake-session/1/0/0';title='pwsh';windowTitle='test-pane';cwd=$fixture;dead=$false;created='1794000000';attached='1794000000'}
$global:g3SyntheticState=[pscustomobject]@{items=@();observedAt=$null}
$global:g3SyntheticProcesses=@([pscustomobject]@{ProcessId=45020;ParentProcessId=1;Name='pwsh.exe';CreationDate=[datetime]'2026-11-06T07:00:00';CommandLine='pwsh.exe'},
 [pscustomobject]@{ProcessId=27204;ParentProcessId=45020;Name='codex.exe';CreationDate=[datetime]'2026-11-06T08:00:00';CommandLine=('codex.exe --no-daemon resume '+$thread)})
function Get-PhoneLive { $global:g3SyntheticPane }
function Get-PhonePaneProcesses { param([array]$Panes);$global:g3SyntheticProcesses }
function Invoke-PhoneStore {param([scriptblock]$Action);& $Action $global:g3SyntheticState}
Update-PhoneHistory -SessionsRoot $root -IndexPath $index
$r=$global:g3SyntheticState.items[0]
if($r.threadId -cne $thread -or $r.codexPid -ne 27204 -or $r.model -cne 'gpt-6.1-sol' -or $r.title -cne '검사 대화 제목'){throw 'live_exact_pid_binding_failed'};$passed++
$global:g3SyntheticProcesses[1].CreationDate=[datetime]'2026-11-06T08:15:00'
$global:g3SyntheticProcesses[1].CommandLine='codex.exe resume --last'
Update-PhoneHistory -SessionsRoot $root -IndexPath $index
if($r.threadId -or $r.rollout -or $r.model -or $r.effort -or $r.resumeRelease){throw 'same_pid_new_start_reused_old_identity'};$passed++
$global:g3SyntheticProcesses[1].ProcessId=27300
$global:g3SyntheticProcesses[1].CreationDate=[datetime]'2026-11-06T08:20:00'
$global:g3SyntheticProcesses[1].CommandLine='codex.exe --no-daemon resume'
Update-PhoneHistory -SessionsRoot $root -IndexPath $index
if($r.threadId -or $r.rollout -or $r.codexPid -ne 27300){throw 'changed_pid_reused_identity'};$passed++
function Get-PhonePaneProcesses {param([array]$Panes);throw 'FAKE_CIM_FAILED'}
Update-PhoneHistory -SessionsRoot $root -IndexPath $index
if($r.threadId -or $r.rollout -or $r.codex -cne 'UNKNOWN'){throw 'lookup_failure_reused_identity'};$passed++
# Ambiguous two Codex descendants must not use a guessed first process.
$ambiguous=@($global:g3SyntheticProcesses[1],[pscustomobject]@{ProcessId=27400;ParentProcessId=45020;Name='codex.exe';CreationDate=[datetime]'2026-11-06T08:25:00'})
$rejected=$false
try{$null=Get-PhoneCodexProcess $global:g3SyntheticPane $ambiguous}catch{$rejected=$true}
if(-not $rejected){throw 'ambiguous_codex_descendants_allowed'};$passed++
$outer=[pscustomobject]@{ProcessId=27204;ParentProcessId=45020;Name='codex.exe'}
$bridge=[pscustomobject]@{ProcessId=18824;ParentProcessId=27204;Name='node.exe'}
$transport=[pscustomobject]@{ProcessId=31352;ParentProcessId=18824;Name='codex.exe';CommandLine='codex.exe app-server --listen stdio://'}
$identified=@(Get-PhoneCodexProcess $global:g3SyntheticPane @($outer,$bridge,$transport))
if($identified.Count -ne 1 -or $identified[0].ProcessId -ne 27204){throw 'nested_transport_obscures_pane_owner'};$passed++
$panel=[IO.File]::ReadAllText((Join-Path $repo 'tools/platform/windows/AiccTerminalPickerPanel.cs'))
foreach($marker in @('기존 터미널 연결','저장 대화 이어 열기','새 PowerShell 열기',
  '&&S(row,"binding")==selectedBinding','loadFailed?','tips.SetToolTip(open,open.AccessibleDescription)',
  'Keys.F1','Keys.F5','Keys.Enter','open.Enabled=!busy&&!loadFailed&&loaded')){
 if(-not $panel.Contains($marker)){throw ('picker_ui_guard_missing_'+$marker)}
 $passed++
}
@{passed=$passed;failed=0;synthetic=$true;realWindowsOpened=0;realModelCalls=0;realMessages=0;fixturePreserved=$true}|ConvertTo-Json -Compress
