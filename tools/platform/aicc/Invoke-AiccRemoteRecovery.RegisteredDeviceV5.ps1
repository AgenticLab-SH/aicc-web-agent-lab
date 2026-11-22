# Separately versioned RegisteredDevice V2; V1/original helper/module are immutable.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('arm', 'watch', 'status', 'signal', 'bind-owner', 'close')]
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
  [string]$DeviceRegistrationSha256
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
    $row=Rdc-Identity $cursor
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


function W44-SourceConvention($Contract) {
  $c=$Contract.sourceOwnership;$sid=W42-CurrentSid
  if($c.schema -cne 'aicc-existing-source-owner-convention/v1' -or $c.currentOwnerSid -cne $sid -or $c.preserveExistingOwnersAndAcls -ne $true){throw 'V4_SOURCE_CONVENTION_REQUIRED'}
  $expected=@{config=(Join-Path (W41-Home) 'config.json');descriptor=(Join-Path (W41-Home) 'runtime\windows-command.json');journal=(Join-Path (W41-Home) 'runtime\windows-install.json');marker=(Join-Path (W41-Home) 'runtime\windows-process.json')}
  $names=if($c.sourcePins -is [Collections.IDictionary]){@($c.sourcePins.Keys)}else{@($c.sourcePins.PSObject.Properties.Name)}
  if($names.Count -ne 4){throw 'V4_SOURCE_PIN_SET'}
  foreach($name in $expected.Keys){
    $pin=$c.sourcePins.$name;$owner=if($name -ceq 'marker'){$sid}else{'S-1-5-32-544'}
    if((W41-Path $pin.path) -ine (W41-Path $expected[$name]) -or $pin.ownerSid -cne $owner -or $pin.currentSidExplicitFullControl -ne $true -or $pin.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $pin.aclSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'V4_SOURCE_PIN_BINDING'}
  }
}
function W44-SourceAcl($Acl,$Pin) {
  if($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Pin.ownerSid -or (W42-AclHash $Acl) -cne $Pin.aclSha256){throw 'V4_SOURCE_OWNER_ACL_CAS'}
  $full=@($Acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -ceq (W42-CurrentSid) -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl})
  if($full.Count -eq 0){throw 'V4_SOURCE_EXISTING_ACCESS_REQUIRED'}
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
    $pin=$Metadata.contract.sourceOwnership.sourcePins.($saved.name)
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
    $pin=$Metadata.contract.sourceOwnership.sourcePins.($entry.Key)
    $source=Rdc-Regular $entry.Value;W44-SourceAcl (Get-Acl -LiteralPath $source) $pin;W41-HashPin $source $pin.sha256
  }
  $containerHash=W42-NewPrivateDirectory $dir $policy
  $backup=Join-Path $dir 'preimages';$backupHash=W42-NewPrivateDirectory $backup $policy
  $Metadata.privateStorage=@{container=$dir;backup=$backup;ownerSid=(W42-CurrentSid);containerAclSha256=$containerHash;backupAclSha256=$backupHash}
  foreach($entry in $Targets.GetEnumerator()){
    W42-Parents $policy;$null=W42-PrivateAcl $dir $true $containerHash;$null=W42-PrivateAcl $backup $true $backupHash
    $pin=$Metadata.contract.sourceOwnership.sourcePins.($entry.Key)
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
  if($storage.writeStrategy -cne 'held-existing-file-ReadWrite-ShareRead-v4' -or $contract.capabilities.preserveExistingFileObject -ne $true){throw 'V4_EXISTING_OBJECT_COMMIT_REQUIRED'}
  if($storage.schema -cne 'aicc-installer-private-reference/v2' -or $storage.supported -ne $true -or $storage.externalPrivateDirectoryOption -ne $true -or $contract.capabilities.operationPrivateInstaller -ne $true){throw 'W42_PRIVATE_INSTALLER_CONTRACT_REQUIRED'}
  W41-HashPin $contract.installerPath $contract.installerSha256
  W41-HashPin (Join-Path $contract.bundleRoot 'app\maintenance\private-storage-guard-v4.ps1') $storage.guardSha256
  W41-HashPin (Join-Path $contract.bundleRoot 'app\maintenance\private-preimages-v4.ts') $storage.privateModuleSha256
  W41-HashPin (Join-Path $contract.bundleRoot 'app\maintenance\windows-runtime-v4.ts') $storage.maintenanceSha256
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
    if(-not $p.CommandLine){throw '17841 process command inventory is UNKNOWN'}
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
  @{state='OWNED';owner=$owner;counts=$counts;idle=(@($counts|Where-Object{$_ -ne 0}).Count -eq 0);acceptingTurns=$health.accepting_turns;version=$health.version;observedAt=(UtcNow)}
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
  $m.sharedDirectoryPins=W42-SharedDirectories $homePath
  W41-Pins $m -Trees
  $observed=W41-Observe $m $original
  if($observed.state -cne 'OWNED' -or -not $observed.acceptingTurns){throw '17841 original owned accepting runtime required at Arm'}
  $m.originalOwner=$observed.owner
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
  $command="`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(`$false); `$OutputEncoding=[Console]::OutputEncoding; & "+(& $quote $Metadata.contract.installerPath)+' -Action '+(& $quote $Action)+' -Bundle '+(& $quote $Metadata.contract.bundleRoot)+' -HomePath '+(& $quote $Metadata.home)
  $command+=' -OperationMetadataPath '+(& $quote (Operation-File 'metadata.json'))+' -OperationMetadataSha256 '+(& $quote $MetadataSha256)
  if($Action -ceq 'start'){$command+=' -RuntimeOnly'}
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
function W41-Outcome([string]$State,[string]$Reason) { @{state=$State;reason=$Reason;operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;target='17841-only';noReplay=$true;unknownOriginalOutcomes='PRESERVED';originalRequestsReplayed=$false;completedAt=(UtcNow)} }
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
    W41-Phase $Metadata $Worker 'WAITING_FOR_IDLE' @{counts=$before.counts;observedAt=$before.observedAt}
    if($before.idle){break}
    Start-Sleep -Seconds $HeartbeatSeconds
  }
  # The supported stop command repeats exact owner/idle checks, performs the
  # authenticated atomic drain, then shutdown. No Stop-Process/taskkill fallback.
  $null=W41-Binding -Activation;$null=W41-FileSet $Metadata 'original'
  Rdc-New (Operation-File 'before-stop.json') @{operationId=$OperationId;nonce=$Nonce;owner=$before.owner;counts=$before.counts;observedAt=$before.observedAt;metadataSha256=$MetadataSha256}
  $stop=W41-Child $Metadata $Worker 'STOP_INTENT' 'stop'
  if(-not $stop.known){return (W41-Outcome 'UNCERTAIN_NO_REPLAY' 'stop_unconfirmed')}
  if($stop.exitCode -ne 0){return (W41-Recover $Metadata $Worker 'stop')}
  if(-not $stop.payload -or $stop.payload.stopped -ne $true -or $stop.payload.pid -ne $before.owner.pid){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'authenticated_stop_ack_missing')}
  $null=W41-FileSet $Metadata 'original'
  if((W41-Observe $Metadata $Metadata.originalRuntime).state -cne 'ABSENT'){return (W41-Outcome 'HOLD_RECONCILE_REQUIRED' 'shutdown_absence_unproved')}
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
    $ready=@{schema='aicc-rdc-17841-ready/v1';state='READY_STANDBY';target='17841-only';deviceId=$DeviceId;operationId=$OperationId;nonce=$Nonce;metadataSha256=$MetadataSha256;worker=$worker;ancestry=$ancestry;operationExpiresAt=$m.operationExpiresAt;recoveryExpiresAt=$m.recoveryExpiresAt;candidateManifestSha256=$m.contract.manifestSha256;contractSha256=$m.contractSha256;readyAt=(UtcNow);standby=$true;idleClaimed=$false;transportProof='retain_actual_RDC_start_process_response'}
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
  switch($Mode){'arm'{W41-Arm};'watch'{W41-Watch};'status'{W41-Status};'signal'{W41-Signal};'close'{W41-Close};default{throw 'V2 has no owner-exit trigger'}}
} catch {
  # Error sanitization must never replace the original refusal with another error.
  $failureRecord=$_
  $failureLine=0
  $failureFunction='V5_RECOVERY_GUARD'
  $failureCode='GUARD_REFUSAL_DETAILS_REDACTED'
  $reporting='SAFE_FALLBACK'
  try {
    $functions=@('W44-SourceConvention','W44-SourceAcl','W44-StreamHash','W42-CapturePreimages','W42-Storage','W42-PrivateAcl','W42-Parents','W41-Observe','W41-Arm','W41-Pins','W41-Binding')
    if($null -ne $failureRecord.InvocationInfo){$failureLine=[int]$failureRecord.InvocationInfo.ScriptLineNumber}
    $frames=[regex]::Matches([string]$failureRecord.ScriptStackTrace,'(?m)^at (?<fn>[-A-Za-z0-9_<>]+), [^\r\n]+: line (?<line>[0-9]+)\r?$')
    if($frames.Count -gt 0){
      $failureLine=[int]$frames[0].Groups['line'].Value
      $name=[string]$frames[0].Groups['fn'].Value
      if($name -cin $functions){$failureFunction=$name}
    }
    $codes=@('17841 process command inventory is UNKNOWN','17841 target image inventory is UNKNOWN','17841 full runtime inventory changed','17841 process marker does not match actual owner','17841 owner or absence is UNKNOWN','17841 health observation is UNKNOWN','W42_PARENT_OWNER_ACL_CAS','W42_SHARED_DIRECTORY_OWNER','V4_SOURCE_CONVENTION_REQUIRED','V4_SOURCE_PIN_SET','V4_SOURCE_PIN_BINDING','V4_SOURCE_OWNER_ACL_CAS','V4_SOURCE_EXISTING_ACCESS_REQUIRED','V4_SOURCE_BYTES_CAS','V4_SOURCE_HANDLE_CAS','V4_SOURCE_METADATA_CAS','V4_EXISTING_OBJECT_COMMIT_REQUIRED','HANDLE_IDENTITY_UNKNOWN','HANDLE_LINK_REFUSED','HANDLE_PATH_UNKNOWN','HANDLE_PATH_CAS')
    $message=[string]$failureRecord.Exception.Message
    if($message -cin $codes){$failureCode=$message}
    $reporting='SAFE_FIELDS_ONLY'
  } catch {
    # Preserve HOLD and the initial safe defaults; no recovery action is run here.
  }
  @{ok=$false;state='HOLD';target='17841-only';operationId=$OperationId;reason='capsule_guard_or_observation_refused';failureLine=$failureLine;failureFunction=$failureFunction;failureCode=$failureCode;errorReporting=$reporting;noReplay=$true;verification='NOT_RUN'}|ConvertTo-Json -Compress
  exit 1
}
