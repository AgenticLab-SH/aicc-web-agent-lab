[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot 'Invoke-AiccRemoteRecovery.ps1'
$work=Join-Path $env:USERPROFILE ('.codex\ops\ocx-upstream-separation\20261009\recovery-fixture-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $work|Out-Null
$rollback=Join-Path $work 'fixture-rollback.ps1'
[IO.File]::WriteAllText($rollback,'[IO.File]::AppendAllText((Join-Path $env:WEBGPT_RECOVERY_CAPSULE "fixture-runs.txt"), "one`n")',[Text.UTF8Encoding]::new($true))
$operation='fixture-'+[Guid]::NewGuid().ToString('N').Substring(0,12)
$arm=(& $source -Mode arm -Root $work -OperationId $operation -ConversationId '6ac8a240-f0c0-83ec-b85c-7927270c9868' -ControllerThreadId 'fixture-only' -RollbackScriptPath $rollback)|ConvertFrom-Json
$worker=Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-File',$source,'-Mode','watch','-Root',$work,'-OperationId',$operation,'-Nonce',$arm.nonce)
for($i=0;$i -lt 20;$i++){Start-Sleep -Milliseconds 300;$status=(& $source -Mode status -Root $work -OperationId $operation)|ConvertFrom-Json;if($status.ok){break}}
if(-not $status.ok){throw 'Fixture standby did not start'}
& $source -Mode signal -Root $work -OperationId $operation -Nonce $arm.nonce -Reason 'Isolated fixture only'|Out-Null
if(-not $worker.WaitForExit(15000)){throw 'Fixture rollback did not complete'}
$result=Get-Content -LiteralPath (Join-Path $arm.capsule 'result.json') -Raw|ConvertFrom-Json
if($result.state -ne 'RECOVERED' -or $result.nonce -cne $arm.nonce){throw 'Fixture rollback result mismatch'}
$count=@(Get-Content -LiteralPath (Join-Path $arm.capsule 'fixture-runs.txt')).Count
if($count -ne 1){throw 'Fixture rollback replayed'}
$replay=Start-Process powershell.exe -WindowStyle Hidden -PassThru -Wait -ArgumentList @('-NoProfile','-File',$source,'-Mode','watch','-Root',$work,'-OperationId',$operation,'-Nonce',$arm.nonce) -RedirectStandardError (Join-Path $work 'replay.error.txt')
if($replay.ExitCode -eq 0 -or @(Get-Content -LiteralPath (Join-Path $arm.capsule 'fixture-runs.txt')).Count -ne 1){throw 'Consumed fixture replay fence failed'}
@{schema='aicc-recovery-fixture/v1';status='PASS';remoteSigned=$true;standbyProcessBound=$true;rollbackCount=1;consumedReplayRefused=$true;isolated=$true;work=$work}|ConvertTo-Json
