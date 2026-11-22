#requires -Version 7.5
[CmdletBinding()]
param([ValidateSet('Read','Store')][string]$Action,[ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$')][string]$Profile,[switch]$Commit)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$root=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.desktop-commander-device'
$profiles=Join-Path $root 'profiles'
function Decode($p){[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($p),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))}
function Atomic($p,$bytes){$tmp=$p+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllBytes($tmp,$bytes);Move-Item -LiteralPath $tmp -Destination $p -Force}
try{
 $file=Join-Path $profiles ($Profile+'.dpapi')
 if($Action -eq 'Read'){[Console]::Write((Decode $file));return}
 $raw=[Console]::In.ReadToEnd();$value=$raw|ConvertFrom-Json
 if(-not $value.deviceId -or -not $value.session.access_token -or -not $value.session.refresh_token){throw 'Incomplete profile'}
 $bytes=[Text.Encoding]::UTF8.GetBytes($raw);$sealed=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 Atomic $file $sealed
 foreach($alias in @(Get-ChildItem -LiteralPath $profiles -Filter '*.dpapi' -File)){
  if(((Decode $alias.FullName)|ConvertFrom-Json).deviceId -ceq $value.deviceId){Atomic $alias.FullName $sealed}
 }
 if($Commit){Atomic (Join-Path $root 'device.json') $bytes}
 [Console]::Write('{"stored":true}')
}catch{[Console]::Error.Write('RDC_PROFILE_STORE_FAILED');exit 1}