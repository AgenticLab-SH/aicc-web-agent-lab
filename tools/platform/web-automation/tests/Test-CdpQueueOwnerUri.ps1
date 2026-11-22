#requires -Version 7.0
[CmdletBinding()]
param([string]$SourcePath = (Join-Path $PSScriptRoot '../Manage-CdpChromeSlotLease.ps1'))
$ErrorActionPreference = 'Stop'
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($SourcePath,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Source parse failed'}
$assignment=@($ast.FindAll({param($n)
    $n -is [Management.Automation.Language.AssignmentStatementAst] -and
    $n.Left.Extent.Text -in @('$url','$queueTargetUri') -and $n.Right.Extent.Text -eq '$null'
},$true))
if($assignment.Count -ne 1){throw 'Exact queue URI validation block required'}
$statements=@($assignment[0].Parent.Statements)
$index=[array]::IndexOf($statements,$assignment[0])
$body=($statements[$index..($index+3)].Extent.Text -join "`n")
# Preserve the real script's typed Url parameter: this reproduced string coercion.
$check=[scriptblock]::Create('param([string]$Url="about:blank",$targets,$ConversationId,$lease)' + "`n" + $body + "`n" + '$true')
function Stop-ReadProof([string]$Code){throw $Code}
$conversation='11111111-1111-4111-8111-111111111111'; $nonce='a'*64
$valid="https://chatgpt.com/c/${conversation}?aicc_task_target=$nonce"
$cases=@(
    @{url=$valid;allow=$true},
    @{url=$valid.Replace('https:','http:');allow=$false},
    @{url=$valid.Replace('chatgpt.com','example.invalid');allow=$false},
    @{url=$valid.Replace($conversation,'22222222-2222-4222-8222-222222222222');allow=$false},
    @{url=$valid.Replace($nonce,('b'*64));allow=$false},
    @{url=($valid+"&aicc_task_target=$nonce");allow=$false},
    @{url=$valid.Replace('https://','https://user@');allow=$false},
    @{url="https://chatgpt.com/c/$conversation";allow=$false}
)
$passed=0
foreach($case in $cases){
    $allowed=$false
    try{$allowed=& $check -targets @(@{url=$case.url}) -ConversationId $conversation -lease @{task_target_nonce=$nonce}}catch{
        if($_.Exception.Message -notmatch '^HOLD_QUEUE_'){throw}
    }
    if([bool]$allowed -ne $case.allow){throw "Queue URI acceptance mismatch at case $passed"}
    $passed++
}
@{ok=$true;passed=$passed;liveChanges=0}|ConvertTo-Json -Compress
