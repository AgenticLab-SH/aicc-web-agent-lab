#requires -Version 7.0
# Official Codex auth.command protocol: stdout is only the token on a private pipe.
# Do not run interactively, log stdout, or use this helper for account/login changes.
[CmdletBinding()]
param([string]$StateRoot)
$ErrorActionPreference='Stop'
function Regular([string]$Path,[long]$Maximum){
 if(-not [IO.Path]::IsPathFullyQualified($Path)){throw 'invalid_path'}
 $item=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force
 if($item.PSIsContainer -or $item.LinkType -or $item.Length -gt $Maximum){throw 'unsafe_file'}
 for($parent=$item.Directory;$parent;$parent=$parent.Parent){if($parent.LinkType){throw 'linked_ancestor'}}
 return $item.FullName
}
try{
 $owner=[Environment]::GetFolderPath('UserProfile')
 $state=if($StateRoot){[IO.Path]::GetFullPath($StateRoot)}else{Join-Path $owner '.ai-control-center'}
 $registration=Regular (Join-Path $state 'runtime\ocx-local\current.json') 16384
 $record=Get-Content -LiteralPath $registration -Raw|ConvertFrom-Json
 $expectedHome=[IO.Path]::GetFullPath((Join-Path $state 'runtime\ocx-local\home'))
 $expectedToken=[IO.Path]::GetFullPath((Join-Path $owner '.opencodex\service-api-token'))
 if($record.schemaVersion -ne 1 -or $record.requestExecution -cne 'windows-local' -or $record.credentialWriter -cne 'a1' -or -not $record.opencodexHome -or -not $record.tokenFile -or [IO.Path]::GetFullPath($record.opencodexHome) -ine $expectedHome -or [IO.Path]::GetFullPath($record.tokenFile) -ine $expectedToken){throw 'owner_mismatch'}
 $tokenFile=Regular $expectedToken 4098
 $token=[IO.File]::ReadAllText($tokenFile).Trim()
 if($token.Length -lt 16 -or $token.Length -gt 4096 -or $token -match '[\r\n\x00-\x20\x7f]'){throw 'invalid_credential'}
 [Console]::Out.Write($token)
 exit 0
}catch{
 [Console]::Error.WriteLine('Registered OCX credential handoff unavailable; no login, account switch or fallback was attempted.')
 exit 1
}
