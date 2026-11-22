#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath $AiccRoot).Path
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('aicc-queue-preflight-'+[guid]::NewGuid().ToString('N'))
$StateRoot=Join-Path $fixture 'continuity';$requestRoot=Join-Path $StateRoot 'requests'
New-Item -ItemType Directory -Path $requestRoot -Force|Out-Null
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Test-QueuePreflight','Assert-DesktopEvidence','Assert-DesktopTargetRoute','Digest-Text')){
 $node=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
 if(-not $node){throw ('missing_preflight_function_'+$name)}
 Invoke-Expression $node.Extent.Text
}
function Assert-HelperIdentity {param($cfg);if(-not $cfg.syntheticPinValid){throw 'continuity_protocol_or_helper_pin_mismatch'}}
function Assert-ThreadAvailable {param($entry);if($entry.availability -cne 'ACTIVE'){throw 'thread_unavailable'}}
function Metadata {param($file);@{source='vscode';originator='Codex Desktop'}}
function Thread-Surface {param($meta);'desktop'}
function Read-Json {param($file);Get-Content -LiteralPath $file -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function Process-Alive {param($id,$created);$script:fakeOwnerActive}
function Get-CimInstance {param($ClassName,$Filter);if($script:fakeWriter){[pscustomobject]@{CommandLine=$script:fakeWriter}}}
function Test-DesktopTransport {param($process);$false}
function Terminal-Evidence {param($entry);@{state='TERMINAL';event=@{type='task_complete';last_agent_message=$script:fakeLastMessage}}}
function Queue-Binary {param($cfg);@{sha256=('b'*64)}}
function Get-PoolReadiness {param($cfg);@{state=$script:fakePool;quotaFresh=$true}}
$ThreadId='23456789-2345-4234-8234-234567890abc';$OperationId='12345678-1234-4123-8123-123456789abc'
$MessageFile=Join-Path $requestRoot ($OperationId+'.txt');$EvidenceFile=Join-Path $requestRoot ($OperationId+'.preflight-evidence.json')
[IO.File]::WriteAllText($MessageFile,'synthetic approved intent',[Text.UTF8Encoding]::new($false))
$messageHash=Digest-Text 'synthetic approved intent'
function Config { @{syntheticPinValid=$true;threads=@{$ThreadId=@{threadId=$ThreadId;projectRoot=$fixture;rollout='unused';state='DISABLED';availability='ACTIVE'}};excludedThreadIds=@()} }
function Proof { $now=[DateTimeOffset]::UtcNow.ToString('o');@{schemaVersion=1;source='codex-app.read_thread';threadId=$ThreadId;operationId=$OperationId;senderThreadId='34567890-3456-4345-8345-345678901abc';messageSha256=$messageHash;projectRoot=$fixture;observedAt=$now;status='idle';turnId='45678901-4567-4456-8456-456789012abc';turnStatus='completed';targetRoute=@{source='codex-app.read_thread';provider='ocx';threadId=$ThreadId;turnId='45678901-4567-4456-8456-456789012abc';projectRoot=$fixture;observedAt=$now;responseSha256=('c'*64)}} }
$passed=0
foreach($case in @('ready','other-pending','quota','pin','pending','hold','complete','stale','wrong-route','wrong-message','active','nonterminal','owner','writer','unknown-writer','self-sender','protected')){
 $cfg=Config;$proof=Proof;$script:fakePool='READY';$script:fakeOwnerActive=$false;$script:fakeWriter=$null;$script:fakeLastMessage=''
 switch($case){
  'quota'{$script:fakePool='QUOTA_WAIT'};'pin'{$cfg.syntheticPinValid=$false};'pending'{$cfg.threads[$ThreadId].queueAttempt=@{id='uncertain'}};'other-pending'{$cfg.threads.other=@{queueAttempt=@{id='history'}}};'hold'{$cfg.threads[$ThreadId].holdReason='WAIT'}
  'stale'{$proof.observedAt='2000-01-01T00:00:00Z'};'wrong-route'{$proof.targetRoute.provider='native'};'wrong-message'{$proof.messageSha256='d'*64};'active'{$proof.status='active'};'nonterminal'{$proof.turnStatus='interrupted'}
  'owner'{$script:fakeOwnerActive=$true};'writer'{$script:fakeWriter='codex resume '+$ThreadId};'unknown-writer'{$script:fakeWriter=$true};'self-sender'{$proof.senderThreadId=$ThreadId};'protected'{$cfg.excludedThreadIds=@($ThreadId)}
  'complete'{$script:fakeLastMessage='AICC_CONTINUITY_COMPLETE:'+$ThreadId}
 }
 # Null CommandLine is an explicitly unreadable process, not a clear owner.
 if($case -eq 'unknown-writer'){$script:fakeWriter=''}
 [IO.File]::WriteAllText($EvidenceFile,($proof|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
 $before=$cfg|ConvertTo-Json -Depth 12 -Compress
 if($case -in @('ready','other-pending','quota')){
  $result=Test-QueuePreflight $cfg
  $expected=if($case -in @('ready','other-pending')){'READY_NOT_AUTHORIZED'}else{'QUOTA_WAIT'}
  if($result.state -cne $expected -or $result.dispatched -ne $false -or $result.claimed -ne $false -or $result.automaticDelivery -ne $false){throw ('preflight_result_'+$case)}
 }elseif($case -ne 'unknown-writer'){
  $rejected=$false;try{$null=Test-QueuePreflight $cfg}catch{$rejected=$true}
  if(-not $rejected){throw ('preflight_did_not_reject_'+$case)}
 }else{
  function Get-CimInstance {param($ClassName,$Filter);[pscustomobject]@{CommandLine=$null}}
  $rejected=$false;try{$null=Test-QueuePreflight $cfg}catch{$rejected=$true}
  if(-not $rejected){throw 'unknown_writer_allowed'}
  function Get-CimInstance {param($ClassName,$Filter);if($script:fakeWriter){[pscustomobject]@{CommandLine=$script:fakeWriter}}}
 }
 if(($cfg|ConvertTo-Json -Depth 12 -Compress) -cne $before -or (Test-Path -LiteralPath (Join-Path $requestRoot ($OperationId+'.json')))){throw 'preflight_must_not_claim_or_write'}
 $passed++
}
@{passed=$passed;failed=0;synthetic=$true;realMessages=0;modelCalls=0;realClaims=0;fixturePreserved=$true}|ConvertTo-Json -Compress
