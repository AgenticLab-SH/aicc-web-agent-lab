#requires -Version 7.5
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'tools/platform/opencodex/Assert-AiccOcxShippingAcceptance.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('aicc-shipping-acceptance-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
function ShippingTestHash($p){(Get-FileHash -LiteralPath $p).Hash.ToLowerInvariant()}
function J($p,$v){[IO.File]::WriteAllText($p,($v|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))}
$native=@{'codex.exe'=('1'*64);'codex-app-server.exe'=('2'*64);'original-issuer-bootstrap.node'=('3'*64);'original-issuer-shared-launcher.exe'=('4'*64)}
$adapters=@{'external-runtime.ts'=('5'*64)}
$receipt=@{schema='aicc-ocx-shipping-operating-acceptance/v1';state='PASS';fixtureOnly=$false;originalReplay=0;resetCreditConsumption=0;nativeArtifacts=$native;adapterArtifacts=$adapters;checks=@{}}
$names=@('shippingTuiAttachment','originalIssuerArmCancel','credentialGenerationRefusal','stopUnknownPreservation')
foreach($name in $names){
  $r=@{schema='aicc-ocx-shipping-check/v1';check=$name;state='PASS';execution='ACTUAL_SHIPPING_BINARY';fixtureOnly=$false;originalReplay=0;resetCreditConsumption=0;nativeArtifacts=$native;adapterArtifacts=$adapters;
    armed=$true;cancelled=$true;exactOriginalIssuer=$true;goalPreserved=$true;authenticatedPeer=$true;sharedChildSurvived=$true;replacementRefused=$true;stopPreserved=$true;unknownPreserved=$true}
  $file=Join-Path $root ($name+'.json');J $file $r
  $receipt.checks[$name]=@{file=($name+'.json');sha256=(ShippingTestHash $file)}
}
$path=Join-Path $root 'shipping-operating-acceptance.json';J $path $receipt
$checks=0
function Run{Assert-AiccOcxShippingAcceptance -Path $path -Sha256 (ShippingTestHash $path) -NativePins $native -AdapterPins $adapters}
function Refuses([scriptblock]$action,$pattern){$err=$null;try{$null=& $action}catch{$err=$_.Exception.Message};if(!$err -or $err -notmatch $pattern){throw ('Expected refusal: '+$err)}}
$valid=Run;if($valid.files.Count -ne 5){throw 'Evidence closure missing'};$checks++
# Exercise both actual consumer helpers with a synthetic four-artifact build.
$nativeFiles=@{};$buildArtifacts=@()
foreach($name in @($native.Keys)){
  $file=Join-Path $root $name;[IO.File]::WriteAllText($file,'synthetic-'+$name)
  $native[$name]=ShippingTestHash $file;$nativeFiles[$name]=@{path=$file;sha256=$native[$name]}
  if($name -in @('codex.exe','codex-app-server.exe')){
    $buildArtifacts+=@{path=$file;sha256=$native[$name];bytes=(Get-Item -LiteralPath $file).Length;version=$(if($name -ceq 'codex.exe'){'codex-cli 0.166.0'}else{'codex-app-server 0.166.0'})}
  }
}
foreach($name in $names){$file=Join-Path $root ($name+'.json');$r=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json -AsHashtable;$r.nativeArtifacts=$native;J $file $r;$receipt.checks[$name].sha256=ShippingTestHash $file}
J $path $receipt
$buildFile=Join-Path $root 'build.json';J $buildFile @{exitCode=0;installed=$false;artifacts=$buildArtifacts}
$bun=Join-Path $root 'bun.exe';[IO.File]::WriteAllText($bun,'synthetic-bun')
$shipping=@{protocol='retained-child-bootstrap/v1';artifactContract='shipping-cli-appserver/v2';originalTuiAttachment='ACTUAL_SHIPPING_ACCEPTED';files=$nativeFiles;bunSha256=(ShippingTestHash $bun);shippingBuild=@{path=$buildFile;sha256=(ShippingTestHash $buildFile)};operatingAcceptance=@{path=$path;sha256=(ShippingTestHash $path)}}
foreach($entry in @(@{file='New-AiccAcceptedOcxRelease.ps1';functions=@('Hash','Regular','ReviewedSharedLauncher')},@{file='Invoke-AiccOcxTransition.ps1';functions=@('SharedLaunchCommand')})){
  $errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo ('tools/platform/opencodex/'+$entry.file)),[ref]$null,[ref]$errors)
  if($errors){throw $errors}
  foreach($name in $entry.functions){$defs=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true));if($defs.Count -ne 1){throw 'Unique helper required'};. ([scriptblock]::Create($defs[0].Extent.Text))}
}
$reviewed=ReviewedSharedLauncher @{sharedLauncherClosure=$shipping;sourceSha256=$adapters}
if(!$reviewed.policy.canActivate -or $reviewed.operatingEvidence.files.Count -ne 5){throw 'Exact synthetic v2 evidence not consumed'};$checks++
$evidenceDir=Join-Path $root 'shipping-evidence';New-Item -ItemType Directory -Path $evidenceDir|Out-Null
foreach($name in $reviewed.operatingEvidence.files.Keys){Copy-Item -LiteralPath $reviewed.operatingEvidence.files[$name] -Destination (Join-Path $evidenceDir $name)}
$release=[pscustomobject]@{sharedLauncher=[pscustomobject]$reviewed.policy;nativeAdapterFiles=[pscustomobject]$native;adapterFiles=[pscustomobject]$adapters;codexClientVersion='0.166.0'}
$command=SharedLaunchCommand $release $root $bun (Join-Path $root 'external-runtime.ts') (Join-Path $root 'release-manifest.json')
if($command -cne ('"'+(Join-Path $root 'original-issuer-shared-launcher.exe')+'" --run')){throw 'Exact launcher command mismatch'};$checks++
$evidenceFile=Join-Path $evidenceDir 'originalIssuerArmCancel.json';[IO.File]::AppendAllText($evidenceFile,' ')
Refuses {SharedLaunchCommand $release $root $bun '' ''} 'evidence changed';$checks++
$receipt.fixtureOnly=$true;J $path $receipt;Refuses {Run} 'actual shipping';$checks++
$receipt.fixtureOnly=$false;$receipt.nativeArtifacts=$native.Clone();$receipt.nativeArtifacts['codex.exe']='f'*64;J $path $receipt;Refuses {Run} 'actual shipping';$checks++
$receipt.nativeArtifacts=$native;J $path $receipt
$file=Join-Path $root 'originalIssuerArmCancel.json';$r=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json -AsHashtable
$r.armed=$false;J $file $r;$receipt.checks.originalIssuerArmCancel.sha256=ShippingTestHash $file;J $path $receipt;Refuses {Run} 'Positive original';$checks++
$r.armed=$true;$r.execution='PARSER_ONLY';J $file $r;$receipt.checks.originalIssuerArmCancel.sha256=ShippingTestHash $file;J $path $receipt;Refuses {Run} 'Actual version-bound';$checks++
$r.execution='ACTUAL_SHIPPING_BINARY';J $file $r;$receipt.checks.originalIssuerArmCancel.sha256=ShippingTestHash $file;J $path $receipt
[IO.File]::AppendAllText($file,' ');Refuses {Run} 'evidence changed';$checks++
$receipt.checks.originalIssuerArmCancel.sha256=ShippingTestHash $file;J $path $receipt
foreach($bad in @('False',0)){
 $receipt.fixtureOnly=$bad;J $path $receipt;Refuses {Run} 'actual shipping';$checks++
}
$receipt.fixtureOnly=$false
foreach($bad in @('0',$false)){
 $receipt.originalReplay=$bad;J $path $receipt;Refuses {Run} 'actual shipping';$checks++
}
$receipt.originalReplay=0;J $path $receipt
foreach($bad in @('True',1)){
 $r.armed=$bad;J $file $r;$receipt.checks.originalIssuerArmCancel.sha256=ShippingTestHash $file;J $path $receipt
 Refuses {Run} 'Positive original';$checks++
}
$r.armed=$true;J $file $r;$receipt.checks.originalIssuerArmCancel.sha256=ShippingTestHash $file;J $path $receipt
$r.resetCreditConsumption='0';J $file $r;$receipt.checks.originalIssuerArmCancel.sha256=ShippingTestHash $file;J $path $receipt
Refuses {Run} 'Actual version-bound';$checks++
$r.resetCreditConsumption=0;J $file $r;$receipt.checks.originalIssuerArmCancel.sha256=ShippingTestHash $file;J $path $receipt
$receipt.checks.Remove('credentialGenerationRefusal');J $path $receipt;Refuses {Run} 'Complete shipping';$checks++
@{state='PASS';checks=$checks;scope='Synthetic receipt validator only; no operating acceptance or model calls';fixture=$root}|ConvertTo-Json -Compress
