#requires -Version 7.5
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$planner=Join-Path $repo 'tools/platform/opencodex/New-AiccOcxCompatibilityPlan.ps1'
$builder=Join-Path $repo 'tools/platform/opencodex/New-AiccAcceptedOcxRelease.ps1'
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($builder,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Builder parse failed'}
$function=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'ReviewedGraph'},$true))
if($function.Count -ne 1){throw 'Exact production graph helper required'}
. ([scriptblock]::Create($function[0].Extent.Text))
function Regular([string]$Path){if(!(Test-Path -LiteralPath $Path -PathType Leaf)){throw 'Fixture member missing'}}
$adapterRoot=Join-Path ([IO.Path]::GetTempPath()) ('aicc-multiline-closure-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $adapterRoot|Out-Null
$runtime=Join-Path $adapterRoot 'external-runtime.ts'
$member=Join-Path $adapterRoot 'external-original-issuer-admission.ts'
[IO.File]::WriteAllText($member,'export const grant = true;')
$fixtures=@(
 "import { grant,`n  type Authority } from './external-original-issuer-admission';",
 "export { grant,`r`n  type Authority } from './external-original-issuer-admission';",
 "import './external-original-issuer-admission';",
 "import { grant }`n from './external-original-issuer-admission';"
)
$plannerBody=[IO.File]::ReadAllText($planner)
$scannerLine=@($plannerBody -split "`n" | Where-Object {$_ -match '\$matches = \[regex\]::Matches\(\$body,'})
if($scannerLine.Count -ne 1){throw 'Exact production planner scanner required'}
$checks=0
foreach($body in $fixtures){
 [IO.File]::WriteAllText($runtime,$body)
 $graph=ReviewedGraph @('external-runtime.ts','external-original-issuer-admission.ts')
 if($graph['external-runtime.ts'].Count -ne 1 -or $graph['external-runtime.ts'][0] -cne 'external-original-issuer-admission.ts'){throw 'Builder lost a static import'}
 . ([scriptblock]::Create($scannerLine[0]))
 if(@($matches).Count -ne 1 -or $matches[0].Groups['spec'].Value -cne './external-original-issuer-admission'){throw 'Planner lost a static import'}
 $checks++
}
[IO.File]::WriteAllText($runtime,$fixtures[0])
$refused=$false
try{$null=ReviewedGraph @('external-runtime.ts')}catch{$refused=$_.Exception.Message -match 'Unpinned relative adapter dependency'}
if(!$refused){throw 'Builder accepted an unpinned multiline import'};$checks++
$actual=Join-Path $repo 'tools/platform/opencodex/external-pool-state.ts'
$body=[IO.File]::ReadAllText($actual)
. ([scriptblock]::Create($scannerLine[0]))
if(!(@($matches|ForEach-Object {$_.Groups['spec'].Value}) -ccontains './external-original-issuer-admission')){throw 'Actual pool dependency still missing'};$checks++
@{status='PASS';checks=$checks;scope='Production planner scanner and builder graph; no release, model or operating changes';fixture=$adapterRoot}|ConvertTo-Json
