param([string]$OperationId=('test-mailbox-'+[Guid]::NewGuid().ToString('N')))
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($OperationId -notmatch '^test-mailbox-[0-9a-f]{32}$'){throw 'Dedicated test operation required'}
$cli=Join-Path $PSScriptRoot 'Invoke-AiccFileMessage.ps1'
$nonce=[Guid]::NewGuid().ToString('N')
$root=Join-Path $env:USERPROFILE ('.ai-control-center\control-plane\file-mailboxes\'+$OperationId)
$checks=[Collections.Generic.List[string]]::new()
& $cli -Action Init -OperationId $OperationId -Nonce $nonce | Out-Null
$body=Join-Path $root 'codex\fixture.md'
[IO.File]::WriteAllText($body,"한글 메시지`nimmutable fixture",[Text.UTF8Encoding]::new($false))
$first=& $cli -Action Send -OperationId $OperationId -Nonce $nonce -Role codex -BodyPath $body -MessageId fixture-1 | ConvertFrom-Json
if($first.state -ne 'DELIVERED'){throw 'First send failed'}
$checks.Add('first-message-delivered')
$repeat=& $cli -Action Send -OperationId $OperationId -Nonce $nonce -Role codex -BodyPath $body -MessageId fixture-1 | ConvertFrom-Json
if($repeat.state -ne 'ALREADY_DELIVERED'){throw 'Idempotent send failed'}
$checks.Add('exact-repeat-is-idempotent')
$peer=@(& $cli -Action Read -OperationId $OperationId -Nonce $nonce -Role webgpt | ConvertFrom-Json)
if($peer.Count -ne 1 -or $peer[0].body -cne [IO.File]::ReadAllText($body)){throw 'UTF8 peer read failed'}
$checks.Add('utf8-korean-peer-read')
$reply=Join-Path $root 'webgpt\fixture-ack.md'
[IO.File]::WriteAllText($reply,'FIXTURE ACK ONLY',[Text.UTF8Encoding]::new($false))
$ack=& $cli -Action Send -OperationId $OperationId -Nonce $nonce -Role webgpt -BodyPath $reply -MessageId fixture-ack -ReplyTo fixture-1 -ReplySha256 $first.sha256 | ConvertFrom-Json
if($ack.state -ne 'DELIVERED'){throw 'Linked fixture ACK failed'}
$checks.Add('ack-links-exact-id-and-hash')
$peer=@(& $cli -Action Read -OperationId $OperationId -Nonce $nonce -Role codex | ConvertFrom-Json)
if($peer.Count -ne 1 -or $peer[0].replySha256 -cne $first.sha256){throw 'ACK roundtrip failed'}
$checks.Add('two-logical-outboxes-roundtrip')
$originalHash=(Get-FileHash -LiteralPath (Join-Path $root 'codex\fixture-1.json')).Hash
[IO.File]::WriteAllText($body,'DIFFERENT FIXTURE',[Text.UTF8Encoding]::new($false))
$refused=$false
try{& $cli -Action Send -OperationId $OperationId -Nonce $nonce -Role codex -BodyPath $body -MessageId fixture-1 | Out-Null}catch{$refused=$_.Exception.Message -like '*conflict*'}
if(-not $refused -or (Get-FileHash -LiteralPath (Join-Path $root 'codex\fixture-1.json')).Hash -cne $originalHash){throw 'Conflict overwrote original'}
$checks.Add('conflicting-id-refused-original-preserved')
$refused=$false
try{& $cli -Action Read -OperationId $OperationId -Nonce ([Guid]::NewGuid().ToString('N')) -Role codex | Out-Null}catch{$refused=$_.Exception.Message -like '*identity*'}
if(-not $refused){throw 'Foreign nonce accepted'}
$checks.Add('wrong-operation-nonce-refused')
[pscustomobject]@{status='PASS';scope='isolated-file-mailbox';operationId=$OperationId;artifactRoot=$root;logicalRolesOnly=$true;checks=$checks.ToArray()}|ConvertTo-Json -Depth 4 -Compress
