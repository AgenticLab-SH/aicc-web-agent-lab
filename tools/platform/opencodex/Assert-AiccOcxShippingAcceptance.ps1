# Shared pure validator for producer and transition; no service or account I/O.
function Assert-AiccOcxShippingAcceptance {
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)]$NativePins,[Parameter(Mandatory)]$AdapterPins)
  function ShippingHash([string]$File){(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
  function ShippingJson([string]$File){
    if(-not [IO.Path]::IsPathFullyQualified($File)){throw 'Absolute shipping evidence required'}
    for($p=[IO.Path]::GetFullPath($File);$p;$p=Split-Path $p -Parent){
      $item=Get-Item -LiteralPath $p -Force
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked shipping evidence refused'}
    }
    if((Get-Item -LiteralPath $File).PSIsContainer -or (Get-Item -LiteralPath $File).Length -gt 1048576){throw 'Bounded regular shipping evidence required'}
    Get-Content -LiteralPath $File -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  }
  function ShippingMapEquals($Left,$Right){
    if($Left -isnot [Collections.IDictionary] -or $Right -isnot [Collections.IDictionary] -or $Left.Count -ne $Right.Count){return $false}
    foreach($key in $Left.Keys){if(-not $Right.Contains($key) -or $Left[$key] -cne $Right[$key]){return $false}}
    return $true
  }
  function ShippingBoolean($Value,[bool]$Expected){
    return ($Value -is [bool] -and $Value -ceq $Expected)
  }
  function ShippingZero($Value){
    return (($Value -is [int] -or $Value -is [long]) -and $Value -ceq 0)
  }
  $receipt=ShippingJson $Path
  if($Sha256 -cnotmatch '^[a-f0-9]{64}$' -or (ShippingHash $Path) -cne $Sha256){throw 'Shipping acceptance receipt changed'}
  if($receipt.schema -cne 'aicc-ocx-shipping-operating-acceptance/v1' -or
     $receipt.state -cne 'PASS' -or -not (ShippingBoolean $receipt.fixtureOnly $false) -or
     -not (ShippingZero $receipt.originalReplay) -or -not (ShippingZero $receipt.resetCreditConsumption) -or
     -not (ShippingMapEquals $receipt.nativeArtifacts $NativePins) -or
     -not (ShippingMapEquals $receipt.adapterArtifacts $AdapterPins)){
    throw 'Exact actual shipping operating acceptance required'
  }
  $required=@('shippingTuiAttachment','originalIssuerArmCancel','credentialGenerationRefusal','stopUnknownPreservation')
  if($receipt.checks -isnot [Collections.IDictionary] -or $receipt.checks.Count -ne $required.Count){throw 'Complete shipping operating evidence required'}
  $files=[ordered]@{'shipping-operating-acceptance.json'=$Path}
  $hashes=[ordered]@{'shipping-operating-acceptance.json'=$Sha256}
  foreach($name in $required){
    $proof=$receipt.checks[$name]
    if($proof -isnot [Collections.IDictionary] -or $proof.sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Pinned shipping check required'}
    $file=if($proof.file -is [string] -and $proof.file -ceq ($name+'.json')){Join-Path (Split-Path $Path -Parent) $proof.file}
      else{throw 'Exact shipping check path required'}
    $result=ShippingJson $file
    if((ShippingHash $file) -cne $proof.sha256){throw 'Shipping check evidence changed'}
    if($result.schema -cne 'aicc-ocx-shipping-check/v1' -or $result.check -cne $name -or
       $result.state -cne 'PASS' -or $result.execution -cne 'ACTUAL_SHIPPING_BINARY' -or
       -not (ShippingBoolean $result.fixtureOnly $false) -or -not (ShippingZero $result.originalReplay) -or
       -not (ShippingZero $result.resetCreditConsumption) -or
       -not (ShippingMapEquals $result.nativeArtifacts $NativePins) -or
       -not (ShippingMapEquals $result.adapterArtifacts $AdapterPins)){
      throw 'Actual version-bound shipping execution evidence required'
    }
    # Negative-only transport/parser tests cannot prove enablement of the owner.
    if($name -ceq 'originalIssuerArmCancel' -and
       (-not (ShippingBoolean $result.armed $true) -or -not (ShippingBoolean $result.cancelled $true) -or
        -not (ShippingBoolean $result.exactOriginalIssuer $true) -or -not (ShippingBoolean $result.goalPreserved $true))){
      throw 'Positive original issuer arm and cancel evidence required'
    }
    if($name -ceq 'shippingTuiAttachment' -and
       (-not (ShippingBoolean $result.authenticatedPeer $true) -or -not (ShippingBoolean $result.sharedChildSurvived $true))){
      throw 'Actual shipping TUI attachment evidence required'
    }
    if($name -ceq 'credentialGenerationRefusal' -and -not (ShippingBoolean $result.replacementRefused $true)){throw 'Changed issuer generation refusal required'}
    if($name -ceq 'stopUnknownPreservation' -and
       (-not (ShippingBoolean $result.stopPreserved $true) -or -not (ShippingBoolean $result.unknownPreserved $true))){
      throw 'Stop and UNKNOWN preservation evidence required'
    }
    $files[$name+'.json']=$file;$hashes[$name+'.json']=$proof.sha256
  }
  return @{files=$files;hashes=$hashes;receiptSha256=$Sha256}
}
