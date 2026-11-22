#requires -Version 5.1
# Companion to WebAssetBackup.ps1 for connector-driven ordinary Chat.
# Local files only. GitHub/Notion writes and reads use their actual connectors.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('Prepare','RecordGitHub','BeginNotion','ConfirmNotion')][string]$Action,
 [Parameter(Mandatory=$true)][string]$WorkspaceRoot,
 [string]$ManifestPath,[string]$ReceiptPath,[string]$ReadbackPath,[string]$NotionPageId
)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$utf8=[Text.UTF8Encoding]::new($false,$true)
$root=(Resolve-Path -LiteralPath $WorkspaceRoot).Path.TrimEnd('\')
$prefix=$root+'\'
function Hash([byte[]]$Bytes){$a=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($a.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$a.Dispose()}}
function File([string]$Value,[switch]$Missing){
 $p=if([IO.Path]::IsPathRooted($Value)){[IO.Path]::GetFullPath($Value)}else{[IO.Path]::GetFullPath((Join-Path $root $Value))}
 if(-not $p.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'HOLD_BACKUP_OUTSIDE_WORKSPACE'}
 $relative=$p.Substring($prefix.Length)
 if(@($relative -split '[\\/]'|Where-Object{!$_ -or $_.StartsWith('.') -or $_ -match '[<>:"|?*\x00-\x1f]|[. ]$'}).Count){throw 'HOLD_BACKUP_PATH'}
 for($c=$p;$c -and $c -ne $root;$c=[IO.Path]::GetDirectoryName($c)){if(Test-Path -LiteralPath $c){if((Get-Item -Force -LiteralPath $c).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'HOLD_BACKUP_LINK'}}}
 if(!$Missing -and !(Test-Path -LiteralPath $p -PathType Leaf)){throw 'HOLD_BACKUP_FILE_MISSING'}
 return $p
}
function Load([string]$Path){$utf8.GetString([IO.File]::ReadAllBytes((File $Path))).TrimStart([char]0xFEFF)|ConvertFrom-Json}
function Save($Value,[string]$Path){$text=ConvertTo-Json -InputObject $Value -Depth 40 -Compress;[IO.File]::WriteAllText($Path,$text,$utf8)}
function Unwrap($Value){if($Value.structuredContent){return $Value.structuredContent};if($Value.text){return $Value};if(@($Value.content).Count -eq 1){return ($Value.content[0].text|ConvertFrom-Json)};throw 'HOLD_ORIGINAL_CONNECTOR_RESPONSE_REQUIRED'}
try{
 if($Action -eq 'Prepare'){
  $m=Load $ManifestPath
  if($m.schemaVersion -ne 1 -or $m.privacyReviewed -ne $true -or $m.githubRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or !$m.githubBranch -or $m.assetKey -notmatch '^[\p{L}\p{N}._|: -]{3,320}$' -or $m.operation -notin @('create','update','update-body','delete','source-update','instructions-update','plugin-update')){throw 'HOLD_REVIEWED_MANIFEST_REQUIRED'}
  foreach($k in @('preimageSHA256','desiredSHA256')){if($m.$k -cnotmatch '^[a-f0-9]{64}$'){throw 'HOLD_BACKUP_HASH_REQUIRED'}}
  $directory=File ($m.stateRoot.TrimEnd('\')+'\placeholder') -Missing
  $directory=[IO.Path]::GetDirectoryName($directory)
  $null=[IO.Directory]::CreateDirectory($directory)
  $files=@();$seen=@{}
  foreach($f in @($m.files|Sort-Object path)){
   if($f.path -notmatch '^(before|desired)/[A-Za-z0-9_. /-]+$' -or $f.path -match '(^|/)\.\.(/|$)' -or $seen.ContainsKey($f.path)){throw 'HOLD_BACKUP_RELATIVE_FILE'}
   $seen[$f.path]=$true;$bytes=[IO.File]::ReadAllBytes((File $f.source));$h=Hash $bytes
   if($h -cne $f.sha256){throw 'HOLD_BACKUP_SOURCE_CHANGED'}
   $files+= [ordered]@{path=$f.path;sha256=$h;contentBase64=[Convert]::ToBase64String($bytes)}
  }
  if(!$files.Count){throw 'HOLD_EMPTY_BACKUP'}
  $bundle=[ordered]@{schemaVersion=1;assetKey=$m.assetKey;operation=$m.operation;preimageSHA256=$m.preimageSHA256;desiredSHA256=$m.desiredSHA256;recoveryComplete=($m.recoveryComplete -eq $true);files=$files}
  $text=ConvertTo-Json -InputObject $bundle -Depth 30 -Compress;$bytes=$utf8.GetBytes($text);$h=Hash $bytes
  $ReceiptPath=Join-Path $directory ($h+'.receipt.json');$bundlePath=Join-Path $directory ($h+'.json')
  if(Test-Path -LiteralPath $ReceiptPath){$r=Load $ReceiptPath;if($r.githubRepository -cne $m.githubRepository -or $r.bundleSHA256 -cne $h){throw 'HOLD_BACKUP_DESTINATION_CONFLICT'}}
  else{[IO.File]::WriteAllBytes($bundlePath,$bytes);$r=[pscustomobject][ordered]@{schemaVersion=1;assetKey=$m.assetKey;operation=$m.operation;preimageSHA256=$m.preimageSHA256;desiredSHA256=$m.desiredSHA256;recoveryComplete=($m.recoveryComplete -eq $true);bundleSHA256=$h;bundlePath=$bundlePath;receiptPath=$ReceiptPath;githubRepository=$m.githubRepository;githubBranch=$m.githubBranch;githubPath=('web-asset-backups/objects/'+$h+'.json');githubStatus='NOT_STARTED';notionStatus='NOT_STARTED';createdAt=[DateTimeOffset]::UtcNow.ToString('o')};Save $r $ReceiptPath}
  [ordered]@{status='LOCAL_BACKUP_PREPARED';receipt=$r;bundleText=$text;remoteWritePerformed=$false}|ConvertTo-Json -Depth 35 -Compress;exit 0
 }
 $ReceiptPath=File $ReceiptPath;$r=Load $ReceiptPath
 if((Hash ([IO.File]::ReadAllBytes((File $r.bundlePath)))) -cne $r.bundleSHA256){throw 'HOLD_BACKUP_BUNDLE_CHANGED'}
 $read=Unwrap (Load $ReadbackPath)
 if($Action -eq 'RecordGitHub'){
  if($read.encoding -ne 'utf-8' -or !$read.sha -or (Hash ($utf8.GetBytes([string]$read.content))) -cne $r.bundleSHA256){throw 'HOLD_GITHUB_BYTES'}
  $expected='https://github.com/'+$r.githubRepository+'/blob/'
  if(!$read.display_url.StartsWith($expected) -or !$read.display_url.EndsWith('/'+$r.githubPath)){throw 'HOLD_GITHUB_TARGET'}
  $r.githubStatus='VERIFIED';$r|Add-Member -NotePropertyName githubBlobSHA -NotePropertyValue $read.sha -Force
 }else{
  if($NotionPageId -notmatch '^[a-f0-9-]{32,36}$' -or $read.id.Replace('-','') -cne $NotionPageId.Replace('-','') -or !$read.text -or $read.truncated -eq $true){throw 'HOLD_NOTION_EXACT_DESTINATION_READ'}
  if($Action -eq 'BeginNotion'){
   if($r.notionStatus -ne 'NOT_STARTED'){throw 'HOLD_NOTION_PRIOR_INTENT_RECONCILE'}
   $r|Add-Member -NotePropertyName notionPageId -NotePropertyValue $NotionPageId -Force;$r.notionStatus='DISPATCHING'
  }else{
   if($r.notionStatus -ne 'DISPATCHING' -or $r.notionPageId -cne $NotionPageId){throw 'HOLD_NOTION_INTENT_REQUIRED'}
   $match=@([regex]::Matches($read.text,'(?ms)^```json\r?\n(?<bytes>.*?)\r?\n```[ \t]*$')|Where-Object{(Hash ($utf8.GetBytes($_.Groups['bytes'].Value))) -ceq $r.bundleSHA256})
   if($match.Count -ne 1){throw 'HOLD_NOTION_UNIQUE_INLINE_BYTES_REQUIRED'}
   $proofPath=$ReceiptPath+'.notion-proof.json';$pagePath=$ReceiptPath+'.notion-read.json'
   Save ([ordered]@{source='notion-page-inline-json';notionPageId=$NotionPageId;content=$match[0].Groups['bytes'].Value}) $proofPath
   Save $read $pagePath
   $r.notionStatus='VERIFIED';$r|Add-Member -NotePropertyName notionFormat -NotePropertyValue 'INLINE_JSON' -Force
   $r|Add-Member -NotePropertyName notionRecoveryProofPath -NotePropertyValue $proofPath -Force
   $r|Add-Member -NotePropertyName notionPageReadPath -NotePropertyValue $pagePath -Force
  }
 }
 Save $r $ReceiptPath
 [ordered]@{status='BACKUP_RECEIPT_UPDATED';receipt=$r;remoteWritePerformed=$false}|ConvertTo-Json -Depth 15 -Compress
}catch{[ordered]@{status='HOLD_BACKUP';reason=$_.Exception.Message;remoteWritePerformed=$false;automaticRetry=$false}|ConvertTo-Json -Compress;exit 2}
