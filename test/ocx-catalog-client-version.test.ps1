#requires -Version 7.5
$ErrorActionPreference='Stop'
$source=Join-Path (Split-Path $PSScriptRoot -Parent) 'tools/platform/opencodex/New-AiccOcxCatalogClientRelease.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Production parser errors'}
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'VerifiedClientVersion'},$true)
if($fn.Count -ne 1){throw 'Exact production version parser required'}
. ([scriptblock]::Create($fn[0].Extent.Text))
if((VerifiedClientVersion 'codex-cli 0.169.0' '0.162.0-alpha.2') -cne '0.169.0'){throw 'Version extraction failed'}
$checks=1
foreach($row in @(@('codex-cli 0.161.0','0.162.0-alpha.2'),@('codex-cli fake','0.162.0'),@('codex-cli 0.169.0','fake'))){
 $refused=$false
 try{$null=VerifiedClientVersion $row[0] $row[1]}catch{$refused=$true}
 if(!$refused){throw 'Invalid/downgrade version accepted'}
 $checks++
}
@{state='PASS';checks=$checks;scope='Production parser; no service changes'}|ConvertTo-Json