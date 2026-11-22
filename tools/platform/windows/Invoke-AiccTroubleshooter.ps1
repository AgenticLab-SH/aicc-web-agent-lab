#requires -Version 7.5
[CmdletBinding()]
param(
 [ValidateSet('Status','Prepare','Repair','Rollback','RdcStatus','RdcSave','RdcSwitch','RdcPair','RdcStart','RdcAdopt','RdcRestart','RdcAuto','RdcNext','RdcAutoStop')][string]$Action='Status',
 [string]$OperationDirectory,[string]$CandidateDirectory,[string]$ReadyFile,[string]$ExpectedPlanSha256,
 [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$')][string]$Profile='current',
 [switch]$AllowServiceRestart
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding
$stateRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$registryFile=Join-Path $stateRoot 'runtime\components.json'
$taskName='AgenticLab-AICC-Workspace-Tunnel'
$profileFile=Join-Path $stateRoot 'workspace-mcp\tunnel\profiles\aicc-workspace.yaml'
$receiptFile=Join-Path $stateRoot ('backups\workspace-tunnel-windows-task\'+$taskName+'.install.json')
. (Join-Path $PSScriptRoot '..\workspace-mcp\Stop-WorkspaceOwnedRuntime.ps1')
function Read-Json($p){Get-Content -LiteralPath (Plain $p) -Raw|ConvertFrom-Json -AsHashtable -DateKind String}
function Plain($p){
 $p=[IO.Path]::GetFullPath($p);$i=Get-Item -LiteralPath $p -Force
 for($j=$i;$j;$j=if($j.PSIsContainer){$j.Parent}else{$j.Directory}){if($j.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked owner path refused'}}
 return $p
}
function Hash($p){(Get-FileHash -LiteralPath (Plain $p)).Hash.ToLowerInvariant()}
function Write-Json($p,$v){$tmp=$p+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($tmp,($v|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $tmp -Destination $p -Force}
function Canonical($v){
 if($v -is [Collections.IDictionary]){$o=[ordered]@{};foreach($k in @($v.Keys|Sort-Object)){$o[$k]=Canonical $v[$k]};return $o}
 if($v -is [Collections.IEnumerable] -and $v -isnot [string]){return ,@(foreach($i in $v){Canonical $i})}
 return $v
}
function Same($a,$b){(Canonical $a|ConvertTo-Json -Depth 30 -Compress) -ceq (Canonical $b|ConvertTo-Json -Depth 30 -Compress)}
function Get-Gateway {
 $registry=Read-Json $registryFile;$g=$registry.components['unified-mcp']
 if(-not $g.releaseRoot.StartsWith((Join-Path $stateRoot 'releases\unified-mcp\'),[StringComparison]::OrdinalIgnoreCase) -or (Hash $g.entry) -cne $g.entryHash){throw 'Registered gateway pin differs'}
 $owners=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Replace('/','\').Contains($g.entry.Replace('/','\'))})
 if($owners.Count -ne 1){throw 'Exact gateway process unavailable'}
 $owner=$owners[0];$instances=@(Get-ChildItem -LiteralPath (Join-Path $stateRoot 'runtime\unified-mcp-maintenance') -Directory -Filter ($owner.ProcessId.ToString()+'-*')|Where-Object {Test-Path -LiteralPath (Join-Path $_.FullName 'state.json')})
 $match=@(foreach($i in $instances){$s=Read-Json (Join-Path $i.FullName 'state.json');if([Math]::Abs(([DateTimeOffset]::Parse($s.identity.gateway.startedAt).UtcDateTime-$owner.CreationDate.ToUniversalTime()).TotalSeconds) -lt 5){@{state=$s;directory=$i.FullName}}})
 if($match.Count -ne 1){throw 'Gateway generation unavailable'}
 return @{registry=$registry;component=$g;process=$owner;state=$match[0].state;directory=$match[0].directory}
}
function Assert-Repairable($g){
 if($g.state.fault -or $g.state.operation -or $g.state.phase -notin @('DRAINING','DEGRADED')){throw 'Automatic repair requires an unowned read failure; inspect the current operation'}
 foreach($p in $g.state.providers.Values){if($p.active -cne 0 -or $p.reconnecting -cne 0){throw 'Provider has active or unknown activity'}}
 $calls=@($g.state.calls);if(-not $calls.Count){throw 'No failed read to repair'}
 $reads=@('aicc_workspace_search','aicc_workspace_list','aicc_workspace_info','aicc_workspace_read','aicc_workspace_read_many','aicc_skill_read','aicc_skill_inventory')
 foreach($c in $calls){if($c.phase -cne 'unknown' -or $c.provider -cne 'workspace' -or $c.tool -cnotin $reads){throw 'A write or unclassified result needs its original owner; preserved without restart'}}
 # The failed result remains unknown. A new process is never its acknowledgement.
 $w=$g.registry.components.workspace
 $status=(& $w.runtime $w.entry workspace status --json)|ConvertFrom-Json -AsHashtable
 if($LASTEXITCODE -ne 0 -or $status.remoteAuthority.activeLeases -cne 0 -or $status.remoteAuthority.runtimeReady -cne $true){throw 'Workspace leases are active or unknown'}
 $ready=Invoke-RestMethod -Uri 'http://127.0.0.1:17841/readyz' -NoProxy -TimeoutSec 5
 # 17841 is observed, never stopped or reconfigured here. Its unrelated turns
 # do not belong to this gateway's exact provider counters above.
 if($ready.ready -cne $true){throw 'Model route is unavailable'}
 $tree=Get-WorkspaceOwnedRuntime 'business-full'
 $runtimeIds=@($tree.helperPid,$tree.tunnelPid,$tree.serverPid,[int]$g.process.ProcessId)
 $nativeChildren=@(Get-CimInstance Win32_Process|Where-Object {$_.ParentProcessId -eq $g.process.ProcessId -and $_.CommandLine -match 'mcp-helper\.cjs'})
 $runtimeIds+=@($nativeChildren.ProcessId)
 $foreign=@($tree.processes|Where-Object {$_.pid -notin $runtimeIds -and [IO.Path]::GetFileName($_.image) -ine 'conhost.exe'})
 if($foreign.Count -and -not $AllowServiceRestart){throw 'AICC 실행 묶음에 다른 프로젝트 서비스가 있습니다. 해당 서비스의 중단·복구 범위를 먼저 확인해야 합니다.'}
}
function OperationsRoot($p){$p=[IO.Path]::GetFullPath($p);if(-not $p.StartsWith((Join-Path $stateRoot 'backups\troubleshooter\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Exact troubleshooter operation directory required'};return $p}

if($Action -like 'Rdc*'){
 $rdcRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.desktop-commander-device'
 $rotationFile=Join-Path $rdcRoot 'rotation\runtime.json'
 if($Action -in @('RdcAuto','RdcNext','RdcAutoStop','RdcSwitch') -and (Test-Path -LiteralPath $rotationFile)){
  $rotation=Read-Json $rotationFile
  if((Hash $rotation.entry) -cne $rotation.entrySha256){throw 'RDC rotation entry pin differs'}
  $args=@{Action=switch($Action){'RdcAuto'{'Start'} 'RdcAutoStop'{'Stop'} default{'Next'}}}
  if($Action -eq 'RdcSwitch'){$args.Profile=$Profile}
  & $rotation.entry @args;return
 }
 if($Action -in @('RdcAuto','RdcNext','RdcAutoStop')){throw 'RDC rotation runtime is not installed'}
 $deviceFile=Join-Path $rdcRoot 'device.json';$profiles=Join-Path $rdcRoot 'profiles';$control=Join-Path $rdcRoot 'control'
 New-Item -ItemType Directory -Path $profiles,$control -Force|Out-Null
 $lock=if($Action -eq 'RdcStatus'){$null}else{[IO.File]::Open((Join-Path $rdcRoot 'account-switch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
 try{
  Add-Type -AssemblyName System.Security
  function Save-Profile($name){
   $bytes=[IO.File]::ReadAllBytes((Plain $deviceFile));$obj=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
   if(-not $obj.deviceId -or -not $obj.session.refresh_token){throw 'A completed RDC login is required'}
   $encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
   [IO.File]::WriteAllBytes((Join-Path $profiles ($name+'.dpapi')),$encrypted)
   # Refresh every local alias for the current device before leaving it. Never
   # resurrect an earlier, already-rotated refresh token from another alias.
   foreach($saved in @(Get-ChildItem -LiteralPath $profiles -Filter '*.dpapi' -File)){
    $old=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Plain $saved.FullName)),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    if(([Text.Encoding]::UTF8.GetString($old)|ConvertFrom-Json).deviceId -ceq $obj.deviceId){[IO.File]::WriteAllBytes($saved.FullName,$encrypted)}
   }
   return $obj.deviceId
  }
  function Agent-State {
   $file=Join-Path $control 'state.json';if(-not(Test-Path -LiteralPath $file)){return $null};$s=Read-Json $file
   $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$s.pid)
   if(-not $p -or -not $p.CommandLine.Contains('rdc-managed-agent.mjs') -or [Math]::Abs(($p.CreationDate.ToUniversalTime()-[DateTimeOffset]::Parse($s.startedAt).UtcDateTime).TotalSeconds) -gt 5){return $null}
   if(([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($s.observedAt)).TotalSeconds -gt 8){throw 'RDC status is stale; preserve the connection'}
   return $s
  }
  $s=Agent-State
  if($Action -eq 'RdcAdopt'){
   if($s){@{ok=$true;message='이미 관리형 RDC 연결입니다.'}|ConvertTo-Json;return}
   $d=Read-Json $deviceFile
   $info=Invoke-RestMethod -Uri 'https://mcp.desktopcommander.app/api/mcp-info' -TimeoutSec 10
   $base=[uri]$info.supabaseUrl
   if($base.Scheme -cne 'https' -or -not $base.Host.EndsWith('.supabase.co')){throw 'Unexpected RDC authentication authority'}
   $headers=@{apikey=$info.supabasePublishableKey;Authorization=('Bearer '+$d.session.access_token)}
   $uri=$base.AbsoluteUri.TrimEnd('/')+'/rest/v1/mcp_remote_calls?select=id,status&device_id=eq.'+[uri]::EscapeDataString($d.deviceId)+'&status=in.(pending,executing)&limit=1'
   $pending=Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 10
   if(@($pending).Count){throw 'Existing RDC has pending or executing calls; preserve it'}
   $owners=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match 'desktop-commander[\\/]dist[\\/]index\.js"?\s+remote(?:\s|$)'})
   if($owners.Count -ne 1){throw 'Exact legacy RDC ownership unavailable'}
   $owner=$owners[0];$children=@(Get-CimInstance Win32_Process|Where-Object {$_.ParentProcessId -eq $owner.ProcessId})
   if(@($children|Where-Object {$_.Name -ne 'node.exe' -or $_.CommandLine -notmatch 'desktop-commander[\\/]dist[\\/]index\.js"?\s*$'}).Count){throw 'Legacy RDC has active external children'}
   $pending=Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 10;if(@($pending).Count){throw 'RDC activity changed before maintenance'}
   $null=Save-Profile $Profile
   $fresh=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owner.ProcessId)
   if(-not $fresh -or $fresh.CreationDate -ne $owner.CreationDate -or $fresh.CommandLine -cne $owner.CommandLine){throw 'RDC ownership changed'}
   # One-time planned stop of the legacy connector; it has no local drain IPC.
   # All future switches use the managed agent's normal stop acknowledgement.
   Stop-Process -Id $owner.ProcessId -ErrorAction Stop
   foreach($child in $children){$live=Get-CimInstance Win32_Process -Filter ('ProcessId='+$child.ProcessId);if($live -and $live.CreationDate -eq $child.CreationDate -and $live.CommandLine -ceq $child.CommandLine){Stop-Process -Id $child.ProcessId -ErrorAction Stop}}
   & (Join-Path $rdcRoot 'launch-remote.ps1')
   @{ok=$true;message='기존 RDC 로그인을 보존하고 관리형 연결 시작을 요청했습니다.';stopMode='planned-maintenance-stop'}|ConvertTo-Json;return
  }
  if($Action -eq 'RdcStatus'){
   $d=if(Test-Path -LiteralPath $deviceFile){Read-Json $deviceFile}else{$null}
   $saved=@(Get-ChildItem -LiteralPath $profiles -Filter '*.dpapi' -File|Sort-Object BaseName)
   $matching=@(foreach($item in $saved){try{$bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Plain $item.FullName)),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);$config=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json;if($d -and $config.deviceId -ceq $d.deviceId){$item.BaseName}}catch{}})
   $friendly=@($matching|Where-Object {$_ -notlike 'device-*'})
   $currentName=if($friendly.Count){$friendly[0]}elseif($matching.Count){$matching[0]}else{''}
   $rotationStatus=if(Test-Path -LiteralPath (Join-Path $rdcRoot 'rotation\state.json')){Read-Json (Join-Path $rdcRoot 'rotation\state.json')}else{$null}
   @{ok=$true;managed=($null -ne $s);state=if($s){$s.phase}else{'LEGACY_CONNECTION'};active=if($s){$s.active}else{$null};unknown=if($s){$s.unknown}else{$null};deviceId=$d.deviceId;profiles=@($saved|ForEach-Object BaseName);currentProfile=$currentName;rotationConfigured=(Test-Path -LiteralPath $rotationFile);rotation=$rotationStatus;message=if($rotationStatus){$rotationStatus.message}elseif($s){'연결 상태와 실행 작업을 확인했습니다.'}else{'기존 연결 보존 중 · 관리형 연결 전환 후 계정 전환 가능'}}|ConvertTo-Json -Depth 7;return
  }
  if($Action -eq 'RdcSave'){$id=Save-Profile $Profile;@{ok=$true;message='현재 로그인을 Windows 사용자 암호화로 저장했습니다.';profile=$Profile;deviceId=$id}|ConvertTo-Json;return}
  if($Action -eq 'RdcStart'){
   & (Join-Path $rdcRoot 'launch-remote.ps1');@{ok=$true;message='RDC 시작 요청을 전달했습니다.'}|ConvertTo-Json;return
  }
  if(-not $s){throw '기존 RDC 연결은 보존 중입니다. 관리형 실행기로 인수한 후 전환할 수 있습니다.'}
  if($s.active -cne 0 -or $s.unknown -cne 0 -or $s.phase -cne 'CONNECTED'){throw '실행 중이거나 결과 미확인인 RDC 작업이 있습니다. 원 작업을 끝내세요.'}
  if($Action -eq 'RdcSwitch'){
   $encrypted=[IO.File]::ReadAllBytes((Plain (Join-Path $profiles ($Profile+'.dpapi'))))
   $target=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
   $targetConfig=[Text.Encoding]::UTF8.GetString($target)|ConvertFrom-Json
   if(-not $targetConfig.deviceId -or -not $targetConfig.session.refresh_token){throw 'Saved login is incomplete'}
   $current=Read-Json $deviceFile
   if($targetConfig.deviceId -ceq $current.deviceId){@{ok=$true;message='이미 선택한 RDC 연결입니다. 현재 연결을 유지했습니다.'}|ConvertTo-Json;return}
  }
  $requestId=[guid]::NewGuid().ToString();$request=@{schemaVersion=1;requestId=$requestId;instanceId=$s.instanceId;action='stop';expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(25).ToString('o')}
  Write-Json (Join-Path $control ($requestId+'.request.json')) $request
  $deadline=[DateTimeOffset]::UtcNow.AddSeconds(20);$answer=Join-Path $control ($requestId+'.response.json')
  while(-not(Test-Path -LiteralPath $answer) -and [DateTimeOffset]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
  if(-not(Test-Path -LiteralPath $answer)){throw 'RDC stop result uncertain. Do not retry; inspect this request.'}
  $ack=Read-Json $answer;if($ack.requestId -cne $requestId -or $ack.instanceId -cne $s.instanceId -or $ack.stopped -cne $true){throw 'RDC is busy or stop failed; preserved'}
  $exitDeadline=[DateTimeOffset]::UtcNow.AddSeconds(8)
  while((Get-Process -Id $s.pid -ErrorAction SilentlyContinue) -and [DateTimeOffset]::UtcNow -lt $exitDeadline){Start-Sleep -Milliseconds 100}
  if(Get-Process -Id $s.pid -ErrorAction SilentlyContinue){throw 'RDC stop acknowledged but process is still present; preserve without switching'}
  if(Test-Path -LiteralPath $deviceFile){
   $current=Read-Json $deviceFile;$currentProfile='device-'+([string]$current.deviceId).Substring(0,8);$null=Save-Profile $currentProfile
  }
  if($Action -eq 'RdcSwitch'){
   $temp=$deviceFile+'.switch.tmp';[IO.File]::WriteAllBytes($temp,$target);Move-Item -LiteralPath $temp -Destination $deviceFile -Force
  }elseif($Action -eq 'RdcPair'){
   # Retain the old login, including the latest refresh token, outside the active filename.
   Move-Item -LiteralPath $deviceFile -Destination (Join-Path $rdcRoot ('device.before-pair-'+$requestId+'.json'))
  }
  & (Join-Path $rdcRoot 'launch-remote.ps1')
  @{ok=$true;message=if($Action -eq 'RdcPair'){'다른 계정 연결을 시작했습니다. 열린 공식 인증 화면에서 계정을 선택하세요.'}else{'저장 계정 연결을 시작했습니다. 상태 조회로 실제 연결을 확인하세요.'};requestId=$requestId}|ConvertTo-Json;return
 }finally{if($lock){$lock.Dispose()}}
}

if($Action -eq 'Status'){
 $g=Get-Gateway;$can=$false;$reason='';try{Assert-Repairable $g;$can=$true}catch{$reason=$_.Exception.Message}
 $pendingRoot=Join-Path $stateRoot 'backups\troubleshooter'
 $plans=if(Test-Path -LiteralPath $pendingRoot){@(Get-ChildItem -LiteralPath $pendingRoot -Directory|Where-Object {Test-Path -LiteralPath (Join-Path $_.FullName 'ready.json')}|Sort-Object LastWriteTime -Descending)}else{@()}
 $prepared=$false
 if($plans.Count){$p=Read-Json (Join-Path $plans[0].FullName 'plan.json');$rd=Read-Json (Join-Path $plans[0].FullName 'ready.json');$prepared=$rd.status -ceq 'READY' -and [DateTimeOffset]::Parse($rd.expires_at) -gt [DateTimeOffset]::UtcNow -and $p.gatewayPid -eq $g.process.ProcessId -and -not(Test-Path -LiteralPath (Join-Path $plans[0].FullName 'result.json'))}
 if($prepared -and $p.serviceRestartAuthorized){$AllowServiceRestart=$true;try{Assert-Repairable $g;$can=$true;$reason=''}catch{$can=$false;$reason=$_.Exception.Message}}
 @{ok=$true;phase=$g.state.phase;gatewayPid=$g.process.ProcessId;providers=$g.state.providers;unknown=@($g.state.unknown|Select-Object callId,provider,tool,errorCategory);repairable=$can;prepared=$prepared;operationDirectory=if($prepared){$plans[0].FullName}else{$null};message=if($g.state.phase -in @('OPEN','RESUMED')){'AICC 게이트웨이가 새 요청을 받고 있습니다.'}elseif($prepared -and $can){'읽기 실패 기록 보존 · 준비된 복구를 적용할 수 있습니다.'}elseif($can){'읽기 실패로 연결 대기 중 · 새 복구 준비와 독립 복구 담당이 필요합니다.'}else{$reason}}|ConvertTo-Json -Depth 8;return
}
$OperationDirectory=OperationsRoot $OperationDirectory
if($Action -eq 'Prepare'){
 $g=Get-Gateway;Assert-Repairable $g
 $candidate=[IO.Path]::GetFullPath($CandidateDirectory)
 if(-not $candidate.StartsWith((Join-Path $stateRoot 'releases\unified-mcp\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Managed candidate required'}
 $manifest=Read-Json (Join-Path $candidate 'manifest.json')
 foreach($f in @('gateway.cjs','config.json')){if((Hash (Join-Path $candidate $f)) -cne $manifest.files[$f]){throw 'Candidate pin differs'}}
 $before=Read-Json (Join-Path $g.component.releaseRoot 'config.json');$after=Read-Json (Join-Path $candidate 'config.json')
 if(-not(Same $before $after)){throw 'Recovery must retain exact provider authority and config'}
 if(Test-Path -LiteralPath $OperationDirectory){throw 'Existing operation preserved; inspect it'}
 New-Item -ItemType Directory -Path $OperationDirectory -Force|Out-Null
 Copy-Item -LiteralPath $registryFile -Destination (Join-Path $OperationDirectory 'registry.before.json')
 Copy-Item -LiteralPath $profileFile -Destination (Join-Path $OperationDirectory 'profile.before.yaml')
 Copy-Item -LiteralPath $receiptFile -Destination (Join-Path $OperationDirectory 'receipt.before.json')
 Copy-Item -LiteralPath $g.directory -Destination (Join-Path $OperationDirectory 'original-unknown') -Recurse
 $desired=[IO.File]::ReadAllText($profileFile).Replace($g.component.entry.Replace('\','/'),(Join-Path $candidate 'gateway.cjs').Replace('\','/')).Replace((Join-Path $g.component.releaseRoot 'config.json').Replace('\','/'),(Join-Path $candidate 'config.json').Replace('\','/'))
 [IO.File]::WriteAllText((Join-Path $OperationDirectory 'profile.after.yaml'),$desired,[Text.UTF8Encoding]::new($false))
 $plan=@{schemaVersion=1;owner_task_id=$env:CODEX_THREAD_ID;request_id=('aicc-tray-repair-'+[guid]::NewGuid().ToString('N'));challenge=[guid]::NewGuid().ToString('N');target=$taskName;rollback_ref=$OperationDirectory;expires_at=[DateTimeOffset]::UtcNow.AddMinutes(25).ToString('o');allowed_recovery=@('restore-exact-gateway-profile-and-registry-with-cas','start-original-workspace-task-once');gatewayPid=[int]$g.process.ProcessId;revision=$g.state.revision;ownership=(Get-WorkspaceOwnedRuntime 'business-full');beforeGateway=$g.component;candidate=$candidate;candidateHash=$manifest.files['gateway.cjs'];profileHash=(Hash $profileFile);registryHash=(Hash $registryFile);receiptHash=(Hash $receiptFile);unknownResult='UNCONFIRMED_PRESERVED';serviceRestartAuthorized=[bool]$AllowServiceRestart;stopMode='planned-maintenance-stop'}
 $plan.profileDesiredHash=Hash (Join-Path $OperationDirectory 'profile.after.yaml')
 $plan.helperSha256=Hash $PSCommandPath
 $plan.taskExecute=(Get-ScheduledTask -TaskName $taskName).Actions.Execute
 $plan.taskArguments=(Get-ScheduledTask -TaskName $taskName).Actions.Arguments
 Write-Json (Join-Path $OperationDirectory 'plan.json') $plan
 @{ok=$true;plan=(Join-Path $OperationDirectory 'plan.json');planSha256=(Hash (Join-Path $OperationDirectory 'plan.json'));message='복구본과 단회 정비 계획을 준비했습니다.'}|ConvertTo-Json;return
}
$planFile=Join-Path $OperationDirectory 'plan.json';$plan=Read-Json $planFile
$lock=[IO.File]::Open($registryFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
 if($Action -eq 'Repair'){
  if(-not $ReadyFile){$ReadyFile=Join-Path $OperationDirectory 'ready.json'}
  $ready=Read-Json $ReadyFile
  foreach($k in @('owner_task_id','request_id','challenge','target','rollback_ref')){if($ready[$k] -cne $plan[$k]){throw ('Independent READY differs: '+$k)}}
  if($ready.status -cne 'READY' -or $ready.independent -cne $true -or $ready.plan_sha256 -cne (Hash $planFile) -or [DateTimeOffset]::Parse($ready.expires_at) -le [DateTimeOffset]::UtcNow -or [DateTimeOffset]::Parse($plan.expires_at) -le [DateTimeOffset]::UtcNow -or -not(Same $ready.allowed_recovery $plan.allowed_recovery)){throw 'Fresh independent READY required'}
  if($plan.helperSha256 -and (Hash $PSCommandPath) -cne $plan.helperSha256){throw 'Prepared helper bytes changed'}
  if(Test-Path -LiteralPath (Join-Path $OperationDirectory 'result.json')){throw 'Repair already attempted. Inspect the result; do not replay'}
  $AllowServiceRestart=[bool]$plan.serviceRestartAuthorized
  $g=Get-Gateway;Assert-Repairable $g
  if($g.process.ProcessId -ne $plan.gatewayPid -or $g.state.revision -ne $plan.revision -or -not(Same $g.component $plan.beforeGateway) -or (Hash $profileFile) -cne $plan.profileHash -or (Hash $receiptFile) -cne $plan.receiptHash -or -not(Same (Get-WorkspaceOwnedRuntime 'business-full') $plan.ownership)){throw 'Live generation changed; prepare again'}
  if((Hash (Join-Path $plan.candidate 'gateway.cjs')) -cne $plan.candidateHash){throw 'Candidate changed'}
  Write-Json (Join-Path $OperationDirectory 'result.json') @{status='STOP_INTENT';at=[DateTimeOffset]::UtcNow.ToString('o');unknownResult='UNCONFIRMED_PRESERVED'}
  Disable-ScheduledTask -TaskName $taskName|Out-Null
  $stopped=Stop-WorkspaceOwnedRuntime $plan.ownership
  if($stopped.stopped -cne $true){throw 'Exact stop unconfirmed'}
  Stop-ScheduledTask -TaskName $taskName
  $r=Read-Json $registryFile
  if(-not(Same $r.components['unified-mcp'] $plan.beforeGateway)){throw 'Gateway component changed during stop'}
  $newEntry=Join-Path $plan.candidate 'gateway.cjs';$newConfig=Join-Path $plan.candidate 'config.json'
  $text=[IO.File]::ReadAllText($profileFile);$oldEntry=$plan.beforeGateway.entry.Replace('\','/');$oldConfig=(Join-Path $plan.beforeGateway.releaseRoot 'config.json').Replace('\','/')
  if($text.Split($oldEntry,[StringSplitOptions]::None).Count -ne 2 -or $text.Split($oldConfig,[StringSplitOptions]::None).Count -ne 2){throw 'Profile does not select exact gateway'}
  $text=$text.Replace($oldEntry,$newEntry.Replace('\','/')).Replace($oldConfig,$newConfig.Replace('\','/'))
  if((Hash (Join-Path $OperationDirectory 'profile.after.yaml')) -cne $plan.profileDesiredHash -or $text -cne [IO.File]::ReadAllText((Join-Path $OperationDirectory 'profile.after.yaml'))){throw 'Prepared profile changed'}
  $tmp=$profileFile+'.repair.tmp';[IO.File]::WriteAllText($tmp,$text,[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $tmp -Destination $profileFile -Force
  $r.components['unified-mcp']=@{}+$plan.beforeGateway;$r.components['unified-mcp'].entry=$newEntry;$r.components['unified-mcp'].entryHash=$plan.candidateHash;$r.components['unified-mcp'].releaseRoot=$plan.candidate;$r.components['unified-mcp'].previousRelease=$plan.beforeGateway.releaseRoot;$r.components['unified-mcp'].recovery=$OperationDirectory
  Write-Json $registryFile $r
  $receipt=Read-Json $receiptFile;$receipt.profileSha256=Hash $profileFile;Write-Json $receiptFile $receipt
  Write-Json (Join-Path $OperationDirectory 'result.json') @{status='START_INTENT';at=[DateTimeOffset]::UtcNow.ToString('o');unknownResult='UNCONFIRMED_PRESERVED'}
  Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
  Write-Json (Join-Path $OperationDirectory 'result.json') @{ok=$true;status='START_ACCEPTED';unknownResult='UNCONFIRMED_PRESERVED';at=[DateTimeOffset]::UtcNow.ToString('o')}
  @{ok=$true;message='AICC 연결을 새 세대로 시작했습니다. 원 검색은 미확인 기록으로 보존했습니다.'}|ConvertTo-Json
 }elseif($Action -eq 'Rollback'){
  $r=Read-Json $registryFile
  if($r.components['unified-mcp'].releaseRoot -cne $plan.candidate){throw 'Rollback target is not the exact candidate'}
  if((Hash $profileFile) -cnotin @($plan.profileHash,$plan.profileDesiredHash)){throw 'Profile changed outside this operation'}
  $task=Get-ScheduledTask -TaskName $taskName
  if($task.Actions.Execute -cne $plan.taskExecute -or $task.Actions.Arguments -cne $plan.taskArguments){throw 'Task changed outside this operation'}
  $running=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Replace('/','\').Contains((Join-Path $plan.candidate 'gateway.cjs'))})
  if($running.Count){
   $owner=Get-WorkspaceOwnedRuntime 'business-full';$live=Get-Gateway
   foreach($p in $live.state.providers.Values){if($p.active -cne 0 -or $p.unknown -cne 0 -or $p.reconnecting -cne 0){throw 'Rollback has active or unknown calls'}}
   Disable-ScheduledTask -TaskName $taskName|Out-Null;$null=Stop-WorkspaceOwnedRuntime $owner
  }else{
   # Cold bootstrap failure: no candidate gateway accepted a call. Restore only
   # the unchanged named task/profile; never require a healthy failed gateway.
   Disable-ScheduledTask -TaskName $taskName|Out-Null
  }
  Stop-ScheduledTask -TaskName $taskName
  $r.components['unified-mcp']=$plan.beforeGateway;Write-Json $registryFile $r
  Copy-Item -LiteralPath (Join-Path $OperationDirectory 'profile.before.yaml') -Destination $profileFile -Force
  Copy-Item -LiteralPath (Join-Path $OperationDirectory 'receipt.before.json') -Destination $receiptFile -Force
  Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName
  @{ok=$true;message='원래 AICC 연결 시작을 요청했습니다.'}|ConvertTo-Json
 }
}finally{$lock.Dispose()}
