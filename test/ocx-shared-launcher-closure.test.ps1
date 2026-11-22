#requires -Version 7.5
$ErrorActionPreference='Stop'
$builder=Join-Path (Split-Path $PSScriptRoot -Parent) 'tools/platform/opencodex/New-AiccAcceptedOcxRelease.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($builder,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Builder syntax invalid'}
# Read the exact pure preflight functions; never execute the live release body.
foreach($name in @('Hash','Regular','ReviewedSharedLauncher')){
 $functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($functions.Count -ne 1){throw 'Unique reviewed helper required'}
 . ([scriptblock]::Create($functions[0].Extent.Text))
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-shared-closure-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
$files=[ordered]@{}
foreach($name in @('original-issuer-bootstrap.node','original-issuer-shared-launcher.exe')){
 $path=Join-Path $root $name;[IO.File]::WriteAllText($path,$name)
 $files[$name]=@{path=$path;sha256=(Hash $path)}
}
$closure=@{protocol='retained-child-bootstrap/v1';originalTuiAttachment='NOT_IMPLEMENTED';files=$files;bunSha256=('1'*64)}
$checks=0
if($null -ne (ReviewedSharedLauncher @{})){throw 'Legacy closure changed'};$checks++
$valid=ReviewedSharedLauncher @{sharedLauncherClosure=$closure}
if($valid.policy.canActivate -cne $false -or $valid.pins.Count -ne 2){throw 'Incomplete caller became activatable'};$checks++
$closure.originalTuiAttachment='PASS'
try{$null=ReviewedSharedLauncher @{sharedLauncherClosure=$closure};throw 'Expected forged caller refusal'}catch{if($_.Exception.Message -notmatch 'Exact shared launcher closure'){throw}};$checks++
$closure.originalTuiAttachment='NOT_IMPLEMENTED'
$shippingFiles=[ordered]@{}
foreach($key in $files.Keys){$shippingFiles[$key]=$files[$key]}
$artifacts=@()
foreach($name in @('codex.exe','codex-app-server.exe')){
 $p=Join-Path $root $name;[IO.File]::WriteAllText($p,'fixture-'+$name)
 $shippingFiles[$name]=@{path=$p;sha256=(Hash $p)}
 $artifacts+=@{path=$p;sha256=(Hash $p);bytes=(Get-Item -LiteralPath $p).Length;
  version=$(if($name -ceq 'codex.exe'){'codex-cli 0.166.0'}else{'codex-app-server 0.166.0'})}
}
$receipt=Join-Path $root 'shipping-build.json'
$build=@{exitCode=0;installed=$false;artifacts=$artifacts}
[IO.File]::WriteAllText($receipt,($build|ConvertTo-Json -Depth 8))
$shipping=@{protocol='retained-child-bootstrap/v1';artifactContract='shipping-cli-appserver/v1';originalTuiAttachment='SHIPPING_BUILD_CANDIDATE_ONLY';
 files=$shippingFiles;bunSha256=('1'*64);shippingBuild=@{path=$receipt;sha256=(Hash $receipt)}}
$reviewed=ReviewedSharedLauncher @{sharedLauncherClosure=$shipping}
if($reviewed.pins.Count -ne 4 -or $reviewed.policy.canActivate -cne $false -or
 $reviewed.policy.codexClientVersion -cne '0.166.0'){throw 'Shipping provenance or activation boundary lost'};$checks++
$artifacts[0].version='codex-cli 0.999.0'
[IO.File]::WriteAllText($receipt,($build|ConvertTo-Json -Depth 8));$shipping.shippingBuild.sha256=Hash $receipt
try{$null=ReviewedSharedLauncher @{sharedLauncherClosure=$shipping};throw 'Wrong build version accepted'}catch{if($_.Exception.Message -notmatch 'version-bound'){throw}};$checks++
$artifacts[0].version='codex-cli 0.166.0'
[IO.File]::WriteAllText($receipt,($build|ConvertTo-Json -Depth 8));$shipping.shippingBuild.sha256=Hash $receipt
[IO.File]::AppendAllText($receipt,' ')
try{$null=ReviewedSharedLauncher @{sharedLauncherClosure=$shipping};throw 'Altered build receipt accepted'}catch{if($_.Exception.Message -notmatch 'receipt changed'){throw}};$checks++
[IO.File]::WriteAllText($receipt,($build|ConvertTo-Json -Depth 8));$shipping.shippingBuild.sha256=Hash $receipt
$shipping.originalTuiAttachment='PASS'
try{$null=ReviewedSharedLauncher @{sharedLauncherClosure=$shipping};throw 'Forged shipping acceptance allowed'}catch{if($_.Exception.Message -notmatch 'Exact shared launcher closure'){throw}};$checks++
$shipping.originalTuiAttachment='SHIPPING_BUILD_CANDIDATE_ONLY'
$cli=$shippingFiles['codex.exe'].path;[IO.File]::AppendAllText($cli,'changed')
try{$null=ReviewedSharedLauncher @{sharedLauncherClosure=$shipping};throw 'Altered CLI accepted'}catch{if($_.Exception.Message -notmatch 'artifact changed'){throw}};$checks++
$addon=$files['original-issuer-bootstrap.node'].path
[IO.File]::WriteAllText($addon,'tampered')
try{$null=ReviewedSharedLauncher @{sharedLauncherClosure=$closure};throw 'Expected altered artifact refusal'}catch{if($_.Exception.Message -notmatch 'artifact changed'){throw}};$checks++
[IO.File]::WriteAllText($addon,'original-issuer-bootstrap.node')
$files['extra.dll']=@{path=$addon;sha256=(Hash $addon)}
try{$null=ReviewedSharedLauncher @{sharedLauncherClosure=$closure};throw 'Expected extra member refusal'}catch{if($_.Exception.Message -notmatch 'Exact shared launcher closure'){throw}};$checks++
@{state='PASS';checks=$checks;scope='Actual builder pure preflight; no live registry/service/release';installed=$false;fixture=$root}|ConvertTo-Json -Compress
