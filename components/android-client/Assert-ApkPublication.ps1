function Assert-AiccApkSigningIdentity {
 param([bool]$KeyExists,[bool]$PasswordExists,[bool]$PublishedExists)
 if($KeyExists -ne $PasswordExists -or ($PublishedExists -and !$KeyExists)){
  throw 'Incomplete or missing published signing identity; preserve files and restore the original key'
 }
}

function Assert-AiccApkPublication {
 param([Parameter(Mandatory)]$Metadata,[Parameter(Mandatory)][string]$Badging,
       [Parameter(Mandatory)][string]$Certificate,$Previous)
 $package=[regex]::Match($Badging,"(?m)^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'")
 $element=@($Metadata.elements)
 if(!$package.Success -or $Metadata.applicationId -cne 'com.agenticfabworks.aicc.mobile' -or
    $element.Count -ne 1 -or $package.Groups[1].Value -cne $Metadata.applicationId -or
    ($element[0].versionCode -isnot [long] -and $element[0].versionCode -isnot [int])){
  throw 'Exact APK package and integer versionCode required'
 }
 $version=$element[0].versionCode
 if($version -lt 1 -or $version -gt 2100000000 -or
    [long]$package.Groups[2].Value -ne $version -or
    $package.Groups[3].Value -cne $element[0].versionName -or
    $Badging -match '(?m)^application-debuggable(?:\s|$)' -or
    $Certificate -cnotmatch '^[a-f0-9]{64}$'){
  throw 'Verified non-debuggable APK version and signing certificate required'
 }
 if($null -ne $Previous -and
    ($Previous.packageName -cne $Metadata.applicationId -or
     $Previous.certificateSha256 -cne $Certificate -or
     ($Previous.versionCode -isnot [int] -and $Previous.versionCode -isnot [long]) -or
     $Previous.versionCode -ge $version)){
  throw 'Preserve package, signing key and monotonically increasing versionCode'
 }
}
