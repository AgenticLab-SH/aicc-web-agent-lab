#requires -Version 5.1
$ErrorActionPreference='Stop'
$source=Join-Path (Split-Path $PSScriptRoot -Parent) 'tools/platform/opencodex/Invoke-AiccOcxTransition.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Transition parse failed'}
$functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'PrepareOriginalIssuerSocketDirectory'},$true))
if($functions.Count -ne 1){throw 'Exact production helper required'}
. ([scriptblock]::Create($functions[0].Extent.Text))
$serviceHome=Join-Path ([IO.Path]::GetTempPath()) ('aicc-private-directory-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($serviceHome)
$path=Join-Path $serviceHome 'oi'
$checks=0
PrepareOriginalIssuerSocketDirectory
$checks++
$before=(Get-Acl -LiteralPath $path).Sddl
PrepareOriginalIssuerSocketDirectory
if((Get-Acl -LiteralPath $path).Sddl -cne $before){throw 'Valid existing ACL changed'}
$checks++
$inherited=Join-Path $serviceHome 'inherited';[void][IO.Directory]::CreateDirectory($inherited)
$oldHome=$serviceHome;$serviceHome=$inherited
$unsafe=Join-Path $serviceHome 'oi';[void][IO.Directory]::CreateDirectory($unsafe)
$unsafeBefore=(Get-Acl -LiteralPath $unsafe).Sddl
$refused=$false
try{PrepareOriginalIssuerSocketDirectory}catch{$refused=$_.Exception.Message -match 'private DACL|DACL differs'}
if(-not $refused -or (Get-Acl -LiteralPath $unsafe).Sddl -cne $unsafeBefore){throw 'Unsafe existing ACL accepted or repaired'}
$checks++
$fileHome=Join-Path $oldHome 'file';[void][IO.Directory]::CreateDirectory($fileHome)
$serviceHome=$fileHome;[IO.File]::WriteAllText((Join-Path $fileHome 'oi'),'preserve')
$refused=$false
try{PrepareOriginalIssuerSocketDirectory}catch{$refused=$_.Exception.Message -match 'regular private directory'}
if(-not $refused -or [IO.File]::ReadAllText((Join-Path $fileHome 'oi')) -cne 'preserve'){throw 'Existing file not preserved'}
$checks++
$body=[IO.File]::ReadAllText($source)
$preflight=$body.IndexOf("`nPrepareOriginalIssuerSocketDirectory`n")
if($preflight -lt 0){$preflight=$body.IndexOf("`nPrepareOriginalIssuerSocketDirectory`r`n")}
if($preflight -lt 0 -or $preflight -gt $body.LastIndexOf('StopOwned $current.cliPath')){throw 'Secure creation not checked before stop'}
$checks++
@{state='PASS';checks=$checks;edition=$PSVersionTable.PSEdition;version=$PSVersionTable.PSVersion.ToString();fixture=$oldHome;servicesChanged=0}|ConvertTo-Json -Compress
