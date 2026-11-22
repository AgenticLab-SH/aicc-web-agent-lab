# Managed Windows OCX entry. No global model/auth config changes.
# Route validation, readiness, admission auth and safety hooks belong to AICC.
param()
$ErrorActionPreference='Stop'
$routeOwner=[Environment]::GetFolderPath('UserProfile')
$routeState=Join-Path $routeOwner '.ai-control-center'
$routeRegistry=Join-Path $routeState 'runtime\components.json'
$routeItem=Get-Item -LiteralPath $routeRegistry -ErrorAction Stop
if($routeItem.PSIsContainer -or $routeItem.LinkType){throw 'Managed AICC registry must be a regular file'}
$routeRecord=[IO.File]::ReadAllText($routeRegistry)|ConvertFrom-Json
$routeCli=$routeRecord.components.cli
$routeAllowed=[IO.Path]::GetFullPath((Join-Path $routeState 'releases\cli'))+[IO.Path]::DirectorySeparatorChar
$routeRelease=[IO.Path]::GetFullPath([string]$routeCli.releaseRoot)
$routeEntry=[IO.Path]::GetFullPath([string]$routeCli.entry)
if($routeRecord.schemaVersion -ne 1 -or $routeRecord.root -ine $routeState -or $routeCli.location -ne 'managed' -or -not $routeRelease.StartsWith($routeAllowed,[StringComparison]::OrdinalIgnoreCase) -or $routeEntry -ine (Join-Path $routeRelease 'bin\aicc')){throw 'Managed AICC route identity differs'}
foreach($routeFile in @($routeCli.runtime,$routeEntry)){
 $routeLeaf=Get-Item -LiteralPath $routeFile -ErrorAction Stop
 if($routeLeaf.PSIsContainer -or $routeLeaf.LinkType){throw 'Managed AICC entry must be a regular file'}
}
if($args.Count -eq 1 -and $args[0] -eq '--status'){
 & $routeCli.runtime $routeEntry codex status
}else{
 & $routeCli.runtime $routeEntry codex ocx @args
}
exit $LASTEXITCODE
