#requires -Version 7.0
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$OcxArguments)
$ErrorActionPreference='Stop'
$owner=[Environment]::GetFolderPath('UserProfile')
$registryPath=Join-Path $owner '.ai-control-center\runtime\ocx-local\current.json'
$registered=Get-Content -LiteralPath $registryPath -Raw|ConvertFrom-Json
$command=if($OcxArguments.Count){$OcxArguments[0]}else{'dashboard'}
switch($command){
  {$_ -in @('--version','-v','version')} {
    $package=Get-Content -LiteralPath (Join-Path $registered.packageRoot 'package.json') -Raw|ConvertFrom-Json
    if($package.version -cne $registered.version){throw 'Registered supplier identity differs'}
    $package.version;return
  }
  'status' { & (Join-Path $PSScriptRoot 'Invoke-AiccOcxTransition.ps1') -Mode Status;return }
  {$_ -in @('start','ensure','recover')} { & (Join-Path $PSScriptRoot 'Invoke-AiccLocalOcx.ps1') -Action Recover;return }
  {$_ -in @('dashboard','gui')} { Start-Process 'http://127.0.0.1:10100';return }
  'update' {
    $mode=if($OcxArguments -contains '--prepare'){'Prepare'}else{'Check'}
    & (Join-Path $PSScriptRoot 'Prepare-AiccOcxUpstream.ps1') -Action $mode;return
  }
  {$_ -in @('help','--help','-h')} {
    'ocx (open dashboard) | gui | dashboard | --version | status | start | recover | update [--prepare]'
    'Official OCX supplier stays unchanged. AICC owns account/quota policy outside it; A1 alone owns credential refresh.'
    'Updates prepare independently; accepted release activation uses Invoke-AiccOcxTransition.ps1 with a fresh rollback standby.'
    return
  }
  default { throw 'This command would bypass the registered runtime owner. Account operations use the existing A1 management dashboard; supplier updates use ocx update --prepare.' }
}
