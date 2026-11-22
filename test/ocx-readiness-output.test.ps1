#requires -Version 7.5
$ErrorActionPreference='Stop'
$source=Join-Path (Split-Path $PSScriptRoot -Parent) 'tools/platform/opencodex/Invoke-AiccOcxTransition.ps1'
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$t,[ref]$e)
$fn=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Ready'},$true))
if($fn.Count -ne 1){throw 'Exact readiness helper required'}
. ([scriptblock]::Create($fn[0].Extent.Text))
function Invoke-RestMethod {throw 'fixture unreachable'}
$old=[Console]::Error;$capture=[IO.StringWriter]::new()
try{
 [Console]::SetError($capture)
 $output=@(Ready *>&1)
 if(@($output|Where-Object {$null -ne $_}).Count){throw 'Readiness diagnostics polluted structured output'}
 if($capture.ToString() -notmatch 'fixture unreachable'){throw 'Readiness error not observable'}
}finally{[Console]::SetError($old);$capture.Dispose()}
function Invoke-RestMethod {[pscustomobject]@{ready=$true;localActive=0}}
$ready=Ready
if(!$ready.ready -or $ready.localActive -ne 0){throw 'Successful readiness changed'}
@{state='PASS';checks=3;scope='Actual helper output/error separation; no services'}|ConvertTo-Json -Compress
