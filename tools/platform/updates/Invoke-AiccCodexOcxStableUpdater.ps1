#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Menu','Status','PrepareCodex','PrepareOcx','PrepareBoth')][string]$Action='Menu')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false)
$owner=[Environment]::GetFolderPath('UserProfile')
$homeRoot=Join-Path $owner '.ai-control-center'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$ocxHelper=Join-Path $repo 'tools\platform\opencodex\Prepare-AiccOcxUpstream.ps1'
$registry=Join-Path $homeRoot 'runtime\ocx-local\current.json'

function Get-Latest([string]$package) {
  $escaped=if($package -ceq '@openai/codex'){'@openai%2fcodex'}elseif($package -ceq '@bitkyc08/opencodex'){'@bitkyc08%2fopencodex'}else{throw 'Unknown supplier'}
  $x=Invoke-RestMethod -Uri ('https://registry.npmjs.org/'+$escaped+'/latest') -TimeoutSec 20
  if($x.name -cne $package -or [string]$x.version -cnotmatch '^\d+\.\d+\.\d+$') { throw 'Registry identity or stable tag changed' }
  $uri=[uri]$x.dist.tarball
  if($uri.Scheme -cne 'https' -or $uri.Host -cne 'registry.npmjs.org' -or
     $x.dist.integrity -cnotmatch '^sha512-([A-Za-z0-9+/=]+)$') { throw 'Official HTTPS archive and SHA512 integrity required' }
  $hash=[Convert]::ToHexString([Convert]::FromBase64String($Matches[1])).ToLowerInvariant()
  if($hash.Length -ne 128){ throw 'Invalid npm archive SHA512' }
  return [pscustomobject]@{name=$package;version=[string]$x.version;url=$uri.AbsoluteUri;sha512=$hash}
}
function Get-InstalledCodex {
  $exe=Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\codex.exe'
  if(-not(Test-Path -LiteralPath $exe -PathType Leaf)){return 'NOT_FOUND'}
  $value=(& $exe --version 2>&1 | Out-String).Trim()
  if($LASTEXITCODE -ne 0){return 'UNKNOWN'}
  return $value
}
function Get-InstalledOcx {
  if(-not(Test-Path -LiteralPath $registry -PathType Leaf)){return 'NOT_FOUND'}
  $r=Get-Content -LiteralPath $registry -Raw | ConvertFrom-Json
  if($r.schemaVersion -ne 1 -or $r.requestExecution -cne 'windows-local'){return 'UNKNOWN'}
  return [string]$r.version
}
function Get-Ready([int]$port) {
  try{
    $result=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$port+'/readyz') -TimeoutSec 3
    return $(if($result.ready -eq $true){'READY'}else{'NOT_READY'})
  }catch{return 'UNREACHABLE'}
}
function Show-Status {
  $c=Get-Latest '@openai/codex'
  $o=Get-Latest '@bitkyc08/opencodex'
  Write-Host ('Codex CLI  : local '+(Get-InstalledCodex)+' | npm latest '+$c.version)
  Write-Host ('OCX runtime: local '+(Get-InstalledOcx)+' | npm latest '+$o.version)
  Write-Host ('Routes     : 17841='+ (Get-Ready 17841)+' 10100='+(Get-Ready 10100)+' 10101='+(Get-Ready 10101))
  Write-Host 'NOTE: AICC adapter and active sessions require independent migration checks.'
}
function Assert-RegularAncestors([string]$path) {
  for($p=[IO.Path]::GetFullPath($path);$p;$p=Split-Path $p -Parent) {
    if(Test-Path -LiteralPath $p){if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked update staging path refused'}}
    $parent=Split-Path $p -Parent
    if(-not $parent -or $parent -eq $p){break}
  }
}
function Prepare-Codex {
  $m=Get-Latest '@openai/codex'
  $dest=Join-Path $homeRoot ('updates\codex-cli\'+$m.version+'\'+$m.sha512.Substring(0,16))
  Assert-RegularAncestors $dest
  $null=New-Item -Path $dest -ItemType Directory -Force
  $artifact=Join-Path $dest 'package.tgz'
  $lock=[IO.File]::Open((Join-Path $dest 'prepare.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
    if(-not(Test-Path -LiteralPath $artifact)) {
      $tmp=Join-Path $dest ('download-'+[guid]::NewGuid().ToString('N')+'.tgz')
      Invoke-WebRequest -Uri $m.url -OutFile $tmp -TimeoutSec 90
      if((Get-FileHash -LiteralPath $tmp -Algorithm SHA512).Hash.ToLowerInvariant() -cne $m.sha512){throw 'Official archive integrity differs'}
      Move-Item -LiteralPath $tmp -Destination $artifact
    }
    if((Get-FileHash -LiteralPath $artifact -Algorithm SHA512).Hash.ToLowerInvariant() -cne $m.sha512){throw 'Staged archive integrity differs'}
    $receipt=[ordered]@{schemaVersion=1;name=$m.name;version=$m.version;sha512=$m.sha512;archive=$artifact;status='STAGED_NOT_INSTALLED';runtimeChanged=$false;atKst=[DateTimeOffset]::Now.ToString('o')}
    $target=Join-Path $dest 'stage-receipt.json'
    $temp=Join-Path $dest ('receipt-'+[guid]::NewGuid().ToString('N')+'.tmp')
    [IO.File]::WriteAllText($temp,($receipt|ConvertTo-Json -Depth 4),$utf8)
    Move-Item -LiteralPath $temp -Destination $target -Force
    Write-Host ('Codex stable '+$m.version+' SHA512 OK. Downloaded only: '+$artifact)
    Write-Host 'Installed Codex, live sessions, PATH and settings were not changed.'
  } finally {$lock.Dispose()}
}
function Prepare-Ocx {
  if(-not(Test-Path -LiteralPath $ocxHelper -PathType Leaf)){throw 'AICC owner-managed OCX preparation script missing'}
  $m=Get-Latest '@bitkyc08/opencodex'
  Write-Host ('Preparing OCX upstream '+$m.version+' with existing AICC owner helper...')
  & $ocxHelper -Action Prepare -TargetVersion $m.version
  if(-not $?) {throw 'AICC OCX prepare failed'}
  Write-Host 'OCX upstream archive prepared only. Activation requires adapter compatibility, zero active requests, rollback and owner acceptance.'
}
function Invoke-Action([string]$name) {
  switch($name) {
    'Status' {Show-Status}
    'PrepareCodex' {Prepare-Codex}
    'PrepareOcx' {Prepare-Ocx}
    'PrepareBoth' {Prepare-Codex;Prepare-Ocx}
    default {throw 'Unknown action'}
  }
}
if($Action -ne 'Menu'){Invoke-Action $Action;return}
while($true) {
  Clear-Host
  Write-Host 'AICC Codex / OCX stable-update assistant' -ForegroundColor Cyan
  Write-Host '1. Check installed / latest versions and routes'
  Write-Host '2. Download + verify latest Codex CLI (no activation)'
  Write-Host '3. Prepare latest OCX with AICC guard (no activation)'
  Write-Host '4. Prepare both (no activation)'
  Write-Host '0. Exit'
  Write-Host 'Existing sessions, accounts and running services are preserved.'
  $choice=Read-Host 'Select'
  if($choice -eq '0'){break}
  $name=switch($choice){'1'{'Status'}'2'{'PrepareCodex'}'3'{'PrepareOcx'}'4'{'PrepareBoth'}default{$null}}
  try{if(-not $name){Write-Warning 'Select 0-4'}else{Invoke-Action $name}}
  catch{Write-Warning ('HOLD: '+$_.Exception.Message)}
  [void](Read-Host 'Press Enter to return to menu')
}
