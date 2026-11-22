#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$JobFile,[Parameter(Mandatory)][string]$DeploymentRoot)
$ErrorActionPreference='Stop'
$stateRoot=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'}
$jobPath=[IO.Path]::GetFullPath($JobFile);$releasePath=[IO.Path]::GetFullPath($DeploymentRoot)
if(-not $jobPath.StartsWith((Join-Path $stateRoot 'jobs')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or -not $releasePath.StartsWith((Join-Path $stateRoot 'releases\policy-deployment')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Owner-bound job paths required'}
$job=Get-Content -LiteralPath $jobPath -Raw|ConvertFrom-Json -AsHashtable
if($job.action -ne 'deploy-ocx-dynamic-policy' -or $job.targetVersion -ne '2.77.0-aicc.windows.2'){throw 'Exact policy job required'}
$lock=[IO.File]::Open($jobPath+'.lock',[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
function Save-Job([string]$state){$job.state=$state;$job.updatedAt=[DateTimeOffset]::Now.ToString('o');$temporary=$jobPath+'.tmp';[IO.File]::WriteAllText($temporary,($job|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $jobPath -Force}
try{
  if($job.state -in @('DEPLOYING','PASS','UNCERTAIN')){throw 'Previously dispatched job must be reconciled, never replayed'}
  foreach($relative in $job.sourceHashes.Keys){$target=[IO.Path]::GetFullPath((Join-Path $releasePath $relative));if(-not $target.StartsWith($releasePath+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $job.sourceHashes[$relative]){throw 'Immutable deployment source changed'}}
  $operator=Join-Path $releasePath 'tools\platform\opencodex\Invoke-AiccOcxWindowPolicy.ps1'
  $deadline=[DateTimeOffset]::Parse($job.expiresAt);$errors=0;$stable=0
  while([DateTimeOffset]::Now -lt $deadline){
    try{
      $observed=(& $operator -Action status)|ConvertFrom-Json -AsHashtable
      if($observed.terminal -eq 'PASS' -and $observed.version -eq $job.targetVersion){$job.result=$observed;Save-Job 'PASS';return}
      $activity=(& $operator -Action activity)|ConvertFrom-Json -AsHashtable
      if($activity.terminal -ne 'PASS' -or $null -eq $activity.activeTurnCount){throw 'Owner activity unconfirmed'}
      $errors=0;$job.activeTurnCount=$activity.activeTurnCount
      if($activity.activeTurnCount -eq 0 -and $activity.isDraining -eq $false){$stable++}else{$stable=0}
      Save-Job 'WAITING_IDLE'
      if($stable -ge 2){
        Save-Job 'DEPLOYING'
        try{$result=(& $operator -Action deploy -TargetVersion 2.77.0 -DynamicSettings)|ConvertFrom-Json -AsHashtable}
        catch{
          # The maintained installer refuses busy before it builds or stops the service.
          if($_.Exception.Message -match 'reason=hub_busy_preserved'){$stable=0;Save-Job 'WAITING_IDLE';Start-Sleep -Seconds 15;continue}
          $job.failure='deployment_result_unconfirmed';Save-Job 'UNCERTAIN';return
        }
        $post=(& $operator -Action status)|ConvertFrom-Json -AsHashtable
        if($result.terminal -eq 'PASS' -and $post.terminal -eq 'PASS' -and $post.version -eq $job.targetVersion){$job.result=$result;$job.post=$post;Save-Job 'PASS'}else{$job.failure='postcondition_unconfirmed';Save-Job 'UNCERTAIN'}
        return
      }
    }catch{$errors++;$job.failure='owner_read_unconfirmed';if($errors -ge 3){Save-Job 'HOLD';return}}
    Start-Sleep -Seconds 15
  }
  $job.failure='idle_deadline_expired_without_dispatch';Save-Job 'HOLD'
}finally{$lock.Dispose()}
