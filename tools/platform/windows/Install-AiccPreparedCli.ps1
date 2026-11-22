#requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$aiccOwnerRoot=[Environment]::GetFolderPath('UserProfile')
$aiccStateRoot=Join-Path $aiccOwnerRoot '.ai-control-center'
$aiccSourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$registryFile=Join-Path $aiccStateRoot 'runtime/components.json'
$candidate=Join-Path $aiccStateRoot 'releases/cli/controlplane-13c47a4b1e33423d'
$expectedManifest='0c75d3e2931e7a9e3f2f5082eb329d6ece0a1f874d77d4cf559a1203a09197b9'
function FileHash([string]$file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function RequireRegular([string]$file){$item=Get-Item -LiteralPath $file;if($item.PSIsContainer -or $item.LinkType){throw 'Regular owner file required.'}}
RequireRegular $registryFile
RequireRegular (Join-Path $candidate '.aicc-release.json')
if((FileHash (Join-Path $candidate '.aicc-release.json')) -cne $expectedManifest){throw 'Prepared candidate changed; no installation.'}
$lock=[IO.File]::Open((Join-Path $aiccStateRoot 'runtime/cli-home-install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
  $before=[IO.File]::ReadAllBytes($registryFile)
  $beforeHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($before)).ToLowerInvariant()
  $registry=[Text.Encoding]::UTF8.GetString($before)|ConvertFrom-Json -AsHashtable
  $cli=$registry.components.cli
  $previous=Join-Path $aiccStateRoot 'releases/cli/controlplane-925bff53'
  if($registry.schemaVersion -ne 1 -or $registry.root -ine $aiccStateRoot -or $cli.location -ne 'managed' -or $cli.releaseRoot -notin @($previous,$candidate)){throw 'CLI owner changed; preserve it.'}
  $node=$cli.runtime;RequireRegular $node
  $nodeRoot=Split-Path $node -Parent
  $entry=Join-Path $nodeRoot 'node_modules/open-aicc'
  $stamp=(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $receipt=Join-Path $aiccStateRoot ('receipts/cli-home-install-'+$stamp+'.json')
  $backupRoot=Join-Path $aiccStateRoot 'backups/runtime-layout'
  $restore=Join-Path $aiccSourceRoot 'tools/platform/aicc/restore-installed-cli-route.ps1'
  $cutover=Join-Path $aiccSourceRoot 'tools/platform/aicc/run-installed-cli-route-cutover.mjs'
  RequireRegular $restore;RequireRegular $cutover
  $arguments=@($cutover,'--state-root',$aiccStateRoot,'--entry',$entry,'--candidate',$candidate,
    '--backup-root',$backupRoot,'--receipt',$receipt,'--recovery-script',$restore,
    '--wrapper',(Join-Path $nodeRoot 'aicc.cmd'),'--wrapper',(Join-Path $nodeRoot 'aicc.ps1'),
    '--wrapper',(Join-Path $nodeRoot 'aicc'),'--legacy-pointer',$registryFile,'--wait-ms','0')
  & $node @arguments
  $cutoverExit=$LASTEXITCODE
  if($cutoverExit -ne 0){Write-Host ('Installation stopped by the existing safety gate. Receipt: '+$receipt);exit $cutoverExit}
  $result=Get-Content -LiteralPath $receipt -Raw|ConvertFrom-Json
  $alreadyCurrent=$result.terminal -eq 'NOT_APPLICABLE' -and $result.reason -eq 'candidate_already_installed'
  if(-not $alreadyCurrent -and ($result.terminal -ne 'PASS' -or $result.installedCandidate -ne $true)){throw 'CLI cutover outcome unconfirmed; do not retry.'}
  if($cli.releaseRoot -ieq $candidate){Write-Host 'PASS_ALREADY_CURRENT';return}
  try{
    if((FileHash $registryFile) -cne $beforeHash){throw 'Home registry changed; preserve the newer owner.'}
    $backup=Join-Path $backupRoot ('cli-home-registry-'+$stamp)
    New-Item -Path $backup -ItemType Directory|Out-Null
    [IO.File]::WriteAllBytes((Join-Path $backup 'components.before.json'),$before)
    $cli.previousEntry=$cli.entry;$cli.entry=Join-Path $candidate 'bin/aicc'
    $cli.releaseRoot=$candidate;$cli.sourceRelease=Split-Path $candidate -Leaf
    $temporary=$registryFile+'.'+$stamp+'.tmp'
    [IO.File]::WriteAllText($temporary,($registry|ConvertTo-Json -Depth 30)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
    if((FileHash $registryFile) -cne $beforeHash){throw 'Home registry changed during preparation; preserve it.'}
    # PowerShell can bind $null to an empty string for this .NET string argument.
    # Supply a real, operation-owned backup path instead.
    [IO.File]::Replace($temporary,$registryFile,(Join-Path $backup 'components.replaced.json'))
    [pscustomobject]@{terminal='PASS_INSTALLED';candidate=$candidate;cutoverReceipt=$receipt;registryBackup=$backup;servicesRestarted=$false}|ConvertTo-Json -Compress
  }catch{
    $problem=$_.Exception.Message
    # Roll back only this confirmed junction change; never stop a service or
    # restore someone else's newer components registry.
    if(-not $alreadyCurrent -and $result.backupTarget){
      $routeBackup=[IO.Path]::GetFullPath($result.backupTarget)
      $allowed=[IO.Path]::GetFullPath($backupRoot)+[IO.Path]::DirectorySeparatorChar
      if(-not $routeBackup.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'HOLD_PARTIAL: recovery location differs.'}
      $manifestFile=Join-Path $routeBackup 'manifest.json';RequireRegular $manifestFile
      $saved=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json
      $link=Get-Item -LiteralPath $entry -Force
      if($saved.component -ne 'installed-cli-route' -or $saved.entryPath -ine $entry -or $saved.sourceTarget -ine $previous -or $saved.candidatePath -ine $candidate -or $link.LinkType -notin @('Junction','SymbolicLink') -or ([IO.Path]::GetFullPath(@($link.Target)[0])) -ine $candidate){throw 'HOLD_PARTIAL: route owner changed; no automatic rollback.'}
      & $restore -BackupTarget $routeBackup -ExpectedManifestSha256 (FileHash $manifestFile)
    }
    throw ('Home registration not completed: '+$problem+'; receipt='+$receipt)
  }
}finally{$lock.Dispose()}
