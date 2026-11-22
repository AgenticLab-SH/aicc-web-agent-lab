#requires -Version 7.5
# Fake-only tests for newly added strict command-route adapter. No real registry, network or Codex process.
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '../windows/Invoke-AiccCodexContinuity.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ('strict_route_source_parse_error:'+($errors[0].Message))}
foreach($name in @('Get-StrictRouteLauncher','Test-StrictPreflight','Get-StrictTerminalSettlement')){
 $found=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($found.Count -ne 1){throw ('strict_route_function_missing:'+ $name)}
 Invoke-Expression $found[0].Extent.Text
}
$checks=0
function Check($yes,[string]$name){if(-not $yes){throw ('FAIL:'+ $name)};$script:checks++}
function Reject($action,[string]$name){$didReject=$false;try{& $action}catch{$didReject=$true};Check $didReject $name}
$fixtureRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'fake-strict-route'))
$node=Join-Path $fixtureRoot 'node.exe'
$codex=Join-Path $fixtureRoot 'codex.exe'
$bridge=Join-Path $fixtureRoot 'codex-strict-continuity-bridge.mjs'
$route=Join-Path $fixtureRoot 'codex-cli-routes.mjs'
$hashes=@{}
$hashes[$node]='a'*64;$hashes[$codex]='b'*64;$hashes[$bridge]='c'*64;$hashes[$route]='d'*64
function Get-Item {param([string]$LiteralPath,[string]$ErrorAction)if(-not $script:hashes.ContainsKey($LiteralPath)){throw 'fake_file_unknown'};@{PSIsContainer=$false;Attributes=[IO.FileAttributes]::Normal}}
function Get-FileHash {param([string]$LiteralPath,[string]$Algorithm)if(-not $script:hashes.ContainsKey($LiteralPath)){throw 'fake_hash_unknown'};@{Hash=$script:hashes[$LiteralPath]}}
$cfg=@{schemaVersion=1;codexExecutable=$codex;codexSha256=$hashes[$codex];strictRouteLauncher=@{
 schemaVersion=1;route='command-route-r2';nodePath=$node;nodeSha256=$hashes[$node]
 bridgePath=$bridge;bridgeSha256=$hashes[$bridge];routeModulePath=$route;routeModuleSha256=$hashes[$route];codexSha256=$hashes[$codex]
}}
$resolved=Get-StrictRouteLauncher $cfg
Check ($resolved.bridgePath -ceq $bridge -and $resolved.routeModuleSha256 -ceq $hashes[$route]) 'pin_exact_bridge_and_module'
$old=$cfg.strictRouteLauncher.nodeSha256;$cfg.strictRouteLauncher.nodeSha256='0'*64
Reject {Get-StrictRouteLauncher $cfg} 'node_hash_changed_hold'
$cfg.strictRouteLauncher.nodeSha256=$old
$old=$cfg.strictRouteLauncher.routeModulePath;$cfg.strictRouteLauncher.routeModulePath=Join-Path $fixtureRoot 'other.mjs'
Reject {Get-StrictRouteLauncher $cfg} 'route_sibling_changed_hold'
$cfg.strictRouteLauncher.routeModulePath=$old
$old=$cfg.strictRouteLauncher.codexSha256;$cfg.strictRouteLauncher.codexSha256='0'*64
Reject {Get-StrictRouteLauncher $cfg} 'codex_pin_changed_hold'
$cfg.strictRouteLauncher.codexSha256=$old
$thread='11111111-1111-4111-8111-111111111111'
$script:ThreadId=$thread;$script:StrictAccountNumber=2
$entry=@{threadId=$thread;strictAccount=2;state='QUEUED';enabled=$true;attempt=$null;queueAttempt=$null}
$cfg.threads=@{$thread=$entry};$cfg.excludedThreadIds=@();$cfg.workerStopRequestedAt=$null
$script:fakeQuota=@{state='STRICT_ACCOUNT_READY';quotaFresh=$true}
function Assert-HelperIdentity {param($config)}
function Thread-Availability {param($row);@{state='ACTIVE';meta=@{source='cli'}}}
function Thread-Surface {param($meta);'cli'}
function Thread-Owner {param($row);'RELEASED'}
function Terminal-Evidence {param($row);@{state='TERMINAL'}}
function Get-StrictAccountReadiness {param([int]$number);if($number -ne 2){throw 'fake_selected_account_changed'};$script:fakeQuota}
$preview=Test-StrictPreflight $cfg
Check ($preview.state -ceq 'STRICT_ROUTE_READY_NOT_DISPATCHED' -and $preview.executionRoute -ceq 'command-route-r2' -and -not $preview.dispatchable -and -not $preview.claimed -and -not $preview.dispatched) 'ready_still_no_dispatch'
$entry.strictAccount=1
Check ((Test-StrictPreflight $cfg).state -ceq 'STRICT_OPT_IN_REQUIRED') 'mismatched_opt_in'
$entry.strictAccount=2
$script:fakeQuota=@{state='STRICT_QUOTA_WAIT';quotaFresh=$true}
Check ((Test-StrictPreflight $cfg).state -ceq 'STRICT_QUOTA_WAIT') 'strict_quota_no_pool_fallback'
$script:fakeQuota=@{state='STRICT_ACCOUNT_READY';quotaFresh=$true}
$entry.attempt=@{id='original-unknown'};$cfg.strictRouteLauncher.nodeSha256='0'*64
Check ((Test-StrictPreflight $cfg).state -ceq 'PENDING_DELIVERY_HOLD') 'unknown_claim_blocks_before_pin'
$entry.attempt=$null;$entry.state='DELIVERY_UNCERTAIN'
Check ((Test-StrictPreflight $cfg).state -ceq 'ORIGINAL_PENDING_OR_HOLD') 'unknown_state_preserved'
$entry.state='QUEUED'
# Restore exact fake pin from hash map rather than from the codex SHA fixture.
$cfg.strictRouteLauncher.nodeSha256=$hashes[$node]
$cfg.strictRouteLauncher=$null
Check ((Test-StrictPreflight $cfg).state -ceq 'STRICT_EXECUTION_UNBOUND') 'missing_install_pin_stays_blocked'
Check ((Get-StrictTerminalSettlement $true $false 'turn.completed' '' 0).acknowledged) 'same_original_terminal_ack'
Check (-not (Get-StrictTerminalSettlement $false $false 'turn.completed' '' 0).acknowledged) 'no_thread_started_no_ack'
Check (-not (Get-StrictTerminalSettlement $true $true 'turn.completed' '' 0).acknowledged) 'foreign_thread_no_ack'
Check (-not (Get-StrictTerminalSettlement $true $false '' '' 0).acknowledged) 'exit_alone_no_ack'
Check ((Get-StrictTerminalSettlement $true $false 'turn.failed' 'QUOTA_WAIT' 1).quota) 'selected_account_quota_ack'
Check (-not (Get-StrictTerminalSettlement $true $false 'turn.failed' 'FAILURE_HOLD' 1).acknowledged) 'non_quota_failure_hold'
$scriptText=$ast.Extent.Text
$worker=$scriptText.Substring($scriptText.IndexOf('$strictMode=($null -ne $entry.strictAccount)'))
Check ($worker.IndexOf('Get-StrictRouteLauncher $script:registry') -ge 0 -and $worker.IndexOf('Get-StrictRouteLauncher $script:registry') -lt $worker.IndexOf('Get-StrictAccountReadiness $strictNumber')) 'pin_refusal_skips_quota_reads'
Check ($scriptText.Contains('quotaUpdatedAtMs') -and $worker.Contains('ToUnixTimeMilliseconds()-$strictQuotaUpdatedAtMs')) 'claim_requires_original_fresh_quota_sample'
Check ($scriptText.Contains('if($strictMode)') -and $scriptText.Contains('Get-StrictAccountReadiness $strictNumber') -and $scriptText.Contains('Get-PoolReadiness $script:registry')) 'strict_not_pool_path'
Check ($scriptText.Contains('routeMode=') -or $scriptText.Contains("$"+"record.routeMode='strict'")) 'strict_claim_marked'
Check ($scriptText.Contains('STRICT_DELIVERY_UNCERTAIN') -and $scriptText.Contains('thread.started') -and $scriptText.Contains('lastStrictRouteReceipt')) 'strict_unknown_and_ack'
Check ($scriptText.Contains("else{") -and $scriptText.Contains('openai_base_url="http://127.0.0.1:17841/v1"')) 'legacy_automatic_path_intact'
@{terminal='PASS';checks=$checks;fake=$true;realModelCalls=0;realRegistryChanges=0;realLaunches=0}|ConvertTo-Json -Compress
