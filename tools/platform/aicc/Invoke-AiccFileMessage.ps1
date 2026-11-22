param(
  [Parameter(Mandatory)][ValidateSet('Init','Send','Read')][string]$Action,
  [Parameter(Mandatory)][string]$OperationId,
  [ValidateSet('codex','webgpt')][string]$Role = 'codex',
  [string]$Nonce,
  [string]$BodyPath,
  [string]$MessageId,
  [string]$ReplyTo,
  [string]$ReplySha256,
  [string]$Root = (Join-Path $env:USERPROFILE '.ai-control-center\control-plane\file-mailboxes')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
if ($OperationId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{5,63}$') { throw 'Invalid operation ID' }
$allowed = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.ai-control-center\control-plane\file-mailboxes'))
$Root = [IO.Path]::GetFullPath($Root)
if (-not $Root.Equals($allowed,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unregistered mailbox root' }
$dir = Join-Path $Root $OperationId
function Assert-Regular([string]$p) {
  for ($cursor = $p; $cursor; $cursor = Split-Path -Parent $cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked mailbox path refused' }
    }
  }
}
function Hash-Text([string]$s) {
  $h = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($h.ComputeHash($utf8.GetBytes($s)))).Replace('-','').ToLowerInvariant() } finally { $h.Dispose() }
}
function Publish-New([string]$p,[object]$v) {
  $tmp = "$p.$([Guid]::NewGuid().ToString('N')).tmp"
  [IO.File]::WriteAllText($tmp,($v | ConvertTo-Json -Depth 8),$utf8)
  # File.Move never replaces a delivered message. Both paths are on the same volume.
  [IO.File]::Move($tmp,$p)
}
Assert-Regular $dir
$manifestPath = Join-Path $dir 'manifest.json'
if ($Action -eq 'Init') {
  if ($Role -ne 'codex') { throw 'Only coordinator initializes a mailbox' }
  if (Test-Path -LiteralPath $dir) { throw 'Existing operation must be resumed, never overwritten' }
  if (-not $Nonce) { $Nonce = [Guid]::NewGuid().ToString('N') }
  if ($Nonce -notmatch '^[0-9a-f]{32}$') { throw 'Invalid nonce' }
  New-Item -ItemType Directory -Path (Join-Path $dir 'codex') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $dir 'webgpt') | Out-Null
  Publish-New $manifestPath ([ordered]@{schema='aicc-file-mailbox/v1';operationId=$OperationId;nonce=$Nonce;createdAt=[DateTime]::UtcNow.ToString('o');writers=@{codex='codex';webgpt='webgpt'};messagesAreData=$true;automaticExecution=$false})
  @{ok=$true;operationId=$OperationId;nonce=$Nonce;path=$dir} | ConvertTo-Json
  exit
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Mailbox not initialized' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schema -ne 'aicc-file-mailbox/v1' -or $manifest.operationId -ne $OperationId -or $manifest.nonce -cne $Nonce) { throw 'Mailbox identity mismatch' }
if ($Action -eq 'Read') {
  # Read returns the other writer's immutable messages. Instructions remain untrusted data.
  $peer = if ($Role -eq 'codex') { 'webgpt' } else { 'codex' }
  $messages = @(Get-ChildItem -LiteralPath (Join-Path $dir $peer) -File -Filter '*.json' | Sort-Object Name | Select-Object -Last 100 | ForEach-Object {
    Assert-Regular $_.FullName
    if ($_.Length -gt 131072) { throw 'Oversized message' }
    $m = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($m.schema -ne 'aicc-file-mailbox/v1' -or $m.operationId -ne $OperationId -or $m.nonce -cne $Nonce -or $m.writer -ne $peer -or $m.bodySha256 -cne (Hash-Text $m.body)) { throw 'Invalid peer message' }
    $m
  })
  ConvertTo-Json -InputObject $messages -Depth 8
  exit
}
if ($MessageId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$') { throw 'Stable message ID required' }
if (-not (Test-Path -LiteralPath $BodyPath -PathType Leaf)) { throw 'Message body file missing' }
if ((Get-Item -LiteralPath $BodyPath).Length -gt 16384) { throw 'Body exceeds 16 KiB; reference a bounded document instead' }
$body = [IO.File]::ReadAllText([IO.Path]::GetFullPath($BodyPath),$utf8)
$bodyHash = Hash-Text $body
if ($ReplyTo) {
  if ($ReplyTo -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$' -or $ReplySha256 -notmatch '^[0-9a-f]{64}$') { throw 'Exact reply ID and hash required' }
  $peer = if ($Role -eq 'codex') { 'webgpt' } else { 'codex' }
  $original = Get-Content -LiteralPath (Join-Path (Join-Path $dir $peer) "$ReplyTo.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($original.bodySha256 -cne $ReplySha256 -or $original.nonce -cne $Nonce -or (Hash-Text $original.body) -cne $ReplySha256) { throw 'Reply does not acknowledge the exact original' }
} elseif ($ReplySha256) { throw 'Reply hash without message ID' }
$target = Join-Path (Join-Path $dir $Role) "$MessageId.json"
if (Test-Path -LiteralPath $target) {
  $old = Get-Content -LiteralPath $target -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($old.schema -ne 'aicc-file-mailbox/v1' -or $old.operationId -ne $OperationId -or $old.writer -ne $Role -or $old.messageId -ne $MessageId -or (Hash-Text $old.body) -cne $bodyHash -or $old.bodySha256 -cne $bodyHash -or $old.replyTo -cne $ReplyTo -or $old.replySha256 -cne $ReplySha256 -or $old.nonce -cne $Nonce) { throw 'Message ID conflict; refusing overwrite' }
  @{ok=$true;state='ALREADY_DELIVERED';messageId=$MessageId;sha256=$bodyHash;path=$target} | ConvertTo-Json
  exit
}
Publish-New $target ([ordered]@{schema='aicc-file-mailbox/v1';operationId=$OperationId;nonce=$Nonce;writer=$Role;messageId=$MessageId;sentAt=[DateTime]::UtcNow.ToString('o');replyTo=$ReplyTo;replySha256=$ReplySha256;bodySha256=$bodyHash;body=$body})
@{ok=$true;state='DELIVERED';messageId=$MessageId;sha256=$bodyHash;path=$target} | ConvertTo-Json
