#requires -Version 7.5
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../windows/CodexContinuityGroupInstall.ps1')
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User.Value
$checks=0
foreach($name in @($sid,$identity.Name,($identity.Name -split '\\')[-1])){
 if((GroupInstall-TaskOwnerSid $name) -cne $sid){throw 'same_owner_not_resolved'}
 $checks++
}
if((GroupInstall-TaskOwnerSid 'S-1-5-18') -ceq $sid){throw 'foreign_owner_accepted'}
$checks++
foreach($name in @('', 'S-1-invalid', 'AiccMissingOwner_7d853c11')){
 $refused=$false
 try{GroupInstall-TaskOwnerSid $name|Out-Null}catch{if($_.Exception.Message -ceq 'task_owner_identity_unresolved'){$refused=$true}else{throw}}
 if(-not $refused){throw 'unresolved_owner_accepted'}
 $checks++
}
@{terminal='PASS';checks=$checks;taskChanges=0;modelRequests=0}|ConvertTo-Json -Compress
