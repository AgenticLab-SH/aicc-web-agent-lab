#requires -Version 7.0
$ErrorActionPreference='Stop'
$stateRoot=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'}
$jobs=Join-Path $stateRoot 'jobs';New-Item -ItemType Directory -Path $jobs -Force|Out-Null
foreach($file in Get-ChildItem -LiteralPath $jobs -Filter 'ocx-dynamic-policy-*.json' -File){$existing=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json;if($existing.state -in @('QUEUED','WAITING_IDLE','DEPLOYING','UNCERTAIN')){throw 'Existing owner deployment job preserved; inspect before another dispatch'}}
$sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$sources=@('tools/platform/opencodex/Invoke-AiccOcxWindowPolicy.ps1','tools/platform/opencodex/hub-window-policy.py','tools/platform/opencodex/build-window-policy.py','tools/platform/opencodex/window-admission.ts','tools/platform/opencodex/window-admission-v2.ts','tools/platform/opencodex/window-policy-settings.ts','tools/platform/opencodex/probe-stock-quota-routing.mjs','tools/platform/opencodex/probe-window-admission.mjs','tools/platform/windows/Complete-AiccPolicyDeployment.ps1')
$hashes=[ordered]@{};foreach($relative in $sources){$hashes[$relative]=(Get-FileHash -LiteralPath (Join-Path $sourceRoot $relative) -Algorithm SHA256).Hash}
$digest=[Security.Cryptography.SHA256]::Create();try{$identity=[Convert]::ToHexString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes(($hashes|ConvertTo-Json -Compress)))).ToLowerInvariant()}finally{$digest.Dispose()}
$release=Join-Path $stateRoot ('releases\policy-deployment\'+$identity.Substring(0,16))
foreach($relative in $sources){$target=Join-Path $release $relative;New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force|Out-Null;if(-not(Test-Path -LiteralPath $target)){Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $target}elseif((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $hashes[$relative]){throw 'Immutable deployment pack changed'}}
$jobFile=Join-Path $jobs ('ocx-dynamic-policy-'+[guid]::NewGuid().ToString('N')+'.json')
$job=@{schemaVersion=1;action='deploy-ocx-dynamic-policy';targetVersion='2.77.0-aicc.windows.2';state='QUEUED';createdAt=[DateTimeOffset]::Now.ToString('o');expiresAt=[DateTimeOffset]::Now.AddHours(1).ToString('o');deploymentRoot=$release;sourceHashes=$hashes;accountMutation=$false;rollbackOwnedBy='maintained-deployer-watchdog'}
[IO.File]::WriteAllText($jobFile,($job|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
$worker=Join-Path $release 'tools\platform\windows\Complete-AiccPolicyDeployment.ps1'
$arguments='-NoProfile -NonInteractive -File "'+$worker+'" -JobFile "'+$jobFile+'" -DeploymentRoot "'+$release+'"'
$process=Start-Process -FilePath (Get-Command pwsh.exe).Source -ArgumentList $arguments -WindowStyle Hidden -PassThru
@{queued=$true;job=$jobFile;workerPid=$process.Id;waitFor='two confirmed idle observations';expiresAt=$job.expiresAt;visibleConsole=$false}|ConvertTo-Json
