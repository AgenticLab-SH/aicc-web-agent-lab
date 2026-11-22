#requires -Version 7.0
[CmdletBinding()]
param([switch]$Commit)
$ErrorActionPreference='Stop'
$directory=Split-Path (Get-Command aicc-apps.ps1 -CommandType ExternalScript -ErrorAction Stop).Source -Parent
$source=Join-Path $PSScriptRoot 'Invoke-AiccWebTask.ps1'
$target=Join-Path $directory 'aicc-web-task.ps1'
if((Get-Item -LiteralPath $directory).LinkType){throw 'Linked CLI directory refused.'}
$quoted=$source.Replace("'","''")
$content="# AICC explicit Web task creation and resume; Native settings are preserved.`n& '$quoted' @args`nexit `$LASTEXITCODE`n"
$exists=Test-Path -LiteralPath $target
if($exists -and ((Get-Item -LiteralPath $target).LinkType -or [IO.File]::ReadAllText($target) -cne $content)){throw 'Existing CLI differs; no overwrite.'}
if($Commit -and -not $exists){
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($content)
    $file=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
}
[pscustomobject]@{target=$target;source=$source;changed=($Commit -and -not $exists);dryRun=(-not $Commit)}|ConvertTo-Json -Compress
