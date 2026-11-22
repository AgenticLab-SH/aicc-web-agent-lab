#requires -Version 7.5
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\windows\Invoke-AiccCodexContinuity.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'strict_source_parse_error'}
foreach($name in @('Resolve-StrictOwnerAccount','Get-StrictAccountReadiness','Test-StrictPreflight')){
 $found=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($found.Count -ne 1){throw ('missing_strict_function_'+$name)}
 Invoke-Expression $found[0].Extent.Text
}
$checks=0
function Check($condition,[string]$name){if(-not $condition){throw ('FAIL:'+ $name)};$script:checks++}
$ownerHome=Join-Path ([IO.Path]::GetTempPath()) ('aicc-strict-fixture-'+[guid]::NewGuid().ToString('N'))
$runtime=Join-Path $ownerHome '.ai-control-center\runtime\ocx-local'
$managed=Join-Path $runtime 'home';New-Item -Path $managed -ItemType Directory -Force|Out-Null
function Save-Fake($file,$data){[IO.File]::WriteAllText($file,($data|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
Save-Fake (Join-Path $runtime 'current.json') @{schemaVersion=1;requestExecution='windows-local';credentialWriter='a1';opencodexHome=$managed}
$config=@{codexAccounts=@(@{id='fake-one';alias='1번(fakeOne)';isMain=$false;logLabel='selector-one'},@{id='fake-two';alias='2번(fakeTwo)';isMain=$false;logLabel='selector-two'});codexAccountNamespaces=@{'selector-one'='fake-one';'selector-two'='fake-two'};pausedCodexAccountIds=@()}
Save-Fake (Join-Path $managed 'config.json') $config
[IO.File]::WriteAllText((Join-Path $managed 'admin-api-token'),('x'*40))
function Read-Json($file){Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json -AsHashtable -DateKind String}
function Get-RegisteredOwnerPolicy {@{strictAdmission=$true;freshQuotaRequired=$true;fiveHourUsedThreshold=95;longWindowUsedThreshold=95}}
$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:one=@{id='fake-one';isMain=$false;paused=$false;needsReauth=$false;hasCredential=$true;quota=@{updatedAt=$now;shortPercent=10;weeklyPercent=10}}
$script:two=@{id='fake-two';isMain=$false;paused=$false;needsReauth=$false;hasCredential=$true;quota=@{updatedAt=$now;shortPercent=99;weeklyPercent=99}}
$script:badEndpoint=$false;$script:reads=0
function Invoke-RestMethod {param([string]$Uri,$Headers,[switch]$NoProxy,[int]$TimeoutSec)
 $script:reads++
 if($Uri -match '/readyz\z'){return @{ready=(-not $script:badEndpoint);requestExecution='windows-local';credentialWriter='a1';nativeExcluded=$true}}
 if($Uri -match 'accounts\?refresh=1\z'){return @{accounts=@($script:one,$script:two)}}
 throw 'unexpected_fake_endpoint'
}
$ThreadId='11111111-1111-4111-8111-111111111111';$StrictAccountNumber=2
$entry=@{threadId=$ThreadId;enabled=$true;state='QUEUED';attempt=$null;queueAttempt=$null}
$cfg=@{threads=@{$ThreadId=$entry};excludedThreadIds=@();workerStopRequestedAt=$null}
function Assert-HelperIdentity {param($cfg)}
function Thread-Availability {param($entry);@{state='ACTIVE';meta=@{source='cli'}}}
function Thread-Surface {param($meta);'cli'}
function Thread-Owner {param($entry);'RELEASED'}
function Terminal-Evidence {param($entry);@{state='TERMINAL'}}
$binding=Resolve-StrictOwnerAccount 2
Check ($binding.selector -ceq 'selector-two' -and $binding.accountId -ceq 'fake-two') 'exact_owner_selector'
Check ((Get-StrictAccountReadiness 2).state -ceq 'STRICT_QUOTA_WAIT') 'other_pool_ready_not_strict'
$p=Test-StrictPreflight $cfg
Check ($p.state -ceq 'STRICT_QUOTA_WAIT' -and -not $p.claimed -and -not $p.dispatched) 'pool_does_not_claim'
$script:two.quota.shortPercent=12;$script:two.quota.weeklyPercent=14
$script:one.quota.shortPercent=99;$script:one.quota.weeklyPercent=99
$p=Test-StrictPreflight $cfg
Check ($p.state -ceq 'STRICT_EXECUTION_UNBOUND' -and $p.selectedQuotaState -ceq 'STRICT_ACCOUNT_READY' -and -not $p.dispatchable) 'selected_ready_dispatch_blocked'
$script:two.quota.updatedAt=$now-65000
Check ((Get-StrictAccountReadiness 2).state -ceq 'STRICT_QUOTA_STALE') 'stale_quota'
$script:two.quota.updatedAt=$now+65000
Check ((Get-StrictAccountReadiness 2).state -ceq 'STRICT_QUOTA_STALE') 'future_quota'
$script:two.quota.updatedAt=$now;$script:two.needsReauth=$true
Check ((Get-StrictAccountReadiness 2).state -ceq 'STRICT_REAUTH_HOLD') 'reauth'
$script:two.needsReauth=$false;$script:two.paused=$true
Check ((Get-StrictAccountReadiness 2).state -ceq 'STRICT_ACCOUNT_PAUSED') 'paused'
$script:two.paused=$false;$script:badEndpoint=$true
Check ((Get-StrictAccountReadiness 2).state -ceq 'STRICT_ENDPOINT_MISMATCH') 'endpoint_mismatch'
$script:badEndpoint=$false
$config.codexAccountNamespaces.Remove('selector-two');Save-Fake (Join-Path $managed 'config.json') $config
Check ((Get-StrictAccountReadiness 2).state -ceq 'STRICT_SELECTOR_MISMATCH') 'selector_mismatch'
$config.codexAccountNamespaces['selector-two']='fake-two';Save-Fake (Join-Path $managed 'config.json') $config
$entry.attempt=@{id='unknown'};$reads=$script:reads
Check ((Test-StrictPreflight $cfg).state -ceq 'PENDING_DELIVERY_HOLD' -and $script:reads -eq $reads) 'pending_before_quota'
$entry.attempt=$null;$cfg.threads.other=@{queueAttempt=@{id='other-pending'}}
Check ((Test-StrictPreflight $cfg).state -ceq 'ANOTHER_DISPATCH_PENDING') 'duplicate_wake'
$cfg.threads.Remove('other');$entry.state='DELIVERY_UNCERTAIN'
Check ((Test-StrictPreflight $cfg).state -ceq 'ORIGINAL_PENDING_OR_HOLD') 'unknown_preserved'
$entry.state='QUEUED';$entry.enabled=$false
Check ((Test-StrictPreflight $cfg).state -ceq 'SELECTION_DISABLED') 'disabled'
$entry.enabled=$true;$cfg.excludedThreadIds=@($ThreadId)
Check ((Test-StrictPreflight $cfg).state -ceq 'REGISTERED_THREAD_REQUIRED') 'protected'
Check ($ast.Extent.Text.Contains('if($entry.strictAccount)') -and $ast.Extent.Text.Contains('strict_continuity_dispatch_route_unbound')) 'sender_guards'
Check ($ast.Extent.Text.Contains('function Get-PoolReadiness($cfg)') -and $ast.Extent.Text.Contains('17841/v1')) 'automatic_default_preserved'
@{terminal='PASS';checks=$checks;fake=$true;claims=0;dispatches=0;modelCalls=0;realRegistryChanges=0}|ConvertTo-Json -Compress
