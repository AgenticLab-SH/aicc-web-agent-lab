#requires -Version 5.1
[CmdletBinding()]param([Parameter(Mandatory=$true)][string]$WorkspaceRoot,[Parameter(Mandatory=$true)][string]$Stage,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root=(Resolve-Path -LiteralPath $WorkspaceRoot).Path.TrimEnd('\')
function Get-BoundedPath([string]$Value){
 $p=if([IO.Path]::IsPathRooted($Value)){[IO.Path]::GetFullPath($Value)}else{[IO.Path]::GetFullPath((Join-Path $root $Value))}
 if(!$p.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'HOLD_ARCHIVE_OUTSIDE_WORKSPACE'}
 for($c=$p;$c -ne $root;$c=[IO.Path]::GetDirectoryName($c)){if(Test-Path -LiteralPath $c){if((Get-Item -LiteralPath $c -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'HOLD_LINKED_ARCHIVE_PATH'}}}
 return $p
}
$stagePath=Get-BoundedPath $Stage;$zip=Get-BoundedPath $Destination
if(!(Test-Path -LiteralPath $stagePath -PathType Container) -or (Test-Path -LiteralPath $zip)){throw 'Existing stage and new exact ZIP required'}
$files=@(Get-ChildItem -LiteralPath $stagePath -Recurse -File|Sort-Object FullName)
if(!$files.Count -or $files.Count -gt 1000){throw 'Bounded nonempty package required'}
foreach($file in $files){$null=Get-BoundedPath $file.FullName}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream=[IO.File]::Open($zip,[IO.FileMode]::CreateNew)
$archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try{
 foreach($file in $files){
  $relative=$file.FullName.Substring($stagePath.TrimEnd('\').Length+1).Replace('\','/')
  if($relative -match '(^|/)\.\.?(/|$)|:|[\x00-\x1f]'){throw 'Unsafe archive member'}
  $entry=$archive.CreateEntry($relative,[IO.Compression.CompressionLevel]::Optimal)
  $entry.LastWriteTime=[DateTimeOffset]::new(2000,1,1,0,0,0,[TimeSpan]::Zero)
  $target=$entry.Open();$inputStream=[IO.File]::OpenRead($file.FullName)
  try{$inputStream.CopyTo($target)}finally{$inputStream.Dispose();$target.Dispose()}
 }
}finally{$archive.Dispose();$stream.Dispose()}
[ordered]@{status='PACKAGE_WRITTEN';archive=$zip;sha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant();files=$files.Count;remoteWritePerformed=$false}|ConvertTo-Json -Compress
