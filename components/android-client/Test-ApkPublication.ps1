# Offline contract regression; no key generation, signing, publishing or phone I/O.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Assert-ApkPublication.ps1')
$script:passed=0
function Refuses([scriptblock]$Case){
 $denied=$false
 try{& $Case}catch{$denied=$true}
 if(!$denied){throw 'Expected publication refusal missing'}
 $script:passed++
}
Assert-AiccApkSigningIdentity $false $false $false
Assert-AiccApkSigningIdentity $true $true $true
$script:passed+=2
Refuses {Assert-AiccApkSigningIdentity $false $true $false}
Refuses {Assert-AiccApkSigningIdentity $true $false $true}
Refuses {Assert-AiccApkSigningIdentity $false $false $true}
function Metadata { @{applicationId='com.agenticfabworks.aicc.mobile';elements=@(@{versionCode=2;versionName='0.2.0'})} }
function Previous { @{packageName='com.agenticfabworks.aicc.mobile';versionCode=1;certificateSha256=('a'*64)} }
$badging="package: name='com.agenticfabworks.aicc.mobile' versionCode='2' versionName='0.2.0'"
Assert-AiccApkPublication (Metadata) $badging ('a'*64) (Previous)
$script:passed++
Refuses {Assert-AiccApkPublication (Metadata) ($badging.Replace("versionCode='2'","versionCode='3'")) ('a'*64) (Previous)}
Refuses {Assert-AiccApkPublication (Metadata) ($badging.Replace('com.agenticfabworks.aicc.mobile','foreign.package')) ('a'*64) (Previous)}
Refuses {Assert-AiccApkPublication (Metadata) ($badging+"`napplication-debuggable") ('a'*64) (Previous)}
Refuses {Assert-AiccApkPublication (Metadata) $badging ('b'*64) (Previous)}
Refuses {$m=Metadata;$m.elements[0].versionCode='2';Assert-AiccApkPublication $m $badging ('a'*64) (Previous)}
Refuses {$old=Previous;$old.versionCode=2;Assert-AiccApkPublication (Metadata) $badging ('a'*64) $old}
Refuses {$old=Previous;$old.packageName='foreign.package';Assert-AiccApkPublication (Metadata) $badging ('a'*64) $old}
Refuses {$old=Previous;$old.versionCode='1';Assert-AiccApkPublication (Metadata) $badging ('a'*64) $old}
@{state='PASS';checks=$script:passed;scope='offline publication contract';keyGeneration=0;publications=0}|ConvertTo-Json -Compress
