#requires -Version 5.1
<#
Local inbox CRUD for instructions, skills, plugins and Projects.
Never contacts ChatGPT. Remote writes use the existing owner-bound manager/connectors.
#>
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$WorkspaceRoot,
 [ValidateSet('List','Show','Put','Remove','Capabilities')][string]$Action='List',
 [string]$RequestPath,[string]$Id,[string]$ExpectedRevision,
 [string]$InboxPath='web-asset-requests/inbox'
)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$u=[Text.UTF8Encoding]::new($false,$true)
$root=(Resolve-Path -LiteralPath $WorkspaceRoot).Path.TrimEnd('\')
function Get-Digest([byte[]]$b){$a=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($a.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$a.Dispose()}}
function Get-Bounded([string]$Value,[switch]$Missing){
 if(!$Value){throw 'Path required'}
 $p=if([IO.Path]::IsPathRooted($Value)){[IO.Path]::GetFullPath($Value)}else{[IO.Path]::GetFullPath((Join-Path $root $Value))}
 if(!$p.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'HOLD_INBOX_OUTSIDE_WORKSPACE'}
 $rel=$p.Substring($root.Length+1)
 foreach($part in ($rel -split '[\\/]')){if(!$part -or $part.StartsWith('.') -or $part -match '[<>:"|?*\x00-\x1f]|[. ]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([.]|$)'){throw 'HOLD_INBOX_PATH'}}
 for($c=$p;$c -ne $root;$c=[IO.Path]::GetDirectoryName($c)){if(Test-Path -LiteralPath $c){if((Get-Item -LiteralPath $c -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'HOLD_INBOX_LINK'}}}
 if(!$Missing -and !(Test-Path -LiteralPath $p -PathType Leaf)){throw 'HOLD_INBOX_FILE_MISSING'}
 return $p
}
function Read-Json([string]$p){if((Get-Item -LiteralPath $p).Length -gt 1MB){throw 'Inbox JSON exceeds bound'};$u.GetString([IO.File]::ReadAllBytes($p)).TrimStart([char]0xFEFF)|ConvertFrom-Json}
function Save-New($v,[string]$p){
 $b=$u.GetBytes((ConvertTo-Json -InputObject $v -Depth 40 -Compress))
 if(Test-Path -LiteralPath $p){if((Get-Digest ([IO.File]::ReadAllBytes($p))) -cne (Get-Digest $b)){throw 'Immutable inbox revision differs'};return}
 $s=[IO.File]::Open($p,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$s.Write($b,0,$b.Length);$s.Flush()}finally{$s.Dispose()}
}
$capabilities=@(
 @{kind='instructions';operations=@('create-text','update-text','delete-text');route='aicc_web_management_start';options=@('exact personalization textarea values');limits=@('Existing label/placeholder fields and observed UI length; singleton entity is not created/deleted')},
 @{kind='skill';scope='personal';operations=@('create','update-body','update-description','delete','plan-existing-support-file','apply-planned-existing-support-file');route='aicc_web_management_start';options=@('ZIP name/display metadata on create','body','description','existing references Markdown','source-only personal-skill-plan-file and planRequestId/planSHA256 on update-body; owner-bound runtime acceptance required');limits=@('Whole-package update, new supporting files and runtime product toggles require a supported same-ID editor path; no delete/recreate fallback')},
 @{kind='skill';scope='workspace';operations=@('inspect','update-existing-body');route='existing workspace editor binding';options=@('existing SKILL.md/references Markdown');limits=@('AICC source-reader adapter is supported independently of new-file bundling')},
 @{kind='plugin';operations=@('create','update','delete');route='Plugin Creator create/update; owner-bound plugin-delete';options=@('version','description','interface displayName/shortDescription/longDescription/defaultPrompt/category/developerName/brandColor','skills and exact file deletion','skill agents/openai.yaml metadata and invocation policy');limits=@('Preserve actual scope/audience/App/MCP binding; no unsolicited sharing/permission changes; uninstall is separate')},
 @{kind='project';operations=@('create','update','upload-source','delete-source','delete-empty');route='aicc_web_management_start';options=@('w-name','instructions','sources','default memory on create');limits=@('Existing memory is immutable; conversations/sources are not bulk deleted')}
)
try{
 if($Action -eq 'Capabilities'){[ordered]@{schemaVersion=1;capabilities=$capabilities;runtimeVerified=$false;remoteWritePerformed=$false}|ConvertTo-Json -Depth 15;exit 0}
 $inbox=Get-Bounded ($InboxPath.TrimEnd('\','/')+'/anchor') -Missing
 $inbox=[IO.Path]::GetDirectoryName($inbox);$null=[IO.Directory]::CreateDirectory($inbox)
 $lock=[IO.File]::Open((Join-Path $inbox 'writer.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{
  $records=@()
  foreach($directory in Get-ChildItem -LiteralPath $inbox -Directory){
   if($directory.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'HOLD_INBOX_LINK'}
   $all=@(Get-ChildItem -LiteralPath $directory.FullName -File -Filter '*.revision.json'|ForEach-Object {Read-Json $_.FullName}|Sort-Object sequence)
   if($all.Count){$records+=$all[-1]}
  }
  if($Action -eq 'List'){[ordered]@{schemaVersion=1;status='LOCAL_INBOX';requests=@($records);remoteWritePerformed=$false}|ConvertTo-Json -Depth 30;exit 0}
  if($Action -eq 'Put'){
   $p=Get-Bounded $RequestPath;$request=Read-Json $p
   $keys=@('schemaVersion','id','kind','operation','scope','target','files','options','reason','safetyState')
   if(@($request.PSObject.Properties.Name|Where-Object{$_ -cnotin $keys}).Count -or $request.schemaVersion -ne 1 -or $request.id -cnotmatch '^[a-z0-9][a-z0-9-]{2,79}$' -or $request.kind -cnotin @('instructions','skill','plugin','project') -or $request.operation -cnotin @('create','update','delete','options') -or !$request.reason){throw 'HOLD_EXPLICIT_INBOX_REQUEST_REQUIRED'}
   $Id=$request.id
   if(!$request.target -or !$request.target.accountAlias -or $request.scope -cnotin @('personal','workspace')){throw 'HOLD_OWNER_SCOPE_REQUIRED'}
   if($request.operation -cne 'create' -and !$request.target.remoteId -and $request.kind -ne 'instructions'){throw 'HOLD_EXACT_EXISTING_ID_REQUIRED'}
   if($request.safetyState -and $request.safetyState -cnotin @('READY_FOR_INSPECTION','HOLD_SECURITY','HOLD_UNCERTAIN')){throw 'Unknown safety state'}
   $files=@();foreach($f in @($request.files)){
    $file=Get-Bounded $f.path;$item=Get-Item -LiteralPath $file
    if($item.Length -gt 25MB){throw 'File exceeds supported bound'}
    $digest=Get-Digest ([IO.File]::ReadAllBytes($file))
    if($f.sha256 -and $f.sha256 -cne $digest){throw 'HOLD_INBOX_BYTES_CHANGED'}
    $files+= [ordered]@{path=$file.Substring($root.Length+1).Replace('\','/');sha256=$digest;bytes=$item.Length}
   }
   $request.files=$files
  }
  if($Id -cnotmatch '^[a-z0-9][a-z0-9-]{2,79}$'){throw 'Exact inbox id required'}
  $old=@($records|Where-Object{$_.id -ceq $Id})
  if($old.Count -gt 1){throw 'Ambiguous inbox identity'}
  if($Action -eq 'Show'){if(!$old.Count){throw 'Inbox id missing'};$old[0]|ConvertTo-Json -Depth 30;exit 0}
  $old=if($old.Count){$old[0]}else{$null}
  if($old -and $ExpectedRevision -cne $old.revision){throw 'HOLD_INBOX_CAS_REQUIRED'}
  if(!$old -and $ExpectedRevision){throw 'HOLD_INBOX_PREIMAGE_MISSING'}
  if($old -and $old.request.safetyState -cin @('HOLD_SECURITY','HOLD_UNCERTAIN')){throw 'HOLD_ORIGINAL_DENIAL_OR_UNKNOWN_RECONCILE'}
  if($Action -eq 'Remove'){
   if(!$old){throw 'Inbox id missing'}
   $request=$old.request;$state='REMOVED_LOCAL_ONLY'
  }else{$state='STAGED_NOT_DISPATCHED'}
  if($old -and $Action -eq 'Put'){
   foreach($key in @('kind','scope')){if($old.request.$key -cne $request.$key){throw 'HOLD_INBOX_IDENTITY_CHANGE'}}
   if($old.request.target.accountAlias -cne $request.target.accountAlias -or $old.request.target.remoteId -cne $request.target.remoteId){throw 'HOLD_INBOX_TARGET_CHANGE'}
  }
  $sequence=if($old){[int]$old.sequence+1}else{1}
  $payload=[ordered]@{schemaVersion=1;id=$Id;sequence=$sequence;previousRevision=$(if($old){$old.revision}else{$null});state=$state;request=$request}
  $revision=Get-Digest ($u.GetBytes((ConvertTo-Json -InputObject $payload -Depth 40 -Compress)))
  $payload.revision=$revision
  $directory=Join-Path $inbox $Id;$null=[IO.Directory]::CreateDirectory($directory)
  Save-New $payload (Join-Path $directory ($sequence.ToString('D8')+'-'+$revision+'.revision.json'))
  [ordered]@{status=$state;id=$Id;revision=$revision;sequence=$sequence;remoteWritePerformed=$false;next='Inspect exact remote target and create real backup before any dispatch; do not replay uncertain requests'}|ConvertTo-Json -Depth 5
 }finally{$lock.Dispose()}
}catch{[ordered]@{status='HOLD_LOCAL_INBOX';reason=$_.Exception.Message;remoteWritePerformed=$false;automaticRetry=$false}|ConvertTo-Json -Compress;exit 2}
