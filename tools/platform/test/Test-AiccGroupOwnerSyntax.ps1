#requires -Version 7.5
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$paths=@(
 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1',
 'tools/platform/windows/CodexContinuityGroupOwner.ps1',
 'tools/platform/windows/CodexContinuityGroupInstall.ps1',
 'tools/platform/windows/CodexContinuityMaintenance.psm1',
 'tools/platform/windows/Install-AiccCodexContinuity.ps1'
)
$checks=0
foreach($p in $paths){
 $errors=$null;$tokens=$null
 $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root $p),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw ('PowerShell parser error at '+$p+': '+($errors|Select-Object -First 1).Message)}
 $checks++
}
Import-Module (Join-Path $root 'tools/platform/windows/CodexContinuityMaintenance.psm1') -Force
$names=@(Get-Command -Module CodexContinuityMaintenance|Select-Object -ExpandProperty Name)
foreach($name in @('New-AiccGroupOwnerInstallPlan','Invoke-AiccGroupOwnerInstallPlan','Undo-AiccGroupOwnerInstallPlan')){
 if($name -cnotin $names){throw ('group installer entry missing:'+ $name)}
 $checks++
}
@{terminal='PASS';checks=$checks;runtimeChanges=0;modelRequests=0}|ConvertTo-Json -Compress
