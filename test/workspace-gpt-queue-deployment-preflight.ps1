#requires -Version 7.5
$ErrorActionPreference='Stop'
$script=Join-Path $PSScriptRoot '../tools/platform/workspace-mcp/Prepare-AiccGptQueueDeployment.ps1'
$root=Join-Path ([IO.Path]::GetTempPath()) ('queue-deployment-preflight-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
$state=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$files=@('runtime/components.json','workspace-mcp/config.json','workspace-mcp/tunnel/profiles/aicc-workspace.yaml')|ForEach-Object {Join-Path $state $_}
$before=@($files|ForEach-Object {(Get-FileHash -LiteralPath $_).Hash})
$ownerFile=Join-Path $root 'prepared.json'
$invalid=@{kind='aicc-gpt-queue-owner-prepared';inspectedTargets=1;originalRequestDispatched=$false}
[IO.File]::WriteAllText($ownerFile,($invalid|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$ownerHash=(Get-FileHash -LiteralPath $ownerFile).Hash.ToLowerInvariant()
$newOperation=Join-Path $state ('asset-control/queue-preflight-never-created-'+[guid]::NewGuid().ToString('N'))
$pwsh=(Get-Process -Id $PID).Path
$cases=@(
 @{name='outside owner operation';directory=(Join-Path $root 'outside');hash=$ownerHash;pattern='New exact owner operation directory'},
 @{name='existing operation preserved';directory=(Join-Path $state 'asset-control');hash=$ownerHash;pattern='New exact owner operation directory'},
 @{name='changed preparation hash';directory=$newOperation;hash=('0'*64);pattern='Original owner preparation changed'},
 @{name='single target cannot become dual proof';directory=$newOperation;hash=$ownerHash;pattern='Actual original two-target owner preparation'}
)
$results=@()
foreach($case in $cases){
 $output=& $pwsh -NoProfile -File $script -StageReceipt (Join-Path $root 'missing-stage.json') -OwnerPreparedReceipt $ownerFile -ExpectedOwnerPreparedSha256 $case.hash -OperationDirectory $case.directory 2>&1|Out-String
 if($LASTEXITCODE -eq 0 -or $output -notmatch $case.pattern){throw ('Failed boundary: '+$case.name+' '+$output)}
 if(Test-Path -LiteralPath $newOperation){throw 'Invalid proof created an operation'}
 $results+=@{name=$case.name;status='PASS'}
}
$invalid.inspectedTargets=2;$invalid.originalRequestDispatched=$true
[IO.File]::WriteAllText($ownerFile,($invalid|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$output=& $pwsh -NoProfile -File $script -StageReceipt (Join-Path $root 'missing-stage.json') -OwnerPreparedReceipt $ownerFile -ExpectedOwnerPreparedSha256 (Get-FileHash -LiteralPath $ownerFile).Hash.ToLowerInvariant() -OperationDirectory $newOperation 2>&1|Out-String
if($LASTEXITCODE -eq 0 -or $output -notmatch 'Actual original two-target owner preparation'){throw 'Already dispatched preparation accepted'}
$results+=@{name='already dispatched original refused';status='PASS'}
$after=@($files|ForEach-Object {(Get-FileHash -LiteralPath $_).Hash})
if(($before -join ',') -cne ($after -join ',') -or (Test-Path -LiteralPath $newOperation)){throw 'Live preimage changed'}
@{pass=$results.Count;fail=0;results=$results;productionHashesUnchanged=$true;dispatched=$false;temporaryEvidence=$root}|ConvertTo-Json -Depth 5
