#requires -Version 7.5
[CmdletBinding()]
param([Parameter(Mandatory)][string]$NodePath,[Parameter(Mandatory)][string]$RepositoryRoot)
$ErrorActionPreference='Stop'
$state=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center\monitoring\scheduler'
$entry=Join-Path $RepositoryRoot 'src\local-scheduler.mjs'
foreach($file in @($NodePath,$entry)){
  $item=Get-Item -LiteralPath $file
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'scheduler_regular_entry_required'}
}
$start=[Diagnostics.ProcessStartInfo]::new($NodePath)
$start.WorkingDirectory=$RepositoryRoot;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
foreach($arg in @($entry,'--upstream-review-only')){[void]$start.ArgumentList.Add($arg)}
foreach($name in @('CODEX_THREAD_ID','CODEX_SESSION_ID')){$null=$start.Environment.Remove($name)}
$child=[Diagnostics.Process]::Start($start)
$stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
if(-not $child.WaitForExit(60000)){throw 'scheduler_outcome_unknown_inspect_existing_due_no_replay'}
$out=$stdout.GetAwaiter().GetResult();$err=$stderr.GetAwaiter().GetResult()
$record=@{at=[DateTimeOffset]::UtcNow.ToString('o');exitCode=$child.ExitCode;automaticApply=$false;scope='upstream-review'}
if($child.ExitCode -eq 0){$record.result=$out|ConvertFrom-Json -Depth 16}else{$record.error=$err.Trim().Substring(0,[Math]::Min(600,$err.Trim().Length))}
$temporary=Join-Path $state ('last-windows-tick.'+[guid]::NewGuid().ToString('N')+'.tmp')
[IO.File]::WriteAllText($temporary,($record|ConvertTo-Json -Depth 18),[Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination (Join-Path $state 'last-windows-tick.json') -Force
if($child.ExitCode -ne 0){exit 1}
