#requires -Version 7.0
<#! Dedicated Windows SSH key. No cloud, Desktop or OCX mutation. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('init','status','restore')][string]$Action,
    [Parameter(Mandatory)][ValidateSet('a1')][string]$Target,
    [Parameter(Mandatory)][string]$Root,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath($Root)
if (-not [IO.Path]::IsPathFullyQualified($Root) -or (Split-Path $taskRoot -Leaf) -ne 'oracle-a1-access') {
    throw 'Exact absolute oracle-a1-access root required.'
}
$walk = $taskRoot
while ($walk) {
    if (Test-Path -LiteralPath $walk) {
        if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused.' }
    }
    $walk = Split-Path $walk -Parent
}
if ($DryRun) { @{action=$Action;target=$Target;mutation=$false} | ConvertTo-Json -Compress; exit 0 }
if (-not $IsWindows) { throw 'Windows required.' }
$keyPath = Join-Path $taskRoot 'id_rsa'
$publicPath = "$keyPath.pub"
$backupPath = Join-Path $taskRoot 'id_rsa.dpapi'
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
function Protect-Directory([string]$Path) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($ownerSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($ownerSid,$systemSid)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Assert-Private([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $rawAcl = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
    if ($null -eq $rawAcl.DiscretionaryAcl -or $rawAcl.DiscretionaryAcl.Count -eq 0) { throw 'Missing access control refused.' }
    if ($acl.Owner -ne $ownerSid.Value -and ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid.Value) { throw 'Owner mismatch.' }
    foreach ($rule in $acl.Access) {
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($rule.AccessControlType -eq 'Allow' -and $sid -notin @($ownerSid.Value,$systemSid.Value)) { throw "Unexpected ACL identity $sid on $(Split-Path $Path -Leaf)." }
    }
    if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused.' }
}
function Protect-File([string]$Path) {
    # OpenSSH creates an explicit Administrators ACE. Change only this new file's
    # DACL through the native utility; Set-Acl may request unavailable SACL rights.
    $null = & icacls.exe $Path '/inheritance:r' '/remove:g' '*S-1-5-32-544' '*S-1-1-0' '*S-1-5-32-545' '*S-1-5-11' '/grant:r' "*$($ownerSid.Value):(F)" '*S-1-5-18:(F)'
    if ($LASTEXITCODE -ne 0) { throw 'Private key ACL update failed.' }
    $null = & icacls.exe $Path '/setowner' "*$($ownerSid.Value)"
    if ($LASTEXITCODE -ne 0) { throw 'Private key owner update failed.' }
}
function Resolve-OpenSshTool([string]$Name) {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git) {
        $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
        $candidate = Join-Path $gitRoot "usr\bin\$Name.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $fallback = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
    if ($fallback) { return $fallback.Source }
    throw "$Name executable not found."
}
function Keygen([string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Resolve-OpenSshTool 'ssh-keygen'
    $start.UseShellExecute=$false
    $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true
    $start.RedirectStandardError=$true
    $start.RedirectStandardInput=$true
    foreach($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $proc = [Diagnostics.Process]::Start($start)
    $proc.StandardInput.Close()
    $output = $proc.StandardOutput.ReadToEnd()
    $null = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) { throw 'SSH key operation failed.' }
    return $output
}
if ($Action -eq 'init') {
    if (Test-Path -LiteralPath $taskRoot) { throw 'Existing root refused; use status.' }
    $null = New-Item -ItemType Directory -Path $taskRoot
    Protect-Directory $taskRoot
    $null = Keygen -Arguments @('-q','-t','rsa','-b','3072','-N','','-C','aicc-oracle-a1','-f',$keyPath)
    Protect-File $keyPath
    Protect-File $publicPath
    Assert-Private $keyPath
    $plain = [IO.File]::ReadAllBytes($keyPath)
    try {
        $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::UTF8.GetBytes('aicc-oracle-a1-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllBytes($backupPath,$encrypted)
        Protect-File $backupPath
    } finally { [Array]::Clear($plain,0,$plain.Length) }
}
Assert-Private $taskRoot
Assert-Private $backupPath
if ($Action -eq 'restore') {
    if (Test-Path -LiteralPath $keyPath) { throw 'Existing private key is never overwritten.' }
    $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($backupPath),[Text.Encoding]::UTF8.GetBytes('aicc-oracle-a1-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { [IO.File]::WriteAllBytes($keyPath,$plain); Protect-File $keyPath } finally { [Array]::Clear($plain,0,$plain.Length) }
}
Assert-Private $keyPath
Assert-Private $publicPath
$derived = (Keygen -Arguments @('-y','-f',$keyPath)).Trim()
$stored = [IO.File]::ReadAllText($publicPath).Trim()
if (-not $stored.StartsWith("$derived ") -and $stored -ne $derived) { throw 'Public/private key mismatch.' }
$fingerprint = ((Keygen -Arguments @('-l','-f',$publicPath)).Trim() -split '\s+')[1]
@{ok=$true;target=$Target;fingerprint=$fingerprint;privateStorage=$true;encryptedLocalBackup=$true;serverEnrollmentChecked=$false} | ConvertTo-Json -Compress
