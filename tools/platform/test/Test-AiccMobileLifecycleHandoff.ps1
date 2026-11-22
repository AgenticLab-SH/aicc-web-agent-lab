#requires -Version 7.5
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$source=[IO.File]::ReadAllText((Join-Path $repo 'tools/platform/windows/Invoke-AiccMobileLifecycleTransition.ps1'))
$root=Join-Path ([IO.Path]::GetTempPath()) ('mobile-handoff-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $root|Out-Null
function Hash($f){(Get-FileHash -LiteralPath $f).Hash.ToLowerInvariant()}
function Json($f,$v){New-Item -ItemType Directory -Path (Split-Path -Parent $f) -Force|Out-Null;[IO.File]::WriteAllText($f,($v|ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false))}
$passed=0
foreach($mode in @('success','delayed-exit','expired-ready','unknown-stop','owner-change','old-process-present','existing-commit')){
 $dir=Join-Path $root $mode;$owner=Join-Path $dir 'owner';$op=Join-Path $owner 'backups/op';$rel=Join-Path $owner 'releases/recovery';$candidate=Join-Path $owner 'releases/cli/candidate'
 foreach($d in @($op,$rel,$candidate,(Join-Path $owner 'control-plane/mobile-public-recovery'))){New-Item -ItemType Directory -Path $d -Force|Out-Null}
 $runtime=Join-Path $dir 'runtime.json';$status=Join-Path $dir 'status.json';Json $status @{pid=123;startedAt='2026-01-01T00:00:00.123Z';state='LISTENING'};Json $runtime @{statusFile=$status}
 $recover=Join-Path $rel 'tools/platform/windows/Request-AiccMobilePublicRecovery.ps1';$stop=Join-Path $candidate 'tools/platform/windows/Request-AiccMobilePublicStop.ps1'
 $recoveryCode=@(
 'param($Action,$PlanFile,$ExpectedPlanSha256,$RequestFile,$ExpectedRequestSha256,$Signal,$Sequence,$ExpectedTaskXmlSha256)',
 'if($Action -eq ''StartProbe''){',
 '$r=Join-Path $env:FIX_OP ''request.json'';@{stopOperationId=''11111111-1111-1111-1111-111111111111'';taskXmlSha256=(''a''*64)}|ConvertTo-Json|Set-Content -LiteralPath $r',
 '@{state=''PROBE_RESPONSE'';mutationCount=0;requestFile=$r;requestSha256=(''a''*64)}|ConvertTo-Json',
 '}else{',
 '$expires=if($env:FIX_MODE -eq ''expired-ready''){[DateTimeOffset]::UtcNow.AddSeconds(-1)}else{[DateTimeOffset]::UtcNow.AddSeconds(110)}',
 '@{state=''ARMED_FOR_EXPLICIT_RECOVERY'';expiresAt=$expires.ToString(''o'');readyFile=''fixture-ready'';readySha256=(''a''*64)}|ConvertTo-Json',
 '}') -join [Environment]::NewLine
 [IO.Directory]::CreateDirectory((Split-Path -Parent $recover))|Out-Null;[IO.File]::WriteAllText($recover,$recoveryCode)
 $stopCode=@('param($ConfigFile,$ExpectedConfigSha256,$OperationId,[switch]$Submit,$WaitSeconds)',
 'if($Submit){@{normalStopAck=($env:FIX_MODE -ne ''unknown-stop'')}|ConvertTo-Json}else{@{stopSubmissionSupported=$true;otherPendingStopRequests=0;pid=if($env:FIX_MODE -eq ''owner-change''){456}else{123}}|ConvertTo-Json}') -join [Environment]::NewLine
 [IO.Directory]::CreateDirectory((Split-Path -Parent $stop))|Out-Null;[IO.File]::WriteAllText($stop,$stopCode)
 $mf=Join-Path $rel 'manifest.json';Json $mf @{files=@(@{path='tools/platform/windows/Request-AiccMobilePublicRecovery.ps1';sha256=Hash $recover})}
 Json (Join-Path $owner 'control-plane/mobile-public-recovery/current.json') @{manifestFile=$mf;manifestSha256=Hash $mf}
 Json (Join-Path $candidate '.aicc-release.json') @{files=@(@{path='tools/platform/windows/Request-AiccMobilePublicStop.ps1';sha256=Hash $stop})}
 $id=[guid]::NewGuid().ToString();$plan=@{operationId=$id;runtimeConfig=$runtime;runtimeConfigSha256=Hash $runtime;candidateRoot=$candidate};$pf=Join-Path $op 'plan.json';Json $pf $plan
 Json (Join-Path $op 'installer-preflight.json') @{planSha256=Hash $pf;operationId=$id;installerPid=987};Json (Join-Path $op 'recovery-preflight.json') @{}
 if($mode -eq 'existing-commit'){Json (Join-Path $op 'lifecycle-commit.json') @{preserve='original'}}
 $isolated=$source.Replace('$owner=Join-Path ([Environment]::GetFolderPath(''UserProfile'')) ''.ai-control-center''',('$owner='''+$owner+''''))
 $shim=@(
 'function Get-Process {param($Id,$ErrorAction) @{Id=$Id}}',
 '$script:exitReads=0',
 'function Get-CimInstance {param($ClassName,$Filter,$ErrorAction) if($Filter -like ''* OR *''){$script:exitReads++;if($env:FIX_MODE -eq ''old-process-present'' -or ($env:FIX_MODE -eq ''delayed-exit'' -and $script:exitReads -lt 3)){@{ProcessId=123}}}else{@{ProcessId=123;ParentProcessId=456}}}',
 'function Get-ScheduledTask {param($TaskName,$TaskPath,$ErrorAction) @{State=''Ready''}}',
 'function Start-Sleep {param($Milliseconds)}') -join [Environment]::NewLine
 if($mode -ne 'delayed-exit'){$isolated=$isolated.Replace('$deadline=[DateTimeOffset]::UtcNow.AddSeconds(60)','$deadline=[DateTimeOffset]::UtcNow.AddSeconds(-1)')}
 $script=Join-Path $dir 'isolated.ps1';[IO.File]::WriteAllText($script,($isolated.Replace('$ErrorActionPreference=''Stop''',('$ErrorActionPreference=''Stop'''+[Environment]::NewLine+$shim))))
 $env:FIX_OP=$op;$env:FIX_MODE=$mode;$thrown=$false;try{& $script -PlanFile $pf -ExpectedPlanSha256 (Hash $pf)|Out-Null}catch{$thrown=$true}
 if($mode -in @('success','delayed-exit')){if($thrown -or -not(Test-Path -LiteralPath (Join-Path $op 'lifecycle-commit.json'))){throw 'fixture_success_failed'};$c=Get-Content -LiteralPath (Join-Path $op 'lifecycle-commit.json') -Raw|ConvertFrom-Json;if($c.stopOperationId -cne '11111111-1111-1111-1111-111111111111'){throw 'wrong_commit'}}else{if(-not $thrown){throw ('unsafe_handoff_'+$mode)};if($mode -ne 'existing-commit' -and (Test-Path -LiteralPath (Join-Path $op 'lifecycle-commit.json'))){throw 'unsafe_commit'}}
 $passed++
}
@{state='PASS';passed=$passed;failed=0;fixture=$root;operationalMutations=0}|ConvertTo-Json -Compress
