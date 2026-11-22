# Separately versioned RegisteredDevice V10; V1-V9 strict idle/original files immutable.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('arm', 'watch', 'status', 'signal', 'bind-owner', 'close', 'planned-stop')]
  [string]$Mode,
  [Parameter(Mandatory = $false)]
  [string]$OperationId,
  [Parameter(Mandatory = $false)]
  [string]$ConversationId,
  [Parameter(Mandatory = $false)]
  [string]$ControllerThreadId,
  [Parameter(Mandatory = $false)]
  [string]$RollbackScriptPath,
  [Parameter(Mandatory = $false)]
  [string]$ResumeMessagePath,
  [Parameter(Mandatory = $false)]
  [string]$Nonce,
  [Parameter(Mandatory = $false)]
  [string]$Reason,
  [Parameter(Mandatory = $false)]
  [string]$Root = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\webgpt-remote-recovery'),
  [Parameter(Mandatory = $false)]
  [int]$HeartbeatSeconds = 5
  ,
  [Parameter(Mandatory = $false)]
  [int]$OwnerPid = 0,
  [Parameter(Mandatory = $false)]
  [switch]$AutoOnOwnerExit,
  [ValidateSet('webgpt','rdc-device','rdc-17841')][string]$Transport = 'webgpt',
  [string]$DeviceId,
  [int]$RdcHostPid,
  [string]$RdcHostCreatedTicks,
  [string]$RdcHostCommandSha256,
  [string]$RdcHostImageSha256,
  [string]$SnapshotPath,
  [string]$ReleaseManifestPath,
  [string]$OperationExpiresAt,
  [string]$RecoveryExpiresAt,
  [string]$MetadataSha256,
  [ValidateSet('recover','activate')][string]$SignalAction = 'recover',
  [string]$RuntimeContractPath,
  [string]$RuntimeContractSha256,
  [string]$HandoffPath,
  [string]$HandoffSha256,
  [string]$TransportReceiptPath,
  [string]$TransportReceiptSha256,
  [string]$DeviceRegistrationPath,
  [string]$DeviceRegistrationSha256,
  [string]$PlannedMaintenanceScopePath,
  [string]$PlannedMaintenanceScopeSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if($Transport -cne 'rdc-17841'){throw 'This versioned successor is dedicated to 17841 maintenance only'}

$ExpectedConversationId = '6ac8a240-f0c0-83ec-b85c-7927270c9868'
$OperationIdPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$'
$NoncePattern = '^[a-f0-9]{32}$'
$Root = [System.IO.Path]::GetFullPath($Root)
$ScriptPath = [System.IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$HeartbeatSeconds = [Math]::Min([Math]::Max($HeartbeatSeconds, 2), 10)

function UtcNow { return [DateTime]::UtcNow.ToString('o') }

function Write-JsonAtomic([string]$Path, [object]$Value) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = "$Path.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
  $json = $Value | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($temp, "$json`n", [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Write-TextAtomic([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = "$Path.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
  [System.IO.File]::WriteAllText($temp, $Text, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $json=Get-Content -Raw -LiteralPath $Path -Encoding UTF8
  if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { return $json | ConvertFrom-Json -DateKind String }
  return $json | ConvertFrom-Json
}

function Require-OperationId {
  if ([string]::IsNullOrWhiteSpace($OperationId) -or $OperationId -notmatch $OperationIdPattern) {
    throw 'OperationId must be 6-64 characters using letters, digits, dot, underscore, or dash.'
  }
}

function Require-Nonce([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch $NoncePattern) {
    throw 'Nonce must be exactly 32 lowercase hexadecimal characters.'
  }
}

function Operation-Dir { return Join-Path $Root (Join-Path 'operations' $OperationId) }
function Operation-File([string]$Name) { return Join-Path (Operation-Dir) $Name }

function Require-Capsule {
  Require-OperationId
  $dir = Operation-Dir
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Recovery capsule does not exist: $OperationId" }
  $metadata = Read-Json (Operation-File 'metadata.json')
  if ($null -eq $metadata) { throw 'Recovery capsule metadata is missing.' }
  return $metadata
}

function Assert-PathUnder([string]$Child, [string]$Parent) {
  $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd('\') + '\'
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $childFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the recovery capsule: $Child"
  }
}

function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try { return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $stream.Dispose() }
  }
  finally { $sha.Dispose() }
}

function Rdc-Regular([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path)
  $item=Get-Item -LiteralPath $full -Force
  if($item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'RDC regular file required'}
  for($parent=$item.Directory;$parent;$parent=$parent.Parent){if($parent.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RDC linked ancestor refused'}}
  return $full
}
function Rdc-TextHash([string]$Value) {
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()
}
function Rdc-New([string]$Path,$Value) {
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 18 -Compress))
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Rdc-Publish([string]$Path,$Value) {
  $pending=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  Rdc-New $pending $Value
  # Publish only a complete message; an existing request is never overwritten.
  [IO.File]::Move($pending,$Path,$false)
}
# V9: process-image authority is distinct from regular source/metadata/private IO.
$script:W49ImageLease=$null
function Initialize-V9ImageIdentity {
  if('AiccRegisteredImageV9.Native' -as [type]){return}
  Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace AiccRegisteredImageV9 {
 public static class Native {
  [StructLayout(LayoutKind.Sequential)] struct Info {
   public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;
   public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder p,uint n,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,uint type,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstFileNameW(string p,uint flags,ref uint length,StringBuilder name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextFileNameW(IntPtr h,ref uint length,StringBuilder name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FindClose(IntPtr h);
  public static SafeFileHandle Directory(string path) {
   // Existing directory read/security access; no delete/rename sharing.
   var h=CreateFileW(path,0x20080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
   if(h.IsInvalid){h.Dispose();throw new IOException("V9_IMAGE_PARENT_OPEN_REFUSED");}return h;
  }
  public static string Identity(SafeFileHandle h,string expected,bool directory) {
   Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("V9_IMAGE_HANDLE_UNKNOWN");
   if((i.Attributes&0x400)!=0 || (((i.Attributes&0x10)!=0)!=directory))throw new IOException("V9_IMAGE_HANDLE_TYPE");
   var p=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,p,(uint)p.Capacity,0);
   if(n==0 || n>=p.Capacity)throw new IOException("V9_IMAGE_HANDLE_PATH_UNKNOWN");
   string actual=p.ToString();if(actual.StartsWith(@"\\?\"))actual=actual.Substring(4);
   if(!String.Equals(Path.GetFullPath(actual),Path.GetFullPath(expected),StringComparison.OrdinalIgnoreCase))throw new IOException("V9_IMAGE_HANDLE_PATH_CAS");
   return i.Volume.ToString("x8")+":"+i.IndexHigh.ToString("x8")+i.IndexLow.ToString("x8");
  }
  public static uint Links(SafeFileHandle h) {
   Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("V9_IMAGE_HANDLE_UNKNOWN");return i.Links;
  }
  public static byte[] Security(SafeFileHandle h) {
   IntPtr o,g,d,s,sd;
   if(GetSecurityInfo(h,1,7,out o,out g,out d,out s,out sd)!=0)throw new IOException("V9_IMAGE_SECURITY_UNKNOWN");
   try{uint n=GetSecurityDescriptorLength(sd);if(n==0||n>65536)throw new IOException("V9_IMAGE_SECURITY_UNKNOWN");
    var bytes=new byte[n];Marshal.Copy(sd,bytes,0,(int)n);return bytes;
   }finally{LocalFree(sd);}
  }
  public static string[] HardLinks(string path) {
   uint n=32768;var name=new StringBuilder((int)n);var h=FindFirstFileNameW(path,0,ref n,name);
   if(h==new IntPtr(-1))throw new IOException("V9_IMAGE_LINK_ENUM_UNKNOWN");
   try{
    var names=new List<string>();string root=Path.GetPathRoot(path);
    while(true){
     string value=name.ToString();
     if(!value.StartsWith(@"\") || value.StartsWith(@"\\"))throw new IOException("V9_IMAGE_LINK_PATH");
     names.Add(Path.GetFullPath(Path.Combine(root,value.TrimStart('\\'))));
     if(names.Count>32)throw new IOException("V9_IMAGE_LINK_ENUM_BOUND");
     n=32768;name=new StringBuilder((int)n);
     if(!FindNextFileNameW(h,ref n,name)){
      if(Marshal.GetLastWin32Error()!=38)throw new IOException("V9_IMAGE_LINK_ENUM_UNKNOWN");break;
     }
    }
    names.Sort(StringComparer.OrdinalIgnoreCase);
    for(int j=1;j<names.Count;j++)if(String.Equals(names[j-1],names[j],StringComparison.OrdinalIgnoreCase))throw new IOException("V9_IMAGE_LINK_DUPLICATE");
    return names.ToArray();
   }finally{FindClose(h);}
  }
 }
}
"@ | Out-Null
}
function W49-Convention($Contract) {
  $policy=$Contract.registeredSystemImage
  $expected=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\ocx-control-plane-repair-20261026\RDC-SYSTEM-IMAGE-CONVENTION.json'
  if($policy.schema -cne 'aicc-registered-rdc-system-image-support/v1' -or $policy.document.path -ine $expected -or $policy.document.sha256 -cne '1631f5e09043e94ffeaf6819b2849180ab32e6b1aa9558b63f9bcd38eecdd843'){throw 'V9_IMAGE_DOCUMENT_PIN'}
  W46-NoLinks $expected;W41-HashPin $expected $policy.document.sha256
  $actual=Read-Json $expected
  if((W46-Canonical $actual) -cne (W46-Canonical $policy.convention)){throw 'V9_IMAGE_DOCUMENT_CONTENT_CAS'}
  if($actual.schema -cne 'aicc-registered-rdc-system-image-convention/v1' -or $actual.path -ine 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe' -or $actual.sha256 -cne '60c9b29843624dd8af6b6a7b26147753be6aeef65098b9a503cc50850afe410f' -or $actual.ownerSid -cne 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' -or $actual.aclSha256 -cne '22b22a38891c2f41a6384b8e4629e2bf08fb94d29e37df9fee6a6b5a4bf7122f' -or $actual.signatureStatus -cne 'Valid' -or $actual.signerThumbprint -cne '667BBA1E1F478221AA65DE4F75187A751B03A453' -or $actual.signerSubject -cne 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' -or $actual.linkType -cne 'HardLink' -or $actual.attributes -cne 'Archive' -or $actual.sourceOrAclMutation -ne $false){throw 'V9_IMAGE_CONVENTION_REQUIRED'}
  return $actual
}
function W49-RegisteredProof($Metadata) {
  if($Metadata -is [Collections.IDictionary]){$Metadata=[pscustomobject]$Metadata}
  Rdc-DeviceRegistration $Metadata
  $pin=$Metadata.deviceRegistration
  $expected=Join-Path $Root ('device-registrations\'+$OperationId+'\registration.json')
  if($pin.path -ine $expected){throw 'V9_IMAGE_FRESH_OPERATION_REGISTRATION'}
  $registration=Get-AiccRecoveryDeviceRegistration -Path $pin.path -Sha256 $pin.sha256 -DeviceId $Metadata.deviceId -RdcHost $Metadata.rdcHost
  # The immutable module has authenticated envelope/challenge/machine/host,
  # official original output handle, time window and complete probe ancestry.
  $lines=@($registration.evidence.output.response.content|Where-Object type -ceq 'text'|ForEach-Object text) -join [char]10
  $proofs=@($lines -split '\r?\n'|Where-Object {$_ -match '^\{.*"schema"\s*:\s*"aicc-rdc-device-probe/v1".*\}$'})
  if($proofs.Count -ne 1){throw 'V9_IMAGE_OFFICIAL_PROBE_REQUIRED'}
  $probe=$proofs[0]|ConvertFrom-Json -DateKind String
  $c=W49-Convention $Metadata.contract
  $rows=@($probe.ancestry|Select-Object -SkipLast 1|Where-Object { $_.image -ieq $c.path -and $_.imageSha256 -ceq $c.sha256 })
  if($rows.Count -ne 1 -or -not (Rdc-SameProcess $probe.ancestry[-1] $Metadata.rdcHost)){throw 'V9_IMAGE_REGISTERED_ANCESTRY_REQUIRED'}
  return @{registrationSha256=$pin.sha256;challengeSha256=$registration.challengeSha256;probeImage=$rows[0];rdcHost=$Metadata.rdcHost;deviceId=$Metadata.deviceId}
}
function W49-HeldAcl($Handle,[bool]$Directory) {
  $acl=if($Directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
  $acl.SetSecurityDescriptorBinaryForm([AiccRegisteredImageV9.Native]::Security($Handle),[Security.AccessControl.AccessControlSections]'Access,Owner,Group')
  return $acl
}
function W49-TrustedAcl($Acl,[bool]$Directory,$Convention) {
  $trusted=@($Convention.ownerSid,'S-1-5-18','S-1-5-32-544')
  $owner=$Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($Directory){if($owner -cnotin $trusted){throw 'V9_IMAGE_PARENT_OWNER'}}elseif($owner -cne $Convention.ownerSid -or (W42-AclHash $Acl) -cne $Convention.aclSha256){throw 'V9_IMAGE_OWNER_ACL_CAS'}
  $rules=@($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if($rules.Count -eq 0){throw 'V9_IMAGE_DACL_UNKNOWN'}
  # Directory CreateDirectories alone cannot replace a held existing child.
  $danger=[long][Security.AccessControl.FileSystemRights]'WriteData,WriteExtendedAttributes,WriteAttributes,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
  if(-not $Directory){$danger=$danger -bor [long][Security.AccessControl.FileSystemRights]::AppendData}
  $danger=$danger -bor 0x50000000
  foreach($rule in $rules){
    if($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){continue}
    if($rule.IdentityReference.Value -cnotin $trusted -and ([long]$rule.FileSystemRights -band $danger)){throw 'V9_IMAGE_FOREIGN_MUTATION_AUTHORITY'}
  }
  return @{ownerSid=$owner;aclSha256=(W42-AclHash $Acl);protected=$Acl.AreAccessRulesProtected}
}
function W49-OpenImage($Metadata) {
  Initialize-V9ImageIdentity
  $convention=W49-Convention $Metadata.contract
  $registered=W49-RegisteredProof $Metadata
  $resources=[Collections.Generic.List[IDisposable]]::new()
  $files=[Collections.Generic.List[object]]::new();$parents=[Collections.Generic.List[object]]::new()
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  try{
    $links=@([AiccRegisteredImageV9.Native]::HardLinks($convention.path))
    if($links.Count -lt 2 -or @($links|Where-Object {$_ -ieq $convention.path}).Count -ne 1){throw 'V9_IMAGE_HARDLINK_PROVENANCE'}
    $firstId=$null
    foreach($path in $links){
      if($path -ine $convention.path -and -not $path.StartsWith('C:\WINDOWS\WinSxS\',[StringComparison]::OrdinalIgnoreCase)){throw 'V9_IMAGE_FOREIGN_HARDLINK'}
      for($cursor=Split-Path -Parent $path;$cursor;$cursor=Split-Path -Parent $cursor){
        if($seen.Add($cursor)){
          $item=Get-Item -LiteralPath $cursor -Force
          if(-not $item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'V9_IMAGE_PARENT_LINK'}
          $h=[AiccRegisteredImageV9.Native]::Directory($cursor);$resources.Add($h)
          $id=[AiccRegisteredImageV9.Native]::Identity($h,$cursor,$true)
          $pin=W49-TrustedAcl (W49-HeldAcl $h $true) $true $convention
          $parents.Add(@{path=$cursor;handle=$h;fileId=$id;pin=$pin})
        }
        $up=Split-Path -Parent $cursor;if(-not $up -or $up -eq $cursor){break}
      }
      $item=Get-Item -LiteralPath $path -Force
      if($item.PSIsContainer -or $item.LinkType -cne 'HardLink' -or $item.Attributes -ne [IO.FileAttributes]::Archive){throw 'V9_IMAGE_TYPE'}
      $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$resources.Add($stream)
      $id=[AiccRegisteredImageV9.Native]::Identity($stream.SafeFileHandle,$path,$false)
      if($null -eq $firstId){$firstId=$id}
      if($id -cne $firstId -or [AiccRegisteredImageV9.Native]::Links($stream.SafeFileHandle) -ne $links.Count){throw 'V9_IMAGE_LINK_ID_CAS'}
      $pin=W49-TrustedAcl (W49-HeldAcl $stream.SafeFileHandle $false) $false $convention
      if((W44-StreamHash $stream) -cne $convention.sha256){throw 'V9_IMAGE_BYTES_CAS'}
      $files.Add(@{path=$path;stream=$stream;fileId=$id;pin=$pin})
    }
    $lease=@{convention=$convention;registration=$registered;resources=$resources;files=$files;parents=$parents;links=$links;fileId=$firstId}
    $lease.proof=W49-ImageSnapshot $lease
    return $lease
  }catch{
    for($i=$resources.Count-1;$i -ge 0;$i--){$resources[$i].Dispose()}
    throw
  }
}
function W49-ImageSnapshot($Lease) {
  $c=$Lease.convention;$actualLinks=@([AiccRegisteredImageV9.Native]::HardLinks($c.path))
  if((W46-Canonical $actualLinks) -cne (W46-Canonical $Lease.links)){throw 'V9_IMAGE_LINK_SET_CAS'}
  $parentPins=@(foreach($row in $Lease.parents){
    if([AiccRegisteredImageV9.Native]::Identity($row.handle,$row.path,$true) -cne $row.fileId){throw 'V9_IMAGE_PARENT_ID_CAS'}
    $pin=W49-TrustedAcl (W49-HeldAcl $row.handle $true) $true $c
    if((W46-Canonical $pin) -cne (W46-Canonical $row.pin)){throw 'V9_IMAGE_PARENT_ACL_CAS'}
    @{path=$row.path;fileId=$row.fileId;ownerSid=$pin.ownerSid;aclSha256=$pin.aclSha256;protected=$pin.protected}
  })
  foreach($row in $Lease.files){
    if([AiccRegisteredImageV9.Native]::Identity($row.stream.SafeFileHandle,$row.path,$false) -cne $Lease.fileId -or [AiccRegisteredImageV9.Native]::Links($row.stream.SafeFileHandle) -ne $actualLinks.Count){throw 'V9_IMAGE_LINK_ID_CAS'}
    $pin=W49-TrustedAcl (W49-HeldAcl $row.stream.SafeFileHandle $false) $false $c
    if((W46-Canonical $pin) -cne (W46-Canonical $row.pin) -or (W44-StreamHash $row.stream) -cne $c.sha256){throw 'V9_IMAGE_HELD_BYTES_ACL_CAS'}
  }
  $signature=Get-AuthenticodeSignature -LiteralPath $c.path
  if($signature.Status.ToString() -cne $c.signatureStatus -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -cne $c.signerThumbprint -or $signature.SignerCertificate.Subject -cne $c.signerSubject){throw 'V9_IMAGE_SIGNATURE_CAS'}
  @{schema='aicc-held-registered-system-image/v1';path=$c.path;sha256=$c.sha256;ownerSid=$c.ownerSid;aclSha256=$c.aclSha256;fileId=$Lease.fileId;links=$actualLinks;linkCount=$actualLinks.Count;parents=$parentPins;signatureStatus=$signature.Status.ToString();signerThumbprint=$signature.SignerCertificate.Thumbprint;registration=$Lease.registration}
}
function W49-EnsureImage($Metadata,[switch]$Capture) {
  $null=W49-Convention $Metadata.contract
  $registered=W49-RegisteredProof $Metadata
  if($null -eq $script:W49ImageLease){$script:W49ImageLease=W49-OpenImage $Metadata}
  $lease=$script:W49ImageLease
  if((W46-Canonical $registered) -cne (W46-Canonical $lease.registration)){throw 'V9_IMAGE_REGISTRATION_CAS'}
  $proof=W49-ImageSnapshot $lease
  if((W46-Canonical $proof) -cne (W46-Canonical $lease.proof)){throw 'V9_IMAGE_HELD_PROOF_CAS'}
  if(-not $Capture){
    if(-not $Metadata.PSObject.Properties['registeredSystemImageProof'] -or (W46-Canonical $Metadata.registeredSystemImageProof) -cne (W46-Canonical $proof)){throw 'V9_IMAGE_OPERATION_PROOF_CAS'}
  }
  return $proof
}
function W49-RegisteredIdentity([int]$ProcessId,$Metadata) {
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProcessId)
  if(-not $p -or -not $p.CommandLine -or -not $p.ExecutablePath){throw 'RDC process identity unavailable'}
  if($p.ExecutablePath -ine 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe'){return (Rdc-Identity $ProcessId)}
  if($ProcessId -eq $Metadata.rdcHost.pid){throw 'V9_IMAGE_REGISTERED_ANCESTOR_ONLY'}
  $proof=W49-EnsureImage $Metadata
  $row=@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;createdTicks=$p.CreationDate.ToUniversalTime().Ticks.ToString();image=$proof.path;imageSha256=$proof.sha256;commandSha256=(Rdc-TextHash ([string]$p.CommandLine))}
  $again=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProcessId)
  if(-not $again -or -not $again.CommandLine -or -not $again.ExecutablePath -or $again.ParentProcessId -ne $row.parentPid -or $again.CreationDate.ToUniversalTime().Ticks.ToString() -cne $row.createdTicks -or $again.ExecutablePath -ine $row.image -or (Rdc-TextHash ([string]$again.CommandLine)) -cne $row.commandSha256){throw 'V9_IMAGE_PROCESS_CAS'}
  return $row
}
function Rdc-Identity([int]$ProcessId) {
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProcessId)
  if(-not $p -or -not $p.CommandLine -or -not $p.ExecutablePath){throw 'RDC process identity unavailable'}
  @{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;createdTicks=$p.CreationDate.ToUniversalTime().Ticks.ToString();image=(Rdc-Regular $p.ExecutablePath);imageSha256=(Get-Sha256 $p.ExecutablePath);commandSha256=(Rdc-TextHash ([string]$p.CommandLine))}
}
function Rdc-SameProcess($A,$B) {
  $A.pid -eq $B.pid -and $A.parentPid -eq $B.parentPid -and $A.createdTicks -ceq $B.createdTicks -and $A.image -ieq $B.image -and $A.imageSha256 -ceq $B.imageSha256 -and $A.commandSha256 -ceq $B.commandSha256
}
function Rdc-Time([string]$Value) {
  $time=[DateTimeOffset]::Parse($Value)
  if($Value -cne $time.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")){throw 'Canonical UTC milliseconds expiry required'}
  return $time
}
function Rdc-Ancestry($Metadata) {
  $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -in @(10100,10101,17841))
  $blocked=@($listeners.OwningProcess)
  $rows=@();$cursor=$PID;$found=$false
  for($depth=0;$cursor -gt 0 -and $depth -lt 16;$depth++){
    $row=W49-RegisteredIdentity $cursor $Metadata
    if($cursor -in $blocked){throw 'RDC ancestry depends on the affected model route'}
    $rows+=@($row)
    if($cursor -eq $Metadata.rdcHost.pid){
      if(-not (Rdc-SameProcess $row $Metadata.rdcHost)){throw 'RDC host process changed'}
      $found=$true;break
    }
    $cursor=[int]$row.parentPid
  }
  if(-not $found){throw 'Worker was not started under the pinned RDC host'}
  return ,$rows
}
function Rdc-DeviceRegistration($Metadata) {
  if(-not $Metadata.PSObject.Properties['deviceRegistration']){throw 'V2 requires fresh exact registration for every device'}
  $module=Rdc-Regular (Join-Path $PSScriptRoot 'Recovery-DeviceBinding.psm1')
  $pin=$Metadata.deviceRegistration
  if($pin.modulePath -ine $module -or $pin.moduleSha256 -cne (Get-Sha256 $module)){throw 'Pinned recovery device module changed'}
  Import-Module -Name $module -Force
  Assert-AiccRecoveryDeviceMetadata -Metadata $Metadata
}

# V2: only fresh operation-private storage receives ACL changes. Existing
# parent/home/runtime ACLs and the managed sandbox group remain unchanged.

function Initialize-V4HandleIdentity {
  if(-not ('AiccPrivateV4.HandleIdentity' -as [type])){
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace AiccPrivateV4 {
 public static class HandleIdentity {
  [StructLayout(LayoutKind.Sequential)] struct Info {
   public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;
   public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder p,uint n,uint f);
  public static string Check(FileStream stream,string expected) {
   Info i;if(!GetFileInformationByHandle(stream.SafeFileHandle,out i))throw new IOException("HANDLE_IDENTITY_UNKNOWN");
   if(i.Links!=1 || (i.Attributes & 0x400)!=0)throw new IOException("HANDLE_LINK_REFUSED");
   var path=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(stream.SafeFileHandle,path,(uint)path.Capacity,0);
   if(n==0 || n>=path.Capacity)throw new IOException("HANDLE_PATH_UNKNOWN");
   string actual=path.ToString();if(actual.StartsWith(@"\\?\"))actual=actual.Substring(4);
   if(!String.Equals(Path.GetFullPath(actual),Path.GetFullPath(expected),StringComparison.OrdinalIgnoreCase))throw new IOException("HANDLE_PATH_CAS");
   return i.Volume.ToString("x8")+":"+i.IndexHigh.ToString("x8")+i.IndexLow.ToString("x8");
  }
 }
}
'@ | Out-Null
  }
}



# V6 source access is an exact pinned provenance contract. Private storage
# continues to use the separate, unchanged owner+SYSTEM-only ACL policy.
function W46-NoLinks([string]$Path) {
  for($cursor=[IO.Path]::GetFullPath($Path);$cursor;$cursor=Split-Path -Parent $cursor){
    $item=Get-Item -LiteralPath $cursor -Force
    if($item.LinkType -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'V6_SOURCE_PATH_LINK'}
    $parent=Split-Path -Parent $cursor;if(-not $parent -or $parent -eq $cursor){break}
  }
}

function W46-Canonical($Value) {
  if($null -eq $Value){return 'null'}
  if($Value -is [Collections.IDictionary]){
    [string[]]$keys=@($Value.Keys);[Array]::Sort($keys,[StringComparer]::Ordinal)
    return '{'+(@(foreach($key in $keys){($key|ConvertTo-Json -Compress)+':'+(W46-Canonical $Value[$key])}) -join ',')+'}'
  }
  if($Value -is [pscustomobject]){
    [string[]]$keys=@($Value.PSObject.Properties.Name);[Array]::Sort($keys,[StringComparer]::Ordinal)
    return '{'+(@(foreach($key in $keys){($key|ConvertTo-Json -Compress)+':'+(W46-Canonical $Value.$key)}) -join ',')+'}'
  }
  if($Value -is [Collections.IList]){return '['+(@(foreach($item in $Value){W46-Canonical $item}) -join ',')+']'}
  return ($Value|ConvertTo-Json -Depth 48 -Compress)
}

function W46-DocumentPin($Contract) {
  $pin=$Contract.sourceAccessDocument
  $expected=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\ocx-control-plane-repair-20261026\SOURCE-ACCESS-CONVENTION-v2.json'
  if((W41-Path $pin.path) -ine (W41-Path $expected) -or $pin.sha256 -cne '4635a073ba3dda7e2f91fce65fd3444b46389ca23e3831f453b52934f700afd6'){throw 'V6_SOURCE_ACCESS_DOCUMENT_PIN'}
  W46-NoLinks $pin.path
  $s=[IO.File]::Open($pin.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{
    if((W44-StreamHash $s) -cne $pin.sha256){throw 'V6_SOURCE_ACCESS_DOCUMENT_CAS'}
    $reader=[IO.StreamReader]::new($s,[Text.UTF8Encoding]::new($false,$true),$true,4096,$true)
    try{$document=$reader.ReadToEnd()|ConvertFrom-Json -DateKind String}finally{$reader.Dispose()}
    if((W46-Canonical $document) -cne (W46-Canonical $Contract.sourceAccess)){throw 'V6_SOURCE_ACCESS_DOCUMENT_CONTENT_CAS'}
  }finally{$s.Dispose()}
}
function W46-ExpectedRule($Rule) {
  if($Rule.isInherited -isnot [bool] -or $Rule.rights -isnot [long] -and $Rule.rights -isnot [int] -or $Rule.type -cne 'Allow'){throw 'V6_SOURCE_RULE_SCHEMA'}
  $inherit=[Security.AccessControl.InheritanceFlags]$Rule.inheritance
  $prop=[Security.AccessControl.PropagationFlags]$Rule.propagation
  return ([string]$Rule.sid)+'|'+$Rule.type+'|'+([long]$Rule.rights)+'|'+([int]$inherit)+'|'+([int]$prop)+'|'+$Rule.isInherited.ToString()
}
function W46-ActualRule($Rule) {
  return $Rule.IdentityReference.Value+'|'+$Rule.AccessControlType.ToString()+'|'+([long]$Rule.FileSystemRights)+'|'+([int]$Rule.InheritanceFlags)+'|'+([int]$Rule.PropagationFlags)+'|'+$Rule.IsInherited.ToString()
}
function W46-AclSnapshot($Acl,$Pin) {
  if($Pin.protected -isnot [bool] -or $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Pin.ownerSid -or $Acl.AreAccessRulesProtected -ne $Pin.protected -or (W42-AclHash $Acl) -cne $Pin.aclSha256){throw 'V6_SOURCE_ACL_OWNER_PROTECTION_CAS'}
  $actual=@($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if($actual.Count -ne @($Pin.rules).Count -or $actual.Count -ne 2){throw 'V6_SOURCE_RULE_COUNT_CAS'}
  [string[]]$wanted=@(foreach($r in $Pin.rules){W46-ExpectedRule $r})
  [string[]]$observed=@(foreach($r in $actual){W46-ActualRule $r})
  [Array]::Sort($wanted,[StringComparer]::Ordinal);[Array]::Sort($observed,[StringComparer]::Ordinal)
  for($i=0;$i -lt $wanted.Length;$i++){if($wanted[$i] -cne $observed[$i]){throw 'V6_SOURCE_RULE_PROVENANCE_CAS'}}
}
function W46-CurrentGrant($Acl,[bool]$Inherited,[Security.AccessControl.InheritanceFlags]$Flags) {
  $sid=W42-CurrentSid
  $rules=@($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -ceq $sid})
  if($rules.Count -ne 1){throw 'V6_CURRENT_SID_GRANT_COUNT'}
  $r=$rules[0]
  if($r.AccessControlType -ne 'Allow' -or $r.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $r.IsInherited -ne $Inherited -or $r.InheritanceFlags -ne $Flags -or $r.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){throw 'V6_CURRENT_SID_GRANT_PROVENANCE'}
}
function W46-GrantParents($Access) {
  $grantHomePath=W41-Home;$runtime=Join-Path $grantHomePath 'runtime';$sid=W42-CurrentSid
  if(@($Access.parents).Count -ne 2 -or (W41-Path $Access.parents[0].path) -ine (W41-Path $grantHomePath) -or (W41-Path $Access.parents[1].path) -ine (W41-Path $runtime) -or (W41-Path (Split-Path -Parent $runtime)) -ine (W41-Path $grantHomePath)){throw 'V6_GRANT_PARENT_ANCESTRY'}
  for($i=0;$i -lt 2;$i++){
    $pin=$Access.parents[$i];$mustProtect=$i -eq 0
    if($pin.ownerSid -cne $sid -or $pin.protected -isnot [bool] -or $pin.protected -ne $mustProtect){throw 'V6_GRANT_PARENT_SCHEMA'}
    W46-NoLinks $pin.path;$item=Get-Item -LiteralPath $pin.path -Force
    if(-not $item.PSIsContainer){throw 'V6_GRANT_PARENT_TYPE'}
    $acl=Get-Acl -LiteralPath $pin.path
    W46-AclSnapshot $acl $pin
    W46-CurrentGrant $acl ($i -ne 0) ([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit')
  }
}
function W44-SourceConvention($Contract) {
  $c=$Contract.sourceAccess;$sid=W42-CurrentSid;$grantHomePath=W41-Home
  W46-DocumentPin $Contract
  if($c.schema -cne 'aicc-existing-source-access-convention/v2' -or $c.currentSid -cne $sid -or $c.noAclOrOwnerMutation -ne $true){throw 'V6_SOURCE_ACCESS_CONVENTION_REQUIRED'}
  $expected=@{config=(Join-Path $grantHomePath 'config.json');descriptor=(Join-Path $grantHomePath 'runtime\windows-command.json');journal=(Join-Path $grantHomePath 'runtime\windows-install.json');marker=(Join-Path $grantHomePath 'runtime\windows-process.json')}
  $names=if($c.sourcePins -is [Collections.IDictionary]){@($c.sourcePins.Keys)}else{@($c.sourcePins.PSObject.Properties.Name)}
  if($names.Count -ne 4){throw 'V6_SOURCE_ACCESS_PIN_SET'}
  foreach($name in $expected.Keys){
    $pin=$c.sourcePins.$name;$owner=if($name -ceq 'marker'){$sid}else{'S-1-5-32-544'}
    $parent=if($name -ceq 'config'){$grantHomePath}else{Join-Path $grantHomePath 'runtime'}
    if((W41-Path $pin.path) -ine (W41-Path $expected[$name]) -or (W41-Path (Split-Path -Parent $pin.path)) -ine (W41-Path $parent) -or $pin.ownerSid -cne $owner -or $pin.currentSidFullControlInherited -isnot [bool] -or $pin.currentSidFullControlInherited -ne $true -or $pin.currentSidFullControlExplicit -isnot [bool] -or $pin.currentSidFullControlExplicit -ne $false -or $pin.protected -isnot [bool] -or $pin.protected -ne $false -or (W41-Path $pin.fullControlGrantOrigin) -ine (W41-Path $grantHomePath) -or $pin.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $pin.aclSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'V6_SOURCE_ACCESS_PIN_BINDING'}
  }
  W46-GrantParents $c
  $script:V6SourceAccess=$c;$script:V6SourceContract=$Contract
}
function W44-SourceAcl($Acl,$Pin) {
  # Every capture/commit/known restore calls this while its existing source
  # or target handle is held. No inherited grants are admitted in Private().
  W46-DocumentPin $script:V6SourceContract
  W46-GrantParents $script:V6SourceAccess
  $name=$null
  foreach($candidate in @('config','descriptor','journal','marker')){
    $bound=$script:V6SourceAccess.sourcePins.$candidate
    if((W41-Path $bound.path) -ieq (W41-Path $Pin.path)){$name=$candidate;break}
  }
  if(-not $name){throw 'V6_SOURCE_ACCESS_PIN_BINDING'}
  $bound=$script:V6SourceAccess.sourcePins.$name
  if($Pin.ownerSid -cne $bound.ownerSid -or $Pin.aclSha256 -cne $bound.aclSha256 -or $Pin.sha256 -cne $bound.sha256){throw 'V6_SOURCE_ACCESS_PIN_BINDING'}
  W46-NoLinks $bound.path
  W46-AclSnapshot $Acl $bound
  W46-CurrentGrant $Acl $true ([Security.AccessControl.InheritanceFlags]::None)
}

function W44-StreamHash($Stream) {
  $Stream.Position=0;$digest=[Security.Cryptography.SHA256]::Create()
  try{$value=[Convert]::ToHexString($digest.ComputeHash($Stream)).ToLowerInvariant();$Stream.Position=0;return $value}finally{$digest.Dispose()}
}

function W42-AclHash($Acl) {
  Rdc-TextHash ($Acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Access,Owner,Group'))
}
function W42-CurrentSid { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
function W42-PrivateAcl([string]$Path,[bool]$Directory,[string]$ExpectedHash='') {
  W41-SafeDirectory $(if($Directory){$Path}else{Split-Path -Parent $Path})
  $item=Get-Item -LiteralPath $Path -Force
  if($item.PSIsContainer -ne $Directory -or $item.LinkType -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'W42_PRIVATE_PATH_TYPE'}
  $acl=Get-Acl -LiteralPath $Path;$sid=W42-CurrentSid
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid){throw 'W42_PRIVATE_OWNER'}
  if($Directory -and -not $acl.AreAccessRulesProtected){throw 'W42_PRIVATE_INHERITANCE'}
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$seen=@{}
  if($rules.Count -ne 2){throw 'W42_PRIVATE_EXACT_TWO_RULES'}
  foreach($rule in $rules){
    $identity=$rule.IdentityReference.Value
    if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $identity -notin @($sid,'S-1-5-18') -or $seen.ContainsKey($identity) -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){throw 'W42_PRIVATE_RULE'}
    if($Directory -and $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'){throw 'W42_PRIVATE_CHILD_INHERITANCE'}
    $seen[$identity]=$true
  }
  $hash=W42-AclHash $acl
  if($ExpectedHash -and $hash -cne $ExpectedHash){throw 'W42_PRIVATE_ACL_CAS'}
  return $hash
}
function W42-Parents($Policy) {
  $expectedRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\webgpt-remote-recovery'
  if($Policy.schema -cne 'aicc-operation-private-preimages/v2' -or (W41-Path $Policy.ownerStateRoot) -ine (W41-Path $expectedRoot) -or $Root -ine (W41-Path $expectedRoot) -or $Policy.ownerSid -cne (W42-CurrentSid) -or $Policy.containerRelativeTemplate -cne 'operations/{operationId}' -or $Policy.backupRelativePath -cne 'preimages' -or $Policy.aclPolicy -cne 'current-owner-and-SYSTEM-FullControl-only'){throw 'W42_UNREGISTERED_PRIVATE_STORAGE'}
  $cursor=[IO.DirectoryInfo]::new((Join-Path $expectedRoot 'operations'));$index=0
  $ownerBoundary=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
  while($cursor){
    if($index -ge @($Policy.parentPins).Count){throw 'W42_PARENT_CHAIN_INCOMPLETE'}
    $pin=$Policy.parentPins[$index]
    if((W41-Path $pin.path) -ine (W41-Path $cursor.FullName)){throw 'W42_PARENT_PATH_CAS'}
    W41-SafeDirectory $cursor.FullName
    $item=Get-Item -LiteralPath $cursor.FullName -Force;$acl=Get-Acl -LiteralPath $cursor.FullName
    if(-not $item.PSIsContainer -or $item.LinkType -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $pin.ownerSid -or (W42-AclHash $acl) -cne $pin.aclSha256){throw 'W42_PARENT_OWNER_ACL_CAS'}
    if((W41-Path $cursor.FullName) -ieq (W41-Path $ownerBoundary) -or $cursor.FullName.StartsWith($ownerBoundary+'\',[StringComparison]::OrdinalIgnoreCase)){
      if($pin.ownerSid -cne (W42-CurrentSid)){throw 'W42_OWNER_STATE_PARENT_OWNER'}
      foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
        if($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){continue}
        $danger=[long][Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
        $danger=$danger -bor 0x50000000
        if($rule.IdentityReference.Value -notin @((W42-CurrentSid),'S-1-5-18','S-1-5-32-544') -and ([long]$rule.FileSystemRights -band $danger)){throw 'W42_FOREIGN_PARENT_MUTATION_AUTHORITY'}
      }
    }
    $cursor=$cursor.Parent;$index++
  }
  if($index -ne @($Policy.parentPins).Count){throw 'W42_EXTRA_PARENT_PIN'}
}
function W42-NewPrivateDirectory([string]$Path,$Policy) {
  W42-Parents $Policy;W41-SafeDirectory $Path
  if(Test-Path -LiteralPath $Path){throw 'W42_NEVER_REUSE_PRIVATE_CONTAINER'}
  # The newly created directory is EMPTY until its exact ACL is established.
  $null=New-Item -ItemType Directory -Path $Path
  $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($owner);$acl.SetAccessRuleProtection($true,$false)
  foreach($identity in @($owner,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  }
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path),$acl)
  W42-Parents $Policy
  return (W42-PrivateAcl $Path $true)
}
function W42-SharedDirectories([string]$HomePath) {
  $pins=@()
  foreach($path in @($HomePath,(Join-Path $HomePath 'runtime'),(Join-Path $HomePath 'versions'))){
    W41-SafeDirectory $path;$acl=Get-Acl -LiteralPath $path
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne (W42-CurrentSid)){throw 'W42_SHARED_DIRECTORY_OWNER'}
    $pins+=@(@{path=(W41-Path $path);ownerSid=(W42-CurrentSid);aclSha256=(W42-AclHash $acl)})
  }
  return ,$pins
}
function W42-Storage($Metadata) {
  W42-Parents $Metadata.contract.privateStorage
  W44-SourceConvention $Metadata.contract;Initialize-V4HandleIdentity
  if(($Metadata -is [Collections.IDictionary] -and -not $Metadata.Contains('privateStorage')) -or ($Metadata -isnot [Collections.IDictionary] -and -not $Metadata.PSObject.Properties['privateStorage'])){throw 'W42_PRIVATE_STORAGE_METADATA_REQUIRED'}
  $storage=$Metadata.privateStorage;$dir=W41-Path (Operation-Dir);$backup=Join-Path $dir 'preimages'
  if((W41-Path $storage.container) -ine $dir -or (W41-Path $storage.backup) -ine $backup -or $storage.ownerSid -cne (W42-CurrentSid)){throw 'W42_PRIVATE_STORAGE_PATH_OWNER_CAS'}
  $null=W42-PrivateAcl $dir $true $storage.containerAclSha256;$null=W42-PrivateAcl $backup $true $storage.backupAclSha256
  foreach($pin in $Metadata.sharedDirectoryPins){
    W41-SafeDirectory $pin.path;$acl=Get-Acl -LiteralPath $pin.path
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $pin.ownerSid -or (W42-AclHash $acl) -cne $pin.aclSha256){throw 'W42_EXISTING_SHARED_ACL_OR_OWNER_CHANGED'}
  }
  $expected=[ordered]@{config=(Join-Path $Metadata.home 'config.json');descriptor=(Join-Path $Metadata.home 'runtime\windows-command.json');journal=(Join-Path $Metadata.home 'runtime\windows-install.json');marker=(Join-Path $Metadata.home 'runtime\windows-process.json')}
  if(@($Metadata.preimages).Count -ne 4 -or @($Metadata.preimages.name|Select-Object -Unique).Count -ne 4){throw 'W42_EXACT_PREIMAGE_SET_REQUIRED'}
  foreach($saved in $Metadata.preimages){
    if(-not $expected.Contains($saved.name) -or (W41-Path $saved.path) -ine (W41-Path $expected[$saved.name]) -or (W41-Path $saved.backup) -ine (Join-Path $backup ($saved.name+'.preimage')) -or $saved.ownerSid -cne (W42-CurrentSid)){throw 'W42_PREIMAGE_PATH_OWNER_CAS'}
    $null=W42-PrivateAcl $saved.backup $false $saved.aclSha256
    if(($saved.bytes -isnot [long] -and $saved.bytes -isnot [int]) -or (Get-Item -LiteralPath $saved.backup -Force).Length -ne $saved.bytes){throw 'W42_PREIMAGE_LENGTH_CAS'}
    W41-HashPin $saved.backup $saved.sha256
    # Normal stop may remove the live marker; its private preimage is retained.
    if($saved.name -eq 'marker' -and -not (Test-Path -LiteralPath $saved.path)){continue}
    $source=Rdc-Regular $saved.path
    $pin=$Metadata.contract.sourceAccess.sourcePins.($saved.name)
    if($saved.sourceOwnerSid -cne $pin.ownerSid -or $saved.sourceAclSha256 -cne $pin.aclSha256 -or $saved.sha256 -cne $pin.sha256){throw 'V4_SOURCE_METADATA_CAS'}
    if($saved.name -ceq 'marker'){
      if((Get-Acl -LiteralPath $source).GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $saved.sourceOwnerSid){throw 'V4_SOURCE_OWNER_ACL_CAS'}
      continue
    }
    $held=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    try{
      W44-SourceAcl ([IO.FileSystemAclExtensions]::GetAccessControl($held)) $pin
      if([AiccPrivateV4.HandleIdentity]::Check($held,$source) -cne $saved.sourceFileId){throw 'V4_SOURCE_HANDLE_CAS'}
    }finally{$held.Dispose()}
  }
}

function W42-CapturePreimages($Metadata,$Targets) {
  W44-SourceConvention $Metadata.contract;Initialize-V4HandleIdentity
  $dir=Operation-Dir;$policy=$Metadata.contract.privateStorage
  foreach($entry in $Targets.GetEnumerator()){
    $pin=$Metadata.contract.sourceAccess.sourcePins.($entry.Key)
    $source=Rdc-Regular $entry.Value;W44-SourceAcl (Get-Acl -LiteralPath $source) $pin;W41-HashPin $source $pin.sha256
  }
  $containerHash=W42-NewPrivateDirectory $dir $policy
  $backup=Join-Path $dir 'preimages';$backupHash=W42-NewPrivateDirectory $backup $policy
  $Metadata.privateStorage=@{container=$dir;backup=$backup;ownerSid=(W42-CurrentSid);containerAclSha256=$containerHash;backupAclSha256=$backupHash}
  foreach($entry in $Targets.GetEnumerator()){
    W42-Parents $policy;$null=W42-PrivateAcl $dir $true $containerHash;$null=W42-PrivateAcl $backup $true $backupHash
    $pin=$Metadata.contract.sourceAccess.sourcePins.($entry.Key)
    $source=Rdc-Regular $entry.Value;$saved=Join-Path $backup ($entry.Key+'.preimage')
    $inputStream=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
      $fileId=[AiccPrivateV4.HandleIdentity]::Check($inputStream,$source)
      W44-SourceAcl ([IO.FileSystemAclExtensions]::GetAccessControl($inputStream)) $pin
      if((W44-StreamHash $inputStream) -cne $pin.sha256){throw 'V4_SOURCE_BYTES_CAS'}
      $output=[IO.File]::Open($saved,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try{
        $fileAclHash=W42-PrivateAcl $saved $false
        $length=$inputStream.Length;$inputStream.CopyTo($output);$output.Flush($true)
      }finally{$output.Dispose()}
      if([AiccPrivateV4.HandleIdentity]::Check($inputStream,$source) -cne $fileId -or (W44-StreamHash $inputStream) -cne $pin.sha256){throw 'V4_SOURCE_HANDLE_CAS'}
      W44-SourceAcl ([IO.FileSystemAclExtensions]::GetAccessControl($inputStream)) $pin
      $null=W42-PrivateAcl $saved $false $fileAclHash;W41-HashPin $saved $pin.sha256
      if((Get-Item -LiteralPath $saved).Length -ne $length){throw 'W42_CAPTURE_CAS_CHANGED'}
      $Metadata.preimages+=@(@{name=$entry.Key;path=$source;backup=$saved;sha256=$pin.sha256;bytes=$length;ownerSid=(W42-CurrentSid);sourceOwnerSid=$pin.ownerSid;sourceFileId=$fileId;aclSha256=$fileAclHash;sourceAclSha256=$pin.aclSha256})
    }finally{$inputStream.Dispose()}
  }
  W42-Storage ([pscustomobject]$Metadata)
}

function W42-InstallerStorageGate {
  $contract=if($RuntimeContractPath){Read-Json $RuntimeContractPath}else{(Read-Json (Operation-File 'metadata.json')).contract}
  W44-SourceConvention $contract
  $storage=$contract.installerPrivateStorage
  if($storage.sourceAccessSchema -cne 'aicc-existing-source-access-convention/v2' -or $contract.capabilities.exactInheritedSourceGrantProvenance -ne $true){throw 'V6_INHERITED_GRANT_CONTRACT_REQUIRED'}
  if($storage.writeStrategy -cne 'held-existing-file-ReadWrite-ShareRead-v4' -or $contract.capabilities.preserveExistingFileObject -ne $true){throw 'V4_EXISTING_OBJECT_COMMIT_REQUIRED'}
  if($storage.schema -cne 'aicc-installer-private-reference/v2' -or $storage.supported -ne $true -or $storage.externalPrivateDirectoryOption -ne $true -or $contract.capabilities.operationPrivateInstaller -ne $true){throw 'W42_PRIVATE_INSTALLER_CONTRACT_REQUIRED'}
  W41-HashPin $contract.installerPath $contract.installerSha256
  W41-HashPin (Join-Path $contract.bundleRoot 'app\maintenance\private-storage-guard-v7.ps1') $storage.guardSha256
  W41-HashPin (Join-Path $contract.bundleRoot 'app\maintenance\private-preimages-v7.ts') $storage.privateModuleSha256
  W41-HashPin (Join-Path $contract.bundleRoot 'app\maintenance\windows-runtime-v7.ts') $storage.maintenanceSha256
}
# V10 dedicated lifecycle; V9 and its exact numeric idle contract are immutable.
function V10-Has($o,[string]$key){if($o -is [Collections.IDictionary]){return $o.Contains($key)};return $null -ne $o.PSObject.Properties[$key]}
function V10-Ref($r){W46-NoLinks $r.path;W41-HashPin $r.path $r.sha256;return (Read-Json $r.path)}
function V10-Turn($p,[string]$thread,[bool]$latest){
 $path=Rdc-Regular $p.rolloutPath;Assert-PathUnder $path (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\sessions')
 if($p.threadId -cne $thread -or [IO.Path]::GetFileName($path) -notlike ('*'+$thread+'.jsonl') -or $p.turnId -cnotmatch '^[a-f0-9-]{36}$'){throw 'V10_TURN_BINDING'}
 $states=@{};$last=$null;$session=$false
 foreach($line in [IO.File]::ReadLines($path)){
  $e=$line|ConvertFrom-Json -DateKind String
  if($e.type -ceq 'session_meta' -and $e.payload.id -ceq $thread){$session=$true}
  if($e.type -cne 'event_msg'){continue};$v=$e.payload
  if($v.type -ceq 'task_started'){$last=[string]$v.turn_id;$states[$last]='ACTIVE'}
  elseif($v.type -ceq 'task_complete'){$states[[string]$v.turn_id]='COMPLETE';if((V10-Has $v 'error') -and $null -ne $v.error){$states[[string]$v.turn_id]='FAILED'}}
  elseif($v.type -in @('turn_aborted','task_failed','error')){if(V10-Has $v 'turn_id'){$states[[string]$v.turn_id]='FAILED'}elseif($last){$states[$last]='FAILED'}}
 }
 if(-not $session -or -not $states.ContainsKey($p.turnId) -or $states[$p.turnId] -cne 'COMPLETE' -or ($latest -and ($last -cne $p.turnId -or @($states.Values|Where-Object {$_ -ceq 'ACTIVE'}).Count -gt 0))){throw 'V10_NORMAL_COMPLETION_REQUIRED'}
}
function V10-Policy($c){
 $p=$c.lifecycle
 if($p.schema -cne 'aicc-legacy17841-planned-maintenance/v1' -or $p.mode -cne 'planned-maintenance-stop' -or $p.target -cne '17841-only' -or $null -ne $p.unknownCount -or $p.lastResult -cne 'UNCONFIRMED_PRESERVED' -or $p.sourceThreadId -cne '01a17e0e-4732-7f71-b7e6-6f42b49b215f' -or $p.sourceTurnId -cne '01a17fc5-308f-7623-ae7f-b2fb957a8559' -or $p.admissionProof -cne 'FUTURE_ROOT_RECORD_REQUIRED'){throw 'V10_IMMUTABLE_LIFECYCLE_REQUIRED'}
}
function V10-Tasks($m,$s){
 $pins=@($s.taskPins);$found=@()
 foreach($t in @(Get-ScheduledTask -ErrorAction Stop)){
  $target=$false
  foreach($a in @($t.Actions)){$text=([string]$a.Execute+' '+[string]$a.Arguments).Replace('/','\');if($text.IndexOf($m.home+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $text -match '(?i)(?:--port(?:=|\s+)|localhost:|127\.0\.0\.1:)17841(?:\s|$|/)'){$target=$true}}
  $p=@($pins|Where-Object {$_.taskPath -ceq $t.TaskPath -and $_.taskName -ceq $t.TaskName})
  if(-not $target -and $p.Count -eq 0){continue}
  if($p.Count -ne 1 -or $t.Settings.Enabled -ne $false -or [string]$t.State -cne 'Disabled'){throw 'V10_RESTART_TASK_NOT_DISABLED'}
  $xml=Export-ScheduledTask -TaskPath $t.TaskPath -TaskName $t.TaskName -ErrorAction Stop
  if((Rdc-TextHash $xml) -cne $p[0].xmlSha256){throw 'V10_TASK_XML_CAS'};$found+=@($t.TaskPath+$t.TaskName)
 }
 if($found.Count -ne $pins.Count){throw 'V10_TASK_INVENTORY_CAS'}
 $quiet=V10-Ref $s.schedulerQuietEvidence
 if($quiet.schema -cne 'aicc-root-cutover-quiet/v1' -or $quiet.operationId -cne $OperationId -or $quiet.controllerThreadId -cne $m.controllerThreadId -or $quiet.noWakeUntil -cne $m.recoveryExpiresAt -or (W46-Canonical $quiet.taskPins) -cne (W46-Canonical $s.taskPins)){throw 'V10_SCHEDULER_QUIET_REQUIRED'}
}
function V10-Descendants($owner){
 $all=@(Get-CimInstance Win32_Process -ErrorAction Stop);$queue=[Collections.Generic.Queue[int]]::new();$queue.Enqueue([int]$owner.pid);$seen=@{};$rows=@()
 while($queue.Count){$id=$queue.Dequeue();if($seen.ContainsKey($id) -or $rows.Count -gt 128){throw 'V10_DESCENDANT_INVENTORY_UNKNOWN'};$seen[$id]=$true
  $row=Rdc-Identity $id
  if($id -eq $owner.pid){if(-not (Rdc-SameProcess $row $owner)){throw 'V10_TARGET_OWNER_CAS'}}else{$rows+=@($row)}
  foreach($p in @($all|Where-Object ParentProcessId -eq $id)){$queue.Enqueue([int]$p.ProcessId)}
 };return ,@($rows|Sort-Object pid)
}
function V10-Scope($m){
 V10-Policy $m.contract;$pin=$m.plannedMaintenanceScope
 if($pin.path -ine (Join-Path $Root ('planned-maintenance\'+$OperationId+'.scope.json'))){throw 'V10_EXACT_SCOPE_PATH_REQUIRED'}
 $s=V10-Ref $pin
 if((Get-Acl -LiteralPath $pin.path).GetOwner([Security.Principal.SecurityIdentifier]).Value -cne (W42-CurrentSid)){throw 'V10_ROOT_SCOPE_OWNER'}
 if($s.schema -cne 'aicc-root-legacy17841-scope/v1' -or $s.operationId -cne $OperationId -or $s.controllerThreadId -cne $m.controllerThreadId -or $s.deviceId -cne $m.deviceId -or $s.helperSha256 -cne $m.workerScriptSha256 -or $s.contractSha256 -cne $m.contractSha256 -or $s.mode -cne 'planned-maintenance-stop' -or $s.target -cne '17841-only' -or $s.operationExpiresAt -cne $m.operationExpiresAt -or $s.recoveryExpiresAt -cne $m.recoveryExpiresAt -or $s.noReplay -ne $true){throw 'V10_SCOPE_BINDING'}
 if((Rdc-Time $s.createdAt) -gt [DateTimeOffset]::UtcNow -or (Rdc-Time $s.createdAt) -lt ([DateTimeOffset]::Parse($m.createdAt)).AddMinutes(-5) -or (Rdc-Time $s.recoveryExpiresAt) -le [DateTimeOffset]::UtcNow){throw 'V10_SCOPE_LEASE'}
 foreach($field in @('activeCount','unknownCount')){if(-not (V10-Has $s $field) -or $null -ne $s.$field){throw 'V10_UNKNOWN_MUST_REMAIN_NULL'}}
 if($s.lastResult -cne 'UNCONFIRMED_PRESERVED' -or $s.reconciliationOwner -cne $m.controllerThreadId -or $s.downstreamDependsOnUnknown -ne $false){throw 'V10_QUARANTINE_REQUIRED'}
 $auth=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\ocx-control-plane-repair-20261026\INSTALL-CONTINUE.md'
 if($s.authorization.path -ine $auth -or $s.authorization.item -ne 3){throw 'V10_EXACT_AUTHORIZATION_REFERENCE'};W41-HashPin $s.authorization.path $s.authorization.sha256
 if($s.sourceCompletion.threadId -cne $m.contract.lifecycle.sourceThreadId -or $s.sourceCompletion.turnId -cne $m.contract.lifecycle.sourceTurnId){throw 'V10_SOURCE_COMPLETION_BINDING'}
 V10-Turn $s.sourceCompletion $s.sourceCompletion.threadId $false
 if(@($s.originalOutcomes).Count -lt 1 -or @($s.knownWork).Count -lt 1){throw 'V10_ACTUAL_WORK_EVIDENCE_REQUIRED'}
 foreach($old in @($s.originalOutcomes)){if($old.state -cne 'UNCONFIRMED_PRESERVED' -or $old.reconciliationOwner -cne $m.controllerThreadId){throw 'V10_ORIGINAL_OUTCOME_BINDING'};W41-HashPin $old.ref.path $old.ref.sha256}
 foreach($work in @($s.knownWork)){
  $w=V10-Ref $work.ref
  if($w.schema -cne 'aicc-root-known-work-release/v1' -or $w.operationId -cne $OperationId -or $w.controllerThreadId -cne $m.controllerThreadId -or $w.workId -cne $work.workId -or $w.expiresAt -cne $m.recoveryExpiresAt){throw 'V10_KNOWN_WORK_RELEASE_BINDING'}
  if($w.state -ceq 'COMPLETED'){V10-Turn $w.completion $w.completion.threadId $true}
  elseif($w.state -ceq 'PRESERVED_OUTSIDE_TARGET'){if($w.affectedService -ceq '17841-only' -or @($w.preservationRefs).Count -eq 0){throw 'V10_KNOWN_ACTIVE_TARGET_REFUSED'};foreach($ref in $w.preservationRefs){W41-HashPin $ref.path $ref.sha256}}
  else{throw 'V10_KNOWN_ACTIVE_TARGET_REFUSED'}
 }
 $g=V10-Ref $s.serviceGeneration.ref
 if($g.bridgePid -ne $s.expectedOwner.pid -or $g.bridgeStartToken -cnotmatch '^[a-f0-9]{64}$' -or $g.bridgeStartToken -cne $s.serviceGeneration.bridgeStartToken -or $g.routeGeneration -cne $s.serviceGeneration.routeGeneration -or $g.routeGeneration -cne ($m.originalVersion+':'+$g.bridgeStartToken.Substring(0,16)) -or [DateTimeOffset]::Parse($g.completedAt).UtcTicks -lt [long]$s.expectedOwner.createdTicks -or [DateTimeOffset]::Parse($g.completedAt) -gt [DateTimeOffset]::UtcNow){throw 'V10_ACTUAL_SERVICE_GENERATION_REQUIRED'}
 if((V10-Has $m 'originalOwner') -and -not (Rdc-SameProcess $s.expectedOwner $m.originalOwner)){throw 'V10_ORIGINAL_OWNER_BINDING'}
 V10-Tasks $m $s;return $s
}
function V10-LiveGate($m,$o,[switch]$Drained){
 $s=V10-Scope $m
 if($o.state -cne 'OWNED' -or -not (Rdc-SameProcess $o.owner $s.expectedOwner) -or $o.unknownEvidenceKnown -ne $false -or $null -ne $o.unknownCount -or $o.legacyUnknownTelemetryAbsent -ne $true){throw 'V10_LEGACY_OWNER_UNKNOWN_CONTRACT'}
 if(@($o.counts).Count -ne 3 -or @($o.counts|Where-Object {(W41-Counter $_) -ne 0}).Count -ne 0){throw 'V10_KNOWN_ACTIVITY_NOT_ZERO'}
 if($o.acceptingTurns -ne (-not $Drained)){throw 'V10_ADMISSION_STATE_CHANGED'}
 if((W46-Canonical (V10-Descendants $o.owner)) -cne (W46-Canonical @($s.descendants|Sort-Object pid))){throw 'V10_NEW_OR_CHANGED_DESCENDANT'};return $s
}
function V10-Release($m,[string]$path,[string]$hash){
 W41-HashPin $path $hash;$r=Read-Json $path;$null=V10-Scope $m
 if($r.released -ne $true -or $r.state -cne 'RELEASED_FOR_MAINTENANCE' -or $r.lifecycleMode -cne 'planned-maintenance-stop' -or $r.plannedMaintenanceScopeSha256 -cne $m.plannedMaintenanceScope.sha256 -or -not (V10-Has $r 'unknownCount') -or $null -ne $r.unknownCount -or $r.lastResult -cne 'UNCONFIRMED_PRESERVED'){throw 'V10_ACTUAL_PLANNED_RELEASE_REQUIRED'}
 V10-Turn $r.controllerCompletion $m.controllerThreadId $true
}
function V10-ActivationProof($m){
 $r=Read-Json (Operation-File 'activate.request.json');$ready=Read-Json (Operation-File 'readiness.json')
 if(-not $r -or -not $ready -or $r.operationId -cne $OperationId -or $r.nonce -cne $Nonce -or $r.metadataSha256 -cne $MetadataSha256){throw 'V10_ORIGINAL_ACTIVATION_PROOF_REQUIRED'}
 W41-RequestProof $m $ready $r.handoffPath $r.handoffSha256 $r.transportReceiptPath $r.transportReceiptSha256
}
function V10-Admin($m,[string]$action){
 if($action -cnotin @('drain','shutdown')){throw 'V10_ADMIN_ACTION_REFUSED'}
 $config=Read-Json (Join-Path $m.home 'config.json');$client=[Net.Http.HttpClient]::new();$client.Timeout=[TimeSpan]::FromSeconds(5)
 try{$request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post,('http://127.0.0.1:17841/admin/'+$action))
  try{$request.Headers.Authorization=[Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',[string]$config.controlToken);$response=$client.SendAsync($request).GetAwaiter().GetResult()
   try{if(-not $response.IsSuccessStatusCode){throw 'V10_AUTHENTICATED_ACTION_REFUSED'};$text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult();if($text.Length -gt 65536){throw 'V10_AUTHENTICATED_ACK_UNKNOWN'};return ($text|ConvertFrom-Json -DateKind String)}finally{$response.Dispose()}
  }finally{$request.Dispose()}
 }finally{$client.Dispose()}
}
function V10-PlannedStop {
 $m=W41-Binding -Activation;V10-ActivationProof $m;$ancestry=Rdc-Ancestry $m;$ready=Read-Json (Operation-File 'readiness.json')
 if(@($ancestry|Where-Object {Rdc-SameProcess $_ $ready.worker}).Count -ne 1){throw 'V10_ORIGINAL_WORKER_CHILD_REQUIRED'}
 $intent=Read-Json (Operation-File 'stop_intent.claim.json')
 if(-not $intent -or $intent.action -cne 'stop' -or $intent.metadataSha256 -cne $MetadataSha256){throw 'V10_EXACT_STOP_INTENT_REQUIRED'}
 $before=W41-Observe $m $m.originalRuntime $m.originalOwner;$scope=V10-LiveGate $m $before;$null=W41-FileSet $m 'original'
 Rdc-New (Operation-File 'planned-stop.claim.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;scopeSha256=$m.plannedMaintenanceScope.sha256;semantics='planned-maintenance-stop';owner=$before.owner;unknownCount=$null;lastResult='UNCONFIRMED_PRESERVED';claimedAt=(UtcNow)}
 $drain=V10-Admin $m 'drain'
 if($drain.accepting_turns -ne $false -or (W41-Counter $drain.active_http_turns) -ne 0 -or (W41-Counter $drain.active_browser_http_turns) -ne 0 -or (W41-Counter $drain.active_browser_turns) -ne 0){throw 'V10_DRAIN_ACK_UNKNOWN'}
 V10-ActivationProof $m;$current=W41-Observe $m $m.originalRuntime $m.originalOwner;$null=V10-LiveGate $m $current -Drained;$null=W41-FileSet $m 'original'
 $null=V10-Admin $m 'shutdown'
 for($i=0;$i -lt 20;$i++){$now=W41-Observe $m $m.originalRuntime;V10-Tasks $m $scope
  if($now.state -ceq 'ABSENT'){
   foreach($old in @($scope.descendants)){if(Get-CimInstance Win32_Process -Filter ('ProcessId='+$old.pid)){throw 'V10_OLD_DESCENDANT_REQUIRES_RECONCILIATION'}}
   @{stopped=$true;pid=$before.owner.pid;stopSemantics='planned-maintenance-stop';unknownCount=$null;lastResult='UNCONFIRMED_PRESERVED';scopeSha256=$m.plannedMaintenanceScope.sha256;forced=$false;noReplay=$true}|ConvertTo-Json -Compress;return
  };if(-not (Rdc-SameProcess $now.owner $before.owner)){throw 'V10_SHUTDOWN_OWNER_CHANGED'};Start-Sleep -Milliseconds 250
 };throw 'V10_SHUTDOWN_COMPLETION_UNKNOWN'
}

function W41-Home { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-chatgpt-web' }
function W41-Path([string]$Path) { [IO.Path]::GetFullPath($Path.Replace('/','\')).TrimEnd('\') }
function W41-HashPin([string]$Path,[string]$Expected) {
  if($Expected -cnotmatch '^[a-f0-9]{64}$' -or (Get-Sha256 (Rdc-Regular $Path)) -cne $Expected){throw '17841 file pin changed'}
}
function W41-SafeDirectory([string]$Path) {
  for($directory=[IO.DirectoryInfo]::new((W41-Path $Path));$directory;$directory=$directory.Parent){
    if(Test-Path -LiteralPath $directory.FullName){
      $entry=Get-Item -LiteralPath $directory.FullName -Force
      if(-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '17841 capsule/backup directory link refused'}
    }
  }
}
function W41-InventoryVisit([string]$Directory,[string]$Prefix,$Digest) {
  $item=Get-Item -LiteralPath $Directory -Force
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '17841 bundle directory must not be a link'}
  [string[]]$names=@([IO.Directory]::EnumerateFileSystemEntries($Directory)|ForEach-Object{[IO.Path]::GetFileName($_)})
  [Array]::Sort($names,[StringComparer]::Ordinal)
  foreach($name in $names){
    $path=Join-Path $Directory $name;$entry=Get-Item -LiteralPath $path -Force;$relative=$Prefix+$name
    if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '17841 bundle link refused'}
    if($entry.PSIsContainer){W41-InventoryVisit $path ($relative+'/') $Digest;continue}
    $null=Rdc-Regular $path
    $Digest.AppendData([Text.Encoding]::UTF8.GetBytes($relative+[char]0))
    $stream=[IO.File]::OpenRead($path)
    try{$buffer=[byte[]]::new(65536);while(($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0){$Digest.AppendData($buffer,0,$read)}}finally{$stream.Dispose()}
    $Digest.AppendData([byte[]]@(0))
  }
}
function W41-Inventory([string]$Directory) {
  $digest=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
  try{W41-InventoryVisit (W41-Path $Directory) '' $digest;[Convert]::ToHexString($digest.GetHashAndReset()).ToLowerInvariant()}finally{$digest.Dispose()}
}
function W41-Canonical($Value) {
  if($null -eq $Value){return 'null'}
  if($Value -is [Collections.IDictionary]){
    [string[]]$keys=@($Value.Keys);[Array]::Sort($keys,[StringComparer]::Ordinal)
    $parts=@(foreach($key in $keys){($key|ConvertTo-Json -Compress)+':'+(W41-Canonical $Value[$key])})
    return '{'+($parts -join ',')+'}'
  }
  if($Value -is [Collections.IList]){return '['+(@(foreach($entry in $Value){W41-Canonical $entry}) -join ',')+']'}
  return ($Value|ConvertTo-Json -Compress -Depth 40)
}
function W41-ConfigInvariant([string]$Path) {
  $data=[IO.File]::ReadAllText($Path,[Text.Encoding]::UTF8)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 100
  $data.Remove('releaseVersion');$data.Remove('runtimeCommand')
  Rdc-TextHash (W41-Canonical $data)
}
function W41-Counter($Value) {
  if(($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt 0){throw '17841 active count is UNKNOWN'}
  return [long]$Value
}
function W41-CommandTokens([string]$Command) {
  $matches=[regex]::Matches($Command,'"([^"]*)"|([^\s"]+)');$cursor=0;$tokens=@()
  foreach($match in $matches){
    if($Command.Substring($cursor,$match.Index-$cursor) -match '\S'){throw '17841 command token boundary is UNKNOWN'}
    $tokens+=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
    $cursor=$match.Index+$match.Length
    if($cursor -lt $Command.Length -and -not [char]::IsWhiteSpace($Command[$cursor])){throw '17841 mixed command token refused'}
  }
  if($Command.Substring($cursor) -match '\S'){throw '17841 command token boundary is UNKNOWN'}
  return ,$tokens
}
function W41-Observe($Metadata,[string]$ExpectedRuntime,$ExpectedOwner=$null) {
  $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq 17841|Select-Object -ExpandProperty OwningProcess -Unique)
  $rows=@();$homePrefix=(W41-Path $Metadata.home)+'\'
  foreach($p in @(Get-CimInstance Win32_Process -Filter "Name = 'bun.exe' OR Name = 'node.exe' OR Name = 'codex-chatgpt-web.exe' OR Name = 'Codex Web GPT.exe'" -ErrorAction Stop)){
    if(-not $p.CommandLine){throw '17841 file pin changed','17841 process command inventory is UNKNOWN'}
    $normalized=([string]$p.CommandLine).Replace('/','\')
    if($p.ProcessId -notin $listeners -and -not ($normalized.IndexOf($homePrefix,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $normalized -match '(?i)\s"?serve"?(?:\s|$)')){continue}
    # Exact existing target predicate remains above; retain UNKNOWN for selected target image.
    if(-not $p.ExecutablePath){throw '17841 target image inventory is UNKNOWN'}
    $tokens=W41-CommandTokens ([string]$p.CommandLine)
    if($tokens.Count -ne 3 -or (W41-Path $tokens[0]) -ine (W41-Path (Join-Path $ExpectedRuntime 'runtime\bun.exe')) -or (W41-Path $tokens[1]) -ine (W41-Path (Join-Path $ExpectedRuntime 'app\cli.js')) -or $tokens[2] -cne 'serve'){throw '17841 foreign or unexpected runtime command'}
    $rows+=@(Rdc-Identity ([int]$p.ProcessId))
  }
  $client=[Net.Http.HttpClient]::new();$client.Timeout=[TimeSpan]::FromSeconds(3)
  $health=$null;$refused=$false
  try{
    $response=$client.GetAsync('http://127.0.0.1:17841/healthz').GetAwaiter().GetResult()
    try{
      if(-not $response.IsSuccessStatusCode){throw '17841 health status is UNKNOWN'}
      $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if($text.Length -gt 65536){throw '17841 health response is oversized'}
      $health=$text|ConvertFrom-Json -DateKind String
    }finally{$response.Dispose()}
  }catch{
    $errorValue=$_.Exception
    while($errorValue){if($errorValue -is [Net.Sockets.SocketException] -and $errorValue.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused){$refused=$true;break};$errorValue=$errorValue.InnerException}
    if(-not $refused){throw '17841 health observation is UNKNOWN'}
  }finally{$client.Dispose()}
  if($listeners.Count -eq 0 -and $rows.Count -eq 0 -and $refused){return @{state='ABSENT';observedAt=(UtcNow)}}
  if($rows.Count -ne 1 -or $listeners.Count -ne 1 -or [int]$listeners[0] -ne $rows[0].pid -or -not $health){throw '17841 owner or absence is UNKNOWN'}
  $owner=$rows[0];$marker=Read-Json (Join-Path $Metadata.home 'runtime\windows-process.json')
  if(-not $marker -or $marker.pid -ne $owner.pid -or ([DateTimeOffset]::Parse($marker.created)).UtcTicks.ToString() -cne $owner.createdTicks -or $marker.commandHash -cne $owner.commandSha256 -or (W41-Path $marker.executable) -ine $owner.image){throw '17841 process marker does not match actual owner'}
  if($ExpectedOwner -and -not (Rdc-SameProcess $owner $ExpectedOwner)){throw '17841 owner changed since Arm'}
  $config=Read-Json (Join-Path $Metadata.home 'config.json')
  if($health.service -cne 'codex-chatgpt-web' -or $health.status -cne 'ok' -or $health.pid -ne $owner.pid -or $health.port -ne 17841 -or $health.version -cne $config.releaseVersion -or $health.accepting_turns -isnot [bool]){throw '17841 health identity differs'}
  $counts=@((W41-Counter $health.active_http_turns),(W41-Counter $health.active_browser_http_turns),(W41-Counter $health.active_browser_turns))
  $legacyUnknownTelemetryAbsent=-not $health.PSObject.Properties['unknownCount'] -and -not $health.PSObject.Properties['unknown_count']
  # Active zero does not prove numeric unknown zero. The installed endpoint
  # has no demonstrated unknownCount support; absent/null never becomes zero.
  $unknownCount=$null
  if($health.PSObject.Properties['unknownCount']){$unknownCount=W41-Counter $health.unknownCount}
  @{state='OWNED';owner=$owner;counts=$counts;legacyUnknownTelemetryAbsent=$legacyUnknownTelemetryAbsent;unknownCount=$unknownCount;unknownEvidenceKnown=($null -ne $unknownCount);idle=($null -ne $unknownCount -and $unknownCount -eq 0 -and @($counts|Where-Object{$_ -ne 0}).Count -eq 0);acceptingTurns=$health.accepting_turns;version=$health.version;observedAt=(UtcNow)}
}
function W41-FileSet($Metadata,[string]$Expected) {
  W42-Storage $Metadata
  foreach($saved in $Metadata.preimages){W41-HashPin $saved.backup $saved.sha256}
  $allBefore=$true
  foreach($saved in @($Metadata.preimages|Where-Object name -ne 'marker')){if((Get-Sha256 (Rdc-Regular $saved.path)) -cne $saved.sha256){$allBefore=$false}}
  if($Expected -ceq 'original'){foreach($saved in $Metadata.preimages){if($saved.name -ne 'marker' -and (W42-AclHash (Get-Acl -LiteralPath $saved.path)) -cne $saved.sourceAclSha256){throw 'W42_ORIGINAL_FILE_ACL_CAS'}};if(-not $allBefore){throw '17841 original CAS changed'};return 'original'}
  if($Expected -ceq 'either' -and $allBefore){return 'original'}
  $config=Read-Json (Join-Path $Metadata.home 'config.json');$journal=Read-Json (Join-Path $Metadata.home 'runtime\windows-install.json');$descriptor=Read-Json (Join-Path $Metadata.home 'runtime\windows-command.json')
  if($config.port -ne 17841 -or $config.runtimeOwner -cne 'service' -or @($config.runtimeCommand).Count -ne 2 -or (W41-Path $config.runtimeCommand[0]) -ine (Join-Path $Metadata.destination 'runtime\bun.exe') -or (W41-Path $config.runtimeCommand[1]) -ine (Join-Path $Metadata.destination 'app\cli.js') -or $config.releaseVersion -cne $Metadata.candidateVersion){throw '17841 replacement config is not the exact candidate'}
  if((W41-ConfigInvariant (Join-Path $Metadata.home 'config.json')) -cne $Metadata.configInvariantSha256){throw '17841 unrelated config or authentication changed'}
  if($journal.schemaVersion -ne 1 -or (W41-Path $journal.runtimeRoot) -ine $Metadata.destination -or $journal.inventoryHash -cne $Metadata.contract.inventorySha256 -or $journal.configHash -cne (Get-Sha256 (Join-Path $Metadata.home 'config.json')) -or $journal.descriptorHash -cne (Get-Sha256 (Join-Path $Metadata.home 'runtime\windows-command.json'))){throw '17841 replacement journal ownership differs'}
  if((W41-Path $descriptor.runtimeRoot) -ine $Metadata.destination -or $descriptor.inventoryHash -cne $Metadata.contract.inventorySha256 -or $descriptor.endpoint -cne 'http://127.0.0.1:17841'){throw '17841 replacement command descriptor differs'}
  if($null -ne $journal.previousConfig -or $null -ne $journal.previousDescriptor -or $null -ne $journal.previousJournal -or ($journal.PSObject.Properties['previousJournalRef'] -and $journal.previousJournalRef)){throw 'W42_SHARED_RAW_PREIMAGE_FORBIDDEN'}
  $reference=$journal.privatePreimages
  if($reference.schema -cne 'aicc-installer-private-reference/v2' -or $reference.operationId -cne $Metadata.operationId -or (W41-Path $reference.metadataPath) -ine (Operation-File 'metadata.json') -or $reference.metadataSha256 -cne $MetadataSha256){throw 'W42_PRIVATE_JOURNAL_REFERENCE_CAS'}
  W41-HashPin (Join-Path $Metadata.destination 'manifest.json') $Metadata.contract.manifestSha256
  W41-HashPin (Join-Path $Metadata.destination 'app\cli.js') $Metadata.contract.appSha256
  $installedPins=Read-Json (Operation-File 'installed-pins.json')
  if($installedPins){
    if($installedPins.operationId -cne $OperationId -or $installedPins.runtimeRoot -ine $Metadata.destination){throw '17841 installed transaction pins differ'}
    W41-HashPin (Join-Path $Metadata.home 'config.json') $installedPins.configSha256
    W41-HashPin (Join-Path $Metadata.home 'runtime\windows-command.json') $installedPins.descriptorSha256
    W41-HashPin (Join-Path $Metadata.home 'runtime\windows-install.json') $installedPins.journalSha256
  }
  return 'candidate'
}
function W41-Pins($Metadata,[switch]$Trees) {
  if($Metadata -is [Collections.IDictionary]){$hasStorage=$Metadata.Contains('privateStorage')}else{$hasStorage=$null -ne $Metadata.PSObject.Properties['privateStorage']}
  if($hasStorage){W42-Storage $Metadata}
  W41-HashPin $Metadata.workerScript $Metadata.workerScriptSha256
  W41-HashPin $Metadata.powershell $Metadata.powershellSha256
  W41-HashPin $Metadata.contract.installerPath $Metadata.contract.installerSha256
  W41-HashPin $Metadata.contractPath $Metadata.contractSha256
  W41-HashPin (Join-Path $Metadata.contract.bundleRoot 'manifest.json') $Metadata.contract.manifestSha256
  W41-HashPin (Join-Path $Metadata.contract.bundleRoot 'app\cli.js') $Metadata.contract.appSha256
  W41-HashPin (Join-Path $Metadata.contract.bundleRoot 'runtime\bun.exe') $Metadata.contract.bunSha256
  W41-HashPin (Join-Path $Metadata.originalRuntime 'manifest.json') $Metadata.contract.baseline.manifestSha256
  W41-HashPin (Join-Path $Metadata.originalRuntime 'app\cli.js') $Metadata.contract.baseline.appSha256
  foreach($saved in $Metadata.preimages){W41-HashPin $saved.backup $saved.sha256}
  if($Trees -and ((W41-Inventory $Metadata.contract.bundleRoot) -cne $Metadata.contract.inventorySha256 -or (W41-Inventory $Metadata.originalRuntime) -cne $Metadata.contract.baseline.inventorySha256)){throw '17841 full runtime inventory changed'}
}
function W41-Binding([switch]$Activation,[switch]$ReadOnly) {
  Require-OperationId;Require-Nonce $Nonce
  $expectedRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\webgpt-remote-recovery'
  if($Root -ine (W41-Path $expectedRoot)){throw '17841 uses the existing capsule root'}
  $null=W42-PrivateAcl (Operation-Dir) $true
  W41-HashPin (Operation-File 'metadata.json') $MetadataSha256
  $m=Read-Json (Operation-File 'metadata.json')
  if($m.schema -cne 'aicc-rdc-17841-recovery/v2' -or $m.operationId -cne $OperationId -or $m.nonce -cne $Nonce -or $m.deviceId -cne $DeviceId -or $m.target -cne '17841-only' -or $m.workerScript -ine $ScriptPath -or $m.home -ine (W41-Home)){throw '17841 capsule identity differs'}
  Rdc-DeviceRegistration $m
  W41-Pins $m
  $null=W49-EnsureImage $m
  $null=V10-Scope $m
  if(-not $ReadOnly -and (Rdc-Time $m.recoveryExpiresAt) -le [DateTimeOffset]::UtcNow){throw '17841 recovery lease expired'}
  if($Activation -and (Rdc-Time $m.operationExpiresAt) -le [DateTimeOffset]::UtcNow){throw '17841 activation lease expired'}
  return $m
}
function W41-Arm {
  Require-OperationId
  if($DeviceId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $ControllerThreadId -notmatch '^[a-f0-9-]{36}$' -or $ConversationId -or $RollbackScriptPath -or $ResumeMessagePath -or $AutoOnOwnerExit -or $OwnerPid -or $SnapshotPath -or $ReleaseManifestPath){throw '17841 exact device/controller contract required; legacy recovery arguments refused'}
  $expectedRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\webgpt-remote-recovery'
  if($Root -ine (W41-Path $expectedRoot)){throw '17841 existing capsule root required'}
  $expiry=Rdc-Time $OperationExpiresAt;$recovery=Rdc-Time $RecoveryExpiresAt;$now=[DateTimeOffset]::UtcNow
  if($expiry -le $now -or $expiry -gt $now.AddMinutes(30) -or $recovery -lt $expiry.AddMinutes(5) -or $recovery -gt $expiry.AddMinutes(30)){throw '17841 bounded activation/recovery deadlines required'}
  W41-HashPin $RuntimeContractPath $RuntimeContractSha256
  $contract=Read-Json $RuntimeContractPath
  if($contract.schema -cne 'aicc-rdc-17841-candidate/v2' -or $contract.target -cne '17841-only'){throw '17841 explicit built candidate contract required'}
  foreach($name in @('runtimeOnlyStart','configuredCommandStart','authenticatedIdleStop','exactJournalRollback')){if($contract.capabilities.$name -isnot [bool] -or $contract.capabilities.$name -ne $true){throw '17841 runtime-only/rollback capability contract missing'}}
  V10-Policy $contract
  W42-InstallerStorageGate
  W42-Parents $contract.privateStorage
  W44-SourceConvention $contract
  if($contract.recoveryHelper.path -ine $ScriptPath){throw 'W42_HELPER_PATH_CAS'}
  W41-HashPin $ScriptPath $contract.recoveryHelper.sha256
  W41-HashPin $contract.recoveryHelper.modulePath $contract.recoveryHelper.moduleSha256
  $manifest=Read-Json (Rdc-Regular (Join-Path $contract.bundleRoot 'manifest.json'))
  if($manifest.schemaVersion -ne 1 -or $manifest.platform -cne 'win32' -or $manifest.arch -cne 'x64' -or $manifest.entrypoint -cne 'app/cli.js' -or $manifest.appVersion -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $manifest.bundleId -cnotmatch '^[a-f0-9]{64}$'){throw '17841 candidate manifest differs'}
  foreach($name in @('runtimeOnlyStart','configuredCommandStart','authenticatedIdleStop','exactJournalRollback')){if($manifest.capabilities.$name -isnot [bool] -or $manifest.capabilities.$name -ne $true){throw '17841 candidate manifest lacks explicit capability'}}
  $homePath=W41-Home;$configPath=Join-Path $homePath 'config.json';$config=Read-Json $configPath
  $journal=Read-Json (Join-Path $homePath 'runtime\windows-install.json')
  $original=W41-Path $journal.runtimeRoot
  if((Split-Path $original -Parent) -ine (Join-Path $homePath 'versions') -or $config.port -ne 17841 -or $config.runtimeOwner -cne 'service' -or @($config.runtimeCommand).Count -ne 2 -or (W41-Path $config.runtimeCommand[0]) -ine (Join-Path $original 'runtime\bun.exe') -or (W41-Path $config.runtimeCommand[1]) -ine (Join-Path $original 'app\cli.js')){throw '17841 original version/config ownership differs'}
  if($journal.schemaVersion -ne 1 -or $journal.configHash -cne (Get-Sha256 $configPath) -or $journal.descriptorHash -cne (Get-Sha256 (Join-Path $homePath 'runtime\windows-command.json')) -or (W41-Path $contract.baseline.runtimeRoot) -ine $original -or $contract.baseline.inventorySha256 -cne $journal.inventoryHash){throw '17841 original install journal or baseline differs'}
  $hostIdentity=Rdc-Identity $RdcHostPid
  if($hostIdentity.createdTicks -cne $RdcHostCreatedTicks -or $hostIdentity.commandSha256 -cne $RdcHostCommandSha256 -or $hostIdentity.imageSha256 -cne $RdcHostImageSha256){throw '17841 fresh RDC host pins required'}
  $registrationPin=$null
  if($DeviceRegistrationPath -or $DeviceRegistrationSha256){
    $module=Rdc-Regular (Join-Path $PSScriptRoot 'Recovery-DeviceBinding.psm1')
    Import-Module -Name $module -Force
    $registration=Get-AiccRecoveryDeviceRegistration -Path $DeviceRegistrationPath -Sha256 $DeviceRegistrationSha256 -DeviceId $DeviceId -RdcHost $hostIdentity
    if($recovery -gt [DateTimeOffset]::Parse($registration.challenge.expiresAt)){throw '17841 recovery deadline outlives exact device registration'}
    $registrationPin=@{path=(Rdc-Regular $DeviceRegistrationPath);sha256=$DeviceRegistrationSha256;modulePath=$module;moduleSha256=(Get-Sha256 $module)}
  }else{throw 'V2 requires fresh registration covering the whole recovery lease'}
  $engine=Rdc-Regular ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
  $destination=Join-Path $homePath ('versions\'+$manifest.appVersion+'-win32-x64-'+$contract.inventorySha256.Substring(0,16))
  if($destination -ieq $original -or (Test-Path -LiteralPath $destination) -and (W41-Inventory $destination) -cne $contract.inventorySha256){throw '17841 distinct candidate destination required; no implicit repair suffix'}
  $m=[ordered]@{schema='aicc-rdc-17841-recovery/v2';channel='rdc-device';target='17841-only';deviceId=$DeviceId;operationId=$OperationId;nonce=([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant());controllerThreadId=$ControllerThreadId;createdAt=(UtcNow);operationExpiresAt=$OperationExpiresAt;recoveryExpiresAt=$RecoveryExpiresAt;rdcHost=$hostIdentity;workerScript=$ScriptPath;workerScriptSha256=(Get-Sha256 $ScriptPath);powershell=$engine;powershellSha256=(Get-Sha256 $engine);home=$homePath;originalRuntime=$original;originalVersion=$config.releaseVersion;candidateVersion=$manifest.appVersion;destination=$destination;contractPath=(Rdc-Regular $RuntimeContractPath);contractSha256=$RuntimeContractSha256;contract=$contract;preimages=@();configInvariantSha256=(W41-ConfigInvariant $configPath);noReplay=$true;unknownOriginalOutcomes='PRESERVED';automaticOwnerExitRecovery=$false;allowedActions=@('wait-exact-idle','authenticated-stop-once','install-once','runtime-only-start-once','known-failure-restore-once','status','close');excluded=@('OCX','Tunnel','Workspace','Chrome','accounts','credentials','original-request-replay');capabilityDeclarationIsLiveVerification=$false}
  if($registrationPin){$m.deviceRegistration=$registrationPin}
  $m.registeredSystemImageProof=W49-EnsureImage $m -Capture
  $m.sharedDirectoryPins=W42-SharedDirectories $homePath
  W41-Pins $m -Trees
  $observed=W41-Observe $m $original
  if($observed.state -cne 'OWNED' -or -not $observed.acceptingTurns){throw '17841 original owned accepting runtime required at Arm'}
  $m.originalOwner=$observed.owner
  $m.plannedMaintenanceScope=@{path=(Rdc-Regular $PlannedMaintenanceScopePath);sha256=$PlannedMaintenanceScopeSha256}
  $null=V10-LiveGate $m $observed
  $dir=Operation-Dir
  $targets=[ordered]@{config=$configPath;descriptor=(Join-Path $homePath 'runtime\windows-command.json');journal=(Join-Path $homePath 'runtime\windows-install.json');marker=(Join-Path $homePath 'runtime\windows-process.json')}
  W42-CapturePreimages $m $targets
  $backup=$m.privateStorage.backup
  $null=W41-FileSet $m 'original';$null=W41-Observe $m $original $m.originalOwner
  Rdc-New (Operation-File 'metadata.json') $m
  Rdc-New (Operation-File 'state.json') @{state='ARMED';operationId=$OperationId;updatedAt=(UtcNow)}
  @{ok=$true;state='ARMED';target='17841-only';deviceId=$DeviceId;operationId=$OperationId;nonce=$m.nonce;metadataSha256=(Get-Sha256 (Operation-File 'metadata.json'));capsule=$dir;privateBackup=$backup;powershell=$engine;workerScript=$ScriptPath;standby=$false;runtimeChanged=$false;activationSupported=$true;installationContract='aicc-installer-private-reference/v2';actualReadinessNotClaimed=$true}|ConvertTo-Json -Depth 6 -Compress
}
function W41-Phase($Metadata,$Worker,[string]$Phase,$Details=$null) {
  Write-JsonAtomic (Operation-File 'state.json') @{state=$Phase;operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;details=$Details;updatedAt=(UtcNow)}
  Write-JsonAtomic (Operation-File 'heartbeat.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;deviceId=$DeviceId;phase=$Phase;worker=$Worker;heartbeatAt=(UtcNow)}
}
function W41-Child($Metadata,$Worker,[string]$Phase,[string]$Action) {
  $null=W41-Binding;W41-Pins $Metadata
  $claim=Operation-File ($Phase.ToLowerInvariant()+'.claim.json')
  Rdc-New $claim @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;action=$Action;phase=$Phase;claimedAt=(UtcNow)}
  W41-Phase $Metadata $Worker $Phase @{action=$Action;dispatchState='INTENT_RECORDED'}
  $quote={param($s) "'"+([string]$s).Replace("'","''")+"'"}
  if($Action -ceq 'stop'){
    $command='$ErrorActionPreference=''Stop''; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & '+(& $quote $ScriptPath)+' -Mode planned-stop -Transport rdc-17841 -OperationId '+(& $quote $OperationId)+' -DeviceId '+(& $quote $DeviceId)+' -Nonce '+(& $quote $Nonce)+' -MetadataSha256 '+(& $quote $MetadataSha256)
  }else{
  $command="`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(`$false); `$OutputEncoding=[Console]::OutputEncoding; & "+(& $quote $Metadata.contract.installerPath)+' -Action '+(& $quote $Action)+' -Bundle '+(& $quote $Metadata.contract.bundleRoot)+' -HomePath '+(& $quote $Metadata.home)
  $command+=' -OperationMetadataPath '+(& $quote (Operation-File 'metadata.json'))+' -OperationMetadataSha256 '+(& $quote $MetadataSha256)
  if($Action -ceq 'start'){$command+=' -RuntimeOnly'}
  }
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$Metadata.powershell;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false,$true);$start.StandardErrorEncoding=$start.StandardOutputEncoding
  foreach($arg in @('-NoProfile','-NonInteractive','-EncodedCommand',[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command)))){$start.ArgumentList.Add($arg)}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$start
  try{
    if(-not $process.Start()){throw '17841 child start unconfirmed'}
    $outTask=$process.StandardOutput.ReadToEndAsync();$errTask=$process.StandardError.ReadToEndAsync()
    Rdc-New (Operation-File ($Phase.ToLowerInvariant()+'.child.json')) @{operationId=$OperationId;phase=$Phase;pid=$process.Id;createdTicks=$process.StartTime.ToUniversalTime().Ticks.ToString();startedAt=(UtcNow);commandSha256=(Rdc-TextHash $command)}
    $seconds=if($Action -ceq 'install'){600}else{180};$deadline=[DateTimeOffset]::UtcNow.AddSeconds($seconds)
    while(-not $process.WaitForExit(1000)){
      W41-Phase $Metadata $Worker $Phase @{action=$Action;dispatchState='CHILD_RUNNING';childPid=$process.Id}
      if([DateTimeOffset]::UtcNow -ge $deadline -or [DateTimeOffset]::UtcNow -ge (Rdc-Time $Metadata.recoveryExpiresAt)){
        $unknown=@{known=$false;phase=$Phase;state='UNCERTAIN_NO_REPLAY';reason='child_deadline_alive';childPid=$process.Id;noReplay=$true}
        Rdc-New (Operation-File ($Phase.ToLowerInvariant()+'.exit.json')) $unknown;return $unknown
      }
    }
    $code=$process.ExitCode;$stdout=$outTask.GetAwaiter().GetResult();$stderr=$errTask.GetAwaiter().GetResult();$payload=$null
    if($code -eq 0 -and $stdout.Length -le 1048576){try{$payload=$stdout|ConvertFrom-Json -DateKind String -Depth 30}catch{$payload=$null}}
    $result=@{known=$true;phase=$Phase;exitCode=$code;stdoutSha256=(Rdc-TextHash $stdout);stderrSha256=(Rdc-TextHash $stderr);completedAt=(UtcNow)}
    Rdc-New (Operation-File ($Phase.ToLowerInvariant()+'.exit.json')) $result
    $result.payload=$payload;return $result
  }catch{return @{known=$false;phase=$Phase;state='UNCERTAIN_NO_REPLAY';reason='child_start_or_output_unconfirmed';noReplay=$true}}
  finally{$process.Dispose()}
}
function W41-Outcome([string]$State,[string]$Reason) { @{state=$State;reason=$Reason;operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;target='17841-only';noReplay=$true;unknownOriginalOutcomes='PRESERVED';unknownCount=$null;lastResult='UNCONFIRMED_PRESERVED';stopSemantics='planned-maintenance-stop';originalRequestsReplayed=$false;completedAt=(UtcNow)} }
function W41-Recover($Metadata,$Worker,[string]$FailurePhase) {
  $null=W41-Binding
  Rdc-New (Operation-File 'rollback.claim.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;failurePhase=$FailurePhase;claimedAt=(UtcNow)}
  W41-Phase $Metadata $Worker 'RECOVERING' @{failurePhase=$FailurePhase}
  # Only two understood file states are recoverable. Partial/foreign writes are
  # not overwritten by copying backups or by pretending installed() succeeded.
  $fileState=W41-FileSet $Metadata 'either'
  $rootPath=if($fileState -ceq 'original'){$Metadata.originalRuntime}else{$Metadata.destination}
  $observation=W41-Observe $Metadata $rootPath
  if($fileState -ceq 'original' -and $observation.state -ceq 'OWNED'){
    if((Rdc-SameProcess $observation.owner $Metadata.originalOwner) -and $observation.acceptingTurns){return (W41-Outcome 'NO_CHANGE' 'original_owner_and_files_preserved')}
    return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'original_runtime_state_requires_observation')
  }
  if($fileState -ceq 'candidate'){
    if($observation.state -ceq 'OWNED'){
      if(-not $observation.idle){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_active_preserved')}
      $stop=W41-Child $Metadata $Worker 'ROLLBACK_STOP_INTENT' 'stop'
      if(-not $stop.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'candidate_stop_unconfirmed')}
      if($stop.exitCode -ne 0){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_stop_refused')}
      if(-not $stop.payload -or $stop.payload.stopped -ne $true -or $stop.payload.pid -ne $observation.owner.pid){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_authenticated_stop_ack_missing')}
      $observation=W41-Observe $Metadata $Metadata.destination
    }
    if($observation.state -cne 'ABSENT'){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_absence_unproved')}
    $null=W41-FileSet $Metadata 'candidate';W41-Pins $Metadata -Trees
    $rollback=W41-Child $Metadata $Worker 'ROLLBACK_FILES_INTENT' 'rollback'
    if(-not $rollback.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'rollback_unconfirmed')}
    if($rollback.exitCode -ne 0 -or -not $rollback.payload -or $rollback.payload.restored -ne $true){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'rollback_result_not_proved')}
  }
  $null=W41-FileSet $Metadata 'original'
  if((W41-Observe $Metadata $Metadata.originalRuntime).state -cne 'ABSENT'){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'original_start_absence_unproved')}
  # Candidate maintenance CLI reads the restored original runtimeCommand and
  # spawns its exact Bun/CLI serve, with runtime-only suppressing Tunnel ensure.
  $start=W41-Child $Metadata $Worker 'RESTORE_START_INTENT' 'start'
  if(-not $start.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'original_start_unconfirmed')}
  if($start.exitCode -ne 0 -or -not $start.payload -or $start.payload.startScope -cne 'runtime-only' -or $start.payload.tunnelEnsured -ne $false){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'original_start_result_not_proved')}
  $null=W41-FileSet $Metadata 'original';$restored=W41-Observe $Metadata $Metadata.originalRuntime
  if($restored.state -cne 'OWNED' -or -not $restored.acceptingTurns){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'original_owner_not_admitted')}
  $result=W41-Outcome 'RECOVERED' 'original_files_and_runtime_restored_once';$result.owner=$restored.owner;return $result
}
function W41-Activate($Metadata,$Worker) {
  W42-InstallerStorageGate
  W41-Pins $Metadata -Trees
  while($true){
    if([DateTimeOffset]::UtcNow -ge (Rdc-Time $Metadata.operationExpiresAt)){return (W41-Outcome 'NOT_ACTIVATED' 'idle_not_reached_before_activation_expiry')}
    $null=W41-Binding -Activation;$null=W41-FileSet $Metadata 'original';$null=Rdc-Ancestry $Metadata
    $before=W41-Observe $Metadata $Metadata.originalRuntime $Metadata.originalOwner
    if($before.state -cne 'OWNED' -or -not $before.acceptingTurns){return (W41-Outcome 'HOLD_PRE_DISPATCH' 'original_runtime_changed_before_stop')}
    W41-Phase $Metadata $Worker 'WAITING_FOR_PLANNED_RELEASE' @{counts=$before.counts;observedAt=$before.observedAt}
    $null=V10-LiveGate $Metadata $before
    break
    Start-Sleep -Seconds $HeartbeatSeconds
  }
  # The supported stop command repeats exact owner/idle checks, performs the
  # authenticated atomic drain, then shutdown. No Stop-Process/taskkill fallback.
  $null=W41-Binding -Activation;$null=W41-FileSet $Metadata 'original'
  Rdc-New (Operation-File 'before-stop.json') @{stopSemantics='planned-maintenance-stop';unknownCount=$null;lastResult='UNCONFIRMED_PRESERVED';operationId=$OperationId;nonce=$Nonce;owner=$before.owner;counts=$before.counts;observedAt=$before.observedAt;metadataSha256=$MetadataSha256}
  $stop=W41-Child $Metadata $Worker 'STOP_INTENT' 'stop'
  if(-not $stop.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'stop_unconfirmed')}
  if($stop.exitCode -ne 0){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'planned_stop_refused_or_unknown_no_automatic_resume')}
  if(-not $stop.payload -or $stop.payload.stopped -ne $true -or $stop.payload.pid -ne $before.owner.pid){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'authenticated_stop_ack_missing')}
  $null=W41-FileSet $Metadata 'original'
  if((W41-Observe $Metadata $Metadata.originalRuntime).state -cne 'ABSENT'){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'shutdown_absence_unproved')}
  $scope=V10-Scope $Metadata
  V10-Tasks $Metadata $scope
  W41-Phase $Metadata $Worker 'STOPPED_ABSENT'
  W41-Pins $Metadata -Trees;$null=W41-FileSet $Metadata 'original'
  if([DateTimeOffset]::UtcNow -ge (Rdc-Time $Metadata.operationExpiresAt)){return (W41-Recover $Metadata $Worker 'activation_expired_after_stop')}
  $install=W41-Child $Metadata $Worker 'INSTALL_INTENT' 'install'
  if(-not $install.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'install_unconfirmed')}
  if($install.exitCode -ne 0){return (W41-Recover $Metadata $Worker 'install')}
  $null=W41-FileSet $Metadata 'candidate'
  if((W41-Inventory $Metadata.destination) -cne $Metadata.contract.inventorySha256 -or (W41-Observe $Metadata $Metadata.destination).state -cne 'ABSENT'){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_inventory_or_absence_differs')}
  Rdc-New (Operation-File 'installed-pins.json') @{operationId=$OperationId;runtimeRoot=$Metadata.destination;inventorySha256=$Metadata.contract.inventorySha256;configSha256=(Get-Sha256 (Join-Path $Metadata.home 'config.json'));descriptorSha256=(Get-Sha256 (Join-Path $Metadata.home 'runtime\windows-command.json'));journalSha256=(Get-Sha256 (Join-Path $Metadata.home 'runtime\windows-install.json'));observedAt=(UtcNow)}
  $start=W41-Child $Metadata $Worker 'START_INTENT' 'start'
  if(-not $start.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'candidate_start_unconfirmed')}
  if($start.exitCode -ne 0){return (W41-Recover $Metadata $Worker 'start')}
  if(-not $start.payload -or $start.payload.startScope -cne 'runtime-only' -or $start.payload.tunnelEnsured -ne $false){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'runtime_only_start_ack_missing')}
  $null=W41-FileSet $Metadata 'candidate';$after=W41-Observe $Metadata $Metadata.destination
  if($after.state -cne 'OWNED' -or -not $after.acceptingTurns){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'candidate_owner_not_admitted')}
  $result=W41-Outcome 'ACTIVATED' 'candidate_installed_and_runtime_only_started';$result.owner=$after.owner;$result.runtimeRoot=$Metadata.destination;$result.manifestSha256=$Metadata.contract.manifestSha256;return $result
}
function W41-Status {
  $m=W41-Binding -ReadOnly;$ready=Read-Json (Operation-File 'readiness.json');$heartbeat=Read-Json (Operation-File 'heartbeat.json');$state=Read-Json (Operation-File 'state.json');$fresh=$false
  if($ready -and $heartbeat){try{$age=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($heartbeat.heartbeatAt)).TotalSeconds;$fresh=$age -ge 0 -and $age -le 20 -and (Rdc-SameProcess (Rdc-Identity $ready.worker.pid) $ready.worker) -and $ready.metadataSha256 -ceq $MetadataSha256 -and $heartbeat.metadataSha256 -ceq $MetadataSha256 -and $ready.nonce -ceq $Nonce -and $ready.deviceId -ceq $DeviceId}catch{$fresh=$false}}
  @{ok=($state.state -ceq 'READY_STANDBY' -and $fresh -and (Rdc-Time $m.operationExpiresAt) -gt [DateTimeOffset]::UtcNow);state=$state.state;heartbeatFresh=$fresh;readiness=$ready;result=(Read-Json (Operation-File 'result.json'));noReplay=$true}|ConvertTo-Json -Depth 15 -Compress
}
function W41-RequestProof($Metadata,$Ready,[string]$HandoffFile,[string]$HandoffDigest,[string]$ReceiptFile,[string]$ReceiptDigest) {
  W41-HashPin $HandoffFile $HandoffDigest;W41-HashPin $ReceiptFile $ReceiptDigest
  $handoff=Read-Json $HandoffFile;$receipt=Read-Json $ReceiptFile
  if($handoff.schema -cne 'aicc-17841-controller-handoff/v1' -or $handoff.operationId -cne $OperationId -or $handoff.nonce -cne $Nonce -or $handoff.metadataSha256 -cne $MetadataSha256 -or $handoff.controllerThreadId -cne $Metadata.controllerThreadId -or $handoff.state -cne 'RELEASED_FOR_MAINTENANCE' -or $handoff.noReplay -ne $true -or $handoff.unknownOriginalOutcomes -cne 'PRESERVED' -or $handoff.expiresAt -cne $Metadata.operationExpiresAt){throw '17841 explicit operation handoff missing'}
  W41-HashPin $handoff.approvalRef.path $handoff.approvalRef.sha256
  V10-Release $Metadata $HandoffFile $HandoffDigest
  if($receipt.schema -cne 'aicc-rdc-transport-ack/v1' -or $receipt.source -cne 'remote_desktop_commander.start_process' -or $receipt.operationId -cne $OperationId -or $receipt.nonce -cne $Nonce -or $receipt.metadataSha256 -cne $MetadataSha256 -or $receipt.deviceId -cne $DeviceId -or $receipt.readyObserved -ne $true -or $receipt.workerPid -ne $Ready.worker.pid -or $receipt.responseProcessId -notin @($Ready.ancestry|Where-Object pid -ne $Metadata.rdcHost.pid|ForEach-Object pid)){throw '17841 actual RDC response binding missing'}
}
function W41-Signal {
  W42-InstallerStorageGate
  $m=W41-Binding -Activation
  if($SignalAction -cne 'activate'){throw '17841 only the worker may recover a known failure'}
  $control=[IO.File]::Open((Operation-File 'control.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    $status=W41-Status|ConvertFrom-Json -DateKind String
    if(-not $status.ok){throw '17841 actual independent standby is not fresh'}
    W41-RequestProof $m $status.readiness $HandoffPath $HandoffSha256 $TransportReceiptPath $TransportReceiptSha256
    $beforeSignal=W41-Observe $m $m.originalRuntime $m.originalOwner
    $null=V10-LiveGate $m $beforeSignal
    $null=W49-EnsureImage $m
    Rdc-Publish (Operation-File 'activate.request.json') @{action='activate';operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;deviceId=$DeviceId;handoffPath=(Rdc-Regular $HandoffPath);handoffSha256=$HandoffSha256;transportReceiptPath=(Rdc-Regular $TransportReceiptPath);transportReceiptSha256=$TransportReceiptSha256;requestedAt=(UtcNow)}
    @{ok=$true;state='REQUESTED';operationId=$OperationId;workerWaitsForActualIdle=$true;controllerMustReleaseCurrentTurn=$true;noReplay=$true}|ConvertTo-Json -Compress
  }finally{$control.Dispose()}
}
function W41-Watch {
  $m=W41-Binding -Activation
  $lock=[IO.File]::Open((Operation-File 'watch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    if((Read-Json (Operation-File 'state.json')).state -cne 'ARMED' -or (Test-Path -LiteralPath (Operation-File 'watch.claim.json'))){throw '17841 worker start is one-use; no replay'}
    $ancestry=Rdc-Ancestry $m;$worker=$ancestry[0]
    if($worker.image -ine $m.powershell -or $worker.imageSha256 -cne $m.powershellSha256){throw '17841 pinned independent worker required'}
    Rdc-New (Operation-File 'watch.claim.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;claimedAt=(UtcNow)}
    W42-InstallerStorageGate;W41-Pins $m -Trees;$null=W41-FileSet $m 'original';$null=W41-Observe $m $m.originalRuntime $m.originalOwner
    $live=W41-Observe $m $m.originalRuntime $m.originalOwner
    $null=V10-LiveGate $m $live
    $ready=@{lifecycleMode='planned-maintenance-stop';unknownCount=$null;lastResult='UNCONFIRMED_PRESERVED';scopeSha256=$m.plannedMaintenanceScope.sha256;schema='aicc-rdc-17841-ready/v1';state='READY_STANDBY';target='17841-only';deviceId=$DeviceId;operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;ancestry=$ancestry;operationExpiresAt=$m.operationExpiresAt;recoveryExpiresAt=$m.recoveryExpiresAt;candidateManifestSha256=$m.contract.manifestSha256;contractSha256=$m.contractSha256;readyAt=(UtcNow);standby=$true;idleClaimed=$false;transportProof='retain_actual_RDC_start_process_response'}
    Write-JsonAtomic (Operation-File 'readiness.json') $ready;W41-Phase $m $worker 'READY_STANDBY'
    $ready|ConvertTo-Json -Depth 14 -Compress
    while($true){
      if((Read-Json (Operation-File 'state.json')).state -ceq 'CLOSED'){return}
      if([DateTimeOffset]::UtcNow -ge (Rdc-Time $m.operationExpiresAt)){W41-Phase $m $worker 'EXPIRED';return}
      $null=W41-Binding -Activation;$null=Rdc-Ancestry $m
      Write-JsonAtomic (Operation-File 'heartbeat.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;deviceId=$DeviceId;phase='READY_STANDBY';worker=$worker;heartbeatAt=(UtcNow)}
      $request=Read-Json (Operation-File 'activate.request.json')
      if($request){
        if($request.operationId -cne $OperationId -or $request.nonce -cne $Nonce -or $request.metadataSha256 -cne $MetadataSha256 -or $request.deviceId -cne $DeviceId -or $request.action -cne 'activate'){throw '17841 foreign activation request refused'}
        W41-RequestProof $m $ready $request.handoffPath $request.handoffSha256 $request.transportReceiptPath $request.transportReceiptSha256
        $control=[IO.File]::Open((Operation-File 'control.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try{
          if((Read-Json (Operation-File 'state.json')).state -cne 'READY_STANDBY'){throw '17841 activation no longer accepted'}
          Rdc-New (Operation-File 'activation.claim.json') @{operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;handoffSha256=$request.handoffSha256;transportReceiptSha256=$request.transportReceiptSha256;claimedAt=(UtcNow)}
          W41-Phase $m $worker 'ACTIVATION_CLAIMED'
        }finally{$control.Dispose()}
        try{$result=W41-Activate $m $worker}catch{$result=W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'guard_or_observation_failed_no_automatic_replay';$result.lastPhase=(Read-Json (Operation-File 'state.json')).state}
        Rdc-New (Operation-File 'result.json') $result;W41-Phase $m $worker $result.state
        $result|ConvertTo-Json -Depth 12 -Compress;return
      }
      Start-Sleep -Seconds $HeartbeatSeconds
    }
  }finally{$lock.Dispose()}
}
function W41-Close {
  $null=W41-Binding -ReadOnly
  $control=[IO.File]::Open((Operation-File 'control.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    $state=Read-Json (Operation-File 'state.json')
    if($state.state -notin @('ARMED','READY_STANDBY','EXPIRED','NOT_ACTIVATED','NO_CHANGE','ACTIVATED','RECOVERED')){throw '17841 active/unknown/HOLD capsule must be reconciled before close'}
    if($state.state -in @('ARMED','READY_STANDBY') -and (Test-Path -LiteralPath (Operation-File 'activate.request.json'))){throw '17841 pending activation cannot be cancelled by close'}
    Write-JsonAtomic (Operation-File 'state.json') @{state='CLOSED';operationId=$OperationId;updatedAt=(UtcNow)}
    @{ok=$true;state='CLOSED';operationId=$OperationId;target='17841-only'}|ConvertTo-Json -Compress
  }finally{$control.Dispose()}
}


# V2 has no legacy transport fallback. This preparation does not execute it.
try {
  if($PSVersionTable.PSVersion -lt [version]'7.5'){throw 'V2 requires PowerShell 7.5+'}
  switch($Mode){'arm'{W41-Arm};'planned-stop'{V10-PlannedStop};'watch'{W41-Watch};'status'{W41-Status};'signal'{W41-Signal};'close'{W41-Close};default{throw 'V2 has no owner-exit trigger'}}
} catch {
  # Error sanitization must never replace the original refusal with another error.
  $failureRecord=$_
  $failureLine=0
  $failureFunction='V10_RECOVERY_GUARD'
  $failureCode='GUARD_REFUSAL_DETAILS_REDACTED'
  $reporting='SAFE_FALLBACK'
  try {
    $functions=@('V10-Turn','V10-Policy','V10-Tasks','V10-Descendants','V10-Scope','V10-LiveGate','V10-Release','V10-ActivationProof','V10-Admin','V10-PlannedStop','W49-Convention','W49-RegisteredProof','W49-HeldAcl','W49-TrustedAcl','W49-OpenImage','W49-ImageSnapshot','W49-EnsureImage','W49-RegisteredIdentity','W46-DocumentPin','W46-AclSnapshot','W46-CurrentGrant','W46-GrantParents','W44-SourceConvention','W44-SourceAcl','W44-StreamHash','W42-CapturePreimages','W42-Storage','W42-PrivateAcl','W42-Parents','W41-Observe','W41-Arm','W41-Pins','W41-Binding')
    if($null -ne $failureRecord.InvocationInfo){$failureLine=[int]$failureRecord.InvocationInfo.ScriptLineNumber}
    $frames=[regex]::Matches([string]$failureRecord.ScriptStackTrace,'(?m)^at (?<fn>[-A-Za-z0-9_<>]+), [^\r\n]+: line (?<line>[0-9]+)\r?$')
    if($frames.Count -gt 0){
      $failureLine=[int]$frames[0].Groups['line'].Value
      $name=[string]$frames[0].Groups['fn'].Value
      if($name -cin $functions){$failureFunction=$name}
    }
    $codes=@('V10_TURN_BINDING','V10_NORMAL_COMPLETION_REQUIRED','V10_IMMUTABLE_LIFECYCLE_REQUIRED','V10_RESTART_TASK_NOT_DISABLED','V10_TASK_XML_CAS','V10_TASK_INVENTORY_CAS','V10_SCHEDULER_QUIET_REQUIRED','V10_DESCENDANT_INVENTORY_UNKNOWN','V10_TARGET_OWNER_CAS','V10_EXACT_SCOPE_PATH_REQUIRED','V10_ROOT_SCOPE_OWNER','V10_SCOPE_BINDING','V10_SCOPE_LEASE','V10_UNKNOWN_MUST_REMAIN_NULL','V10_QUARANTINE_REQUIRED','V10_EXACT_AUTHORIZATION_REFERENCE','V10_SOURCE_COMPLETION_BINDING','V10_ACTUAL_WORK_EVIDENCE_REQUIRED','V10_ORIGINAL_OUTCOME_BINDING','V10_KNOWN_WORK_RELEASE_BINDING','V10_KNOWN_ACTIVE_TARGET_REFUSED','V10_ACTUAL_SERVICE_GENERATION_REQUIRED','V10_ORIGINAL_OWNER_BINDING','V10_LEGACY_OWNER_UNKNOWN_CONTRACT','V10_KNOWN_ACTIVITY_NOT_ZERO','V10_ADMISSION_STATE_CHANGED','V10_NEW_OR_CHANGED_DESCENDANT','V10_ACTUAL_PLANNED_RELEASE_REQUIRED','V10_ORIGINAL_ACTIVATION_PROOF_REQUIRED','V10_ADMIN_ACTION_REFUSED','V10_AUTHENTICATED_ACTION_REFUSED','V10_AUTHENTICATED_ACK_UNKNOWN','V10_ORIGINAL_WORKER_CHILD_REQUIRED','V10_EXACT_STOP_INTENT_REQUIRED','V10_DRAIN_ACK_UNKNOWN','V10_OLD_DESCENDANT_REQUIRES_RECONCILIATION','V10_SHUTDOWN_OWNER_CHANGED','V10_SHUTDOWN_COMPLETION_UNKNOWN','V9_IMAGE_PARENT_OPEN_REFUSED','V9_IMAGE_HANDLE_UNKNOWN','V9_IMAGE_HANDLE_TYPE','V9_IMAGE_HANDLE_PATH_UNKNOWN','V9_IMAGE_HANDLE_PATH_CAS','V9_IMAGE_SECURITY_UNKNOWN','V9_IMAGE_LINK_ENUM_UNKNOWN','V9_IMAGE_LINK_PATH','V9_IMAGE_LINK_ENUM_BOUND','V9_IMAGE_LINK_DUPLICATE','V9_IMAGE_DOCUMENT_PIN','V9_IMAGE_DOCUMENT_CONTENT_CAS','V9_IMAGE_CONVENTION_REQUIRED','V9_IMAGE_FRESH_OPERATION_REGISTRATION','V9_IMAGE_OFFICIAL_PROBE_REQUIRED','V9_IMAGE_REGISTERED_ANCESTRY_REQUIRED','V9_IMAGE_PARENT_OWNER','V9_IMAGE_OWNER_ACL_CAS','V9_IMAGE_DACL_UNKNOWN','V9_IMAGE_FOREIGN_MUTATION_AUTHORITY','V9_IMAGE_HARDLINK_PROVENANCE','V9_IMAGE_FOREIGN_HARDLINK','V9_IMAGE_PARENT_LINK','V9_IMAGE_TYPE','V9_IMAGE_LINK_ID_CAS','V9_IMAGE_BYTES_CAS','V9_IMAGE_LINK_SET_CAS','V9_IMAGE_PARENT_ID_CAS','V9_IMAGE_PARENT_ACL_CAS','V9_IMAGE_HELD_BYTES_ACL_CAS','V9_IMAGE_SIGNATURE_CAS','V9_IMAGE_REGISTRATION_CAS','V9_IMAGE_HELD_PROOF_CAS','V9_IMAGE_OPERATION_PROOF_CAS','V9_IMAGE_REGISTERED_ANCESTOR_ONLY','V9_IMAGE_PROCESS_CAS','V9_RUNTIME_NUMERIC_IDLE_UNKNOWN_REQUIRED','V6_SOURCE_PATH_LINK','V6_SOURCE_ACCESS_DOCUMENT_PIN','V6_SOURCE_ACCESS_DOCUMENT_CAS','V6_SOURCE_ACCESS_DOCUMENT_CONTENT_CAS','V6_SOURCE_RULE_SCHEMA','V6_SOURCE_ACL_OWNER_PROTECTION_CAS','V6_SOURCE_RULE_COUNT_CAS','V6_SOURCE_RULE_PROVENANCE_CAS','V6_CURRENT_SID_GRANT_COUNT','V6_CURRENT_SID_GRANT_PROVENANCE','V6_GRANT_PARENT_ANCESTRY','V6_GRANT_PARENT_SCHEMA','V6_GRANT_PARENT_TYPE','V6_SOURCE_ACCESS_CONVENTION_REQUIRED','V6_SOURCE_ACCESS_PIN_SET','V6_SOURCE_ACCESS_PIN_BINDING','V6_INHERITED_GRANT_CONTRACT_REQUIRED','17841 file pin changed','17841 process command inventory is UNKNOWN','17841 target image inventory is UNKNOWN','17841 full runtime inventory changed','17841 process marker does not match actual owner','17841 owner or absence is UNKNOWN','17841 health observation is UNKNOWN','W42_PARENT_OWNER_ACL_CAS','W42_SHARED_DIRECTORY_OWNER','V4_SOURCE_CONVENTION_REQUIRED','V4_SOURCE_PIN_SET','V4_SOURCE_PIN_BINDING','V4_SOURCE_OWNER_ACL_CAS','V4_SOURCE_EXISTING_ACCESS_REQUIRED','V4_SOURCE_BYTES_CAS','V4_SOURCE_HANDLE_CAS','V4_SOURCE_METADATA_CAS','V4_EXISTING_OBJECT_COMMIT_REQUIRED','HANDLE_IDENTITY_UNKNOWN','HANDLE_LINK_REFUSED','HANDLE_PATH_UNKNOWN','HANDLE_PATH_CAS')
    $message=[string]$failureRecord.Exception.Message
    if($message -cin $codes){$failureCode=$message}
    $reporting='SAFE_FIELDS_ONLY'
  } catch {
    # Preserve HOLD and the initial safe defaults; no recovery action is run here.
  }
  @{ok=$false;state='HOLD';target='17841-only';operationId=$OperationId;reason='capsule_guard_or_observation_refused';failureLine=$failureLine;failureFunction=$failureFunction;failureCode=$failureCode;errorReporting=$reporting;noReplay=$true;verification='NOT_RUN'}|ConvertTo-Json -Compress
  exit 1
}

finally {
  # Keep held image/alias/parent identities through standby, activation/outcome.
  if($null -ne $script:W49ImageLease){
    $resources=$script:W49ImageLease.resources
    for($i=$resources.Count-1;$i -ge 0;$i--){$resources[$i].Dispose()}
  }
}

