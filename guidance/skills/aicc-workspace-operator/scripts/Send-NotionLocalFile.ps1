[CmdletBinding(DefaultParameterSetName='Upload')]
param(
 [Parameter(Mandatory=$true,ParameterSetName='Upload')][string]$FilePath,
 [Parameter(Mandatory=$true)][string]$PageId,
 [Parameter(Mandatory=$true,ParameterSetName='Upload')][string]$ReceiptDirectory,
 [Parameter(Mandatory=$true)][string]$DestinationReadPath,
 [Parameter(Mandatory=$true,ParameterSetName='Destination')][switch]$ValidateDestinationOnly,
 [string]$TicketPath,
 [switch]$TicketFromStdin,
 [switch]$InspectOnly
)
$ErrorActionPreference='Stop'
$utf8=New-Object Text.UTF8Encoding($false)
function ConvertFrom-NotionTicketJson([string]$Text){
 # Windows PowerShell 5.1 has no DateKind. Preserve date strings where the
 # runtime supports it; expiry validation below accepts both runtime forms.
 $options=@{}
 if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')){$options.DateKind='String'}
 $Text|ConvertFrom-Json @options
}
function Require-LocalPath([string]$PathValue,[bool]$MustExist){
 if(![IO.Path]::IsPathRooted($PathValue)){throw 'Absolute local path required'}
 $resolved=[IO.Path]::GetFullPath($PathValue)
 $boundary=[IO.Path]::GetFullPath($env:AICC_WORKSPACE_ROOT).TrimEnd('\')
 if(!$boundary -or !$resolved.StartsWith($boundary+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Path must stay inside the opened AICC workspace'}
 $walk=$resolved
 while($walk -and $walk.Length -ge $boundary.Length){
  if(Test-Path -LiteralPath $walk){if((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked paths are not accepted'}}
  $parent=[IO.Directory]::GetParent($walk);if(!$parent){break};$walk=$parent.FullName
 }
 if($MustExist -and !(Test-Path -LiteralPath $resolved)){throw 'Required local file missing'}
 return $resolved
}
function Save-Receipt($Value,[string]$PathValue,[bool]$Exclusive){
 $mode=if($Exclusive){[IO.FileMode]::CreateNew}else{[IO.FileMode]::Create}
 $bytes=$utf8.GetBytes(($Value|ConvertTo-Json -Depth 15 -Compress))
 $stream=New-Object IO.FileStream($PathValue,$mode,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Assert-NotionDestination([string]$EvidencePath,[string]$ExpectedPageId){
 if($ExpectedPageId -notmatch '^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$'){throw 'HOLD_NOTION_DESTINATION: exact page UUID required'}
 if(!$EvidencePath -or ![IO.Path]::IsPathRooted($EvidencePath)){throw 'HOLD_NOTION_DESTINATION: actual fetch response file required'}
 $e=Get-Item -LiteralPath ([IO.Path]::GetFullPath($EvidencePath)) -Force
 if($e.PSIsContainer -or ($e.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $e.Length -gt 2097152){throw 'HOLD_NOTION_DESTINATION: bounded regular response file required'}
 $raw=Get-Content -LiteralPath $e.FullName -Raw|ConvertFrom-Json
 if($raw.isError -eq $true){throw 'HOLD_NOTION_DESTINATION: connector error'}
 if($raw.content){if(@($raw.content).Count -ne 1 -or $raw.content[0].type -ne 'text'){throw 'HOLD_NOTION_DESTINATION: expected actual page fetch response'};$raw=$raw.content[0].text|ConvertFrom-Json}
 $expected=$ExpectedPageId.Replace('-','').ToLowerInvariant()
 if(!$raw.id -or ([string]$raw.id).Replace('-','').ToLowerInvariant() -ne $expected -or $raw.truncated -eq $true){throw 'HOLD_NOTION_DESTINATION: page ID mismatch or truncated response'}
 $text=[string]$raw.text
 $page=[regex]::Match($text,'<page url="(?<url>https://(?:app[.]notion[.]com/p/|(?:www[.])?notion[.]so/)[^"\s]+)"')
 if(!$page.Success){throw 'HOLD_NOTION_DESTINATION: page entity required; database/data-source is different'}
 $uri=[uri]$page.Groups['url'].Value
 if(!$uri.AbsolutePath.Replace('-','').ToLowerInvariant().EndsWith($expected)){throw 'HOLD_NOTION_DESTINATION: fetched page URL mismatch'}
 # The connector's "as of" value can equal page_last_edited_at; an old page is not a stale read.
 # Require a newly saved actual connector response. File times are consistency evidence, not authentication.
 $recordedAt=[DateTimeOffset]$e.LastWriteTimeUtc
 $age=[DateTimeOffset]::UtcNow-$recordedAt
 if($age.TotalSeconds -lt -60 -or $age.TotalMinutes -gt 15){throw 'HOLD_NOTION_DESTINATION: fresh saved destination fetch required; fetch again, do not touch or recopy old evidence'}
 return @{status='DESTINATION_VERIFIED';pageId=$ExpectedPageId;evidencePath=$e.FullName;evidenceRecordedAtUtc=$recordedAt.ToString('o');sourcePageLastEditedAt=$raw.page_last_edited_at;scope='consistency-only-not-authorization'}
}

$destination=Assert-NotionDestination $DestinationReadPath $PageId
if($ValidateDestinationOnly){$destination|ConvertTo-Json -Compress;return}
$null=Require-LocalPath $DestinationReadPath $true
$file=Require-LocalPath $FilePath $true
$item=Get-Item -LiteralPath $file -Force
if($item.PSIsContainer -or $item.Length -gt 20971520 -or $item.Length -lt 1){throw 'A regular file of 1 byte through 20 MiB is required'}
$hashAlgorithm=[Security.Cryptography.SHA256]::Create();$read=[IO.File]::OpenRead($file)
try{$hash=([BitConverter]::ToString($hashAlgorithm.ComputeHash($read))).Replace('-','').ToLowerInvariant()}finally{$read.Dispose();$hashAlgorithm.Dispose()}
$directory=Require-LocalPath $ReceiptDirectory $false
[IO.Directory]::CreateDirectory($directory)|Out-Null
$receipt=Join-Path $directory ($PageId.Replace('-','').ToLowerInvariant()+'-'+$hash+'.upload.json')
if(Test-Path -LiteralPath $receipt){
 $existing=Get-Content -LiteralPath $receipt -Raw|ConvertFrom-Json
 if($existing.sha256 -ne $hash -or $existing.pageId -ne $PageId){throw 'Receipt binding mismatch'}
 if($existing.status -in @('UPLOADED','ATTACHED_VERIFIED')){$existing|ConvertTo-Json -Depth 15 -Compress;return}
 if(!$InspectOnly){throw 'Previous upload attempt must be reconciled by exact file_upload_id; do not resend'}
 $existing|ConvertTo-Json -Depth 15 -Compress;return
}
if($InspectOnly){@{status='READY_FOR_TICKET';filename=$item.Name;bytes=$item.Length;sha256=$hash;pageId=$PageId;receiptPath=$receipt}|ConvertTo-Json -Compress;return}
if($TicketFromStdin){
 if($TicketPath){throw 'Choose TicketFromStdin or TicketPath'}
 [Console]::WriteLine('AWAITING_NOTION_UPLOAD_TICKET')
 $ticketLine=[Console]::ReadLine()
 if(!$ticketLine -or $ticketLine.Length -gt 16384){throw 'One bounded JSON ticket line required on stdin'}
 $ticket=ConvertFrom-NotionTicketJson $ticketLine
 $ticketLine=$null
}else{
 $ticketFile=Require-LocalPath $TicketPath $true
 $ticket=ConvertFrom-NotionTicketJson (Get-Content -LiteralPath $ticketFile -Raw)
}
$id=[string]$ticket.file_upload_id
$uri=[uri]$ticket.upload_url
if($id -notmatch '^[a-fA-F0-9-]{36}$' -or $uri.Scheme -ne 'https' -or $uri.Host -ne 'api.notion.com' -or !$uri.IsDefaultPort -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne ('/v1/mcp/file_uploads/'+$id+'/send')){throw 'Exact official Notion MCP one-file upload ticket required'}
if($ticket.upload_method -ne 'POST' -or $ticket.upload_form_field -ne 'file' -or $ticket.filename -ne $item.Name){throw 'Ticket method, form field or exact filename mismatch'}
if([DateTimeOffset]::Parse($ticket.expires_at) -le [DateTimeOffset]::UtcNow.AddSeconds(10)){throw 'Upload ticket expired or too near expiry; no POST performed'}
Add-Type -AssemblyName System.Net.Http
$handler=New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect=$false
$client=New-Object System.Net.Http.HttpClient($handler)
$client.Timeout=[TimeSpan]::FromSeconds(90)
$form=New-Object System.Net.Http.MultipartFormDataContent
$stream=$null;$response=$null;$state=$null
try{
 foreach($header in $ticket.upload_headers.PSObject.Properties){
  if($header.Name -notmatch '^[A-Za-z0-9-]+$' -or [string]$header.Value -match '[\r\n]' -or $header.Name -ieq 'content-type'){throw 'Unexpected upload header'}
  if(!$client.DefaultRequestHeaders.TryAddWithoutValidation($header.Name,[string]$header.Value)){throw 'Unable to set returned upload header'}
 }
 $stream=[IO.File]::OpenRead($file)
 $content=New-Object System.Net.Http.StreamContent($stream)
 $content.Headers.ContentType=[System.Net.Http.Headers.MediaTypeHeaderValue]::Parse([string]$ticket.content_type)
 $form.Add($content,'file',$item.Name)
 $state=[ordered]@{schemaVersion=1;status='DISPATCHING';pageId=$PageId;sha256=$hash;filename=$item.Name;bytes=$item.Length;file_upload_id=$id;receiptPath=$receipt;atUtc=[DateTimeOffset]::UtcNow.ToString('o');automaticRetry=$false}
 Save-Receipt $state $receipt $true
 $response=$client.PostAsync($uri,$form).GetAwaiter().GetResult()
 $body=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
 $payload=$null;try{$payload=$body|ConvertFrom-Json}catch{}
 $state.httpStatus=[int]$response.StatusCode
 if(!$response.IsSuccessStatusCode){
  $state.status=if([int]$response.StatusCode -ge 500){'OUTCOME_UNKNOWN_RECONCILE'}else{'REJECTED_NO_RETRY'}
  $state.errorCode=if($payload.code){[string]$payload.code}else{'upload_http_error'}
  if($payload.message){
   $message=([string]$payload.message -replace '(?i)Bearer\s+\S+','Bearer [REDACTED]')
   $state.errorMessage=$message.Substring(0,[Math]::Min(1000,$message.Length))
  }
  Save-Receipt $state $receipt $false
  $state|ConvertTo-Json -Depth 15 -Compress;exit 2
 }
 $actualId=if($payload.file_upload_id){$payload.file_upload_id}else{$payload.id}
 $actualBytes=if($null -ne $payload.content_length){[long]$payload.content_length}else{-1}
 if($actualId -ne $id -or $payload.status -ne 'uploaded' -or $actualBytes -ne $item.Length){throw 'Upload response identity, status or length unconfirmed'}
 $state.status='UPLOADED';$state.content_type=[string]$payload.content_type
 $state.markdown_source=[string]$payload.markdown_source;$state.suggested_markdown=[string]$payload.suggested_markdown
 $state.completedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')
 Save-Receipt $state $receipt $false
 $state|ConvertTo-Json -Depth 15 -Compress
}catch{
 if($state){$state.status='OUTCOME_UNKNOWN_RECONCILE';$state.errorCode='upload_response_or_transport_unconfirmed';Save-Receipt $state $receipt $false}
 throw 'Upload not confirmed. Reconcile the recorded file_upload_id; never automatically POST again.'
}finally{
 if($response){$response.Dispose()};$form.Dispose();if($stream){$stream.Dispose()};$client.Dispose();$handler.Dispose()
}
