#requires -Version 7.0
# Fixed owner-home entry. Runtime dependencies remain shared; no browser or service is started here.
[CmdletBinding(PositionalBinding=$false)]
param(
[ValidateSet('cli','home-control')][string]$Component='cli',
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
)
$ErrorActionPreference='Stop'
$ownerRoot=[Environment]::GetFolderPath('UserProfile')
$aiccHome=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path $ownerRoot '.ai-control-center'}
$registryFile=Join-Path $aiccHome 'runtime\components.json'
if((Get-Item -LiteralPath $registryFile).LinkType){throw 'Linked runtime registry refused'}
$registry=Get-Content -LiteralPath $registryFile -Raw|ConvertFrom-Json -AsHashtable
if($registry.schemaVersion -ne 1 -or $registry.root -ne $aiccHome){throw 'Unknown runtime registry'}
if($Component -eq 'cli' -and $Arguments.Count -gt 0 -and $Arguments[0] -eq 'home'){
  $Component='home-control';$Arguments=@($Arguments|Select-Object -Skip 1)
}
$componentEntry=$registry.components[$Component]
if(-not $componentEntry){throw 'Component is not registered; run the owner installer'}
$entry=[IO.Path]::GetFullPath($componentEntry.entry)
$runtime=[IO.Path]::GetFullPath($componentEntry.runtime)
$managed=Join-Path $aiccHome 'releases'
$legacy=Join-Path $ownerRoot '.codex\releases\open-aicc'
$managedEntry=$entry.StartsWith($managed+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
$legacyEntry=$componentEntry.location -eq 'legacy-frozen' -and $entry.StartsWith($legacy+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
if(-not($managedEntry -or $legacyEntry) -or -not(Test-Path -LiteralPath $entry -PathType Leaf) -or -not(Test-Path -LiteralPath $runtime -PathType Leaf)){throw 'Registered runtime unavailable'}
& $runtime $entry @Arguments
exit $LASTEXITCODE
