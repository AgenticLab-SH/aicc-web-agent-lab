#requires -Version 7.5
<#
Owned private mobile blue/green deployment. Prepare does not start a service.
Apply is one-shot; an uncertain start/proxy result must be reconciled, never replayed.
No legacy process, public listener, model route or device-trust record is stopped/restored.
No build, test, HTTP probe or automatic post-install verification is performed.
#>
[CmdletBinding()]
param(
 [ValidateSet('Prepare','Apply','Reconcile','Rollback','Run')][string]$Mode='Prepare',
 [Parameter(Mandatory)][string]$OperationRoot,
 [string]$SourceRoot=(Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))),
 [string]$OwnerRoot=(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'),
 [string]$BaseRelease,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedBaseManifestSha256,
 [ValidateSet(4384,4385)][int]$NewPort=4384,
 [switch]$LocalOnly,
 [string]$PreviousRuntimeConfig,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPreviousConfigSha256,
 [string]$PlanFile,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPlanSha256,
 [string]$ConfigFile,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedConfigSha256
)
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false)
$taskName='AgenticLab-AICC-Mobile-Control'
$port=$NewPort
function Full([string]$p){[IO.Path]::GetFullPath($p)}
function Within([string]$root,[string]$p){(Full $p).StartsWith((Full $root)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)}
function HashBytes([byte[]]$bytes){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()}
function HashText([string]$text){HashBytes ($utf8.GetBytes($text))}
function HashFile([string]$p){
 # Same SHA-256 bytes; avoid a PowerShell provider pipeline per manifest entry.
 $stream=[IO.File]::OpenRead((Full $p))
 try{[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()}finally{$stream.Dispose()}
}
function Regular([string]$p){
 # Inspect the leaf and every ancestor directly. Never cache path safety across
 # mutations and never follow a reparse point to accept a release or journal.
 $p=Full $p;$leaf=[IO.File]::GetAttributes($p)
 for($a=$p;;$a=[IO.Path]::GetDirectoryName($a)){
  $attributes=[IO.File]::GetAttributes($a)
  if($attributes -band [IO.FileAttributes]::ReparsePoint){throw 'linked_deployment_path_preserved'}
  $up=[IO.Path]::GetDirectoryName($a);if(-not $up -or $up -eq $a){break}
 }
 if($leaf -band [IO.FileAttributes]::Directory){throw 'regular_file_required'}
 return $p
}
function ReadJson([string]$p){
 # PowerShell 7.5 otherwise converts ISO timestamps to DateTime; a later string cast
 # removes their UTC suffix and reparses them as local time, breaking generation CAS.
 Get-Content -LiteralPath (Regular $p) -Raw|ConvertFrom-Json -AsHashtable -DateKind String
}
function WriteNew([string]$p,[string]$text){
 $s=[IO.File]::Open($p,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$b=$utf8.GetBytes($text);$s.Write($b);$s.Flush($true)}finally{$s.Dispose()}
}
function WriteJson([string]$p,$value){WriteNew $p ($value|ConvertTo-Json -Depth 24)}
function UpdateJson([string]$p,$value){
 if(-not (Within $OperationRoot $p)){throw 'journal_boundary_required'}
 $temp=$p+'.'+[guid]::NewGuid().ToString('N')+'.tmp';WriteJson $temp $value
 Move-Item -LiteralPath $temp -Destination (Full $p) -Force -ErrorAction Stop
}
function PrivateDirectory([string]$p){
 New-Item -ItemType Directory -Path $p -ErrorAction Stop|Out-Null
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.DirectorySecurity]::new()
 $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow'))
 Set-Acl -LiteralPath $p -AclObject $acl
}
function Pinned([string]$file,[string]$expected){$file=Regular $file;if((HashFile $file) -cne $expected){throw 'preimage_changed'};return $file}
function LedgerIdle {
 $dir=Join-Path $OwnerRoot 'status-tray/requests';if(-not (Test-Path -LiteralPath $dir -PathType Container)){throw 'mobile_ledger_inventory_unknown'}
 if(Test-Path -LiteralPath (Join-Path $dir 'mobile-operation.lock')){throw 'mobile_operation_lock_preserved'}
 $count=0
 foreach($f in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction Stop|Where-Object Name -Match '^mobile-[a-f0-9]{32}\.json$')){
  $r=ReadJson $f.FullName;if($r.state -cne 'COMPLETED'){throw 'mobile_outcome_requires_reconciliation'};$count++
 }
 return $count
}
function ListenerFree {if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -EQ $port).Count){throw 'new_listener_occupied_preserved'}}
function ServeText([string]$exe){$lines=& $exe serve status --json;if($LASTEXITCODE -ne 0){throw 'tailscale_serve_inventory_unknown'};return ($lines -join "`n")}
function LegacyTask {
 $t=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
 if(@($t.Actions).Count -ne 1 -or [IO.Path]::GetFileName($t.Actions[0].Execute) -ine 'wscript.exe'){throw 'registered_private_task_required'}
 $m=[regex]::Match([string]$t.Actions[0].Arguments,'^/b /nologo "([^"]+\.vbs)"$')
 if(-not $m.Success){throw 'exact_private_launcher_required'}
 return @{task=$t;xml=(Export-ScheduledTask -InputObject $t);vbs=(Regular $m.Groups[1].Value)}
}
function RestartPromotion([string]$op){
 $proofFile=Join-Path $op 'restart-authorization.json'
 if(-not(Test-Path -LiteralPath $proofFile)){return $null}
 $proof=ReadJson $proofFile
 if($proof.schemaVersion -ne 1 -or $proof.state -cne 'AUTHORIZED_AFTER_APPLIED' -or $proof.operationId -notmatch '^[a-f0-9]{32}$' -or $proof.monitorActivated -ne $true -or $proof.monitorStartCalls -ne 1 -or $proof.activationOperationId -notmatch '^[a-f0-9-]{36}$' -or $proof.previousNormalStopped -ne $true){throw 'restart_authorization_not_completed'}
 foreach($name in @('originalConfig','bootConfig','bootLauncher','bootstrap','runner','completedReceipt')){if(-not(Within $op $proof[$name])){throw 'restart_authorization_boundary_changed'};[void](Pinned $proof[$name] $proof[$name+'Sha256'])}
 $completed=ReadJson $proof.completedReceipt
 if($completed.state -cne 'APPLIED_NOT_VERIFIED' -or $completed.operationId -cne $proof.operationId -or $completed.monitorActivated -ne $true -or $completed.monitorStartCalls -ne 1 -or $completed.previousNormalStopped -ne $true -or $completed.monitorActivationAttempts -ne 1 -or $completed.monitorActivationOperationId -cne $proof.activationOperationId){throw 'restart_completed_receipt_required'}
 $original=ReadJson $proof.originalConfig;$boot=ReadJson $proof.bootConfig
 if($original.runtimeId -cne $proof.runtimeId -or $original.releaseManifestSha256 -cne $proof.releaseManifestSha256 -or $boot.monitorStandby -ne $false -or $boot.restartAuthorizationSource -cne ('completed-deployment:'+ $proof.operationId+':'+$proof.activationOperationId)){throw 'restart_authorization_generation_changed'}
 if(@($boot.Keys).Count -ne @($original.Keys).Count+1){throw 'restart_config_contract_changed'}
 foreach($key in $original.Keys){if($key -ceq 'monitorStandby'){continue};if(($original[$key]|ConvertTo-Json -Depth 24 -Compress) -cne ($boot[$key]|ConvertTo-Json -Depth 24 -Compress)){throw 'restart_config_preimage_changed'}}
 return $proof
}
$OwnerRoot=Full $OwnerRoot;$OperationRoot=Full $OperationRoot
if($OwnerRoot -ine (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center') -or -not (Within (Join-Path $OwnerRoot 'backups') $OperationRoot)){throw 'existing_owner_and_owned_operation_required'}

if($Mode -eq 'Run'){
 $config=Pinned $ConfigFile $ExpectedConfigSha256;$cfg=ReadJson $config
 if(-not (Within $OperationRoot $config) -or $cfg.port -notin @(4384,4385) -or $cfg.ownerRoot -ine $OwnerRoot -or $cfg.controlNonce -notmatch '^[a-f0-9]{64}$'){throw 'exact_private_runtime_config_required'}
 if($cfg.restartAuthorizationSource){$authorization=RestartPromotion $OperationRoot;if(-not $authorization -or $authorization.bootConfig -ine $config -or $authorization.bootConfigSha256 -cne $ExpectedConfigSha256){throw 'completed_restart_authorization_required'}}
 $port=[int]$cfg.port
 ListenerFree
 $node=Pinned $cfg.nodeExecutable $cfg.nodeSha256;$runner=Pinned $cfg.runnerFile $cfg.runnerSha256
 $lock=[IO.File]::Open((Join-Path $OperationRoot 'runtime.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$node;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.WindowStyle='Hidden';$psi.RedirectStandardInput=$true;$psi.StandardInputEncoding=$utf8
 $psi.Environment['AICC_STATE_ROOT']=$OwnerRoot;$psi.ArgumentList.Add($runner);$psi.ArgumentList.Add($config)
 $child=$null
 try{
  $child=[Diagnostics.Process]::Start($psi)
  while(-not $child.WaitForExit(1000)){
   $requestRoot=Join-Path $OperationRoot 'stop-requests';if(-not (Test-Path -LiteralPath $requestRoot -PathType Container)){continue}
   foreach($d in @(Get-ChildItem -LiteralPath $requestRoot -Directory|Where-Object Name -Match '^[a-f0-9-]{36}$'|Select-Object -First 64)){
    $requestFile=Join-Path $d.FullName 'request.json';$claim=Join-Path $d.FullName 'claim.json';if(-not(Test-Path -LiteralPath $requestFile) -or (Test-Path -LiteralPath $claim)){continue}
    try{$r=ReadJson $requestFile;$expiry=[DateTimeOffset]::Parse([string]$r.expiresAt)}catch{continue}
    if(@($r.Keys|Where-Object{$_ -notin @('action','operationId','runtimeId','expectedPid','releaseManifestSha256','expectedStartedAt','expiresAt')}).Count -or $r.action -notin @('drain-and-stop','activate-monitor') -or $r.operationId -cne $d.Name -or $r.runtimeId -cne $cfg.runtimeId -or $r.expectedPid -ne $child.Id -or $r.releaseManifestSha256 -cne $cfg.releaseManifestSha256 -or $expiry -lt [DateTimeOffset]::UtcNow -or $expiry -gt [DateTimeOffset]::UtcNow.AddSeconds(60)){continue}
    WriteJson $claim @{state='CLAIMED_INPUT_OUTCOME_UNKNOWN';operationId=$r.operationId;runtimeId=$cfg.runtimeId;pid=$child.Id;automaticReplay=$false}
    $r.controlNonce=$cfg.controlNonce;$child.StandardInput.WriteLine(($r|ConvertTo-Json -Compress));$child.StandardInput.Flush();break
   }
  }
  exit $child.ExitCode
 }catch{
  # Never convert supervisor uncertainty into proof that its child stopped.
  $errorFile=Join-Path $OperationRoot 'supervisor-error.json'
  if(-not(Test-Path -LiteralPath $errorFile)){WriteJson $errorFile @{schemaVersion=1;runtimeId=$cfg.runtimeId;supervisorPid=$PID;runtimePid=$(if($child){$child.Id}else{$null});state='SUPERVISOR_ERROR_PROCESS_PRESERVED';errorCode='SUPERVISOR_OPERATION_FAILED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');automaticReplay=$false}}
  throw
 }finally{if($child){$child.Dispose()};$lock.Dispose()}
}

if($Mode -eq 'Prepare'){
 if(Test-Path -LiteralPath $OperationRoot){throw 'fresh_operation_directory_required'}
 $base=Full $BaseRelease;if(-not (Within (Join-Path $OwnerRoot 'releases/cli') $base)){throw 'registered_private_release_required'}
 $baseManifest=Pinned (Join-Path $base '.aicc-release.json') $ExpectedBaseManifestSha256;$manifest=ReadJson $baseManifest
 if($manifest.schemaVersion -ne 1 -or $manifest.component -notin @('mobile-control','mobile-quota-control')){throw 'private_mobile_manifest_required'}
 $pins=@{};foreach($pin in $manifest.files){$file=Full (Join-Path $base $pin.path);if(-not(Within $base $file) -or $pins.ContainsKey($pin.path)){throw 'invalid_base_manifest_path'};[void](Pinned $file $pin.sha256);if((Get-Item -LiteralPath $file).Length -ne $pin.size){throw 'base_size_changed'};$pins[$pin.path]=$pin}
 $all=@(Get-ChildItem -LiteralPath $base -Recurse -Force -ErrorAction Stop);if(@($all|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count -or @($all|Where-Object{-not $_.PSIsContainer -and $_.FullName -ine $baseManifest}).Count -ne $pins.Count){throw 'base_inventory_mismatch'}
 # Device trust is an explicit required dependency absent from the old private release.
 # Do not deploy the current server or unrelated source files.
 $overlay=@('src/mobile-control.mjs','src/dashboard-workspace.mjs','public/dashboard-workspace.js','public/dashboard-workspace.css','public/aicc.webmanifest','public/aicc-sw.js','public/favicon.svg','src/management-overview.mjs','src/ocx-quota-dashboard.mjs','src/ocx-quota-slack-monitor.mjs','src/mobile-device-trust.mjs','public/mobile.html','public/mobile.js','public/mobile.css','public/ai-cowork.js','public/ai-cowork.json','public/mobile-quota.js','public/mobile-quota.css','src/mobile-tray-tools.mjs','public/mobile-tools.js','tools/platform/windows/tray-status.mjs','src/runtime-layout.mjs','src/private-home.mjs')
 $selected=@();foreach($relative in $overlay){$file=Regular (Join-Path $SourceRoot $relative);$selected+=@{path=$relative;sha256=(HashFile $file);size=(Get-Item -LiteralPath $file).Length}}
 $task=LegacyTask;$previous=$null;$oldPort=4382
 if($PreviousRuntimeConfig){
  $previousFile=Pinned $PreviousRuntimeConfig $ExpectedPreviousConfigSha256;$previousCfg=ReadJson $previousFile
  $previousOp=Split-Path -Parent $previousFile
  $promotion=RestartPromotion $previousOp;$previousConfigFiles=@($previousFile);$previousLaunchers=@((Join-Path $previousOp 'mobile-quota.hidden.vbs'))
  if($promotion){
   if($previousFile -notin @($promotion.originalConfig,$promotion.bootConfig) -or $promotion.runtimeId -cne $previousCfg.runtimeId -or $promotion.releaseManifestSha256 -cne $ExpectedBaseManifestSha256){throw 'previous_restart_authorization_mismatch'}
   $previousConfigFiles=@($promotion.originalConfig,$promotion.bootConfig);$previousLaunchers+=@($promotion.bootLauncher)
  }
  if(-not (Within (Join-Path $OwnerRoot 'backups') $previousFile) -or $previousCfg.ownerRoot -ine $OwnerRoot -or $previousCfg.port -notin @(4384,4385) -or (-not $LocalOnly -and $port -eq $previousCfg.port) -or ($LocalOnly -and $port -ne $previousCfg.port) -or $previousCfg.releaseRoot -ine $base -or $previousCfg.releaseManifestSha256 -cne $ExpectedBaseManifestSha256 -or $task.vbs -notin $previousLaunchers){throw 'exact_managed_previous_runtime_required'}
  $previousStatus=ReadJson (Join-Path $previousOp 'runtime-status.json')
  if($previousStatus.state -cne 'LISTENING' -or $previousStatus.runtimeId -cne $previousCfg.runtimeId -or $previousStatus.releaseManifestSha256 -cne $ExpectedBaseManifestSha256 -or $previousStatus.monitorStartCalls -ne 1 -or $previousStatus.port -ne $previousCfg.port){throw 'previous_runtime_not_listening'}
  $oldPort=[int]$previousCfg.port;$entry=Regular (Join-Path $previousOp 'Install-AiccMobileQuota.ps1')
  $previous=@{configFile=$previousFile;configSha256=$ExpectedPreviousConfigSha256;processConfigFiles=$previousConfigFiles;processLaunchers=$previousLaunchers;restartAuthorization=$(if($promotion){Join-Path $previousOp 'restart-authorization.json'}else{$null});restartAuthorizationSha256=$(if($promotion){HashFile (Join-Path $previousOp 'restart-authorization.json')}else{$null});operationRoot=$previousOp;runtimeId=$previousCfg.runtimeId;pid=$previousStatus.pid;startedAt=$previousStatus.startedAt;port=$oldPort;statusFile=(Join-Path $previousOp 'runtime-status.json');releaseRoot=$base;releaseManifestSha256=$ExpectedBaseManifestSha256}
 }else{
  if($LocalOnly){throw 'local_cutover_requires_exact_managed_previous_generation'}
  if($port -ne 4384){throw 'previous_managed_generation_required_for_4385'}
  $entry=Regular (Join-Path (Split-Path -Parent $task.vbs) 'mobile-control.mjs')
  if(-not [IO.File]::ReadAllText($entry).Contains(([Uri](Join-Path $base 'src/server.mjs')).AbsoluteUri)){throw 'legacy_entry_release_mismatch'}
 }
 $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop);$old=@($listeners|Where-Object{$_.LocalPort -eq $oldPort -and $_.LocalAddress -eq '127.0.0.1'});if($old.Count -ne 1 -or ($previous -and $old[0].OwningProcess -ne $previous.pid)){throw 'exact_legacy_listener_required'};if(-not $LocalOnly){ListenerFree}
 $configPath=Regular (Join-Path $OwnerRoot 'control-plane/mobile-control.json');$mobile=ReadJson $configPath;$origin=[Uri]$mobile.remoteOrigin
 if($origin.Scheme -cne 'https' -or $origin.Port -ne 8443 -or $origin.AbsolutePath -cne '/' -or $origin.GetLeftPart([UriPartial]::Authority) -cne $mobile.remoteOrigin){throw 'existing_private_https_origin_required'}
 $tailscale=$null;$serve='null'
 if(-not $LocalOnly){
  $tailscale=Regular ((Get-Command tailscale.exe -ErrorAction Stop).Source);$serve=ServeText $tailscale;$serveObj=$serve|ConvertFrom-Json -AsHashtable
  $hostKey=$origin.Authority
  if(-not $serveObj.Web -or -not $serveObj.Web.ContainsKey($hostKey)){throw 'existing_private_proxy_unavailable_check_tailscale_connection'}
  if($serveObj.Web[$hostKey].Handlers['/'].Proxy -cne ('http://127.0.0.1:'+$oldPort)){throw 'registered_private_root_proxy_required'}
 }
 [void](LedgerIdle)
 PrivateDirectory $OperationRoot;$op=[guid]::NewGuid().ToString('N');$dest=Join-Path $OwnerRoot ('releases/cli/mobile-quota-'+$op)
 if(Test-Path -LiteralPath $dest){throw 'fresh_candidate_required'};New-Item -ItemType Directory -Path $dest|Out-Null
 foreach($item in Get-ChildItem -LiteralPath $base -Force){Copy-Item -LiteralPath $item.FullName -Destination $dest -Recurse -Force}
 foreach($pin in $selected){$source=Pinned (Join-Path $SourceRoot $pin.path) $pin.sha256;$to=Join-Path $dest $pin.path;[IO.Directory]::CreateDirectory((Split-Path -Parent $to))|Out-Null;Copy-Item -LiteralPath $source -Destination $to -Force;$pins[$pin.path]=$pin}
 Copy-Item -LiteralPath $baseManifest -Destination (Join-Path $OperationRoot 'release-manifest.before.json')
 WriteNew (Join-Path $OperationRoot 'task.before.xml') $task.xml
 Copy-Item -LiteralPath $task.vbs -Destination (Join-Path $OperationRoot 'launcher.before.vbs')
 Copy-Item -LiteralPath $entry -Destination (Join-Path $OperationRoot 'entry.before.mjs')
 Copy-Item -LiteralPath $configPath -Destination (Join-Path $OperationRoot 'mobile-config.before.json')
 if($previous){Copy-Item -LiteralPath $previous.configFile -Destination (Join-Path $OperationRoot 'previous-runtime-config.before.json');Copy-Item -LiteralPath $previous.statusFile -Destination (Join-Path $OperationRoot 'previous-runtime-status.before.json')}
 WriteNew (Join-Path $OperationRoot 'tailscale.before.json') $serve
 $newManifest=@{schemaVersion=1;component='mobile-quota-control';operationId=$op;baseline=$base;baselineManifestSha256=$ExpectedBaseManifestSha256;fileCount=$pins.Count;totalBytes=($pins.Values|Measure-Object size -Sum).Sum;overlays=$selected;files=@($pins.Values|Sort-Object path)}
 # Only the new candidate manifest is replaced; the original immutable release is untouched.
 $mf=Join-Path $dest '.aicc-release.json';$temp=Join-Path $dest '.aicc-release.new.json';WriteJson $temp $newManifest;Move-Item -LiteralPath $temp -Destination (Full $mf) -Force -ErrorAction Stop
 $runner=Join-Path $OperationRoot 'mobile-quota-runner.mjs'
 $runnerText=@'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
// Failure metadata has no prompt, URL, nonce, command line or exception message.
const startupAt=new Date().toISOString();let startupStage='PIN_CHECK';
process.once('uncaughtExceptionMonitor',()=>{try{const t=cfg.statusFile+'.'+process.pid+'.failure.tmp';fs.writeFileSync(t,JSON.stringify({schemaVersion:1,runtimeId:cfg.runtimeId,pid:process.pid,startedAt:startupAt,releaseManifestSha256:cfg.releaseManifestSha256,state:'START_FAILED',stage:startupStage,errorCode:'STARTUP_FAILED',automaticReplay:false,observedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});fs.renameSync(t,cfg.statusFile);}catch{}});
const hash=b=>createHash('sha256').update(b).digest('hex');
if(![4384,4385].includes(cfg.port)||path.resolve(process.env.AICC_STATE_ROOT||'')!==path.resolve(cfg.ownerRoot))throw Error('runtime_owner_mismatch');
if(hash(fs.readFileSync(path.join(cfg.releaseRoot,'.aicc-release.json')))!==cfg.releaseManifestSha256)throw Error('runtime_manifest_changed');
const manifest=JSON.parse(fs.readFileSync(path.join(cfg.releaseRoot,'.aicc-release.json'),'utf8').replace(/^\uFEFF/,''));
for(const p of manifest.files){const f=path.resolve(cfg.releaseRoot,p.path);if(!f.startsWith(path.resolve(cfg.releaseRoot)+path.sep)||fs.lstatSync(f).isSymbolicLink()||hash(fs.readFileSync(f))!==p.sha256)throw Error('runtime_pin_changed');}
startupStage='IMPORTS';
const {startServer}=await import(pathToFileURL(path.join(cfg.releaseRoot,'src/server.mjs')).href);
const {createOcxQuotaDashboard}=await import(pathToFileURL(path.join(cfg.releaseRoot,'src/ocx-quota-dashboard.mjs')).href);
const {createOcxQuotaSlackMonitor}=await import(pathToFileURL(path.join(cfg.releaseRoot,'src/ocx-quota-slack-monitor.mjs')).href);
const dashboard=createOcxQuotaDashboard({ownerRoot:cfg.ownerRoot});
const monitor=createOcxQuotaSlackMonitor({dashboard,ownerRoot:cfg.ownerRoot});
const status={schemaVersion:1,runtimeId:cfg.runtimeId,pid:process.pid,startedAt:startupAt,releaseManifestSha256:cfg.releaseManifestSha256,state:'STARTING',port:cfg.port,automaticReplay:false,restartAuthorizationSource:cfg.restartAuthorizationSource||null};
function record(update){Object.assign(status,update,{observedAt:new Date().toISOString()});const t=cfg.statusFile+'.'+process.pid+'.tmp';fs.writeFileSync(t,JSON.stringify(status)+'\n',{flag:'wx',mode:0o600});fs.renameSync(t,cfg.statusFile);}
let mobileControl;let activeHttpRequests=0;startupStage='LISTEN';
const server=startServer({host:'127.0.0.1',port:cfg.port,backgroundOpenaiMonitor:false,backgroundDesignSourceMonitor:false,backgroundRecoveryHandoff:false,mobile:{remoteOrigin:cfg.remoteOrigin,quotaDashboard:dashboard,quotaMonitor:monitor,onControlReady:control=>{mobileControl=control;}}});
if(typeof mobileControl?.beginMaintenance!=='function')throw Error('normal_mobile_drain_required');
server.prependListener('request',(_req,res)=>{activeHttpRequests++;let finished=false;const finish=()=>{if(!finished){finished=true;activeHttpRequests--;}};res.once('finish',finish);res.once('close',finish);});
let monitorStarted=false;
server.once('listening',()=>{try{if(cfg.monitorStandby){record({state:'LISTENING_STANDBY',monitorStartCalls:0});return;}if(monitorStarted)throw Error('monitor_duplicate_start');monitorStarted=true;monitor.start();record({state:'LISTENING',monitorStartCalls:1});}catch{record({state:'MONITOR_START_UNKNOWN'});}});
server.once('error',e=>{record({state:'START_FAILED',errorCode:/^[A-Z0-9_]{1,64}$/.test(e.code||'')?e.code:'UNKNOWN'});process.exitCode=1;});
const seen=new Set();const control=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
control.on('line',async line=>{if(line.length>4096)return;let r;try{r=JSON.parse(line);}catch{return;}
if(Object.keys(r).some(k=>!['action','operationId','runtimeId','expectedPid','releaseManifestSha256','controlNonce','expectedStartedAt','expiresAt'].includes(k))||!['drain-and-stop','activate-monitor'].includes(r.action)||!/^[a-f0-9-]{36}$/.test(r.operationId||'')||r.runtimeId!==cfg.runtimeId||r.expectedPid!==process.pid||r.releaseManifestSha256!==cfg.releaseManifestSha256||r.controlNonce!==cfg.controlNonce||r.expectedStartedAt!==status.startedAt||!Number.isFinite(Date.parse(r.expiresAt))||Date.parse(r.expiresAt)<Date.now()||Date.parse(r.expiresAt)>Date.now()+60000||seen.has(r.operationId))return;
seen.add(r.operationId);
if(r.action==='activate-monitor'){
 if(status.state!=='LISTENING_STANDBY'||monitorStarted){record({lastActivationResult:'STATE_PRESERVED',lastActivationOperationId:r.operationId});return;}
 if(!cfg.previousRuntime){record({lastActivationResult:'PREVIOUS_GENERATION_REQUIRED',lastActivationOperationId:r.operationId});return;}
 const previous=JSON.parse(fs.readFileSync(cfg.previousRuntime.statusFile,'utf8').replace(/^\uFEFF/,''));
 if(previous.runtimeId!==cfg.previousRuntime.runtimeId||previous.pid!==cfg.previousRuntime.pid||previous.startedAt!==cfg.previousRuntime.startedAt||previous.releaseManifestSha256!==cfg.previousRuntime.releaseManifestSha256||previous.state!=='NORMAL_STOPPED'||previous.lastStopResult!=='NORMAL_STOP_ACK'){record({lastActivationResult:'PREVIOUS_STOP_UNCONFIRMED',lastActivationOperationId:r.operationId});return;}
 let previousExists=true;try{process.kill(cfg.previousRuntime.pid,0);}catch(e){if(e.code==='ESRCH')previousExists=false;}
 if(previousExists){record({lastActivationResult:'PREVIOUS_PROCESS_PRESERVED',lastActivationOperationId:r.operationId});return;}
 monitorStarted=true;try{monitor.start();record({state:'LISTENING',monitorStartCalls:1,lastActivationResult:'ACTIVATED',lastActivationOperationId:r.operationId});}catch{record({state:'MONITOR_START_UNKNOWN',monitorStartCalls:1,lastActivationResult:'UNKNOWN',lastActivationOperationId:r.operationId});}return;
}
if(!['LISTENING','LISTENING_STANDBY'].includes(status.state)){record({lastStopResult:'STATE_PRESERVED',lastOperationId:r.operationId});return;}
const monitorState=monitor.status();if(activeHttpRequests||monitorState.inFlight!==false||monitorState.unresolvedDeliveryCount!==0){record({lastStopResult:'WORK_PRESERVED',lastOperationId:r.operationId});return;}
const gate=mobileControl.beginMaintenance();if(!gate.accepted){record({lastStopResult:'WORK_PRESERVED',lastOperationId:r.operationId});return;}
record({state:'DRAINING',lastOperationId:r.operationId});await monitor.stop();
server.close(e=>{record({state:e?'STOP_RESULT_UNKNOWN':'NORMAL_STOPPED',lastStopResult:e?'UNKNOWN':'NORMAL_STOP_ACK'});control.close();if(e)process.exitCode=1;});});
control.once('close',()=>{if(!['NORMAL_STOPPED','STOP_RESULT_UNKNOWN'].includes(status.state))record({controlChannel:'CLOSED',processPreserved:true});});
'@
 WriteNew $runner $runnerText
 $node=Regular (Join-Path $env:LOCALAPPDATA 'Programs/AICC-Tools/node-v22.23.2-win-x64/node.exe');$pwsh=Regular (Join-Path $PSHOME 'pwsh.exe')
 $bootstrap=Join-Path $OperationRoot 'Install-AiccMobileQuota.ps1';Copy-Item -LiteralPath (Regular $PSCommandPath) -Destination $bootstrap
 $cfg=@{schemaVersion=1;runtimeId=[guid]::NewGuid().ToString();controlNonce=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant();ownerRoot=$OwnerRoot;releaseRoot=$dest;releaseManifestSha256=(HashFile $mf);port=$port;remoteOrigin=$mobile.remoteOrigin;runnerFile=$runner;runnerSha256=(HashFile $runner);nodeExecutable=$node;nodeSha256=(HashFile $node);statusFile=(Join-Path $OperationRoot 'runtime-status.json');monitorStandby=($null -ne $previous);previousRuntime=$previous}
 $config=Join-Path $OperationRoot 'runtime-config.json';WriteJson $config $cfg
 $launcher=Join-Path $OperationRoot 'mobile-quota.hidden.vbs'
 $command='"'+$pwsh+'" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$bootstrap+'" -Mode Run -OperationRoot "'+$OperationRoot+'" -ConfigFile "'+$config+'" -ExpectedConfigSha256 '+(HashFile $config)
 if($command -match '[\r\n]'){throw 'invalid_launcher_argument'}
 WriteNew $launcher ("Option Explicit`r`nDim s`r`nSet s=CreateObject(""WScript.Shell"")`r`nWScript.Quit s.Run("""+$command.Replace('"','""')+""",0,True)`r`n")
 $plan=@{schemaVersion=1;state='PREPARED_NOT_APPLIED';operationId=$op;ownerRoot=$OwnerRoot;candidateRoot=$dest;candidateManifestSha256=(HashFile $mf);overlays=$selected;legacyPid=$old[0].OwningProcess;legacyPort=$oldPort;previousRuntime=$previous;legacyEntry=$entry;legacyEntrySha256=(HashFile $entry);legacyVbs=$task.vbs;legacyVbsSha256=(HashFile $task.vbs);taskXmlSha256=(HashText $task.xml);mobileConfig=$configPath;mobileConfigSha256=(HashFile $configPath);remoteOrigin=$mobile.remoteOrigin;tailscaleExecutable=$tailscale;tailscaleSha256=$(if($tailscale){HashFile $tailscale}else{$null});serveBeforeSha256=(HashText $serve);runtimeConfig=$config;runtimeConfigSha256=(HashFile $config);launcher=$launcher;launcherSha256=(HashFile $launcher);bootstrap=$bootstrap;bootstrapSha256=(HashFile $bootstrap);runner=$runner;runnerSha256=(HashFile $runner);newPort=$port;preservedPorts=@(4382,4383,443);testsRun=$false;functionalVerification='NOT_RUN';deviceTrustModified=$false;legacyInMemoryWork='Existing managed runtime drains normally after cutover; no session/preview replay. Legacy4382 preserved.';sessionMigration='Existing origin-bound trusted devices are reused. CSRF/session state refreshes normally; previews are never transferred.';automaticReplay=$false}
 $plan.networkMode=if($LocalOnly){'local-only-same-port-preserve-network'}else{'existing-private-tailscale-cutover'}
 if($LocalOnly){$plan.tailscaleSha256=$null;$plan.legacyInMemoryWork='Exact previous generation drains normally before same-port start; network is untouched.'}
 WriteJson (Join-Path $OperationRoot 'plan.json') $plan
 @{state=$plan.state;planFile=(Join-Path $OperationRoot 'plan.json');planSha256=(HashFile (Join-Path $OperationRoot 'plan.json'));normalStop='nonce-bound stdin; exact generation/PID/start/preimage; no public shutdown';verification='NOT_RUN'}|ConvertTo-Json
 return
}

$planPath=Pinned $PlanFile $ExpectedPlanSha256
if(-not (Within $OperationRoot $planPath)){throw 'owned_exact_plan_required'}
$plan=ReadJson $planPath
if($plan.schemaVersion -ne 1 -or $plan.ownerRoot -ine $OwnerRoot -or $plan.newPort -notin @(4384,4385)){throw 'private_mobile_plan_required'}
$port=[int]$plan.newPort
$cfg=ReadJson (Pinned $plan.runtimeConfig $plan.runtimeConfigSha256)
$localCutover=$plan.networkMode -ceq 'local-only-same-port-preserve-network'
if($localCutover){if(-not $plan.previousRuntime -or $plan.newPort -ne $plan.previousRuntime.port){throw 'local_same_port_previous_generation_required'};$tailscale=$null}else{$tailscale=Pinned $plan.tailscaleExecutable $plan.tailscaleSha256}
function ExactStartedRuntime($plan,$cfg,$receipt){
 $status=ReadJson (Join-Path $OperationRoot 'runtime-status.json')
 $ready=($status.state -ceq 'LISTENING' -and $status.monitorStartCalls -eq 1) -or ($cfg.monitorStandby -eq $true -and $status.state -ceq 'LISTENING_STANDBY' -and $status.monitorStartCalls -eq 0)
 if(-not $ready -or $status.runtimeId -cne $cfg.runtimeId -or $status.releaseManifestSha256 -cne $plan.candidateManifestSha256 -or $status.port -ne $port -or $status.pid -lt 1){throw 'exact_original_start_ack_required'}
 if($status.startedAt -isnot [string] -or $status.startedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$'){throw 'offset_bound_runtime_start_required'}
 $started=[DateTimeOffset]::Parse($status.startedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None)
 $child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$status.pid) -ErrorAction Stop
 if(-not $child -or -not $child.CommandLine -or $child.ExecutablePath -ine $cfg.nodeExecutable -or -not $child.CommandLine.Contains([string]$cfg.runnerFile,[StringComparison]::OrdinalIgnoreCase) -or -not $child.CommandLine.Contains([string]$plan.runtimeConfig,[StringComparison]::OrdinalIgnoreCase)){throw 'original_node_identity_unknown'}
 $created=[DateTimeOffset]$child.CreationDate
 if($created -gt $started -or $started -gt $created.AddMinutes(10) -or $started -gt [DateTimeOffset]::UtcNow){throw 'original_node_creation_mismatch'}
 $supervisor=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$child.ParentProcessId) -ErrorAction Stop
 $launcher=if($supervisor){Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$supervisor.ParentProcessId) -ErrorAction Stop}else{$null}
 if(-not $supervisor -or -not $supervisor.CommandLine -or -not $supervisor.CommandLine.Contains([string]$plan.bootstrap,[StringComparison]::OrdinalIgnoreCase) -or -not $supervisor.CommandLine.Contains([string]$plan.runtimeConfig,[StringComparison]::OrdinalIgnoreCase) -or -not $launcher -or $launcher.ProcessId -ne $receipt.launcherPid -or -not $launcher.CommandLine -or -not $launcher.CommandLine.Contains([string]$plan.launcher,[StringComparison]::OrdinalIgnoreCase)){throw 'original_launcher_chain_unknown'}
 $supervisorCreated=[DateTimeOffset]$supervisor.CreationDate;$launcherCreated=[DateTimeOffset]$launcher.CreationDate
 if($launcherCreated -gt $supervisorCreated -or $supervisorCreated -gt $created -or $started -lt $launcherCreated){throw 'original_process_generation_order_mismatch'}
 $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -EQ $port)
 if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne $status.pid){throw 'original_runtime_listener_mismatch'}
 return $status
}
function FutureTaskUnchanged($plan){
 $task=LegacyTask
 $promotion=RestartPromotion $OperationRoot
 if(($task.vbs -ine $plan.launcher -and (-not $promotion -or $promotion.operationId -cne $plan.operationId -or $promotion.originalConfigSha256 -cne $plan.runtimeConfigSha256 -or $task.vbs -ine $promotion.bootLauncher)) -or $task.task.Actions[0].WorkingDirectory -ine $OperationRoot){throw 'future_task_action_changed'}
 $before=[xml]::new();$before.PreserveWhitespace=$false;$before.LoadXml((Get-Content -LiteralPath (Regular (Join-Path $OperationRoot 'task.before.xml')) -Raw -Encoding utf8))
 $now=[xml]::new();$now.PreserveWhitespace=$false;$now.LoadXml($task.xml)
 foreach($doc in @($before,$now)){$node=$doc.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="Actions"]');if(-not $node){throw 'task_actions_contract_missing'};[void]$node.ParentNode.RemoveChild($node)}
 if($before.OuterXml -cne $now.OuterXml){throw 'task_nonaction_definition_changed'}
}
function PreviousManagedState($plan,[switch]$RequireLive){
 $previous=$plan.previousRuntime
 if(-not $previous){throw 'previous_managed_generation_required'}
 $previousCfg=ReadJson (Pinned $previous.configFile $previous.configSha256)
 if($previous.restartAuthorization){[void](Pinned $previous.restartAuthorization $previous.restartAuthorizationSha256);[void](RestartPromotion $previous.operationRoot)}
 if($previousCfg.runtimeId -cne $previous.runtimeId -or $previousCfg.releaseRoot -ine $previous.releaseRoot -or $previousCfg.releaseManifestSha256 -cne $previous.releaseManifestSha256 -or $previousCfg.ownerRoot -ine $OwnerRoot -or $previousCfg.port -ne $previous.port){throw 'previous_generation_config_changed'}
 $status=ReadJson $previous.statusFile
 if($status.runtimeId -cne $previous.runtimeId -or $status.pid -ne $previous.pid -or $status.startedAt -cne $previous.startedAt -or $status.releaseManifestSha256 -cne $previous.releaseManifestSha256 -or $status.port -ne $previous.port){throw 'previous_runtime_status_changed'}
 if($RequireLive){
  if($status.state -cne 'LISTENING' -or $status.monitorStartCalls -ne 1){throw 'previous_runtime_not_live'}
  $child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$previous.pid) -ErrorAction Stop
  $allowedConfigs=if($previous.processConfigFiles){@($previous.processConfigFiles)}else{@($previous.configFile)}
  $matchedConfig=@($allowedConfigs|Where-Object{$child -and $child.CommandLine -and $child.CommandLine.Contains([string]$_,[StringComparison]::OrdinalIgnoreCase)})
  if(-not $child -or -not $child.CommandLine -or $child.ExecutablePath -ine $previousCfg.nodeExecutable -or -not $child.CommandLine.Contains([string]$previousCfg.runnerFile,[StringComparison]::OrdinalIgnoreCase) -or $matchedConfig.Count -ne 1){throw 'previous_process_identity_unknown'}
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$child.ParentProcessId) -ErrorAction Stop
  $launcher=if($parent){Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$parent.ParentProcessId) -ErrorAction Stop}else{$null}
  $allowedLaunchers=if($previous.processLaunchers){@($previous.processLaunchers)}else{@($plan.legacyVbs)}
  $matchedLauncher=@($allowedLaunchers|Where-Object{$launcher -and $launcher.CommandLine -and $launcher.CommandLine.Contains([string]$_,[StringComparison]::OrdinalIgnoreCase)})
  if(-not $parent -or -not $parent.CommandLine -or -not $parent.CommandLine.Contains([string]$plan.legacyEntry,[StringComparison]::OrdinalIgnoreCase) -or -not $parent.CommandLine.Contains([string]$matchedConfig[0],[StringComparison]::OrdinalIgnoreCase) -or -not $launcher -or -not $launcher.CommandLine -or $matchedLauncher.Count -ne 1){throw 'previous_process_lineage_unknown'}
  $started=[DateTimeOffset]::Parse($previous.startedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None)
  $born=[DateTimeOffset]$child.CreationDate;$parentBorn=[DateTimeOffset]$parent.CreationDate;$launcherBorn=[DateTimeOffset]$launcher.CreationDate
  if($launcherBorn -gt $parentBorn -or $parentBorn -gt $born -or $born -gt $started -or $started -gt $born.AddMinutes(10)){throw 'previous_process_generation_mismatch'}
  $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -EQ $previous.port)
  if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne $previous.pid){throw 'previous_listener_owner_mismatch'}
 }
 return $status
}
function AdvancePreviousDrainAndMonitor($plan,$cfg,$receipt,[string]$attempt,[switch]$DrainOnly){
 if(-not $plan.previousRuntime){return}
 $previous=$plan.previousRuntime
 if(-not $receipt.ContainsKey('previousStopOperationId')){
  $statusBeforeDrain=PreviousManagedState $plan -RequireLive;[void](LedgerIdle)
  $requestRoot=Join-Path $previous.operationRoot 'stop-requests'
  if(Test-Path -LiteralPath $requestRoot){
   # Keep old claims. Only an exact completed activation may precede a new stop.
   # Across an authorized restart, its original PID/start pair comes from the
   # immutable completed-deployment receipt, not from a current-generation guess.
   $rootItem=Get-Item -LiteralPath $requestRoot -Force
   if(-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'previous_control_request_exists_reconcile_original'}
   $entries=@(Get-ChildItem -LiteralPath $requestRoot -Force)
   if($entries.Count -ne 1 -or -not $entries[0].PSIsContainer -or ($entries[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -or $statusBeforeDrain.state -cne 'LISTENING' -or $statusBeforeDrain.monitorStartCalls -ne 1){throw 'previous_control_request_exists_reconcile_original'}
   $activationDir=$entries[0].FullName;$activationFiles=@(Get-ChildItem -LiteralPath $activationDir -Force)
   if($activationFiles.Count -ne 2 -or @($activationFiles|Where-Object{$_.PSIsContainer -or $_.Name -notin @('request.json','claim.json')}).Count){throw 'previous_control_request_exists_reconcile_original'}
   $activation=ReadJson (Join-Path $activationDir 'request.json');$activationClaim=ReadJson (Join-Path $activationDir 'claim.json')
   if($activation.action -cne 'activate-monitor' -or $activation.operationId -cne $entries[0].Name -or $activation.runtimeId -cne $previous.runtimeId -or $activation.releaseManifestSha256 -cne $previous.releaseManifestSha256 -or $activationClaim.state -cne 'CLAIMED_INPUT_OUTCOME_UNKNOWN' -or $activationClaim.operationId -cne $activation.operationId -or $activationClaim.runtimeId -cne $previous.runtimeId -or $activationClaim.pid -ne $activation.expectedPid -or $activationClaim.automaticReplay -ne $false){throw 'previous_control_request_exists_reconcile_original'}
   $sameGenerationAck=$activation.expectedPid -eq $previous.pid -and $activation.expectedStartedAt -ceq $previous.startedAt -and $statusBeforeDrain.lastActivationOperationId -ceq $activation.operationId -and $statusBeforeDrain.lastActivationResult -ceq 'ACTIVATED'
   if(-not $sameGenerationAck){
    $restartProof=RestartPromotion $previous.operationRoot
    if(-not $restartProof -or $restartProof.activationOperationId -cne $activation.operationId -or $restartProof.runtimeId -cne $previous.runtimeId -or $restartProof.releaseManifestSha256 -cne $previous.releaseManifestSha256){throw 'previous_control_request_exists_reconcile_original'}
    $completedActivation=ReadJson $restartProof.completedReceipt
    if($completedActivation.runtimePid -ne $activation.expectedPid -or $completedActivation.startedAt -cne $activation.expectedStartedAt -or $completedActivation.monitorActivationOperationId -cne $activation.operationId -or $completedActivation.monitorActivated -ne $true -or $completedActivation.monitorStartCalls -ne 1){throw 'previous_control_request_exists_reconcile_original'}
   }
  }
  $stopId=[guid]::NewGuid().ToString();$receipt.previousStopOperationId=$stopId;$receipt.previousStopRequested=$true;$receipt.state='PREVIOUS_DRAIN_DISPATCHING';UpdateJson $attempt $receipt
  if(-not(Test-Path -LiteralPath $requestRoot)){PrivateDirectory $requestRoot};$requestDir=Join-Path $requestRoot $stopId;PrivateDirectory $requestDir
  WriteJson (Join-Path $requestDir 'request.json') @{action='drain-and-stop';operationId=$stopId;runtimeId=$previous.runtimeId;expectedPid=$previous.pid;releaseManifestSha256=$previous.releaseManifestSha256;expectedStartedAt=$previous.startedAt;expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(60).ToString('o')}
 }
 $until=[DateTimeOffset]::UtcNow.AddSeconds(20);$previousStatus=$null
 while([DateTimeOffset]::UtcNow -lt $until){
  $previousStatus=PreviousManagedState $plan
  if($previousStatus.state -ceq 'NORMAL_STOPPED' -and $previousStatus.lastStopResult -ceq 'NORMAL_STOP_ACK' -and $previousStatus.lastOperationId -ceq $receipt.previousStopOperationId -and -not (Get-Process -Id $previous.pid -ErrorAction SilentlyContinue)){break}
  if($previousStatus.lastOperationId -ceq $receipt.previousStopOperationId -and $previousStatus.lastStopResult -in @('WORK_PRESERVED','STATE_PRESERVED','NOT_LISTENING_PRESERVED')){throw 'previous_work_preserved_no_forced_stop'}
  Start-Sleep -Milliseconds 250
 }
 if($previousStatus.state -cne 'NORMAL_STOPPED' -or $previousStatus.lastStopResult -cne 'NORMAL_STOP_ACK' -or $previousStatus.lastOperationId -cne $receipt.previousStopOperationId -or (Get-Process -Id $previous.pid -ErrorAction SilentlyContinue)){throw 'previous_normal_stop_unknown_reconcile_same_request'}
 if(($DrainOnly -or -not $localCutover) -and @(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -EQ $previous.port).Count){throw 'previous_port_ownership_preserved'}
 $receipt.previousNormalStopped=$true;$receipt.state='PREVIOUS_NORMAL_STOPPED';UpdateJson $attempt $receipt
 if($DrainOnly){return}
 $newStatus=ExactStartedRuntime $plan $cfg $receipt
 if($receipt.ContainsKey('monitorActivationOperationId')){
  # No second activation request is generated if delivery or result is uncertain.
  if($newStatus.state -cne 'LISTENING' -or $newStatus.monitorStartCalls -ne 1 -or $newStatus.lastActivationOperationId -cne $receipt.monitorActivationOperationId -or $newStatus.lastActivationResult -cne 'ACTIVATED'){throw 'monitor_activation_unknown_reconcile_same_request'}
 }else{
  if($newStatus.state -cne 'LISTENING_STANDBY' -or $newStatus.monitorStartCalls -ne 0){throw 'new_monitor_not_standby'}
  $activationId=[guid]::NewGuid().ToString();$requestRoot=Join-Path $OperationRoot 'stop-requests'
  if(Test-Path -LiteralPath $requestRoot){throw 'new_control_request_exists_reconcile_original'}
  $receipt.monitorActivationOperationId=$activationId;$receipt.monitorActivationAttempts=1;$receipt.state='MONITOR_ACTIVATION_DISPATCHING';UpdateJson $attempt $receipt
  PrivateDirectory $requestRoot;$requestDir=Join-Path $requestRoot $activationId;PrivateDirectory $requestDir
  WriteJson (Join-Path $requestDir 'request.json') @{action='activate-monitor';operationId=$activationId;runtimeId=$cfg.runtimeId;expectedPid=$newStatus.pid;releaseManifestSha256=$plan.candidateManifestSha256;expectedStartedAt=$newStatus.startedAt;expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(60).ToString('o')}
  $until=[DateTimeOffset]::UtcNow.AddSeconds(20)
  while([DateTimeOffset]::UtcNow -lt $until){$newStatus=ExactStartedRuntime $plan $cfg $receipt;if($newStatus.state -ceq 'LISTENING' -and $newStatus.lastActivationOperationId -ceq $activationId -and $newStatus.lastActivationResult -ceq 'ACTIVATED'){break};Start-Sleep -Milliseconds 250}
  if($newStatus.state -cne 'LISTENING' -or $newStatus.lastActivationOperationId -cne $activationId -or $newStatus.lastActivationResult -cne 'ACTIVATED'){throw 'monitor_activation_unknown_reconcile_same_request'}
 }
 $receipt.monitorActivated=$true;$receipt.monitorStartCalls=1
}
function PromoteCompletedRestart($plan,$cfg,$receipt){
 if(-not $cfg.monitorStandby){return}
 if($receipt.state -cne 'APPLIED_NOT_VERIFIED' -or $receipt.operationId -cne $plan.operationId -or $receipt.monitorActivated -ne $true -or $receipt.monitorStartCalls -ne 1 -or $receipt.monitorActivationAttempts -ne 1 -or $receipt.previousNormalStopped -ne $true){throw 'completed_monitor_activation_required_for_restart'}
 $promotionAttempt=Join-Path $OperationRoot 'restart-promotion-attempt.json'
 $authorization=RestartPromotion $OperationRoot
 if(-not $authorization){
  # These new immutable artifacts authorize future starts only. They never alter
  # the original cfg, operation/claim, running process, or old activation request.
  if(Test-Path -LiteralPath $promotionAttempt){throw 'restart_promotion_outcome_unknown_reconcile_artifacts'}
  FutureTaskUnchanged $plan
  $completed=Join-Path $OperationRoot 'restart-completed-receipt.json';WriteJson $completed $receipt
  $bootCfg=ReadJson (Pinned $plan.runtimeConfig $plan.runtimeConfigSha256)
  $bootCfg.monitorStandby=$false;$bootCfg.restartAuthorizationSource='completed-deployment:'+$plan.operationId+':'+$receipt.monitorActivationOperationId
  $bootConfig=Join-Path $OperationRoot 'runtime-config.restart.json';WriteJson $bootConfig $bootCfg
  $bootLauncher=Join-Path $OperationRoot 'mobile-quota.restart.hidden.vbs'
  $originalLauncher=[IO.File]::ReadAllText((Pinned $plan.launcher $plan.launcherSha256))
  if(([regex]::Matches($originalLauncher,[regex]::Escape([string]$plan.runtimeConfig))).Count -ne 1 -or ([regex]::Matches($originalLauncher,[regex]::Escape([string]$plan.runtimeConfigSha256))).Count -ne 1){throw 'restart_launcher_preimage_contract_changed'}
  WriteNew $bootLauncher ($originalLauncher.Replace([string]$plan.runtimeConfig,$bootConfig).Replace([string]$plan.runtimeConfigSha256,(HashFile $bootConfig)))
  $authorization=@{schemaVersion=1;state='AUTHORIZED_AFTER_APPLIED';operationId=$plan.operationId;runtimeId=$cfg.runtimeId;releaseManifestSha256=$plan.candidateManifestSha256;activationOperationId=$receipt.monitorActivationOperationId;monitorActivated=$true;monitorStartCalls=1;previousNormalStopped=$true;originalConfig=$plan.runtimeConfig;originalConfigSha256=$plan.runtimeConfigSha256;bootConfig=$bootConfig;bootConfigSha256=(HashFile $bootConfig);bootLauncher=$bootLauncher;bootLauncherSha256=(HashFile $bootLauncher);bootstrap=$plan.bootstrap;bootstrapSha256=$plan.bootstrapSha256;runner=$plan.runner;runnerSha256=$plan.runnerSha256;completedReceipt=$completed;completedReceiptSha256=(HashFile $completed);authorizedAt=[DateTimeOffset]::UtcNow.ToString('o');automaticReplay=$false;processRestarted=$false;oldActivationReplayed=$false}
  WriteJson (Join-Path $OperationRoot 'restart-authorization.json') $authorization
 }
 if($authorization.operationId -cne $plan.operationId -or $authorization.originalConfigSha256 -cne $plan.runtimeConfigSha256){throw 'restart_authorization_original_plan_changed'}
 FutureTaskUnchanged $plan;$task=LegacyTask
 if(Test-Path -LiteralPath $promotionAttempt){
  $prior=ReadJson $promotionAttempt
  if($prior.operationId -cne $plan.operationId -or $prior.bootLauncherSha256 -cne $authorization.bootLauncherSha256 -or $prior.state -notin @('FUTURE_TASK_DISPATCHING','FUTURE_TASK_UPDATED') -or $task.vbs -ine $authorization.bootLauncher){throw 'restart_task_outcome_unknown_do_not_replay'}
  if($prior.state -ceq 'FUTURE_TASK_DISPATCHING'){$prior.state='FUTURE_TASK_UPDATED';$prior.resultReconciled=$true;UpdateJson $promotionAttempt $prior}
  return
 }
 if($task.vbs -ine $plan.launcher){throw 'restart_task_preimage_changed'}
 $promotion=@{schemaVersion=1;state='FUTURE_TASK_DISPATCHING';operationId=$plan.operationId;bootLauncherSha256=$authorization.bootLauncherSha256;taskXmlBeforeSha256=(HashText $task.xml);automaticReplay=$false;processRestarted=$false;oldActivationReplayed=$false;functionalVerification='NOT_RUN'}
 WriteJson $promotionAttempt $promotion
 $action=New-ScheduledTaskAction -Execute $task.task.Actions[0].Execute -Argument ('/b /nologo "'+$authorization.bootLauncher+'"') -WorkingDirectory $OperationRoot
 Set-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -ErrorAction Stop|Out-Null
 $promotion.state='FUTURE_TASK_UPDATED';UpdateJson $promotionAttempt $promotion
}
function CompleteOriginalCutover($plan,$cfg,$receipt,[string]$attempt){
 if($receipt.operationId -cne $plan.operationId -or $receipt.startAttempts -ne 1 -or $receipt.taskUpdated -ne $true -or -not $receipt.launcherPid){throw 'original_single_start_receipt_required'}
 [void](Pinned (Join-Path $plan.candidateRoot '.aicc-release.json') $plan.candidateManifestSha256)
 foreach($name in @('launcher','bootstrap','runner')){[void](Pinned $plan[$name] $plan[$name+'Sha256'])}
 [void](Pinned $plan.legacyEntry $plan.legacyEntrySha256);[void](Pinned $plan.legacyVbs $plan.legacyVbsSha256)
 $expectedMobileHash=if($receipt.ContainsKey('mobileConfigExpectedSha256')){$receipt.mobileConfigExpectedSha256}else{$plan.mobileConfigSha256}
 [void](Pinned $plan.mobileConfig $expectedMobileHash)
 FutureTaskUnchanged $plan;[void](LedgerIdle)
 $status=ExactStartedRuntime $plan $cfg $receipt
 if($plan.previousRuntime -and -not $receipt.proxyAttempted -and -not $receipt.localCutoverAccepted -and $status.state -cne 'LISTENING_STANDBY'){throw 'new_generation_must_remain_standby_before_cutover'}
 $receipt.runtimePid=$status.pid;$receipt.startAcknowledged=$true;$receipt.startedAt=$status.startedAt
 $oldPort=if($plan.legacyPort){[int]$plan.legacyPort}else{4382}
 if($localCutover){
  if($receipt.previousNormalStopped -ne $true -or $receipt.proxyAttempted){throw 'local_previous_stop_required_network_preserved'}
  $receipt.localCutoverAccepted=$true;$receipt.networkModified=$false;$receipt.state='LOCAL_START_ACKNOWLEDGED';UpdateJson $attempt $receipt
 }else{
 $currentText=ServeText $tailscale;$current=$currentText|ConvertFrom-Json -AsHashtable
 $before=ReadJson (Join-Path $OperationRoot 'tailscale.before.json');$key=([Uri]$plan.remoteOrigin).Authority
 $oldPort=if($plan.legacyPort){[int]$plan.legacyPort}else{4382}
 $oldProxy='http://127.0.0.1:'+$oldPort;$newProxy='http://127.0.0.1:'+$port
 if((HashText ([IO.File]::ReadAllText((Join-Path $OperationRoot 'tailscale.before.json')))) -cne $plan.serveBeforeSha256){throw 'serve_backup_changed'}
 $expectedNew=([IO.File]::ReadAllText((Join-Path $OperationRoot 'tailscale.before.json'))|ConvertFrom-Json -AsHashtable)
 $expectedNew.Web[$key].Handlers['/'].Proxy=$newProxy
 if($receipt.proxyAttempted){
  # A previous attempt is never resent. Its observed exact desired result may be reconciled.
  if(($current|ConvertTo-Json -Depth 32 -Compress) -cne ($expectedNew|ConvertTo-Json -Depth 32 -Compress)){throw 'previous_proxy_outcome_unknown_do_not_replay'}
  $receipt.proxyReconciled=$true
 }else{
  if($plan.previousRuntime){[void](PreviousManagedState $plan -RequireLive)}
  if((HashText $currentText) -cne $plan.serveBeforeSha256 -or $current.Web[$key].Handlers['/'].Proxy -cne $oldProxy){throw 'original_serve_preimage_changed'}
  # Preserve all non-root handlers and all other ports. Only this named root action is dispatched.
  $receipt.proxyAttempted=$true;$receipt.state='PROXY_DISPATCHING';UpdateJson $attempt $receipt
  & $tailscale serve --bg --https=8443 --set-path=/ $newProxy|Out-Null
  if($LASTEXITCODE -ne 0){throw 'proxy_result_unknown_reconcile_original'}
  $receipt.proxyAccepted=$true
 }
 }
 $mobilePath=Regular $plan.mobileConfig;$actualHash=HashFile $mobilePath
 $expectedConfig=ReadJson (Join-Path $OperationRoot 'mobile-config.before.json')
 if((HashFile (Join-Path $OperationRoot 'mobile-config.before.json')) -cne $plan.mobileConfigSha256){throw 'mobile_config_backup_changed'}
 foreach($field in @('localUrl','privateLocalUrl')){
  if($expectedConfig.ContainsKey($field) -and $expectedConfig[$field] -is [string]){
   $url=$null
   if([Uri]::TryCreate($expectedConfig[$field],[UriKind]::Absolute,[ref]$url) -and $url.Scheme -ceq 'http' -and $url.Host -in @('127.0.0.1','localhost','[::1]')){
    # The owner's default entry may still name the preserved public generation.
    # Move only known mobile entries; custom paths and non-loopback URLs stay intact.
    $ownerEntry=$field -ceq 'localUrl' -and $url.Port -in @(4382,4383,4384,4385) -and $url.AbsolutePath -ceq '/mobile.html'
    if($url.Port -eq $oldPort -or $ownerEntry){$builder=[UriBuilder]::new($url);$builder.Port=$port;$expectedConfig[$field]=$builder.Uri.AbsoluteUri}
   }
  }
 }
 $configText=$expectedConfig|ConvertTo-Json -Depth 24;$desiredHash=HashText $configText
 if($receipt.ContainsKey('mobileConfigExpectedSha256')){
  if($receipt.mobileConfigExpectedSha256 -cne $desiredHash -or $actualHash -cne $desiredHash){throw 'previous_mobile_config_outcome_unknown'}
  $receipt.mobileConfigReconciled=$true
 }else{
  if($actualHash -cne $plan.mobileConfigSha256){throw 'mobile_config_preimage_changed'}
  $receipt.mobileConfigExpectedSha256=$desiredHash;$receipt.state='CONFIG_DISPATCHING';UpdateJson $attempt $receipt
  $temp=Join-Path (Split-Path -Parent $mobilePath) ('mobile-control.'+$plan.operationId+'.tmp')
  WriteNew $temp $configText
  if((HashFile $mobilePath) -cne $plan.mobileConfigSha256){throw 'mobile_config_changed_before_replace'}
  Move-Item -LiteralPath $temp -Destination (Full $mobilePath) -Force -ErrorAction Stop
  $receipt.mobileConfigUpdated=$true
 }
 AdvancePreviousDrainAndMonitor $plan $cfg $receipt $attempt
 $receipt.state='APPLIED_NOT_VERIFIED';$receipt.functionalVerification='NOT_RUN';$receipt.bootstrapImprovements='This operation ships its pinned bootstrap/runner; any previous operation files are preserved.'
 $receipt.transitionPolicy='New server standby -> root proxy once -> exact previous normal drain/exit -> new monitor activation once; uncertain delivery is never replayed.'
 if($localCutover){$receipt.transitionPolicy='Exact previous normal drain/exit -> same-port new standby -> monitor activation once; network untouched.'}
 UpdateJson $attempt $receipt
 PromoteCompletedRestart $plan $cfg $receipt
}
if($Mode -eq 'Reconcile'){
 $attempt=Regular (Join-Path $OperationRoot 'apply-attempt.json');$receipt=ReadJson $attempt
 $lock=[IO.File]::Open((Join-Path $OwnerRoot 'control-plane/mobile-quota-deployment.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{
  CompleteOriginalCutover $plan $cfg $receipt $attempt
  $receipt|ConvertTo-Json -Depth 8
 }catch{$receipt.state='HOLD_RECONCILE_ORIGINAL';$receipt.errorCode='RECONCILIATION_STAGE_FAILED';UpdateJson $attempt $receipt;throw}finally{$lock.Dispose()}
 return
}
if($Mode -eq 'Apply'){
 $attempt=Join-Path $OperationRoot 'apply-attempt.json';if(Test-Path -LiteralPath $attempt){throw 'apply_attempt_exists_reconcile_original'}
 [void](Pinned $plan.legacyEntry $plan.legacyEntrySha256);[void](Pinned $plan.legacyVbs $plan.legacyVbsSha256);[void](Pinned $plan.mobileConfig $plan.mobileConfigSha256)
 [void](Pinned (Join-Path $plan.candidateRoot '.aicc-release.json') $plan.candidateManifestSha256)
 foreach($name in @('launcher','bootstrap','runner')){[void](Pinned $plan[$name] $plan[$name+'Sha256'])}
 $task=LegacyTask;if((HashText $task.xml) -cne $plan.taskXmlSha256 -or $task.vbs -ine $plan.legacyVbs){throw 'private_task_preimage_changed'}
 if(-not $localCutover -and (HashText (ServeText $tailscale)) -cne $plan.serveBeforeSha256){throw 'serve_preimage_changed'}
 if(-not $localCutover){ListenerFree};[void](LedgerIdle)
 $oldPort=if($plan.legacyPort){[int]$plan.legacyPort}else{4382}
 $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object{$_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq $oldPort});if($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $plan.legacyPid){throw 'legacy_generation_changed'}
 if($plan.previousRuntime){[void](PreviousManagedState $plan -RequireLive)}
 $lock=[IO.File]::Open((Join-Path $OwnerRoot 'control-plane/mobile-quota-deployment.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $receipt=@{operationId=$plan.operationId;state='CLAIMED';taskUpdated=$false;startAttempts=0;proxyAttempted=$false;legacyStopped=$false;deviceTrustModified=$false;legacyInMemoryWork='UNKNOWN_PRESERVED_NOT_REPLAYED';functionalVerification='NOT_RUN';automaticReplay=$false}
 try{
  WriteJson $attempt $receipt
  if($localCutover){AdvancePreviousDrainAndMonitor $plan $cfg $receipt $attempt -DrainOnly;ListenerFree}
  $action=New-ScheduledTaskAction -Execute $task.task.Actions[0].Execute -Argument ('/b /nologo "'+$plan.launcher+'"') -WorkingDirectory $OperationRoot
  Set-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -ErrorAction Stop|Out-Null
  $receipt.taskUpdated=$true;$receipt.state='FUTURE_TASK_UPDATED';UpdateJson $attempt $receipt
  $receipt.startAttempts=1;$receipt.state='START_DISPATCHING';UpdateJson $attempt $receipt
  # Existing task remains running: one independent hidden invocation, not Start-ScheduledTask.
  $start=Start-Process -FilePath $task.task.Actions[0].Execute -ArgumentList @('/b','/nologo',('"'+$plan.launcher+'"')) -WindowStyle Hidden -PassThru -ErrorAction Stop
  $receipt.launcherPid=$start.Id;$receipt.state='START_ACCEPTED_NOT_VERIFIED';UpdateJson $attempt $receipt
  # Intrinsic startup acknowledgement only; no HTTP request or functional probe.
  # Whole immutable-release pinning precedes listening; a timeout preserves the one original start.
  $ackPath=Join-Path $OperationRoot 'runtime-status.json';$until=[DateTimeOffset]::UtcNow.AddSeconds(180);$ack=$null
  while([DateTimeOffset]::UtcNow -lt $until){if(Test-Path -LiteralPath $ackPath){$ack=ReadJson $ackPath;if($ack.runtimeId -cne $cfg.runtimeId -or $ack.releaseManifestSha256 -cne $plan.candidateManifestSha256){throw 'startup_generation_mismatch'};if($ack.state -ceq 'LISTENING' -or ($cfg.monitorStandby -and $ack.state -ceq 'LISTENING_STANDBY')){break};if($ack.state -in @('START_FAILED','MONITOR_START_UNKNOWN')){throw 'startup_outcome_requires_reconciliation'}};Start-Sleep -Milliseconds 250}
  if($ack.state -cne 'LISTENING' -and -not($cfg.monitorStandby -and $ack.state -ceq 'LISTENING_STANDBY')){throw 'startup_ack_unknown_original_proxy_preserved'}
  CompleteOriginalCutover $plan $cfg $receipt $attempt
  $receipt|ConvertTo-Json
 }catch{$receipt.state='HOLD_RECONCILE_ORIGINAL';$receipt.errorCode='DEPLOYMENT_STAGE_FAILED';UpdateJson $attempt $receipt;throw}finally{$lock.Dispose()}
 return
}

if($Mode -eq 'Rollback'){
 if($localCutover){throw 'local_same_port_rollback_requires_exact_owned_recovery_plan_no_network_action'}
 if($plan.previousRuntime){
  $previousState=PreviousManagedState $plan
  if($previousState.state -ceq 'NORMAL_STOPPED'){throw 'previous_generation_already_stopped_preserve_active_candidate_requires_owned_recovery_plan'}
  [void](PreviousManagedState $plan -RequireLive)
 }
 $statusFile=Join-Path $OperationRoot 'runtime-status.json'
 if(-not(Test-Path -LiteralPath $statusFile)){throw 'start_outcome_unknown_preserve_routing_and_process'}
 $status=ReadJson $statusFile
 if($status.runtimeId -cne $cfg.runtimeId -or $status.releaseManifestSha256 -cne $plan.candidateManifestSha256){throw 'exact_new_generation_required'}
 if($status.state -cne 'NORMAL_STOPPED'){
  if($status.state -notin @('LISTENING','LISTENING_STANDBY')){throw 'normal_stop_state_unknown_reconcile_original'}
  $stopRoot=Join-Path $OperationRoot 'stop-requests';if(Test-Path -LiteralPath $stopRoot){throw 'existing_stop_request_reconcile_do_not_replay'}
  PrivateDirectory $stopRoot;$stopId=[guid]::NewGuid().ToString();$requestDir=Join-Path $stopRoot $stopId;PrivateDirectory $requestDir
  WriteJson (Join-Path $requestDir 'request.json') @{action='drain-and-stop';operationId=$stopId;runtimeId=$cfg.runtimeId;expectedPid=$status.pid;releaseManifestSha256=$plan.candidateManifestSha256;expectedStartedAt=$status.startedAt;expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(60).ToString('o')}
  @{state='NORMAL_STOP_REQUESTED_NOT_REPLAYED';operationId=$stopId;routingRestored=$false;next='Reconcile exact normal stop ACK and actual exit, then explicitly invoke Rollback again.'}|ConvertTo-Json;return
 }
 if(Get-Process -Id $status.pid -ErrorAction SilentlyContinue){throw 'exact_runner_exit_unconfirmed'}
 if(@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -EQ $port).Count){throw 'new_port_still_owned'}
 [void](Pinned $plan.legacyEntry $plan.legacyEntrySha256);[void](Pinned $plan.legacyVbs $plan.legacyVbsSha256)
 $oldPort=if($plan.legacyPort){[int]$plan.legacyPort}else{4382}
 $legacyListeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object{$_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq $oldPort})
 if($legacyListeners.Count -ne 1 -or $legacyListeners[0].OwningProcess -ne $plan.legacyPid){throw 'rollback_original_listener_not_proven'}
 $current=LegacyTask
 if($current.vbs -ine $plan.launcher){throw 'task_changed_do_not_restore'}
 FutureTaskUnchanged $plan
 $applyReceipt=ReadJson (Join-Path $OperationRoot 'apply-attempt.json')
 if($applyReceipt.operationId -cne $plan.operationId -or $applyReceipt.startAttempts -ne 1 -or $applyReceipt.taskUpdated -ne $true){throw 'original_apply_receipt_required'}
 if($applyReceipt.proxyAttempted -eq $false){
  # Pre-cutover rollback: the original route was never dispatched. Do not send a proxy command.
  $serve=ServeText $tailscale
  $serveBackup=Regular (Join-Path $OperationRoot 'tailscale.before.json')
  if((HashText ([IO.File]::ReadAllText($serveBackup))) -cne $plan.serveBeforeSha256 -or (HashText $serve) -cne $plan.serveBeforeSha256){throw 'precutover_serve_changed_preserved'}
  [void](Pinned $plan.mobileConfig $plan.mobileConfigSha256)
  $xml=[IO.File]::ReadAllText((Pinned (Join-Path $OperationRoot 'task.before.xml') $plan.taskXmlSha256))
  $rollback=Join-Path $OperationRoot 'rollback-attempt.json'
  WriteJson $rollback @{state='PRE_CUTOVER_TASK_RESTORE_DISPATCHING';operationId=$plan.operationId;proxyCommandSent=$false;configRestored=$false;deviceTrustRestored=$false;legacyProcessStopped=$false;automaticReplay=$false}
  Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $xml -Force -ErrorAction Stop|Out-Null
  UpdateJson $rollback @{state='PRE_CUTOVER_FUTURE_TASK_RESTORED_NOT_VERIFIED';operationId=$plan.operationId;proxyCommandSent=$false;configRestored=$false;deviceTrustRestored=$false;legacyProcessStopped=$false;functionalVerification='NOT_RUN';automaticReplay=$false}
  @{state='PRE_CUTOVER_FUTURE_TASK_RESTORED_NOT_VERIFIED';operationId=$plan.operationId;proxyCommandSent=$false;functionalVerification='NOT_RUN'}|ConvertTo-Json
  return
 }
 $serve=ServeText $tailscale;$obj=$serve|ConvertFrom-Json -AsHashtable;$key=([Uri]$plan.remoteOrigin).Authority
 if($obj.Web[$key].Handlers['/'].Proxy -cne ('http://127.0.0.1:'+$port)){throw 'root_proxy_changed_do_not_restore'}
 $before=ReadJson (Join-Path $OperationRoot 'tailscale.before.json');$expected=$before|ConvertTo-Json -Depth 32 -Compress
 $obj.Web[$key].Handlers['/'].Proxy='http://127.0.0.1:'+$oldPort
 if(($obj|ConvertTo-Json -Depth 32 -Compress) -cne $expected){throw 'other_serve_handlers_changed_preserved'}
 $xml=[IO.File]::ReadAllText((Pinned (Join-Path $OperationRoot 'task.before.xml') $plan.taskXmlSha256))
 $applyReceipt=ReadJson (Join-Path $OperationRoot 'apply-attempt.json')
 $mobileHash=HashFile (Regular $plan.mobileConfig)
 if($mobileHash -cne $plan.mobileConfigSha256 -and (-not $applyReceipt.ContainsKey('mobileConfigExpectedSha256') -or $mobileHash -cne $applyReceipt.mobileConfigExpectedSha256)){throw 'mobile_config_changed_do_not_restore'}
 $mobilePreimage=Pinned (Join-Path $OperationRoot 'mobile-config.before.json') $plan.mobileConfigSha256
 $rollback=Join-Path $OperationRoot 'rollback-attempt.json';WriteJson $rollback @{state='RESTORE_DISPATCHING';operationId=$plan.operationId;deviceTrustRestored=$false;legacyProcessStopped=$false;automaticReplay=$false}
 if($mobileHash -cne $plan.mobileConfigSha256){
  $temp=Join-Path (Split-Path -Parent $plan.mobileConfig) ('mobile-control.rollback.'+$plan.operationId+'.tmp')
  Copy-Item -LiteralPath $mobilePreimage -Destination $temp -ErrorAction Stop
  if((HashFile $plan.mobileConfig) -cne $mobileHash){throw 'mobile_config_changed_before_restore'}
  Move-Item -LiteralPath $temp -Destination (Full $plan.mobileConfig) -Force -ErrorAction Stop
 }
 Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $xml -Force -ErrorAction Stop|Out-Null
 & $tailscale serve --bg --https=8443 --set-path=/ ('http://127.0.0.1:'+$oldPort)|Out-Null
 if($LASTEXITCODE -ne 0){throw 'rollback_proxy_result_unknown'}
 UpdateJson $rollback @{state='ROUTING_AND_FUTURE_TASK_RESTORED_NOT_VERIFIED';operationId=$plan.operationId;deviceTrustRestored=$false;legacyProcessStopped=$false;functionalVerification='NOT_RUN';automaticReplay=$false}
}
