[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Status', 'Store', 'Read')]
    [string]$Action,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$')]
    [string]$Service,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$')]
    [string]$Account
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'windows_credential_manager_required'
}

if (-not ('Aicc.WindowsCredentialManager.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Aicc.WindowsCredentialManager {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static class NativeMethods {
        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredWrite(ref Credential credential, UInt32 flags);

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern void CredFree(IntPtr buffer);
    }
}
'@
}

$target = "open-AICC:slack:$Service`:$Account"
$targetHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target))).ToLowerInvariant()

switch ($Action) {
    'Status' {
        [pscustomobject]@{ ok = $true; backend = 'windows_credential_manager'; targetHash = $targetHash } | ConvertTo-Json -Compress
    }
    'Store' {
        $token = [Console]::In.ReadToEnd().Trim()
        if ($token -notmatch '^xoxb-[A-Za-z0-9-]{20,}$') {
            throw 'invalid_slack_bot_token'
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes($token)
        $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
        try {
            [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
            $credential = [Aicc.WindowsCredentialManager.Credential]@{
                Type               = 1
                TargetName         = $target
                CredentialBlobSize = $bytes.Length
                CredentialBlob     = $blob
                Persist            = 2
                UserName           = $Account
            }
            if (-not [Aicc.WindowsCredentialManager.NativeMethods]::CredWrite([ref]$credential, 0)) {
                throw "windows_credential_write_failed:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            }
        } finally {
            [Array]::Clear($bytes, 0, $bytes.Length)
            for ($index = 0; $index -lt $bytes.Length; $index++) {
                [Runtime.InteropServices.Marshal]::WriteByte($blob, $index, 0)
            }
            [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
            $token = $null
        }
        [pscustomobject]@{ ok = $true; backend = 'windows_credential_manager'; targetHash = $targetHash } | ConvertTo-Json -Compress
    }
    'Read' {
        $pointer = [IntPtr]::Zero
        if (-not [Aicc.WindowsCredentialManager.NativeMethods]::CredRead($target, 1, 0, [ref]$pointer)) {
            throw "windows_credential_read_failed:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        try {
            $credential = [Runtime.InteropServices.Marshal]::PtrToStructure[Aicc.WindowsCredentialManager.Credential]($pointer)
            $bytes = New-Object byte[] $credential.CredentialBlobSize
            [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
            $token = [Text.Encoding]::UTF8.GetString($bytes)
            if ($token -notmatch '^xoxb-[A-Za-z0-9-]{20,}$') {
                throw 'invalid_slack_bot_token'
            }
            [Console]::Out.Write($token)
        } finally {
            if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
            $token = $null
            [Aicc.WindowsCredentialManager.NativeMethods]::CredFree($pointer)
        }
    }
}
