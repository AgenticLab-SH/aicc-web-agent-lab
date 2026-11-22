#requires -Version 7.5
# Install only the bounded recovery tool, never a service/task or candidate dashboard.
[CmdletBinding()]param([switch]$Apply,[string]$ExpectedPreviewSha256)
$ErrorActionPreference='Stop'
$owner=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$source=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$files=@('tools/platform/workspace-mcp/Watch-AiccHostRuntimeRecovery.ps1','tools/platform/windows/MobilePublicRecovery.psm1','tools/platform/windows/Request-AiccMobilePublicRecovery.ps1','tools/platform/windows/Restore-AiccMobilePublicRuntime.ps1','tools/platform/windows/MobilePublicTransition.psm1','tools/platform/windows/Update-AiccMobileRecoveryPlan.ps1')
$pins=@(foreach($r in $files){$f=Join-Path $source $r;if((Get-Item -LiteralPath $f).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'recovery_source_link_denied'};@{path=$r;sha256=(Get-FileHash -LiteralPath $f).Hash.ToLowerInvariant()}})
$signature=($pins|ForEach-Object {$_.path+':'+$_.sha256}) -join "`n"
$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($signature))).ToLowerInvariant()
$root=Join-Path $owner ('releases/mobile-public-recovery/'+$hash.Substring(0,16))
$control=Join-Path $owner 'control-plane/mobile-public-recovery';$current=Join-Path $control 'current.json'
$old=if(Test-Path -LiteralPath $current){(Get-FileHash -LiteralPath $current).Hash.ToLowerInvariant()}else{'ABSENT'}
$preview=@{schemaVersion=1;action='install-bounded-mobile-recovery';sourceSignature=$hash;previousRegistrySha256=$old;releaseRoot=$root;files=$pins;changes='immutable recovery tools+current registry only; no service/task/start/model/stop'}
$json=$hash+"|"+$old+"|"+$root
$digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json))).ToLowerInvariant()
if(-not $Apply){@{preview=$preview;previewSha256=$digest}|ConvertTo-Json -Depth 10;return}
if($ExpectedPreviewSha256 -cne $digest){throw 'fresh_recovery_install_preview_required'}
New-Item -ItemType Directory -Path $control -Force|Out-Null
$lock=[IO.File]::Open((Join-Path $control 'install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
$now=if(Test-Path -LiteralPath $current){(Get-FileHash -LiteralPath $current).Hash.ToLowerInvariant()}else{'ABSENT'}
if($now -cne $old){throw 'recovery_install_registry_cas_changed'}
$backup=Join-Path $owner ('backups/mobile-recovery-install-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $backup|Out-Null
if($old -cne 'ABSENT'){Copy-Item -LiteralPath $current -Destination (Join-Path $backup 'current.before.json')}
foreach($pin in $pins){$f=Join-Path $source $pin.path;$dest=Join-Path $root $pin.path;if((Get-FileHash -LiteralPath $f).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'recovery_source_changed'}
New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force|Out-Null
if(Test-Path -LiteralPath $dest){if((Get-FileHash -LiteralPath $dest).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'recovery_immutable_release_changed'}}else{[IO.File]::Copy($f,$dest,$false)}
if((Get-FileHash -LiteralPath $dest).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'recovery_install_readback_failed'}}
$manifest=Join-Path $root 'manifest.json';$m=@{schemaVersion=1;component='mobile-public-recovery';sourceSignature=$hash;files=$pins;moduleSha256=($pins|Where-Object path -CEQ 'tools/platform/windows/MobilePublicRecovery.psm1').sha256}
$utf8=[Text.UTF8Encoding]::new($false)
if(-not(Test-Path -LiteralPath $manifest)){[IO.File]::WriteAllText($manifest,($m|ConvertTo-Json -Depth 8),$utf8)}
$actual=Get-Content -LiteralPath $manifest -Raw|ConvertFrom-Json
if($actual.sourceSignature -cne $hash -or $actual.files.Count -ne $pins.Count){throw 'recovery_manifest_collision'}
foreach($pin in $pins){$same=@($actual.files|Where-Object path -CEQ $pin.path);if($same.Count -ne 1 -or $same[0].sha256 -cne $pin.sha256){throw 'recovery_manifest_collision'}}
$reg=@{schemaVersion=1;manifestFile=$manifest;manifestSha256=(Get-FileHash -LiteralPath $manifest).Hash.ToLowerInvariant();entry=Join-Path $root 'tools/platform/workspace-mcp/Watch-AiccHostRuntimeRecovery.ps1';backup=$backup;installedAt=[DateTimeOffset]::UtcNow.ToString('o')}
$temp=Join-Path $backup 'current.new.json';[IO.File]::WriteAllText($temp,($reg|ConvertTo-Json -Depth 6),$utf8)
$now=if(Test-Path -LiteralPath $current){(Get-FileHash -LiteralPath $current).Hash.ToLowerInvariant()}else{'ABSENT'}
if($now -cne $old){throw 'recovery_install_final_cas_changed'}
[IO.File]::Move($temp,$current,$true)
@{state='INSTALLED_NOT_STARTED';registry=$current;registrySha256=(Get-FileHash -LiteralPath $current).Hash.ToLowerInvariant();entry=$reg.entry;releaseRoot=$root;backup=$backup;files=$pins;tasksChanged=0;servicesStarted=0}|ConvertTo-Json -Depth 8
}finally{$lock.Dispose()}
