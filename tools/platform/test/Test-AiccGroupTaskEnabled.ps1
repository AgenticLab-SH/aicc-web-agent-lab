#requires -Version 7.5
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../windows/CodexContinuityGroupInstall.ps1')
$checks=0
foreach($value in @('','<Enabled>true</Enabled>','<Enabled>false</Enabled>')){
 $before='<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings>'+$value+'</Settings><Actions><Exec><Command>old.exe</Command><Arguments>old</Arguments><WorkingDirectory>C:\old</WorkingDirectory></Exec></Actions></Task>'
 $after=[xml](GroupInstall-TaskXml $before 'C:\new\worker.hidden.vbs' 'C:\new' 'C:\Windows\System32\wscript.exe')
 $enabled=@($after.SelectNodes('/*[local-name()="Task"]/*[local-name()="Settings"]/*[local-name()="Enabled"]'))
 if($enabled.Count -ne 1 -or $enabled[0].InnerText -cne 'false'){throw 'disabled_task_not_explicit'}
 $checks++
}
$refused=$false
try{GroupInstall-TaskXml '<Task><Actions><Exec><Command>x</Command><Arguments>x</Arguments><WorkingDirectory>x</WorkingDirectory></Exec></Actions></Task>' 'x' 'x' 'x'|Out-Null}catch{if($_.Exception.Message -ceq 'task_settings_preimage_required'){$refused=$true}else{throw}}
if(-not $refused){throw 'missing_settings_accepted'}
$checks++
@{terminal='PASS';checks=$checks;runtimeChanges=0;modelRequests=0}|ConvertTo-Json -Compress
