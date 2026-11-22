#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'),[string]$ActualCandidateRoot,[string[]]$Modes=@('success','task-readback-mismatch','register-unknown','start-unknown','expired-ready','unresolved-journal','listener-preserved','process-inventory-unknown','executor-pin-mismatch','recovery-readback-mismatch','long-preflight','locked-tamper','locked-rename','locked-parent-rename','added-file','new-generation','stale-ack','preflight-ack'))
$ErrorActionPreference='Stop'
if($Modes -notcontains 'preflight-task-pin-mismatch'){$Modes+= 'preflight-task-pin-mismatch'}
if($Modes -notcontains 'preflight-launcher-mismatch'){$Modes+= 'preflight-launcher-mismatch'}
$repo=(Resolve-Path -LiteralPath $AiccRoot).Path
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('aicc-lifecycle-install-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture|Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
function WriteJson($file,$value){New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force|Out-Null;[IO.File]::WriteAllText($file,($value|ConvertTo-Json -Depth 18),$utf8)}
function Hash($file){(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
function TextHash($value){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($value))).ToLowerInvariant()}
$source=[IO.File]::ReadAllText((Join-Path $repo 'tools/platform/windows/Install-AiccMobilePublicRuntime.ps1'))
$passed=0
foreach($mode in $Modes){
 $case=Join-Path $fixture $mode;$owner=Join-Path $case 'owner'
 $base=Join-Path $owner 'releases/cli/before';$release=Join-Path $owner 'releases/cli/after'
 $operation=Join-Path $owner 'backups/operation';$oldOperation=Join-Path $owner 'backups/before';$recovery=Join-Path $owner 'backups/recovery'
 $oldId=[guid]::NewGuid().ToString();$nextId=[guid]::NewGuid().ToString();$op=[guid]::NewGuid().ToString();$stop=[guid]::NewGuid().ToString()
 $oldConfig=Join-Path $owner ('control-plane/mobile-public-runtime/'+$oldId+'/runtime.json')
 $newConfig=Join-Path $owner ('control-plane/mobile-public-runtime/'+$nextId+'/runtime.json')
 $statusFile=Join-Path $owner ('runtime/mobile-public-control/'+$oldId+'/status.json')
 foreach($dir in @($base,$release,$operation,$oldOperation,$recovery,(Split-Path -Parent $oldConfig),(Join-Path $owner 'status-tray/requests'))){New-Item -ItemType Directory -Path $dir -Force|Out-Null}
 $nodeFile=Join-Path $case 'fake-node.exe';$wscript=Join-Path $case 'fake-wscript.exe'
 [IO.File]::WriteAllText($nodeFile,'inert fixture');[IO.File]::WriteAllText($wscript,'inert fixture')
 $oldSupervisor=Join-Path $base 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1'
 $newSupervisor=Join-Path $release 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1'
 foreach($file in @($oldSupervisor,$newSupervisor)){New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force|Out-Null;[IO.File]::WriteAllText($file,'# inert fixture; must never run')}
 $baseManifest=Join-Path $base '.aicc-release.json';WriteJson $baseManifest @{schemaVersion=1;component='mobile-public-control';files=@(@{path='tools/platform/windows/Start-AiccMobilePublicRuntime.ps1';size=(Get-Item -LiteralPath $oldSupervisor).Length;sha256=(Hash $oldSupervisor)})}
 $manifestFile=Join-Path $release '.aicc-release.json'
 WriteJson $manifestFile @{schemaVersion=1;component='mobile-public-control';operationId=$op;files=@(@{path='tools/platform/windows/Start-AiccMobilePublicRuntime.ps1';size=(Get-Item -LiteralPath $newSupervisor).Length;sha256=(Hash $newSupervisor)})}
 $previous=@{schemaVersion=1;runtimeId=$oldId;releaseRoot=$base;releaseManifestSha256=(Hash $baseManifest);port=4383;remoteOrigin='https://synthetic.invalid';nodeExecutable=$nodeFile;nodeSha256=(Hash $nodeFile);controlNonce=('a'*64);statusFile=$statusFile}
 WriteJson $oldConfig $previous
 $next=$previous.Clone();$next.runtimeId=$nextId;$next.releaseRoot=$release;$next.releaseManifestSha256=Hash $manifestFile;$next.controlNonce='b'*64;$next.statusFile=Join-Path $owner ('runtime/mobile-public-control/'+$nextId+'/status.json')
 if($ActualCandidateRoot){
  foreach($item in @(Get-ChildItem -LiteralPath $ActualCandidateRoot -Force)){Copy-Item -LiteralPath $item.FullName -Destination $release -Recurse -Force}
  $actualManifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json -AsHashtable
  $actualManifest.operationId=$op;WriteJson $manifestFile $actualManifest
  $next.releaseManifestSha256=Hash $manifestFile
 }
 $prepared=Join-Path $operation 'prepared-runtime-config.json';WriteJson $prepared $next
 $oldLauncher=Join-Path $oldOperation 'before.hidden.vbs'
 $command='"'+(Join-Path $PSHOME 'pwsh.exe')+'" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$oldSupervisor+'" -ConfigFile "'+$oldConfig+'" -ExpectedConfigSha256 '+(Hash $oldConfig)
 [IO.File]::WriteAllText($oldLauncher,("Option Explicit`r`nDim shell`r`nSet shell = CreateObject(""WScript.Shell"")`r`nWScript.Quit shell.Run("""+$command.Replace('"','""')+""",0,True)`r`n"),$utf8)
 $xmlPath=Join-Path $case 'task.xml'
 $xml='<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Actions><Exec><Command>'+[Security.SecurityElement]::Escape($wscript)+'</Command><Arguments>'+[Security.SecurityElement]::Escape('/b /nologo "'+$oldLauncher+'"')+'</Arguments><WorkingDirectory>'+[Security.SecurityElement]::Escape($oldOperation)+'</WorkingDirectory></Exec></Actions></Task>'
 [IO.File]::WriteAllText($xmlPath,$xml,$utf8)
 if($mode -ceq 'preflight-launcher-mismatch'){
  [IO.File]::AppendAllText($oldLauncher,"`r`n' changed launcher must be refused before stop`r`n",$utf8)
 }
 $now=[DateTimeOffset]::UtcNow
 $status=@{schemaVersion=1;controlProtocolVersion=2;runtimeId=$oldId;releaseRoot=$base;releaseManifestSha256=$previous.releaseManifestSha256;state='NORMAL_STOPPED';lastOperationId=$stop;lastStopResult='NORMAL_STOP_ACK';pid=765432;startedAt=$now.AddHours(-1).ToString('o');observedAt=$now.AddSeconds(-1).ToString('o');drain=@{accepted=$true;activeApiRequests=0;mutationBusy=$false;pendingOutcomes=0;deviceTrustPreserved=$true}}
 WriteJson $statusFile $status
 $stopRoot=Join-Path (Split-Path -Parent $oldConfig) ('stop-requests/'+$stop)
 $requestFile=Join-Path $stopRoot 'request.json'
 WriteJson $requestFile @{action='drain-and-stop';operationId=$stop;runtimeId=$oldId;expectedPid=765432;expectedStartedAt=$status.startedAt;releaseManifestSha256=$previous.releaseManifestSha256;expiresAt=$now.AddSeconds(25).ToString('o')}
 WriteJson (Join-Path $stopRoot 'claim.json') @{schemaVersion=1;operationId=$stop;runtimeId=$oldId;pid=765432;requestSha256=(Hash $requestFile);state='CLAIMED_INPUT_OUTCOME_UNKNOWN';at=$now.AddSeconds(-2).ToString('o')}
 WriteJson (Join-Path $owner 'control-plane/mobile-control.json') @{synthetic=$true}
 if($mode -ceq 'unresolved-journal'){WriteJson (Join-Path $owner ('status-tray/requests/mobile-'+('a'*32)+'.json')) @{state='UNKNOWN'}}
 $isolated=Join-Path $case 'isolated-installer.ps1'
 $isolatedSource=$source.Replace('$owner=Join-Path ([Environment]::GetFolderPath(''UserProfile'')) ''.ai-control-center''',('$owner='''+$owner.Replace("'","''")+"'"))
 $isolatedSource=$isolatedSource.Replace('$wscript=Regular (Join-Path ([Environment]::GetFolderPath(''Windows'')) ''System32\wscript.exe'')',('$wscript=Regular '''+$wscript.Replace("'","''")+"'"))
 $isolatedSource=$isolatedSource.Replace('$scheduler=New-Object -ComObject ''Schedule.Service''','$scheduler=New-FixtureScheduler')
 $isolatedSource=$isolatedSource.Replace('$message=$_.Exception.Message',('$message=$_.Exception.Message; [IO.File]::WriteAllText('''+(Join-Path $case 'fixture-error.txt').Replace("'","''")+''', ($_ | Out-String))'))
 $aclStart=$isolatedSource.IndexOf(' $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User')
 $aclEnd=$isolatedSource.IndexOf(' $bytes=[IO.File]::ReadAllBytes($preparedConfig)',$aclStart)
 if($aclStart -lt 0 -or $aclEnd -lt 0){throw 'fixture_acl_anchor_changed'}
 $isolatedSource=$isolatedSource.Remove($aclStart,$aclEnd-$aclStart).Insert($aclStart," # ACL is an OS-only fixture boundary.`r`n")
 if($mode -in @('long-preflight','locked-tamper','locked-rename','locked-parent-rename','added-file','new-generation','stale-ack','preflight-ack','actual-files')){
  # Synthetic elapsed time applies to installer clock and the pure contract only.
  # Owner fixture publishes a distinct fresh stop after verified files are locked.
  if($mode -ne 'actual-files'){$isolatedSource=$isolatedSource.Replace('[DateTimeOffset]::UtcNow','(Get-FixtureNow)')}
  if($mode -ne 'actual-files'){$isolatedSource=$isolatedSource.Replace(' -PreviousProcessPresent ($previousProcess.Count -ne 0)',' -Now (Get-FixtureNow) -PreviousProcessPresent ($previousProcess.Count -ne 0)')}
  $isolatedSource=$isolatedSource.Replace(" # This process never stops the old service", " Publish-FixtureCommit`n # This process never stops the old service")
 }
 [IO.File]::WriteAllText($isolated,$isolatedSource,$utf8)
 Copy-Item -LiteralPath (Join-Path $repo 'tools/platform/windows/MobilePublicTransition.psm1') -Destination (Join-Path $case 'MobilePublicTransition.psm1')
 $plan=@{schemaVersion=1;operationId=$op;state='ASSEMBLED_NOT_APPLIED';runtimeApplied=$false;validation='STATIC_DEPENDENCIES_PASS_NOT_RUNTIME';lifecycleTransition=@{contractVersion=1;installerSha256=(Hash $isolated);moduleSha256=(Hash (Join-Path $case 'MobilePublicTransition.psm1'))};baselineRuntimeId=$oldId;baseRoot=$base;baseManifestSha256=$previous.releaseManifestSha256;candidateRoot=$release;candidateManifestSha256=$next.releaseManifestSha256;runtimeConfig=$oldConfig;runtimeConfigSha256=(Hash $oldConfig);preparedConfig=$prepared;configSha256=(Hash $prepared);futureConfigPath=$newConfig}
 $planFile=Join-Path $operation 'plan.json';WriteJson $planFile $plan
 $ready=@{schemaVersion=1;status='READY';independent=$true;operationId=$op;planSha256=(Hash $planFile);taskXmlSha256=(TextHash $xml);previousConfigSha256=(Hash $oldConfig);stopOperationId=$stop;target='AgenticLab-AICC-Mobile-Public-Control';recoveryAction='restore-exact-task-after-normal-stop';executorId='synthetic-executor';observedAt=$now.AddSeconds(-4).ToString('o');expiresAt=$now.AddMinutes(2).ToString('o')}
 if($mode -ceq 'expired-ready'){$ready.expiresAt=$now.AddSeconds(-1).ToString('o')}
 $toolReceiptFile=Join-Path $recovery 'tool-readback.json';WriteJson $toolReceiptFile $ready
 $ready.toolReceiptFile=$toolReceiptFile;$ready.toolReceiptSha256=Hash $toolReceiptFile
 if($mode -ceq 'recovery-readback-mismatch'){$ready.executorId='different-executor'}
 $readyFile=Join-Path $recovery 'ready.json';WriteJson $readyFile $ready
 $params=@{PlanFile=$planFile;ExpectedPlanSha256=(Hash $planFile);ExpectedTaskXmlSha256=(TextHash $xml);ActivateNormallyStoppedLifecycle=$true;StopOperationId=$stop;RecoveryReadyFile=$readyFile;ExpectedRecoveryReadySha256=(Hash $readyFile)}
 if($mode -in @('long-preflight','locked-tamper','locked-rename','locked-parent-rename','added-file','new-generation','stale-ack','preflight-ack','actual-files')){
  $params.Remove('ActivateNormallyStoppedLifecycle');$params.Remove('StopOperationId');$params.Remove('RecoveryReadyFile');$params.Remove('ExpectedRecoveryReadySha256')
  $params.AwaitLifecycleCommit=$true;$params.CommitFile=Join-Path $operation 'fresh-commit.json';$params.CommitWaitSeconds=3
 }
 $paramsFile=Join-Path $case 'params.json';WriteJson $paramsFile $params
 if($mode -in @('preflight-task-pin-mismatch','preflight-launcher-mismatch')){
  $params=@{PlanFile=$planFile;ExpectedPlanSha256=(Hash $planFile);ExpectedTaskXmlSha256=if($mode -ceq 'preflight-task-pin-mismatch'){'0'*64}else{TextHash $xml};AwaitLifecycleCommit=$true;CommitFile=(Join-Path $operation 'fresh-commit.json');CommitWaitSeconds=3}
  WriteJson $paramsFile $params
 }
 $harness=Join-Path $case 'harness.ps1'
 $harnessSource=@'
param($CaseRoot,$Mode)
$ErrorActionPreference='Stop'
$global:aiccFixtureCaseRoot=$CaseRoot
$global:aiccFixtureXmlPath=Join-Path $CaseRoot 'task.xml';$global:aiccFixtureMode=$Mode
$global:fixtureNow=[DateTimeOffset]::UtcNow
function Get-FixtureNow {$global:fixtureNow}
function SaveFixture($file,$value){[IO.File]::WriteAllText($file,($value|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))}
function FixtureHash($file){(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
function Publish-FixtureCommit {
 $p=Get-Content -LiteralPath $params.PlanFile -Raw|ConvertFrom-Json -AsHashtable
 $preflight=Join-Path (Split-Path -Parent $params.PlanFile) 'installer-preflight.json'
 $pre=Get-Content -LiteralPath $preflight -Raw|ConvertFrom-Json
 if($pre.state -cne 'CANDIDATE_LOCKED_WAITING_FOR_FRESH_COMMIT' -or $pre.stopRequested){throw 'invalid_preflight_handoff'}
 if($Mode -in @('actual-files','preflight-ack')){$global:fixtureNow=[DateTimeOffset]::UtcNow}else{$global:fixtureNow=$global:fixtureNow.AddSeconds(180)}
 $old=Get-Content -LiteralPath $p.runtimeConfig -Raw|ConvertFrom-Json
 $st=Get-Content -LiteralPath $old.statusFile -Raw|ConvertFrom-Json -AsHashtable
 $stop=$st.lastOperationId;$stopRoot=Join-Path (Split-Path -Parent $p.runtimeConfig) ('stop-requests/'+$stop)
 $reqFile=Join-Path $stopRoot 'request.json';$claimFile=Join-Path $stopRoot 'claim.json'
 $req=Get-Content -LiteralPath $reqFile -Raw|ConvertFrom-Json -AsHashtable
 $claim=Get-Content -LiteralPath $claimFile -Raw|ConvertFrom-Json -AsHashtable
 if($Mode -notin @('stale-ack','preflight-ack')){
  $st.observedAt=$global:fixtureNow.ToString('o')
  $req.expiresAt=$global:fixtureNow.AddSeconds(25).ToString('o')
  $claim.at=$global:fixtureNow.ToString('o')
  SaveFixture $reqFile $req;$claim.requestSha256=FixtureHash $reqFile;SaveFixture $claimFile $claim
 }
 if($Mode -eq 'new-generation'){$st.runtimeId=[guid]::NewGuid().ToString()}
 SaveFixture $old.statusFile $st
 $readyFile=Join-Path $global:aiccFixtureCaseRoot 'owner/backups/recovery/ready.json'
 $ready=Get-Content -LiteralPath $readyFile -Raw|ConvertFrom-Json -AsHashtable
 $ready.observedAt=$global:fixtureNow.ToString('o');$ready.expiresAt=$global:fixtureNow.AddMinutes(2).ToString('o')
 $tool=Get-Content -LiteralPath $ready.toolReceiptFile -Raw|ConvertFrom-Json -AsHashtable
 $tool.observedAt=$ready.observedAt;$tool.expiresAt=$ready.expiresAt
 SaveFixture $ready.toolReceiptFile $tool;$ready.toolReceiptSha256=FixtureHash $ready.toolReceiptFile;SaveFixture $readyFile $ready
 if($Mode -in @('locked-tamper','locked-rename','locked-parent-rename')){
  $target=Join-Path $p.candidateRoot 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1'
  $blocked=$false
  try{if($Mode -eq 'locked-tamper'){[IO.File]::WriteAllText($target,'changed')}elseif($Mode -eq 'locked-parent-rename'){[IO.Directory]::Move($p.candidateRoot,($p.candidateRoot+'.renamed'))}else{[IO.File]::Move($target,($target+'.renamed'))}}catch [IO.IOException]{$blocked=$true}
  if(-not $blocked){throw 'candidate_lock_did_not_prevent_tamper'}
  Mark 'tamper-blocked'
 }
 if($Mode -eq 'added-file'){[IO.File]::WriteAllText((Join-Path $p.candidateRoot 'unsealed.mjs'),'throw Error()')}
 SaveFixture $params.CommitFile @{schemaVersion=1;action='activate-normally-stopped-lifecycle';operationId=$p.operationId;planSha256=$params.ExpectedPlanSha256;preflightSha256=(FixtureHash $preflight);stopOperationId=$stop;recoveryReadyFile=$readyFile;recoveryReadySha256=(FixtureHash $readyFile)}
}
function Mark($name){[IO.File]::AppendAllText((Join-Path $global:aiccFixtureCaseRoot 'calls.txt'),$name+"`n")}
function Get-ScheduledTask {param($TaskName,$TaskPath,$ErrorAction) $doc=[xml][IO.File]::ReadAllText($global:aiccFixtureXmlPath);[pscustomobject]@{State='Ready';Actions=@([pscustomobject]@{Execute=$doc.Task.Actions.Exec.Command;Arguments=$doc.Task.Actions.Exec.Arguments})}}
function Export-ScheduledTask {param($InputObject,$ErrorAction) [IO.File]::ReadAllText($global:aiccFixtureXmlPath)}
function Register-ScheduledTask {param($TaskName,$TaskPath,$Xml,[switch]$Force,$ErrorAction) Mark 'register';[IO.File]::WriteAllText($global:aiccFixtureXmlPath,$Xml);if($global:aiccFixtureMode -ceq 'register-unknown'){throw 'synthetic_register_unknown'};if($global:aiccFixtureMode -ceq 'task-readback-mismatch'){[IO.File]::WriteAllText($global:aiccFixtureXmlPath,$Xml.Replace('mobile-public-runtime.hidden.vbs','changed.hidden.vbs'))}}
function Start-ScheduledTask {param($TaskName,$TaskPath,$ErrorAction) Mark 'start';if($global:aiccFixtureMode -ceq 'start-unknown'){throw 'synthetic_start_unknown'}}
function Get-NetTCPConnection {param($State,$ErrorAction) if($global:aiccFixtureMode -ceq 'listener-preserved'){[pscustomobject]@{LocalPort=4383}}else{@()}}
function Get-CimInstance {param($ClassName,$Filter,$ErrorAction) if($global:aiccFixtureMode -ceq 'process-inventory-unknown'){throw 'synthetic_inventory_unknown'};@()}
function New-FixtureScheduler {$obj=[pscustomobject]@{};$obj|Add-Member ScriptMethod Connect {};$obj|Add-Member ScriptMethod GetFolder {param($p)$this};$obj|Add-Member ScriptMethod GetTask {param($p)$this};$obj|Add-Member ScriptMethod GetInstances {param($p)@()};$obj}
$params=Get-Content -LiteralPath (Join-Path $CaseRoot 'params.json') -Raw|ConvertFrom-Json -AsHashtable
& (Join-Path $CaseRoot 'isolated-installer.ps1') @params
exit $LASTEXITCODE
'@
 [IO.File]::WriteAllText($harness,$harnessSource,$utf8)
 if($mode -ceq 'executor-pin-mismatch'){[IO.File]::AppendAllText($isolated,"`n# changed after pin")}
 $before=@{config=(Hash $oldConfig);manifest=(Hash $baseManifest);request=(Hash $requestFile)}
 $output=& (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File $harness -CaseRoot $case -Mode $mode 2>&1
 $exitCode=$LASTEXITCODE
 [IO.File]::WriteAllText((Join-Path $case 'output.txt'),($output -join "`n"),$utf8)
 $callsFile=Join-Path $case 'calls.txt';$calls=if(Test-Path -LiteralPath $callsFile){@(Get-Content -LiteralPath $callsFile)}else{@()}
 if($mode -in @('preflight-task-pin-mismatch','preflight-launcher-mismatch') -and ((Test-Path -LiteralPath (Join-Path $operation 'installer-preflight.json')) -or $calls.Count)){throw 'wrong_launch_binding_reached_ready_or_mutation'}
 $expected= switch($mode){success {@('register','start')};'long-preflight' {@('register','start')};'locked-tamper' {@('tamper-blocked','register','start')};'locked-rename' {@('tamper-blocked','register','start')};'locked-parent-rename' {@('tamper-blocked','register','start')};'actual-files' {@('register','start')};'task-readback-mismatch' {@('register')};'register-unknown' {@('register')};'start-unknown' {@('register','start')};default {@()}}
 if(($calls -join ',') -cne ($expected -join ',') -or ($mode -in @('success','long-preflight','locked-tamper','locked-rename','locked-parent-rename','actual-files') -and $exitCode -ne 0) -or ($mode -notin @('success','long-preflight','locked-tamper','locked-rename','locked-parent-rename','actual-files') -and $exitCode -eq 0)){throw ('synthetic_installer_case_failed_'+$mode)}
 if((Hash $oldConfig) -cne $before.config -or (Hash $baseManifest) -cne $before.manifest -or ($mode -notin @('long-preflight','locked-tamper','locked-rename','locked-parent-rename','added-file','new-generation','actual-files') -and (Hash $requestFile) -cne $before.request)){throw 'previous_generation_mutated'}
 if($calls.Count){
  $receipt=Get-Content -LiteralPath (Join-Path $operation 'activation-attempt.json') -Raw|ConvertFrom-Json -AsHashtable
  if($mode -notin @('success','long-preflight','locked-tamper','locked-rename','locked-parent-rename','actual-files') -and ($receipt.phase -cne 'HOLD_NO_AUTOMATIC_REPLAY' -or ($mode -ceq 'register-unknown' -and $receipt.startAttempted))){throw 'unknown_receipt_not_preserved'}
  $null=& (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File $harness -CaseRoot $case -Mode $mode 2>&1
  if(($calls -join ',') -cne (@(Get-Content -LiteralPath $callsFile) -join ',')){throw 'activation_replayed'}
 }
 if($mode -eq 'actual-files'){
  WriteJson (Join-Path $fixture 'actual-install-readback.json') @{ownerRoot=$owner;releaseRoot=$release;installedConfig=$newConfig;preparedConfig=$prepared;manifestSha256=(Hash $manifestFile);configSha256=(Hash $newConfig);receipt=(Join-Path $operation 'activation-attempt.json');fixtureRoot=$fixture;preflight=(Join-Path $operation 'installer-preflight.json');candidateFiles=$actualManifest.files.Count}
 }
 $passed++
}
@{passed=$passed;failed=0;synthetic=$true;realTaskChanges=0;realServiceStarts=0;stopRequests=0;externalMessages=0;fixturePreserved=$true;fixtureRoot=$fixture}|ConvertTo-Json -Compress

exit 0
