#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PrivateAdapterRoot,[switch]$Commit)
$ErrorActionPreference='Stop'
if(-not [IO.Path]::IsPathFullyQualified($PrivateAdapterRoot)){throw 'Absolute private adapter root required'}
$source=Join-Path (Resolve-Path -LiteralPath $PrivateAdapterRoot).Path 'scripts/account-surface-status.mjs'
if(-not (Test-Path -LiteralPath $source -PathType Leaf) -or (Get-Item -LiteralPath $source).LinkType){throw 'Regular identity reporter required'}
$directory=Split-Path (Get-Command aicc-apps.ps1 -CommandType ExternalScript -ErrorAction Stop).Source -Parent
$target=Join-Path $directory 'aicc-account-identities.ps1'
$runtime=(Get-Command bun.exe -ErrorAction Stop).Source
$quote={param($value) "'"+$value.Replace("'","''")+"'"}
$content="# AICC current account identities; no chat submission.`n& $(& $quote $runtime) run $(& $quote $source) @args`nexit `$LASTEXITCODE`n"
if(Test-Path -LiteralPath $target){if((Get-Item -LiteralPath $target).LinkType -or [IO.File]::ReadAllText($target) -ne $content){throw 'Existing CLI differs; refusing overwrite'}}
$changed=$false
if($Commit -and -not (Test-Path -LiteralPath $target)){
  $file=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes($content);$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
  $changed=$true
}
@{terminal=if($Commit){'PASS'}else{'DRY_RUN'};target=$target;changed=$changed;remoteMutation=$false}|ConvertTo-Json -Compress
