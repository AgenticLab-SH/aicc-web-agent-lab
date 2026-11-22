#requires -Version 7.5
[CmdletBinding()]
param([ValidateSet('Start','Watch','Next','Status','Quota','Observe','Confirm','Bind','Connect','Reconcile','Stop')][string]$Action='Start',[string]$Profile,[ValidateRange(0,100)][double]$RemainingPercent=100,[string]$ObservedAt,[string]$ConnectorUserId,[string]$DeviceId,[string]$LinkId,[string]$OperationId,[switch]$ReadSucceeded,[switch]$UsageRejected,[switch]$Refresh)
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.desktop-commander-device'
$dir=Join-Path $root 'rotation'
function Read($p){$value=Get-Content -LiteralPath $p -Raw|ConvertFrom-Json -AsHashtable -DateKind String;if($null -eq $value){throw 'RDC state is empty or corrupt; reconcile its original operation before continuing'};return $value}
function Save-Json($p,$v){
 $json=$v|ConvertTo-Json -Depth 16
 if((Test-Path -LiteralPath $p) -and [IO.File]::ReadAllText($p) -ceq $json){return}
 $t=$p+'.'+[guid]::NewGuid().ToString('N')+'.tmp';$bytes=[Text.UTF8Encoding]::new($false).GetBytes($json)
 $stream=[IO.FileStream]::new($t,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 if(Test-Path -LiteralPath $p){[IO.File]::Replace($t,$p,$p+'.previous',$true)}else{Move-Item -LiteralPath $t -Destination $p}
}
$runtime=Read (Join-Path $dir 'runtime.json');$cfg=Read $runtime.config
$stateFile=Join-Path $dir 'state.json';$requestFile=Join-Path $dir 'next.json';$quotaFile=Join-Path $dir 'quota.json';$availabilityFile=Join-Path $dir 'availability.json'
function Emit($v){$v|ConvertTo-Json -Depth 16 -Compress}
function Account($name){$a=@($cfg.accounts|Where-Object profile -CEQ $name);if($a.Count -ne 1){throw 'Unknown RDC account'};return $a[0]}
function Current{$d=Read (Join-Path $root 'device.json');$a=@($cfg.accounts|Where-Object deviceId -CEQ $d.deviceId);if($a.Count -ne 1){throw 'Unregistered current device'};return $a[0]}
function State{if(Test-Path -LiteralPath $stateFile){Read $stateFile}else{$a=Current;@{phase='IDLE';current=$a.profile;link_id=$a.linkId;deviceId=$a.deviceId;message='전환 요청 대기';retryAfterMs=1000}}}
function Fresh($value,$seconds){$value -and [Math]::Abs(([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($value)).TotalSeconds) -le $seconds}
function Known-Link($account,$id){$id -and (@($account.linkId)+@($account.linkIds)) -ccontains $id}
function Request-Guard{
 for($attempt=0;$attempt -lt 60;$attempt++){try{return [IO.File]::Open((Join-Path $dir 'requests.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch [IO.IOException]{Start-Sleep -Milliseconds 50}}
 throw 'Another request owner is still committing; query the existing operation'
}
function Begin-Watcher{
 if((Get-FileHash -LiteralPath $runtime.entry).Hash.ToLowerInvariant() -cne $runtime.entrySha256){throw 'Rotation entry pin differs'}
 Start-Process -FilePath $runtime.powershell -ArgumentList @('-NoProfile','-NonInteractive','-File',('"'+$runtime.entry+'"'),'-Action','Watch') -WindowStyle Hidden|Out-Null
}
function Quota-Guard{
 for($i=0;$i -lt 60;$i++){try{return [IO.File]::Open((Join-Path $dir 'quota.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch [IO.IOException]{Start-Sleep -Milliseconds 50}}
 throw 'Quota observation owner is busy'
}
function Save-Quota($q){
 $null=Account $q.profile
 if($q.source -notin @('rdc-who_am_i','rdc-official-dashboard') -or -not(Fresh $q.observedAt 300) -or $null -eq $q.remainingPercent -or [double]$q.remainingPercent -lt 0 -or [double]$q.remainingPercent -gt 100){throw 'Exact fresh official quota required'}
 $g=Quota-Guard
 try{
  $all=if(Test-Path -LiteralPath $availabilityFile){Read $availabilityFile}else{@{}};$old=$all[$q.profile]
  if($old -and [DateTimeOffset]::Parse($old.observedAt) -gt [DateTimeOffset]::Parse($q.observedAt)){return}
  if(-not $q.resetAt -and $old.resetAt){$q.resetAt=$old.resetAt}
  $q.excluded=($q.usageRejected -ceq $true -or [double]$q.remainingPercent -le $cfg.thresholdPercent)
  $q.excludedSince=if($q.excluded){if($old.excludedSince){$old.excludedSince}else{$q.observedAt}}else{$null}
  $q.nextCheckAt=[DateTimeOffset]::Parse($q.observedAt).AddSeconds($(if($q.excluded){21600}else{300})).ToString('o')
  if($q.resetAt){$reset=[DateTimeOffset]::Parse($q.resetAt).AddSeconds(5);if($reset -gt [DateTimeOffset]::UtcNow -and $reset -lt [DateTimeOffset]::Parse($q.nextCheckAt)){$q.nextCheckAt=$reset.ToString('o')}}
  $all[$q.profile]=$q;Save-Json $availabilityFile $all
  $latest=if(Test-Path -LiteralPath $quotaFile){Read $quotaFile}else{$null}
  if(-not $latest -or [DateTimeOffset]::Parse($latest.observedAt) -le [DateTimeOffset]::Parse($q.observedAt)){Save-Json $quotaFile $q}
 }finally{$g.Dispose()}
}
function Quota-Pool{
 $all=if(Test-Path -LiteralPath $availabilityFile){Read $availabilityFile}else{@{}}
 $checksFile=Join-Path $dir 'quota-checks.json';$checks=if(Test-Path -LiteralPath $checksFile){Read $checksFile}else{@{}}
 $current=Current
 $rows=@(foreach($account in $cfg.accounts){
  $q=$all[$account.profile];$check=$checks[$account.profile];$reason='UNKNOWN';$excluded=$true
  if($q -and $null -ne $q.remainingPercent){
   if($q.usageRejected -ceq $true){$reason='REJECTED'}elseif([double]$q.remainingPercent -le 0){$reason='EXHAUSTED'}elseif([double]$q.remainingPercent -le $cfg.thresholdPercent){$reason='LOW_QUOTA'}elseif(-not(Fresh $q.observedAt 86400)){$reason='STALE'}else{$reason='AVAILABLE';$excluded=$false}
  }
  $next=$q.nextCheckAt
  if(-not $next){$next=[DateTimeOffset]::UtcNow.ToString('o')}
  if($check.nextAttemptAt -and [DateTimeOffset]::Parse($check.nextAttemptAt) -gt [DateTimeOffset]::Parse($next)){$next=$check.nextAttemptAt}
  if($check.phase -eq 'SECURITY_REFUSED'){$next=$null}
  @{profile=$account.profile;current=($current.profile -ceq $account.profile);remainingPercent=$q.remainingPercent;excluded=$excluded;reason=$reason;observedAt=$q.observedAt;source=$q.source;resetAt=$q.resetAt;resetAtKst=if($q.resetAt){[DateTimeOffset]::Parse($q.resetAt).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyy-MM-dd HH:mm:ss zzz')}else{$null};nextCheckAt=$next;nextCheckAtKst=if($next){[DateTimeOffset]::Parse($next).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyy-MM-dd HH:mm:ss zzz')}else{$null};checkPhase=$check.phase;checkMessage=$check.message;excludedSince=$q.excludedSince}
 })
 @{phase='QUOTA';accounts=$rows;thresholdPercent=$cfg.thresholdPercent;message=(@($rows|ForEach-Object {$label=switch($_.reason){'AVAILABLE'{'사용 가능'} 'EXHAUSTED'{'소진 제외'} 'LOW_QUOTA'{'잔여 부족 제외'} 'REJECTED'{'한도 거절 제외'} 'STALE'{'재조회 대기'} default{'미확인'}};$left=if($null -eq $_.remainingPercent){'?'}else{([Math]::Round([double]$_.remainingPercent,2)).ToString()};$_.profile+' '+$left+'% · '+$label}) -join ' / ')}
}
function Select-NextAccount($pool,$requested,$current){
 $eligible=@($pool.accounts|Where-Object {-not $_.excluded -and -not $_.current}).profile
 if($requested){if($requested -in $eligible){return Account $requested};return $null}
 $index=[array]::IndexOf(@($cfg.accounts.profile),$current.profile)
 foreach($offset in 1..($cfg.accounts.Count-1)){$candidate=$cfg.accounts[($index+$offset)%$cfg.accounts.Count];if($candidate.profile -in $eligible){return $candidate}}
 return $null
}
function Progress($op,$phase,$message){$op.phase=$phase;$op.message=$message;$op.observedAt=[DateTimeOffset]::UtcNow.ToString('o');$op.retryAfterMs=if($phase -eq 'READY'){0}else{500};Save-Json $stateFile $op;Save-Json (Join-Path $dir ($op.operationId+'.json')) $op}
if($Action -eq 'Status'){$s=State;$s.quota=Quota-Pool;Emit $s;return}
if($Action -eq 'Quota'){
 if($Profile){$null=Account $Profile}
 $view=Quota-Pool
 if($Refresh){
  $guard=Request-Guard
  try{
   $refreshFile=Join-Path $dir 'quota-refresh.json'
   $existing=if(Test-Path -LiteralPath $refreshFile){Read $refreshFile}else{$null}
   if(-not $existing){$existing=@{requestId=[guid]::NewGuid().ToString();profiles=@($cfg.accounts.profile);requestedAt=[DateTimeOffset]::UtcNow.ToString('o')};Save-Json $refreshFile $existing}
   $view.refreshRequestId=$existing.requestId;$view.refreshQueued=$true;$view.message+=' · 공식 사용량 재조회를 접수했습니다.'
  }finally{$guard.Dispose()}
  Begin-Watcher
 }
 if($Profile){$view.accounts=@($view.accounts|Where-Object profile -CEQ $Profile)}
 Emit $view;return
}
if($Action -eq 'Stop'){Save-Json (Join-Path $dir 'stop.json') @{requestedAt=[DateTimeOffset]::UtcNow.ToString('o')};Emit @{phase='STOP_REQUESTED';message='진행 중인 전환 후 감시만 중지합니다. RDC 작업은 유지합니다.'};return}
if($Action -in @('Bind','Confirm')){
 $guard=Request-Guard
 try{
  $target=Account $Profile
  if(-not(Fresh $ObservedAt 90) -or $ConnectorUserId -cne $target.userId){throw 'Fresh exact who_am_i identity required'}
  if($Action -eq 'Bind'){
   if($LinkId -cnotmatch '^link_[a-f0-9]{20,64}$'){throw 'Use only link_id exposed by current tool schema'}
   $target.linkIds=@(@($target.linkId)+@($target.linkIds)+@($LinkId)|Where-Object {$_}|Select-Object -Unique)
   if(-not $target.linkId){$target.linkId=$LinkId};Save-Json $runtime.config $cfg
   $pending=State;if($pending.phase -eq 'VERIFYING' -and $pending.target -ceq $Profile){$pending.link_id=$LinkId;Progress $pending 'VERIFYING' '새 link_id를 결속했습니다. 같은 지피티의 실제 읽기 확인을 기다립니다.'}
   Emit @{phase='BOUND';profile=$Profile;link_id=$LinkId;message='실제 도구 신원과 계정 연결을 저장했습니다.'};return
  }
  $state=State
  if($state.phase -cne 'VERIFYING' -or $state.operationId -cne $OperationId -or $state.target -cne $Profile -or $DeviceId -cne $target.deviceId -or -not(Known-Link $target $LinkId) -or -not $ReadSucceeded){throw 'Exact operation, link, online device and successful RDC read required'}
  $state.confirmationLinkId=$LinkId;Progress $state 'READY' 'RDC 계정 전환이 완료되어 작업을 이어갑니다.';Emit $state;return
 }finally{$guard.Dispose()}
}
if($Action -eq 'Connect'){
 $null=Account $Profile
 if((Get-FileHash -LiteralPath $runtime.browserEntry).Hash.ToLowerInvariant() -cne $runtime.browserSha256){throw 'Browser adapter pin differs'}
 $browserGuard=[IO.File]::Open((Join-Path $dir 'dashboard.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{& $runtime.node $runtime.browserEntry $runtime.config $Profile ([guid]::NewGuid().ToString())}finally{$browserGuard.Dispose()};return
}
if($Action -eq 'Observe'){
 $a=Account $Profile
 if(-not(Fresh $ObservedAt 90) -or $ConnectorUserId -cne $a.userId -or -not(Known-Link $a $LinkId)){throw 'Fresh quota from the exact bound connector required'}
 Save-Quota @{profile=$Profile;remainingPercent=$RemainingPercent;observedAt=$ObservedAt;source='rdc-who_am_i';usageRejected=[bool]$UsageRejected};Begin-Watcher;Emit @{phase='OBSERVED';message='사용량 신호를 접수했습니다.'};return
}
if($Action -eq 'Reconcile'){
 $guard=Request-Guard
 try{
  $state=State
  if($state.operationId -cne $OperationId -or $state.phase -notin @('VERIFYING','HOLD') -or -not $state.agentRequestId){throw 'Exact unresolved operation required'}
  $ack=Read (Join-Path $root ('control\'+$state.agentRequestId+'.response.json'));$agent=Read (Join-Path $root 'control\state.json')
  $from=Account $state.from
  if($ack.requestId -ceq $state.agentRequestId -and $ack.instanceId -ceq $state.agentInstanceId -and $ack.rotated -ceq $false -and $ack.reason -ceq 'busy_or_auth_failed' -and $agent.instanceId -ceq $state.agentInstanceId -and $agent.deviceId -ceq $from.deviceId -and $agent.phase -ceq 'CONNECTED' -and $agent.active -eq 0 -and $agent.unknown -eq 0 -and (Fresh $agent.observedAt 8)){
   Progress $state 'NOT_SWITCHED' '원 요청의 미전환 응답과 기존 연결 유지를 확인했습니다. 자동 재시도 없이 다음 명시 전환을 허용합니다.';Emit $state;return
  }
  if($ack.requestId -cne $state.agentRequestId -or $ack.instanceId -cne $state.agentInstanceId -or $ack.rotated -cne $true -or $ack.deviceId -cne $state.deviceId -or $agent.deviceId -cne $state.deviceId -or $agent.phase -cne 'CONNECTED' -or $agent.active -ne 0 -or $agent.unknown -ne 0 -or -not(Fresh $agent.observedAt 8)){throw 'Transport outcome is still unknown; preserve operation'}
  Progress $state 'UNVERIFIED' '중계 교체 ACK를 조정했습니다. 지피티 읽기는 미확인으로 남기며 다음 명시 전환을 허용합니다.';Emit $state;return
 }finally{$guard.Dispose()}
}
if($Action -eq 'Start'){Begin-Watcher;Emit @{phase='START_REQUESTED';message='RDC 자동 전환 담당을 시작합니다.';statusFile=$stateFile};return}
if($Action -eq 'Next'){
 $guard=Request-Guard
 try{
  $state=State
  if($state.phase -in @('QUEUED','PREPARING','SWITCHING','VERIFYING','HOLD','NEEDS_CONNECTOR_REAUTH')){Emit $state;return}
  if($Profile){$null=Account $Profile}
  $request=@{operationId=[guid]::NewGuid().ToString();profile=$Profile;requestedAt=[DateTimeOffset]::UtcNow.ToString('o')}
  Save-Json $stateFile @{operationId=$request.operationId;phase='QUEUED';message='RDC 계정 전환을 접수했습니다.';retryAfterMs=500};Save-Json $requestFile $request
 }finally{$guard.Dispose()}
 Begin-Watcher;Emit (State);return
}
$mutex=[Threading.Mutex]::new($false,'Local\AICC-RDC-Rotation')
if(-not $mutex.WaitOne(0)){$mutex.Dispose();return}
try{
 $stopFile=Join-Path $dir 'stop.json';if(Test-Path -LiteralPath $stopFile){Move-Item -LiteralPath $stopFile -Destination (Join-Path $dir ('stop.previous-'+[guid]::NewGuid().ToString('N')+'.json'))}
 $usageProcess=$null;$usageOutput=$null;$usageProfile=$null;$browserGuard=$null;$usageAccountGuard=$null;$forcedProfiles=@();$nextPoll=[DateTimeOffset]::MinValue
 $checksFile=Join-Path $dir 'quota-checks.json'
 while(-not(Test-Path -LiteralPath $stopFile) -or $usageProcess){
  $cfg=Read $runtime.config;$state=State;$request=$null
  Save-Json (Join-Path $dir 'watcher.json') @{pid=$PID;entry=$runtime.entry;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
  if($usageProcess -and $usageProcess.HasExited){
   $checks=if(Test-Path -LiteralPath $checksFile){Read $checksFile}else{@{}}
   try{
    $q=Read $usageOutput
    if($usageProcess.ExitCode -ne 0 -or $q.phase -cne 'USAGE_OBSERVED' -or $q.profile -cne $usageProfile){throw 'Official account quota unavailable'}
    Save-Quota $q;$checks[$usageProfile]=@{phase='OBSERVED';observedAt=$q.observedAt;message='공식 계정 사용량을 읽었습니다.'}
   }catch{
    $failed=if(Test-Path -LiteralPath $usageOutput){try{Read $usageOutput}catch{$null}}else{$null}
    $phase=if($failed.reason -eq 'SECURITY_REFUSED' -or $failed.phase -eq 'SECURITY_REFUSED'){'SECURITY_REFUSED'}elseif($failed.phase -eq 'NEEDS_GOOGLE_LOGIN'){'NEEDS_GOOGLE_LOGIN'}elseif($failed.phase -eq 'QUOTA_SESSION_MISMATCH'){'QUOTA_SESSION_MISMATCH'}elseif($failed.phase -eq 'AUTH_REQUIRED'){'AUTH_REQUIRED'}elseif($failed.phase -eq 'AUTH_REFRESH_PENDING'){'AUTH_REFRESH_PENDING'}elseif($failed.phase -eq 'IDENTITY_MISMATCH'){'IDENTITY_MISMATCH'}else{'UNKNOWN'}
    $checks[$usageProfile]=@{phase=$phase;observedAt=[DateTimeOffset]::UtcNow.ToString('o');nextAttemptAt=[DateTimeOffset]::UtcNow.AddMinutes($(if($phase -in @('NEEDS_GOOGLE_LOGIN','QUOTA_SESSION_MISMATCH','AUTH_REQUIRED','IDENTITY_MISMATCH')){360}else{10})).ToString('o');message=if($phase -eq 'SECURITY_REFUSED'){'공급자 보안 거절입니다. 자동 로그인 재시도 없이 기존 연결과 제외 상태를 보존합니다.'}elseif($phase -eq 'NEEDS_GOOGLE_LOGIN'){'조회용 로그인이 없습니다. 한도 조회는 자동 로그인하지 않으며 기존 RDC 연결·제외 상태를 보존합니다.'}elseif($phase -eq 'QUOTA_SESSION_MISMATCH'){'현재 웹 로그인과 다른 계정의 한도입니다. 자동 로그아웃·로그인 없이 기존 연결을 유지하고 해당 조회를 보류합니다.'}elseif($phase -eq 'AUTH_REQUIRED'){'저장된 RDC 인증을 갱신하지 못했습니다. 자동 로그인 없이 기존 연결·한도 제외를 보존합니다.'}elseif($phase -eq 'AUTH_REFRESH_PENDING'){'현재 RDC 에이전트의 정상 인증 갱신을 기다립니다. 연결·로그인은 변경하지 않습니다.'}elseif($phase -eq 'IDENTITY_MISMATCH'){'RDC 저장 신원이 등록값과 다릅니다. 계정과 기존 연결을 보존합니다.'}else{'공식 사용량 미확인 · 마지막 한도와 제외 상태를 보존합니다.'}}
   }
   Save-Json $checksFile $checks;$usageProcess.Dispose();$usageProcess=$null;$usageProfile=$null
   if($browserGuard){$browserGuard.Dispose();$browserGuard=$null}
   if($usageAccountGuard){$usageAccountGuard.Dispose();$usageAccountGuard=$null}
   $nextPoll=[DateTimeOffset]::UtcNow.AddSeconds(15)
  }
  if(Test-Path -LiteralPath $stopFile){Start-Sleep -Seconds 2;continue}
  $refreshFile=Join-Path $dir 'quota-refresh.json'
  if(Test-Path -LiteralPath $refreshFile){$guard=Request-Guard;try{if(Test-Path -LiteralPath $refreshFile){$refreshRequestRecord=Read $refreshFile;$forcedProfiles=@(@($forcedProfiles)+@($refreshRequestRecord.profiles)|Select-Object -Unique);Move-Item -LiteralPath $refreshFile -Destination (Join-Path $dir ('quota-refresh-'+$refreshRequestRecord.requestId+'.accepted.json')) -Force}}finally{$guard.Dispose()}}
  if(-not $usageProcess -and $state.phase -in @('IDLE','READY','QUOTA_WAIT','NOT_SWITCHED','UNVERIFIED') -and [DateTimeOffset]::UtcNow -ge $nextPoll){
   $pool=Quota-Pool;$due=@($pool.accounts|Where-Object {$_.checkPhase -ne 'SECURITY_REFUSED' -and ($_.profile -in $forcedProfiles -or ($_.nextCheckAt -and [DateTimeOffset]::Parse($_.nextCheckAt) -le [DateTimeOffset]::UtcNow))}|Sort-Object nextCheckAt)
   if($due.Count){
    $usageProfile=$due[0].profile
    try{
     $browserGuard=[IO.File]::Open((Join-Path $dir 'dashboard.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
     $usageAccountGuard=[IO.File]::Open((Join-Path $root 'account-switch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
     if(-not $runtime.quotaEntry -or (Get-FileHash -LiteralPath $runtime.quotaEntry).Hash.ToLowerInvariant() -cne $runtime.quotaSha256){throw 'Quota reader pin differs'}
     if((Get-FileHash -LiteralPath $runtime.browserEntry).Hash.ToLowerInvariant() -cne $runtime.browserSha256){throw 'Browser pin differs'}
     $usageId=[guid]::NewGuid().ToString();$usageOutput=Join-Path $dir ('usage-'+$usageId+'.json')
     $usageProcess=Start-Process -FilePath $runtime.node -ArgumentList @(('"'+$runtime.browserEntry+'"'),('"'+$runtime.config+'"'),$usageProfile,$usageId,'usage') -RedirectStandardOutput $usageOutput -RedirectStandardError ($usageOutput+'.stderr') -WindowStyle Hidden -PassThru
     $forcedProfiles=@($forcedProfiles|Where-Object {$_ -cne $usageProfile})
    }catch{if($browserGuard){$browserGuard.Dispose();$browserGuard=$null};if($usageAccountGuard){$usageAccountGuard.Dispose();$usageAccountGuard=$null};$nextPoll=[DateTimeOffset]::UtcNow.AddSeconds(30)}
   }
  }
  if(-not $usageProcess -and (Test-Path -LiteralPath $requestFile)){
   $guard=Request-Guard
   try{if(Test-Path -LiteralPath $requestFile){$r=Read $requestFile;if($r.operationId -cne $state.operationId -or $state.phase -eq 'QUEUED'){$request=$r};Move-Item -LiteralPath $requestFile -Destination (Join-Path $dir ('request-'+$r.operationId+'.accepted.json')) -Force}}finally{$guard.Dispose()}
  }
  if(-not $usageProcess -and -not $request -and $state.phase -in @('IDLE','READY','VERIFYING','QUOTA_WAIT')){
   $pool=Quota-Pool;$currentQuota=@($pool.accounts|Where-Object current)[0];$eligible=@($pool.accounts|Where-Object {-not $_.excluded -and -not $_.current})
   $verifyRejected=if(Test-Path -LiteralPath $availabilityFile){(Read $availabilityFile)[$currentQuota.profile]}else{$null}
   if($state.phase -eq 'QUOTA_WAIT' -and -not $state.resumeProfile -and -not $currentQuota.excluded){Progress $state 'IDLE' '현재 계정의 공식 잔여 한도가 회복되었습니다. 기존 연결로 작업할 수 있습니다.';$state=State}
   $resume=($state.phase -eq 'QUOTA_WAIT' -and $(if($state.resumeProfile){@($eligible|Where-Object profile -CEQ $state.resumeProfile).Count -gt 0}else{$eligible.Count -gt 0}))
   if($resume -or ($state.phase -ne 'QUOTA_WAIT' -and $currentQuota.reason -in @('EXHAUSTED','LOW_QUOTA','REJECTED') -and ($state.phase -ne 'VERIFYING' -or ($verifyRejected.usageRejected -ceq $true -and (Fresh $verifyRejected.observedAt 120))))){$request=@{operationId=[guid]::NewGuid().ToString();profile=if($resume){$state.resumeProfile}else{''};requestedAt=[DateTimeOffset]::UtcNow.ToString('o')}}
  }
  if($state.phase -eq 'VERIFYING' -and -not(Fresh $state.observedAt 300)){Progress $state 'HOLD' '중계 교체 후 같은 지피티의 실제 읽기 확인이 필요합니다.'}
  if(-not $request){
   if($state.phase -in @('IDLE','READY','QUOTA_WAIT','NOT_SWITCHED','UNVERIFIED')){
    $view=Quota-Pool;$state.quota=$view
    if(-not $state.baseMessage){$state.baseMessage=$state.message}
    $state.message=$state.baseMessage+' · '+$view.message;Save-Json $stateFile $state
   }
   Start-Sleep -Seconds 2;continue
  }
  $op=@{operationId=$request.operationId;requestedAt=$request.requestedAt};$accountLock=$null
  try{
   $accountLock=[IO.File]::Open((Join-Path $root 'account-switch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
   $current=Current;$index=[array]::IndexOf(@($cfg.accounts.profile),$current.profile)
   $pool=Quota-Pool
   if($request.profile -ceq $current.profile -and -not (@($pool.accounts|Where-Object current)[0].excluded)){$op.from=$current.profile;Progress $op 'IDLE' '요청 계정이 이미 연결되어 있습니다. 계정을 교체하지 않았습니다.';continue}
   $target=Select-NextAccount $pool $request.profile $current
   if(-not $target){$op.from=$current.profile;$op.resumeProfile=$request.profile;Progress $op 'QUOTA_WAIT' '사용 가능한 다음 계정이 없습니다. 소진·미확인 계정을 제외하고 공식 사용량 회복을 감시합니다. 기존 RDC 연결은 유지합니다.';continue}
   $op.from=$current.profile;$op.target=$target.profile;$op.link_id=$target.linkId;$op.deviceId=$target.deviceId;$op.connectorUserId=$target.userId
   $op.connectorEmail=$target.email
   if(-not $target.linkId -and $target.connectorRegistered -cne $true){Progress $op 'NEEDS_CONNECTOR_REAUTH' '다음 계정의 지피티 연결을 최초 등록하고 실제 도구 link_id를 결속해야 합니다. 현재 연결은 유지합니다.';continue}
   Progress $op 'PREPARING' 'RDC 계정을 전환 중입니다. 기존 작업과 연결을 보존하며 다음 계정을 준비합니다.'
   $agent=Read (Join-Path $root 'control\state.json')
   if($agent.phase -cne 'CONNECTED' -or $agent.active -cne 0 -or $agent.unknown -cne 0 -or 'hotRotate' -notin $agent.capabilities -or -not(Fresh $agent.observedAt 8)){throw 'Agent busy, unknown, stale, or continuity upgrade required'}
   $rid=[guid]::NewGuid().ToString();$op.agentRequestId=$rid;$op.agentInstanceId=$agent.instanceId
   Progress $op 'SWITCHING' '로컬 작업 프로세스를 유지하며 RDC 중계만 교체합니다. 이후 반환된 link_id로 호출합니다.'
   $answer=Join-Path $root ('control\'+$rid+'.response.json')
   Save-Json (Join-Path $root ('control\'+$rid+'.request.json')) @{requestId=$rid;instanceId=$agent.instanceId;action='rotate';profile=$target.profile;expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(25).ToString('o')}
   $deadline=[DateTimeOffset]::UtcNow.AddSeconds(75)
   while(-not(Test-Path -LiteralPath $answer) -and [DateTimeOffset]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 150}
   if(-not(Test-Path -LiteralPath $answer)){throw 'Rotation outcome uncertain; no automatic retry'}
   $ack=Read $answer
   if($ack.requestId -cne $rid -or $ack.instanceId -cne $agent.instanceId -or $ack.rotated -cne $true -or $ack.deviceId -cne $target.deviceId -or $ack.localCorePreserved -cne $true){throw 'Transport replacement not acknowledged'}
   Progress $op 'VERIFYING' '중계 교체를 마쳤습니다. 현재 지피티 도구 명세에서 connectorEmail의 link_id를 찾아 신원·기기·읽기 후 Confirm하세요. 새 연결이 안 보이면 명세 갱신 대기입니다.'
  }catch{$op.reason=$_.Exception.Message;Progress $op 'HOLD' '전환을 보류했습니다. 원 operation 결과를 조정한 뒤 이어가며 불명 요청을 재전송하지 않습니다.'}
  finally{if($accountLock){$accountLock.Dispose()}}
 }
}finally{$mutex.ReleaseMutex();$mutex.Dispose()}
