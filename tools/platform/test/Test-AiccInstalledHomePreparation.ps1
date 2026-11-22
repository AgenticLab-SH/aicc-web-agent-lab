#requires -Version 7.5
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ReleaseRoot,
 [Parameter(Mandatory)][string]$EvidenceDirectory
)
$ErrorActionPreference='Stop'
$release=(Resolve-Path -LiteralPath $ReleaseRoot).Path
$evidence=[IO.Path]::GetFullPath($EvidenceDirectory)
if(-not [IO.Path]::IsPathFullyQualified($EvidenceDirectory) -or (Test-Path -LiteralPath $evidence)){throw 'Fresh absolute evidence directory required'}
if($evidence.Equals($release,[StringComparison]::OrdinalIgnoreCase) -or $evidence.StartsWith($release+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Evidence must be outside the installed release'}
$manifestFile=Join-Path $release '.aicc-release.json'
$manifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json
function Hash([string]$file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function Assert([bool]$condition,[string]$message){if(-not $condition){throw $message}}
$pins=@(foreach($relative in @('tools/platform/codex/Prepare-CodexSharedHome.ps1','tools/platform/codex/Read-AiccOcxAdmission.ps1')){
 $file=Join-Path $release $relative
 $row=@($manifest.files|Where-Object path -CEQ $relative)
 Assert ($row.Count -eq 1 -and (Hash $file) -ceq $row[0].sha256) ('Installed manifest mismatch: '+$relative)
 @{path=$relative;sha256=(Hash $file)}
})
$preparer=Join-Path $release $pins[0].path
$helper=Join-Path $release $pins[1].path
$pwsh=Join-Path $PSHOME 'pwsh.exe'
New-Item -ItemType Directory -Path $evidence|Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
function Write-EvidenceText([string]$file,[string]$text){[IO.File]::WriteAllText($file,$text,$utf8)}
function Snapshot([string]$dir){
 @(Get-ChildItem -LiteralPath $dir -Recurse -File|Sort-Object FullName|ForEach-Object {($_.FullName.Substring($dir.Length))+' '+(Hash $_.FullName)}) -join "`n"
}
function Invoke-Preparation([string]$name,[hashtable]$values){
 $info=[Diagnostics.ProcessStartInfo]::new($pwsh)
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 foreach($arg in @('-NoLogo','-NoProfile','-NonInteractive','-File',$preparer)){$info.ArgumentList.Add($arg)}
 foreach($key in $values.Keys){$info.ArgumentList.Add('-'+$key);$info.ArgumentList.Add([string]$values[$key])}
 $process=[Diagnostics.Process]::Start($info)
 try{
  $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  Assert ($process.WaitForExit(30000)) 'Installed preparation timed out; preserve original process/evidence and reconcile'
  $result=@{name=$name;exitCode=$process.ExitCode;stdout=$stdout.GetAwaiter().GetResult();stderr=$stderr.GetAwaiter().GetResult()}
 }finally{$process.Dispose()}
 Write-EvidenceText (Join-Path $evidence ($name+'.json')) ($result|ConvertTo-Json -Depth 5)
 return $result
}
$fixture=Join-Path $evidence 'synthetic'
$homeFixture=Join-Path $fixture 'home';$stateFixture=Join-Path $fixture 'state'
foreach($dir in @($homeFixture,$stateFixture)){New-Item -ItemType Directory -Path $dir -Force|Out-Null}
$config=Join-Path $homeFixture 'config.toml'
$configText="# synthetic fixture only`nmodel = `"fixture-model`"`nmodel_reasoning_effort = `"high`"`napproval_policy = `"on-request`"`n[features]`nfixture_feature = true`n"
Write-EvidenceText $config $configText
$ocx=Join-Path $fixture 'ocx.json';$native=Join-Path $fixture 'native.json';$web=Join-Path $fixture 'web.json'
Write-EvidenceText $ocx '{"models":[{"slug":"fixture-ocx"}]}'
Write-EvidenceText $native '{"models":[{"slug":"fixture-native"}]}'
Write-EvidenceText $web '{"models":[{"slug":"chatgpt-web/fixture"}]}'
$operation=Join-Path $fixture 'normal';New-Item -ItemType Directory -Path $operation|Out-Null
$argsMap=@{CodexHome=$homeFixture;ExpectedConfigSha256=(Hash $config);OcxCatalog=$ocx;NativeCatalog=$native;WebCatalog=$web;CredentialHelper=$helper;ExpectedCredentialHelperSha256=(Hash $helper);PowerShellExe=$pwsh;OperationDirectory=$operation;StateRoot=$stateFixture}
$beforeHome=Snapshot $homeFixture;$beforeState=Snapshot $stateFixture
$cases=[Collections.Generic.List[object]]::new()
$normal=Invoke-Preparation 'normal' $argsMap
Assert ($normal.exitCode -eq 0) 'Installed normal preparation failed'
$receipt=Get-Content -LiteralPath (Join-Path $operation 'shared-home-config.preparation.json') -Raw|ConvertFrom-Json
Assert ($receipt.state -ceq 'PREPARED_NOT_APPLIED' -and $receipt.status -ceq $receipt.state -and -not $receipt.activationReady -and $receipt.files.Count -eq 3) 'Preparation state contract mismatch'
Assert ($receipt.liveConfigWrites -eq 0 -and $receipt.runtimeChanges -eq 0 -and $receipt.credentialInvocation -eq 0) 'Preparation must remain unapplied'
foreach($row in $receipt.files){
 Assert ((Hash $row.candidate) -ceq $row.candidateSha256) 'Candidate pin mismatch'
 Assert ($row.target.StartsWith($homeFixture+'\',[StringComparison]::OrdinalIgnoreCase)) 'Target outside synthetic home'
 if(Test-Path -LiteralPath $row.target){Assert ((Hash $row.target) -ceq $row.expectedBeforeSha256) 'Original pin mismatch'}else{Assert ($null -eq $row.expectedBeforeSha256) 'Absent original pin mismatch'}
}
$candidate=[IO.File]::ReadAllText((Join-Path $operation 'config.toml.candidate'))
$quotedHelper=ConvertTo-Json -InputObject $helper -Compress
Assert ($candidate.Contains($configText.TrimEnd()) -and $candidate.Contains($quotedHelper) -and $candidate.Contains('wire_api = "responses"')) 'Inherited plain config/provider boundary mismatch'
Assert ([IO.File]::ReadAllText((Join-Path $operation 'native.config.toml.candidate')).Contains('https://chatgpt.com/backend-api/codex') -and [IO.File]::ReadAllText((Join-Path $operation 'aicc-webgpt.config.toml.candidate')).Contains('http://127.0.0.1:17841/v1')) 'Separate profile boundary mismatch'
Assert ($receipt.credentialHelper -ceq $helper -and $receipt.credentialHelperSha256 -ceq (Hash $helper)) 'Immutable helper binding mismatch'
$cases.Add(@{name='normal-installed-command';state='PASS';files=3})
$normalSnapshot=Snapshot $operation
$replay=Invoke-Preparation 'same-operation' $argsMap
Assert ($replay.exitCode -ne 0 -and $replay.stderr.Contains('Candidate already exists') -and (Snapshot $operation) -ceq $normalSnapshot) 'Original preparation changed on replay'
$cases.Add(@{name='same-operation-preserved';state='PASS'})
foreach($mode in @('stale-config','stale-helper','unsupported-catalog','unsupported-profile','output-in-home')){
 $values=$argsMap.Clone();$dir=Join-Path $fixture $mode;New-Item -ItemType Directory -Path $dir|Out-Null
 $values.OperationDirectory=$dir
 $expected=''
 switch($mode){
  'stale-config' {$values.ExpectedConfigSha256='0'*64;$expected='Base config preimage changed'}
  'stale-helper' {$values.ExpectedCredentialHelperSha256='0'*64;$expected='Credential helper pin changed'}
  'unsupported-catalog' {$values.WebCatalog=$ocx;$expected='catalogs must remain separate'}
  'unsupported-profile' {
   $otherHome=Join-Path $fixture 'profile-home';New-Item -ItemType Directory -Path $otherHome|Out-Null
   Write-EvidenceText (Join-Path $otherHome 'config.toml') ('profile = "fixture"'+"`n"+$configText)
   $values.CodexHome=$otherHome;$values.ExpectedConfigSha256=Hash (Join-Path $otherHome 'config.toml');$expected='Existing default profile selection'
  }
  'output-in-home' {$dir=Join-Path $homeFixture 'output';New-Item -ItemType Directory -Path $dir|Out-Null;$values.OperationDirectory=$dir;$expected='Output must not be the live shared Codex HOME'}
 }
 $before=Snapshot $dir;$homeBefore=Snapshot $values.CodexHome
 $rejected=Invoke-Preparation $mode $values
 Assert ($rejected.exitCode -ne 0 -and $rejected.stderr.Contains($expected) -and (Snapshot $dir) -ceq $before -and (Snapshot $values.CodexHome) -ceq $homeBefore) ('Refusal or original preservation failed: '+$mode)
 $cases.Add(@{name=$mode;state='PASS'})
}
Assert ((Snapshot $homeFixture) -ceq $beforeHome -and (Snapshot $stateFixture) -ceq $beforeState) 'Synthetic original/state changed'
foreach($pin in $pins){Assert ((Hash (Join-Path $release $pin.path)) -ceq $pin.sha256) 'Installed helper/preparer changed'}
$result=[ordered]@{status='PASS';passed=$cases.Count;failed=0;synthetic=$true;releaseRoot=$release;manifestSha256=(Hash $manifestFile);pins=$pins;powerShell=@{path=$pwsh;sha256=(Hash $pwsh)};cases=$cases;originalsPreserved=$true;installedFilesChanged=0;registryWrites=0;credentialInvocation=0;realModelCalls=0;sharedHomeWrites=0;meaning='Actual installed preparation command; not v8 private reader acceptance, HOME activation, or authentication E2E'}
Write-EvidenceText (Join-Path $evidence 'acceptance.json') ($result|ConvertTo-Json -Depth 12)
$result|ConvertTo-Json -Depth 12
