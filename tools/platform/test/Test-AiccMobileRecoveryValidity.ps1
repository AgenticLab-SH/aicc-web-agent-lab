#requires -Version 7.5
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '../windows/Restore-AiccMobilePublicRuntime.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $source),[ref]$tokens,[ref]$errors)
if($errors){throw 'restore_parse_failed'}
# Exercise the actual verifier/lock/freshness functions, with only temporary files.
foreach($name in @('Within','Regular','Hash','Json','HoldFile','LockedHash','AssertReleaseEntries','CheckRelease','AssertFreshRollbackReady')){
 $node=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
 . ([scriptblock]::Create($node.Extent.Text))
}
$add=$ast.Find({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Add-Type'},$true)
. ([scriptblock]::Create($add.Extent.Text))
$pass=0;$checks=[Collections.Generic.List[string]]::new()
function Pass($n){$script:pass++;$checks.Add($n)}
function Refuses($body,$n){$denied=$false;try{& $body}catch{$denied=$true};if(-not $denied){throw "expected_rejection:$n"};Pass $n}
$now=[DateTimeOffset]::Parse('2026-11-04T02:00:00+09:00')
$expected=@{operationId=[guid]::NewGuid().ToString();planSha256=('a'*64);taskXmlSha256=('b'*64);rollbackOperationId=[guid]::NewGuid().ToString();activationReceiptSha256=('c'*64)}
$ready=$expected.Clone();$ready.schemaVersion=1;$ready.status='READY';$ready.independent=$true;$ready.target='AgenticLab-AICC-Mobile-Public-Control';$ready.recoveryAction='restore-exact-task-after-normal-stop';$ready.executorId='fixture:independent';$ready.observedAt=$now.ToString('o');$ready.expiresAt=$now.AddSeconds(120).ToString('o')
Refuses {AssertFreshRollbackReady $ready $expected $now.AddSeconds(845)} 'old READY before 845s verification expires'
$fresh=$ready.Clone();$fresh.observedAt=$now.AddSeconds(845).ToString('o');$fresh.expiresAt=$now.AddSeconds(965).ToString('o')
AssertFreshRollbackReady $fresh $expected $now.AddSeconds(846);Pass '845s verification then fresh READY accepted'
foreach($k in @('operationId','planSha256','taskXmlSha256','rollbackOperationId','activationReceiptSha256')){$bad=$fresh.Clone();$bad[$k]='changed';Refuses {AssertFreshRollbackReady $bad $expected $now.AddSeconds(846)} "changed $k denied"}
Refuses {AssertFreshRollbackReady $fresh $expected $now.AddSeconds(966)} 'expiry unchanged'
Import-Module (Join-Path $PSScriptRoot '../windows/MobilePublicRecovery.psm1') -Force
$created=[datetime]::UtcNow;$command='fixture exact restore';$exe='C:\fixture\pwsh.exe'
$process=@{ProcessId=42;CreationDate=$created;CommandLine=$command;ExecutablePath=$exe}
$pre=@{state='RELEASES_LOCKED_WAITING_FOR_FRESH_RECOVERY';planSha256=('a'*64);restorePid=42;restoreCreatedAt=$created.ToUniversalTime().ToString('o');restoreCommandSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($command))).ToLowerInvariant();restoreExecutable=$exe}
Assert-MobileRecoveryRestoreIdentity $process $pre ('a'*64) $exe;Pass 'actual locked restore identity accepted'
$roundtrip=$pre|ConvertTo-Json|ConvertFrom-Json -AsHashtable -DateKind String
Assert-MobileRecoveryRestoreIdentity $process $roundtrip ('a'*64) $exe;Pass 'JSON preserves exact creation timestamp identity'
foreach($key in @('restorePid','restoreCreatedAt','restoreCommandSha256','planSha256','restoreExecutable')){$bad=$pre.Clone();$bad[$key]='changed';Refuses {Assert-MobileRecoveryRestoreIdentity $process $bad ('a'*64) $exe} "different restore $key denied"}
$owner=Join-Path ([IO.Path]::GetTempPath()) ('aicc-recovery-validity-'+[guid]::NewGuid().ToString('N'))
$root=Join-Path $owner 'releases/cli/fixture';$null=New-Item -ItemType Directory -Path $root
$held=[Collections.Generic.List[IDisposable]]::new();$lockedFiles=@{};$lockedDirectories=@{};$releaseSets=[Collections.Generic.List[object]]::new()
try{
 $file=Join-Path $root 'entry.txt';[IO.File]::WriteAllText($file,'original');$node=Join-Path $owner 'fake-node.exe';[IO.File]::WriteAllText($node,'fixture')
 $mf=Join-Path $root '.aicc-release.json';$pin=@{path='entry.txt';sha256=Hash $file;size=(Get-Item -LiteralPath $file).Length}
 [IO.File]::WriteAllText($mf,(@{schemaVersion=1;component='mobile-public-control';files=@($pin)}|ConvertTo-Json -Depth 5))
 $cfg=@{releaseRoot=$root;releaseManifestSha256=Hash $mf;nodeExecutable=$node;nodeSha256=Hash $node}
 CheckRelease $cfg;Pass 'full hash verification under retained Windows locks'
 Refuses {[IO.File]::WriteAllText($file,'changed')} 'post verification original mutation denied'
 Refuses {[IO.File]::Move($file,(Join-Path $root 'moved.txt'))} 'post verification file replacement denied'
 [IO.File]::WriteAllText((Join-Path $root 'injected.txt'),'extra')
 Refuses {AssertReleaseEntries $releaseSets[0]} 'file set insertion detected at commit'
}finally{foreach($h in $held){$h.Dispose()}}
# Corruption prior to verification must still fail the full digest, with fresh locks.
$held=[Collections.Generic.List[IDisposable]]::new();$lockedFiles=@{};$lockedDirectories=@{}
try{[IO.File]::WriteAllText($file,'corrupt!');Refuses {CheckRelease $cfg} 'pre verification corruption denied'}finally{foreach($h in $held){$h.Dispose()}}
@{passed=$pass;failed=0;synthetic=$true;checks=$checks;fixtureRoot=$owner;productionMutation=0}|ConvertTo-Json -Depth 5
