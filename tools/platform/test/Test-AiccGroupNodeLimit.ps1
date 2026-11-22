#requires -Version 7.5
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../windows/CodexContinuityGroupInstall.ps1')
function Maintenance-Hash([string]$File){(Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant()}
$root=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$file=Join-Path $root ('aicc-node-size-'+[guid]::NewGuid().ToString('N')+'.fake')
if([IO.Path]::GetDirectoryName($file) -ine $root.TrimEnd([IO.Path]::DirectorySeparatorChar)){throw 'fixture_scope'}
$checks=0
function Refuse([scriptblock]$Action,[string]$Reason){
 $seen=$false
 try{& $Action}catch{if($_.Exception.Message -ceq $Reason){$seen=$true}else{throw}}
 if(-not $seen){throw 'missing_refusal'}
 $script:checks++
}
try{
 $s=[IO.File]::Open($file,'CreateNew','Write','None')
 try{$s.SetLength(67108865)}finally{$s.Dispose()}
 $sha=Maintenance-Hash $file
 Refuse {GroupInstall-SafeFile $file $root $sha} 'group_installer_file_changed'
 GroupInstall-SafeFile $file $root $sha 134217728;$checks++
 Refuse {GroupInstall-SafeFile $file $root ('0'*64) 134217728} 'group_installer_file_changed'
 Refuse {GroupInstall-SafeFile $file $root $sha 2147483647} 'group_installer_file_limit_invalid'
 $s=[IO.File]::Open($file,'Open','Write','None')
 try{$s.SetLength(134217729)}finally{$s.Dispose()}
 Refuse {GroupInstall-SafeFile $file $root $sha 134217728} 'group_installer_file_changed'
 @{terminal='PASS';checks=$checks;runtimeChanges=0;modelRequests=0}|ConvertTo-Json -Compress
}finally{if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force}}
