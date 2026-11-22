#requires -Version 7.5
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\windows\Invoke-AiccRdcRotation.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'RDC source parse failed'}
foreach($name in @('Read','Save-Json','Account','Fresh','Quota-Pool','Select-NextAccount')){
 $f=$ast.FindAll({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -CEQ $name
 Invoke-Expression $f.Extent.Text
}
$passed=0
function Check($condition,$message){if(-not $condition){throw $message};$script:passed++}
$fixture=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('rdc-fixture-'+[guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Path $fixture|Out-Null
$cfg=@{thresholdPercent=10;accounts=@(@{profile='account1'},@{profile='account2'},@{profile='account3'})}
$availabilityFile=Join-Path $fixture 'availability.json';$dir=$fixture
function Current{@{profile='account1'}}
$f=Join-Path $fixture 'atomic.json';Save-Json $f @{revision=1};Save-Json $f @{revision=2}
Check ((Read $f).revision -eq 2) 'durable current JSON missing'
Check ((Read ($f+'.previous')).revision -eq 1) 'previous JSON not retained'
$time=(Get-Item -LiteralPath $f).LastWriteTimeUtc;Save-Json $f @{revision=2}
Check ((Get-Item -LiteralPath $f).LastWriteTimeUtc -eq $time) 'unchanged state was rewritten'
[IO.File]::WriteAllBytes((Join-Path $fixture 'corrupt.json'),[byte[]]::new(30));$refused=$false
try{$null=Read (Join-Path $fixture 'corrupt.json')}catch{$refused=$true};Check $refused 'NUL state did not fail closed'
$now=[DateTimeOffset]::UtcNow.ToString('o');Save-Json $availabilityFile @{account1=@{remainingPercent=99;observedAt=$now};account2=@{remainingPercent=10;observedAt=$now};account3=@{remainingPercent=10.01;observedAt=$now}}
$pool=Quota-Pool
Check ($pool.accounts[1].excluded -and $pool.accounts[1].reason -eq 'LOW_QUOTA') '10 percent exclusion failed'
Check (-not $pool.accounts[2].excluded) 'quota above 10 percent not eligible'
Check ((Select-NextAccount $pool '' (Current)).profile -eq 'account3') 'selector did not skip excluded account'
Check ($null -eq (Select-NextAccount $pool 'account2' (Current))) 'explicit excluded account selected'
$pool.accounts[2].excluded=$true
Check ($null -eq (Select-NextAccount $pool '' (Current))) 'all-excluded QUOTA_WAIT selection did not preserve current'
# Kept local fixture files are small, contain no credentials, and are not owner state.
@{passed=$passed;failed=0;fixture=$fixture;realAccountSwitches=0;realLogins=0}|ConvertTo-Json -Compress