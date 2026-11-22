#requires -Version 7.5
# Isolated source-function exercise. Never invokes Manage-CdpChromeSlotLease.ps1's
# entry point, Chrome, native host, actual owner lease, or private user requests.
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '../Manage-CdpChromeSlotLease.ps1'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(
    [IO.Path]::GetFullPath($source),[ref]$tokens,[ref]$errors)
if(@($errors).Count){throw 'QUEUE_LEASE_MANAGER_PARSE_FAILED'}
foreach($name in @('Get-QueueOriginalRequestBinding','Write-KeepTargetHistory',
 'Assert-QueueOriginalTargetUrl')){
    $fn=@($ast.FindAll({param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -ceq $name
    },$true))
    if($fn.Count -ne 1){throw "QUEUE_RETAINED_SOURCE_FUNCTION_MISSING_$name"}
    . ([scriptblock]::Create($fn[0].Extent.Text))
}
function Sha([byte[]]$raw){
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($raw)).ToLowerInvariant()
}
function TextSha([string]$s){Sha ([Text.Encoding]::UTF8.GetBytes($s))}
function Get-ProofTextHash([string]$Text){TextSha $Text}
function Stop-ReadProof([string]$Code){throw $Code}
function Read-BoundedProofJson([string]$Path,[int]$MaxBytes=65536){
  if(-not [IO.File]::Exists($Path)){throw 'HOLD_SOURCE_FILE_MISSING'}
  $bytes=[IO.File]::ReadAllBytes($Path)
  if($bytes.Length -gt $MaxBytes){throw 'HOLD_SOURCE_TOO_LARGE'}
  [pscustomobject]@{sha256=(Sha $bytes);
    value=([Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json)}
}
function Test-LeaseExpired($Lease){return $false}
function Get-TargetHistoryDirectory([int]$Port,[string]$Id){return $script:history}
function Get-RegistrationHash($Slot){return '7'*64}
function Read-TargetHistory([string]$Directory,[string]$Name){
  if($Name -cne 'creation.json'){throw 'HOLD_SOURCE_UNEXPECTED_HISTORY'}
  return [pscustomobject]@{sha256=('8'*64);event=$script:creation}
}
function Get-TargetIdentityProof($Slot,[string]$Id){
  [pscustomobject]@{identityHash=('9'*64);workspaceIdentityHash=('a'*64);
    registration_sha256=('7'*64)}
}
function Write-TargetHistory([string]$Directory,[string]$Name,$Event){
  if($Name -cne 'release.json'){throw 'HOLD_TEST_WRONG_HISTORY_EVENT'}
  $script:releasedEvent=$Event
  return 'e'*64
}
function Get-CdpTargets($Endpoint,[switch]$Strict){
  @([pscustomobject]@{id=$script:targetId;type='page';url=$script:currentTargetUrl})
}
function Check([bool]$Condition,[string]$Name){
  if(-not $Condition){throw "QUEUE_RETENTION_TEST_FAILED_$Name"}
  $script:checks++
}
function MustRefuse([scriptblock]$Invoke,[string]$Expected){
  $message=$null
  try{$null=& $Invoke}catch{$message=$_.Exception.Message}
  Check ($message -match [regex]::Escape($Expected)) ("HOLD_"+$Expected)
}
$script:checks=0
$ownerHome=[IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile'))
$root=Join-Path $ownerHome ('AppData/Local/Temp/aicc-gptq-retained-fixture-'+[guid]::NewGuid().ToString('N'))
if((Test-Path -LiteralPath $root)){throw 'HOLD_TEST_ROOT_EXISTS'}
$null=[IO.Directory]::CreateDirectory($root)
try{
  $script:history=Join-Path $root 'target-A.history'
  $null=[IO.Directory]::CreateDirectory($script:history)
  $script:targetId='A'*32
  $nonce='b'*64
  $leaseToken='1'*32
  $conversation='11111111-1111-4111-8111-111111111111'
  $script:currentTargetUrl="https://chatgpt.com/c/${conversation}?aicc_task_target=$nonce"
  $script:QueueOwnerRequestFile=Join-Path $root 'request.json'
  $original=[ordered]@{
    schemaVersion=1;kind='aicc-gpt-queue-original-owner-request'
    ownerId='fake-bound-owner-0001';ownerIdentityHash=('2'*64)
    bindingId='fake-binding-0001';operationId='fake-operation-0001'
    roles=@(
      [ordered]@{slot='9222';targetId=$script:targetId;leaseToken=$leaseToken;
        targetNonce=$nonce;conversationId=$conversation;accountAlias='one';
        browserWorkspace='ordinary'},
      [ordered]@{slot='9223';targetId=('B'*32);leaseToken=('3'*32);
        targetNonce=('4'*64);conversationId='22222222-2222-4222-8222-222222222222';
        accountAlias='two';browserWorkspace='ordinary'}
    )
  }
  $requestText=$original|ConvertTo-Json -Compress -Depth 10
  [IO.File]::WriteAllText($script:QueueOwnerRequestFile,$requestText,[Text.UTF8Encoding]::new($false))
  $script:OriginalRequestSha256=Sha ([IO.File]::ReadAllBytes($script:QueueOwnerRequestFile))
  $script:ConversationId=$conversation
  $script:Action='Release';$script:KeepTarget=$true;$script:NoBrowser=$false
  $script:OriginalReceipt='';$script:OriginalReceiptSha256='';$script:PromptSha256=''
  $lease=[pscustomobject]@{
    port=9222;owner_id='fake-bound-owner-0001';endpoint='http://127.0.0.1:9222'
    lease_token=$leaseToken;target_id=$script:targetId;task_target_nonce=$nonce
    account_alias='one';workspace='ordinary'
  }
  $proof=Get-QueueOriginalRequestBinding $lease
  Check ($proof.kind -ceq 'aicc-queue-original-request-retained/v1') 'VALID_IDENTITY'
  Check ($proof.originalLeaseSha256 -ceq (TextSha $leaseToken)) 'LEASE_SHA_PIN'
  Check (-not (($proof|ConvertTo-Json -Compress) -match $leaseToken)) 'NO_RAW_TOKEN'
  Check ($proof.conversationId -ceq $conversation) 'EXACT_CONVERSATION'
  $script:slots=@([pscustomobject]@{port=9222;account_alias='one';workspace='ordinary'})
  $script:creation=[pscustomobject]@{
    kind='created';owner_id=$lease.owner_id;target_id=$lease.target_id
    endpoint=$lease.endpoint;write_lease_sha256=(TextSha $leaseToken)
    identity_verified=$true;registration_sha256=('7'*64)
    identityHash=('9'*64);workspaceIdentityHash=('a'*64)
  }
  $script:releasedEvent=$null
  $null=Write-KeepTargetHistory $lease
  Check ($script:releasedEvent.kind -ceq 'released' -and $script:releasedEvent.keep_target -eq $true) 'SEALED_KEEP_TARGET'
  Check ($script:releasedEvent.binding.originalRequestSha256 -ceq $script:OriginalRequestSha256) 'SEALED_REQUEST_PIN'
  Check ($script:releasedEvent.binding.originalLeaseSha256 -ceq (TextSha $leaseToken)) 'SEALED_LEASE_PIN'
  $mockTargets=@(Get-CdpTargets -Endpoint $script:slots[0].endpoint -Strict|Where-Object{
    [string]$_.id -ceq $script:targetId -and [string]$_.type -ceq 'page'
  })
  Check ($mockTargets.Count -eq 1) 'SYNTHETIC_TARGET_PROOF_PRESENT'
  $urlParsed=$null
  Check ([Uri]::TryCreate([string]$mockTargets[0].url,[UriKind]::Absolute,[ref]$urlParsed)) 'SYNTHETIC_URI_VALID'
  Check ($urlParsed.AbsolutePath -ceq "/c/$conversation") 'SYNTHETIC_CONVERSATION_PATH'
  Check ($urlParsed.Scheme -ceq 'https' -and $urlParsed.Host -ceq 'chatgpt.com') 'SYNTHETIC_ORIGIN_VALID'
  Assert-QueueOriginalTargetUrl $script:slots[0] $script:targetId $conversation $nonce
  $script:currentTargetUrl=$script:currentTargetUrl.Replace($nonce,('0'*64))
  MustRefuse {Assert-QueueOriginalTargetUrl $script:slots[0] $script:targetId $conversation $nonce} 'HOLD_QUEUE_LIVE_NONCE_UNPROVEN'
  $script:currentTargetUrl="https://chatgpt.com/c/${conversation}?aicc_task_target=$nonce"
  $badLease=$lease.PSObject.Copy();$badLease.account_alias='foreign'
  MustRefuse {Get-QueueOriginalRequestBinding $badLease} 'HOLD_QUEUE_RETENTION_ORIGINAL_LEASE_MISMATCH'
  $savedSha=$script:OriginalRequestSha256
  $script:OriginalRequestSha256='0'*64
  MustRefuse {Get-QueueOriginalRequestBinding $lease} 'HOLD_QUEUE_RETENTION_REQUEST_SHA_CHANGED'
  $script:OriginalRequestSha256=$savedSha
  $script:KeepTarget=$false
  MustRefuse {Get-QueueOriginalRequestBinding $lease} 'HOLD_QUEUE_KEEP_TARGET_REQUIRED'
  $script:KeepTarget=$true
  @{status='PASS';cases=$script:checks;safeOutput=$true;liveChrome=$false;
    realLeaseChanged=$false;queueModelSends=0}|ConvertTo-Json -Compress
}finally{
  $normal=[IO.Path]::GetFullPath($root)
  if(-not $normal.StartsWith($ownerHome+[IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path $normal -Leaf) -cnotmatch '^aicc-gptq-retained-fixture-[a-f0-9]{32}$'){
    throw 'HOLD_TEST_CLEANUP_BOUNDARY'
  }
  if(Test-Path -LiteralPath $normal){Remove-Item -LiteralPath $normal -Force -Recurse}
}
