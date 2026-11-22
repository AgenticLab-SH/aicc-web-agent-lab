#requires -Version 7.0
[CmdletBinding()]param([switch]$AsJson)
$ErrorActionPreference='Stop'
$tool=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../Manage-CdpChromeSlotLease.ps1')).Path
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($tool,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw ($parseErrors|Out-String)}
foreach($name in @('Test-LeaseExpired','Test-LeaseBlocksSlot','Test-LeaseCleanupUnchanged','Test-ExpiredTargetCleanup')){
 $definition=$ast.FindAll({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object { $_.Name -eq $name }
 Invoke-Expression $definition.Extent.Text
}
$checks=[Collections.Generic.List[object]]::new()
function Check($Name,$Condition){$checks.Add(@{name=$Name;ok=[bool]$Condition});if(-not$Condition){throw $Name}}
$slot=[pscustomobject]@{port=19222;endpoint='http://127.0.0.1:19222';profile_dir=(Join-Path ([IO.Path]::GetTempPath()) 'cleanup-fixture-profile')}
$lease=[pscustomobject]@{lease_token=('a'*32);owner_id='fixture';state='cleanup_failed';target_id='owned';endpoint=$slot.endpoint;profile_dir=$slot.profile_dir;heartbeat_at_utc='2026-01-01T00:00:00Z';expires_at_utc='2026-01-01T00:01:00Z'}
$script:NoBrowser=$false;$script:AllowBrowserStart=$false;$script:mode='online';$script:starts=0;$script:closes=0;$script:closeOk=$true
function Get-IdentityReport($Slot){if($script:mode-eq'online'){return @{exit_code=0;report=@{ok=$true}}};if($script:mode-eq'offline'){return @{exit_code=1;report=@{ok=$false;reasons=@('cdp_endpoint_unavailable')};raw='offline'}};return @{exit_code=1;report=@{ok=$false;reasons=@('profile_mismatch')};raw='mismatch'}}
function Ensure-SlotReady($Slot){$script:starts++;$script:mode='online';return $true}
function Close-OwnedTarget($Lease){$script:closes++;return $script:closeOk}
$script:mode='offline';Check 'offline is never absence and cannot auto-start' ((Test-ExpiredTargetCleanup $slot $lease)-eq$false-and$script:starts-eq0-and$script:closes-eq0)
$script:AllowBrowserStart=$true;Check 'authorized start is reached before capacity and exact cleanup succeeds' ((Test-ExpiredTargetCleanup $slot $lease)-eq$true-and$script:starts-eq1-and$script:closes-eq1)
$script:mode='mismatch';$denied=$false;try{$null=Test-ExpiredTargetCleanup $slot $lease}catch{$denied=$true};Check 'identity mismatch cannot start or close' ($denied-and$script:starts-eq1-and$script:closes-eq1)
$script:mode='online';$script:closeOk=$false;Check 'present target without successful close remains fenced' (-not(Test-ExpiredTargetCleanup $slot $lease))
$other=$lease.PSObject.Copy();$other.endpoint='http://127.0.0.1:19999';Check 'unregistered endpoint is preserved' (-not(Test-ExpiredTargetCleanup $slot $other))
$other=$lease.PSObject.Copy();$other.profile_dir=Join-Path $slot.profile_dir 'other';Check 'wrong profile is preserved' (-not(Test-ExpiredTargetCleanup $slot $other))
$other=$lease.PSObject.Copy();$other.target_id=$null;Check 'unknown target is never guessed' (-not(Test-ExpiredTargetCleanup $slot $other))
$other=$lease.PSObject.Copy();$other.expires_at_utc=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o');Check 'renewed active owner cannot be deleted after observation' (-not(Test-LeaseCleanupUnchanged $other $lease))
$other=$lease.PSObject.Copy();$other.heartbeat_at_utc='changed';Check 'heartbeat race is preserved' (-not(Test-LeaseCleanupUnchanged $other $lease))
foreach($state in @('reclaiming','releasing','cleanup_failed','unknown','outcome_unknown','provisioning')){$other=$lease.PSObject.Copy();$other.state=$state;Check ($state+' blocks until reconciled') (Test-LeaseBlocksSlot $other)}
Check 'matching unchanged expired record can be reconciled' (Test-LeaseCleanupUnchanged $lease $lease)
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-cleanup-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root '19222.leases') -Force|Out-Null
try{
 foreach($state in @('reclaiming','releasing','cleanup_failed')){$record=$lease.PSObject.Copy();$record|Add-Member port 19222;$record.lease_token=[Guid]::NewGuid().ToString('N');$record.state=$state;$record|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root ('19222.leases/'+$record.lease_token+'.lease.json')) -Encoding utf8}
 $raw=& pwsh -NoProfile -File $tool -Action Acquire -OwnerId cleanup-fixture -StateRoot $root -SlotPorts 19222 -NoBrowser -MaxTargetsPerSlot 3 -WaitSec 0 -AsJson
 $exitCode=$LASTEXITCODE;$result=$raw|ConvertFrom-Json
 Check 'full cleanup-state slot recovers through the actual Acquire sweep' ($exitCode-eq0-and$result.ok-and$result.reclaimed_count-eq3)
 $null=& pwsh -NoProfile -File $tool -Action Release -LeaseToken $result.lease.lease_token -StateRoot $root -SlotPorts 19222 -NoBrowser -AsJson
 Check 'recovered lease releases normally' ($LASTEXITCODE-eq0)
}finally{if([IO.Path]::GetFullPath($root).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $root -Recurse -Force}}
$result=@{ok=$true;check_count=$checks.Count;checks=@($checks)}
if($AsJson){$result|ConvertTo-Json -Depth 5 -Compress}else{$result|ConvertTo-Json -Depth 5}