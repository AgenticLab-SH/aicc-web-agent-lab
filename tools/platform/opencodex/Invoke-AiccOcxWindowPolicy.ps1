#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('status','activity','prepare','stage','deploy','rollback')][string]$Action='status',[ValidateSet('2.77.0')][string]$TargetVersion,[switch]$DynamicSettings,[switch]$InterruptInFlight)
$ErrorActionPreference='Stop'
if($InterruptInFlight){throw 'In-flight protection belongs to the local OCX pipeline. Use build-local-policy.py; never deploy it to the A1 cycle owner.'}
$payload="import base64,os,pathlib`n"
if($Action -in @('deploy','stage')){
  if($DynamicSettings -or $InterruptInFlight){
    $payload+="os.environ['AICC_OCX_DYNAMIC_POLICY']='1'`n"
    foreach($row in @(@('AICC_POLICY_SETTINGS','window-policy-settings.ts'),@('AICC_POLICY_ADMISSION_V2','window-admission-v2.ts'))){
      $value=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $row[1])))
      $payload+="os.environ['$($row[0])']='$value'`n"
    }
  }
  if($InterruptInFlight){
    $payload+="os.environ['AICC_OCX_INFLIGHT_POLICY']='1'`n"
    foreach($row in @(@('AICC_POLICY_INFLIGHT_MONITOR','window-inflight-monitor.ts'),@('AICC_POLICY_INFLIGHT_RUNTIME','window-inflight-runtime.ts'),@('AICC_POLICY_INFLIGHT_RESPONSE','window-inflight-response.ts'),@('AICC_POLICY_INFLIGHT_FIXTURE','probe-window-inflight.mjs'))){
      $value=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $row[1])))
      $payload+="os.environ['$($row[0])']='$value'`n"
    }
  }
  foreach($row in @(@('AICC_POLICY_BUILDER','build-window-policy.py'),@('AICC_POLICY_FIXTURE','probe-stock-quota-routing.mjs'))){
    $value=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $row[1])))
    $payload+="os.environ['$($row[0])']='$value'`n"
  }
  $admission=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'window-admission.ts')))
  $payload+="os.environ['AICC_POLICY_ADMISSION']='$admission'`n"
  $fixture=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'probe-window-admission.mjs')))
  $payload+="os.environ['AICC_POLICY_ADMISSION_FIXTURE']='$fixture'`n"
}
$code=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'hub-window-policy.py')))
if($Action -eq 'deploy'){
  $payload+="p=pathlib.Path('/demo/owner/.local/share/ocx-window-policy');p.mkdir(parents=True,exist_ok=True,mode=0o700);(p/'hub-window-policy.py').write_bytes(base64.b64decode('$code'))`n"
}
$payload+="exec(base64.b64decode('$code'))`n"
$remote="/demo/owner/.local/bin/oracle-a1-connection exec -- python3 - $Action"
if($TargetVersion){$remote+=" --target $TargetVersion"}
$result=$payload | ssh -T -o BatchMode=yes -o ConnectTimeout=15 skct-relay-micro $remote
$operationExit=$LASTEXITCODE
if($operationExit -ne 0){
  $reason='unconfirmed'
  try {
    $observed=$result | ConvertFrom-Json -ErrorAction Stop
    if($observed.reason -match '^[a-z][a-z0-9_]{0,100}$'){$reason=$observed.reason}
  } catch { }
  throw "Policy operation refused or unconfirmed (reason=$reason). Inspect status before another mutation."
}
$result
