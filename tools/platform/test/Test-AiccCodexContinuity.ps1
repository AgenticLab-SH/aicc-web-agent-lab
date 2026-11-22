#requires -Version 7.5
$ErrorActionPreference='Stop'
$helper=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\windows\Invoke-AiccCodexContinuity.ps1'))
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('aicc-continuity-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture|Out-Null
. $helper -StateRoot $fixture
$script:checks=0
function Check($condition,[string]$label){if(-not $condition){throw ('FAIL: '+$label)};$script:checks++}
$id='11111111-1111-4111-8111-111111111111'
$script:codexHome=Join-Path $fixture 'codex-home'
$rollout=Join-Path $codexHome 'sessions\rollout.jsonl'
New-Item -ItemType Directory -Path (Split-Path -Parent $rollout) -Force|Out-Null
$stamp=[DateTimeOffset]::UtcNow.AddSeconds(-60).ToString('o')
$meta=@{type='session_meta';payload=@{id=$id;cwd=$fixture;originator='Codex Desktop';source='vscode'}}
$terminal=@{type='event_msg';timestamp=$stamp;payload=@{type='task_complete';last_agent_message=('AICC_CONTINUITY_HOLD:'+$id+':REQUIRED_EXTERNAL_ACTION')}}
function Save-Rollout { [IO.File]::WriteAllText($rollout,($meta|ConvertTo-Json -Compress)+"`n"+($terminal|ConvertTo-Json -Depth 8 -Compress)+"`n") }
Save-Rollout
$entry=@{threadId=$id;projectRoot=$fixture;rollout=$rollout;enabled=$false;state='REQUIRED_ACTION_HOLD';holdReason='REQUIRED_EXTERNAL_ACTION';attempt=$null}
$config=@{schemaVersion=1;protocolVersion=3;helperSha256=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant();threads=@{};excludedThreadIds=@();worker=$null}
$config.threads[$id]=$entry
Write-Json $configFile $config
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'parser'
$actionBlock=$ast.EndBlock.Statements|Where-Object {$_.Extent.Text.StartsWith("if(`$Action -ne 'Worker')")}|Select-Object -First 1
$invoke=[scriptblock]::Create($actionBlock.Extent.Text)
function Invoke-Action([string]$name,[string]$expected=$null){$script:Action=$name;$script:ThreadId=$id;$script:ExpectedTerminalSha256=$expected;& $invoke | Out-Null}
Invoke-Action 'Enable'
$saved=Read-Json $configFile
Check ($saved.threads[$id].enabled -and $saved.threads[$id].holdReason -eq 'REQUIRED_EXTERNAL_ACTION') 'Enable preserves explicit HOLD'
$before=(Terminal-Evidence $saved.threads[$id]).sha256
Invoke-Action 'Resume' $before
$saved=Read-Json $configFile
Check ((Terminal-Evidence $saved.threads[$id]).state -eq 'TERMINAL') 'same displayed HOLD authorized once'
$terminal.timestamp=[DateTimeOffset]::UtcNow.ToString('o');Save-Rollout
Check ((Terminal-Evidence $saved.threads[$id]).state -eq 'REQUIRED_ACTION_HOLD') 'new HOLD is not bypassed'
try{Invoke-Action 'Resume' $before;throw 'expected rejection'}catch{Check ($_.Exception.Message -match 'displayed_terminal_changed') 'stale preview rejected'}
Check ((Thread-Surface $meta.payload) -eq 'desktop') 'Desktop classified'
Check ((Thread-Surface @{source=@{subagent=@{}};originator='Codex Desktop'}) -eq 'subagent') 'subagent excluded'
Check ((Thread-Owner $saved.threads[$id]) -eq 'DESKTOP_APP_TRANSPORT_REQUIRED') 'Desktop never dispatched by CLI'
$terminal.payload=@{type='task_started'};Save-Rollout
$entry=$saved.threads[$id];$entry.lastTerminal='turn.failed';$entry.failureKind='QUOTA_WAIT';$entry.lastTerminalAt=[DateTimeOffset]::UtcNow.AddSeconds(1).ToString('o')
Check ((Terminal-Evidence $entry).quotaTerminal -eq $true) 'known quota terminal preserves queue'
$entry.failureKind=$null
Check ((Terminal-Evidence $entry).state -eq 'INTERRUPTED_TURN_HOLD') 'unknown interrupted outcome preserved'
function Get-PoolReadiness($cfg){@{state='READY';quotaFresh=$true}}
$config.threads[$id].holdReason=$null;$config.threads[$id].enabled=$true;Write-Json $configFile $config
$script:SenderThreadId='22222222-2222-4222-8222-222222222222'
$priorTurn='33333333-3333-4333-8333-333333333333'
$proof=@{schemaVersion=1;source='codex-app.read_thread';observedAt=[DateTimeOffset]::UtcNow.ToString('o');threadId=$id;projectRoot=$fixture;status='idle';turnId=$priorTurn;turnStatus='failed';errorCode='usage_limit_reached';targetRoute=@{source='codex-app.read_thread';provider='ocx';threadId=$id;turnId=$priorTurn;projectRoot=$fixture;observedAt=[DateTimeOffset]::UtcNow.ToString('o');responseSha256=('c'*64)}}
$script:EvidenceFile=Join-Path $fixture 'proof.json';Write-Json $EvidenceFile $proof
Invoke-Action 'DesktopClaim'
$saved=Read-Json $configFile;$script:AttemptId=$saved.threads[$id].attempt.id
Check ($AttemptId -and $saved.threads[$id].attempt.state -eq 'CLAIMED_NO_ACK') 'claim persisted before external send'
try{Invoke-Action 'DesktopClaim';throw 'expected rejection'}catch{Check ($_.Exception.Message -match 'enabled_unclaimed') 'unknown claim is never replayed'}
$ack=@{schemaVersion=1;source='codex-app.send_message_to_thread';threadId=$id;attemptId=$AttemptId;accepted=$true;responseSha256=('a'*64)};Write-Json $EvidenceFile $ack;Invoke-Action 'DesktopAck'
Check ((Read-Json $configFile).threads[$id].attempt.state -eq 'ACKNOWLEDGED') 'ACK is not completion'
$proof.continuityAttemptId=$AttemptId;$proof.turnId='44444444-4444-4444-8444-444444444444';$proof.markerTurnId=$proof.turnId;$proof.attemptMarker=('AICC_CONTINUITY_ATTEMPT:'+$AttemptId);$proof.turnStatus='failed';Write-Json $EvidenceFile $proof;Invoke-Action 'DesktopObserve'
$saved=Read-Json $configFile
Check ($saved.threads[$id].enabled -and -not $saved.threads[$id].attempt -and $saved.threads[$id].state -eq 'QUOTA_WAIT') 'known failed quota turn keeps opt-in and releases only exact attempt'
$order=Queue-Order @(@{threadId='a';lastDispatchAt='2026-10-15T01:00:00Z'},@{threadId='b';lastDispatchAt=$null},@{threadId='c';lastDispatchAt='2026-10-14T01:00:00Z'})
Check (($order.threadId -join ',') -eq 'b,c,a') 'never dispatched then oldest dispatched fairness'
$terminal.payload=@{type='task_complete';last_agent_message=('AICC_CONTINUITY_COMPLETE:'+$id)};Save-Rollout
$proof.turnStatus='completed';$proof.targetRoute.turnId=$proof.turnId;Write-Json $EvidenceFile $proof
try{Invoke-Action 'DesktopClaim';throw 'expected rejection'}catch{Check ($_.Exception.Message -match 'completed_goal_preserved') 'completed exact goal is not resumed'}
$config.helperSha256='b'*64;Write-Json $configFile $config
try{Invoke-Action 'Enable';throw 'expected rejection'}catch{Check ($_.Exception.Message -match 'protocol_or_helper_pin_mismatch') 'mismatched tray helper refused'}
Invoke-Action 'Disable'
Check (-not (Read-Json $configFile).threads[$id].enabled) 'Disable remains available on helper mismatch'
$saved=Read-Json $configFile;$saved.helperSha256=(Helper-Identity).helperSha256;Write-Json $configFile $saved
$proof.status='active';$proof.turnStatus='inProgress';$proof.heartbeatAutomationId='selected-root-heartbeat';Write-Json $EvidenceFile $proof
Invoke-Action 'DesktopHeartbeatObserve'
$saved=Read-Json $configFile
Check ($saved.threads[$id].lastNativeHeartbeat.turnId -eq $proof.turnId -and -not $saved.threads[$id].attempt -and -not $saved.threads[$id].enabled) 'native heartbeat observation creates no self dispatch or enable'
$script:codexHome=Join-Path $fixture 'codex-home'
$d=Get-Date;$today=Join-Path $codexHome 'sessions' $d.Year.ToString('0000') $d.Month.ToString('00') $d.Day.ToString('00');New-Item -ItemType Directory -Path $today -Force|Out-Null
$candidateId='22222222-2222-4222-8222-222222222222';$meta.payload.id=$candidateId
$candidateFile=Join-Path $today ('rollout-'+$candidateId+'_resumed-turn.jsonl');[IO.File]::WriteAllText($candidateFile,($meta|ConvertTo-Json -Compress)+"`n")
Check (@(Recent-Candidates $saved|Where-Object threadId -eq $candidateId).Count -eq 1) 'date folder and resumed suffix discover Desktop candidate'
@{terminal='PASS';checks=$checks;fixture=$fixture;liveDispatches=0;liveRegistrationsChanged=0}|ConvertTo-Json
