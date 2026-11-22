#requires -Version 7.5
$ErrorActionPreference='Stop'
$source=Join-Path (Split-Path $PSScriptRoot -Parent) 'tools/platform/opencodex/Invoke-AiccOcxTransition.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Transition syntax invalid'}
foreach($name in @('Hash','Regular','SharedLaunchCommand')){
 $functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($functions.Count -ne 1){throw 'Unique transition helper required'}
 . ([scriptblock]::Create($functions[0].Extent.Text))
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-shared-transition-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
$pins=[ordered]@{}
foreach($name in @('bun.exe','original-issuer-bootstrap.node','original-issuer-shared-launcher.exe')){
 $p=Join-Path $root $name;[IO.File]::WriteAllText($p,$name);$pins[$name]=(Hash $p)
}
$bun=Join-Path $root 'bun.exe';$cli=Join-Path $root 'external-runtime.ts';$manifest=Join-Path $root 'release-manifest.json'
$checks=0
if((SharedLaunchCommand ([pscustomobject]@{}) $root $bun $cli $manifest) -cne ('"'+$bun+'" "'+$cli+'" "'+$manifest+'"')){throw 'Legacy launch changed'};$checks++
$release=[pscustomobject]@{sharedLauncher=[pscustomobject]@{protocol='retained-child-bootstrap/v1';originalTuiAttachment='NOT_IMPLEMENTED';canActivate=$false;bunSha256=$pins['bun.exe']};nativeAdapterFiles=[pscustomobject]@{'original-issuer-bootstrap.node'=$pins['original-issuer-bootstrap.node'];'original-issuer-shared-launcher.exe'=$pins['original-issuer-shared-launcher.exe']}}
try{$null=SharedLaunchCommand $release $root $bun $cli $manifest;throw 'Missing caller accepted'}catch{if($_.Exception.Message -notmatch 'caller not implemented'){throw}};$checks++
$release.sharedLauncher.originalTuiAttachment='PASS'
try{$null=SharedLaunchCommand $release $root $bun $cli $manifest;throw 'Forged caller accepted'}catch{if($_.Exception.Message -notmatch 'Unsupported shared launcher'){throw}};$checks++
$release.sharedLauncher.originalTuiAttachment='NOT_IMPLEMENTED'
$shippingPins=@{}
foreach($name in @('original-issuer-shared-launcher.exe','original-issuer-bootstrap.node','codex.exe','codex-app-server.exe')){
 $p=Join-Path $root $name
 if(-not(Test-Path -LiteralPath $p)){[IO.File]::WriteAllText($p,$name)}
 $shippingPins[$name]=Hash $p
}
$shipping=[pscustomobject]@{codexClientVersion='0.166.0';nativeAdapterFiles=[pscustomobject]$shippingPins;
 sharedLauncher=[pscustomobject]@{protocol='retained-child-bootstrap/v1';artifactContract='shipping-cli-appserver/v1';originalTuiAttachment='SHIPPING_BUILD_CANDIDATE_ONLY';
 canActivate=$false;bunSha256=$pins['bun.exe'];shippingBuildSha256=('2'*64);codexClientVersion='0.166.0'}}
try{$null=SharedLaunchCommand $shipping $root $bun $cli $manifest;throw 'Unaccepted shipping caller activated'}catch{if($_.Exception.Message -notmatch 'operating acceptance pending'){throw}};$checks++
$shipping.sharedLauncher.canActivate=$true
try{$null=SharedLaunchCommand $shipping $root $bun $cli $manifest;throw 'Forged activation accepted'}catch{if($_.Exception.Message -notmatch 'Unsupported shared launcher'){throw}};$checks++
$shipping.sharedLauncher.canActivate=$false
$shipping.codexClientVersion='0.169.0'
try{$null=SharedLaunchCommand $shipping $root $bun $cli $manifest;throw 'Mismatched shipping version accepted'}catch{if($_.Exception.Message -notmatch 'provenance required'){throw}};$checks++
$shipping.codexClientVersion='0.166.0'
[IO.File]::AppendAllText((Join-Path $root 'codex.exe'),'changed')
try{$null=SharedLaunchCommand $shipping $root $bun $cli $manifest;throw 'Changed shipping binary accepted'}catch{if($_.Exception.Message -notmatch 'member changed'){throw}};$checks++
[IO.File]::WriteAllText((Join-Path $root 'original-issuer-bootstrap.node'),'altered')
try{$null=SharedLaunchCommand $release $root $bun $cli $manifest;throw 'Altered addon accepted'}catch{if($_.Exception.Message -notmatch 'member changed'){throw}};$checks++
@{state='PASS';checks=$checks;scope='Actual transition pure planning; no stop/start/registry';fixture=$root}|ConvertTo-Json -Compress
