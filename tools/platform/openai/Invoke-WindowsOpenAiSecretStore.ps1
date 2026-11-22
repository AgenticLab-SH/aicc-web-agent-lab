[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Status', 'Store', 'Read')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$target = 'open-AICC:openai:OpenAI API:personal-default'
$account = 'personal-default'

if ($env:OS -ne 'Windows_NT') {
    throw 'windows_credential_manager_required'
}

if (-not ('Aicc.OpenAiCredentialManager.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Aicc.OpenAiCredentialManager {
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

$targetHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($target))).ToLowerInvariant()

switch ($Action) {
    'Status' {
        [pscustomobject]@{ ok = $true; backend = 'windows_credential_manager'; targetHash = $targetHash } | ConvertTo-Json -Compress
    }
    'Store' {
        $secret = [Console]::In.ReadToEnd().Trim()
        if ($secret -notmatch '^sk-[A-Za-z0-9_-]{20,}$') { throw 'invalid_openai_api_key' }
        $bytes = [Text.Encoding]::UTF8.GetBytes($secret)
        $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
        try {
            [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
            $credential = [Aicc.OpenAiCredentialManager.Credential]@{
                Type = 1
                TargetName = $target
                CredentialBlobSize = $bytes.Length
                CredentialBlob = $blob
                Persist = 2
                UserName = $account
            }
            if (-not [Aicc.OpenAiCredentialManager.NativeMethods]::CredWrite([ref]$credential, 0)) {
                throw "windows_credential_write_failed:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            }
        } finally {
            [Array]::Clear($bytes, 0, $bytes.Length)
            for ($index = 0; $index -lt $bytes.Length; $index++) { [Runtime.InteropServices.Marshal]::WriteByte($blob, $index, 0) }
            [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
            $secret = $null
        }
        [pscustomobject]@{ ok = $true; backend = 'windows_credential_manager'; targetHash = $targetHash } | ConvertTo-Json -Compress
    }
    'Read' {
        $pointer = [IntPtr]::Zero
        if (-not [Aicc.OpenAiCredentialManager.NativeMethods]::CredRead($target, 1, 0, [ref]$pointer)) {
            throw "windows_credential_read_failed:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        try {
            $credential = [Runtime.InteropServices.Marshal]::PtrToStructure[Aicc.OpenAiCredentialManager.Credential]($pointer)
            $bytes = New-Object byte[] $credential.CredentialBlobSize
            [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
            $secret = [Text.Encoding]::UTF8.GetString($bytes)
            if ($secret -notmatch '^sk-[A-Za-z0-9_-]{20,}$') { throw 'invalid_openai_api_key' }
            [Console]::Out.Write($secret)
        } finally {
            if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
            $secret = $null
            [Aicc.OpenAiCredentialManager.NativeMethods]::CredFree($pointer)
        }
    }
}
