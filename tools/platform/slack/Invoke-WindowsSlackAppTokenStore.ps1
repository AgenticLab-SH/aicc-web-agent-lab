[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Store', 'Read')]
    [string]$Action,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$')]
    [string]$Service,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$')]
    [string]$Account
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'windows_credential_manager_required' }

if (-not ('Aicc.SlackCaptchaCredential.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Aicc.SlackCaptchaCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential {
        public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
        public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    public static class NativeMethods {
        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredWrite(ref Credential credential, UInt32 flags);
        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern void CredFree(IntPtr buffer);
    }
}
'@
}

$target = "open-AICC:slack-app:$Service`:$Account"
switch ($Action) {
    'Store' {
        $token = [Console]::In.ReadToEnd().Trim()
        if ($token -notmatch '^xapp-[A-Za-z0-9-]{20,}$') { throw 'invalid_slack_app_token' }
        $bytes = [Text.Encoding]::UTF8.GetBytes($token)
        $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
        try {
            [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
            $credential = [Aicc.SlackCaptchaCredential.Credential]@{
                Type = 1; TargetName = $target; CredentialBlobSize = $bytes.Length; CredentialBlob = $blob
                Persist = 2; UserName = $Account
            }
            if (-not [Aicc.SlackCaptchaCredential.NativeMethods]::CredWrite([ref]$credential, 0)) {
                throw "windows_credential_write_failed:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            }
        } finally {
            [Array]::Clear($bytes, 0, $bytes.Length)
            for ($index = 0; $index -lt $bytes.Length; $index++) { [Runtime.InteropServices.Marshal]::WriteByte($blob, $index, 0) }
            [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
            $token = $null
        }
        [Console]::Out.Write('{"ok":true,"backend":"windows_credential_manager"}')
    }
    'Read' {
        $pointer = [IntPtr]::Zero
        if (-not [Aicc.SlackCaptchaCredential.NativeMethods]::CredRead($target, 1, 0, [ref]$pointer)) {
            throw "windows_credential_read_failed:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        try {
            $credential = [Runtime.InteropServices.Marshal]::PtrToStructure[Aicc.SlackCaptchaCredential.Credential]($pointer)
            $bytes = New-Object byte[] $credential.CredentialBlobSize
            [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
            $token = [Text.Encoding]::UTF8.GetString($bytes)
            if ($token -notmatch '^xapp-[A-Za-z0-9-]{20,}$') { throw 'invalid_slack_app_token' }
            [Console]::Out.Write($token)
        } finally {
            if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
            $token = $null
            [Aicc.SlackCaptchaCredential.NativeMethods]::CredFree($pointer)
        }
    }
}
