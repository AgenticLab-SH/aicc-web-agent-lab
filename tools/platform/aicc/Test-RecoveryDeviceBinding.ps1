#requires -Version 7.5
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$modulePath=Join-Path $PSScriptRoot 'Recovery-DeviceBinding.psm1'
$module=Import-Module -Name $modulePath -Force -PassThru
$script:passed=0
function Digest([string]$Text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()}
function Clone($Value){$Value|ConvertTo-Json -Depth 30 -Compress|ConvertFrom-Json -DateKind String}
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
$now=[DateTimeOffset]::UtcNow
$device='11111111-1111-4111-8111-111111111111'
$machine=@{computerName='fixture-machine';machineGuidSha256=('a'*64);ownerSid='fixture-owner'}
$hostPin=@{pid=9876;parentPid=10;createdTicks='1000';image='C:\fixture\rdc.exe';imageSha256=('b'*64);commandSha256=('c'*64)}
$child=@{pid=1234;parentPid=3456;createdTicks='3000';image='C:\fixture\pwsh.exe';imageSha256=('d'*64);commandSha256=('e'*64)}
$shell=@{pid=3456;parentPid=9876;createdTicks='2000';image='C:\fixture\powershell.exe';imageSha256=('f'*64);commandSha256=('1'*64)}
$challenge=Clone ([ordered]@{schema='aicc-rdc-device-challenge/v1';deviceId=$device;linkId='link_fixture';nonce=('2'*32);createdAt=$now.AddSeconds(-2).ToString('o');expiresAt=$now.AddMinutes(14).ToString('o');machine=$machine;rdcHost=$hostPin;module=@{path=$modulePath;sha256=(Get-FileHash -LiteralPath $modulePath -Algorithm SHA256).Hash.ToLowerInvariant()};powershell=@{path='C:\fixture\pwsh.exe';sha256=('d'*64)}})
$challengeHash=Digest ($challenge|ConvertTo-Json -Depth 30 -Compress)
$challengePath=Join-Path $env:TEMP 'fixture-device-challenge-not-created.json'
$command=Get-AiccRecoveryDeviceProbeCommand -ChallengePath $challengePath -ChallengeSha256 $challengeHash -PowerShellPath $challenge.powershell.path
$probe=[ordered]@{schema='aicc-rdc-device-probe/v1';deviceId=$device;nonce=$challenge.nonce;challengeSha256=$challengeHash;machine=$machine;rdcHost=$hostPin;ancestry=@($child,$shell,$hostPin);observedAt=$now.AddSeconds(-1).ToString('o');runtimeChanged=$false}
function Envelope([string]$Tool,$Arguments,[string]$Text){@{schemaVersion=1;source='RDC official MCP';tool=$Tool;observedAt=$now.AddMilliseconds(-100).ToString('o');arguments=$Arguments;response=@{content=@(@{type='text';text=$Text});isError=$false}}}
$footer='[executed on device: fixture ('+$device+')]'
$candidate=Clone @{schema='aicc-rdc-device-registration/v1';deviceId=$device;challengePath=$challengePath;challengeSha256=$challengeHash;challenge=$challenge;probeCommand=$command;evidence=@{
 list=(Envelope 'list_devices' @{link_id='link_fixture'} ("Desktop Commander devices`n`n1. fixture`n   Status: Online`n   ID: "+$device+"`n   Last seen: now"))
 start=(Envelope 'start_process' @{link_id='link_fixture';deviceId=$device;command=$command} ("Process started with PID 3456 (shell: powershell.exe)`nInitial output:`n"+$footer))
 output=(Envelope 'read_process_output' @{link_id='link_fixture';pid=3456} ((($probe|ConvertTo-Json -Depth 15 -Compress)+"`n"+$footer)))
};sealedAt=$now.ToString('o');authority='existing_registered_device_exact_host_attestation';runtimeChanged=$false}
function Verify($Value,$ExpectedMachine=$machine,$ExpectedHost=$hostPin,[DateTimeOffset]$At=[DateTimeOffset]::UtcNow){
  & $module {param($Value,$ExpectedMachine,$ExpectedHost,$At) BindingProof $Value $ExpectedMachine $ExpectedHost $At} $Value $ExpectedMachine $ExpectedHost $At
}
function Pass([string]$Name,[scriptblock]$Check){& $Check;$script:passed++;Write-Output ('PASS '+$Name)}
function Deny([string]$Name,[scriptblock]$Change){$value=Clone $candidate;& $Change $value;$denied=$false;try{$null=Verify $value}catch{$denied=$true};Require $denied ('Unsafe proof accepted: '+$Name);$script:passed++;Write-Output ('PASS rejects '+$Name)}
function RewriteProbe($Value,[scriptblock]$Change){$p=($Value.evidence.output.response.content[0].text -split '\r?\n')[0]|ConvertFrom-Json -DateKind String;& $Change $p;$Value.evidence.output.response.content[0].text=($p|ConvertTo-Json -Depth 15 -Compress)+"`n"+$footer}
Pass 'exact official proof with machine, current host, transport PID and contiguous ancestry' {$valid=Verify $candidate;Require ($valid.deviceId -ceq $device) 'Wrong valid device'}
Deny 'foreign account evidence' {param($v)$v.evidence.list.arguments.link_id='link_foreign'}
Deny 'offline device' {param($v)$v.evidence.list.response.content[0].text=$v.evidence.list.response.content[0].text.Replace('Status: Online','Status: Offline')}
Deny 'duplicate device registration' {param($v)$v.evidence.list.response.content[0].text+="`n2. duplicate`n Status: Online`n ID: "+$device}
Deny 'foreign device argument' {param($v)$v.evidence.start.arguments.deviceId='22222222-2222-4222-8222-222222222222'}
Deny 'foreign transport device' {param($v)$v.evidence.start.response.content[0].text=$v.evidence.start.response.content[0].text.Replace($device,'22222222-2222-4222-8222-222222222222')}
Deny 'non-official envelope' {param($v)$v.evidence.start.source='synthetic'}
Deny 'missing process ACK' {param($v)$v.evidence.start.response.content[0].text=$footer}
Deny 'output process mismatch' {param($v)$v.evidence.output.arguments.pid=999}
Deny 'ACK outside exact ancestry' {param($v)$v.evidence.start.response.content[0].text=$v.evidence.start.response.content[0].text.Replace('PID 3456','PID 999');$v.evidence.output.arguments.pid=999}
Deny 'changed read-only command' {param($v)$v.evidence.start.arguments.command+='; echo unexpected'}
Deny 'changed challenge bytes' {param($v)$v.challenge.nonce=('3'*32)}
Deny 'changed binding module' {param($v)$v.challenge.module.sha256=('0'*64)}
Deny 'wrong challenge nonce' {param($v)RewriteProbe $v {param($p)$p.nonce=('3'*32)}}
Deny 'wrong host generation' {param($v)RewriteProbe $v {param($p)$p.rdcHost.createdTicks='999'}}
Deny 'wrong machine identity' {param($v)RewriteProbe $v {param($p)$p.machine.machineGuidSha256=('0'*64)}}
Deny 'broken ancestry' {param($v)RewriteProbe $v {param($p)$p.ancestry[0].parentPid=999}}
Deny 'reused PID before parent creation' {param($v)RewriteProbe $v {param($p)$p.ancestry[0].createdTicks='999'}}
Deny 'repeated ancestor PID' {param($v)RewriteProbe $v {param($p)$p.ancestry[0].pid=$p.ancestry[1].pid}}
Deny 'future official evidence' {param($v)$v.evidence.list.observedAt=[DateTimeOffset]::UtcNow.AddHours(1).ToString('o')}
Deny 'proof before challenge' {param($v)$v.evidence.output.observedAt=$now.AddMinutes(-1).ToString('o')}
Pass 'expired registration rejected independently of immutable bytes' {$denied=$false;try{$null=Verify $candidate $machine $hostPin $now.AddMinutes(16)}catch{$denied=$true};Require $denied 'Expired registration accepted'}
Pass 'changed expected host rejected' {$different=Clone $hostPin;$different.pid=999;$denied=$false;try{$null=Verify $candidate $machine $different}catch{$denied=$true};Require $denied 'Different live host accepted'}
Pass 'original exact device remains compatible without migration' {Assert-AiccRecoveryDeviceMetadata -Metadata ([pscustomobject]@{deviceId='32002de6-dd98-4da6-9423-7d1032bfec6e'})}
Pass 'new device without registration remains refused' {$denied=$false;try{Assert-AiccRecoveryDeviceMetadata -Metadata ([pscustomobject]@{deviceId=$device})}catch{$denied=$true};Require $denied 'Unregistered device accepted'}
Pass 'caller registration SHA256 is checked before host access' {$denied=$false;try{$null=Get-AiccRecoveryDeviceRegistration -Path $modulePath -Sha256 ('0'*64) -DeviceId $device -RdcHost $hostPin}catch{$denied=$true};Require $denied 'Wrong caller SHA256 accepted'}
Pass 'probe command is literal, read-only and caller-bound' {Require ($command.Contains('Get-AiccRecoveryDeviceProbe -ChallengePath') -and $command.Contains($challengeHash) -and -not $command.Contains('EncodedCommand')) 'Probe command differs'}
Pass 'local preview creates only a challenge and refuses overwrite' {
  $previewPath=Join-Path ([Environment]::GetFolderPath('UserProfile')) ('.codex\ops\webgpt-remote-recovery\device-registrations\fixture-'+[guid]::NewGuid().ToString('N')+'\challenge.json')
  $preview=New-AiccRecoveryDeviceChallenge -Path $previewPath -DeviceId $device -LinkId 'link_fixture' -RdcHostPid $PID -Minutes 1
  Require ($preview.state -ceq 'CHALLENGE_ONLY_NOT_REGISTERED' -and -not $preview.runtimeChanged) 'Preview promoted a device'
  Require ((Get-FileHash -LiteralPath $previewPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $preview.challengeSha256) 'Preview SHA mismatch'
  $denied=$false;try{$null=New-AiccRecoveryDeviceChallenge -Path $previewPath -DeviceId $device -LinkId 'link_fixture' -RdcHostPid $PID -Minutes 1}catch{$denied=$true};Require $denied 'Existing challenge overwritten'
  Require (-not(Test-Path -LiteralPath ($previewPath+'.registration-claim.json'))) 'Preview consumed registration'
}
@{schema='aicc-rdc-device-binding-fixture/v1';state='PASS';passed=$script:passed;actualRdcStarted=$false;registeredDeviceChanged=$false;servicesChanged=$false}|ConvertTo-Json -Compress
