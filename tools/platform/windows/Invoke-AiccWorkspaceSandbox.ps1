param(
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$CommandFile,
  [ValidateSet('Enabled', 'Disabled')][string]$Network = 'Enabled',
  [string[]]$ReadOnlyPath = @(),
  [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-ExistingDirectory([string]$PathValue) {
  $item = Get-Item -LiteralPath $PathValue -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Non-reparse directory required: $PathValue"
  }
  $full = $item.FullName
  for ($ancestor = $item.Parent; $ancestor; $ancestor = $ancestor.Parent) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Linked sandbox ancestor refused: $($ancestor.FullName)"
    }
  }
  if ($full.TrimEnd('\') -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) {
    throw 'A volume root cannot be used as an AppContainer workspace.'
  }
  return $full.TrimEnd('\')
}

function Test-PathInside([string]$Root, [string]$Candidate) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  return $candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -or
    $candidateFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Icacls([string[]]$Arguments) {
  $systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { $env:WINDIR }
  $icacls = Join-Path $systemRoot 'System32\icacls.exe'
  & $icacls @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE" }
}

function Test-ExistingSandboxAce([string]$PathValue, [string]$Sid, [Security.AccessControl.AccessControlType]$Type, [Security.AccessControl.FileSystemRights]$Rights, [bool]$InheritedChildren) {
  $acl = Get-Acl -LiteralPath $PathValue -ErrorAction Stop
  $neededInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $required = [int]$Rights
  $permitted = $required -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
  $found = $false
  foreach ($rule in $acl.Access) {
    $ruleSid = try { $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $rule.IdentityReference.Value }
    if ($ruleSid -ne $Sid -or $rule.AccessControlType -ne $Type) { continue }
    $actual = [int]$rule.FileSystemRights
    $expectedInheritance = if ($InheritedChildren) { [int]$neededInheritance } else { 0 }
    if (($actual -band $required) -ne $required -or ($actual -band (-bnot $permitted)) -ne 0 -or
        [int]$rule.InheritanceFlags -ne $expectedInheritance -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
      throw "Unexpected AppContainer ACL for $PathValue; inspect the exact SID before running a command."
    }
    $found = $true
  }
  return $found
}

function Protect-SandboxSensitivePath([string]$PathValue, [string]$Sid) {
  # A package SID deny ACE alone did not block access in the registered-root
  # acceptance probe. Remove this package's inherited allow, retaining denies
  # and every other trustee's rights. Do not broaden ancestor or user access.
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($PathValue)
  while ($pending.Count -gt 0) {
    $entry = $pending.Pop()
    $attributes = [IO.File]::GetAttributes($entry)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Linked sensitive sandbox path refused: $entry"
    }
    $acl = Get-Acl -LiteralPath $entry -ErrorAction Stop
    $packageAllows = @()
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
      $ruleSid = $rule.IdentityReference.Value
      if ($ruleSid -eq $Sid) { $packageAllows += $rule; continue }
      if ($ruleSid -eq 'S-1-15-2-1' -or $ruleSid -eq 'S-1-15-2-2' -or $ruleSid.StartsWith('S-1-15-3-', [StringComparison]::Ordinal)) {
        throw "Ambiguous AppContainer capability grant on sensitive path; owner reconciliation required: $entry"
      }
    }
    if (-not $acl.AreAccessRulesProtected -or $packageAllows.Count -gt 0) {
      $originalRules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($rule in $originalRules) {
        $ruleSid = $rule.IdentityReference.Value
        if ($ruleSid -eq $Sid -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
          if (-not $rule.IsInherited) { $acl.RemoveAccessRuleSpecific($rule) }
          continue
        }
        if ($rule.IsInherited) {
          $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $rule.IdentityReference, $rule.FileSystemRights, $rule.InheritanceFlags,
            $rule.PropagationFlags, $rule.AccessControlType))
        }
      }
      try { Set-Acl -LiteralPath $entry -AclObject $acl -ErrorAction Stop }
      catch { throw "sandbox_sensitive_inheritance_not_protected: workspace owner must prepare the exact sensitive ACL before execution: $entry. $($_.Exception.Message)" }
    }
    $verified = Get-Acl -LiteralPath $entry -ErrorAction Stop
    if (-not $verified.AreAccessRulesProtected) { throw "Sensitive sandbox inheritance remains enabled: $entry" }
    foreach ($rule in $verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      $ruleSid = $rule.IdentityReference.Value
      if ($ruleSid -eq $Sid -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
        throw "Sensitive sandbox package allow remains: $entry"
      }
    }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
      foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($entry)) { $pending.Push($child) }
    }
  }
}

$WorkspaceRoot = Resolve-ExistingDirectory $WorkspaceRoot
if (-not (Test-Path -LiteralPath $RuntimeRoot)) {
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
}
$RuntimeRoot = Resolve-ExistingDirectory $RuntimeRoot
$commandItem = Get-Item -LiteralPath $CommandFile -Force -ErrorAction Stop
if ($commandItem.PSIsContainer -or ($commandItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Command file must be a non-reparse regular file.'
}
$CommandFile = $commandItem.FullName
if (-not (Test-PathInside $RuntimeRoot $CommandFile)) { throw 'Command file must be inside the AICC runtime root.' }

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AiccAppContainer {
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint SE_GROUP_ENABLED = 0x00000004;
    const int STARTF_USESTDHANDLES = 0x00000100;
    const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = new IntPtr(0x00020009);
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_CAPABILITIES {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint capabilityCount, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);

    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr capabilities, out uint capabilityCount);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr stringSid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr sid);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int stdHandle);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint desiredAccess, bool inheritHandle, uint options);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr buffer, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);

    static int TokenInt(IntPtr token, int informationClass) {
        IntPtr buffer = Marshal.AllocHGlobal(4);
        try {
            int returned;
            if (!GetTokenInformation(token, informationClass, buffer, 4, out returned)) ThrowLast("Read sandbox token state");
            return Marshal.ReadInt32(buffer);
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    static void AssertLowbox(IntPtr process, IntPtr expectedSid) {
        IntPtr token;
        if (!OpenProcessToken(process, 0x0008, out token)) ThrowLast("Open sandbox token");
        try {
            int isAppContainer = TokenInt(token, 29), isElevated = TokenInt(token, 20);
            if (isAppContainer != 1 || isElevated != 0)
                throw new InvalidOperationException("Sandbox child token refused: AppContainer=" + isAppContainer + ", Elevated=" + isElevated + ".");
            int returned;
            GetTokenInformation(token, 31, IntPtr.Zero, 0, out returned);
            if (returned < IntPtr.Size || returned > 4096) throw new InvalidOperationException("Invalid sandbox package SID information.");
            IntPtr buffer = Marshal.AllocHGlobal(returned);
            try {
                if (!GetTokenInformation(token, 31, buffer, returned, out returned)) ThrowLast("Read sandbox package SID");
                IntPtr actualText = IntPtr.Zero, expectedText = IntPtr.Zero;
                try {
                    if (!ConvertSidToStringSidW(Marshal.ReadIntPtr(buffer), out actualText) ||
                        !ConvertSidToStringSidW(expectedSid, out expectedText)) ThrowLast("Read sandbox SID identity");
                    if (!String.Equals(Marshal.PtrToStringUni(actualText), Marshal.PtrToStringUni(expectedText), StringComparison.Ordinal))
                        throw new InvalidOperationException("Sandbox package SID differs from registered workspace profile.");
                } finally {
                    if (actualText != IntPtr.Zero) LocalFree(actualText);
                    if (expectedText != IntPtr.Zero) LocalFree(expectedText);
                }
            } finally { Marshal.FreeHGlobal(buffer); }
        } finally { CloseHandle(token); }
    }
    static void ThrowLast(string operation) {
        int error = Marshal.GetLastWin32Error();
        throw new Win32Exception(error, operation + " failed (Win32 " + error + ")");
    }

    public static string AncestorCapabilitySid() {
        IntPtr groups = IntPtr.Zero, capabilities = IntPtr.Zero;
        uint groupCount = 0, capabilityCount = 0;
        if (!DeriveCapabilitySidsFromName("OpenAICC.Workspace.AncestorTraverse.v1", out groups, out groupCount, out capabilities, out capabilityCount)) {
            ThrowLast("Derive ancestor capability SID");
        }
        try {
            if (capabilityCount != 1) throw new InvalidOperationException("Unexpected ancestor capability SID count.");
            IntPtr text;
            if (!ConvertSidToStringSidW(Marshal.ReadIntPtr(capabilities), out text)) ThrowLast("Convert ancestor capability SID");
            try { return Marshal.PtrToStringUni(text); }
            finally { LocalFree(text); }
        } finally {
            for (int i = 0; i < groupCount; i++) LocalFree(Marshal.ReadIntPtr(groups, i * IntPtr.Size));
            for (int i = 0; i < capabilityCount; i++) LocalFree(Marshal.ReadIntPtr(capabilities, i * IntPtr.Size));
            if (groups != IntPtr.Zero) LocalFree(groups);
            if (capabilities != IntPtr.Zero) LocalFree(capabilities);
        }
    }

    public static string EnsureProfile(string profileName) {
        IntPtr createdSid = IntPtr.Zero;
        int hr = CreateAppContainerProfile(profileName, profileName, "open-AICC workspace sandbox", IntPtr.Zero, 0, out createdSid);
        uint unsignedHr = unchecked((uint)hr);
        if (createdSid != IntPtr.Zero) FreeSid(createdSid);
        if (hr != 0 && unsignedHr != 0x800700B7) throw new InvalidOperationException("CreateAppContainerProfile failed: 0x" + unsignedHr.ToString("X8"));

        IntPtr sid;
        hr = DeriveAppContainerSidFromAppContainerName(profileName, out sid);
        if (hr != 0 || sid == IntPtr.Zero) throw new InvalidOperationException("DeriveAppContainerSidFromAppContainerName failed: 0x" + unchecked((uint)hr).ToString("X8"));
        try {
            IntPtr text;
            if (!ConvertSidToStringSidW(sid, out text)) ThrowLast("ConvertSidToStringSid");
            try { return Marshal.PtrToStringUni(text); }
            finally { LocalFree(text); }
        } finally {
            FreeSid(sid);
        }
    }

    public static int Run(string profileName, string application, string commandLine, string currentDirectory, bool network) {
        IntPtr appSid = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr securityCapabilitiesPtr = IntPtr.Zero;
        IntPtr capabilitiesPtr = IntPtr.Zero;
        IntPtr ancestorSid = IntPtr.Zero;
        IntPtr internetSid = IntPtr.Zero;
        IntPtr privateNetworkSid = IntPtr.Zero;
        IntPtr stdinHandle = IntPtr.Zero;
        IntPtr stdoutHandle = IntPtr.Zero;
        IntPtr stderrHandle = IntPtr.Zero;
        IntPtr handleListPtr = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        try {
            int hr = DeriveAppContainerSidFromAppContainerName(profileName, out appSid);
            if (hr != 0 || appSid == IntPtr.Zero) throw new InvalidOperationException("AppContainer SID is unavailable.");

            if (!ConvertStringSidToSidW(AncestorCapabilitySid(), out ancestorSid)) ThrowLast("Convert ancestor capability SID");
            SID_AND_ATTRIBUTES[] capabilities = new SID_AND_ATTRIBUTES[network ? 3 : 1];
            capabilities[0] = new SID_AND_ATTRIBUTES { Sid = ancestorSid, Attributes = SE_GROUP_ENABLED };
            if (network) {
                if (!ConvertStringSidToSidW("S-1-15-3-1", out internetSid)) ThrowLast("Convert internet capability SID");
                if (!ConvertStringSidToSidW("S-1-15-3-3", out privateNetworkSid)) ThrowLast("Convert private network capability SID");
                capabilities[1] = new SID_AND_ATTRIBUTES { Sid = internetSid, Attributes = SE_GROUP_ENABLED };
                capabilities[2] = new SID_AND_ATTRIBUTES { Sid = privateNetworkSid, Attributes = SE_GROUP_ENABLED };
            }
            int itemSize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            capabilitiesPtr = Marshal.AllocHGlobal(itemSize * capabilities.Length);
            for (int i = 0; i < capabilities.Length; i++) {
                Marshal.StructureToPtr(capabilities[i], IntPtr.Add(capabilitiesPtr, i * itemSize), false);
            }

            SECURITY_CAPABILITIES securityCapabilities = new SECURITY_CAPABILITIES {
                AppContainerSid = appSid,
                Capabilities = capabilitiesPtr,
                CapabilityCount = (uint)capabilities.Length,
                Reserved = 0
            };
            securityCapabilitiesPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            Marshal.StructureToPtr(securityCapabilities, securityCapabilitiesPtr, false);

            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributeList = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref size)) ThrowLast("InitializeProcThreadAttributeList");
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, securityCapabilitiesPtr, new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero)) {
                ThrowLast("Update security capabilities");
            }

            IntPtr currentProcess = GetCurrentProcess();
            if (!DuplicateHandle(currentProcess, GetStdHandle(STD_INPUT_HANDLE), currentProcess, out stdinHandle, 0, true, DUPLICATE_SAME_ACCESS)) ThrowLast("Duplicate stdin");
            if (!DuplicateHandle(currentProcess, GetStdHandle(STD_OUTPUT_HANDLE), currentProcess, out stdoutHandle, 0, true, DUPLICATE_SAME_ACCESS)) ThrowLast("Duplicate stdout");
            if (!DuplicateHandle(currentProcess, GetStdHandle(STD_ERROR_HANDLE), currentProcess, out stderrHandle, 0, true, DUPLICATE_SAME_ACCESS)) ThrowLast("Duplicate stderr");

            handleListPtr = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleListPtr, 0, stdinHandle);
            Marshal.WriteIntPtr(handleListPtr, IntPtr.Size, stdoutHandle);
            Marshal.WriteIntPtr(handleListPtr, IntPtr.Size * 2, stderrHandle);
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleListPtr, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) {
                ThrowLast("Update handle allowlist");
            }

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdinHandle;
            startup.StartupInfo.hStdOutput = stdoutHandle;
            startup.StartupInfo.hStdError = stderrHandle;
            startup.lpAttributeList = attributeList;
            StringBuilder mutableCommand = new StringBuilder(commandLine);
            if (!CreateProcessW(application, mutableCommand, IntPtr.Zero, IntPtr.Zero, true, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED, IntPtr.Zero, currentDirectory, ref startup, out pi)) {
                ThrowLast("CreateProcessW");
            }

            // No command runs until the exact child token has been checked.
            try {
                AssertLowbox(pi.hProcess, appSid);
                if (ResumeThread(pi.hThread) == 0xFFFFFFFF) ThrowLast("Resume verified sandbox child");
            } catch {
                // This is our own still-suspended child, never an existing service.
                TerminateProcess(pi.hProcess, 1);
                throw;
            }
            uint wait = WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
            if (wait != 0) throw new InvalidOperationException("WaitForSingleObject failed: " + wait);
            uint exitCode;
            if (!GetExitCodeProcess(pi.hProcess, out exitCode)) ThrowLast("GetExitCodeProcess");
            return unchecked((int)exitCode);
        } finally {
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            if (attributeList != IntPtr.Zero) {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (securityCapabilitiesPtr != IntPtr.Zero) Marshal.FreeHGlobal(securityCapabilitiesPtr);
            if (capabilitiesPtr != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesPtr);
            if (ancestorSid != IntPtr.Zero) LocalFree(ancestorSid);
            if (internetSid != IntPtr.Zero) LocalFree(internetSid);
            if (privateNetworkSid != IntPtr.Zero) LocalFree(privateNetworkSid);
            if (stdinHandle != IntPtr.Zero) CloseHandle(stdinHandle);
            if (stdoutHandle != IntPtr.Zero) CloseHandle(stdoutHandle);
            if (stderrHandle != IntPtr.Zero) CloseHandle(stderrHandle);
            if (handleListPtr != IntPtr.Zero) Marshal.FreeHGlobal(handleListPtr);
            if (appSid != IntPtr.Zero) FreeSid(appSid);
        }
    }
}
'@

if (-not ('AiccAppContainer' -as [type])) {
  Add-Type -TypeDefinition $nativeSource -Language CSharp
}

function Test-NarrowAncestorCapability([string]$Directory) {
  $sid = [AiccAppContainer]::AncestorCapabilitySid()
  $required = [int]([Security.AccessControl.FileSystemRights]::ReadAttributes -bor [Security.AccessControl.FileSystemRights]::Traverse)
  $permitted = $required -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
  $acl = Get-Acl -LiteralPath $Directory -ErrorAction Stop
  $found = $false
  foreach ($rule in $acl.Access) {
    $ruleSid = try { $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $rule.IdentityReference.Value }
    if ($ruleSid -ne $sid) { continue }
    $rights = [int]$rule.FileSystemRights
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or
        $rule.InheritanceFlags -ne 'None' -or $rule.PropagationFlags -ne 'None' -or
        ($rights -band $required) -ne $required -or ($rights -band (-bnot $permitted)) -ne 0 -or $found) {
      throw "Unexpected AICC ancestor capability ACL for $Directory."
    }
    $found = $true
  }
  return $found
}

function Assert-AncestorCapability([string]$PathValue) {
  $volumeRoot = [IO.Path]::GetPathRoot($PathValue).TrimEnd('\')
  $parent = [IO.Directory]::GetParent($PathValue)
  $found = $false
  while ($parent -and -not $parent.FullName.TrimEnd('\').Equals($volumeRoot, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-NarrowAncestorCapability $parent.FullName) { $found = $true }
    $parent = $parent.Parent
  }
  if (Test-NarrowAncestorCapability ([IO.Path]::GetPathRoot($PathValue))) {
    throw 'The AICC ancestor capability must not be installed on a volume root.'
  }
  if (-not $found) { throw "AICC ancestor traverse capability is not installed for: $PathValue" }
}

Assert-AncestorCapability $WorkspaceRoot
if (-not (Test-PathInside $WorkspaceRoot $RuntimeRoot)) { Assert-AncestorCapability $RuntimeRoot }
foreach ($allowedRead in $ReadOnlyPath) {
  if ($allowedRead) {
    $resolvedRead = (Get-Item -LiteralPath $allowedRead -Force -ErrorAction Stop).FullName
    if (-not (Test-PathInside $WorkspaceRoot $resolvedRead)) {
      Assert-AncestorCapability $resolvedRead
    }
  }
}

$sha = [Security.Cryptography.SHA256]::Create()
try {
  $bytes = [Text.Encoding]::UTF8.GetBytes($WorkspaceRoot.ToLowerInvariant())
  $digest = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
} finally {
  $sha.Dispose()
}
$profileName = 'OpenAICC.Workspace.' + $digest.Substring(0, 24)
$sid = [AiccAppContainer]::EnsureProfile($profileName)

if (-not (Test-ExistingSandboxAce $WorkspaceRoot $sid Allow Modify $true)) {
  Invoke-Icacls @($WorkspaceRoot, '/grant', ('*' + $sid + ':(OI)(CI)M'), '/Q')
}
if (-not (Test-ExistingSandboxAce $RuntimeRoot $sid Allow Modify $true)) {
  Invoke-Icacls @($RuntimeRoot, '/grant', ('*' + $sid + ':(OI)(CI)M'), '/Q')
}
# /C may report a failed ACL while continuing. Never launch a lowbox until the
# exact least-privilege ACEs were read back from both granted directories.
if (-not (Test-ExistingSandboxAce $WorkspaceRoot $sid Allow Modify $true) -or
    -not (Test-ExistingSandboxAce $RuntimeRoot $sid Allow Modify $true)) {
  throw 'sandbox_acl_not_applied: workspace owner must reconcile the exact AppContainer grant; no alternate executor is allowed.'
}
foreach ($allowedRead in $ReadOnlyPath) {
  if (-not $allowedRead) { continue }
  $resolvedRead = (Get-Item -LiteralPath $allowedRead -Force -ErrorAction Stop).FullName
  $readAttributes = [IO.File]::GetAttributes($resolvedRead)
  $readRights = if (($readAttributes -band [IO.FileAttributes]::Directory) -ne 0) { '(OI)(CI)RX' } else { 'RX' }
  $isDirectory = ($readAttributes -band [IO.FileAttributes]::Directory) -ne 0
  if (-not (Test-ExistingSandboxAce $resolvedRead $sid Allow ReadAndExecute $isDirectory)) {
    Invoke-Icacls @($resolvedRead, '/grant', ('*' + $sid + ':' + $readRights), '/Q')
    if (-not (Test-ExistingSandboxAce $resolvedRead $sid Allow ReadAndExecute $isDirectory)) { throw 'sandbox_read_acl_not_applied' }
  }
}

$blockedNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@('.env', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519', 'known_hosts', '.ssh', '.gnupg', '.aws', '.azure', '.kube') |
  ForEach-Object { [void]$blockedNames.Add($_) }
$blockedExtensions = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@('.pem', '.key', '.p12', '.pfx') | ForEach-Object { [void]$blockedExtensions.Add($_) }
$skipDirs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@('node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.venv') | ForEach-Object { [void]$skipDirs.Add($_) }

$stack = [Collections.Generic.Stack[string]]::new()
$stack.Push($WorkspaceRoot)
while ($stack.Count -gt 0) {
  $directory = $stack.Pop()
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
    try {
      $attributes = [IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
      $name = [IO.Path]::GetFileName($entry)
      $extension = [IO.Path]::GetExtension($entry)
      $sensitive = $blockedNames.Contains($name) -or $name.StartsWith('.env.', [StringComparison]::OrdinalIgnoreCase) -or $blockedExtensions.Contains($extension)
      $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
      if ($sensitive) {
        $rights = if ($isDirectory) { '(OI)(CI)F' } else { 'F' }
        if (-not (Test-ExistingSandboxAce $entry $sid Deny FullControl $isDirectory)) {
          Invoke-Icacls @($entry, '/deny', ('*' + $sid + ':' + $rights), '/Q')
          if (-not (Test-ExistingSandboxAce $entry $sid Deny FullControl $isDirectory)) { throw 'sandbox_sensitive_deny_not_applied' }
        }
        Protect-SandboxSensitivePath $entry $sid
        continue
      }
      if ($isDirectory -and -not $skipDirs.Contains($name)) { $stack.Push($entry) }
    } catch {
      throw "Unable to secure sandbox path '$entry': $($_.Exception.Message)"
    }
  }
}

# An elevated owner may reconcile only these profile-specific ACLs. Execution
# remains the standard-user Workspace service's responsibility; no token or
# executor substitution is allowed when the suspended-child check refuses it.
if ($PrepareOnly) {
  [ordered]@{
    status = 'ACL_PREPARED_NOT_EXECUTED'
    workspaceRoot = $WorkspaceRoot
    runtimeRoot = $RuntimeRoot
    profileName = $profileName
    appContainerSid = $sid
    commandExecuted = $false
  } | ConvertTo-Json -Compress
  exit 0
}

$runId = [Guid]::NewGuid().ToString('N')
$wrapperPath = Join-Path $RuntimeRoot "wrapper-$runId.ps1"
$wrapper = @'
param(
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$CommandFile
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
try {
# Bind the allowed directory directly; volume-root metadata is unavailable in AppContainer.
New-PSDrive -Name AiccWorkspace -PSProvider FileSystem -Root $WorkspaceRoot -Scope Global | Out-Null
Set-Location -LiteralPath 'AiccWorkspace:\'
[Environment]::CurrentDirectory = $WorkspaceRoot
  $commandText = [IO.File]::ReadAllText($CommandFile, [Text.Encoding]::UTF8)
  # Flush formatting output before the wrapper exits (PathInfo followed by text).
  & ([ScriptBlock]::Create($commandText)) | Out-Default
  $nativeVariable = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
  $nativeExit = if ($nativeVariable) { $nativeVariable.Value } else { 0 }
  $code = if ($nativeExit -is [int]) { [int]$nativeExit } else { 0 }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $code = 1
}
exit $code
'@
[IO.File]::WriteAllText($wrapperPath, $wrapper, [Text.UTF8Encoding]::new($false))

function Quote-ProcessArg([string]$Value) {
  return '"' + $Value.Replace('\', '\').Replace('"', '\"') + '"'
}

$systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { $env:WINDIR }
$powershellPath = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
  throw 'The Windows system PowerShell executable is unavailable to the AppContainer broker.'
}
$commandLine = (Quote-ProcessArg $powershellPath) +
  ' -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-ProcessArg $wrapperPath) +
  ' -WorkspaceRoot ' + (Quote-ProcessArg $WorkspaceRoot) +
  ' -CommandFile ' + (Quote-ProcessArg $CommandFile)

try {
  exit [AiccAppContainer]::Run($profileName, $powershellPath, $commandLine, $WorkspaceRoot, $Network -eq 'Enabled')
} finally {
  Remove-Item -LiteralPath $wrapperPath -Force -ErrorAction SilentlyContinue
}
