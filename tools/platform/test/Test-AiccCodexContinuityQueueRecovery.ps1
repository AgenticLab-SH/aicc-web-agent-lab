#requires -Version 7.5
$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-queue-recovery-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'requests')|Out-Null
. (Join-Path $PSScriptRoot '../windows/Invoke-AiccCodexContinuity.ps1') -StateRoot $root
$script:codexHome=Join-Path $root 'codex'
$rollout=Join-Path $codexHome 'sessions/queue.jsonl'
New-Item -ItemType Directory -Path (Split-Path -Parent $rollout) -Force|Out-Null
$id='11111111-1111-4111-8111-111111111111';$op='22222222-2222-4222-8222-222222222222'
$turn='33333333-3333-4333-8333-333333333333';$other='44444444-4444-4444-8444-444444444444'
$stamp=[DateTimeOffset]::UtcNow.AddMinutes(-1).ToString('o');$checks=0
function Check($ok,$name){if(-not $ok){throw ('FAIL: '+$name)};$script:checks++}
function Event($payload){@{type='event_msg';timestamp=$stamp;payload=$payload}|ConvertTo-Json -Compress -Depth 9}
$meta=@{type='session_meta';payload=@{id=$id;cwd=$root;source='vscode';originator='Codex Desktop'}}|ConvertTo-Json -Compress
$marker=Event @{type='item_completed';turn_id=$turn;item=@{type='UserMessage';content=@(@{type='text';text=('work'+"`n`nAICC_QUEUE_ATTEMPT:"+$op)})}}
$done=Event @{type='task_complete';turn_id=$turn}
$aborted=Event @{type='turn_aborted';turn_id=$turn}
$neighbour=Event @{type='task_complete';turn_id=$other}
$padding=@{type='response_item';payload=@{type='function_call_output';output=('x'*1100000)}}|ConvertTo-Json -Compress
function Setup([string[]]$rows){
 [IO.File]::WriteAllText($rollout,((@($meta)+$rows)-join "`n")+"`n")
 $script:entry=@{threadId=$id;projectRoot=$root;rollout=$rollout;enabled=$false;state='DISABLED';queueAttempt=@{id=$op;threadId=$id;at=$stamp;marker=('AICC_QUEUE_ATTEMPT:'+$op);messageSha256=(Digest-Text 'work');state='QUEUE_ACCEPTED';automaticReplay=$false};attempt=$null}
}
Setup @($marker,$done,$padding)
Check ((Queue-Progress $entry).state -ceq 'QUEUE_TURN_COMPLETED') 'terminal outside 1MiB tail recovered'
Check (-not(Queue-Progress $entry).goalComplete) 'delivery completion is not goal completion'
Setup @($marker,$neighbour)
Check ((Queue-Progress $entry).pending) 'neighbour terminal cannot settle request'
Setup @($done,$marker)
Check ((Queue-Progress $entry).pending) 'terminal before marker is not accepted'
Setup @($marker,$aborted,$padding)
Check ((Queue-Progress $entry).state -ceq 'QUEUE_TURN_INTERRUPTED') 'interruption exact terminal recovered'
$cfg=@{schemaVersion=1;threads=@{$id=$entry}}
Write-Json $configFile $cfg
Save-QueueProgress $id
$saved=Read-Json $configFile
Check (-not $saved.threads[$id].queueAttempt -and $saved.threads[$id].holdReason -ceq 'QUEUE_TURN_INTERRUPTED') 'interrupted delivery settles with explicit resume hold'
Check ((Read-Json (Join-Path $root ('requests/'+$op+'.json'))).state -ceq 'QUEUE_TURN_INTERRUPTED') 'receipt persisted before registry settlement'
Save-QueueProgress $id
Check ((Read-Json $configFile).threads[$id].lastQueueAttempt.id -ceq $op) 'restart repeated reconciliation is idempotent'
Setup @($marker,$done,$marker.Replace($turn,$other))
Check ((Queue-Progress $entry).observationReason -ceq 'QUEUE_MULTIPLE_TURNS_NO_REPLAY') 'duplicate marker across turns preserves pending'
Setup @($neighbour)
Check ((Queue-Progress $entry).pending) 'missing exact marker preserves historical request'
Setup @($marker.Replace('work','diagnostic quote'),$done)
Check ((Queue-Progress $entry).pending) 'diagnostic marker without original message hash cannot settle'
Setup @($marker,$done,'{"partial":')
Check ((Queue-Progress $entry).pending) 'partially written record preserves pending'
Setup @($marker,$done)
$entry.queueAttempt.threadId=$other
Check ((Queue-Progress $entry).observationReason -ceq 'QUEUE_BINDING_INVALID') 'foreign thread binding rejected'
Setup @($marker,$done)
$entry.queueAttempt.turnId=$other
Check ((Queue-Progress $entry).pending) 'conflicting saved turn rejected'
Setup @($done)
$entry.queueAttempt.turnId=$turn
Check ((Queue-Progress $entry).pending) 'saved turn alone cannot replace original message proof'
Setup @($marker,$done,$aborted)
Check ((Queue-Progress $entry).observationReason -ceq 'QUEUE_TERMINAL_CONFLICT') 'conflicting terminals preserve original pending'
Setup @($marker,$aborted,$done)
Check ((Queue-Progress $entry).pending) 'terminal conflict rejected in either order'
Setup @($marker,$done,$done)
Check (-not(Queue-Progress $entry).pending) 'duplicate identical terminal is idempotent'
Setup @($marker,$done)
[IO.File]::WriteAllText($rollout,([IO.File]::ReadAllText($rollout).Replace($id,$other)))
Check ((Queue-Progress $entry).observationReason -ceq 'QUEUE_ORIGINAL_SCOPE_CHANGED') 'foreign rollout identity rejected'
Setup @($marker,$done)
$entry.projectRoot=Join-Path $root 'foreign'
Check ((Queue-Progress $entry).pending) 'foreign project root rejected'
Setup @($marker,$neighbour)
Write-Json $configFile @{schemaVersion=1;threads=@{$id=$entry}}
Save-QueueProgress $id
Check ((Read-Json $configFile).threads[$id].queueAttempt.turnId -ceq $turn) 'active turn hint persisted before interruption'
Add-Content -LiteralPath $rollout -Value $done -Encoding utf8
Save-QueueProgress $id
$settled=Read-Json $configFile
Check (-not $settled.threads[$id].queueAttempt -and $settled.threads[$id].lastQueueAttempt.state -ceq 'QUEUE_TURN_COMPLETED') 'restart recovers terminal after active observation'
Setup @($marker,$done)
Write-Json $configFile @{schemaVersion=1;threads=@{$id=$entry}}
$proof=Queue-Progress $entry;$null=$proof.Remove('pending')
Write-Json (Join-Path $root ('requests/'+$op+'.json')) $proof
Save-QueueProgress $id
Check (-not(Read-Json $configFile).threads[$id].queueAttempt) 'crash after receipt before registry is reconciled without dispatch'
Setup @($neighbour)
Write-Json $configFile @{schemaVersion=1;threads=@{$id=$entry}}
Save-QueueProgress $id
Check ((Read-Json $configFile).threads[$id].queueAttempt.observationReason -ceq 'QUEUE_EXACT_TURN_NOT_OBSERVED') 'pending reason change survives registry write'
Setup @($marker,$done)
Move-Item -LiteralPath $rollout -Destination ($rollout+'.preserved')
Check ((Queue-Progress $entry).observationReason -ceq 'QUEUE_ORIGINAL_READ_UNAVAILABLE') 'unavailable original never settles'
Move-Item -LiteralPath ($rollout+'.preserved') -Destination $rollout
@{terminal='PASS';checks=$checks;fixture=$root;liveDispatches=0;liveRegistrationsChanged=0}|ConvertTo-Json
