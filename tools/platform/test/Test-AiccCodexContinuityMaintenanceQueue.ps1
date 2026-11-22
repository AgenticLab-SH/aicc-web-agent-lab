#requires -Version 7.5
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityCliPin.psm1') -Force
$m=Get-Module CodexContinuityCliPin
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-maint-queue-'+[guid]::NewGuid().ToString('N'))
$release=Join-Path $root 'release';$state=Join-Path $root 'state'
foreach($d in @((Join-Path $release 'tools/platform/windows'),(Join-Path $release 'src'),(Join-Path $state 'requests'))){New-Item -ItemType Directory -Path $d -Force|Out-Null}
$helper=Join-Path $release 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'
$dep=Join-Path $release 'src/route.mjs'
[IO.File]::WriteAllText($helper,'fake reviewed maintenance helper')
[IO.File]::WriteAllText($dep,'fake dependency')
$hash=(Get-FileHash -LiteralPath $helper).Hash.ToLowerInvariant()
& $m {param($h)$script:MaintenanceQueueDependencyHelperSha256=$h} $hash
$id='11111111-1111-4111-8111-111111111111';$op='22222222-2222-4222-8222-222222222222'
$q=@{id=$op;threadId=$id;transport='codex-queue';binarySource='signed-desktop-transport';automaticReplay=$false;state='QUEUE_ACCEPTED';exitCode=0;binarySha256=('b'*64);queuedMessageId='33333333-3333-4333-8333-333333333333';marker=('AICC_QUEUE_ATTEMPT:'+$op)}
$receipt=Join-Path $state ('requests/'+$op+'.json')
[IO.File]::WriteAllText($receipt,($q|ConvertTo-Json))
$cfg=@{schemaVersion=1;protocolVersion=3;nativeFallback=$false;helperPath=$helper;helperSha256=$hash;codexSha256=('a'*64);workerStopRequestedAt='2026-11-07T00:00:00Z';worker=@{state='STOPPED_FOR_MAINTENANCE'};threads=@{};strictRouteLauncher=@{schemaVersion=1;route='command-route-r2';codexSha256=('a'*64);releaseRoot=$release;files=@{'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'=$hash;'src/route.mjs'=(Get-FileHash -LiteralPath $dep).Hash.ToLowerInvariant()}}}
$cfg.threads[$id]=@{threadId=$id;enabled=$false;state='DISABLED';attempt=$null;queueAttempt=$q}
$checks=0
function Check($ok,$label){if(-not $ok){throw ('FAIL:'+ $label)};$script:checks++}
function Proof {& $m {param($c,$s)Assert-PinNoDispatch $c $s $c.codexSha256 $c.codexSha256} $cfg $state}
function Reject {try{Proof|Out-Null;throw 'expected_rejection_missing'}catch{Check ($_.Exception.Message -match 'existing_dispatch_preserved|desktop_queue_receipt_binding_changed|worker_maintenance_exit_unconfirmed') ('invalid preservation rejected: '+$_.Exception.Message)}}
$before=(Get-FileHash -LiteralPath $receipt).Hash
$proof=@(Proof)
Check ($proof.Count -eq 1 -and $proof[0].attemptId -ceq $op) 'reviewed complete stopped closure preserves exact queue'
Check ((Get-FileHash -LiteralPath $receipt).Hash -ceq $before -and $q.state -ceq 'QUEUE_ACCEPTED') 'receipt and unresolved state unchanged'
$cfg.workerStopRequestedAt=$null;Reject;$cfg.workerStopRequestedAt='2026-11-07T00:00:00Z'
$cfg.worker.state='WATCHING';Reject;$cfg.worker.state='STOPPED_FOR_MAINTENANCE'
$cfg.threads[$id].enabled=$true;Reject;$cfg.threads[$id].enabled=$false
$q.automaticReplay=$true;Reject;$q.automaticReplay=$false
$cfg.threads[$id].attempt=@{id='unknown'};Reject;$cfg.threads[$id].attempt=$null
$cfg.strictRouteLauncher.files['../outside']='a'*64;Reject;$cfg.strictRouteLauncher.files.Remove('../outside')
[IO.File]::AppendAllText($dep,'changed');Reject
[IO.File]::WriteAllText($dep,'fake dependency')
$cfg.helperSha256='e'*64;$cfg.strictRouteLauncher.files['tools/platform/windows/Invoke-AiccCodexContinuity.ps1']=$cfg.helperSha256
[IO.File]::WriteAllText($helper,'unreviewed helper')
$cfg.helperSha256=(Get-FileHash -LiteralPath $helper).Hash.ToLowerInvariant();$cfg.strictRouteLauncher.files['tools/platform/windows/Invoke-AiccCodexContinuity.ps1']=$cfg.helperSha256
Reject
@{terminal='PASS';checks=$checks;fixture=$root;runtimeMutations=0;modelRequests=0}|ConvertTo-Json -Compress
