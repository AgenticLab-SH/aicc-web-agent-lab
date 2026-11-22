#requires -Version 7.5
[CmdletBinding()]param([Parameter(Mandatory)][string]$JavaHome,[Parameter(Mandatory)][string]$AndroidSdk)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($PSScriptRoot)
. (Join-Path $root 'Assert-ApkPublication.ps1')
$unsigned=Join-Path $root 'app/build/outputs/apk/release/app-release-unsigned.apk'
$metadata=Get-Content -LiteralPath (Join-Path $root 'app/build/outputs/apk/release/output-metadata.json') -Raw|ConvertFrom-Json
if($metadata.applicationId -cne 'com.agenticfabworks.aicc.mobile' -or $metadata.elements.Count -ne 1){throw 'Exact APK identity required'}
$private=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center/android-client/signing'
$destination=[IO.Path]::GetFullPath((Join-Path $root '../../public/downloads'))
$target=Join-Path $destination 'aicc-mobile.apk'
$info=Join-Path $destination 'aicc-mobile.json'
if((Test-Path -LiteralPath $info) -ne (Test-Path -LiteralPath $target)){throw 'Incomplete published APK pair; preserve and reconcile before publishing'}
$key=Join-Path $private 'aicc-mobile.p12';$password=Join-Path $private 'password.dpapi'
Assert-AiccApkSigningIdentity -KeyExists (Test-Path -LiteralPath $key) -PasswordExists (Test-Path -LiteralPath $password) -PublishedExists ((Test-Path -LiteralPath $info) -or (Test-Path -LiteralPath $target))
[void][IO.Directory]::CreateDirectory($private)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $private -AclObject $acl
try{
 if(!(Test-Path -LiteralPath $key) -and !(Test-Path -LiteralPath $password)){
  $new=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  ConvertTo-SecureString $new -AsPlainText -Force|ConvertFrom-SecureString|Set-Content -LiteralPath $password -Encoding utf8NoBOM
 }
 $secure=(Get-Content -LiteralPath $password -Raw).Trim()|ConvertTo-SecureString
 $env:AICC_APK_SIGN_PASSWORD=[Net.NetworkCredential]::new('unused',$secure).Password
 if(!(Test-Path -LiteralPath $key)){
  & (Join-Path $JavaHome 'bin/keytool.exe') -genkeypair -keystore $key -storetype PKCS12 -storepass:env AICC_APK_SIGN_PASSWORD -alias aicc-mobile -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=AICC Mobile' 2>&1|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Signing key generation failed; preserve partial identity'}
 }
 [void][IO.Directory]::CreateDirectory($destination)
 $temporary=Join-Path $private ('signed-'+[guid]::NewGuid().ToString('N')+'.apk')
 $jar=Join-Path $AndroidSdk 'build-tools/36.0.0/lib/apksigner.jar'
 & (Join-Path $JavaHome 'bin/java.exe') -jar $jar sign --ks $key --ks-key-alias aicc-mobile --ks-pass env:AICC_APK_SIGN_PASSWORD --out $temporary $unsigned
 if($LASTEXITCODE -ne 0){throw 'APK signing failed'}
 $verified=& (Join-Path $JavaHome 'bin/java.exe') -jar $jar verify --verbose --print-certs $temporary
 if($LASTEXITCODE -ne 0){throw 'APK signature verification failed'}
 $certificate=[regex]::Match(($verified -join "`n"),'Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})').Groups[1].Value
 if(!$certificate){throw 'Signing certificate proof missing'}
 $badging=& (Join-Path $AndroidSdk 'build-tools/36.0.0/aapt.exe') dump badging $temporary
 if($LASTEXITCODE -ne 0){throw 'Signed APK package inspection failed'}
 $old=if(Test-Path -LiteralPath $info){Get-Content -LiteralPath $info -Raw|ConvertFrom-Json}else{$null}
 Assert-AiccApkPublication -Metadata $metadata -Badging ($badging -join "`n") -Certificate $certificate -Previous $old
 if(Test-Path -LiteralPath $info){
  $backup=Join-Path $private ('previous-'+$old.versionCode)
  [void][IO.Directory]::CreateDirectory($backup)
  Copy-Item -LiteralPath $info -Destination $backup
  if(Test-Path -LiteralPath $target){Copy-Item -LiteralPath $target -Destination $backup}
 }
 Copy-Item -LiteralPath $temporary -Destination $target -Force
 @{schemaVersion=1;packageName=$metadata.applicationId;versionCode=$metadata.elements[0].versionCode;versionName=$metadata.elements[0].versionName;sha256=(Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $target).Length;certificateSha256=$certificate;download='/downloads/aicc-mobile.apk';signed=$true;debuggable=$false;createdAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $info -Encoding utf8NoBOM
 Get-Content -LiteralPath $info
}finally{Remove-Item Env:\AICC_APK_SIGN_PASSWORD -ErrorAction SilentlyContinue}
