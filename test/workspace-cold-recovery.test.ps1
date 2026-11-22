#requires -Version 7.5
$ErrorActionPreference='Stop'
$scriptPath=Join-Path $PSScriptRoot '../tools/platform/workspace-mcp/Repair-AiccWorkspaceRuntime.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Recovery script parse failed'}
foreach($name in @('Same','Plain','Assert-FrozenUnknown','Assert-EmptyRecoveryState','Assert-UnchangedConsumedInstall','Assert-QueueConsumedBinding')){
 $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false)
 if(!$node){throw 'Recovery contract function missing'}
 . ([ScriptBlock]::Create($node.Extent.Text))
}
$call=@{callId='11111111-1111-1111-1111-111111111111';requestHash=('a'*64);provider='workspace';tool='aicc_workspace_apply_patch';phase='unknown';readOnly=$false}
function Fixture { @{initialized=$true;closed=$true;phase='DRAINING';fault=$null;providers=@{workspace=@{active=0;unknown=1;reconnecting=0};native=@{active=0;unknown=0;reconnecting=0};host=@{active=0;unknown=0;reconnecting=0}};calls=@($call.Clone());unknown=@($call.Clone())} }
if((Plain $scriptPath.Replace('\','/')) -ine (Resolve-Path -LiteralPath $scriptPath).Path){throw 'Canonical Windows file identity changed'}
$state=Fixture;$before=$state|ConvertTo-Json -Depth 10 -Compress
$accepted=Assert-FrozenUnknown $state $call.callId $call.requestHash
if(!(Same $accepted $call) -or ($state|ConvertTo-Json -Depth 10 -Compress) -cne $before){throw 'Unknown was not preserved verbatim'}
$checks=[Collections.Generic.List[string]]::new();$checks.Add('accept_exact_closed_unknown_without_mutation')
foreach($case in @('active','reconnecting','other-provider-unknown','extra-call','wrong-request','read-only','open','fault','unknown-counter-type')){
 $s=Fixture;$expected=$call.requestHash
 switch($case){
  'active' {$s.providers.workspace.active=1}
  'reconnecting' {$s.providers.host.reconnecting=1}
  'other-provider-unknown' {$s.providers.native.unknown=1}
  'extra-call' {$s.calls+=@($call.Clone())}
  'wrong-request' {$expected='b'*64}
  'read-only' {$s.calls[0].readOnly=$true;$s.unknown[0].readOnly=$true}
  'open' {$s.closed=$false}
  'fault' {$s.fault='unconfirmed'}
  'unknown-counter-type' {$s.providers.workspace.unknown='1'}
 }
 $rejected=$false
 try{$null=Assert-FrozenUnknown $s $call.callId $expected}catch{$rejected=$true}
 if(!$rejected){throw "Unsafe recovery accepted: $case"}
 $checks.Add($case)
}
$empty=@{initialized=$true;closed=$false;phase='OPEN';operation=$null;fault=$null;providers=@{workspace=@{active=0;unknown=0;reconnecting=0};native=@{active=0;unknown=0;reconnecting=0};host=@{active=0;unknown=0;reconnecting=0}};calls=@();unknown=@()}
Assert-EmptyRecoveryState $empty
$checks.Add('empty_open_prepare')
$plan=@{request_id='fixture';challenge='nonce';expires_at='2030-01-01T00:00:00.000Z';gatewayIdentity=@{pid=42}}
$drain=$empty.Clone();$drain.closed=$true;$drain.phase='CONSUMED';$drain.expired=$false;$drain.consumedSnapshotSha256='a'*64;$drain.identity=$plan.gatewayIdentity;$drain.operation=@{operationId='fixture';nonce='nonce';operationExpiresAt=$plan.expires_at}
Assert-EmptyRecoveryState $drain $plan
$checks.Add('empty_exact_consumed_apply')
foreach($case in @('not-consumed','expired','wrong-nonce','wrong-generation','unknown','active','missing-counter','unconfirmed-counter')){
 $s=($drain|ConvertTo-Json -Depth 12)|ConvertFrom-Json -AsHashtable -DateKind String
 switch($case){
  'not-consumed' {$s.phase='DRAINING'}
  'expired' {$s.expired=$true}
  'wrong-nonce' {$s.operation.nonce='changed'}
  'wrong-generation' {$s.identity.pid=43}
  'unknown' {$s.unknown=@($call)}
  'active' {$s.providers.workspace.active=1}
  'missing-counter' {$s.providers.workspace.Remove('reconnecting')}
  'unconfirmed-counter' {$s.providers.native.unknown='0'}
 }
 $rejected=$false;try{Assert-EmptyRecoveryState $s $plan}catch{$rejected=$true}
 if(!$rejected){throw "Unsafe empty recovery accepted: $case"};$checks.Add($case)
}
$drain.identity=@{gateway=@{pid=42}}
$failed=@{changeKind='host-runtime-update';request_id=$plan.request_id;challenge=$plan.challenge;expires_at=$plan.expires_at;ownership=@{processes=@(@{pid=42})}}
$journal=@{phase='PREPARED';startAttempts=0;rollbackStartAttempts=0}
$failure=@{phase='PREPARED';error='Runtime ownership changed'}
Assert-UnchangedConsumedInstall $drain $failed $journal $failure
$checks.Add('consumed_unchanged_install_recovery')
foreach($kind in @('workspace-gpt-queue-update','workspace-gpt-queue-owner-replacement')){
 $q=$failed.Clone();$q.changeKind=$kind
 Assert-UnchangedConsumedInstall $drain $q $journal @{phase='PREPARED';error='QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN'}
 $checks.Add('consumed_queue_refusal_recovery-'+$kind)
 foreach($case in @('started','stopped','unknown','active','wrong-error','wrong-kind','wrong-operation','expired')){
  $f=($q|ConvertTo-Json -Depth 12)|ConvertFrom-Json -AsHashtable -DateKind String
  $j=$journal.Clone();$e=@{phase='PREPARED';error='QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN'}
  $s=($drain|ConvertTo-Json -Depth 12)|ConvertFrom-Json -AsHashtable -DateKind String
  switch($case){
   'started' {$j.startAttempts=1}
   'stopped' {$j.phase='STOPPED'}
   'unknown' {$s.unknown=@($call)}
   'active' {$s.providers.workspace.active=1}
   'wrong-error' {$e.error='QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN'}
   'wrong-kind' {$f.changeKind='unreviewed'}
   'wrong-operation' {$f.request_id='other'}
   'expired' {$s.expired=$true}
  }
  $rejected=$false;try{Assert-UnchangedConsumedInstall $s $f $j $e}catch{$rejected=$true}
  if(!$rejected){throw "Unsafe queue refusal recovery accepted: $case"}
  $checks.Add('queue-refusal-'+$kind+'-'+$case)
 }
}
foreach($case in @('started','stopped','rollback-started','wrong-error','wrong-owner-gateway','wrong-operation','unknown','active','wrong-phase','expired')){
 $f=($failed|ConvertTo-Json -Depth 12)|ConvertFrom-Json -AsHashtable -DateKind String
 $j=$journal.Clone();$e=$failure.Clone();$s=($drain|ConvertTo-Json -Depth 12)|ConvertFrom-Json -AsHashtable -DateKind String
 switch($case){
  'started' {$j.startAttempts=1}
  'stopped' {$j.phase='STOPPED'}
  'rollback-started' {$j.rollbackStartAttempts=1}
  'wrong-error' {$e.error='unconfirmed'}
  'wrong-owner-gateway' {$f.ownership.processes[0].pid=99}
  'wrong-operation' {$f.request_id='other'}
  'unknown' {$s.unknown=@($call)}
  'active' {$s.providers.workspace.active=1}
  'wrong-phase' {$s.phase='DRAINING'}
  'expired' {$s.expired=$true}
 }
 $rejected=$false;try{Assert-UnchangedConsumedInstall $s $f $j $e}catch{$rejected=$true}
 if(!$rejected){throw "Unsafe consumed install recovery accepted: $case"};$checks.Add('consumed-'+$case)
}
$queue=@{kind='webgpt-queue-native-deployment/v1';ownerTaskId=$env:CODEX_THREAD_ID;enginePlanSha256=('a'*64);operationId=$plan.request_id;challenge=$plan.challenge;expiresAt=$plan.expires_at}
$engine=@{operationId='engine';before=@{ledgerSha256=('b'*64);configSha256=('c'*64)};candidateSha256=('d'*64)}
$applied=@{status='APPLIED_RUNTIME_UNOBSERVED';ledgerPreserved=$true;planSha256=('a'*64);operationId='engine';after=@{ledgerSha256=('b'*64);configSha256=('c'*64);executableSha256=('d'*64)}}
Assert-QueueConsumedBinding $drain $queue $engine $applied
$checks.Add('queue_success_exact_consumed_recovery')
foreach($case in @('wrong-owner','wrong-plan','ledger-changed','config-changed','binary-changed','unconfirmed-apply','expired-deployment','wrong-nonce','unknown','active')){
 $q=($queue|ConvertTo-Json -Depth 12)|ConvertFrom-Json -AsHashtable -DateKind String
 $a=($applied|ConvertTo-Json -Depth 12)|ConvertFrom-Json -AsHashtable -DateKind String
 $s=($drain|ConvertTo-Json -Depth 12)|ConvertFrom-Json -AsHashtable -DateKind String
 switch($case){
  'wrong-owner' {$q.ownerTaskId='other'}
  'wrong-plan' {$a.planSha256='f'*64}
  'ledger-changed' {$a.after.ledgerSha256='f'*64}
  'config-changed' {$a.after.configSha256='f'*64}
  'binary-changed' {$a.after.executableSha256='f'*64}
  'unconfirmed-apply' {$a.status='UNKNOWN'}
  'expired-deployment' {$q.expiresAt='2000-01-01T00:00:00.000Z'}
  'wrong-nonce' {$s.operation.nonce='other'}
  'unknown' {$s.unknown=@($call)}
  'active' {$s.providers.host.active=1}
 }
 $rejected=$false;try{Assert-QueueConsumedBinding $s $q $engine $a}catch{$rejected=$true}
 if(!$rejected){throw "Unsafe queue consumed recovery accepted: $case"};$checks.Add('queue-'+$case)
}
@{status='PASS';checks=@($checks);serviceMutations=0;unknownRewritten=$false}|ConvertTo-Json -Compress
