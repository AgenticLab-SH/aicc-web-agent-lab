#requires -Version 7.5
# Read-only, exact installed legacy contract. No request, claim, ACK or READY is
# created here. A lossy date, unknown process/source or ambiguous inventory holds.
Set-StrictMode -Version Latest
function Test-AiccMobileLegacyStopPins {
 param([string]$ManifestSha256,[string]$SupervisorSha256,[string]$RunnerSha256)
 # This reviewed pair uses default ConvertFrom-Json and strict JS string equality.
 # A different source requires its own review; matching a snippet is insufficient.
 return $ManifestSha256 -ceq '2a9e293d9619aa10f029265bd6b2ddac11fc4769b88c24f025ca3bc3938336cd' -and
  $SupervisorSha256 -ceq '7e6f857fcd12059be9733e70cd071a5f77827f6c5137ac53de7685198ef8345d' -and
  $RunnerSha256 -ceq '548f29b873840b999f9e8d5d88b62abc6e563a319efe1118600ebbea335e7e94'
}
function Test-AiccMobileLegacyGeneration {
 param($Status,$Runner,$Supervisor,[string]$ConfigPath,[string]$ConfigSha256,
  [string]$SupervisorPath,[string]$RunnerPath,[string]$NodePath)
 if(-not $Runner -or -not $Supervisor -or $Status.state -cne 'LISTENING' -or
  $Status.startedAt -isnot [string] -or $Status.startedAt -cnotmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' -or
  $Runner.ProcessId -ne $Status.pid -or $Runner.ParentProcessId -ne $Supervisor.ProcessId -or
  $Runner.ExecutablePath -ine $NodePath -or -not $Runner.CreationDate -or -not $Supervisor.CreationDate){return $false}
 $stamp=[DateTimeOffset]::MinValue
 if(-not [DateTimeOffset]::TryParse($Status.startedAt,[ref]$stamp)){return $false}
 $created=[DateTimeOffset]$Runner.CreationDate;$parentCreated=[DateTimeOffset]$Supervisor.CreationDate
 if($created -gt $stamp -or $stamp-$created -gt [TimeSpan]::FromSeconds(5) -or $parentCreated -gt $created){return $false}
 # Exact known command shapes, not Contains(): no extra code, config or args.
 $runnerCommand='"'+$NodePath+'" '+$RunnerPath+' '+$ConfigPath
 $quotedRunnerCommand='"'+$NodePath+'" "'+$RunnerPath+'" "'+$ConfigPath+'"'
 if($Runner.CommandLine -cne $runnerCommand -and $Runner.CommandLine -cne $quotedRunnerCommand){return $false}
 $expected='"'+$Supervisor.ExecutablePath+'"  -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$SupervisorPath+'" -ConfigFile "'+$ConfigPath+'" -ExpectedConfigSha256 '+$ConfigSha256
 return $Supervisor.CommandLine -ceq $expected
}
function Invoke-AiccMobileLegacyDateProbe {
 param([string]$PowerShellPath,[string]$ExpectedPowerShellSha256,[string]$StartedAt)
 if($ExpectedPowerShellSha256 -cnotmatch '^[a-f0-9]{64}$' -or
  (Get-FileHash -LiteralPath $PowerShellPath).Hash.ToLowerInvariant() -cne $ExpectedPowerShellSha256){throw 'legacy_powershell_pin_changed'}
 # Run ONLY a fixed, non-service serializer probe in the very same executable.
 # Input is data on stdin; no installed script is evaluated and no stop is sent.
 $code=@'
$ErrorActionPreference='Stop'
$raw=[Console]::In.ReadToEnd()
$request=$raw|ConvertFrom-Json -AsHashtable
$wire=$request|ConvertTo-Json -Compress
$after=$wire|ConvertFrom-Json -AsHashtable -DateKind String
@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;startedAt=$after.expectedStartedAt}|ConvertTo-Json -Compress
'@
 $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$PowerShellPath
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
 $psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $psi.StandardInputEncoding=[Text.UTF8Encoding]::new($false);$psi.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
 foreach($arg in @('-NoLogo','-NoProfile','-NonInteractive','-Command',$code)){$psi.ArgumentList.Add($arg)}
 $probe=[Diagnostics.Process]::Start($psi)
 try{
  $output=$probe.StandardOutput.ReadToEndAsync();$errorOutput=$probe.StandardError.ReadToEndAsync()
  $probe.StandardInput.Write((@{expectedStartedAt=$StartedAt}|ConvertTo-Json -Compress));$probe.StandardInput.Close()
  if(-not $probe.WaitForExit(5000)){throw 'legacy_serializer_probe_unconfirmed'}
  if($probe.ExitCode -ne 0 -or $output.Result.Length -gt 4096 -or $errorOutput.Result.Length){throw 'legacy_serializer_probe_failed'}
  $row=$output.Result|ConvertFrom-Json -AsHashtable -DateKind String
  if($row.edition -cne 'Core' -or ([version]$row.version) -lt [version]'7.5' -or
   (Get-FileHash -LiteralPath $PowerShellPath).Hash.ToLowerInvariant() -cne $ExpectedPowerShellSha256){throw 'legacy_serializer_identity_changed'}
  return @{exact=($row.startedAt -is [string] -and $row.startedAt -ceq $StartedAt);version=$row.version;powerShellSha256=$ExpectedPowerShellSha256}
 }finally{$probe.Dispose()}
}
function Test-AiccMobileHistoricalStopBinding {
 param($Request,$Claim,[string]$RequestSha256,[string]$RuntimeId,[string]$Operation,
  $Status,$GenerationEvidence,[bool]$OldProcessAbsent)
 if(-not $GenerationEvidence -or $GenerationEvidence.verified -ne $true -or
  $GenerationEvidence.pid -ne $Status.pid -or $GenerationEvidence.startedAt -cne $Status.startedAt -or
  $GenerationEvidence.manifestSha256 -cne $Status.releaseManifestSha256 -or -not $OldProcessAbsent){return $false}
 $keys=@('action','operationId','runtimeId','expectedPid','expectedStartedAt','releaseManifestSha256','expiresAt')
 if($Request.Count -ne $keys.Count -or @($Request.Keys|Where-Object {$_ -cnotin $keys}).Count -or
  $Request.action -cne 'drain-and-stop' -or $Request.runtimeId -cne $RuntimeId -or $Request.operationId -cne $Operation -or
  ($Request.expectedPid -isnot [int] -and $Request.expectedPid -isnot [long]) -or $Request.expectedPid -le 0 -or
  $Request.expectedPid -eq $Status.pid -or $Request.expectedStartedAt -isnot [string] -or
  $Request.expectedStartedAt -ceq $Status.startedAt -or $Request.releaseManifestSha256 -cne $Status.releaseManifestSha256 -or
  $RequestSha256 -cnotmatch '^[a-f0-9]{64}$'){return $false}
 $claimKeys=@('schemaVersion','operationId','runtimeId','pid','state','at','requestSha256','automaticReplay')
 if($Claim.Count -ne $claimKeys.Count -or @($Claim.Keys|Where-Object {$_ -cnotin $claimKeys}).Count -or
  $Claim.schemaVersion -ne 1 -or $Claim.operationId -cne $Operation -or $Claim.runtimeId -cne $RuntimeId -or
  $Claim.pid -ne $Request.expectedPid -or $Claim.requestSha256 -cne $RequestSha256 -or
  $Claim.state -cne 'CLAIMED_INPUT_OUTCOME_UNKNOWN' -or $Claim.automaticReplay -isnot [bool] -or $Claim.automaticReplay){return $false}
 $started=[DateTimeOffset]::MinValue;$expires=$started;$claimed=$started;$currentCreated=$started
 if(-not [DateTimeOffset]::TryParse($Request.expectedStartedAt,[ref]$started) -or
  -not [DateTimeOffset]::TryParse([string]$Request.expiresAt,[ref]$expires) -or
  -not [DateTimeOffset]::TryParse([string]$Claim.at,[ref]$claimed) -or
  -not [DateTimeOffset]::TryParse([string]$GenerationEvidence.createdAt,[ref]$currentCreated)){return $false}
 # Already-claimed, expired BEFORE the actual current process was created.
 # This is disjointness, not settlement or a permission to replay the old input.
 return $started -lt $claimed -and $claimed -le $expires -and $claimed -ge $expires.AddSeconds(-60) -and $expires -lt $currentCreated
}
Export-ModuleMember -Function Test-AiccMobileLegacyStopPins,Test-AiccMobileLegacyGeneration,Invoke-AiccMobileLegacyDateProbe,Test-AiccMobileHistoricalStopBinding
