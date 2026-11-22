[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
if(![IO.Path]::IsPathFullyQualified($OutputDirectory)){throw 'Absolute output required'}
$out=Get-Item -LiteralPath $OutputDirectory -Force
if(!$out.PSIsContainer -or ($out.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Existing private non-link output directory required'}
$guidance=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$source=Join-Path $guidance 'plugins/web-gpt-management/plugin.json'
$stage=Join-Path $out.FullName ('package-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stage)|Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $stage 'plugin.json')
$names=@('manage-chatgpt-skills','manage-chatgpt-assets','manage-chatgpt-personal-skills','manage-chatgpt-workspace-skills','design-chatgpt-projects','aicc-workspace-operator','manage-chatgpt-conversation-titles')
foreach($name in $names){
 $root=Join-Path $guidance ('skills/'+$name)
 foreach($file in Get-ChildItem -LiteralPath $root -File -Recurse){
  if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked package file refused'}
  if($file.Extension -notin @('.md','.ps1','.cjs','.mjs','.py','.yaml','.json')){continue}
  $rel=[IO.Path]::GetRelativePath($root,$file.FullName)
  $target=Join-Path $stage ('skills/'+$name+'/'+$rel)
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination $target
 }
}
$zip=Join-Path $out.FullName ('web-gpt-management-'+[guid]::NewGuid().ToString('N')+'.zip')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream=[IO.File]::Open($zip,[IO.FileMode]::CreateNew)
$archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try{
 foreach($file in Get-ChildItem -LiteralPath $stage -File -Recurse|Sort-Object FullName){
  $relative=[IO.Path]::GetRelativePath($stage,$file.FullName).Replace('\','/')
  $entry=$archive.CreateEntry($relative,[IO.Compression.CompressionLevel]::Optimal)
  $entry.LastWriteTime=[DateTimeOffset]::new(2000,1,1,0,0,0,[TimeSpan]::Zero)
  $target=$entry.Open();$source=[IO.File]::OpenRead($file.FullName)
  try{$source.CopyTo($target)}finally{$source.Dispose();$target.Dispose()}
 }
}finally{$archive.Dispose();$stream.Dispose()}
@{archive=$zip;stage=$stage;skills=$names;sha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Depth 5
