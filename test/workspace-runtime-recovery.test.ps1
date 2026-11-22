#requires -Version 7.5
[CmdletBinding()]
param([string[]]$Cases = @('broker-ready','patch-parent-ready','cold-ready','host-compatible','lifecycle-ready','queue-ready','unsupported-kind','wrong-host','target-dependent'))
$ErrorActionPreference='Stop'
$worker=Join-Path $PSScriptRoot '../tools/platform/workspace-mcp/Watch-AiccHostRuntimeRecovery.ps1'
$base=[IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.ai-control-center/asset-control'))
$root=Join-Path $base ('recovery-worker-test-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
$checks=[Collections.Generic.List[string]]::new()
function Digest([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function Put($v,[string]$p){[IO.File]::WriteAllText($p,($v|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
try{
 $updater=Join-Path $root 'updater.ps1'
 [IO.File]::WriteAllText($updater,"throw 'Fixture updater must never run'")
 $updaterHash=Digest $updater
 $hostProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
 $hostHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($hostProcess.CommandLine))).ToLowerInvariant()
 foreach($case in $Cases){
  $dir=Join-Path $root $case;[IO.Directory]::CreateDirectory($dir)|Out-Null
  $planFile=Join-Path $dir 'plan.json'
  $kind=if($case -eq 'host-compatible'){'host-runtime-update'}elseif($case -eq 'cold-ready'){'workspace-runtime-cold-recovery'}elseif($case -eq 'patch-parent-ready'){'workspace-patch-parent-update'}elseif($case -eq 'lifecycle-ready'){'workspace-process-lifecycle-update'}elseif($case -eq 'queue-ready'){'workspace-gpt-queue-update'}elseif($case -eq 'unsupported-kind'){'unregistered-update'}else{'workspace-broker-security-update'}
  $owned=if($case -eq 'target-dependent'){@(@{pid=$PID})}else{@()}
  $plan=@{changeKind=$kind;scriptSha256=$updaterHash;rollback_ref=$dir;expires_at=[DateTimeOffset]::UtcNow.AddSeconds(8).ToString('o');ownership=@{processes=$owned};request_id=$case;owner_task_id='fixture';challenge=[guid]::NewGuid().ToString('N');target='fixture';allowed_recovery=@()}
  Put $plan $planFile
  Put @{phase='PREPARED'} (Join-Path $dir 'journal.json')
  $expectedPid=if($case -eq 'wrong-host'){0}else{$PID}
  $arguments=@('-NoProfile','-File',$worker,'-Mode','Watch','-PlanFile',$planFile,'-ExpectedPlanSha256',(Digest $planFile),'-Updater',$updater,'-ExpectedUpdaterSha256',$updaterHash,'-ExpectedIndependentHostPid',$expectedPid,'-ExpectedIndependentHostCreatedTicks',$hostProcess.CreationDate.ToUniversalTime().Ticks.ToString(),'-ExpectedIndependentHostCommandSha256',$hostHash)
  $process=Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dir 'stdout.log') -RedirectStandardError (Join-Path $dir 'stderr.log')
  if(-not $process.WaitForExit(20000)){Stop-Process -Id $process.Id;throw "Fixture worker did not exit: $case"}
  $ready=Join-Path $dir 'independent-ready.json'
  if($case -in @('broker-ready','patch-parent-ready','cold-ready','host-compatible','lifecycle-ready','queue-ready')){
   if($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $ready)){throw "Expected independent READY: $case"}
   $receipt=Get-Content -LiteralPath $ready -Raw|ConvertFrom-Json
   if($receipt.independentHostPid -ne $PID -or $receipt.request_id -cne $case -or $receipt.plan_sha256 -cne (Digest $planFile)){throw 'READY was not bound to the actual process and plan'}
   $closed=Get-Content -LiteralPath (Join-Path $dir 'independent-closed.json') -Raw|ConvertFrom-Json
   if($closed.state -cne 'EXPIRED_NO_RECOVERY_DISPATCH'){throw 'Prepared fixture must not dispatch recovery'}
  }elseif($process.ExitCode -eq 0 -or (Test-Path -LiteralPath $ready)){throw "Unsafe recovery origin accepted: $case"}
  $checks.Add($case)
 }
 @{status='PASS';checks=@($checks);serviceMutations=0}|ConvertTo-Json -Compress
}finally{
 $resolved=[IO.Path]::GetFullPath($root)
 if(-not $resolved.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'recovery-worker-test-*'){throw 'Fixture cleanup boundary changed'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
