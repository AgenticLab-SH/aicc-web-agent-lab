#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SnapshotPath,[Parameter(Mandatory)][string]$ReleaseManifestPath,
  [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]{7,120}$')][string]$OperationId,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string]$Nonce)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$SnapshotPath=[IO.Path]::GetFullPath($SnapshotPath)
$allowed=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center\backups\runtime-layout\'
if(-not $SnapshotPath.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $SnapshotPath -Leaf) -notmatch '^ocx-clean-\d{8}-\d{6}-[a-f0-9]{8}$'){throw 'Exact software-only snapshot required'}
$helper=Join-Path $PSScriptRoot 'Invoke-AiccOcxTransition.ps1'
function Hash([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function WriteNew([string]$Name,$Value){
  $stream=[IO.File]::Open((Join-Path $SnapshotPath $Name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 8));$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Transition([string]$Mode){
  $start=[Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($arg in @('-NoProfile','-File',$helper,'-Mode',$Mode,'-SnapshotPath',$SnapshotPath,'-RecoveryOperationId',$OperationId)){[void]$start.ArgumentList.Add($arg)}
  if($Mode -eq 'Activate'){
    foreach($arg in @('-ReleaseManifestPath',$ReleaseManifestPath,'-RecoveryNonce',$Nonce,'-LocalRecoveryReadyPath',(Join-Path $SnapshotPath 'local-recovery-ready.json'))){[void]$start.ArgumentList.Add($arg)}
  }
  $child=[Diagnostics.Process]::Start($start)
  $outTask=$child.StandardOutput.ReadToEndAsync();$errorTask=$child.StandardError.ReadToEndAsync()
  if(-not $child.WaitForExit(180000)){$script:transitionStillRunning=$true;throw 'Transition still running; inspect child rather than duplicate'}
  $stdout=$outTask.GetAwaiter().GetResult();$stderr=$errorTask.GetAwaiter().GetResult()
  WriteNew ($Mode.ToLowerInvariant()+'-worker-output.json') @{exitCode=$child.ExitCode;stdout=$stdout;stderr=$stderr}
  if($child.ExitCode -ne 0){throw ($Mode+' failed; see exact worker output')}
  return ($stdout|ConvertFrom-Json -DateKind String)
}
$self=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
$ready=@{schema='aicc-ocx-local-recovery/v1';state='READY';operationId=$OperationId;nonce=$Nonce;workerPid=$PID;
  workerStartedTicks=$self.CreationDate.ToUniversalTime().Ticks.ToString();readyAt=[DateTimeOffset]::UtcNow.ToString('o');expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(2).ToString('o');
  snapshotSha256=Hash (Join-Path $SnapshotPath 'snapshot.json');manifestSha256=Hash $ReleaseManifestPath;helperSha256=Hash $helper;workerSha256=Hash $PSCommandPath;
  recovery='exact software rollback; no model, account switch, schedule or original request replay'}
WriteNew 'local-recovery-ready.json' $ready
$attempted=$false;$state='EXPIRED_WITHOUT_ACTIVATION';$rollback=$null;$reason=$null;$script:transitionStillRunning=$false
try{
  do{
    $signalPath=Join-Path $SnapshotPath 'local-activate-signal.json'
    if(Test-Path -LiteralPath $signalPath){
      $signal=Get-Content -LiteralPath $signalPath -Raw|ConvertFrom-Json -DateKind String
      if($signal.operationId -cne $OperationId -or $signal.nonce -cne $Nonce -or $signal.snapshotSha256 -cne $ready.snapshotSha256 -or $signal.manifestSha256 -cne $ready.manifestSha256){throw 'Activation signal binding differs'}
      if((Hash $helper) -cne $ready.helperSha256 -or (Hash $ReleaseManifestPath) -cne $ready.manifestSha256){throw 'Frozen transition changed'}
      $attempted=$true;$activation=Transition 'Activate'
      if($activation.state -cne 'ACTIVATED'){throw 'Activation unconfirmed'}
      $state='ACTIVATED';break
    }
    Start-Sleep -Milliseconds 250
  }while([DateTimeOffset]::UtcNow -lt [DateTimeOffset]::Parse($ready.expiresAt))
}catch{
  $reason=$_.Exception.Message;$state='NOT_ACTIVATED'
  if($attempted -and $script:transitionStillRunning){$state='RECOVERY_NEEDS_ATTENTION'}
  elseif($attempted){
    # The transition never takes over a foreign owner; rollback uses the same preimage/CAS rules.
    try{$rollback=Transition 'Rollback';$state='ROLLED_BACK'}catch{$state='RECOVERY_NEEDS_ATTENTION';$reason+='; '+$_.Exception.Message}
  }
}
WriteNew 'local-recovery-result.json' @{schema='aicc-ocx-local-recovery-result/v1';operationId=$OperationId;state=$state;activationAttempted=$attempted;rollback=$rollback;reason=$reason;completedAt=[DateTimeOffset]::UtcNow.ToString('o');originalRequestsReplayed=$false}
