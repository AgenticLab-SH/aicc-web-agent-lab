#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._-]{1,64}$')][string]$Selector,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedIdentity,
 [Parameter(Mandatory)][ValidateSet('true','false')][string]$Enabled,
 [ValidateRange(1,100)][int]$FiveHourUsedThreshold,
 [ValidateSet('true','false')][string]$LongWindowProtection,
 [switch]$Commit,[switch]$ReadOnly,[ValidatePattern('^[a-f0-9]{32}$')][string]$PreviewToken)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Hash($text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()}
function Guard($file){for($p=[IO.Path]::GetFullPath($file);$p;$p=Split-Path $p -Parent){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked policy path refused'}}}
function AssertWindowReadback($actual){
 if($FiveHourUsedThreshold -and ($actual.quotaProtection.fiveHour.usedThreshold -ne $FiveHourUsedThreshold -or $actual.quotaProtection.fiveHour.enabled -cne $true)){throw 'Five-hour policy readback unconfirmed'}
 if($LongWindowProtection -and $actual.quotaProtection.longWindow.enabled -cne ($LongWindowProtection -ceq 'true')){throw 'Long-window policy readback unconfirmed'}
}
$state=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'}
$registryFile=Join-Path $state 'runtime/ocx-local/current.json';Guard $registryFile
$registry=Get-Content -Raw -LiteralPath $registryFile|ConvertFrom-Json
$quotaHome=[IO.Path]::GetFullPath($registry.opencodexHome)
if($registry.requestExecution -cne 'windows-local' -or $registry.credentialWriter -cne 'a1' -or $quotaHome -cne [IO.Path]::GetFullPath((Join-Path $state 'runtime/ocx-local/home'))){throw 'Registered local OCX owner required'}
$configFile=Join-Path $quotaHome 'config.json';Guard $configFile
$config=Get-Content -Raw -LiteralPath $configFile|ConvertFrom-Json -AsHashtable
$configSha=(Get-FileHash -LiteralPath $configFile).Hash
$id=$config.codexAccountNamespaces[$Selector]
$account=@($config.codexAccounts|Where-Object {$_.id -ceq $id -and !$_.isMain})
if(!$id -or $id -ceq '__main__' -or $account.Count -ne 1 -or (Hash $id) -cne $ExpectedIdentity){throw 'Exact account identity changed'}
$alias=[string]$account[0].alias
if($alias -cnotmatch '^(\d{1,2})(?:번(?:\(|$)|$)'){throw 'Numbered account identity required'}
$number=[int]$Matches[1]
$same=@($config.codexAccounts|Where-Object {!$_.isMain -and $_.alias -match '^(\d{1,2})(?:번(?:\(|$)|$)' -and [int]$Matches[1] -eq $number})
if($number -lt 1 -or $same.Count -ne 1){throw 'Ambiguous account number'}
$tokenFile=Join-Path $quotaHome 'admin-api-token';Guard $tokenFile
$headers=@{Authorization='Bearer '+[IO.File]::ReadAllText($tokenFile).Trim()}
$live=Invoke-RestMethod 'http://127.0.0.1:10100/api/aicc-local/policy' -Headers $headers -NoProxy -TimeoutSec 15
if($live.accountQuotaProtectionSupported -cne $true -or $live.version -cne $registry.version){throw 'Account quota runtime update required'}
if(($FiveHourUsedThreshold -or $LongWindowProtection) -and $live.accountQuotaWindowOverridesSupported -cne $true){throw 'Independent window runtime update required'}
$file=Join-Path $quotaHome 'aicc-account-quota-policy.json';Guard $file;Guard ($file+'.lock')
$gate=[IO.FileStream]::new($file+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
 $before=if(Test-Path -LiteralPath $file){[IO.File]::ReadAllText($file)}else{''}
 if($before.Length -gt 65536){throw 'Account policy too large'}
 $value=if($before){$before|ConvertFrom-Json -AsHashtable}else{@{schemaVersion=1;defaultOtherAccounts=$false;overrides=@{}}}
 if($value.schemaVersion -ne 1 -or $value.defaultOtherAccounts -cne $false -or $value.overrides -isnot [Collections.IDictionary]){throw 'Invalid account policy'}
 foreach($key in $value.overrides.Keys){if($value.overrides[$key] -isnot [bool]){throw 'Invalid policy override'}}
 if((Get-FileHash -LiteralPath $configFile).Hash -cne $configSha){throw 'Account configuration changed'}
 $binding=Hash ($configSha+':'+$before+':'+$ExpectedIdentity+':'+$Enabled+':'+$FiveHourUsedThreshold+':'+$LongWindowProtection)
 $previewDir=Join-Path $state 'status-tray/account-policy-previews';Guard $previewDir;[IO.Directory]::CreateDirectory($previewDir)|Out-Null
 if($ReadOnly){
  if($Commit -or !$PreviewToken -or !(Test-Path -LiteralPath (Join-Path $previewDir ($PreviewToken+'.used')))){throw 'Exact dispatched local policy required'}
  $prior=Get-Content -Raw -LiteralPath (Join-Path $previewDir ($PreviewToken+'.json'))|ConvertFrom-Json
  if($prior.identityHash -cne $ExpectedIdentity -or $prior.enabled -cne ($Enabled -ceq 'true') -or [int]$prior.fiveHourUsedThreshold -ne $FiveHourUsedThreshold -or [string]$prior.longWindowProtection -cne $LongWindowProtection){throw 'Original policy request changed'}
  if(!$value.overrides.Contains($id) -or $value.overrides[$id] -cne ($Enabled -ceq 'true')){throw 'Original local policy result unconfirmed'}
  $observed=Invoke-RestMethod 'http://127.0.0.1:10100/api/codex-auth/accounts' -Headers $headers -NoProxy -TimeoutSec 15
  $actual=@($observed.accounts|Where-Object id -CEQ $id)
  if($actual.Count -ne 1 -or $actual[0].quotaProtectionEnabled -cne ($Enabled -ceq 'true')){throw 'Runtime account policy readback unconfirmed'}
  AssertWindowReadback $actual[0]
  @{terminal='RECONCILED';action='quota-protection';runtimeReadbackVerified=$true;mutationDispatched=$false}|ConvertTo-Json -Compress;return
 }
 if(!$Commit){
  $previewToken=[Guid]::NewGuid().ToString('N')
  @{binding=$binding;identityHash=$ExpectedIdentity;enabled=($Enabled -ceq 'true');fiveHourUsedThreshold=$FiveHourUsedThreshold;longWindowProtection=$LongWindowProtection;expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(2).ToUnixTimeSeconds()}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $previewDir ($previewToken+'.json')) -Encoding utf8NoBOM
  @{terminal='DRY_RUN';previewToken=$previewToken}|ConvertTo-Json -Compress;return
 }
 if(!$PreviewToken){throw 'One-use preview required'}
 $previewFile=Join-Path $previewDir ($PreviewToken+'.json');Guard $previewFile
 $preview=Get-Content -Raw -LiteralPath $previewFile|ConvertFrom-Json
 if($preview.binding -cne $binding -or $preview.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()){throw 'Policy preview changed or expired'}
 $used=Join-Path $previewDir ($PreviewToken+'.used');$f=[IO.FileStream]::new($used,[IO.FileMode]::CreateNew);$f.Dispose()
 $value.overrides[$id]=$Enabled -ceq 'true'
 if($FiveHourUsedThreshold -or $LongWindowProtection){
  if(!$value.ContainsKey('windowOverrides')){$value.windowOverrides=@{}}
  if($value.windowOverrides -isnot [Collections.IDictionary]){throw 'Invalid window policy overrides'}
  if(!$value.windowOverrides.Contains($id)){$value.windowOverrides[$id]=@{}}
  $windows=$value.windowOverrides[$id]
  if($windows -isnot [Collections.IDictionary]){throw 'Invalid account window policy'}
  if($FiveHourUsedThreshold){$windows.fiveHour=@{usedThreshold=$FiveHourUsedThreshold;enabled=$true}}
  if($LongWindowProtection){
   if(!$windows.Contains('longWindow')){$windows.longWindow=@{}}
   $windows.longWindow.enabled=$LongWindowProtection -ceq 'true'
  }
 }
 $next=$value|ConvertTo-Json -Depth 8
 if($before){[IO.File]::WriteAllText((Join-Path $previewDir ($PreviewToken+'.before.json')),$before,[Text.UTF8Encoding]::new($false))}
 $temporary=$file+'.'+$PreviewToken+'.tmp';[IO.File]::WriteAllText($temporary,$next,[Text.UTF8Encoding]::new($false))
 if(Test-Path -LiteralPath $file){[IO.File]::Replace($temporary,$file,[NullString]::Value)}else{[IO.File]::Move($temporary,$file)}
 if([IO.File]::ReadAllText($file) -cne $next){throw 'Policy readback unconfirmed'}
 $observed=Invoke-RestMethod 'http://127.0.0.1:10100/api/codex-auth/accounts' -Headers $headers -NoProxy -TimeoutSec 15
 $actual=@($observed.accounts|Where-Object id -CEQ $id)
 if($actual.Count -ne 1 -or $actual[0].quotaProtectionEnabled -cne ($Enabled -ceq 'true')){throw 'Runtime account policy readback unconfirmed'}
 AssertWindowReadback $actual[0]
 @{terminal='PASS';action='quota-protection';enabled=($Enabled -ceq 'true');localMutation=$true;remoteMutation=$false;runtimeReadbackVerified=$true}|ConvertTo-Json -Compress
} finally {$gate.Dispose()}
