#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$AiccRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path,
    [switch]$Commit,
    [switch]$InstallStockCli
)
$ErrorActionPreference = 'Stop'
$existing=Get-Command aicc-apps.ps1 -CommandType ExternalScript -ErrorAction Stop
$directory=Split-Path $existing.Source -Parent
if((Get-Item -LiteralPath $directory).LinkType){throw 'Linked install directory refused.'}
$plans=@()
foreach($entry in @(@('aicc-ocx-hub.ps1','Invoke-AiccOcxHubAccounts.ps1','AICC hub account CLI; credentials remain on A1.'),@('aicc-ocx-recover.ps1','Invoke-AiccOcxRecovery.ps1','AICC owner-attested OCX recovery; healthy services are unchanged.'),@('aicc-ocx-update.ps1','Invoke-AiccOcxUpdate.ps1','AICC stock OCX two-target update; preserves intentionally off or busy owners.'),@('aicc-ocx-policy.ps1','Invoke-AiccOcxWindowPolicy.ps1','AICC A1 window policy status and software-only rollback.'),@('aicc-ocx-open.ps1','Open-AiccOcxDashboard.ps1','AICC official one-use pairing in an isolated dashboard window.'))){
    $source=Join-Path (Resolve-Path -LiteralPath $AiccRoot).Path ('tools/platform/opencodex/'+$entry[1])
    if(-not (Test-Path -LiteralPath $source -PathType Leaf)){throw 'Source CLI is missing.'}
    $target=Join-Path $directory $entry[0]
    $quotedSource=$source.Replace("'","''")
    $content="# $($entry[2])`n`$ErrorActionPreference='Stop'`n& '$quotedSource' @args`nexit `$LASTEXITCODE`n"
    $exists=Test-Path -LiteralPath $target
    if($exists){
        $item=Get-Item -LiteralPath $target
        if($item.LinkType -or $item.PSIsContainer -or [IO.File]::ReadAllText($target) -ne $content){throw 'Existing CLI differs; refusing overwrite.'}
    }
    $plans+=@{target=$target;source=$source;content=$content;exists=$exists}
}
if($InstallStockCli){
    $ownerHome=[Environment]::GetFolderPath('UserProfile')
    $package=Join-Path $ownerHome '.bun/install/global/node_modules/@bitkyc08/opencodex'
    $stockBin=Join-Path $package 'bin/ocx.mjs'
    $nodeExe=Join-Path $directory 'node.exe'
    $stockCli=Join-Path $package 'src/cli/index.ts'
    $service=Get-Content -LiteralPath (Join-Path $ownerHome '.opencodex/service-state.json') -Raw | ConvertFrom-Json
    if($service.cliPath -ine $stockCli -or $service.backend -ne 'scheduler'){throw 'Registered stock OCX owner differs.'}
    foreach($file in @($stockBin,$nodeExe)){if(-not(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).LinkType){throw 'Regular stock launcher required.'}}
    $stockPs="# AICC forwards to the registered stock OCX package; old installs are preserved.`n& '$($nodeExe.Replace("'","''"))' '$($stockBin.Replace("'","''"))' @args`nexit `$LASTEXITCODE`n"
    $stockCmd="@echo off`r`n`"$nodeExe`" `"$stockBin`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    foreach($entry in @(@('ocx.ps1',$stockPs),@('ocx.cmd',$stockCmd))){
        $target=Join-Path $directory $entry[0]
        $exists=Test-Path -LiteralPath $target
        if($exists -and ((Get-Item -LiteralPath $target).LinkType -or [IO.File]::ReadAllText($target) -cne $entry[1])){throw 'Existing stock CLI differs; refusing overwrite.'}
        $plans+=@{target=$target;source=$stockBin;content=$entry[1];exists=$exists}
    }
}
foreach($plan in $plans){
    $changed=$false
    if($Commit -and -not $plan.exists){
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes($plan.content)
        $file=[IO.File]::Open($plan.target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
        $changed=$true
    }
    [pscustomobject]@{action='install-ocx-owner-cli';dryRun=(-not $Commit);changed=$changed;target=$plan.target;source=$plan.source;remoteMutation=$false}|ConvertTo-Json -Compress
}
