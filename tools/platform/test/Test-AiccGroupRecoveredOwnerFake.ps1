#requires -Version 7.5
# Independent fake contract tests; no real Task/registry/CLI/model access.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../windows/CodexContinuityGroupInstall.ps1')
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityCliPin.psm1') -Force
$script:PinModule=Get-Module CodexContinuityCliPin
$pass=0
function Maintenance-Hash([string]$file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function Passed([string]$name){$script:pass++;Write-Output ('PASS '+$script:pass+' '+$name)}
function Refused([string]$name,[scriptblock]$action,[string]$error){
 $hit=$null;try{& $action}catch{$hit=$_.Exception.Message}
 if(-not $hit -or $hit -notlike ('*'+$error+'*')){throw ('fixture_missing_refusal:'+ $name +':'+$hit)}
 Passed $name
}
function Copy-Fake($v){($v|ConvertTo-Json -Depth 20 -Compress)|ConvertFrom-Json -AsHashtable -DateKind String}
$id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
$root='C:\owner\project'
$rollout='C:\owner\.codex\sessions\2026\11\07\rollout-'+$id+'.jsonl'
$exe='C:\standalone\current\bin\codex.exe'
$release='C:\standalone\releases\v0.166.0\bin\codex.exe'
$sha='a'*64
$meta=@{type='session_meta';payload=@{id=$id;source='vscode';cwd=$root}}
$process=@{ProcessId=27204;ExecutablePath=$release;CommandLine=('"'+$exe+'" --no-daemon resume '+$id);
 CreationDate=([DateTime]'2026-11-04T18:04:58.6249760Z')}
$e=@{schemaVersion=1;kind='aicc-recovered-cli-transport';threadId=$id;projectRoot=$root;rollout=$rollout;
 metaSha256=$sha;codexExecutable=$exe;codexSha256=$sha;signerThumbprint=('A'*40);ownerPid=27204;
 ownerCreatedAt=$process.CreationDate.ToUniversalTime().ToString('o');resumeArgs=@('--no-daemon','resume',$id);
 commandLineSha256=(GroupInstall-HashText $process.CommandLine)}
GroupInstall-CheckRecoveredFacts $meta $e $process $id $root $rollout $sha $exe $sha $release
Passed 'original vscode session + exact restored no-daemon CLI accepted'
$m=Copy-Fake $meta;$m.payload.source='cli'
Refused 'native CLI label cannot masquerade as recovery' {GroupInstall-CheckRecoveredFacts $m $e $process $id $root $rollout $sha $exe $sha $release} 'recovered_cli_evidence_binding_changed'
$m=Copy-Fake $meta;$m.payload.source=@{subagent='other'}
Refused 'subagent rejected' {GroupInstall-CheckRecoveredFacts $m $e $process $id $root $rollout $sha $exe $sha $release} 'recovered_cli_evidence_binding_changed'
$m=Copy-Fake $meta;$m.payload.cwd='C:\other'
Refused 'foreign root rejected' {GroupInstall-CheckRecoveredFacts $m $e $process $id $root $rollout $sha $exe $sha $release} 'recovered_cli_evidence_binding_changed'
$t=Copy-Fake $e;$t.metaSha256=('b'*64)
Refused 'metadata SHA drift rejected' {GroupInstall-CheckRecoveredFacts $meta $t $process $id $root $rollout $sha $exe $sha $release} 'recovered_cli_evidence_binding_changed'
$t=Copy-Fake $e;$t.signerThumbprint=''
Refused 'unknown signer rejected' {GroupInstall-CheckRecoveredFacts $meta $t $process $id $root $rollout $sha $exe $sha $release} 'recovered_cli_evidence_binding_changed'
$t=Copy-Fake $e;$t.ownerPid=12345
Refused 'PID swap rejected' {GroupInstall-CheckRecoveredFacts $meta $t $process $id $root $rollout $sha $exe $sha $release} 'recovered_cli_evidence_binding_changed'
$t=Copy-Fake $e;$t.ownerCreatedAt='2026-11-06T18:04:58Z'
Refused 'PID creation mismatch rejected' {GroupInstall-CheckRecoveredFacts $meta $t $process $id $root $rollout $sha $exe $sha $release} 'recovered_cli_process_creation_changed'
$t=Copy-Fake $process;$t.ExecutablePath='C:\unknown\codex.exe'
Refused 'foreign executable refused' {GroupInstall-CheckRecoveredFacts $meta $e $t $id $root $rollout $sha $exe $sha $release} 'recovered_cli_process_binary_changed'
$t=Copy-Fake $process;$t.CreationDate=$process.CreationDate;$t.CommandLine=('"'+$exe+'" --no-daemon exec resume '+$id)
Refused 'exec-resume is not exact no-daemon resume' {GroupInstall-CheckRecoveredFacts $meta $e $t $id $root $rollout $sha $exe $sha $release} 'recovered_cli_exact_no_daemon_resume_required'
$t=Copy-Fake $process;$t.CreationDate=$process.CreationDate;$t.CommandLine=('"'+$exe+'" --no-daemon resume '+$id+' --extra')
Refused 'additional executable arguments refused' {GroupInstall-CheckRecoveredFacts $meta $e $t $id $root $rollout $sha $exe $sha $release} 'recovered_cli_exact_no_daemon_resume_required'
$t=Copy-Fake $e;$t.commandLineSha256=('c'*64)
Refused 'command SHA mismatch refused' {GroupInstall-CheckRecoveredFacts $meta $t $process $id $root $rollout $sha $exe $sha $release} 'recovered_cli_command_line_changed'
$state=Join-Path $PSScriptRoot ('g1-recovered-fake-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $state 'requests') -Force|Out-Null
try{
 $attempt='12345678-1234-4234-8234-123456789abc'
 $queue=@{id=$attempt;threadId=$id;state='QUEUE_ACCEPTED';automaticReplay=$false}
 $receiptFile=Join-Path (Join-Path $state 'requests') ($attempt+'.json')
 [IO.File]::WriteAllText($receiptFile,($queue|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 $digest=& $script:PinModule {param($v)Get-PinValueDigest $v} -v $queue
 $proof=@{threadId=$id;attemptId=$attempt;queueSha256=$digest;receiptFile=$receiptFile;receiptSha256=(Maintenance-Hash $receiptFile)}
 $plan=@{stateRoot=$state;preservedQueues=@($proof)}
 $receipt=@{preservedQueues=@($proof)}
 $before=@{threads=@{$id=@{attempt=$null;groupEvent=$null;queueAttempt=$queue}}}
 $current=Copy-Fake $before
 GroupInstall-AssertHistoricalQueueCas $plan $receipt $before $current
 Passed 'original identical historical queue and receipt accepted for stopped rollback'
 $current=Copy-Fake $before;$current.threads[$id].queueAttempt.id='ffffffff-ffff-4fff-8fff-ffffffffffff'
 Refused 'historical queue mutation rejected' {GroupInstall-AssertHistoricalQueueCas $plan $receipt $before $current} 'group_rollback_queue_changed'
 $current=Copy-Fake $before;$current.threads[$id].attempt=@{id='new-claim'}
 Refused 'new claim rejected' {GroupInstall-AssertHistoricalQueueCas $plan $receipt $before $current} 'group_rollback_new_claim_or_group_event'
 $current=Copy-Fake $before;$current.threads[$id].groupEvent=@{state='ENQUEUED'}
 Refused 'new group event rejected' {GroupInstall-AssertHistoricalQueueCas $plan $receipt $before $current} 'group_rollback_new_claim_or_group_event'
 $current=Copy-Fake $before;$current.threads['ffffffff-ffff-4fff-8fff-ffffffffffff']=@{queueAttempt=@{id='new-unsealed'}}
 Refused 'unsealed queue rejected' {GroupInstall-AssertHistoricalQueueCas $plan $receipt $before $current} 'group_rollback_queue_changed'
 [IO.File]::AppendAllText($receiptFile,'altered')
 Refused 'receipt SHA drift rejected' {GroupInstall-AssertHistoricalQueueCas $plan $receipt $before $before} 'group_installer_file_changed'
 GroupInstall-AssertNoGroupMarkers $state
 Passed 'no claim markers preserves stopped rollback'
 $claims=Join-Path $state 'group-claims';New-Item -ItemType Directory -Path $claims|Out-Null
 $claim=Join-Path $claims 'orphan.json';[IO.File]::WriteAllText($claim,'{}')
 Refused 'unregistered claim marker rejected' {GroupInstall-AssertNoGroupMarkers $state} 'group_unsettled_marker_preserved'
 Remove-Item -LiteralPath $claim
 $events=Join-Path $state 'group-events';New-Item -ItemType Directory -Path $events|Out-Null
 $marker=Join-Path $events 'orphan.json';[IO.File]::WriteAllText($marker,'{}')
 Refused 'unregistered group event marker rejected' {GroupInstall-AssertNoGroupMarkers $state} 'group_unsettled_marker_preserved'
 $taskXml='<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>old</Command><Arguments>old</Arguments><WorkingDirectory>old</WorkingDirectory></Exec></Actions></Task>'
 $disabled=[xml](GroupInstall-TaskXml $taskXml 'C:\example\worker.hidden.vbs' 'C:\example\release' 'C:\Windows\System32\wscript.exe')
 if($disabled.Task.Settings.Enabled -cne 'false'){throw 'stopped_task_not_disabled'}
 Passed 'stopped task XML is disabled regardless of prior Ready state'
 Refused 'task XML lacking Enabled cannot bypass disable' {GroupInstall-TaskXml '<Task><Actions><Exec><Command>x</Command><Arguments>x</Arguments><WorkingDirectory>x</WorkingDirectory></Exec></Actions></Task>' 'vbs' 'release' 'wscript'} 'task_enabled_preimage_required'
}finally{
 if(Test-Path -LiteralPath $state){Remove-Item -LiteralPath $state -Recurse -Force}
}
Write-Output ('G1_RECOVERED_OWNER_FAKE_PASS='+$pass)
