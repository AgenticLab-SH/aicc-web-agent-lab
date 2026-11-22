[CmdletBinding()]
param(
    [string]$StateRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center')
)

$ErrorActionPreference = 'Stop'
if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) { throw 'windows_required' }

$target = [IO.Path]::GetFullPath((Join-Path $StateRoot 'notifications\slack-captcha'))
$expectedParent = [IO.Path]::GetFullPath((Join-Path $StateRoot 'notifications'))
if (-not $target.StartsWith($expectedParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'invalid_captcha_state_target'
}
New-Item -ItemType Directory -Path $target -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $target -AclObject $acl
[pscustomobject]@{ ok = $true; state = 'ready'; path = $target } | ConvertTo-Json -Compress
