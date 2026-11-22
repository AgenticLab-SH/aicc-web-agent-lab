#requires -Version 7.5
param([ValidateSet('restore','foreign')][string]$Scenario='restore')
$ErrorActionPreference='Stop'
$controlRoot=Join-Path ([IO.Path]::GetTempPath()) ('aicc-rollback-'+[guid]::NewGuid().ToString('N'))
$SnapshotPath=Join-Path $controlRoot 'backups/runtime-layout/ocx-clean-20261102-010101-aabbccdd'
[IO.Directory]::CreateDirectory($SnapshotPath)|Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
$scriptPath=Join-Path (Split-Path $PSScriptRoot -Parent) 'tools/platform/opencodex/Invoke-AiccOcxTransition.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Transition parse failure'}
foreach($name in @('Hash','ReadJson','Regular','Snapshot','Atomic')){
  $node=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
  . ([scriptblock]::Create($node.Extent.Text))
}
$registryFile=Join-Path $controlRoot 'current.json';$wrapperFile=Join-Path $controlRoot 'wrapper.cmd';$stateFile=Join-Path $controlRoot 'state.json';$homeStateFile=Join-Path $controlRoot 'home-state.json';$nativeFile=Join-Path $controlRoot 'native.toml'
$oldCli=Join-Path $controlRoot 'old.ts';[IO.File]::WriteAllText($oldCli,'old supplier adapter')
$packageRoot=Join-Path $controlRoot 'package';[IO.Directory]::CreateDirectory($packageRoot)|Out-Null
[IO.File]::WriteAllText((Join-Path $packageRoot 'package.json'),'{"version":"2.81.0"}')
[IO.File]::WriteAllText($nativeFile,'preserve native')
$previous=@{cliPath=$oldCli;packageRoot=$packageRoot;version='2.81.0'}
$files=@();$after=@{};$i=0
foreach($path in @($registryFile,$wrapperFile,$stateFile,$homeStateFile)){
  $before=if($i -eq 0){$previous|ConvertTo-Json -Compress}else{'before-'+$i}
  [IO.File]::WriteAllText($path,$before)
  Copy-Item -LiteralPath $path -Destination (Join-Path $SnapshotPath ($i.ToString()+'.preimage'))
  $files+=@{path=$path;backupFile=($i.ToString()+'.preimage');sha256=(Hash $path)}
  [IO.File]::WriteAllText($path,('candidate-2.96-'+$i));$after[$path]=Hash $path;$i++
}
Atomic (Join-Path $SnapshotPath 'snapshot.json') @{schema='aicc-ocx-software-snapshot/v1';files=$files;previous=$previous;previousCliSha256=(Hash $oldCli);previousPackageSha256=(Hash (Join-Path $packageRoot 'package.json'));nativeSha256=(Hash $nativeFile)}
Atomic (Join-Path $SnapshotPath 'activation.json') @{afterHashes=$after}
$script:stops=0;$script:starts=0
function StopOwned([string]$Cli){$script:stops++}
function StartOwned([string]$Version){$script:starts++;return @{version=$Version}}
$RecoveryMetadataSha256=$null;$RecoveryOperationId='fixture-versioned-rollback';$Mode='Rollback';$current=@{cliPath='candidate-2.96.ts'};$record=Snapshot
if($Scenario -eq 'foreign'){[IO.File]::WriteAllText($wrapperFile,'foreign newer writer');$foreignHash=Hash $wrapperFile}
$source=[IO.File]::ReadAllText($scriptPath)
$begin=$source.IndexOf('if($Mode -eq ''Rollback''){');$end=$source.IndexOf('if($ManualRecovery){',$begin)
$block=$source.Substring($begin,$end-$begin).Replace(';exit',';return')
$caught=$null;try{$ignored=& ([scriptblock]::Create($block))}catch{$caught=$_.Exception.Message}
if($Scenario -eq 'foreign'){
  if($caught -notmatch 'Newer foreign software edit preserved' -or $script:stops -ne 0 -or $script:starts -ne 0 -or (Hash $wrapperFile) -cne $foreignHash){throw 'CAS must preserve foreign edit before any service action'}
}else{
  if($caught){throw $caught}
  foreach($file in $files){if((Hash $file.path) -cne $file.sha256){throw 'Exact preimage not restored'}}
  if($script:stops -ne 1 -or $script:starts -ne 1 -or (ReadJson (Join-Path $SnapshotPath 'rollback-result.json')).version -cne '2.81.0'){throw 'Rollback version/action count differs'}
}
@{status='PASS';scope='actual-transition-rollback-branch-fake-service-fixture';scenario=$Scenario;serviceCalls='mock-only';liveServicesChanged=$false}|ConvertTo-Json -Compress