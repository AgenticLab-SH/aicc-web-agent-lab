# Shared by Codex and ChatGPT through the existing AICC workspace executor.
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidateSet('Prepare','GitHub','BeginNotion','ConfirmNotion','AssertReady')][string]$Action,
 [string]$ManifestPath,[string]$ReceiptPath,[string]$NotionPageId,
 [string]$NotionFileUploadId,[string]$NotionDownloadPath,[string]$NotionPageReadPath
)
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false)
function Hash-Bytes([byte[]]$bytes){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()}
function File-Path([string]$p){
 if(![IO.Path]::IsPathFullyQualified($p)){throw 'Absolute file path required'}
 $item=Get-Item -LiteralPath $p -Force
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Regular non-link file required'}
 return $item.FullName
}
function Save-Json($value,[string]$p){
 $tmp=$p+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 [IO.File]::WriteAllText($tmp,(ConvertTo-Json -InputObject $value -Depth 40),$utf8)
 Move-Item -LiteralPath $tmp -Destination $p -Force
}
function Gh-Json([string[]]$arguments){
 $output=& gh @arguments 2>$null
 if($LASTEXITCODE -ne 0){throw 'HOLD_GITHUB: request failed; reconcile the exact object before retry'}
 return ($output -join "`n")|ConvertFrom-Json -AsHashtable
}

function Assert-GhBackupBytes($object,[string]$endpoint){
 if($object.encoding -eq 'base64'){
  if((Hash-Bytes ([Convert]::FromBase64String(($object.content -replace '\s','')))) -ne $r.bundleSHA256){throw 'Remote backup object bytes differ'}
  return
 }
 # GitHub Contents officially returns encoding:none above 1 MiB. Fetch the
 # same pinned repo/path/ref with its raw media type; no new authority or URL.
 if($object.encoding -cne 'none' -or $object.content -cne '' -or $object.type -cne 'file' -or [long]$object.size -ne (Get-Item -LiteralPath $r.bundlePath).Length){throw 'Unexpected large backup metadata'}
 $rawPath=$ReceiptPath+'.raw-'+[guid]::NewGuid().ToString('N')+'.json'
 $start=[Diagnostics.ProcessStartInfo]::new()
 $start.FileName=(@(Get-Command gh -CommandType Application)[0]).Source;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 foreach($arg in @('api',$endpoint,'--header','Accept: application/vnd.github.raw+json')){$start.ArgumentList.Add($arg)}
 $process=[Diagnostics.Process]::new();$process.StartInfo=$start
 $stream=[IO.File]::Open($rawPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{
  if(-not $process.Start()){throw 'HOLD_GITHUB_RAW_READ: process not started'}
  $errorRead=$process.StandardError.ReadToEndAsync()
  $process.StandardOutput.BaseStream.CopyTo($stream);$stream.Flush($true);$process.WaitForExit();$null=$errorRead.GetAwaiter().GetResult()
  if($process.ExitCode -ne 0){throw 'HOLD_GITHUB_RAW_READ: same-object read failed; not absence and no retry'}
 }finally{$stream.Dispose();$process.Dispose()}
 if((Get-FileHash -LiteralPath $rawPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.bundleSHA256){throw 'HOLD_GITHUB_RAW_BYTES: recovered bytes differ'}
 $r.githubReadbackFormat='OFFICIAL_RAW';$r.githubRawReadback=$rawPath
}

if($Action -eq 'Prepare'){
 $m=Get-Content -LiteralPath (File-Path $ManifestPath) -Raw|ConvertFrom-Json -AsHashtable
 if($m.schemaVersion -ne 1 -or $m.privacyReviewed -ne $true){throw 'Reviewed schemaVersion=1 manifest required'}
 if($m.assetKey -notmatch '^[\p{L}\p{N}._|: -]{3,320}$'){throw 'Stable non-secret assetKey required'}
 if($m.operation -notin @('create','update','update-body','delete','source-update','instructions-update','plugin-update','plugin-uninstall')){throw 'Unknown operation'}
 foreach($key in @('preimageSHA256','desiredSHA256')){if($m[$key] -notmatch '^[a-f0-9]{64}$'){throw "Exact $key required (use SHA256 of empty bytes for absent side)"}}
 if($m.githubRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $m.githubBranch -notmatch '^[A-Za-z0-9_./-]+$'){throw 'Existing private GitHub repository and branch required'}
 $root=Get-Item -LiteralPath ([IO.Path]::GetFullPath($m.stateRoot)) -Force
 if(!$root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Existing private stateRoot required'}
 $entries=@();$seen=@{}
 foreach($f in @($m.files|Sort-Object path)){
  if($f.path -notmatch '^[A-Za-z0-9_. /-]+$' -or $f.path -match '(^|/)\.\.(/|$)|^/|\\|:' -or $seen.ContainsKey($f.path)){throw 'Unique safe backup-relative path required'}
  $seen[$f.path]=$true;$bytes=[IO.File]::ReadAllBytes((File-Path $f.source));$hash=Hash-Bytes $bytes
  if($f.sha256 -ne $hash){throw 'Source changed since approved snapshot'}
  $entries+=[ordered]@{path=$f.path;sha256=$hash;contentBase64=[Convert]::ToBase64String($bytes)}
 }
 if(!$entries.Count){throw 'Backup must contain recoverable bytes'}
 $bundle=[ordered]@{schemaVersion=1;assetKey=$m.assetKey;operation=$m.operation;preimageSHA256=$m.preimageSHA256;desiredSHA256=$m.desiredSHA256;recoveryComplete=($m.recoveryComplete -eq $true);files=$entries}
 $bytes=$utf8.GetBytes((ConvertTo-Json -InputObject $bundle -Depth 30 -Compress));$hash=Hash-Bytes $bytes
 $ReceiptPath=Join-Path $root.FullName ($hash+'.receipt.json');$objectPath=Join-Path $root.FullName ($hash+'.json')
 $lock=[IO.File]::Open((Join-Path $root.FullName '.backup.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{
  if(Test-Path -LiteralPath $ReceiptPath){
   $old=Get-Content -LiteralPath (File-Path $ReceiptPath) -Raw|ConvertFrom-Json -AsHashtable
   if($old.bundleSHA256 -ne $hash -or $old.githubRepository -ne $m.githubRepository -or $old.githubBranch -ne $m.githubBranch){throw 'Existing backup destination conflict'}
   $old|ConvertTo-Json -Depth 15;return
  }
  [IO.File]::WriteAllBytes($objectPath,$bytes)
  $r=[ordered]@{schemaVersion=1;assetKey=$m.assetKey;operation=$m.operation;preimageSHA256=$m.preimageSHA256;desiredSHA256=$m.desiredSHA256;recoveryComplete=($m.recoveryComplete -eq $true);bundleSHA256=$hash;bundlePath=$objectPath;receiptPath=$ReceiptPath;githubRepository=$m.githubRepository;githubBranch=$m.githubBranch;githubPath=('web-asset-backups/objects/'+$hash+'.json');githubStatus='NOT_STARTED';notionStatus='NOT_STARTED';createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
  Save-Json $r $ReceiptPath
  $r|ConvertTo-Json -Depth 15;return
 }finally{$lock.Dispose()}
}
$ReceiptPath=File-Path $ReceiptPath
$lock=[IO.File]::Open(($ReceiptPath+'.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
 $r=Get-Content -LiteralPath $ReceiptPath -Raw|ConvertFrom-Json -AsHashtable
 if($r.schemaVersion -ne 1 -or (Hash-Bytes ([IO.File]::ReadAllBytes((File-Path $r.bundlePath)))) -ne $r.bundleSHA256){throw 'Backup receipt or bytes mismatch'}
 if($Action -eq 'GitHub'){
  $repo=Gh-Json @('api',('repos/'+$r.githubRepository))
  if($repo.private -ne $true){throw 'HOLD_PUBLIC_DESTINATION: backups require the existing private repository'}
  $endpoint='repos/'+$r.githubRepository+'/contents/'+$r.githubPath
  $lookup=& gh api ($endpoint+'?ref='+$r.githubBranch) 2>$null;$exit=$LASTEXITCODE
  if($exit -eq 0){
   $object=($lookup -join "`n")|ConvertFrom-Json -AsHashtable
   Assert-GhBackupBytes $object ($endpoint+'?ref='+$r.githubBranch)
   $r.githubStatus='VERIFIED';$r.githubBlobSHA=$object.sha
  }else{
   if(($lookup -join '') -notmatch 'Not Found'){throw 'HOLD_GITHUB_READ: absence unproven'}
   if($r.githubStatus -ne 'NOT_STARTED'){throw 'HOLD_GITHUB_UNKNOWN: reconcile prior dispatch; never recreate automatically'}
   $r.githubStatus='DISPATCHING';Save-Json $r $ReceiptPath
   $payload=[ordered]@{message=('backup: web asset '+$r.bundleSHA256);branch=$r.githubBranch;content=[Convert]::ToBase64String([IO.File]::ReadAllBytes($r.bundlePath))}
   $requestPath=$ReceiptPath+'.github-request.json';Save-Json $payload $requestPath
   $saved=Gh-Json @('api','--method','PUT',$endpoint,'--input',$requestPath)
   $r.githubCommit=$saved.commit.sha;$r.githubBlobSHA=$saved.content.sha;Save-Json $r $ReceiptPath
   $object=Gh-Json @('api',($endpoint+'?ref='+$r.githubCommit))
   Assert-GhBackupBytes $object ($endpoint+'?ref='+$r.githubCommit)
   $r.githubStatus='VERIFIED'
  }
  Save-Json $r $ReceiptPath
 }elseif($Action -eq 'BeginNotion'){
  if($r.notionStatus -eq 'VERIFIED'){$r|ConvertTo-Json -Depth 15;return}
  if($r.notionStatus -ne 'NOT_STARTED'){throw 'HOLD_NOTION_UNKNOWN: fetch the recorded page/upload; do not create a duplicate'}
  $guard=Join-Path $PSScriptRoot '../../aicc-workspace-operator/scripts/Send-NotionLocalFile.ps1'
  $null=& $guard -PageId $NotionPageId -DestinationReadPath $NotionPageReadPath -ValidateDestinationOnly
  $r.notionPageId=$NotionPageId
  $r.notionDestinationReadPath=File-Path $NotionPageReadPath
  $r.notionStatus='DISPATCHING';Save-Json $r $ReceiptPath
 }elseif($Action -eq 'ConfirmNotion'){
  if($r.notionStatus -notin @('DISPATCHING','VERIFIED')){throw 'BeginNotion intent required'}
  if($NotionPageId -notmatch '^[a-f0-9-]{32,36}$'){throw 'Exact connector page ID required'}
  if($r.notionPageId -and $r.notionPageId -ne $NotionPageId){throw 'HOLD_NOTION_DESTINATION: receipt destination mismatch'}
  $download=Get-Content -LiteralPath (File-Path $NotionDownloadPath) -Raw|ConvertFrom-Json -AsHashtable
  if((Hash-Bytes ($utf8.GetBytes([string]$download.content))) -ne $r.bundleSHA256){throw 'Notion recovered bytes differ'}
  $page=Get-Content -LiteralPath (File-Path $NotionPageReadPath) -Raw
  if(!$page.Replace('-','').Contains($NotionPageId.Replace('-',''))){throw 'Notion page readback ID mismatch'}
  if($download.source -eq 'notion-page-inline-json'){
   if($download.notionPageId -ne $NotionPageId){throw 'Inline proof page mismatch'}
   $document=$page|ConvertFrom-Json -AsHashtable
   if($document.text -is [string]){$pageText=$document.text}
   elseif($document.content -is [array] -and $document.content.Count -eq 1 -and $document.content[0].text -is [string]){
    $nested=$document.content[0].text|ConvertFrom-Json -AsHashtable
    if($nested.text -isnot [string]){throw 'Original Notion fetch text required'};$pageText=$nested.text
   }else{throw 'Original Notion fetch response required'}
   $matching=@([regex]::Matches($pageText,'(?ms)^```json\r?\n(?<bytes>.*?)\r?\n```[ \t]*$')|Where-Object{(Hash-Bytes ($utf8.GetBytes($_.Groups['bytes'].Value))) -eq $r.bundleSHA256})
   if($matching.Count -ne 1 -or $matching[0].Groups['bytes'].Value -cne [string]$download.content){throw 'Unique exact inline backup bytes missing from actual page read'}
   if($r.notionFileUploadId){$r.notionRetiredUploadId=$r.notionFileUploadId;$r.Remove('notionFileUploadId')}
   $r.notionFormat='INLINE_JSON'
  }else{
   if($NotionFileUploadId -notmatch '^[a-f0-9-]{32,36}$' -or $download.file_upload_id -ne $NotionFileUploadId){throw 'Exact connector uploaded file ID required'}
   if(!$page.Contains($r.bundleSHA256) -or $page -notmatch '<file src=|notion-file-block://'){throw 'Notion durable attachment readback missing'}
   $r.notionFileUploadId=$NotionFileUploadId;$r.notionFormat='ATTACHMENT'
  }
  $r.notionPageReadPath=(File-Path $NotionPageReadPath);$r.notionRecoveryProofPath=(File-Path $NotionDownloadPath)
  $r.notionPageId=$NotionPageId;$r.notionStatus='VERIFIED';Save-Json $r $ReceiptPath
 }elseif($Action -eq 'AssertReady'){
  if($r.githubStatus -ne 'VERIFIED' -or $r.notionStatus -ne 'VERIFIED'){throw 'HOLD_BACKUP_INCOMPLETE: both destinations must contain recoverable bytes'}
 }
 $r|ConvertTo-Json -Depth 15
}finally{$lock.Dispose()}