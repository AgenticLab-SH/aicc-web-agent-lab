#requires -Version 7.5
$ErrorActionPreference='Stop'
$watcher=Join-Path $PSScriptRoot '../tools/platform/workspace-mcp/Watch-AiccHostRuntimeRecovery.ps1'
$updater=Join-Path $PSScriptRoot '../tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1'
$state=Join-Path $env:USERPROFILE '.ai-control-center/asset-control'
$testRoot=Join-Path $state ('queue-owner-recovery-test-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $testRoot
function Sha($file){(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
$updaterSha=Sha $updater
$cases=@(
 @{kind='workspace-gpt-queue-owner-replacement';expected=0;pin=$updaterSha;rollback=$testRoot},
 @{kind='workspace-gpt-queue-update';expected=0;pin=$updaterSha;rollback=$testRoot},
 @{kind='unreviewed-owner-operation';expected=1;pin=$updaterSha;rollback=$testRoot},
 @{kind='workspace-gpt-queue-owner-replacement';expected=1;pin=('0'*64);rollback=$testRoot},
 @{kind='workspace-gpt-queue-owner-replacement';expected=1;pin=$updaterSha;rollback=(Join-Path $testRoot 'other')}
)
$checks=0
foreach($case in $cases){
 $plan=Join-Path $testRoot ('plan-'+$checks+'.json')
 @{changeKind=$case.kind;scriptSha256=$case.pin;rollback_ref=$case.rollback;request_id='synthetic-read-only-test'}|ConvertTo-Json|Set-Content -LiteralPath $plan -Encoding utf8NoBOM
 $raw=& pwsh -NoProfile -File $watcher -Mode Status -PlanFile $plan -ExpectedPlanSha256 (Sha $plan) -Updater $updater -ExpectedUpdaterSha256 $updaterSha 2>&1
 $actual=$LASTEXITCODE
 if($actual -ne $case.expected){throw ('Unexpected scope result: '+$case.kind+' '+($raw -join ' '))}
 if($actual -eq 0){$read=($raw -join "`n")|ConvertFrom-Json;if($read.state -cne 'READ_ONLY' -or $read.readyExists){throw 'Status granted readiness'}}
 if(Test-Path -LiteralPath (Join-Path $testRoot 'independent-ready.json')){throw 'Read-only scope check wrote READY'}
 $checks++
}
@{status='PASS';checks=$checks;readOnly=$true;readyWritten=$false;runtimeChanged=$false;fixture=$testRoot}|ConvertTo-Json -Compress
