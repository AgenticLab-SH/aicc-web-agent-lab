#requires -Version 7.5
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath $AiccRoot).Path
$t=$null;$e=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'),[ref]$t,[ref]$e)
$node=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Send-QueueMessage'},$true)
$source=$node.Extent.Text.Replace('[Diagnostics.Process]::Start($info)','(New-FakeQueueProcess $info)')
Invoke-Expression $source
$StateRoot=Join-Path ([IO.Path]::GetTempPath()) ('aicc-checked-queue-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $StateRoot 'requests') -Force|Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
$ThreadId='23456789-2345-4234-8234-234567890abc';$EvidenceFile='fixture-only'
function Read-Json($file){if(Test-Path -LiteralPath $file){Get-Content -LiteralPath $file -Raw|ConvertFrom-Json -AsHashtable}}
function Write-Json($file,$value){[IO.File]::WriteAllText($file,($value|ConvertTo-Json -Depth 12),$utf8)}
function Digest-Text($text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($text))).ToLowerInvariant()}
function Queue-Binary($cfg){@{path=(Join-Path $PSHOME 'pwsh.exe');sha256=('b'*64);source='FAKE'}}
function Assert-HelperIdentity($cfg){}
function Assert-ThreadAvailable($entry){}
function Metadata($file){@{}}
function Thread-Surface($meta){'desktop'}
function Save-QueueProgress($id){}
function With-Registry($action){$script:inside=$true;try{& $action $script:cfg}finally{$script:inside=$false}}
function Test-QueuePreflight($cfg){
 if(-not $script:inside){throw 'checked_gate_not_under_registry_lock'}
 $script:checks++
 if($script:mode -eq 'stale'){throw 'stale_exact_evidence'}
 @{state=if($script:mode -eq 'quota'){'QUOTA_WAIT'}else{'READY_NOT_AUTHORIZED'};messageSha256=if($script:mode -eq 'hash'){'f'*64}else{Digest-Text '합성 message'};binarySha256=if($script:mode -eq 'binary'){'f'*64}else{'b'*64}}
}
function New-FakeQueueProcess($info){
 $script:starts++
 if($info.ArgumentList[0] -cne 'queue' -or $info.ArgumentList[2] -cne $ThreadId -or -not $info.ArgumentList[4].Contains('AICC_QUEUE_ATTEMPT:'+ $OperationId)){throw 'fake_exact_args_invalid'}
 $p=[pscustomobject]@{ExitCode=0;StandardOutput=[pscustomobject]@{};StandardError=[pscustomobject]@{}}
 $p.StandardOutput|Add-Member ScriptMethod ReadToEndAsync { [Threading.Tasks.Task]::FromResult(('Queued message 34567890-3456-4345-8345-345678901abc for thread '+$ThreadId+'.')) }
 $p.StandardError|Add-Member ScriptMethod ReadToEndAsync {[Threading.Tasks.Task]::FromResult('')}
 $p|Add-Member ScriptMethod WaitForExit {param($ms);$script:mode -ne 'timeout'}
 $p|Add-Member ScriptMethod Kill {}
 $p|Add-Member ScriptMethod Dispose {}
 return $p
}
$passed=0
foreach($script:mode in @('success','other-unknown','same-pending','stale','quota','hash','binary','timeout')){
 $OperationId=[guid]::NewGuid().ToString();$MessageFile=Join-Path $StateRoot ('requests/'+$OperationId+'.txt')
 [IO.File]::WriteAllText($MessageFile,'합성 message',$utf8)
 $script:cfg=@{threads=@{$ThreadId=@{threadId=$ThreadId;projectRoot=$StateRoot}};excludedThreadIds=@()};$script:checks=0;$script:starts=0
 if($mode -eq 'other-unknown'){$cfg.threads.other=@{queueAttempt=@{state='UNKNOWN'}}}
 if($mode -eq 'same-pending'){$cfg.threads[$ThreadId].attempt=@{state='UNKNOWN'}}
 $allowed=$mode -in @('success','other-unknown','timeout');$failed=$false
 try{$result=Send-QueueMessage $cfg}catch{$failed=$true}
 if($allowed){
  if($failed -or $starts -ne 1 -or $checks -ne 1 -or $result.state -cne $(if($mode -eq 'timeout'){'QUEUE_DELIVERY_UNCERTAIN'}else{'QUEUE_ACCEPTED'})){throw ('checked_case_failed_'+$mode)}
  $before=[IO.File]::ReadAllBytes((Join-Path $StateRoot ('requests/'+$OperationId+'.json')))
  $again=Send-QueueMessage $cfg
  if($starts -ne 1 -or $again.id -cne $OperationId){throw 'checked_send_replayed'}
  if([Convert]::ToHexString($before) -cne [Convert]::ToHexString([IO.File]::ReadAllBytes((Join-Path $StateRoot ('requests/'+$OperationId+'.json'))))){throw 'original_receipt_changed'}
 }elseif(-not $failed -or $starts -ne 0 -or (Test-Path -LiteralPath (Join-Path $StateRoot ('requests/'+$OperationId+'.json')))){throw ('checked_gate_failed_'+$mode)}
 $passed++
}
@{passed=$passed;failed=0;synthetic=$true;realMessages=0;realClaims=0;realProcessStarts=0;fixtureRoot=$StateRoot}|ConvertTo-Json -Compress
