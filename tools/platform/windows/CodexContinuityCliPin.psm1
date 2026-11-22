#requires -Version 7.5
$ErrorActionPreference='Stop'
function Pin-Hash([byte[]]$Bytes){[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($Bytes))}
function Pin-Path([string]$Path){[IO.Path]::GetFullPath($Path)}
function Read-PinRegistry([string]$Path){
 $item=Get-Item -LiteralPath $Path
 if($item.LinkType -or $item.Length -gt 2097152){throw 'registry_file_unsafe'}
 $bytes=[IO.File]::ReadAllBytes($Path)
 @{bytes=$bytes;config=([Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json -AsHashtable -DateKind String)}
}
# This immutable installed helper was reviewed: Desktop queue dispatch pins its
# own signed binary; its watcher only observes an existing queue and continues.
# Other helper generations remain HOLD until their dependency contract is reviewed.
$script:DesktopQueueDependencyHelperSha256='1c4f06903b380a79f7a31207f7bb972fcee2a0789a993c5f128016bd5ac7cfc7'
# Reviewed stopped-maintenance generation retains the global pending-delivery
# dispatch fence. Only its complete installed closure can preserve old receipts.
$script:MaintenanceQueueDependencyHelperSha256='c43ccbfb61c361d24d3a9268bce181d6d5fac903cda073b04d2333c285384cf2'
# Owner-reviewed immutable stopped helper generations. Every release dependency
# and original queue receipt must still pass the complete stop/closure proof.
$script:AdditionalStoppedQueueHelpers=@(
 '4e7b13ec389a57043be3f4d0dad29507e13ec0fe0f61f21697492e9117dae4f3',
 'adb5a192be597ac6af4a4805311ead1d2e42291238da7946c3ff4e26c49410fc'
)
function Test-PinQueueHelper($cfg){
 if($cfg.helperSha256 -ceq $script:DesktopQueueDependencyHelperSha256){return $true}
 if($cfg.helperSha256 -cne $script:MaintenanceQueueDependencyHelperSha256 -and
    $cfg.helperSha256 -cnotin $script:AdditionalStoppedQueueHelpers){return $false}
 $pin=$cfg.strictRouteLauncher
 if(-not $cfg.workerStopRequestedAt -or $cfg.worker.state -cne 'STOPPED_FOR_MAINTENANCE' -or
    -not $pin -or $pin.schemaVersion -ne 1 -or $pin.route -cne 'command-route-r2' -or
    $pin.codexSha256 -cne $cfg.codexSha256 -or $pin.files -isnot [Collections.IDictionary] -or
    -not [IO.Path]::IsPathFullyQualified([string]$pin.releaseRoot)){return $false}
 $root=[IO.Path]::GetFullPath($pin.releaseRoot)
 $helper=Join-Path $root 'tools/platform/windows/Invoke-AiccCodexContinuity.ps1'
 if([IO.Path]::GetFullPath($cfg.helperPath) -ine $helper -or
    $pin.files['tools/platform/windows/Invoke-AiccCodexContinuity.ps1'] -cne $cfg.helperSha256){return $false}
 foreach($relative in $pin.files.Keys){
  if([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':') -or $relative -match '(^|[\\/])\.\.([\\/]|$)'){return $false}
  $file=[IO.Path]::GetFullPath((Join-Path $root $relative))
  for($path=$file;$path.Length -ge $root.Length;$path=[IO.Path]::GetDirectoryName($path)){
   if((Get-Item -LiteralPath $path -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){return $false}
   if($path -ieq $root){break}
  }
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.files[$relative]){return $false}
 }
 return $true
}
function Get-PinValueDigest($value){
 function Sort-PinValue($v){
  if($v -is [Collections.IDictionary]){$o=[ordered]@{};foreach($k in @($v.Keys|Sort-Object)){$o[$k]=Sort-PinValue $v[$k]};return ,$o}
  if($v -is [array]){return ,@($v|ForEach-Object {Sort-PinValue $_})}
  return $v
 }
 $canonical=Sort-PinValue $value
 Pin-Hash ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $canonical -Depth 30 -Compress)))
}
function Assert-PinNoDispatch($cfg,[string]$StateRoot,[string]$OldHash,[string]$NewHash){
 if($cfg.schemaVersion -ne 1 -or $cfg.protocolVersion -ne 3 -or $cfg.nativeFallback -ne $false){throw 'registered_configuration_identity_hold'}
 if($cfg.worker.state -eq 'RUNNING_REGISTERED_THREAD'){throw 'existing_dispatch_preserved'}
 if($cfg.workerStopRequestedAt -and $cfg.worker.state -cne 'STOPPED_FOR_MAINTENANCE'){throw 'worker_maintenance_exit_unconfirmed'}
 if(-not $cfg.helperPath -or (Get-FileHash -LiteralPath $cfg.helperPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $cfg.helperSha256){throw 'installed_helper_identity_hold'}
 $proofs=@()
 foreach($id in @($cfg.threads.Keys|Sort-Object)){
  $entry=$cfg.threads[$id];$q=$entry.queueAttempt
  if($entry.attempt){throw 'existing_dispatch_preserved'}
  if(-not $q){if($entry.state -match 'UNKNOWN|UNCERTAIN|RESUMING_OCX|DISPATCH_CLAIMED'){throw 'existing_dispatch_preserved'};continue}
  # No force flag: only an already accepted, disabled, non-replayed Desktop
  # transport with independent historical binary pin can be preserved in scope.
  if(-not (Test-PinQueueHelper $cfg) -or $entry.enabled -isnot [bool] -or $entry.enabled -cne $false -or $entry.state -cne 'DISABLED' -or $entry.threadId -cne $id -or
    $q.transport -cne 'codex-queue' -or $q.binarySource -cne 'signed-desktop-transport' -or $q.automaticReplay -isnot [bool] -or $q.automaticReplay -cne $false -or $q.state -cne 'QUEUE_ACCEPTED' -or $q.exitCode -ne 0 -or
    $q.binarySha256 -cnotmatch '^[a-f0-9]{64}$' -or $q.binarySha256 -cin @($OldHash,$NewHash) -or $q.threadId -cne $id -or
    $q.id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $q.queuedMessageId -cnotmatch '^[a-f0-9-]{36}$' -or $q.marker -cne ('AICC_QUEUE_ATTEMPT:'+$q.id)){
   throw 'existing_dispatch_preserved'
  }
  $requestRoot=Join-Path $StateRoot 'requests';$receiptFile=Join-Path $requestRoot ($q.id+'.json')
  foreach($folder in @($StateRoot,$requestRoot)){if((Get-Item -LiteralPath $folder).LinkType){throw 'queue_receipt_path_unsafe'}}
  $receipt=Read-PinRegistry $receiptFile
  $queueHash=Get-PinValueDigest $q
  if((Get-PinValueDigest $receipt.config) -cne $queueHash){throw 'desktop_queue_receipt_binding_changed'}
  $proofs+=@{threadId=$id;attemptId=$q.id;binarySource=$q.binarySource;binarySha256=$q.binarySha256;queueSha256=$queueHash;receiptFile=$receiptFile;receiptSha256=(Pin-Hash $receipt.bytes);helperSha256=$cfg.helperSha256}
 }
 return $proofs
}
function Enter-PinMaintenanceFence($cfg,[string]$StateRoot){
 if(-not $cfg.workerStopRequestedAt){return $null}
 if($cfg.worker.state -cne 'STOPPED_FOR_MAINTENANCE' -or [int]$cfg.worker.pid -le 0){throw 'worker_maintenance_exit_unconfirmed'}
 # The installed worker takes this lock before reading or dispatching. Holding
 # it excludes task recovery while the old worker's actual exit is checked.
 $file=Join-Path $StateRoot 'worker.lock'
 if((Get-Item -LiteralPath $file -ErrorAction Stop).LinkType){throw 'worker_lock_alias_forbidden'}
 $handle=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{
  $processes=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$cfg.worker.pid) -ErrorAction Stop)
  if($processes.Count){throw 'worker_maintenance_exit_unconfirmed'}
  return $handle
 }catch{$handle.Dispose();throw}
}
function Get-PinScope($cfg,[string]$Contract){
 $copy=($cfg|ConvertTo-Json -Depth 30 -Compress)|ConvertFrom-Json -AsHashtable -DateKind String
 $ignored=@()
 if($copy.worker -and $copy.worker.ContainsKey('heartbeatAt')){$copy.worker.Remove('heartbeatAt');$ignored+='/worker/heartbeatAt'}
 if($Contract -ceq 'pin-stable-v2' -and $copy.helperSha256 -ceq $script:DesktopQueueDependencyHelperSha256){
  foreach($id in @($copy.threads.Keys)){
   $e=$copy.threads[$id]
   # These exact installed-helper branches only observe Desktop/archived work
   # and continue before CLI dispatch. State/hold/owner/enable remain strict CAS.
   $nonDispatchObservation=($e.state -ceq 'DESKTOP_QUEUE_WAIT' -and $e.executionSurface -ceq 'desktop') -or ($e.state -ceq 'ARCHIVED_THREAD_HOLD' -and $e.availabilityState -ceq 'ARCHIVED_THREAD_HOLD')
   if($e.enabled -is [bool] -and $e.enabled -ceq $true -and -not $e.attempt -and -not $e.queueAttempt -and $id -notin $copy.excludedThreadIds -and $nonDispatchObservation){
    $valid=$true
    foreach($key in @('observedAt','nextCheckAt')){
     $stamp=[DateTimeOffset]::MinValue
     if(-not $e.ContainsKey($key) -or $e[$key] -isnot [string] -or -not [DateTimeOffset]::TryParseExact($e[$key],'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$stamp)){$valid=$false}
    }
    if($valid){foreach($key in @('observedAt','nextCheckAt')){$e.Remove($key);$ignored+=('/threads/'+$id+'/'+$key)}}
   }
  }
 }
 @{config=$copy;ignoredTelemetry=@($ignored|Sort-Object)}
}
function Get-PinScopeDigest($cfg,[string]$Contract){Get-PinValueDigest (Get-PinScope $cfg $Contract).config}
function Get-PinStableScope($cfg){
 $scope=Get-PinScope $cfg 'pin-stable-v2';$fields=@{}
 function Add-PinField($path,$value){$fields[$path]=@{kind=if($null -eq $value){'null'}elseif($value -is [Collections.IDictionary]){'object'}elseif($value -is [array]){'array'}else{$value.GetType().Name};sha256=(Get-PinValueDigest $value)}}
 function Escape-PinKey($key){([string]$key).Replace('~','~0').Replace('/','~1')}
 foreach($key in $scope.config.Keys){
  $value=$scope.config[$key];$path='/'+(Escape-PinKey $key)
  if($key -ceq 'threads' -and $value -is [Collections.IDictionary]){
   Add-PinField ($path+'/@members') @($value.Keys|Sort-Object)
   foreach($id in $value.Keys){foreach($field in $value[$id].Keys){Add-PinField ($path+'/'+(Escape-PinKey $id)+'/'+(Escape-PinKey $field)) $value[$id][$field]}}
  }elseif($key -ceq 'worker' -and $value -is [Collections.IDictionary]){foreach($field in $value.Keys){Add-PinField ($path+'/'+(Escape-PinKey $field)) $value[$field]}}
  else{Add-PinField $path $value}
 }
 @{schemaVersion=1;fields=$fields;ignoredTelemetry=$scope.ignoredTelemetry}
}
function Assert-PinPreviewScope($cfg,$p){
 if($p.scopeContract -and $p.scopeContract -cne 'pin-stable-v2'){throw 'unsupported_pin_scope_contract'}
 if($p.scopeContract -ceq 'pin-stable-v2'){
  $actual=Get-PinStableScope $cfg
  if($p.stableScope.schemaVersion -ne 1 -or -not $p.stableScope.fields){throw 'stable_scope_structure_required'}
  $changed=@(foreach($path in @(@($actual.fields.Keys)+@($p.stableScope.fields.Keys)|Sort-Object -Unique)){
   if(-not $actual.fields.ContainsKey($path) -or -not $p.stableScope.fields.ContainsKey($path) -or (Get-PinValueDigest $actual.fields[$path]) -cne (Get-PinValueDigest $p.stableScope.fields[$path])){$path}
  })
  if($changed.Count){throw ('cli_pin_preview_scope_changed:'+($changed -join ','))}
 }
 if((Get-PinScopeDigest $cfg $p.scopeContract) -cne $p.registryScopeSha256){throw 'cli_pin_preview_scope_changed'}
}
function New-PinRegistryBytes([byte[]]$Before,[string]$OldHash,[string]$NewHash){
 if($OldHash -cnotmatch '^[a-f0-9]{64}$' -or $NewHash -cnotmatch '^[a-f0-9]{64}$'){throw 'exact_cli_hash_required'}
 if(-not ('AiccScopedPinBytesV1' -as [type])){
 Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
public static class AiccScopedPinBytesV1 {
 public static byte[] Replace(byte[] before, string oldHash, string newHash) {
  var reader = new Utf8JsonReader(before, new JsonReaderOptions { MaxDepth = 64 });
  var offsets = new List<int>();
  var rootKeys = new HashSet<string>(StringComparer.Ordinal);
  var pinKeys = new HashSet<string>(StringComparer.Ordinal);
  string topKey = null, pinKey = null;
  bool root = false, strict = false; int strictObjects = 0;
  while(reader.Read()) {
   if(reader.TokenType == JsonTokenType.StartObject && reader.CurrentDepth == 0) { if(root) throw new Exception("duplicate_root"); root = true; }
   if(reader.TokenType == JsonTokenType.PropertyName && reader.CurrentDepth == 1) {
    topKey = reader.GetString();
    if(!rootKeys.Add(topKey)) throw new Exception("duplicate_top_level_property");
   } else if(reader.CurrentDepth == 1 && topKey == "strictRouteLauncher" && reader.TokenType != JsonTokenType.EndObject) {
    if(reader.TokenType != JsonTokenType.StartObject) throw new Exception("strict_launcher_object_required");
    strict = true; strictObjects++;
   }
   if(strict && reader.TokenType == JsonTokenType.PropertyName && reader.CurrentDepth == 2) {
    pinKey = reader.GetString();
    if(!pinKeys.Add(pinKey)) throw new Exception("duplicate_strict_launcher_property");
   }
   bool selected = (reader.CurrentDepth == 1 && topKey == "codexSha256") || (strict && reader.CurrentDepth == 2 && pinKey == "codexSha256");
   if(selected && reader.TokenType != JsonTokenType.PropertyName) {
    if(reader.TokenType != JsonTokenType.String || reader.HasValueSequence || reader.ValueSpan.Length != 64 || reader.GetString() != oldHash) throw new Exception("exact_selected_pin_required");
    int offset = checked((int)reader.TokenStartIndex + 1);
    if(Encoding.UTF8.GetString(before,offset,64) != oldHash) throw new Exception("literal_selected_pin_required");
    offsets.Add(offset);
   }
   if(strict && reader.TokenType == JsonTokenType.EndObject && reader.CurrentDepth == 1) strict = false;
  }
  if(!root || !rootKeys.Contains("codexSha256") || (strictObjects > 0 && !pinKeys.Contains("codexSha256")) || offsets.Count != 1+strictObjects) throw new Exception("unique_selected_pin_required");
  var after=(byte[])before.Clone(); var value=Encoding.ASCII.GetBytes(newHash);
  foreach(int offset in offsets) Buffer.BlockCopy(value,0,after,offset,64);
  return after;
 }
}
"@
 }
 [AiccScopedPinBytesV1]::Replace($Before,$OldHash,$NewHash)
}

function Assert-PinFile([string]$Path,[string]$Hash,[string]$Signer){
 if($Hash -cnotmatch '^[a-f0-9]{64}$' -or $Signer -cnotmatch '^[A-F0-9]{40}$'){throw 'exact_hash_and_signer_required'}
 $item=Get-Item -LiteralPath $Path
 if($item.LinkType -or $item.PSIsContainer){throw 'codex_release_file_unsafe'}
 if((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash){throw 'codex_release_hash_changed'}
 $sig=Get-AuthenticodeSignature -LiteralPath $Path
 if($sig.Status -ne 'Valid' -or -not $sig.SignerCertificate -or $sig.SignerCertificate.Subject -notmatch '(?:^|, )O="?OpenAI OpCo, LLC"?(?:,|$)' -or $sig.SignerCertificate.Thumbprint -cne $Signer){throw 'valid_exact_openai_signature_required'}
}
function Get-PinSigners($p){
 # Legacy plans bind one exact certificate to both files. Rotation requires an
 # explicit exact pair; mixing the two contracts is never inferred or accepted.
 if($p.signerThumbprint){
  if($p.oldSignerThumbprint -or $p.newSignerThumbprint){throw 'exclusive_exact_signer_contract_required'}
  return @{old=$p.signerThumbprint;new=$p.signerThumbprint}
 }
 if(-not $p.oldSignerThumbprint -or -not $p.newSignerThumbprint){throw 'exact_old_and_new_signers_required'}
 return @{old=$p.oldSignerThumbprint;new=$p.newSignerThumbprint}
}
function Assert-PinLayout($p){
 $signers=Get-PinSigners $p
 $root=Pin-Path $p.standaloneRoot;$current=Join-Path $root 'current'
 if((Pin-Path $p.anchor) -ine (Pin-Path (Join-Path $current 'bin/codex.exe'))){throw 'codex_anchor_changed'}
 $link=Get-Item -LiteralPath $current
 if($link.LinkType -ne 'Junction'){throw 'managed_current_junction_required'}
 foreach($key in @('oldRelease','newRelease')){
  $release=Pin-Path $p[$key];$item=Get-Item -LiteralPath $release
  if($item.LinkType -or -not $item.PSIsContainer -or [IO.Path]::GetDirectoryName($release) -ine (Join-Path $root 'releases')){throw 'exact_managed_release_required'}
  $bin=Get-Item -LiteralPath (Join-Path $release 'bin')
  if($bin.LinkType -or -not $bin.PSIsContainer){throw 'release_bin_alias_forbidden'}
 }
 if($link.ResolveLinkTarget($true).FullName -ine $p.newRelease){throw 'current_release_path_cas_failed'}
 Assert-PinFile (Join-Path $p.oldRelease 'bin/codex.exe') $p.oldSha256 $signers.old
 Assert-PinFile (Join-Path $p.newRelease 'bin/codex.exe') $p.newSha256 $signers.new
 if((Get-FileHash -LiteralPath $p.anchor -Algorithm SHA256).Hash.ToLowerInvariant() -cne $p.newSha256){throw 'current_anchor_hash_changed'}
}
function Enter-PinRegistryLock([string]$StateRoot){
 $path=Join-Path $StateRoot 'registrations.json.lock'
 for($i=0;$i -lt 20;$i++){try{return [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch [IO.IOException]{Start-Sleep -Milliseconds 100}}
 throw 'registry_busy_preserved'
}
function New-AiccContinuityCliPinPlan{
 param([string]$StateRoot,[string]$StandaloneRoot,[string]$OldRelease,[string]$NewRelease,[string]$ExpectedOldSha256,[string]$ExpectedNewSha256,[string]$ExpectedSignerThumbprint,[string]$ExpectedOldSignerThumbprint,[string]$ExpectedNewSignerThumbprint,[string]$PlanFile)
 $signers=Get-PinSigners @{signerThumbprint=$ExpectedSignerThumbprint;oldSignerThumbprint=$ExpectedOldSignerThumbprint;newSignerThumbprint=$ExpectedNewSignerThumbprint}
 if($ExpectedOldSha256 -ceq $ExpectedNewSha256){throw 'changed_exact_cli_pin_required'}
 $p=@{schemaVersion=1;action='UpdateCodexPin';stateRoot=(Pin-Path $StateRoot);standaloneRoot=(Pin-Path $StandaloneRoot);anchor=(Pin-Path (Join-Path $StandaloneRoot 'current/bin/codex.exe'));oldRelease=(Pin-Path $OldRelease);newRelease=(Pin-Path $NewRelease);oldSha256=$ExpectedOldSha256;newSha256=$ExpectedNewSha256;oldSignerThumbprint=$signers.old;newSignerThumbprint=$signers.new;createdAt=[DateTimeOffset]::UtcNow.ToString('o');expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')}
 Assert-PinLayout $p
 $lock=Enter-PinRegistryLock $StateRoot;$maintenanceFence=$null
 try{
  $read=Read-PinRegistry (Join-Path $StateRoot 'registrations.json');$cfg=$read.config
  $maintenanceFence=Enter-PinMaintenanceFence $cfg $StateRoot
  $preservedQueues=@(Assert-PinNoDispatch $cfg $StateRoot $ExpectedOldSha256 $ExpectedNewSha256)
  if($cfg.codexExecutable -ine $p.anchor -or $cfg.codexSha256 -cne $ExpectedOldSha256){throw 'registered_cli_path_or_old_pin_changed'}
  $p.scopeContract='pin-stable-v2'
  $p.registryScopeSha256=Get-PinScopeDigest $cfg $p.scopeContract
  $p.stableScope=Get-PinStableScope $cfg
  $p.preservedQueues=$preservedQueues
 }finally{if($maintenanceFence){$maintenanceFence.Dispose()};$lock.Dispose()}
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($p|ConvertTo-Json -Depth 8)+[Environment]::NewLine)
 $file=[IO.File]::Open($PlanFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
 @{state='PREPARED';planFile=$PlanFile;planSha256=(Pin-Hash $bytes);confirmation=('APPLY CODEX PIN '+(Pin-Hash $bytes));registryChanged=$false;workerStopped=$false}
}
function Invoke-AiccContinuityCliPinPlan{
 param([string]$PlanFile,[string]$ExpectedPlanSha256,[string]$Confirm)
 $bytes=[IO.File]::ReadAllBytes($PlanFile)
 if((Pin-Hash $bytes) -cne $ExpectedPlanSha256 -or $Confirm -cne ('APPLY CODEX PIN '+$ExpectedPlanSha256)){throw 'exact_preview_confirmation_required'}
 $p=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json -AsHashtable -DateKind String
 if($p.schemaVersion -ne 1 -or $p.action -cne 'UpdateCodexPin' -or [DateTimeOffset]::Parse($p.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'stale_cli_pin_preview'}
 Assert-PinLayout $p
 $path=Join-Path $p.stateRoot 'registrations.json';$lock=Enter-PinRegistryLock $p.stateRoot;$held=@();$maintenanceFence=$null
 try{
  foreach($exe in @((Join-Path $p.oldRelease 'bin/codex.exe'),(Join-Path $p.newRelease 'bin/codex.exe'),$p.anchor)){$held+=,[IO.File]::Open($exe,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
  $read=Read-PinRegistry $path;$cfg=$read.config
  $maintenanceFence=Enter-PinMaintenanceFence $cfg $p.stateRoot
  $held+=,[IO.File]::Open($cfg.helperPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $preservedQueues=@(Assert-PinNoDispatch $cfg $p.stateRoot $p.oldSha256 $p.newSha256)
  if((Get-PinValueDigest $preservedQueues) -cne (Get-PinValueDigest @($p.preservedQueues))){throw 'preserved_queue_preview_changed'}
  foreach($queue in $preservedQueues){$held+=,[IO.File]::Open($queue.receiptFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
  if($cfg.codexExecutable -ine $p.anchor -or $cfg.codexSha256 -cne $p.oldSha256){throw 'cli_pin_preview_scope_changed:/codexExecutable,/codexSha256'}
  Assert-PinPreviewScope $cfg $p
  Assert-PinLayout $p
  $after=New-PinRegistryBytes $read.bytes $p.oldSha256 $p.newSha256
  # One-use claim after all preflight. Claim without APPLIED receipt means HOLD.
  $claim=[IO.File]::Open($PlanFile+'.claimed',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$claim.Dispose()
  $backup=$PlanFile+'.before.json';$b=[IO.File]::Open($backup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$b.Write($read.bytes);$b.Flush($true)}finally{$b.Dispose()}
  if((Pin-Hash ([IO.File]::ReadAllBytes($backup))) -cne (Pin-Hash $read.bytes)){throw 'registry_backup_verification_failed'}
  $temporary=$path+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllBytes($temporary,$after)
  Assert-PinLayout $p
  if((Pin-Hash ([IO.File]::ReadAllBytes($path))) -cne (Pin-Hash $read.bytes)){throw 'registry_bytes_cas_failed'}
  foreach($queue in $preservedQueues){if((Pin-Hash ([IO.File]::ReadAllBytes($queue.receiptFile))) -cne $queue.receiptSha256){throw 'preserved_queue_receipt_bytes_changed'}}
  [IO.File]::Move($temporary,$path,$true)
  if((Pin-Hash ([IO.File]::ReadAllBytes($path))) -cne (Pin-Hash $after)){throw 'cli_pin_readback_unknown'}
  $post=Read-PinRegistry $path
  $postQueues=@(Assert-PinNoDispatch $post.config $p.stateRoot $p.oldSha256 $p.newSha256)
  if((Get-PinValueDigest $postQueues) -cne (Get-PinValueDigest $preservedQueues)){throw 'preserved_queue_readback_unknown'}
  $signers=Get-PinSigners $p
  $receipt=@{oldSignerThumbprint=$signers.old;newSignerThumbprint=$signers.new;preservedQueues=$preservedQueues;queueOriginalBytesPreserved=$true;state='APPLIED';action='UpdateCodexPin';beforeSha256=(Pin-Hash $read.bytes);afterSha256=(Pin-Hash $after);oldCliSha256=$p.oldSha256;newCliSha256=$p.newSha256;backup=$backup;workerStopped=$false;helperChanged=$false;taskChanged=$false;automaticReplay=$false;threadStatesChanged=$false}
  [IO.File]::WriteAllText($PlanFile+'.receipt.json',($receipt|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  return $receipt
 }finally{foreach($handle in $held){$handle.Dispose()};if($maintenanceFence){$maintenanceFence.Dispose()};$lock.Dispose()}
}
Export-ModuleMember -Function New-AiccContinuityCliPinPlan,Invoke-AiccContinuityCliPinPlan
