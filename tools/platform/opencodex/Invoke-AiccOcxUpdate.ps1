#requires -Version 7.0
[CmdletBinding()]
param([switch]$Check,[ValidateRange(0,600)][int]$WaitForIdleSeconds=0,[string]$TargetVersion='latest')
$ErrorActionPreference='Stop'
$ownerHome=[Environment]::GetFolderPath('UserProfile')
$globalRoot=Join-Path $ownerHome '.bun/install/global'
$package=Join-Path $globalRoot 'node_modules/@bitkyc08/opencodex'
$store=Join-Path $ownerHome '.ai-control-center/opencodex-native/versions'
$nativeConfig=Join-Path $ownerHome '.codex/config.toml'
$nativeHash=(Get-FileHash -LiteralPath $nativeConfig).Hash
$localRegistry=Join-Path $ownerHome '.ai-control-center/runtime/ocx-local/current.json'
if(Test-Path -LiteralPath $localRegistry){
    # Upstream software and AICC runtime integration have independent owners.
    # Never replace/restart the running fork or write account state here.
    $upstreamAction=if($Check){'Check'}else{'Prepare'}
    & (Join-Path $PSScriptRoot 'Prepare-AiccOcxUpstream.ps1') -Action $upstreamAction -TargetVersion $TargetVersion
    return
}

function Invoke-HubUpdate([string]$Action,[string]$Expected,[string]$Target){
    $payload="import base64,types,sys`n"
    foreach($module in @(@('native_versions','native-versions.py'),@('hub_accounts','hub-accounts.py'))){
        $encoded=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $module[1])))
        $payload+="m=types.ModuleType('$($module[0])');sys.modules['$($module[0])']=m;exec(base64.b64decode('$encoded'),m.__dict__)`n"
    }
    $encoded=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'hub-update.py')))
    $payload+="exec(base64.b64decode('$encoded'))`n"
    $remote="/demo/owner/.local/bin/oracle-a1-connection exec -- python3 - $Action"
    if($Expected -or $Target){
        foreach($version in @($Expected,$Target)){if($version -notmatch '^\d+\.\d+\.\d+$'){throw 'Exact stable version required.'}}
        $remote+=" --expected $Expected --target $Target"
    }
    $output=$payload | ssh -T -o BatchMode=yes -o ConnectTimeout=15 skct-relay-micro $remote
    if($LASTEXITCODE -ne 0){throw 'Hub update refused or unconfirmed; no request replay.'}
    $output | ConvertFrom-Json
}
function Read-LocalOwner{
    $state=Get-Content -LiteralPath (Join-Path $ownerHome '.opencodex/service-state.json') -Raw | ConvertFrom-Json
    $config=Get-Content -LiteralPath (Join-Path $ownerHome '.opencodex/config.json') -Raw | ConvertFrom-Json
    $cli=Join-Path $package 'src/cli/index.ts'
    if($state.backend -ne 'scheduler' -or $state.cliPath -ine $cli -or $config.runtimeRole -ne 'client' -or $config.clientIntegrations.codex -ne $false){throw 'Separate stock client owner required.'}
    $task=Get-ScheduledTask -TaskName 'opencodex-proxy'
    $launcher=Join-Path $ownerHome '.opencodex/opencodex-service-launcher.vbs'
    if($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32/wscript.exe') -or $task.Actions[0].Arguments -cne ('/b /nologo "'+$launcher+'"')){throw 'Local service owner differs.'}
    $version=(Get-Content -LiteralPath (Join-Path $package 'package.json') -Raw|ConvertFrom-Json).version
    if([string]$task.State -eq 'Ready'){
        $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq 10100)
        if($listeners.Count){throw 'Off task has an unknown listener.'}
        return @{version=$version;running=$false}
    }
    if([string]$task.State -ne 'Running'){throw 'Local task state unknown.'}
    $ready=Invoke-RestMethod 'http://localhost:10100/readyz' -TimeoutSec 10 -NoProxy
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$ready.pid)
    if($ready.status -ne 'ready' -or $ready.role -ne 'client' -or $ready.version -ne $version -or $process.ExecutablePath -ine $state.bunPath -or -not $process.CommandLine.Contains('"'+$cli+'"')){throw 'Local runtime owner or version differs.'}
    return @{version=$version;running=$true;pid=$ready.pid;bun=$state.bunPath}
}
function Wait-HubIdle($Observed,[DateTimeOffset]$Deadline){
    while($Observed.running -and ($Observed.activeTurns -ne 0 -or $Observed.draining -ne $false) -and [DateTimeOffset]::UtcNow -lt $Deadline){
        Start-Sleep -Seconds 2
        $Observed=Invoke-HubUpdate 'status'
    }
    if(-not $Observed.running -or $Observed.activeTurns -ne 0 -or $Observed.draining -ne $false){throw 'OCX intentionally off or busy; update preserved its state.'}
    return $Observed
}
function Resolve-StockCli([string]$ExpectedShim,[string]$StockBin){
    # Explicit script lookup can return every PATH match. Attest the command
    # PowerShell actually selects; never fall through to a preserved old copy.
    $stock=@(Get-Command ocx.ps1 -CommandType ExternalScript -ErrorAction Stop)[0]
    if($stock.Source -ine $ExpectedShim -or -not ([IO.File]::ReadAllText($stock.Source).Contains("'"+$StockBin+"'"))){throw 'Published stock CLI forward differs.'}
    return $stock
}
$local=Read-LocalOwner
$hub=Invoke-HubUpdate 'status'
$latest=(Invoke-RestMethod 'https://registry.npmjs.org/@bitkyc08%2fopencodex/latest' -TimeoutSec 20).version
if($latest -notmatch '^\d+\.\d+\.\d+$'){throw 'Stable upstream registry version unknown.'}
$receipt=@{terminal='PASS_CURRENT';local=$local.version;hub=$hub.version;latest=$latest;localRunning=$local.running;hubRunning=$hub.running;hubActiveTurns=$hub.activeTurns;hubDraining=$hub.draining;changed=$false;dashboard='http://localhost:10100'}
if($hub.windowPolicyActive){
    $receipt.windowPolicy='5h 95% used / weekly 98% used'
    $receipt.hubUpstream=$hub.upstreamVersion
    if($hub.upstreamVersion -ne $latest -and ($latest -ne '2.77.0' -or $hub.version -ne '2.76.0-aicc.windows.3')){
        $receipt.terminal='HOLD_POLICY_REBUILD_REQUIRED'
        $receipt.nativeConfigUnchanged=(Get-FileHash -LiteralPath $nativeConfig).Hash -ceq $nativeHash
        $receipt | ConvertTo-Json -Compress
        return
    }
}
$hubTargetCurrent=if($hub.windowPolicyActive){$hub.upstreamVersion -eq $latest}else{$hub.version -eq $latest}
if($local.version -ne $latest -or -not $hubTargetCurrent){
    if($Check){$receipt.terminal=if($hub.windowPolicyActive){'UPDATE_AVAILABLE_POLICY_REVIEWED'}else{'UPDATE_AVAILABLE'}}else{
        $idleDeadline=[DateTimeOffset]::UtcNow.AddSeconds($WaitForIdleSeconds)
        if(-not $local.running){throw 'OCX intentionally off or busy; update preserved its state.'}
        $hub=Wait-HubIdle $hub $idleDeadline
        # Reuse immutable software-only snapshots. Credentials/history are never restored.
        $snapshotText=python (Join-Path $PSScriptRoot 'native-versions.py') snapshot --root $globalRoot --store $store
        if($LASTEXITCODE -ne 0){throw 'Local software snapshot failed.'}
        $snapshot=$snapshotText|ConvertFrom-Json
        if(-not $hubTargetCurrent){
            if($hub.windowPolicyActive){
                $prepared=& (Join-Path $PSScriptRoot 'Invoke-AiccOcxWindowPolicy.ps1') -Action prepare -TargetVersion $latest
                if(($prepared|ConvertFrom-Json).terminal -ne 'PASS_PREPARED'){throw 'Reviewed policy candidate is not prepared.'}
                $updated=& (Join-Path $PSScriptRoot 'Invoke-AiccOcxWindowPolicy.ps1') -Action deploy -TargetVersion $latest
                if(($updated|ConvertFrom-Json).terminal -ne 'PASS'){throw 'Policy upgrade unconfirmed; local update was not started.'}
            }else{
                $hubSnapshot=Invoke-HubUpdate 'snapshot'
                $updated=Invoke-HubUpdate 'update' $hub.version $latest
                if($updated.terminal -ne 'PASS_UPDATED'){throw 'Hub rolled back; local update was not started.'}
            }
        }
        if($local.version -ne $latest){
            # Keep the original wait budget across the separately guarded targets.
            # A new hub turn after preparation is not permission to restart it.
            $idle=Wait-HubIdle (Invoke-HubUpdate 'status') $idleDeadline
            $pathBefore=$env:PATH
            $ocxHomeBefore=$env:OPENCODEX_HOME
            $codexHomeBefore=$env:CODEX_HOME
            try{
                $env:PATH=(Split-Path $local.bun -Parent)+';'+$pathBefore
                $env:OPENCODEX_HOME=Join-Path $ownerHome '.opencodex'
                $env:CODEX_HOME=Join-Path $ownerHome '.codex'
                $appsShim=@(Get-Command aicc-apps.ps1 -CommandType ExternalScript -ErrorAction Stop)[0]
                $expectedShim=Join-Path (Split-Path $appsShim.Source -Parent) 'ocx.ps1'
                $stockBin=Join-Path $package 'bin/ocx.mjs'
                $stock=Resolve-StockCli $expectedShim $stockBin
                # Output is captured in memory; never forward authentication/config dumps.
                $ignored=& $stock.Source update --tag latest 2>&1
                $exitCode=$LASTEXITCODE
            }finally{$env:PATH=$pathBefore;$env:OPENCODEX_HOME=$ocxHomeBefore;$env:CODEX_HOME=$codexHomeBefore}
            if($exitCode -ne 0){
                # Automatic code rollback only once exact task is off and ports are proven absent.
                if([string](Get-ScheduledTask -TaskName 'opencodex-proxy').State -ne 'Ready'){throw 'Local update failed with a live owner; preserved for inspection.'}
                $inventoryText=python (Join-Path $PSScriptRoot 'native-versions.py') status --root $globalRoot --store $store
                if($LASTEXITCODE -ne 0){throw 'Current software unknown; no blind rollback.'}
                $inventory=$inventoryText|ConvertFrom-Json
                $restoreText=python (Join-Path $PSScriptRoot 'native-versions.py') restore --root $globalRoot --store $store --snapshot $snapshot.snapshot --expected-sha256 $inventory.sha256 --commit
                if($LASTEXITCODE -ne 0){throw 'Safe offline rollback refused.'}
                $recovery=& (Join-Path $PSScriptRoot 'Invoke-AiccOcxRecovery.ps1')
                throw 'Local software rolled back; inspect the separately reported hub version.'
            }
        }
        $local=Read-LocalOwner
        $hub=Invoke-HubUpdate 'status'
        $hubTargetCurrent=if($hub.windowPolicyActive){$hub.upstreamVersion -eq $latest}else{$hub.version -eq $latest}
        if($local.version -ne $latest -or -not $hubTargetCurrent -or -not $local.running -or -not $hub.running){throw 'Two-target postconditions failed.'}
        $receipt.terminal='PASS_UPDATED';$receipt.local=$local.version;$receipt.hub=$hub.version;$receipt.changed=$true
    }
}
elseif($hub.windowPolicyActive){$receipt.terminal='PASS_CUSTOM_CURRENT'}
if((Get-FileHash -LiteralPath $nativeConfig).Hash -cne $nativeHash){
    $receipt.terminal='HOLD_NATIVE_CONFIG_DRIFT'
    $receipt.nativeConfigUnchanged=$false
    $receipt | ConvertTo-Json -Compress
    throw 'Native config changed during update; inspect before further work.'
}
$receipt.nativeConfigUnchanged=$true
$receipt | ConvertTo-Json -Compress
