#requires -Version 7.5
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/MobilePublicRecovery.psm1') -Force
$req=@{operationId=[guid]::NewGuid().ToString();nonce=('a'*64);expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(1).ToString('o');stopOperationId=[guid]::NewGuid().ToString()};$hash='b'*64
$c=@{action='probe';operationId=$req.operationId;nonce=$req.nonce;requestSha256=$hash}
$pass=0
Assert-MobileRecoveryCommand $c $req $hash;$pass++
foreach($change in @(@{nonce=('c'*64)},@{operationId=[guid]::NewGuid().ToString()},@{requestSha256=('d'*64)},@{action='execute'},@{command='whoami'},@{action='arm';expectedTaskXmlSha256=('e'*64);stopOperationId=[guid]::NewGuid().ToString()},@{action='restore';expectedTaskXmlSha256=('e'*64);activationReceiptSha256='bad'})){
 $x=$c.Clone();foreach($k in $change.Keys){$x[$k]=$change[$k]};$rejected=$false;try{Assert-MobileRecoveryCommand $x $req $hash}catch{$rejected=$true};if(-not $rejected){throw 'unsafe_signal_accepted'};$pass++
}
$expired=$req.Clone();$expired.expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o');$rejected=$false;try{Assert-MobileRecoveryCommand $c $expired $hash}catch{$rejected=$true};if(-not $rejected){throw 'expired_signal_accepted'};$pass++
$restoreCommand=@{activationReceiptSha256=('f'*64);rollbackOperationId=[guid]::NewGuid().ToString();candidateStopOperationId=[guid]::NewGuid().ToString()}
$args=New-MobileRecoveryRestoreArguments 'C:\fixture\restore.ps1' 'C:\fixture\plan.json' $hash $restoreCommand ('c'*64) 'C:\fixture\ready.json' ('d'*64) $false
if($args -contains '-CandidateStopOperationId' -or $args[-1] -cne '-RestoreStoppedService' -or $args[2] -cne '-File'){throw 'restore_never_started_arguments_changed'};$pass++
$args=New-MobileRecoveryRestoreArguments 'C:\fixture\restore.ps1' 'C:\fixture\plan.json' $hash $restoreCommand ('c'*64) 'C:\fixture\ready.json' ('d'*64) $true
if($args[-2] -cne '-CandidateStopOperationId' -or $args[-1] -cne $restoreCommand.candidateStopOperationId){throw 'restore_candidate_stop_not_bound'};$pass++
$bad=$restoreCommand.Clone();$bad.candidateStopOperationId=[guid]::Empty.ToString();$refused=$false
try{New-MobileRecoveryRestoreArguments 'C:\fixture\restore.ps1' 'C:\fixture\plan.json' $hash $bad ('c'*64) 'C:\fixture\ready.json' ('d'*64) $true|Out-Null}catch{$refused=$true};if(-not $refused){throw 'empty_stop_not_refused'};$pass++
# A fake invocation consumes only structured arguments; never a shell command.
$fakeRunner={param($argv) if($argv[3] -cne 'C:\fixture\restore.ps1' -or $argv -contains '-Command'){throw 'unexpected_transport'};@{exitCode=0;phase='FAKE_RESTORE_RETURNED'}}
$r=& $fakeRunner $args;if($r.exitCode -ne 0){throw 'fake_restore_not_returned'};$pass++
$created=[datetime]::UtcNow;$command='pwsh exact encoded caller script';$commandHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($command))).ToLowerInvariant()
$identity=@{ProcessId=222;CreationDate=$created;CommandLine=$command;ExecutablePath='C:\fixture\pwsh.exe'}
$binding=@{installerPid=222;installerCreatedAt=$created.ToUniversalTime().ToString('o');installerCommandSha256=$commandHash;preflightSha256=('a'*64)}
Assert-MobileRecoveryInstallerIdentity $identity $binding ('a'*64) 'C:\fixture\pwsh.exe';$pass++
foreach($key in @('installerPid','installerCreatedAt','installerCommandSha256','preflightSha256')){$x=$binding.Clone();$x[$key]='changed';$denied=$false;try{Assert-MobileRecoveryInstallerIdentity $identity $x ('a'*64) 'C:\fixture\pwsh.exe'}catch{$denied=$true};if(-not $denied){throw 'installer_identity_change_accepted'};$pass++}
@{passed=$pass;failed=0;scope='new recovery signal contract only; no service/model/task changes';synthetic=$true}|ConvertTo-Json