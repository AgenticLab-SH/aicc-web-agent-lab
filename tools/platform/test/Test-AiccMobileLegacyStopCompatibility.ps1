#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
Import-Module (Join-Path $AiccRoot 'tools/platform/windows/MobilePublicStopCompatibility.psm1') -Force -DisableNameChecking
$pass=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw $Name};$script:pass++}
$manifest='2a9e293d9619aa10f029265bd6b2ddac11fc4769b88c24f025ca3bc3938336cd'
$supervisor='7e6f857fcd12059be9733e70cd071a5f77827f6c5137ac53de7685198ef8345d'
$runnerPin='548f29b873840b999f9e8d5d88b62abc6e563a319efe1118600ebbea335e7e94'
Check (Test-AiccMobileLegacyStopPins $manifest $supervisor $runnerPin) 'exact_reviewed_pair'
foreach($p in @(@(('0'*64),$supervisor,$runnerPin),@($manifest,('0'*64),$runnerPin),@($manifest,$supervisor,('0'*64)))){
 Check (-not (Test-AiccMobileLegacyStopPins $p[0] $p[1] $p[2])) 'changed_source_or_manifest_holds'
}
$status=@{state='LISTENING';pid=4656;startedAt='2026-11-12T17:50:14.975Z';releaseManifestSha256=$manifest}
$cfg='C:\fixture\runtime.json';$node='C:\fixture\node.exe';$sup='C:\fixture\supervisor.ps1';$runnerPath='C:\fixture\runner.mjs';$cfgSha='a'*64
$child=@{ProcessId=4656;ParentProcessId=17344;ExecutablePath=$node;CreationDate=[DateTimeOffset]'2026-11-12T17:50:14.477625Z';CommandLine='"'+$node+'" '+$runnerPath+' '+$cfg}
$parent=@{ProcessId=17344;ExecutablePath='C:\fixture\pwsh.exe';CreationDate=[DateTimeOffset]'2026-11-12T17:49:40.819456Z';CommandLine='"C:\fixture\pwsh.exe"  -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$sup+'" -ConfigFile "'+$cfg+'" -ExpectedConfigSha256 '+$cfgSha}
function Generation($s=$status,$c=$child,$p=$parent){Test-AiccMobileLegacyGeneration $s $c $p $cfg $cfgSha $sup $runnerPath $node}
Check (Generation) 'exact_live_process_generation'
foreach($field in @('ProcessId','ParentProcessId','ExecutablePath','CreationDate','CommandLine')){
 $bad=$child.Clone();$bad[$field]=switch($field){'ProcessId'{1};'ParentProcessId'{2};'CreationDate'{[DateTimeOffset]'2026-11-12T17:50:15Z'};default{'different'}}
 Check (-not (Generation $status $bad $parent)) ('wrong_child_'+$field)
}
$bad=$parent.Clone();$bad.CommandLine+=' -Command injected';Check (-not (Generation $status $child $bad)) 'extra_supervisor_command_rejected'
$bad=$child.Clone();$bad.CreationDate=[DateTimeOffset]'2026-11-12T17:40:14Z';Check (-not (Generation $status $bad $parent)) 'stale_pid_generation'
$bad=$status.Clone();$bad.startedAt='2026-11-12T17:50:14.975+00:00';Check (-not (Generation $bad)) 'non_js_timestamp_rejected'
$bad=$status.Clone();$bad.state='NORMAL_STOPPED';Check (-not (Generation $bad)) 'legacy_support_only_live_listening'

# Same actual pwsh binary; only a fixed data serializer is executed, not a service.
$pwsh=(Get-Process -Id $PID).Path;$pwshSha=(Get-FileHash -LiteralPath $pwsh).Hash.ToLowerInvariant()
foreach($case in @(@('2026-11-12T17:50:14.975Z',$true),@('2026-10-31T04:47:53.156Z',$true),
 @('2026-11-01T15:56:08.410Z',$false),@('2026-01-01T00:00:00.000Z',$false),@('2026-01-01T00:00:00.100Z',$false))){
 $r=Invoke-AiccMobileLegacyDateProbe $pwsh $pwshSha $case[0]
 Check ($r.exact -eq $case[1]) ('real_serializer_'+$case[0])
}
$denied=$false;try{Invoke-AiccMobileLegacyDateProbe $pwsh ('0'*64) $status.startedAt}catch{$denied=$true};Check $denied 'serializer_executable_pin'

$runtime=[guid]::NewGuid().ToString();$op=[guid]::NewGuid().ToString();$query=[guid]::NewGuid().ToString()
$request=@{action='drain-and-stop';runtimeId=$runtime;operationId=$op;expectedPid=23508;expectedStartedAt='2026-11-01T15:56:08.41Z';releaseManifestSha256=$manifest;expiresAt='2026-11-03T17:47:50.6306124+00:00'}
$claim=@{schemaVersion=1;operationId=$op;runtimeId=$runtime;pid=23508;requestSha256='b'*64;state='CLAIMED_INPUT_OUTCOME_UNKNOWN';at='2026-11-03T17:47:06.3441430+00:00';automaticReplay=$false}
$evidence=@{verified=$true;pid=$status.pid;startedAt=$status.startedAt;manifestSha256=$manifest;createdAt='2026-11-12T17:50:14.477625Z'}
function Historical($req=$request,$c=$claim,$e=$evidence,$absent=$true){Test-AiccMobileHistoricalStopBinding $req $c ('b'*64) $runtime $op $status $e $absent}
Check (Historical) 'old_lossy_timestamp_is_history_not_current_authority'
Check (-not (Historical $request $claim $evidence $false)) 'old_pid_present_holds'
Check (-not (Historical $request $claim $null)) 'unverified_current_generation_holds'
foreach($field in @('runtimeId','operationId','expectedPid','expectedStartedAt','releaseManifestSha256','expiresAt')){
 $bad=$request.Clone();$bad[$field]=switch($field){'expectedPid'{$status.pid};'expectedStartedAt'{$status.startedAt};'expiresAt'{'2026-11-13T00:00:00Z'};default{'wrong'}}
 Check (-not (Historical $bad)) ('bad_historical_request_'+$field)
}
foreach($field in @('runtimeId','operationId','pid','requestSha256','state','at','automaticReplay')){
 $bad=$claim.Clone();$bad[$field]=switch($field){'pid'{4656};'automaticReplay'{$true};'at'{'2026-11-13T00:00:00Z'};default{'wrong'}}
 Check (-not (Historical $request $bad)) ('bad_historical_claim_'+$field)
}

# Exercise the real inventory gate with fake process lookup and real temp files.
$stopFile=Join-Path $AiccRoot 'tools/platform/windows/Request-AiccMobilePublicStop.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($stopFile,[ref]$tokens,[ref]$errors)
Check (@($errors).Count -eq 0) 'request_helper_parse'
foreach($name in @('Get-ExistingStopRequestGate','Assert-CurrentStopStatusBinding','Read-ExactStopResult','Get-SupervisorStopReadiness')){
 $fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
 . ([scriptblock]::Create($fn.Extent.Text))
}
Check (-not (Get-SupervisorStopReadiness '$x|ConvertFrom-Json -AsHashtable').supported) 'generic_legacy_ast_still_refuses'
Check ((Get-SupervisorStopReadiness '$x|ConvertFrom-Json -AsHashtable -DateKind String').supported) 'modern_parser_still_supported'
$reads=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'ConvertFrom-Json'},$true))
Check ($reads.Count -eq 9) 'new_inventory_read_count_reviewed'
foreach($read in $reads){Check ($read.Extent.Text -match '-AsHashtable\s+-DateKind\s+String') 'all_owner_reads_remain_strings'}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-legacy-stop-'+[guid]::NewGuid().ToString('N'))
$dir=Join-Path $root $op;New-Item -ItemType Directory -Path $dir -Force|Out-Null
$requestFile=Join-Path $dir 'request.json';$claimFile=Join-Path $dir 'claim.json'
[IO.File]::WriteAllText($requestFile,($request|ConvertTo-Json -Compress))
$claim.requestSha256=(Get-FileHash -LiteralPath $requestFile).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($claimFile,($claim|ConvertTo-Json -Compress))
$before=@((Get-FileHash -LiteralPath $requestFile).Hash,(Get-FileHash -LiteralPath $claimFile).Hash)
$script:oldExists=$false;$script:lookupFails=$false
function Get-CimInstance {param($ClassName,$Filter,$ErrorAction);if($script:lookupFails){throw 'lookup unavailable'};if($script:oldExists){return @{ProcessId=23508}}}
$r=Get-ExistingStopRequestGate $root $runtime $query $status $evidence
Check ($r.supported -and $r.historicalUnknown -eq 1 -and $r.pending -eq 0) 'history_disjoint_not_settled'
$r=Get-ExistingStopRequestGate $root $runtime $op $status $evidence
Check ($r.historicalUnknown -eq 1 -and $r.supported) 'query_original_history_still_counted'
$r=Get-ExistingStopRequestGate $root $runtime $query $status
Check (-not $r.supported -and $r.pending -eq 1) 'no_generation_evidence_keeps_previous_hold'
$script:oldExists=$true
Check ((Get-ExistingStopRequestGate $root $runtime $query $status $evidence).reason -ceq 'EXISTING_STOP_INVENTORY_UNKNOWN') 'old_pid_present_inventory_hold'
$script:oldExists=$false;$script:lookupFails=$true
Check (-not (Get-ExistingStopRequestGate $root $runtime $query $status $evidence).supported) 'process_lookup_unknown_holds'
$script:lookupFails=$false
$goodClaim=[IO.File]::ReadAllText($claimFile);$bad=$claim.Clone();$bad.requestSha256='0'*64
[IO.File]::WriteAllText($claimFile,($bad|ConvertTo-Json -Compress))
Check (-not (Get-ExistingStopRequestGate $root $runtime $query $status $evidence).supported) 'tampered_claim_holds'
[IO.File]::WriteAllText($claimFile,$goodClaim)
$missingClaimArchive=Join-Path $root 'fixture-original-claim-preserved.json'
Move-Item -LiteralPath $claimFile -Destination $missingClaimArchive
Check (-not (Get-ExistingStopRequestGate $root $runtime $query $status $evidence).supported) 'missing_historical_claim_holds'
Move-Item -LiteralPath $missingClaimArchive -Destination $claimFile
# A current generation UNKNOWN is never classified historical.
$currentOp=[guid]::NewGuid().ToString();$currentDir=Join-Path $root $currentOp;New-Item -ItemType Directory -Path $currentDir|Out-Null
$current=$request.Clone();$current.operationId=$currentOp;$current.expectedPid=$status.pid;$current.expectedStartedAt=$status.startedAt
[IO.File]::WriteAllText((Join-Path $currentDir 'request.json'),($current|ConvertTo-Json -Compress))
$r=Get-ExistingStopRequestGate $root $runtime $query $status $evidence
Check (-not $r.supported -and $r.pending -eq 1 -and $r.historicalUnknown -eq 1) 'current_unknown_still_blocks'
Check ((Get-FileHash -LiteralPath $requestFile).Hash -ceq $before[0] -and (Get-FileHash -LiteralPath $claimFile).Hash -ceq $before[1]) 'original_request_claim_bytes_preserved'
$prepare=[IO.File]::ReadAllText((Join-Path $AiccRoot 'tools/platform/windows/Prepare-AiccMobilePublicRuntime.ps1'))
Check ($prepare.Contains("`$overlay += 'tools/platform/windows/MobilePublicStopCompatibility.psm1'")) 'candidate_includes_new_dependency'
@{passed=$pass;failed=0;fixtureRoot=$root;operationalRequests=0;runtimeMutations=0;scope='new legacy compatibility boundary only'}|ConvertTo-Json -Compress
