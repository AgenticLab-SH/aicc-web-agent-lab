#requires -Version 7.5
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$PreviousBindingFile,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPreviousBindingSha256,
 [Parameter(Mandatory)][string]$ManagerBindingFile,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedManagerBindingSha256,
 [ValidateSet('project-source-read','personal-skill-plan-file','personal-skill-plan-add-file','personal-skill-add-file')]
 [string[]]$AdditionalActions=@('project-source-read','personal-skill-plan-file'),
 [Parameter(Mandatory)][string]$OutputFile
)
$ErrorActionPreference='Stop'
# Artifact preparation only. No manager launch, runtime copy, config write or registration.
function Exact-Path([string]$Value,[switch]$Directory){
 if(-not [IO.Path]::IsPathFullyQualified($Value)){throw 'Explicit absolute path required'}
 $full=[IO.Path]::GetFullPath($Value);$item=Get-Item -LiteralPath $full -Force
 if($item.LinkType -or ($Directory -and -not $item.PSIsContainer) -or (-not $Directory -and $item.PSIsContainer)){throw 'Exact non-linked path kind required'}
 for($parent=$(if($item.PSIsContainer){$item}else{$item.Directory});$parent;$parent=$parent.Parent){if($parent.LinkType){throw 'Linked ancestor refused'}}
 return $full
}
function Inside([string]$Root,[string]$File){
 $prefix=[IO.Path]::GetFullPath($Root).TrimEnd('\','/')
 $target=[IO.Path]::GetFullPath($File)
 return $target.Equals($prefix,[StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($prefix+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
}
function Read-Pinned([string]$File,[string]$Expected){
 $full=Exact-Path $File
 if((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Expected){throw 'Exact preparation input pin changed'}
 return Get-Content -LiteralPath $full -Raw|ConvertFrom-Json -AsHashtable -DateKind String
}
function Same($Left,$Right){
 if($null -eq $Left -or $null -eq $Right){return ($null -eq $Left -and $null -eq $Right)}
 if($Left -is [Collections.IDictionary] -and $Right -is [Collections.IDictionary]){
  if($Left.Count -ne $Right.Count){return $false}
  foreach($key in $Left.Keys){if(-not $Right.Contains($key) -or -not (Same $Left[$key] $Right[$key])){return $false}}
  return $true
 }
 if($Left -is [array] -and $Right -is [array]){
  if($Left.Count -ne $Right.Count){return $false}
  for($i=0;$i -lt $Left.Count;$i++){if(-not (Same $Left[$i] $Right[$i])){return $false}}
  return $true
 }
 return (ConvertTo-Json -InputObject $Left -Compress -Depth 60) -ceq (ConvertTo-Json -InputObject $Right -Compress -Depth 60)
}
$previous=Read-Pinned $PreviousBindingFile $ExpectedPreviousBindingSha256
$manager=Read-Pinned $ManagerBindingFile $ExpectedManagerBindingSha256
foreach($binding in @($previous,$manager)){
 if($binding.schemaVersion -ne 1 -or $binding.kind -cne 'aicc-web-management-owner-binding' -or $binding.executionBoundary -cne 'owner-registered-fixed-web-manager'){throw 'Existing fixed-manager binding required'}
 if($binding.allowedActions -isnot [array] -or -not $binding.allowedActions.Count -or @($binding.allowedActions|Where-Object {$_ -isnot [string] -or -not $_}).Count){throw 'Explicit action list required'}
 if(@($binding.allowedActions|Select-Object -Unique -CaseInsensitive).Count -ne $binding.allowedActions.Count){throw 'Duplicate action refused'}
 foreach($key in @('blockedRequestHashes','blockedAssetKeys')){if($binding[$key] -isnot [array]){throw 'Original denial lists required'}}
 $null=Exact-Path $binding.workspaceRoot -Directory
 if((Inside $binding.workspaceRoot $PreviousBindingFile) -or (Inside $binding.workspaceRoot $ManagerBindingFile)){throw 'Owner authority cannot come from the remote workspace'}
}
$additions=@($AdditionalActions | Select-Object -Unique)
foreach($action in $previous.allowedActions){if($action -cnotin $manager.allowedActions){throw 'Existing management action removed'}}
foreach($action in $manager.allowedActions){if($action -cnotin $previous.allowedActions -and $action -cnotin $additions){throw 'Unrelated action expansion refused'}}
foreach($key in @('blockedRequestHashes','blockedAssetKeys')){foreach($value in $previous[$key]){if($value -cnotin $manager[$key]){throw 'Original denied operation must remain blocked'}}}
# Match the existing updater's immutable identity boundary; runtime pins stay proposed.
$runtimeKeys=@('entry','entrySha256','config','configSha256','dependencyPins','allowedActions','blockedRequestHashes','blockedAssetKeys')
$previousIdentity=@{};$managerIdentity=@{}
foreach($key in $previous.Keys){if($key -cnotin $runtimeKeys){$previousIdentity[$key]=$previous[$key]}}
foreach($key in $manager.Keys){if($key -cnotin $runtimeKeys){$managerIdentity[$key]=$manager[$key]}}
if(-not (Same $previousIdentity $managerIdentity)){throw 'Existing owner, workspace, node, limits and operation identity must be preserved'}
$manager.allowedActions=@($previous.allowedActions)+@($additions|Where-Object {$_ -cnotin $previous.allowedActions})
if(-not [IO.Path]::IsPathFullyQualified($OutputFile)){throw 'Explicit absolute output file required'}
$target=[IO.Path]::GetFullPath($OutputFile);$null=Exact-Path (Split-Path -Parent $target) -Directory
if((Inside $previous.workspaceRoot $target) -or (Test-Path -LiteralPath $target)){throw 'Create-once owner-local output outside the remote workspace required'}
$artifact=[ordered]@{
 schemaVersion=1;kind='aicc-web-management-binding-preparation';status='DRAFT_NOT_INSTALLABLE'
 previousBindingFile=[IO.Path]::GetFullPath($PreviousBindingFile);previousBindingSha256=$ExpectedPreviousBindingSha256
 managerBindingFile=[IO.Path]::GetFullPath($ManagerBindingFile);managerBindingSha256=$ExpectedManagerBindingSha256
 additions=@($additions|Where-Object {$_ -cnotin $previous.allowedActions});proposedBinding=$manager
 runtimeClosureAcceptance='NOT_RUN';installedActions='UNCHANGED';activationReady=$false
 remaining=@('Owner materializes and seals the exact source-read/plan-file manager closure with full dependency pins and unchanged account config authority','Existing updater validates a separate PREPARED_NOT_ACTIVE candidate with actual provider toolHash and preserved native/host graph','Exact change and recovery bytes receive existing GitHub and Notion VERIFIED receipts','Root owns fresh independent READY, device lease, normal completion/idle+unknown, owner CAS, rollback, one signal and publication')
 runtimeMutation=0;registration=0;managerInvocation=0;browserStart=0
}
$bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $artifact -Depth 60)+[Environment]::NewLine)
$stream=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
[ordered]@{status=$artifact.status;activationReady=$false;outputFile=$target;runtimeMutation=0;registration=0}|ConvertTo-Json -Compress
