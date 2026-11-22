#requires -Version 7.5
[CmdletBinding()]
param([string]$AiccRoot=(Join-Path $PSScriptRoot '../../..'))
$ErrorActionPreference='Stop'
$file=Join-Path $AiccRoot 'tools/platform/windows/Request-AiccMobilePublicStop.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
if(@($errors).Count){throw 'source_parse_failed'}
$function=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-SupervisorStopReadiness'},$true)
if(-not $function){throw 'readiness_function_missing'}
. ([scriptblock]::Create($function.Extent.Text))
$cases=@(
 @{name='legacy parser';source='$x | ConvertFrom-Json -AsHashtable';supported=$false},
 @{name='repaired parser';source='$x | ConvertFrom-Json -AsHashtable -DateKind String';supported=$true},
 @{name='colon parameter';source='$x | ConvertFrom-Json -DateKind:String -AsHashtable';supported=$true},
 @{name='comment cannot claim support';source='$x | ConvertFrom-Json -AsHashtable # -DateKind String';supported=$false},
 @{name='automatic date';source='$x | ConvertFrom-Json -DateKind Default';supported=$false},
 @{name='computed argument';source='$x | ConvertFrom-Json -DateKind $mode';supported=$false},
 @{name='mixed reads';source='$x | ConvertFrom-Json -DateKind String; $y | ConvertFrom-Json';supported=$false},
 @{name='absent parser';source='Write-Output done';supported=$false},
 @{name='invalid source';source='function {';supported=$false},
 @{name='duplicate option';source='$x | ConvertFrom-Json -DateKind String -DateKind String';supported=$false}
)
$passed=0
foreach($case in $cases){
 $result=Get-SupervisorStopReadiness $case.source
 if($result.supported -cne $case.supported){throw ('classification_failed:'+ $case.name)}
 if(-not $result.supported -and -not $result.reason){throw 'hold_reason_required'}
 $passed++
}
$current=[IO.File]::ReadAllText((Join-Path $AiccRoot 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1'))
if(-not (Get-SupervisorStopReadiness $current).supported){throw 'current_supervisor_not_supported'}
$passed++
@{passed=$passed;failed=0;operationalRequests=0;runtimeMutation=$false}|ConvertTo-Json -Compress
