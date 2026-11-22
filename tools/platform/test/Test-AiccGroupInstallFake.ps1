#requires -Version 7.5
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityMaintenance.psm1') -Force
$m=Get-Module CodexContinuityMaintenance
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-group-install-fake-'+[guid]::NewGuid().ToString('N'))
$state=Join-Path $root 'control-plane/codex-continuity'
$source=Join-Path $root 'source'
$paths=@($state,(Join-Path $source 'src'),(Join-Path $source 'tools/platform/windows'),(Join-Path $root 'oldrelease'))
foreach($d in $paths){New-Item -ItemType Directory -Path $d -Force|Out-Null}
$targetThread='11111111-1111-4111-8111-111111111111'
$targetRoot=Join-Path $root 'original'
New-Item -ItemType Directory -Path $targetRoot -Force|Out-Null
function WriteFake($file,$value){[IO.File]::WriteAllText($file,$value,[Text.UTF8Encoding]::new($false))}
function Hash($file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
WriteFake (Join-Path $source 'src/codex-strict-continuity-bridge.mjs') "import {officialRoute} from './codex-cli-routes.mjs';"
WriteFake (Join-Path $source 'src/codex-cli-routes.mjs') "export const officialRoute='command-route-r2';"
WriteFake (Join-Path $source 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1') ". (Join-Path `$PSScriptRoot 'CodexContinuityGroupOwner.ps1') # fake group helper"
WriteFake (Join-Path $source 'tools/platform/windows/CodexContinuityGroupOwner.ps1') '# fake transitive owner module'
$node=Join-Path $root 'node.exe';$codex=Join-Path $root 'codex.exe';$oldHelper=Join-Path $root 'old.ps1'
foreach($f in @($node,$codex,$oldHelper)){WriteFake $f ('fake '+$f)}
$oldVbs=Join-Path $root 'oldrelease/worker.hidden.vbs'
WriteFake $oldVbs 'fake original task vbs'
$xml='<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Author>Owner</Author></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Actions><Exec><Command>C:\Windows\System32\wscript.exe</Command><Arguments>/b /nologo "'+$oldVbs+'"</Arguments><WorkingDirectory>'+(Split-Path $oldVbs)+'</WorkingDirectory></Exec></Actions></Task>'
$cfg=@{schemaVersion=1;protocolVersion=3;nativeFallback=$false;workerStopRequestedAt='2026-11-07T00:00:00Z';
 worker=@{pid=2147483647;state='STOPPED_FOR_MAINTENANCE'};helperPath=$oldHelper;helperSha256=(Hash $oldHelper);
 codexExecutable=$codex;codexSha256=(Hash $codex);excludedThreadIds=@();threads=@{}}
$registry=Join-Path $state 'registrations.json'
WriteFake $registry ($cfg|ConvertTo-Json -Depth 15)
foreach($lock in @('worker.lock','registrations.json.lock')){WriteFake (Join-Path $state $lock) ''}
$global:fakeCurrentTaskXml=$xml
$global:fakeRoot=$root
$global:fakeTargetRoot=$targetRoot
$global:fakeRollout=(Join-Path $targetRoot 'rollout-11111111.jsonl')
& $m {
 function script:GroupInstall-RequireOwner([string]$StateRoot){
  if(-not [IO.Path]::GetFullPath($StateRoot).StartsWith([IO.Path]::GetFullPath($global:fakeRoot),[StringComparison]::OrdinalIgnoreCase)){throw 'fake_owner_root_changed'}
 }
 function script:GroupInstall-Thread([string]$ThreadId,[string]$ExpectedRoot,$cfg){
  if($ThreadId -cne '11111111-1111-4111-8111-111111111111' -or [IO.Path]::GetFullPath($ExpectedRoot) -ine [IO.Path]::GetFullPath($global:fakeTargetRoot)){throw 'fake_thread_mismatch'}
  @{threadId=$ThreadId;projectRoot=[IO.Path]::GetFullPath($ExpectedRoot);rollout=$global:fakeRollout;registered=$cfg.threads.ContainsKey($ThreadId)}
 }
 function script:GroupInstall-TaskSnapshot([string]$StateRoot){
  $xml=$global:fakeCurrentTaskXml
  $match=[regex]::Match($xml,'/b /nologo &quot;(?<vbs>.*?)&quot;')
  if(-not $match.Success){$match=[regex]::Match($xml,'/b /nologo "(?<vbs>.*?)"')}
  if(-not $match.Success){throw 'fake_task_actions_lost'}
  $vbs=$match.Groups['vbs'].Value
  @{taskName='AgenticLab-AICC-Codex-Continuity';xml=$xml;xmlSha256=(GroupInstall-HashText $xml);
   oldVbs=$vbs;oldVbsSha256=(Maintenance-Hash $vbs);oldTaskState='Disabled';wscript='C:\Windows\System32\wscript.exe'}
 }
 function script:Register-ScheduledTask{
  param([string]$TaskName,[string]$Xml,[switch]$Force)
  if($TaskName -cne 'AgenticLab-AICC-Codex-Continuity' -or -not $Force){throw 'fake_task_wrong_owner'}
  $global:fakeCurrentTaskXml=$Xml
  @{TaskName=$TaskName}
 }
 function script:Maintenance-Hash([string]$file){
  if($file -like '*pwsh-7.6.6*'){return ('f'*64)}
  (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
 }
 & $script:PinModule {
  function script:Get-CimInstance {param($ClassName,$Filter,$ErrorAction)@()}
 }
}
$checks=0
function Check($ok,[string]$label){if(-not $ok){throw ('fake_group_install_failed:'+ $label)};$script:checks++}
$beforeHash=Hash $registry
$planRoot=Join-Path $state 'plans';New-Item -ItemType Directory -Path $planRoot -Force|Out-Null
$plan=Join-Path $planRoot 'groupowner-preview.json'
$preview=New-AiccGroupOwnerInstallPlan -StateRoot $state -SourceRoot $source -NodePath $node -PlanFile $plan -ThreadId $targetThread -TargetRoot $targetRoot -OwnerRevision ('a'*64) -StopEpoch 7 -WorkerOperationId '22222222-2222-4222-8222-222222222222'
Check ($preview.state -ceq 'PREPARED' -and $preview.modelRequests -eq 0) 'preview no model'
Check ((Hash $registry) -ceq $beforeHash -and $global:fakeCurrentTaskXml -ceq $xml) 'preview no effect'
$wrong=$false
try{Invoke-AiccGroupOwnerInstallPlan -PlanFile $plan -ExpectedPlanSha256 $preview.planSha256 -Confirm 'not authorized'|Out-Null}catch{$wrong=$true}
Check ($wrong -and -not(Test-Path -LiteralPath ($plan+'.claimed'))) 'incorrect confirm cannot apply'
$installed=Invoke-AiccGroupOwnerInstallPlan -PlanFile $plan -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirmation
Check ($installed.state -ceq 'INSTALLED_STOPPED' -and $installed.modelRequests -eq 0 -and -not $installed.workerStarted) 'exact apply without model'
$now=Get-Content -LiteralPath $registry -Raw|ConvertFrom-Json -AsHashtable -DateKind String
Check ($now.workerStopRequestedAt -ceq '2026-11-07T00:00:00Z' -and $now.threads[$targetThread].enabled -ceq $false -and
 $now.threads[$targetThread].groupOwnerOnly -ceq $true -and $now.threads[$targetThread].strictAccount -eq 2) 'fence and explicit opt-in preserved'
Check ($now.strictRouteLauncher.files.Count -eq 4 -and $now.helperSha256 -ceq $installed.helperSha256) 'complete strict dependency pin'
Check ($global:fakeCurrentTaskXml -cne $xml -and $global:fakeCurrentTaskXml.Contains('group-owner-')) 'only exact task action changed'
$duplicate=$false
try{Invoke-AiccGroupOwnerInstallPlan -PlanFile $plan -ExpectedPlanSha256 $preview.planSha256 -Confirm $preview.confirmation|Out-Null}catch{$duplicate=$true}
Check ($duplicate) 'duplicate apply refused'
$rolled=Undo-AiccGroupOwnerInstallPlan -PlanFile $plan -Confirm ('ROLLBACK GROUP OWNER '+$installed.afterRegistrySha256)
Check ($rolled.state -ceq 'ROLLED_BACK_STOPPED' -and $rolled.modelRequests -eq 0) 'explicit guarded rollback'
Check ((Hash $registry) -ceq $beforeHash -and $global:fakeCurrentTaskXml -ceq $xml) 'registry and task exact preimages restored'
@{terminal='PASS';checks=$checks;fixture=$root;liveRuntimeChanges=0;modelRequests=0}|ConvertTo-Json -Compress
