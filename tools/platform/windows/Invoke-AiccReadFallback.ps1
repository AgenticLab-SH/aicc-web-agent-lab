#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('List','Read','Search','Info')][string]$Action='List',
 [ValidateSet('aicc','codex-home','projects')][string]$Alias='aicc',
 [string]$Path='context/PROJECT.md',[string]$Query='',
 [ValidateRange(1,1000000)][int]$StartLine=1,[ValidateRange(1,200)][int]$MaxLines=80)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Text.UTF8Encoding]::new($false)
$manifestPath=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center\control-plane\aicc-read-fallback\v3b\manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
foreach($pin in $manifest.pins){
 $file=Get-Item -LiteralPath ([IO.Path]::GetFullPath($pin.path))
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'Pinned fallback runtime changed; preserve without connecting'}
}
$payload=@{action=$Action;alias=$Alias;path=$Path;query=$Query;start=$StartLine;lines=$MaxLines}|ConvertTo-Json -Compress
& $manifest.node $manifest.client $manifestPath $payload
if($LASTEXITCODE -ne 0){throw 'AICC previous read fallback was not accepted; original request preserved'}
