#requires -Version 7.5
$ErrorActionPreference='Stop'
$source=Join-Path (Split-Path $PSScriptRoot -Parent) 'tools/platform/opencodex/Invoke-AiccOcxTransition.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Transition syntax invalid'}
$helper=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Test-OwnedOcxProcess'},$true))
if($helper.Count -ne 1){throw 'Shared launcher lifecycle owner helper missing'}
. ([scriptblock]::Create($helper[0].Extent.Text))
$root=Join-Path ([IO.Path]::GetTempPath()) 'aicc owner fixture'
$cli=Join-Path $root 'external-runtime.ts'
$wrapper=Join-Path $root 'service.cmd';$launcher=Join-Path $root 'service.vbs'
$shared=Join-Path $root 'original-issuer-shared-launcher.exe'
$checks=0
function Check($Process,[bool]$Expected){
 if((Test-OwnedOcxProcess $Process $cli $wrapper $launcher) -cne $Expected){throw ('Owner classification mismatch: '+$Process.Name)}
 $script:checks++
}
Check ([pscustomobject]@{Name='bun.exe';ExecutablePath='C:\fixture\bun.exe';CommandLine=('bun "'+$cli+'"')}) $true
Check ([pscustomobject]@{Name='cmd.exe';ExecutablePath='C:\Windows\System32\cmd.exe';CommandLine=('cmd /c "'+$wrapper+'"')}) $true
Check ([pscustomobject]@{Name='wscript.exe';ExecutablePath='C:\Windows\System32\wscript.exe';CommandLine=('wscript "'+$launcher+'"')}) $true
Check ([pscustomobject]@{Name='original-issuer-shared-launcher.exe';ExecutablePath=$shared;CommandLine=('"'+$shared+'" --run')}) $true
Check ([pscustomobject]@{Name='original-issuer-shared-launcher.exe';ExecutablePath=$shared;CommandLine=('"'+$shared+'" --check')}) $false
Check ([pscustomobject]@{Name='original-issuer-shared-launcher.exe';ExecutablePath=$shared;CommandLine=('"'+$shared+'" --run --extra')}) $false
Check ([pscustomobject]@{Name='original-issuer-shared-launcher.exe';ExecutablePath=($shared+'.foreign');CommandLine=('"'+$shared+'" --run')}) $false
Check ([pscustomobject]@{Name='original-issuer-shared-launcher.exe';ExecutablePath=$shared;CommandLine=('foreign.exe "'+$shared+'" --run')}) $false
Check ([pscustomobject]@{Name='original-issuer-shared-launcher.exe';ExecutablePath=$null;CommandLine=('"'+$shared+'" --run')}) $false
Check ([pscustomobject]@{Name='codex.exe';ExecutablePath='C:\fixture\codex.exe';CommandLine=$cli}) $false
Check ([pscustomobject]@{Name='bun.exe';ExecutablePath='C:\fixture\bun.exe';CommandLine='unrelated.ts'}) $false
$owned=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Owned'},$true))
if($owned.Count -ne 1){throw 'Unique owner enumeration required'}
. ([scriptblock]::Create($owned[0].Extent.Text))
$wrapperFile=$wrapper;$launcherFile=$launcher
function Get-CimInstance {
 @([pscustomobject]@{Name='original-issuer-shared-launcher.exe';ExecutablePath=$shared;CommandLine=('"'+$shared+'" --run')},
   [pscustomobject]@{Name='original-issuer-shared-launcher.exe';ExecutablePath=$shared;CommandLine=('"'+$shared+'" --check')},
   [pscustomobject]@{Name='bun.exe';ExecutablePath='C:\fixture\bun.exe';CommandLine=('bun "'+$cli+'"')})
}
$selected=@(Owned $cli)
if($selected.Count -ne 2 -or @($selected|Where-Object Name -eq 'original-issuer-shared-launcher.exe').Count -ne 1){throw 'Lifecycle enumeration failed to retain exact shared host'}
$checks++
@{state='PASS';checks=$checks;scope='Pure owner classification; no process stop, start or registry mutation'}|ConvertTo-Json -Compress
