[CmdletBinding()]
param([Parameter(Mandatory)][string]$ArtifactDirectory,[string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($AiccRoot)
$out=[IO.Path]::GetFullPath($ArtifactDirectory)
[IO.Directory]::CreateDirectory($out)|Out-Null
$guard=Join-Path $root 'guidance/skills/aicc-workspace-operator/scripts/Send-NotionLocalFile.ps1'
$utf8=[Text.UTF8Encoding]::new($false)
$page='11111111-2222-3333-4444-555555555555'
$results=@()
function Check([string]$Name,$Value,[string]$ExpectedId,[bool]$Allow,[int]$AgeMinutes=0){
 $file=Join-Path $out ($Name+'.json')
 [IO.File]::WriteAllText($file,($Value|ConvertTo-Json -Depth 10),$utf8)
 if($AgeMinutes){(Get-Item -LiteralPath $file).LastWriteTimeUtc=[DateTime]::UtcNow.AddMinutes(-$AgeMinutes)}
 $passed=$false;$actual='REJECT'
 try{$r=& $guard -PageId $ExpectedId -DestinationReadPath $file -ValidateDestinationOnly|ConvertFrom-Json;$actual=$r.status;$passed=$Allow -and $actual -eq 'DESTINATION_VERIFIED'}catch{$passed=!$Allow}
 $script:results+=@{name=$Name;passed=$passed;expected=if($Allow){'ALLOW'}else{'REJECT'};actual=$actual}
}
function Response([string]$Tag='page',[string]$At=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')){
 return @{content=@(@{type='text';text=(@{id=$page;title='Offline fixture';text=('Here is the result of "fetch" as of '+$At+':'+"`n"+'<'+$Tag+' url="https://app.notion.com/p/'+$page.Replace('-','')+'">')}|ConvertTo-Json -Compress)})}
}
Check 'existing-page' (Response) $page $true
Check 'different-page-id' (Response) 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' $false
Check 'missing-destination' (Response) '' $false
Check 'root-destination' (Response) 'root' $false
Check 'draft-destination' (Response) 'draft' $false
Check 'parent-omitted' @{} $page $false
Check 'data-source-is-not-page' (Response 'data-source') $page $false
Check 'old-page-fresh-read' (Response 'page' '2020-01-01T00:00:00.000Z') $page $true
Check 'stale-saved-fetch' (Response) $page $false 16
$bad=Response;$bad.isError=$true;Check 'connector-error' $bad $page $false
$bad=@{id=$page;truncated=$true;text=('as of '+[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')+': <page url="https://app.notion.com/p/'+$page.Replace('-','')+'">')};Check 'truncated-fetch' $bad $page $false
# Missing destination must fail before reading file/ticket or creating an upload receipt.
$untouched=Join-Path $out 'must-not-create-receipts'
$blocked=$false
try{& $guard -PageId $page -DestinationReadPath (Join-Path $out 'parent-omitted.json') -FilePath (Join-Path $out 'missing.bin') -ReceiptDirectory $untouched -TicketFromStdin}catch{$blocked=$_.Exception.Message -like '*HOLD_NOTION_DESTINATION*'}
$results+=@{name='upload-before-ticket-and-receipt';passed=($blocked -and !(Test-Path -LiteralPath $untouched));expected='REJECT_BEFORE_SIDE_EFFECT';actual=if($blocked){'REJECT'}else{'UNEXPECTED'}}
$summary=@{schemaVersion=1;networkCalls=0;notionPagesCreated=0;passed=@($results|Where-Object passed).Count;failed=@($results|Where-Object {!$_.passed}).Count;results=$results}
[IO.File]::WriteAllText((Join-Path $out 'results.json'),($summary|ConvertTo-Json -Depth 10),$utf8)
$summary|ConvertTo-Json -Depth 10
if($summary.failed){throw 'Notion destination guard offline test failed'}
