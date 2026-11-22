#requires -Version 7.5
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('begin','status','resume','consume')][string]$Action,
  [Parameter(Mandatory)][string]$InstanceDirectory,
  [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{0,95}$')][string]$OperationId,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$Nonce,
  [Parameter(Mandatory)][string]$OperationExpiresAt,
  [Parameter(Mandatory)][int]$ExpectedGatewayPid,
  [Parameter(Mandatory)][ValidatePattern('^[0-9]+$')][string]$ExpectedGatewayCreatedTicks,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedGatewayCommandSha256,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedGatewayImageSha256,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedConfigSha256,
  [ValidatePattern('^[a-f0-9]{64}$')][string]$ReadySnapshotSha256,
  [ValidateRange(1,30)][int]$TimeoutSeconds=15
)
$ErrorActionPreference='Stop'
$stateRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$maintenanceRoot=Join-Path $stateRoot 'runtime\unified-mcp-maintenance'
function Require-PlainPath([string]$Path,[bool]$Directory=$false){
  $full=[IO.Path]::GetFullPath($Path)
  $item=Get-Item -LiteralPath $full -Force
  if([bool]$item.PSIsContainer -ne $Directory -or $item.LinkType -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Regular owner-local non-linked path required'}
  $parent=if($Directory){$item.Parent}else{$item.Directory}
  for(;$parent;$parent=$parent.Parent){if($parent.LinkType -or ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked ancestor refused'}}
  return $full
}
function Digest-Text([string]$Value){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()}
function Digest-File([string]$Path){(Get-FileHash -LiteralPath (Require-PlainPath $Path) -Algorithm SHA256).Hash.ToLowerInvariant()}
function Read-Object([string]$Path){Get-Content -LiteralPath (Require-PlainPath $Path) -Raw | ConvertFrom-Json -AsHashtable -DateKind String}
function Json($Value){ConvertTo-Json -InputObject $Value -Depth 24 -Compress}
function Same-Gateway($A,$B){$A.pid -eq $B.pid -and $A.startedAt -ceq $B.startedAt -and $A.instanceId -ceq $B.instanceId}
function Test-ExactGatewayCommand([string]$Command,[string]$Runtime,[string]$Entry,[string]$Config){
  # The registered launcher emits exactly: node gateway.cjs --config config.json.
  # Accept its quoted/unquoted arguments only; ambiguous quoting fails closed.
  $arguments=@();$offset=0
  foreach($match in [regex]::Matches($Command,'"([^"\r\n]+)"|([^\s"]+)')){
    if($Command.Substring($offset,$match.Index-$offset) -notmatch '^\s*$'){return $false}
    $arguments+=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
    $offset=$match.Index+$match.Length
    if($offset -lt $Command.Length -and -not [char]::IsWhiteSpace($Command[$offset])){return $false}
  }
  if($Command.Substring($offset) -notmatch '^\s*$' -or $arguments.Count -ne 4 -or $arguments[2] -cne '--config'){return $false}
  foreach($pair in @(@($arguments[0],$Runtime),@($arguments[1],$Entry),@($arguments[3],$Config))){
    if(-not [IO.Path]::IsPathFullyQualified($pair[0])){return $false}
    try{$actual=[IO.Path]::GetFullPath($pair[0]).Replace('/','\');$expected=[IO.Path]::GetFullPath($pair[1]).Replace('/','\')}catch{return $false}
    if(-not [string]::Equals($actual,$expected,[StringComparison]::OrdinalIgnoreCase)){return $false}
  }
  return $true
}
$instance=Require-PlainPath $InstanceDirectory $true
if((Split-Path $instance -Parent) -ine [IO.Path]::GetFullPath($maintenanceRoot) -or (Split-Path $instance -Leaf) -notmatch '^\d+-[a-f0-9-]{36}$'){throw 'Exact gateway maintenance instance required'}
$identityFile=Join-Path $instance 'identity.json'
$identity=Read-Object $identityFile
if($identity.schemaVersion -ne 1 -or $identity.kind -cne 'aicc-unified-maintenance' -or $identity.gateway.pid -ne $ExpectedGatewayPid -or $identity.configSha256 -cne $ExpectedConfigSha256 -or $identity.instanceDirectory -ine $instance){throw 'Maintenance identity differs from selected generation'}
$requestDirectory=Require-PlainPath (Join-Path $instance 'requests') $true
$responseDirectory=Require-PlainPath (Join-Path $instance 'responses') $true
if($identity.requestDirectory -ine $requestDirectory -or $identity.responseDirectory -ine $responseDirectory){throw 'Foreign maintenance mailbox refused'}
$registry=Read-Object (Join-Path $stateRoot 'runtime\components.json')
$gateway=$registry.components.'unified-mcp'
if($registry.root -ine $stateRoot -or -not $gateway.releaseRoot.StartsWith((Join-Path $stateRoot 'releases\unified-mcp\'),[StringComparison]::OrdinalIgnoreCase) -or $gateway.entry -ine (Join-Path $gateway.releaseRoot 'gateway.cjs') -or [IO.Path]::GetFullPath($identity.configPath) -ine (Join-Path $gateway.releaseRoot 'config.json') -or (Digest-File $gateway.entry) -cne $gateway.entryHash -or (Digest-File $identity.configPath) -cne $ExpectedConfigSha256){throw 'Registered gateway/config pins differ'}
$owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ExpectedGatewayPid)
if(-not $owner -or $owner.CreationDate.ToUniversalTime().Ticks.ToString() -cne $ExpectedGatewayCreatedTicks -or $owner.ExecutablePath -ine $gateway.runtime -or (Digest-File $owner.ExecutablePath) -cne $ExpectedGatewayImageSha256 -or (Digest-Text ([string]$owner.CommandLine)) -cne $ExpectedGatewayCommandSha256){throw 'Gateway process ownership changed'}
if(-not (Test-ExactGatewayCommand ([string]$owner.CommandLine) $gateway.runtime $gateway.entry $identity.configPath)){throw 'Gateway command does not select the exact registered generation'}
$estimatedStart=[DateTimeOffset]::Parse($identity.gateway.startedAt)
if([Math]::Abs(($estimatedStart.UtcDateTime-$owner.CreationDate.ToUniversalTime()).TotalSeconds) -gt 5){throw 'Gateway start estimate disagrees with actual process creation'}
$operationExpiry=[DateTimeOffset]::Parse($OperationExpiresAt)
$canonicalOperationExpiry=$operationExpiry.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
if($OperationExpiresAt -cne $canonicalOperationExpiry){throw 'Operation expiry must use canonical UTC ISO milliseconds and Z; existing plans are not rewritten'}
if($Action -in @('begin','consume') -and $operationExpiry -le [DateTimeOffset]::UtcNow){throw 'Operation expired; mutation not dispatched'}
if($Action -eq 'consume' -and -not $ReadySnapshotSha256){throw 'Consume requires exact ready snapshot SHA'}
# Never automatically replay an uncertain mutation for this operation.
if($Action -ne 'status'){
  foreach($priorFile in @(Get-ChildItem -LiteralPath $requestDirectory -Filter '*.json' -File)){
    $prior=Read-Object $priorFile.FullName
    if($prior.operationId -ceq $OperationId -and $prior.action -ceq $Action -and -not (Test-Path -LiteralPath (Join-Path $responseDirectory $priorFile.Name))){throw 'Previous mutation response missing; inspect that exact request before retrying'}
  }
}
$requestId=[guid]::NewGuid().ToString()
$requestFile=Join-Path $requestDirectory ($requestId+'.json')
$responseFile=Join-Path $responseDirectory ($requestId+'.json')
$pendingRequest=Join-Path $requestDirectory ($requestId+'.tmp')
$request=@{schemaVersion=1;requestId=$requestId;action=$Action;operationId=$OperationId;nonce=$Nonce;operationExpiresAt=$OperationExpiresAt;requestExpiresAt=[DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");configSha256=$ExpectedConfigSha256;gateway=$identity.gateway}
if($Action -eq 'consume'){$request.readySnapshotSha256=$ReadySnapshotSha256}
$serialized=Json $request
$stream=[IO.File]::Open($pendingRequest,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$bytes=[Text.Encoding]::UTF8.GetBytes($serialized);$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
Move-Item -LiteralPath $pendingRequest -Destination $requestFile
$deadline=[DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
while([DateTimeOffset]::UtcNow -lt $deadline){
  if(Test-Path -LiteralPath $responseFile){
    $response=Read-Object $responseFile
    if($response.schemaVersion -ne 1 -or $response.requestId -cne $requestId -or $response.action -cne $Action -or -not (Same-Gateway $response.identity.gateway $identity.gateway) -or $response.identity.configSha256 -cne $ExpectedConfigSha256){throw ('Response identity mismatch; preserve exact request '+$requestId)}
    if($response.operation -and ($response.operation.operationId -cne $OperationId -or $response.operation.nonce -cne $Nonce -or $response.operation.operationExpiresAt -cne $OperationExpiresAt)){throw ('Operation response mismatch; preserve exact request '+$requestId)}
    @{client=@{requestFile=$requestFile;responseFile=$responseFile;requestSha256=(Digest-Text $serialized);gatewayCreatedTicks=$ExpectedGatewayCreatedTicks;noReplay=$true};response=$response}|ConvertTo-Json -Depth 28
    if($response.ok -cne $true){exit 1}
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
@{ok=$false;outcome='UNCERTAIN_NO_REPLAY';requestId=$requestId;requestFile=$requestFile;responseFile=$responseFile;action=$Action;operationId=$OperationId}|ConvertTo-Json
exit 2
