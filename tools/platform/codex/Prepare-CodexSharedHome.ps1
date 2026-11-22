#requires -Version 7.5
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$CodexHome,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedConfigSha256,
 [Parameter(Mandatory)][string]$OcxCatalog,
 [Parameter(Mandatory)][string]$NativeCatalog,
 [Parameter(Mandatory)][string]$WebCatalog,
 [Parameter(Mandatory)][string]$CredentialHelper,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedCredentialHelperSha256,
 [Parameter(Mandatory)][string]$PowerShellExe,
 [Parameter(Mandatory)][string]$OperationDirectory,
 [Parameter(Mandatory)][string]$StateRoot
)
$ErrorActionPreference='Stop'
function Exact([string]$Path,[switch]$Directory){
 if(-not [IO.Path]::IsPathFullyQualified($Path)){throw 'Explicit absolute path required'}
 $item=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force
 if($item.LinkType -or ($Directory -and -not $item.PSIsContainer) -or (-not $Directory -and $item.PSIsContainer)){throw 'Exact non-linked path kind required'}
 for($parent=$(if($item.PSIsContainer){$item}else{$item.Directory});$parent;$parent=$parent.Parent){if($parent.LinkType){throw 'Linked ancestor refused'}}
 return $item.FullName
}
function Hash([string]$Path){(Get-FileHash -LiteralPath (Exact $Path) -Algorithm SHA256).Hash.ToLowerInvariant()}
function Quoted([string]$Value){ConvertTo-Json -InputObject $Value -Compress}
function New-Text([string]$Path,[string]$Text){$bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text);$stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}}
function Set-Top([string]$Text,[string]$Key,[string]$Value){
 $table=[regex]::Match($Text,'(?m)^\s*\[');$cut=if($table.Success){$table.Index}else{$Text.Length}
 $top=$Text.Substring(0,$cut);$rest=$Text.Substring($cut)
 $pattern='(?m)^\s*'+[regex]::Escape($Key)+'\s*=\s*[^\r\n]*\r?$'
 $matches=[regex]::Matches($top,$pattern)
 if($matches.Count -gt 1){throw 'Duplicate managed top-level setting; reconcile exact input'}
 if($matches.Count){$top=[regex]::Replace($top,$pattern,[Text.RegularExpressions.MatchEvaluator]{param($m) $Key+' = '+$Value})}
 else{$top=$Key+' = '+$Value+"`n"+$top}
 return $top+$rest
}
function Catalog([string]$File,[bool]$WebOnly){
 $full=Exact $File;$value=Get-Content -LiteralPath $full -Raw|ConvertFrom-Json
 $rows=@($value.models)
 if(-not $rows.Count){throw 'Reviewed Codex metadata catalog required; raw /models IDs are insufficient'}
 foreach($row in $rows){if(-not $row.slug -or ([string]$row.slug).StartsWith('chatgpt-web/') -ne $WebOnly){throw 'OCX/Native and Web catalogs must remain separate'}}
 return $full
}
$CodexHome=Exact $CodexHome -Directory;$StateRoot=Exact $StateRoot -Directory
$operation=Exact $OperationDirectory -Directory
if($operation.Equals($CodexHome,[StringComparison]::OrdinalIgnoreCase) -or $operation.StartsWith($CodexHome+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Output must not be the live shared Codex HOME'}
$configFile=Join-Path $CodexHome 'config.toml'
if((Hash $configFile) -cne $ExpectedConfigSha256){throw 'Base config preimage changed; preserve current owner edits'}
$CredentialHelper=Exact $CredentialHelper;$PowerShellExe=Exact $PowerShellExe
if((Hash $CredentialHelper) -cne $ExpectedCredentialHelperSha256){throw 'Credential helper pin changed'}
# Pin the exact PowerShell before any candidate is written; a late hash failure used to leave
# candidates without a receipt, and the next run then refused the existing candidates.
$PowerShellSha256=Hash $PowerShellExe
$OcxCatalog=Catalog $OcxCatalog $false;$NativeCatalog=Catalog $NativeCatalog $false;$WebCatalog=Catalog $WebCatalog $true
$before=[IO.File]::ReadAllText($configFile)
if($before -match '(?im)^\s*(?:experimental_bearer_token|api_key|access_token|refresh_token|password|authorization)\s*='){throw 'Existing raw-secret config requires registered owner reconciliation; do not copy or print it'}
if($before -match '(?m)^\s*profile\s*='){throw 'Existing default profile selection needs owner reconciliation before base route migration'}
$start='# aicc-command-route-r2:begin';$end='# aicc-command-route-r2:end'
if($before.Contains($start) -or $before.Contains($end)){
 if(([regex]::Matches($before,[regex]::Escape($start))).Count -ne 1 -or ([regex]::Matches($before,[regex]::Escape($end))).Count -ne 1){throw 'Ambiguous managed provider block'}
 $before=[regex]::Replace($before,'(?ms)^'+[regex]::Escape($start)+'.*?^'+[regex]::Escape($end)+'\s*\r?\n?','')
}
if($before -match '(?m)^\s*\[\s*model_providers\s*\.\s*(?:aicc-ocx|"aicc-ocx"|''aicc-ocx'')\s*(?:\.|\])'){throw 'Unowned aicc-ocx provider table preserved'}
$desired=Set-Top $before 'model_provider' '"aicc-ocx"'
$desired=Set-Top $desired 'openai_base_url' '"http://127.0.0.1:10100/v1"'
$desired=Set-Top $desired 'model_catalog_json' (Quoted $OcxCatalog)
$authArgs=@('-NoLogo','-NoProfile','-NonInteractive','-File',$CredentialHelper,'-StateRoot',$StateRoot)
$argsToml='['+(@($authArgs|ForEach-Object {Quoted $_}) -join ', ')+']'
$provider=@"
$start
[model_providers.aicc-ocx]
name = "OCX"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
[model_providers.aicc-ocx.auth]
command = $(Quoted $PowerShellExe)
args = $argsToml
timeout_ms = 5000
refresh_interval_ms = 300000
$end
"@
$desired=$desired.TrimEnd()+"`n`n"+$provider+"`n"
$native='model_provider = "openai"'+"`n"+'openai_base_url = "https://chatgpt.com/backend-api/codex"'+"`n"+'model_catalog_json = '+(Quoted $NativeCatalog)+"`n"
$web='model_provider = "openai"'+"`n"+'openai_base_url = "http://127.0.0.1:17841/v1"'+"`n"+'model_catalog_json = '+(Quoted $WebCatalog)+"`n"
$targets=@(
 @{target=$configFile;name='config.toml.candidate';text=$desired},
 @{target=(Join-Path $CodexHome 'native.config.toml');name='native.config.toml.candidate';text=$native},
 @{target=(Join-Path $CodexHome 'aicc-webgpt.config.toml');name='aicc-webgpt.config.toml.candidate';text=$web}
)
foreach($item in $targets){if(Test-Path -LiteralPath (Join-Path $operation $item.name)){throw 'Candidate already exists; reconcile the original operation'}}
$receipt=Join-Path $operation 'shared-home-config.preparation.json'
if(Test-Path -LiteralPath $receipt){throw 'Preparation receipt already exists'}
$rows=@()
foreach($item in $targets){
 $preimage=if(Test-Path -LiteralPath $item.target){Hash $item.target}else{$null}
 $output=Join-Path $operation $item.name;New-Text $output $item.text
 $rows+=@{target=$item.target;expectedBeforeSha256=$preimage;candidate=$output;candidateSha256=(Hash $output)}
}
$manifest=[ordered]@{schemaVersion=1;scopeRevision='command-route-r2';state='PREPARED_NOT_APPLIED';status='PREPARED_NOT_APPLIED';sharedHome=$CodexHome;files=$rows;credentialHelper=$CredentialHelper;credentialHelperSha256=$ExpectedCredentialHelperSha256;powershellSha256=$PowerShellSha256;catalogPins=@(@{path=$OcxCatalog;sha256=(Hash $OcxCatalog)},@{path=$NativeCatalog;sha256=(Hash $NativeCatalog)},@{path=$WebCatalog;sha256=(Hash $WebCatalog)});inherited=@('model','reasoning','approval','reviewer','sandbox','personality','skills','plugins');profileV2=@('native','aicc-webgpt');liveConfigWrites=0;runtimeChanges=0;credentialInvocation=0;activationReady=$false;next='Registered root owner takes exact candidates through existing backup/CAS/active/rollback and daemon handoff; this preparer has no Apply mode'}
New-Text $receipt (ConvertTo-Json -InputObject $manifest -Depth 12)
@{status='PREPARED_NOT_APPLIED';receipt=$receipt;liveConfigWrites=0;runtimeChanges=0;activationReady=$false}|ConvertTo-Json -Compress
