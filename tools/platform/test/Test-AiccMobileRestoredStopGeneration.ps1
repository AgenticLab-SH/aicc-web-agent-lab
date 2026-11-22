#requires -Version 7.5
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
Import-Module (Join-Path $repo 'tools/platform/windows/MobilePublicStopCompatibility.psm1') -Force
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools/platform/windows/Request-AiccMobilePublicStop.ps1'),[ref]$t,[ref]$e)
foreach($name in @('Get-ExistingStopRequestGate','Read-ExactStopResult','Assert-CurrentStopStatusBinding')){
 $n=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 . ([scriptblock]::Create($n.Extent.Text))
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('restored-stop-'+[guid]::NewGuid().ToString('N'))
$id=[guid]::NewGuid().ToString();$runtime=[guid]::NewGuid().ToString();$dir=Join-Path $root $id;New-Item -ItemType Directory $dir|Out-Null
function WriteFixture($n,$v){[IO.File]::WriteAllText((Join-Path $dir $n),($v|ConvertTo-Json -Compress))}
function Get-CimInstance {param($ClassName,$Filter,$ErrorAction) if($script:oldPresent){@{ProcessId=123}}}
$req=@{action='drain-and-stop';operationId=$id;runtimeId=$runtime;expectedPid=123;expectedStartedAt='2026-01-01T00:00:00.123Z';releaseManifestSha256=('a'*64);expiresAt='2026-01-01T00:01:00Z'}
WriteFixture request.json $req;$sha=(Get-FileHash (Join-Path $dir 'request.json')).Hash.ToLowerInvariant()
$claim=@{schemaVersion=1;operationId=$id;runtimeId=$runtime;pid=123;state='CLAIMED_INPUT_OUTCOME_UNKNOWN';at='2026-01-01T00:00:30Z';requestSha256=$sha;automaticReplay=$false};WriteFixture claim.json $claim
$result=@{schemaVersion=1;kind='aicc-mobile-stop-result/v1';operationId=$id;runtimeId=$runtime;pid=123;startedAt=$req.expectedStartedAt;releaseManifestSha256=('a'*64);requestSha256=$sha;state='NORMAL_STOPPED';lastStopResult='NORMAL_STOP_ACK';observedAt='2026-01-01T00:00:35Z';automaticReplay=$false};WriteFixture result.json $result
$status=@{pid=456;startedAt='2026-01-01T00:02:00.123Z';state='LISTENING';releaseManifestSha256=('a'*64)}
$gen=@{verified=$true;pid=456;startedAt=$status.startedAt;manifestSha256=('a'*64);createdAt='2026-01-01T00:02:00Z'}
$script:oldPresent=$false;$pass=0
function Check($yes){if(-not $yes){throw 'restored_generation_boundary_failed'};$script:pass++}
function Gate {Get-ExistingStopRequestGate $root $runtime ([guid]::NewGuid().ToString()) $status $gen}
Check (Gate).supported
$script:oldPresent=$true;Check (-not (Gate).supported);$script:oldPresent=$false
$result.lastStopResult='UNKNOWN';WriteFixture result.json $result;Check (-not (Gate).supported)
$result.lastStopResult='NORMAL_STOP_ACK';$result.requestSha256='b'*64;WriteFixture result.json $result;Check (-not (Gate).supported)
$result.requestSha256=$sha;$result.observedAt='2026-01-01T00:03:00Z';WriteFixture result.json $result;Check (-not (Gate).supported)
$result.observedAt='2026-01-01T00:00:20Z';WriteFixture result.json $result;Check (-not (Gate).supported)
$result.observedAt='2026-01-01T00:00:35Z';WriteFixture result.json $result;$gen.verified=$false;Check (-not (Gate).supported);$gen.verified=$true
$claim.requestSha256='c'*64;WriteFixture claim.json $claim;Check (-not (Gate).supported)
@{state='PASS';passed=$pass;runtimeMutations=0;fixture=$root}|ConvertTo-Json -Compress
