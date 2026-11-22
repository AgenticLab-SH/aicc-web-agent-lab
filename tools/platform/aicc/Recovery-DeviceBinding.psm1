Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:BindingModulePath=[IO.Path]::GetFullPath($PSCommandPath)
$script:LegacyDevice='32002de6-dd98-4da6-9423-7d1032bfec6e'
function BindingHash([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function BindingTextHash([string]$Value){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()}
function BindingRegular([string]$Path){
  $full=[IO.Path]::GetFullPath($Path)
  for($cursor=$full;$cursor;$cursor=Split-Path -Parent $cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked device binding path refused'}}}
  $file=Get-Item -LiteralPath $full -Force
  if($file.PSIsContainer){throw 'Regular device binding file required'}
  $full
}
function BindingRead([string]$Path){$full=BindingRegular $Path;if((Get-Item -LiteralPath $full).Length -gt 4MB){throw 'Bounded device evidence required'};[IO.File]::ReadAllText($full)|ConvertFrom-Json -DateKind String}
function BindingNew([string]$Path,$Value){
  $full=[IO.Path]::GetFullPath($Path);$parent=Split-Path -Parent $full
  $owned=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\webgpt-remote-recovery\device-registrations'
  if(-not $full.StartsWith($owned+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Owned device registration directory required'}
  [IO.Directory]::CreateDirectory($parent)|Out-Null
  for($cursor=$parent;$cursor;$cursor=Split-Path -Parent $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked device registration directory refused'}}
  $stream=[IO.File]::Open($full,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 30 -Compress));$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
  $full
}
function BindingMachine{
  $guid=[Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography','MachineGuid',$null)
  if(-not $guid){throw 'Current Windows machine identity unavailable'}
  @{computerName=[Environment]::MachineName;machineGuidSha256=(BindingTextHash ([string]$guid));ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
}
function BindingProcess([int]$Id){
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$Id)
  if(-not $p -or -not $p.CommandLine -or -not $p.ExecutablePath){throw 'Device host process identity unavailable'}
  @{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;createdTicks=$p.CreationDate.ToUniversalTime().Ticks.ToString();image=(BindingRegular $p.ExecutablePath);imageSha256=(BindingHash $p.ExecutablePath);commandSha256=(BindingTextHash ([string]$p.CommandLine))}
}
function BindingSameProcess($A,$B){$A.pid -eq $B.pid -and $A.parentPid -eq $B.parentPid -and $A.createdTicks -ceq $B.createdTicks -and $A.image -ieq $B.image -and $A.imageSha256 -ceq $B.imageSha256 -and $A.commandSha256 -ceq $B.commandSha256}
function BindingSameMachine($A,$B){$A.computerName -ceq $B.computerName -and $A.machineGuidSha256 -ceq $B.machineGuidSha256 -and $A.ownerSid -ceq $B.ownerSid}
function BindingTime([string]$Value){
  $date=[DateTimeOffset]::Parse($Value)
  if($date.Offset -ne [TimeSpan]::Zero){throw 'UTC device evidence time required'}
  $date
}
function BindingChallenge($Challenge,$Machine,$Host,[DateTimeOffset]$Now){
  if($Challenge.schema -cne 'aicc-rdc-device-challenge/v1' -or $Challenge.deviceId -cnotmatch '^[a-f0-9-]{36}$' -or $Challenge.linkId -cnotmatch '^link_[A-Za-z0-9_-]+$' -or $Challenge.nonce -cnotmatch '^[a-f0-9]{32}$'){throw 'Exact device challenge required'}
  $created=BindingTime $Challenge.createdAt;$expires=BindingTime $Challenge.expiresAt
  if($created -gt $Now -or $expires -le $Now -or $expires -gt $created.AddMinutes(15)){throw 'Device challenge expired or has unbounded lifetime'}
  if(-not (BindingSameMachine $Challenge.machine $Machine)){throw 'Device machine identity differs'}
  if(-not (BindingSameProcess $Challenge.rdcHost $Host)){throw 'Device host generation differs'}
  if($Challenge.module.path -ine $script:BindingModulePath -or $Challenge.module.sha256 -cne (BindingHash $script:BindingModulePath)){throw 'Device binding module pin differs'}
}
function BindingEnvelope($Envelope,[string]$Tool,[string]$LinkId,[DateTimeOffset]$Created,[DateTimeOffset]$Expires){
  if($Envelope.schemaVersion -ne 1 -or $Envelope.source -cne 'RDC official MCP' -or $Envelope.tool -cne $Tool -or $Envelope.arguments.link_id -cne $LinkId -or $Envelope.response.isError){throw 'Official RDC evidence envelope differs'}
  $time=BindingTime $Envelope.observedAt
  if($time -lt $Created -or $time -gt $Expires -or $time -gt [DateTimeOffset]::UtcNow){throw 'Official RDC evidence time differs'}
  $texts=@($Envelope.response.content|Where-Object type -ceq 'text'|ForEach-Object text)
  if(-not $texts.Count){throw 'Official RDC original text is missing'}
  $texts -join "`n"
}
function BindingProof($Registration,$Machine,$Host,[DateTimeOffset]$Now){
  if($Registration.schema -cne 'aicc-rdc-device-registration/v1'){throw 'Exact device registration schema required'}
  $challenge=$Registration.challenge
  BindingChallenge $challenge $Machine $Host $Now
  $created=BindingTime $challenge.createdAt;$expires=BindingTime $challenge.expiresAt
  if($Registration.challengeSha256 -cnotmatch '^[a-f0-9]{64}$' -or (BindingTextHash ($challenge|ConvertTo-Json -Depth 30 -Compress)) -cne $Registration.challengeSha256 -or $Registration.deviceId -cne $challenge.deviceId){throw 'Device registration challenge differs'}
  $list=BindingEnvelope $Registration.evidence.list 'list_devices' $challenge.linkId $created $expires
  # Match one complete official list entry. Neither device order nor its display name grants authority.
  $entries=[regex]::Matches($list,'(?ms)^\s*\d+\. [^\r\n]+\r?\n(?<body>.*?)(?=^\s*\d+\. |\z)')
  $matching=@($entries|Where-Object {$_.Groups['body'].Value -match ('(?m)^\s*ID:\s*'+[regex]::Escape($challenge.deviceId)+'\s*$')})
  if($matching.Count -ne 1 -or $matching[0].Groups['body'].Value -notmatch '(?m)^\s*Status:\s*Online\s*$'){throw 'Exact registered device is not uniquely Online in the official response'}
  $start=BindingEnvelope $Registration.evidence.start 'start_process' $challenge.linkId $created $expires
  $outputTool=$Registration.evidence.output.tool
  if($outputTool -cnotin @('read_process_output','start_process')){throw 'Official probe output tool differs'}
  $output=BindingEnvelope $Registration.evidence.output $outputTool $challenge.linkId $created $expires
  if($Registration.evidence.start.arguments.deviceId -cne $challenge.deviceId -or $Registration.evidence.start.arguments.command -cne $Registration.probeCommand){throw 'Exact challenge start arguments differ'}
  $footer='(?m)^\[executed on device: [^\r\n]+ \('+[regex]::Escape($challenge.deviceId)+'\)\]\s*$'
  if($start -notmatch $footer -or $output -notmatch $footer){throw 'Official probe transport device differs'}
  $pidMatch=[regex]::Match($start,'Process started with PID ([1-9][0-9]*) \(shell: powershell\.exe\)')
  if(-not $pidMatch.Success){throw 'Official probe process ACK missing'}
  $responsePid=[int]$pidMatch.Groups[1].Value
  if($outputTool -ceq 'read_process_output' -and $Registration.evidence.output.arguments.pid -ne $responsePid){throw 'Probe output belongs to another process'}
  $proofs=@($output -split '\r?\n'|Where-Object {$_ -match '^\{.*"schema"\s*:\s*"aicc-rdc-device-probe/v1".*\}$'})
  if($proofs.Count -ne 1){throw 'Exactly one official challenge probe output required'}
  $probe=$proofs[0]|ConvertFrom-Json -DateKind String
  if($probe.schema -cne 'aicc-rdc-device-probe/v1' -or $probe.challengeSha256 -cne $Registration.challengeSha256 -or $probe.nonce -cne $challenge.nonce -or $probe.deviceId -cne $challenge.deviceId -or -not (BindingSameMachine $probe.machine $Machine) -or -not (BindingSameProcess $probe.rdcHost $Host)){throw 'Official challenge probe binding differs'}
  $observed=BindingTime $probe.observedAt
  if($observed -lt $created -or $observed -gt $expires -or $observed -gt $Now){throw 'Official challenge probe expired'}
  $ancestry=@($probe.ancestry)
  if($ancestry.Count -lt 2 -or $ancestry.Count -gt 16 -or -not (BindingSameProcess $ancestry[-1] $Host) -or $responsePid -notin @($ancestry|Select-Object -SkipLast 1|ForEach-Object pid)){throw 'Official probe does not descend from the exact RDC host'}
  $seen=@{}
  for($i=0;$i -lt $ancestry.Count;$i++){
    $row=$ancestry[$i]
    if($seen.ContainsKey([int]$row.pid) -or $row.createdTicks -cnotmatch '^[0-9]+$' -or $row.imageSha256 -cnotmatch '^[a-f0-9]{64}$' -or $row.commandSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Invalid probe ancestry pins'}
    $seen[[int]$row.pid]=$true
    if($i -lt $ancestry.Count-1 -and ($row.parentPid -ne $ancestry[$i+1].pid -or [long]$row.createdTicks -lt [long]$ancestry[$i+1].createdTicks)){throw 'Probe ancestry chain differs'}
  }
  if($Registration.probeCommand -cne (Get-AiccRecoveryDeviceProbeCommand -ChallengePath $Registration.challengePath -ChallengeSha256 $Registration.challengeSha256 -PowerShellPath $challenge.powershell.path)){throw 'Registration probe command differs'}
  return $Registration
}
function Get-AiccRecoveryDeviceProbeCommand{
  param([Parameter(Mandatory)][string]$ChallengePath,[Parameter(Mandatory)][string]$ChallengeSha256,[Parameter(Mandatory)][string]$PowerShellPath)
  if($ChallengeSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Challenge SHA256 required'}
  $quote={param($s) "'"+$s.Replace("'","''")+"'"}
  $code='Import-Module '+(& $quote $script:BindingModulePath)+' -Force; Get-AiccRecoveryDeviceProbe -ChallengePath '+(& $quote ([IO.Path]::GetFullPath($ChallengePath)))+' -ChallengeSha256 '+(& $quote $ChallengeSha256)+' | ConvertTo-Json -Depth 15 -Compress'
  # Literal command stays reviewable; only read-only attestation runs through RDC.
  '& "'+[IO.Path]::GetFullPath($PowerShellPath)+'" -NoLogo -NoProfile -NonInteractive -Command "'+$code+'"'
}
function New-AiccRecoveryDeviceChallenge{
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$DeviceId,[Parameter(Mandatory)][string]$LinkId,[Parameter(Mandatory)][int]$RdcHostPid,[ValidateRange(1,15)][int]$Minutes=15)
  $now=[DateTimeOffset]::UtcNow;$engine=BindingRegular ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
  $challenge=[ordered]@{schema='aicc-rdc-device-challenge/v1';deviceId=$DeviceId;linkId=$LinkId;nonce=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant();createdAt=$now.ToString('o');expiresAt=$now.AddMinutes($Minutes).ToString('o');machine=(BindingMachine);rdcHost=(BindingProcess $RdcHostPid);module=@{path=$script:BindingModulePath;sha256=(BindingHash $script:BindingModulePath)};powershell=@{path=$engine;sha256=(BindingHash $engine)}}
  BindingChallenge ([pscustomobject]$challenge) $challenge.machine $challenge.rdcHost $now
  $full=BindingNew $Path $challenge;$hash=BindingHash $full
  @{state='CHALLENGE_ONLY_NOT_REGISTERED';challengePath=$full;challengeSha256=$hash;expiresAt=$challenge.expiresAt;command=(Get-AiccRecoveryDeviceProbeCommand $full $hash $engine);runtimeChanged=$false}
}
function Get-AiccRecoveryDeviceProbe{
  param([Parameter(Mandatory)][string]$ChallengePath,[Parameter(Mandatory)][string]$ChallengeSha256)
  if($ChallengeSha256 -cnotmatch '^[a-f0-9]{64}$' -or (BindingHash (BindingRegular $ChallengePath)) -cne $ChallengeSha256){throw 'Immutable device challenge differs'}
  $challenge=BindingRead $ChallengePath;$machine=BindingMachine;$hostPin=BindingProcess $challenge.rdcHost.pid
  BindingChallenge $challenge $machine $hostPin ([DateTimeOffset]::UtcNow)
  $engine=BindingRegular ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
  if($engine -ine $challenge.powershell.path -or (BindingHash $engine) -cne $challenge.powershell.sha256){throw 'Pinned probe PowerShell required'}
  $blocked=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -in @(10100,10101,17841)|ForEach-Object OwningProcess)
  $ancestry=@();$cursor=$PID;$found=$false
  for($depth=0;$cursor -gt 0 -and $depth -lt 16;$depth++){
    if($cursor -in $blocked){throw 'Device probe depends on the affected route'}
    $row=BindingProcess $cursor;$ancestry+=@($row)
    if($cursor -eq $hostPin.pid){if(-not (BindingSameProcess $row $hostPin)){throw 'Probe host generation changed'};$found=$true;break}
    $cursor=[int]$row.parentPid
  }
  if(-not $found){throw 'Device probe was not launched by the exact RDC host'}
  [ordered]@{schema='aicc-rdc-device-probe/v1';deviceId=$challenge.deviceId;nonce=$challenge.nonce;challengeSha256=$ChallengeSha256;machine=$machine;rdcHost=$hostPin;ancestry=$ancestry;observedAt=[DateTimeOffset]::UtcNow.ToString('o');runtimeChanged=$false}
}
function New-AiccRecoveryDeviceRegistration{
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$ChallengePath,[Parameter(Mandatory)][string]$ChallengeSha256,[Parameter(Mandatory)][string]$ListEnvelopePath,[Parameter(Mandatory)][string]$StartEnvelopePath,[Parameter(Mandatory)][string]$OutputEnvelopePath)
  if($ChallengeSha256 -cnotmatch '^[a-f0-9]{64}$' -or (BindingHash (BindingRegular $ChallengePath)) -cne $ChallengeSha256){throw 'Immutable challenge SHA256 differs'}
  $challenge=BindingRead $ChallengePath
  $registration=[ordered]@{schema='aicc-rdc-device-registration/v1';deviceId=$challenge.deviceId;challengePath=[IO.Path]::GetFullPath($ChallengePath);challengeSha256=$ChallengeSha256;challenge=$challenge;probeCommand=(Get-AiccRecoveryDeviceProbeCommand $ChallengePath $ChallengeSha256 $challenge.powershell.path);evidence=@{list=(BindingRead $ListEnvelopePath);start=(BindingRead $StartEnvelopePath);output=(BindingRead $OutputEnvelopePath)};sealedAt=[DateTimeOffset]::UtcNow.ToString('o');authority='existing_registered_device_exact_host_attestation';runtimeChanged=$false}
  $null=BindingProof ([pscustomobject]$registration) (BindingMachine) (BindingProcess $challenge.rdcHost.pid) ([DateTimeOffset]::UtcNow)
  # One local challenge can seal only one registration. A failed/unknown seal is reconciled, never replayed.
  $claimPath=$ChallengePath+'.registration-claim.json'
  $null=BindingNew $claimPath @{challengeSha256=$ChallengeSha256;registrationPath=[IO.Path]::GetFullPath($Path);claimedAt=[DateTimeOffset]::UtcNow.ToString('o')}
  $full=BindingNew $Path $registration
  @{state='SEALED_REGISTRATION_NOT_ARMED';registrationPath=$full;registrationSha256=(BindingHash $full);deviceId=$challenge.deviceId;expiresAt=$challenge.expiresAt;runtimeChanged=$false}
}
function Get-AiccRecoveryDeviceRegistration{
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Sha256,[Parameter(Mandatory)][string]$DeviceId,[Parameter(Mandatory)]$RdcHost)
  if($Sha256 -cnotmatch '^[a-f0-9]{64}$' -or (BindingHash (BindingRegular $Path)) -cne $Sha256){throw 'Immutable device registration SHA256 differs'}
  $registration=BindingRead $Path
  if($registration.deviceId -cne $DeviceId -or -not (BindingSameProcess $registration.challenge.rdcHost $RdcHost)){throw 'Exact operation device/host registration differs'}
  BindingProof $registration (BindingMachine) (BindingProcess $RdcHost.pid) ([DateTimeOffset]::UtcNow)
}
function Assert-AiccRecoveryDeviceMetadata{
  param([Parameter(Mandatory)]$Metadata)
  $binding=$Metadata.PSObject.Properties['deviceRegistration']
  if(-not $binding){if($Metadata.deviceId -cne $script:LegacyDevice){throw 'New device requires exact registered host attestation'};return}
  $pin=$binding.Value
  if($pin.modulePath -ine $script:BindingModulePath -or $pin.moduleSha256 -cne (BindingHash $script:BindingModulePath)){throw 'Operation device binding module pin changed'}
  $registration=Get-AiccRecoveryDeviceRegistration -Path $pin.path -Sha256 $pin.sha256 -DeviceId $Metadata.deviceId -RdcHost $Metadata.rdcHost
  if((BindingTime $Metadata.recoveryExpiresAt) -gt (BindingTime $registration.challenge.expiresAt)){throw 'Operation outlives its exact device registration'}
}
Export-ModuleMember -Function New-AiccRecoveryDeviceChallenge,Get-AiccRecoveryDeviceProbeCommand,Get-AiccRecoveryDeviceProbe,New-AiccRecoveryDeviceRegistration,Get-AiccRecoveryDeviceRegistration,Assert-AiccRecoveryDeviceMetadata
