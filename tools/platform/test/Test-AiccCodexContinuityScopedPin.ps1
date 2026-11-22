#requires -Version 7.5
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../windows/CodexContinuityCliPin.psm1') -Force
$module=Get-Module CodexContinuityCliPin
$old='a'*64;$new='b'*64;$other='c'*64;$passed=0
function Replace-Pin([string]$Text){
 $raw=[Text.Encoding]::UTF8.GetBytes($Text)
 $changed=& $module {param($bytes,$oldHash,$newHash)New-PinRegistryBytes $bytes $oldHash $newHash} $raw $old $new
 [Text.Encoding]::UTF8.GetString([byte[]]$changed)
}
function Check([bool]$Ok,[string]$Name){if(-not $Ok){throw ('FAIL '+$Name)};$script:passed++}
function Reject-Pin([string]$Text){$rejected=$false;try{Replace-Pin $Text|Out-Null}catch{$rejected=$true};Check $rejected 'invalid exact pin rejected'}
$s='{ "한글":"보존", "codexSha256" : "'+$old+'" }';Check ((Replace-Pin $s) -ceq $s.Replace($old,$new)) 'UTF8 byte offsets'
$s='{"codexSha256":"'+$old+'","strictRouteLauncher":{"codexSha256":"'+$old+'"},"threads":{"history":{"codexSha256":"'+$old+'"}}}'
$expected='{"codexSha256":"'+$new+'","strictRouteLauncher":{"codexSha256":"'+$new+'"},"threads":{"history":{"codexSha256":"'+$old+'"}}}'
$after=Replace-Pin $s;Check ($after -ceq $expected) 'only current top and strict pin change'
$reverse=& $module {param($bytes,$oldHash,$newHash)New-PinRegistryBytes $bytes $newHash $oldHash} ([Text.Encoding]::UTF8.GetBytes($after)) $old $new
Check ([Text.Encoding]::UTF8.GetString([byte[]]$reverse) -ceq $s) 'all bytes reverse exactly in memory'
$s='{"threads":{"strictRouteLauncher":{"codexSha256":"'+$old+'"}},"codexSha256":"'+$old+'"}'
Check ((Replace-Pin $s) -ceq ('{"threads":{"strictRouteLauncher":{"codexSha256":"'+$old+'"}},"codexSha256":"'+$new+'"}')) 'nested history untouched'
Reject-Pin ('{"codexSha256":"'+$old+'","codexSha256":"'+$old+'"}')
Reject-Pin ('{"codexSha256":"'+$old+'","strictRouteLauncher":{},"strictRouteLauncher":{}}')
Reject-Pin ('{"codexSha256":"'+$old+'","strictRouteLauncher":{"codexSha256":"'+$old+'","codexSha256":"'+$old+'"}}')
Reject-Pin ('{"codexSha256":"'+$other+'"}')
Reject-Pin ('{"codexSha256":"'+$old+'","strictRouteLauncher":{"codexSha256":"'+$other+'"}}')
Reject-Pin ('{"threads":{"codexSha256":"'+$old+'"}}')
Reject-Pin ('{"codexSha256":"'+$old+'","strictRouteLauncher":{"schemaVersion":1}}')
Reject-Pin ('{"codexSha256":"'+$old+'","strictRouteLauncher":null}')
Reject-Pin ('{"codexSha256":"\u0061'+('a'*63)+'"}')
Reject-Pin ('{"codexSha256":"'+$old+'"')
Reject-Pin ('{"codexSha256":"'+$old+'"}{"x":1}')
$raw=[Text.Encoding]::UTF8.GetBytes('{"codexSha256":"'+$old+'"}');$copy=[byte[]]$raw.Clone()
& $module {param($bytes,$oldHash,$newHash)New-PinRegistryBytes $bytes $oldHash $newHash} $raw $old $new|Out-Null
Check ([Linq.Enumerable]::SequenceEqual([byte[]]$raw,[byte[]]$copy)) 'input bytes untouched'
@{passed=$passed;failed=0;scope='pure scoped bytes, no live registry or model/account access'}|ConvertTo-Json -Compress