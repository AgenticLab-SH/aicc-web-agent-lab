#requires -Version 7.0
[CmdletBinding()]
param([switch]$PrepareOnly)
$ErrorActionPreference='Stop'
$owner=[Environment]::GetFolderPath('UserProfile')
$tools=Join-Path $owner 'AppData\Local\Programs\AICC-Tools\node-v22.23.2-win-x64'
$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$entry=Join-Path $PSScriptRoot 'Invoke-AiccOcxCli.ps1'
$backup=Join-Path $owner ('.ai-control-center\backups\runtime-layout\ocx-cli-clean-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
$stock=Join-Path $owner '.bun\install\global\node_modules\@bitkyc08\opencodex\bin\ocx.mjs'
$planned=@()
foreach($name in @('ocx','opencodex')){
  foreach($extension in @('ps1','cmd')){
    $path=Join-Path $tools ($name+'.'+$extension)
    $exists=Test-Path -LiteralPath $path
    if($exists){
      $text=[IO.File]::ReadAllText($path)
      if(-not $text.Contains($stock) -and -not $text.Contains($entry)){throw 'Foreign CLI shim preserved'}
      if((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked CLI shim refused'}
    }
    $content=if($extension -eq 'ps1'){
      "# AICC registered OCX entry; supplier package remains unchanged.`r`n& '$pwsh' -NoProfile -File '$entry' @args`r`nexit `$LASTEXITCODE`r`n"
    }else{
      "@echo off`r`n`"$pwsh`" -NoProfile -File `"$entry`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    }
    $planned+=@{path=$path;existed=$exists;beforeSha256=if($exists){(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()}else{$null};content=$content}
  }
}
if(-not $PrepareOnly){
  $registry=Get-Content -LiteralPath (Join-Path $owner '.ai-control-center\runtime\ocx-local\current.json') -Raw|ConvertFrom-Json
  if(-not $registry.PSObject.Properties['adapterManifest']){throw 'Activate accepted external supplier before CLI install'}
}
New-Item -ItemType Directory -Path $backup|Out-Null
foreach($item in $planned){if($item.existed){Copy-Item -LiteralPath $item.path -Destination (Join-Path $backup (Split-Path $item.path -Leaf))}}
$planned|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $backup 'plan.json') -Encoding utf8
if(-not $PrepareOnly){
  foreach($item in $planned){
    if($item.existed -and (Get-FileHash -LiteralPath $item.path).Hash.ToLowerInvariant() -cne $item.beforeSha256){throw 'CLI changed; preserve new edit'}
    $temp=$item.path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    [IO.File]::WriteAllText($temp,$item.content,[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $item.path -Force
  }
}
@{status=if($PrepareOnly){'PREPARED'}else{'INSTALLED'};backup=$backup;shims=4;supplierChanged=$false;servicesRestarted=$false}|ConvertTo-Json
