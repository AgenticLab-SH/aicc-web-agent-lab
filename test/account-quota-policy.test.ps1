#requires -Version 7.5
$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-quota-policy-'+[Guid]::NewGuid().ToString('N'))
$quotaHome=Join-Path $root 'runtime/ocx-local/home';[IO.Directory]::CreateDirectory($quotaHome)|Out-Null
$env:AICC_STATE_ROOT=$root
$scriptPath=Join-Path (Split-Path $PSScriptRoot -Parent) 'tools/platform/windows/Invoke-AiccAccountQuotaPolicy.ps1'
function Hash($s){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($s))).ToLowerInvariant()}
@{schemaVersion=1;requestExecution='windows-local';credentialWriter='a1';opencodexHome=$quotaHome;version='fixture'}|ConvertTo-Json|Set-Content (Join-Path $root 'runtime/ocx-local/current.json') -Encoding utf8
@{codexAccountNamespaces=@{second='b'};codexAccounts=@(@{id='a';alias='1번'},@{id='b';alias='2번'})}|ConvertTo-Json -Depth 6|Set-Content (Join-Path $quotaHome 'config.json') -Encoding utf8
[IO.File]::WriteAllText((Join-Path $quotaHome 'admin-api-token'),'fixture-only')
function Invoke-RestMethod {
 param($Uri,$Headers,[switch]$NoProxy,$TimeoutSec)
 if($Uri -like '*/policy'){return @{accountQuotaProtectionSupported=$true;accountQuotaWindowOverridesSupported=$true;version='fixture'}}
 if($Uri -like '*/accounts'){
  $policy=Get-Content -Raw (Join-Path $quotaHome 'aicc-account-quota-policy.json')|ConvertFrom-Json
  return @{accounts=@(@{id='b';quotaProtectionEnabled=$policy.overrides.b;quotaProtection=$policy.windowOverrides.b})}
 }
 throw 'Network forbidden in fixture'
}
try {
 $identity=Hash 'b';$common=@{Selector='second';ExpectedIdentity=$identity;Enabled='false'}
 $preview=(& $scriptPath @common)|ConvertFrom-Json
 if($preview.terminal -cne 'DRY_RUN'){throw 'Preview failed'}
 $result=(& $scriptPath @common -Commit -PreviewToken $preview.previewToken)|ConvertFrom-Json
 if($result.terminal -cne 'PASS' -or !$result.runtimeReadbackVerified){throw 'Commit/readback failed'}
 $caught=$false;try{& $scriptPath @common -Commit -PreviewToken $preview.previewToken}catch{$caught=$true}
 if(!$caught){throw 'Consumed preview replay accepted'}
 $result=(& $scriptPath @common -ReadOnly -PreviewToken $preview.previewToken)|ConvertFrom-Json
 if($result.terminal -cne 'RECONCILED'){throw 'Read-only reconciliation failed'}
 $before=[IO.File]::ReadAllText((Join-Path $quotaHome 'aicc-account-quota-policy.json'))
 $caught=$false;try{& $scriptPath -Selector second -ExpectedIdentity ('0'*64) -Enabled true}catch{$caught=$true}
 if(!$caught -or [IO.File]::ReadAllText((Join-Path $quotaHome 'aicc-account-quota-policy.json')) -cne $before){throw 'Wrong identity changed policy'}
 $preview=(& $scriptPath -Selector second -ExpectedIdentity $identity -Enabled true)|ConvertFrom-Json
 $result=(& $scriptPath -Selector second -ExpectedIdentity $identity -Enabled true -Commit -PreviewToken $preview.previewToken)|ConvertFrom-Json
 if($result.enabled -cne $true){throw 'Re-enable failed'}
 $windows=@{Selector='second';ExpectedIdentity=$identity;Enabled='true';FiveHourUsedThreshold=98;LongWindowProtection='false'}
 $preview=(& $scriptPath @windows)|ConvertFrom-Json
 $caught=$false;try{& $scriptPath @windows -FiveHourUsedThreshold 97 -Commit -PreviewToken $preview.previewToken}catch{$caught=$true}
 if(!$caught){throw 'Window preview accepted changed arguments'}
 $result=(& $scriptPath @windows -Commit -PreviewToken $preview.previewToken)|ConvertFrom-Json
 if($result.terminal -cne 'PASS'){throw 'Window policy commit failed'}
 $result=(& $scriptPath @windows -ReadOnly -PreviewToken $preview.previewToken)|ConvertFrom-Json
 if($result.terminal -cne 'RECONCILED'){throw 'Window readback failed'}
 $stored=Get-Content -Raw (Join-Path $quotaHome 'aicc-account-quota-policy.json')|ConvertFrom-Json
 if($stored.windowOverrides.b.fiveHour.usedThreshold -ne 98 -or $stored.windowOverrides.b.longWindow.enabled -cne $false){throw 'Independent windows not preserved'}
 @{status='PASS';checks=10;network='fake-only';runtimeChanged=$false}|ConvertTo-Json -Compress
}finally{Remove-Item Env:AICC_STATE_ROOT}
