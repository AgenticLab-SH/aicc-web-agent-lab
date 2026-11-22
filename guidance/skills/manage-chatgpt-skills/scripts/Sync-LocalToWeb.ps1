# Content-addressed bridge to the existing personal skill manager. No model calls.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ManifestPath,[string[]]$SkillNames=@(),[switch]$Plan)
$ErrorActionPreference='Stop'
function AbsoluteFile([string]$p){if(![IO.Path]::IsPathFullyQualified($p)){throw 'Absolute path required'};$v=Get-Item -LiteralPath $p -Force;if(!$v.PSIsContainer -and !($v.Attributes -band [IO.FileAttributes]::ReparsePoint)){return $v.FullName};throw 'Regular non-link file required'}
function Save-State($value,[string]$path){$tmp=$path+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($tmp,($value|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $tmp -Destination $path -Force}
# Trace only metadata already returned by the existing calls. Missing evidence never blocks sync.
function New-SyncTraceMetadata($Binding,$File,[string]$BackupReceipt,$Inspection,$ManagerResult,$ManagerExitCode){
 $observed=@{};$origins=@{};$unknown=@{}
 foreach($field in @('identityHash','workspaceIdentityHash','sourceInstance','bundleSha256','packageSha256','consumerId','consumerRevision','receiptPath','operationReceiptPath')){
  $values=@();$from=@()
  foreach($entry in @(@{name='inspection';value=$Inspection},@{name='managerResult';value=$ManagerResult})){
   if($entry.value -is [System.Collections.IDictionary] -and $entry.value.Contains($field)){
    $value=$entry.value[$field]
    $valid=$value -is [string] -and ![string]::IsNullOrWhiteSpace($value)
    if($valid -and $field -in @('identityHash','workspaceIdentityHash','bundleSha256','packageSha256')){$valid=$value -cmatch '^[a-f0-9]{64}$'}
    if($valid -and $field -in @('receiptPath','operationReceiptPath')){$valid=[IO.Path]::IsPathFullyQualified($value)}
    if($valid){$values+=@($value);$from+=@($entry.name)}else{$unknown[$field]='INVALID_RETURNED_METADATA'}
   }
  }
  $distinct=@($values|Select-Object -Unique)
  if($distinct.Count -eq 1){$observed[$field]=$distinct[0];$origins[$field]=@($from)}
  elseif($distinct.Count -gt 1){$observed[$field]=$null;$unknown[$field]='CONFLICTING_RETURNED_METADATA'}
  else{$observed[$field]=$null;if(!$unknown.ContainsKey($field)){$unknown[$field]='NOT_RETURNED_BY_EXISTING_MANAGER'}}
 }
 $summary=@{}
 foreach($field in @('status','account','name','id','skillId','filePath','bodySHA256','beforeSHA256','afterSHA256','zipSHA256','verified','remoteMutation','externalWritePerformed')){
  if($ManagerResult -is [System.Collections.IDictionary] -and $ManagerResult.Contains($field)){
   $value=$ManagerResult[$field]
   if($value -is [string] -or $value -is [bool] -or $null -eq $value){$summary[$field]=$value}
  }
 }
 $inspectionSummary=@{}
 foreach($field in @('status','account','id','name','filePath','bodySHA256')){
  if($Inspection -is [System.Collections.IDictionary] -and $Inspection.Contains($field) -and $Inspection[$field] -is [string]){$inspectionSummary[$field]=$Inspection[$field]}
 }
 $holds=@()
 foreach($entry in @(@{value=$Inspection},@{value=$ManagerResult})){
  if($entry.value -isnot [System.Collections.IDictionary]){continue}
  foreach($field in @('id','skillId')){
   if($entry.value.Contains($field) -and $entry.value[$field] -and $entry.value[$field] -cne $Binding.skillId){$holds+=@('RETURNED_REMOTE_ID_MISMATCH')}
  }
  if($entry.value.Contains('account') -and $entry.value.account -and $entry.value.account -cne $Binding.account){$holds+=@('RETURNED_ACCOUNT_ALIAS_MISMATCH')}
 }
 if($unknown.Values -contains 'CONFLICTING_RETURNED_METADATA'){$holds+=@('CONFLICTING_RETURNED_METADATA')}
 return @{
  schemaVersion=1
  expectedBinding=@{accountAlias=$Binding.account;skillId=$Binding.skillId;filePath=$File.path;sourceRoot=$Binding.sourceRoot;approvedFileSHA256=$File.approvedSHA256}
  backupReceiptRef=$BackupReceipt
  inspection=$inspectionSummary
  managerResult=$summary
  managerExitCode=$ManagerExitCode
  observed=$observed
  observedFieldOrigins=$origins
  unknownFields=$unknown
  holds=@($holds|Select-Object -Unique)
  identityState=if($observed.identityHash -and $observed.workspaceIdentityHash){'RETURNED_METADATA_ONLY'}else{'UNKNOWN'}
  sourceBundleState=if($observed.sourceInstance -and $observed.bundleSha256){'RETURNED_METADATA_ONLY'}else{'UNKNOWN'}
  actualInvocation=if($null -ne $ManagerExitCode){'UPDATE_REQUESTED'}elseif($Inspection){'INSPECT_RETURNED'}else{'NOT_REQUESTED'}
 }
}
$ManifestPath=AbsoluteFile $ManifestPath
$m=Get-Content -LiteralPath $ManifestPath -Raw|ConvertFrom-Json -AsHashtable
if($m.schemaVersion -ne 1){throw 'Unsupported sync manifest'}
$manager=AbsoluteFile $m.manager;$config=AbsoluteFile $m.config
$node=(Get-Command node -ErrorAction Stop).Source
if(![IO.Path]::IsPathFullyQualified($m.stateFile)){throw 'Absolute private stateFile required'}
$stateFile=[IO.Path]::GetFullPath($m.stateFile);$parent=Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($stateFile)) -Force
if(!$parent.PSIsContainer -or ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Existing private state directory required'}
if($m.powershellExecutable){$env:AICC_PWSH=AbsoluteFile $m.powershellExecutable}
$state=if(Test-Path -LiteralPath $stateFile){Get-Content -LiteralPath (AbsoluteFile $stateFile) -Raw|ConvertFrom-Json -AsHashtable}else{@{schemaVersion=1;files=@{}}}
if($state.schemaVersion -ne 1 -or !$state.ContainsKey('files')){throw 'Unknown state; do not overwrite'}
$lock=$null;$results=@();$actualInvocation='NOT_REQUESTED';$boundNames=@($m.bindings|ForEach-Object {$_.name})
foreach($name in $SkillNames){if($name -notin $boundNames){$results+=@{name=$name;status='ASSESSMENT_REQUIRED_NO_BINDING'}}}
try{
 if(!$Plan){$lock=[IO.File]::Open($stateFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
 foreach($b in $m.bindings){
  if($SkillNames.Count -and $b.name -notin $SkillNames){continue}
  if($b.name -notmatch '^[a-z0-9-]+$'){throw 'Invalid skill name'}
  if($b.assessment -eq 'local-only'){$results+=@{name=$b.name;status='LOCAL_ONLY';reason=$b.reason};continue}
  if($b.assessment -ne 'sync' -or !$b.reason){$results+=@{name=$b.name;status='ASSESSMENT_REQUIRED'};continue}
  if($b.skillId -notmatch '^[a-f0-9]{32}$' -or !$b.account -or !$b.displayName){throw 'Exact remote binding required'}
  $source=Get-Item -LiteralPath $b.sourceRoot -Force
  if(!$source.PSIsContainer -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Non-link source root required'}
  foreach($file in $b.files){
   $rel=[string]$file.path
   if($rel -ne 'SKILL.md' -and $rel -notmatch '^references/[a-z0-9-]+[.]md$'){$results+=@{name=$b.name;path=$rel;status='PACKAGE_UPDATE_REQUIRED'};continue}
   if($file.remoteExists -ne $true){$results+=@{name=$b.name;path=$rel;status='REMOTE_FILE_DISCOVERY_REQUIRED'};continue}
   $path=AbsoluteFile (Join-Path $source.FullName $rel);$prefix=$source.FullName.TrimEnd('\')+'\'
   if(!$path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Source boundary mismatch'}
   $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
   if($file.approvedSHA256 -ne $hash){$results+=@{name=$b.name;path=$rel;status='ASSESSMENT_REQUIRED_SOURCE_CHANGED'};continue}
   $key=$b.account+'|'+$b.skillId+'|'+$rel;$old=$state.files[$key]
   if($old -and $old.status -notin @('APPLIED','NO_CHANGE')){$results+=@{name=$b.name;path=$rel;status='RECONCILE_PRIOR_ATTEMPT'};continue}
   if($old -and $old.localSHA256 -eq $hash){$results+=@{name=$b.name;path=$rel;status='UNCHANGED_LOCAL_CACHE'};continue}
   if($Plan){$results+=@{name=$b.name;path=$rel;status='PLANNED';sha256=$hash};continue}
   $managerArgs=@('--account',$b.account,'--name',$b.name,'--display-name',$b.displayName,'--skill-id',$b.skillId,'--config',$config,'--playwright-module',$m.playwrightModule)
   if($rel -ne 'SKILL.md'){$managerArgs+=@('--file-path',$rel)}
   if($b.editorBinding){$managerArgs+=@('--editor-binding',(AbsoluteFile $b.editorBinding),'--identity-module',(AbsoluteFile $m.identityModule))}
   $actualInvocation='INSPECT_REQUESTED'
   $raw=& $node $manager inspect @managerArgs --include-body
   if($LASTEXITCODE -ne 0){$results+=@{name=$b.name;path=$rel;status='INSPECT_FAILED_NO_WRITE'};break}
   $remote=($raw -join "`n")|ConvertFrom-Json -AsHashtable
   if($remote.status -ne 'inspected' -or $remote.bodySHA256 -notmatch '^[a-f0-9]{64}$'){throw 'Fresh body preimage missing'}
   if(!$file.backupReceipt){$results+=@{name=$b.name;path=$rel;status='BACKUP_REQUIRED_GITHUB_AND_NOTION';preimageSHA256=$remote.bodySHA256;desiredSHA256=$hash};continue}
   $backupReceiptRef=AbsoluteFile $file.backupReceipt
   $managerArgs+=@('--backup-receipt',$backupReceiptRef)
   $trace=New-SyncTraceMetadata -Binding $b -File $file -BackupReceipt $backupReceiptRef -Inspection $remote -ManagerResult $null -ManagerExitCode $null
   $state.files[$key]=@{status='DISPATCHING';localSHA256=$hash;remotePreimageSHA256=$remote.bodySHA256;at=[DateTimeOffset]::UtcNow.ToString('o');traceMetadata=$trace};Save-State $state $stateFile
   $actualInvocation='UPDATE_REQUESTED'
   $raw=& $node $manager update-body @managerArgs --expected-current-sha $remote.bodySHA256 --body-file $path --commit --ack $b.name
   $managerExitCode=$LASTEXITCODE
   if($managerExitCode -ne 0){
    $failedReceipt=$null
    try{$failedReceipt=($raw -join "`n")|ConvertFrom-Json -AsHashtable -ErrorAction Stop}catch{}
    $state.files[$key].traceMetadata=New-SyncTraceMetadata -Binding $b -File $file -BackupReceipt $backupReceiptRef -Inspection $remote -ManagerResult $failedReceipt -ManagerExitCode $managerExitCode
    $state.files[$key].status='OUTCOME_UNKNOWN_RECONCILE';Save-State $state $stateFile;$results+=@{name=$b.name;path=$rel;status='OUTCOME_UNKNOWN_RECONCILE'};continue
   }
   $receipt=($raw -join "`n")|ConvertFrom-Json -AsHashtable
   $state.files[$key].traceMetadata=New-SyncTraceMetadata -Binding $b -File $file -BackupReceipt $backupReceiptRef -Inspection $remote -ManagerResult $receipt -ManagerExitCode $managerExitCode
   if($receipt.status -in @('body_updated_verified','already_current')){$state.files[$key].status=if($receipt.status -eq 'already_current'){'NO_CHANGE'}else{'APPLIED'}}else{$state.files[$key].status='OUTCOME_UNKNOWN_RECONCILE'}
   $state.files[$key].managerStatus=$receipt.status;Save-State $state $stateFile
   $results+=@{name=$b.name;path=$rel;status=$state.files[$key].status}
  }
 }
}finally{if($lock){$lock.Dispose()}}
@{schemaVersion=1;plan=[bool]$Plan;results=$results;actualInvocation=$actualInvocation}|ConvertTo-Json -Depth 8