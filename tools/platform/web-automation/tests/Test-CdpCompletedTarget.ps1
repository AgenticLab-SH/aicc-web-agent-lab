#requires -Version 7.5
$ErrorActionPreference='Stop'
$tool=Join-Path $PSScriptRoot '../Manage-CdpChromeSlotLease.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($tool,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
foreach($name in @('Stop-ReadProof','Get-ProofHash','Get-ProofTextHash','Get-CompletedTargetArchive','Assert-CompletedTargetLive')){
 $fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -EQ $name
 if(@($fn).Count -ne 1){throw "missing function $name"};Invoke-Expression $fn.Extent.Text
}
function Get-TargetHistoryDirectory {return 'fixture'}
function Read-TargetHistory {return @{event=@{receipt_sha256=('b'*64);prompt_sha256=('c'*64);identityHash='identity';workspaceIdentityHash='workspace'}}}
function Read-BoundedProofJson {return $script:archive}
function Get-TargetIdentityProof {return @{identityHash='identity';workspaceIdentityHash='workspace'}}
function Get-CdpTargets {return @(@{id=('A'*32);webSocketDebuggerUrl='ws://127.0.0.1:9223/devtools/page/fixture'})}
function Invoke-CdpBrowserCommand {return @{result=@{value=$script:live}}}
$CompletionReceipt=Join-Path ([Environment]::GetFolderPath('UserProfile')) 'fixture-completion.json';$CompletionReceiptSha256='a'*64
$lease=@{port=9223;target_id=('A'*32);read_id='fixture';account_alias='fixture';workspace='business'}
$value=@{schemaVersion=1;action='read-existing';executor='registered_cdp';submissions=0;readLease=@{returned=$true;acquired=$true};
 reconciliation=@{proof='exact_target_dom';domComplete=$true;promptSha256=('c'*64);userTurnId=('d'*36);assistantTurnId=('e'*36)};
 turns=@{user=1;assistant=1};original=@{receiptSha256=('b'*64);promptSha256=('c'*64);targetIdHash=(Get-ProofTextHash ("registered-review-target"+[char]0+('A'*32)))};
 accountAlias='fixture';workspaceAlias='business';body=@{kind='dom_original_assistant';value='archived body'};conversationUrl=('https://chatgpt.com/c/'+('f'*36))}
$script:archive=@{sha256=('a'*64);value=$value}
$script:live=@{href=$value.conversationUrl;userIds=@('d'*36);assistantIds=@('e'*36);body='archived body'}
$count=0
$null=Get-CompletedTargetArchive $lease;Assert-CompletedTargetLive @{} $lease $archive;$count+=2
foreach($mutation in @('pending','unreturned','changedHash','wrongTarget','emptyBody')){
 $saved=$value|ConvertTo-Json -Depth 9|ConvertFrom-Json -AsHashtable
 switch($mutation){pending{$value.reconciliation.domComplete=$false}unreturned{$value.readLease.returned=$false}changedHash{$value.original.receiptSha256='x'}wrongTarget{$value.original.targetIdHash='x'}emptyBody{$value.body.value=''}}
 $denied=$false;try{$null=Get-CompletedTargetArchive $lease}catch{$denied=$true};if(-not $denied){throw "not denied $mutation"};$count++
 $value=$saved;$script:archive.value=$value
}
foreach($mutation in @('draftOrGenerating','changedBody','extraTurn','changedConversation','wrongIdentity')){
 $script:live=@{href=$value.conversationUrl;userIds=@('d'*36);assistantIds=@('e'*36);body='archived body'}
 switch($mutation){draftOrGenerating{$script:live=$null}changedBody{$script:live.body='changed'}extraTurn{$script:live.userIds=@(('d'*36),('f'*36))}changedConversation{$script:live.href='https://chatgpt.com/c/other'}wrongIdentity{$script:live.assistantIds=@('f'*36)}}
 $denied=$false;try{Assert-CompletedTargetLive @{} $lease $archive}catch{$denied=$true};if(-not $denied){throw "not denied $mutation"};$count++
}
@{ok=$true;passed=$count;failed=0;liveChanges=0}|ConvertTo-Json -Compress
