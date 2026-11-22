#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('status', 'refresh', 'identity', 'pair', 'recover', 'pause', 'resume','priority','use','unpin','reset','policy','order','reconcile','credits')]
    [string]$Action = 'status',
    [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')]
    [string]$Selector,
    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$ExpectedIdentity,
    [switch]$Commit,
    [ValidateRange(-100,100)][int]$Priority,
    [ValidatePattern('^[A-Za-z0-9+/=]{1,8192}$')][string]$OrderBase64,
    [ValidateRange(1,100)][int]$ShortThreshold,
    [ValidateRange(1,100)][int]$LongThreshold,
    [ValidateSet('switch','stop')][string]$ShortAction,
    [ValidateSet('switch','stop')][string]$LongAction,
    [ValidatePattern('^[a-f0-9]{32}$')][string]$PreviewToken,
    [ValidatePattern('^[A-Za-z0-9+/=]{1,2048}$')][string]$ResetCreditGuardBase64
)
$ErrorActionPreference = 'Stop'
if($ResetCreditGuardBase64 -and $Action -ne 'reset'){throw 'Credit guard is only supported for exact reset operations.'}
$source = Join-Path $PSScriptRoot 'hub-accounts.py'
if ($Action -in @('pause','resume','priority','use','unpin','reset','credits')) {
    if (-not $Selector -or -not $ExpectedIdentity -or $Selector -eq 'main') {
        throw 'Exact pool selector and fresh identity hash are required.'
    }
} elseif ($Selector -or $ExpectedIdentity -or ($Commit -and $Action -notin @('recover','policy','order'))) {
    throw 'Read-only commands do not accept mutation arguments.'
}
if($Action -eq 'credits' -and ($Commit -or $PreviewToken -or $PSBoundParameters.ContainsKey('Priority') -or $ShortThreshold -or $LongThreshold -or $ShortAction -or $LongAction)){throw 'Credit inventory only permits read-only identity arguments.'}
if($Action -eq 'priority' -and -not $PSBoundParameters.ContainsKey('Priority')){throw 'Priority is required.'}
if($Action -eq 'policy' -and (-not $ShortThreshold -or -not $LongThreshold -or -not $ShortAction -or -not $LongAction)){throw 'Both independent window settings are required.'}
if($Commit -and $Action -ne 'recover' -and -not $PreviewToken){throw 'A fresh one-use preview is required.'}
if($Action -eq 'reconcile' -and -not $PreviewToken){throw 'The original request token is required for read-only reconciliation.'}
# Desktop Commander / MCP-launched shells can omit ProgramData. Windows OpenSSH
# exits 255 without diagnostics in that case. Restore the OS-known location only
# in this process; never change global environment, credentials, or SSH settings.
if ([string]::IsNullOrWhiteSpace($env:ProgramData)) {
    $commonData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    if ([string]::IsNullOrWhiteSpace($commonData) -or -not (Test-Path -LiteralPath $commonData -PathType Container)) {
        throw 'Windows ProgramData path unavailable; A1 relay not attempted.'
    }
    $env:ProgramData = $commonData
}
if($Action -eq 'order'){
    if(-not $OrderBase64){throw 'An exact ordered identity list is required.'}
    $order=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($OrderBase64))|ConvertFrom-Json
    if(@($order).Count -lt 1 -or @($order).Count -gt 16){throw 'Invalid account order count.'}
}elseif($OrderBase64){throw 'Account order only accepts the order action.'}
# Arguments are validated above; credentials stay on the existing A1 relay.
$remote = "/demo/owner/.local/bin/oracle-a1-connection exec -- python3 - $Action"
if ($Selector) { $remote += " --selector $Selector --expected-identity $ExpectedIdentity" }
if ($Commit) { $remote += ' --commit' }
if($Action -eq 'priority'){$remote+=" --priority $Priority"}
if($Action -eq 'policy'){$remote+=" --short-threshold $ShortThreshold --long-threshold $LongThreshold --short-action $ShortAction --long-action $LongAction"}
if($Action -eq 'order'){$remote+=" --order-base64 $OrderBase64"}
if($PreviewToken){$remote+=" --preview-token $PreviewToken"}; if($ResetCreditGuardBase64){$remote+=" --reset-credit-guard-base64 $ResetCreditGuardBase64"}
Get-Content -Raw -LiteralPath $source | ssh -T -o BatchMode=yes -o ConnectTimeout=15 skct-relay-micro $remote
exit $LASTEXITCODE
