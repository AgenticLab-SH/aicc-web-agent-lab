#requires -Version 7.5
$ErrorActionPreference='Stop'
$root=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.desktop-commander-device'
$mutex=[Threading.Mutex]::new($false,'Local\AICC-RDC-Managed-Launcher')
if(-not $mutex.WaitOne(0)){return}
try{
 $existing=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -and ($_.CommandLine -match 'rdc-managed-agent\.mjs' -or $_.CommandLine -match 'desktop-commander[\\/]dist[\\/]index\.js"?\s+remote(?:\s|$)')})
 if($existing.Count){return}
 $config=Get-Content -LiteralPath (Join-Path $root 'managed-runtime.json') -Raw|ConvertFrom-Json
 if((Get-FileHash -LiteralPath $config.agent).Hash.ToLowerInvariant() -cne $config.agentSha256){throw 'Managed RDC launcher pin differs'}
 Start-Process -FilePath $config.node -ArgumentList @(('"'+$config.agent+'"')) -WindowStyle Hidden -WorkingDirectory $root|Out-Null
}finally{$mutex.ReleaseMutex();$mutex.Dispose()}
