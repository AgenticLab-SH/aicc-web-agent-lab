# Bind the existing phone entry points to a registered immutable tray release.
# No history rewrite, watcher/task/SSH change, model process or service restart.
param([Parameter(Mandatory=$true)][string]$ReleaseRoot,[Parameter(Mandatory=$true)][string]$ExpectedSelectSha256,
      [Parameter(Mandatory=$true)][string]$ExpectedResumeSha256)
$ErrorActionPreference='Stop'
$phone=[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\phone-terminal-20261028'))
$state=if($env:AICC_STATE_ROOT){[IO.Path]::GetFullPath($env:AICC_STATE_ROOT)}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'}
$release=[IO.Path]::GetFullPath($ReleaseRoot)
if(-not $release.StartsWith((Join-Path $state 'releases\tray')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Managed tray release required'}
$registry=Get-Content -LiteralPath (Join-Path $state 'runtime\components.json') -Raw|ConvertFrom-Json
if($registry.components.tray.releaseRoot -ine $release){throw 'Register the exact tray source first'}
if((Get-Item -LiteralPath $phone).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked phone store refused'}
$files=@('Select-PhoneTerminal.ps1','Resume-PhoneTerminal.ps1')
$pins=@($ExpectedSelectSha256,$ExpectedResumeSha256)
$gate=[IO.File]::Open((Join-Path $phone 'terminal-history.json.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
    $before=@();$next=@();$sources=@()
    for($i=0;$i -lt $files.Count;$i++){
        $target=Join-Path $phone $files[$i];$source=Join-Path $release ('tools\platform\codex\'+$files[$i])
        if($pins[$i] -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pins[$i]){throw 'Existing phone source changed; preserve it'}
        if((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked phone entry refused'}
        $relative='tools/platform/codex/'+$files[$i];$registered=$registry.components.tray.sourceHashes.$relative
        if(-not $registered -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $registered){throw 'Immutable shared source pin differs'}
        $before+=,([IO.File]::ReadAllBytes($target));$sources+=$source
        if($i -eq 0){$text="# Managed phone entry; state/history stays owner-local.`r`n. '"+$source.Replace("'","''")+"'`r`n"}
        else{$text="param([string]`$RecordId,[string]`$AttemptId)`r`n& '"+$source.Replace("'","''")+"' -RecordId `$RecordId -AttemptId `$AttemptId`r`n"}
        $next+=$text
    }
    $operation=Join-Path $phone ('picker-registration-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $operation|Out-Null
    for($i=0;$i -lt $files.Count;$i++){[IO.File]::WriteAllBytes((Join-Path $operation ($files[$i]+'.before')),$before[$i])}
    $intent=@{schemaVersion=1;state='ENTRY_BINDING_INTENT';release=$release;originalPins=$pins;automaticRetry=$false;historyChanged=$false;watcherChanged=$false}
    [IO.File]::WriteAllText((Join-Path $operation 'intent.json'),($intent|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    # Each target uses PS5-compatible non-empty backup and a fresh exact preimage check.
    for($i=0;$i -lt $files.Count;$i++){
        $target=Join-Path $phone $files[$i]
        if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pins[$i]){throw 'Phone entry CAS changed; keep partial intent'}
        $tmp=Join-Path $phone ($files[$i]+'.'+[guid]::NewGuid().ToString('N')+'.tmp')
        [IO.File]::WriteAllText($tmp,$next[$i],[Text.UTF8Encoding]::new($true))
        [IO.File]::Replace($tmp,$target,(Join-Path $operation ($files[$i]+'.replace-backup')))
    }
    @{state='PHONE_ENTRY_BINDING_COMMANDS_RETURNED';operation=$operation;historyChanged=$false;watcherChanged=$false;sshChanged=$false;verification='NOT_RUN'}|ConvertTo-Json
}finally{$gate.Dispose()}
