#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('new','resume')][string]$Action='new',
    [Parameter(Mandatory)][string]$Prompt,
    [ValidatePattern('^chatgpt-web/(account-[1-9][0-9]?/)?(saved|temporary)/(low|medium|high|extra-high)$')][string]$Model,
    [ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$ThreadId,
    [string]$Directory=(Get-Location).Path
)
$ErrorActionPreference='Stop'
$ownerHome=[Environment]::GetFolderPath('UserProfile')
$codexHome=if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path $ownerHome '.codex'}
$configuration=[IO.File]::ReadAllText((Join-Path $codexHome 'config.toml'))
$topLevel=($configuration -split '(?m)^\s*\[',2)[0]
if($topLevel -notmatch '(?m)^\s*openai_base_url\s*=\s*"http://127\.0\.0\.1:17841/v1"\s*$'){
    throw 'Web route is disconnected. Run aicc doctor; no Native fallback or automatic route change.'
}
if($topLevel -match '(?m)^\s*model_provider\s*=\s*"(?!openai")[^"]+"'){
    throw 'A different default provider is active; it is preserved.'
}
$health=Invoke-RestMethod -Uri 'http://127.0.0.1:17841/healthz' -TimeoutSec 10
if($health.status -ne 'ok' -or $health.service -ne 'codex-chatgpt-web' -or $health.runtime_owner -ne 'service' -or $health.accepting_browser_turns -ne $true){
    throw 'The existing Web runtime is not accepting work; no restart or fallback.'
}
$indexRoot=Join-Path $ownerHome '.codex-chatgpt-web/tasks'
if($Action -eq 'resume'){
    if(-not $ThreadId){throw 'Resume requires the exact thread id.'}
    $indexFile=Join-Path $indexRoot ($ThreadId+'.json')
    if((Get-Item -LiteralPath $indexRoot).LinkType -or (Get-Item -LiteralPath $indexFile).LinkType){throw 'Linked task descriptor refused.'}
    $saved=Get-Content -LiteralPath $indexFile -Raw | ConvertFrom-Json
    if($saved.threadId -ne $ThreadId -or $saved.codexHome -ine $codexHome -or -not $saved.directory -or $saved.model -notmatch '^chatgpt-web/(account-[1-9][0-9]?/)?(saved|temporary)/(low|medium|high|extra-high)$'){
        throw 'Owned Web task descriptor is invalid; no model substitution.'
    }
    if($Model -and $Model -cne $saved.model){throw 'The requested model differs from this saved Web task. Start a new task instead.'}
    if(-not $Model){$Model=$saved.model}
    $Directory=$saved.directory
}elseif($ThreadId){throw 'New tasks do not accept an existing thread id.'}
if(-not $Model){$Model='chatgpt-web/saved/low'}
$catalog=Invoke-RestMethod -Uri 'http://127.0.0.1:17841/v1/models' -TimeoutSec 10
if(@($catalog.models | Where-Object {$_.slug -ceq $Model}).Count -ne 1){throw 'Requested Web model is unavailable; no fallback.'}
$executable=Join-Path $ownerHome 'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe'
if(-not(Test-Path -LiteralPath $executable -PathType Leaf)){throw 'Official standalone Codex is missing; run aicc doctor.'}
$workingDirectory=(Resolve-Path -LiteralPath $Directory).Path
$arguments=if($Action -eq 'new'){
    @('exec','--json','--skip-git-repo-check','--cd',$workingDirectory,'-m',$Model,$Prompt)
}else{@('exec','resume','--json','--skip-git-repo-check','-m',$Model,$ThreadId,$Prompt)}
# Always pass the exact Web model, including resume. Codex otherwise uses its
# Native default. Store only routing metadata, never prompts, auth or tool output.
Push-Location -LiteralPath $workingDirectory
try{
& $executable @arguments | ForEach-Object {
    $line=$_;Write-Output $line
    try{$event=$line | ConvertFrom-Json}catch{$event=$null}
    if($Action -eq 'new' -and $event.type -eq 'thread.started'){
        $id=[Guid]::Parse($event.thread_id).ToString()
        [IO.Directory]::CreateDirectory($indexRoot) | Out-Null
        if((Get-Item -LiteralPath $indexRoot).LinkType){throw 'Linked task index refused.'}
        $descriptor=@{schemaVersion=2;threadId=$id;model=$Model;codexHome=$codexHome;directory=$workingDirectory}
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($descriptor | ConvertTo-Json -Compress))
        $file=[IO.File]::Open((Join-Path $indexRoot ($id+'.json')),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
    }
}
$executionExit=$LASTEXITCODE
}finally{Pop-Location}
exit $executionExit
