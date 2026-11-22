# Owner-local phone terminal browser. No model calls from discovery or startup.
$script:PhoneRoot=if($env:AICC_PHONE_TERMINAL_ROOT){[IO.Path]::GetFullPath($env:AICC_PHONE_TERMINAL_ROOT)}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\ops\phone-terminal-20261028'}
$script:PhoneSourceRoot=$PSScriptRoot
$script:PhoneMux=Join-Path $env:LOCALAPPDATA 'Programs\psmux\3.4.0\psmux.exe'
$script:PhoneStore=Join-Path $script:PhoneRoot 'terminal-history.json'
function ConvertFrom-PhoneJson {
    param([string]$Json)
    # PS7.5+ parses ISO strings to DateTime by default; keep identity timestamps exact.
    if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')){
        return ($Json | ConvertFrom-Json -DateKind String)
    }
    return ($Json | ConvertFrom-Json)
}
function Invoke-PhoneStore {
    param([scriptblock]$Action)
    $ErrorActionPreference='Stop'
    $gate=$null
    try {
        $gate=[IO.File]::Open(($script:PhoneStore+'.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $state=ConvertFrom-PhoneJson ([IO.File]::ReadAllText($script:PhoneStore))
        & $Action $state
        $tmp=$script:PhoneStore+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
        [IO.File]::WriteAllText($tmp,($state|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($true))
        [IO.File]::Replace($tmp,$script:PhoneStore,($script:PhoneStore+'.previous'))
    } finally {if($gate){$gate.Dispose()}}
}
function Get-PhoneLive {
    if(-not (Test-Path -LiteralPath $script:PhoneMux -PathType Leaf)){throw 'psmux 실행기를 찾지 못했습니다.'}
    $sep=[string][char]31
    $format=@('#{session_name}','#{window_index}','#{pane_index}','#{window_name}','#{pane_title}','#{pane_current_command}','#{pane_current_path}','#{pane_pid}','#{session_created}','#{session_last_attached}','#{pane_dead}') -join $sep
    $prior=$ErrorActionPreference
    try {$ErrorActionPreference='Continue';$raw=@(& $script:PhoneMux -L aicc-phone list-panes -a -F $format 2>&1);$code=$LASTEXITCODE}
    finally {$ErrorActionPreference=$prior}
    if($code -ne 0){
        $message=($raw|ForEach-Object {"$_"}) -join ' '
        if($message -match '(?i)no server running|no sessions|no server found'){return}
        throw '터미널 상태 조회 실패: 닫힌 상태로 간주하지 않습니다.'
    }
    foreach($line in $raw){
        $p=([string]$line).Split([char]31)
        if($p.Count -ne 11 -or $p[1] -notmatch '^\d+$' -or $p[2] -notmatch '^\d+$'){throw '터미널 목록 형식 불명'}
        [pscustomobject]@{session=$p[0];window=$p[1];pane=$p[2];windowTitle=$p[3];title=$p[4];command=$p[5];cwd=$p[6];pid=[int]$p[7];created=$p[8];attached=$p[9];dead=($p[10] -eq '1');key=($p[0]+'/'+$p[1]+'/'+$p[2]+'/'+$p[8])}
    }
}
function Get-PhoneCodexProcess {
    param($Pane,$Processes)
    $ids=@([int]$Pane.pid)
    for($depth=0;$depth -lt 16;$depth++){
        $more=@($Processes|Where-Object {$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids}|ForEach-Object {[int]$_.ProcessId})
        if($more.Count -eq 0){break};$ids+=$more
    }
    $candidates=@($Processes|Where-Object {$_.ProcessId -in $ids -and $_.Name -eq 'codex.exe'})
    # A CLI can own an app-server for its tools. Only outer Codex processes own
    # this pane; nested transports must not create a second terminal identity.
    $found=@(foreach($candidate in $candidates){
        $parent=[int]$candidate.ParentProcessId;$nested=$false;$visited=@{}
        for($level=0;$level -lt 16 -and $parent -gt 0;$level++){
            if($visited.ContainsKey($parent)){throw '프로세스 계보가 순환하여 신원을 정할 수 없습니다.'}
            $visited[$parent]=$true
            if(@($candidates|Where-Object ProcessId -eq $parent).Count){$nested=$true;break}
            $parents=@($Processes|Where-Object ProcessId -eq $parent)
            if($parents.Count -gt 1){throw '프로세스 계보가 중복되어 신원을 정할 수 없습니다.'}
            if($parents.Count -eq 0){break}
            $parent=[int]$parents[0].ParentProcessId
        }
        if(-not $nested){$candidate}
    })
    if($found.Count -gt 1){throw '하나의 pane에 여러 Codex 프로세스가 있어 신원을 정할 수 없습니다.'}
    if($found.Count -eq 1){$found[0]}
}
function Get-PhonePaneProcesses {
    param([array]$Panes)
    # Query only pane PIDs and descendants. Never enumerate the entire process table.
    $seen=@{};$front=@($Panes|ForEach-Object {[int]$_.pid}|Where-Object {$_ -gt 0}|Select-Object -Unique)
    $result=@()
    for($depth=0;$depth -lt 16 -and $front.Count;$depth++){
        if($front.Count -gt 256 -or $result.Count -gt 512){throw '터미널 하위 프로세스 범위를 초과했습니다.'}
        $filter=($front|ForEach-Object {"ProcessId = $_ OR ParentProcessId = $_"}) -join ' OR '
        $batch=@(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)
        $next=@()
        foreach($p in $batch){if(-not $seen.ContainsKey([int]$p.ProcessId)){$seen[[int]$p.ProcessId]=$true;$result+=$p;$next+=[int]$p.ProcessId}}
        $front=$next
    }
    $result
}
# Only a directly observed codex.exe argv with one explicit "resume UUID" is evidence.
# Parsing is bounded and never interprets embedded prompts or implicit --last.
function Split-PhoneNativeCommandLine {
    param([string]$CommandLine)
    if([string]::IsNullOrWhiteSpace($CommandLine) -or $CommandLine.Length -gt 16384 -or $CommandLine -match '[\x00\r\n]'){return}
    $tokens=[Collections.Generic.List[string]]::new();$i=0
    while($i -lt $CommandLine.Length){
        while($i -lt $CommandLine.Length -and [char]::IsWhiteSpace($CommandLine[$i])){$i++}
        if($i -ge $CommandLine.Length){break}
        $value=[Text.StringBuilder]::new();$quoted=$false
        while($i -lt $CommandLine.Length){
            $ch=$CommandLine[$i]
            if(-not $quoted -and [char]::IsWhiteSpace($ch)){break}
            if($ch -eq [char]92){
                $slashes=0
                while($i -lt $CommandLine.Length -and $CommandLine[$i] -eq [char]92){$slashes++;$i++}
                if($i -lt $CommandLine.Length -and $CommandLine[$i] -eq [char]34){
                    [void]$value.Append(('\'*[int][Math]::Floor($slashes/2)))
                    if($slashes%2){[void]$value.Append('"')}else{$quoted=-not $quoted}
                    $i++;continue
                }
                [void]$value.Append(('\'*$slashes));continue
            }
            if($ch -eq [char]34){$quoted=-not $quoted;$i++;continue}
            [void]$value.Append($ch);$i++
        }
        if($quoted){return}
        $tokens.Add($value.ToString())
    }
    $tokens.ToArray()
}
function Get-PhoneExactResumeId {
    param([string]$CommandLine)
    $args=@(Split-PhoneNativeCommandLine $CommandLine)
    if($args.Count -lt 3 -or [IO.Path]::GetFileName([string]$args[0]) -ine 'codex.exe'){return $null}
    $positions=@(for($j=1;$j -lt $args.Count;$j++){if($args[$j] -ceq 'resume'){$j}})
    if($positions.Count -ne 1){return $null}
    $at=[int]$positions[0]
    $uuid='^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$'
    if($at+1 -ge $args.Count -or $args[$at+1] -cnotmatch $uuid){return $null}
    for($j=1;$j -lt $args.Count;$j++){
        if($args[$j] -match '^--last(?:=|$)' -or ($j -ne $at+1 -and $args[$j] -match $uuid)){return $null}
    }
    # Accept only known CLI global switches before the subcommand; arbitrary values
    # such as --label resume must not be misread as a resume command.
    for($j=1;$j -lt $at;$j++){
        $token=[string]$args[$j]
        if($token -in @('--no-daemon','--search','--no-alt-screen')){continue}
        if($token -in @('-C','--cd','-p','--profile','-c','--config','-m','--model','-a','--ask-for-approval','-s','--sandbox','--enable','--disable')){
            $j++;if($j -ge $at){return $null};continue
        }
        if($token -match '^--(cd|profile|config|model|ask-for-approval|sandbox|enable|disable)=.+$'){continue}
        return $null
    }
    ([string]$args[$at+1]).ToLowerInvariant()
}
function Find-PhoneExactRollout {
    param([string]$ThreadId,[string]$SessionsRoot=(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\sessions'))
    if($ThreadId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or -not (Test-Path -LiteralPath $SessionsRoot -PathType Container)){return $null}
    $root=[IO.Path]::GetFullPath($SessionsRoot)
    for($part=$root;;$part=[IO.Path]::GetDirectoryName($part)){
        if((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '연결된 세션 디렉터리는 읽지 않습니다.'}
        if($part -eq [IO.Path]::GetPathRoot($part)){break}
    }
    $queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($root);$visited=0;$matched=$null
    while($queue.Count){
        if(++$visited -gt 2048){throw '세션 경로 탐색 범위를 초과했습니다.'}
        $folder=$queue.Dequeue()
        foreach($file in [IO.Directory]::EnumerateFiles($folder,('rollout-*-'+$ThreadId+'.jsonl'),[IO.SearchOption]::TopDirectoryOnly)){
            $name=[IO.Path]::GetFileName($file)
            if(-not $name.StartsWith('rollout-',[StringComparison]::OrdinalIgnoreCase) -or -not $name.EndsWith('-'+$ThreadId+'.jsonl',[StringComparison]::OrdinalIgnoreCase)){continue}
            $flags=[IO.File]::GetAttributes($file)
            if(($flags -band [IO.FileAttributes]::ReparsePoint) -or ($flags -band [IO.FileAttributes]::Directory)){continue}
            if($matched){throw '같은 ID의 대화 파일이 여러 개여서 결속하지 않습니다.'}
            $matched=[IO.Path]::GetFullPath($file)
        }
        foreach($dir in [IO.Directory]::EnumerateDirectories($folder)){
            if(-not ([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint)){$queue.Enqueue($dir)}
        }
    }
    $matched
}
function Clear-PhoneCodexBinding {
    param($Record,[string]$Kind='UNKNOWN')
    foreach($field in @('threadId','rollout','model','effort','resumeRelease','stopReceipt','writerRecordPath')){
        $Record|Add-Member -NotePropertyName $field -NotePropertyValue $null -Force
    }
    $Record.codex=$Kind;$Record.codexPid=0;$Record.codexStarted=$null
}

function Read-PhoneBoundedText {
    param([string]$Path,[int]$Maximum=1048576,[switch]$Tail)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    try{
        $length=[int][Math]::Min($stream.Length,$Maximum);$offset=if($Tail){$stream.Length-$length}else{0L}
        [void]$stream.Seek($offset,[IO.SeekOrigin]::Begin);$bytes=New-Object byte[] $length;$used=0
        while($used -lt $length){$n=$stream.Read($bytes,$used,$length-$used);if($n -eq 0){break};$used+=$n}
        $text=[Text.Encoding]::UTF8.GetString($bytes,0,$used)
        if($offset -gt 0){$first=$text.IndexOf("`n");if($first -lt 0){return ''};$text=$text.Substring($first+1)}
        $last=$text.LastIndexOf("`n");if($last -lt 0){return ''};$text.Substring(0,$last)
    }finally{$stream.Dispose()}
}
function Get-PhoneKnownContext {
    param($Record,[string]$SessionsRoot=(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\sessions'))
    if(-not $Record.rollout -or -not $Record.threadId){throw '정확한 대화 기록 결속이 없습니다.'}
    $sessions=[IO.Path]::GetFullPath($SessionsRoot).TrimEnd([char]92,[char]47)
    $rollout=[IO.Path]::GetFullPath([string]$Record.rollout)
    $name=[IO.Path]::GetFileName($rollout)
    if($Record.threadId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
       -not $rollout.StartsWith($sessions+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
       -not $name.StartsWith('rollout-',[StringComparison]::OrdinalIgnoreCase) -or
       -not $name.EndsWith('-'+$Record.threadId+'.jsonl',[StringComparison]::OrdinalIgnoreCase)){throw '등록 대화 경계가 다릅니다.'}
    for($part=$rollout;;$part=[IO.Path]::GetDirectoryName($part)){
        if((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '연결된 대화 경로는 읽지 않습니다.'}
        if($part -eq [IO.Path]::GetPathRoot($part)){break}
    }
    $item=Get-Item -LiteralPath $rollout -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '일반 대화 파일만 읽습니다.'}
    $meta=$null;$context=$null
    # No full rollout scan: 1MiB head and a bounded 1MiB/4MiB tail. A long
    # tool-heavy turn can place its context more than 1MiB behind the current end.
    foreach($line in ((Read-PhoneBoundedText $rollout -Maximum 1048576) -split "\n")){
        if($line -notmatch '"type"\s*:\s*"session_meta"'){continue}
        $event=ConvertFrom-PhoneJson $line
        if($event.type -eq 'session_meta'){$meta=$event.payload;break}
    }
    foreach($budget in @(1048576,4194304)){
        foreach($line in ((Read-PhoneBoundedText $rollout -Maximum $budget -Tail) -split "\n")){
            if($line -notmatch '"type"\s*:\s*"turn_context"'){continue}
            $event=ConvertFrom-PhoneJson $line
            if($event.type -eq 'turn_context'){$context=$event.payload}
        }
        if($context){break}
    }
    if(-not $meta -or $meta.id -cne $Record.threadId -or -not $context -or
       [string]::IsNullOrWhiteSpace([string]$context.model) -or
       [string]::IsNullOrWhiteSpace([string]$context.effort)){throw '대화 메타데이터 또는 현재 모델 정보가 미확인입니다.'}
    [pscustomobject]@{meta=$meta;context=$context}
}
function Update-PhoneHistory {
    param([string]$SessionsRoot=(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\sessions'),[string]$IndexPath=(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\session_index.jsonl'))
    $live=@(Get-PhoneLive)
    $processes=$null
    try {$processes=@(Get-PhonePaneProcesses $live)} catch {$processes=$null}
    $titles=@{}
    $index=$IndexPath
    if(Test-Path -LiteralPath $index -PathType Leaf){
        try{
            if(-not ((Get-Item -LiteralPath $index -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){
                foreach($line in ((Read-PhoneBoundedText $index -Maximum 1048576 -Tail) -split "\n")){
                    try{
                        $t=ConvertFrom-PhoneJson $line
                        if([string]$t.id -match '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){
                            $name=([string]$t.thread_name -replace '[\x00-\x1f\x7f]',' ').Trim()
                            if($name.Length -gt 160){$name=$name.Substring(0,160)+'…'}
                            if($name){$titles[[string]$t.id]=$name}
                        }
                    }catch{}
                }
            }
        }catch{}
    }
    Invoke-PhoneStore {
        param($state)
        $now=[DateTimeOffset]::Now.ToString('o')
        foreach($r in $state.items){$r.present=$false}
        foreach($p in $live){
            $matches=@($state.items|Where-Object {$_.key -eq $p.key -or ($_.pending -and $_.session -eq $p.session)}|Select-Object -First 1)
            if($matches.Count){$r=$matches[0]}else{
                $r=[pscustomobject]@{id=[guid]::NewGuid().ToString('N');key=$p.key;session=$p.session;window=$p.window;pane=$p.pane;title=$p.windowTitle;cwd=$p.cwd;lastOpened=$null;lastSeen=$now;present=$true;dead=$p.dead;codex='UNKNOWN';threadId=$null;rollout=$null;model=$null;effort=$null;codexPid=0;codexStarted=$null;pending=$null;lastAttempt=$null}
                $state.items=@($state.items)+@($r)
            }
            $r.key=$p.key;$r.window=$p.window;$r.pane=$p.pane;$r.present=$true;$r.dead=$p.dead;$r.lastSeen=$now
            if($r.pending){$r.lastAttempt=$r.pending;$r.pending=$null}
            if($p.cwd -and (Test-Path -LiteralPath $p.cwd -PathType Container)){$r.cwd=$p.cwd}
            $epoch=0L
            $timeValue=if([long]::TryParse($p.attached,[ref]$epoch) -and $epoch -gt 0){$epoch}else{[long]$p.created}
            $opened=[DateTimeOffset]::FromUnixTimeSeconds($timeValue)
            if(-not $r.lastOpened -or $opened -gt [DateTimeOffset]::Parse($r.lastOpened)){$r.lastOpened=$opened.ToString('o')}
            if(-not $p.dead){
                if($null -eq $processes){Clear-PhoneCodexBinding $r 'UNKNOWN'}
                else{
                    try{
                        $cp=@(Get-PhoneCodexProcess $p $processes)
                        if($cp.Count -eq 0){Clear-PhoneCodexBinding $r 'NO'}
                        else{
                            $proc=$cp[0];$started=([DateTimeOffset]$proc.CreationDate).ToString('o')
                            if($r.codexPid -ne [int]$proc.ProcessId -or $r.codexStarted -cne $started){Clear-PhoneCodexBinding $r 'YES'}
                            $r.codex='YES';$r.codexPid=[int]$proc.ProcessId;$r.codexStarted=$started
                            try{
                                $thread=Get-PhoneExactResumeId ([string]$proc.CommandLine)
                                if(-not $thread){throw '명시적 resume UUID 없음'}
                                $rollout=Find-PhoneExactRollout $thread -SessionsRoot $SessionsRoot
                                if(-not $rollout){throw '대화 파일 없음'}
                                $candidate=[pscustomobject]@{threadId=$thread;rollout=$rollout}
                                $known=Get-PhoneKnownContext $candidate -SessionsRoot $SessionsRoot
                                if($r.threadId -and ($r.threadId -cne $thread -or $r.rollout -cne $rollout)){Clear-PhoneCodexBinding $r 'YES'}
                                $r.codex='YES';$r.codexPid=[int]$proc.ProcessId;$r.codexStarted=$started
                                $r.threadId=$thread;$r.rollout=$rollout
                                $r.model=[string]$known.context.model;$r.effort=[string]$known.context.effort
                            }catch{
                                # A live process without exact verified argv+rollout is not a remembered identity.
                                Clear-PhoneCodexBinding $r 'YES'
                                $r.codexPid=[int]$proc.ProcessId;$r.codexStarted=$started
                            }
                        }
                    }catch{Clear-PhoneCodexBinding $r 'UNKNOWN'}
                }
            }
            if($r.threadId){
                $r.title=if($titles.ContainsKey([string]$r.threadId)){$titles[[string]$r.threadId]}else{$null}
            }else{$r.title=if($p.title -and $p.title -ne 'AUTOTRADER'){$p.title}else{$p.windowTitle}}
        }
        $state.observedAt=$now
    }
}
function Get-PhonePickerSnapshot {
    param([switch]$Refresh)
    if($Refresh){Update-PhoneHistory}
    $state=Read-PhoneHistory
    $items=@(foreach($r in ($state.items|Sort-Object lastOpened -Descending)){
        $opened=[bool]($r.present -and -not $r.dead)
        $kind=switch($r.codex){'YES' {'Codex'} 'NO' {'PowerShell'} default {'종류 미확인'}}
        $title=if($r.codex -eq 'YES'){if($r.threadId -and $r.title){[string]$r.title}else{'Codex 제목 미확인'}}elseif($r.title){[string]$r.title}else{'PowerShell'}
        $missingResume=(-not $opened -and $r.codex -eq 'YES' -and (-not $r.threadId -or -not $r.rollout -or -not $r.resumeRelease))
        $reason=if($r.pending){'이전 열기 결과 불명 · 재시도하지 않습니다.'}elseif($missingResume){'정확한 대화 ID·기존 경로·현재 작성권 해제 영수증이 필요합니다.'}elseif(-not $opened -and $r.codex -eq 'NO'){'닫힌 PowerShell은 대화 재개 대상이 아닙니다. 새 PowerShell을 사용하세요.'}elseif(-not $opened -and $r.codex -eq 'UNKNOWN'){'종류를 확인해야 합니다.'}elseif(-not $opened -and $r.codex -eq 'YES'){'정확한 대화·기존 경로·현재 작성권 해제 영수증을 실행 직전에 확인합니다.'}else{''}
        [pscustomobject]@{id=$r.id;title=$title;session=$r.session;kind=$kind;model=$(if($r.model){$r.model}else{'미확인'});effort=$(if($r.effort){$r.effort}else{'미확인'});lastOpened=$r.lastOpened;opened=$opened;modelWork='미확인';threadId=$r.threadId;cwd=$r.cwd;pending=[bool]$r.pending;disabledReason=$reason;canOpen=(-not $r.pending -and ($opened -or ($r.codex -eq 'YES' -and -not $missingResume)));binding=($r.key+'|'+$r.threadId)}
    })
    [pscustomobject]@{schemaVersion=1;kind='aicc-terminal-picker';observedAt=$state.observedAt;items=$items;modelCalls=0;polling=$false}
}
function Assert-PhoneResumeRelease {
    param($Record)
    $known=Get-PhoneKnownContext $Record
    # 'aicc-ocx' is the r2 shared-HOME provider id; 'aicc-ocx-compat' is the process-only provider id of the aicc codex ocx launcher (G1-08).
    if(@('opencodex','aicc-ocx','aicc-ocx-compat') -cnotcontains [string]$known.meta.model_provider){throw '기존 OCX 외 경로는 해당 정비 소유자가 재개해야 합니다. 경로를 바꾸지 않습니다.'}
    $pin=$Record.resumeRelease
    if(-not $pin -or $pin.sha256 -notmatch '^[a-f0-9]{64}$' -or -not [IO.Path]::IsPathRooted($pin.path)){throw '현재 작성권 해제 영수증이 없습니다. 기존 소유자가 정상 종료·불명 조정 후 제공해야 합니다.'}
    $bytes=Read-PhonePinnedArtifact $pin.path;$sha=[Security.Cryptography.SHA256]::Create()
    try{$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    if($hash -cne $pin.sha256){throw '작성권 해제 영수증이 바뀌었습니다.'}
    $release=ConvertFrom-PhoneJson ([Text.Encoding]::UTF8.GetString($bytes));$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if($release.schemaVersion -ne 1 -or $release.kind -cne 'aicc-terminal-resume-release' -or $release.recordId -cne $Record.id -or
       $release.threadId -cne $Record.threadId -or $release.normalExit -ne $true -or $release.writerReleased -ne $true -or
       $release.activeCount -isnot [int] -or $release.activeCount -ne 0 -or $release.unknownCount -isnot [int] -or $release.unknownCount -ne 0 -or
       $release.observedAt -isnot [ValueType] -or $release.expiresAt -isnot [ValueType] -or
       $release.observedAt -gt $now -or $now-$release.observedAt -gt 60000 -or $release.expiresAt -le $now -or $release.expiresAt-$release.observedAt -gt 60000 -or
       $release.provider -cne $known.meta.model_provider -or $release.model -cne $known.context.model -or $release.effort -cne $known.context.effort){throw '현재 대화·경로·정상종료·active0/UNKNOWN0 해제 근거가 필요합니다.'}
    $file=Get-Item -LiteralPath $Record.rollout
    if($release.rolloutLength -ne $file.Length -or $release.rolloutLastWriteUtc -cne $file.LastWriteTimeUtc.ToString('o')){throw '해제 이후 대화가 바뀌었습니다.'}
    if($release.stoppedPid -isnot [ValueType] -or $release.stoppedPid -le 0){throw '원 프로세스 결속이 없습니다.'}
    if(@(Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$release.stoppedPid) -ErrorAction Stop).Count){throw '원 프로세스가 아직 있습니다.'}
    $thread=[string]$Record.threadId
    if($thread -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw '정확한 UUID가 필요합니다.'}
    if(@(Get-CimInstance Win32_Process -Filter ("Name = 'codex.exe' AND CommandLine LIKE '%"+$thread+"%'") -ErrorAction Stop).Count){throw '동일 대화의 기존 실행이 있습니다.'}
    $writer=$release.writerRecord
    if(-not $writer -or $writer.sha256 -notmatch '^[a-f0-9]{64}$' -or -not [IO.Path]::IsPathRooted($writer.path)){throw '정본 작성권 pin이 없습니다.'}
    $wb=Read-PhonePinnedArtifact $writer.path;$sha=[Security.Cryptography.SHA256]::Create()
    try{$wh=([BitConverter]::ToString($sha.ComputeHash($wb))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    $owner=ConvertFrom-PhoneJson ([Text.Encoding]::UTF8.GetString($wb))
    if($wh -cne $writer.sha256 -or $owner.owner -cne $Record.threadId -or $owner.writerReleased -ne $true){throw '다른 writer가 인수했거나 원 작성권이 해제되지 않았습니다.'}
    $known|Add-Member -NotePropertyName release -NotePropertyValue $release -Force
    $known|Add-Member -NotePropertyName writerBytes -NotePropertyValue $wb -Force
    $known|Add-Member -NotePropertyName writer -NotePropertyValue $owner -Force
    $known
}
function Read-PhonePinnedArtifact {
    param([string]$Path)
    if(-not [IO.Path]::IsPathRooted($Path)){throw '절대 영수증 경로가 필요합니다.'}
    $absolute=[IO.Path]::GetFullPath($Path)
    for($part=$absolute;;$part=[IO.Path]::GetDirectoryName($part)){
        if((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '연결된 영수증 경로는 사용하지 않습니다.'}
        if($part -eq [IO.Path]::GetPathRoot($part)){break}
    }
    $item=Get-Item -LiteralPath $absolute
    if($item.PSIsContainer -or $item.Length -gt 1048576){throw '작은 원 영수증 파일이 필요합니다.'}
    ,[IO.File]::ReadAllBytes($absolute)
}
# G1-08: mint a fresh 60-second resume release from the launcher-produced stop receipt of the
# last exact resume. Every field is re-observed now; the stop only proves the earlier normal exit.
# Without a stop pin and a remembered writer record the owner must still supply the release.
function New-PhoneResumeReleaseFromStop {
    param($Record)
    $stopPin=$Record.stopReceipt
    if(-not $stopPin -or $stopPin.sha256 -notmatch '^[a-f0-9]{64}$' -or -not [IO.Path]::IsPathRooted($stopPin.path) -or -not [IO.Path]::IsPathRooted([string]$Record.writerRecordPath)){return $false}
    $bytes=Read-PhonePinnedArtifact $stopPin.path;$sha=[Security.Cryptography.SHA256]::Create()
    try{$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    if($hash -cne $stopPin.sha256){throw '정지 영수증이 바뀌었습니다.'}
    $stop=ConvertFrom-PhoneJson ([Text.Encoding]::UTF8.GetString($bytes))
    if($stop.schemaVersion -ne 1 -or $stop.kind -cne 'codex-checkpoint-stop' -or $stop.threadId -cne $Record.threadId -or $stop.normalExit -ne $true -or
       $stop.activeCount -ne 0 -or $stop.unknownCount -ne 0 -or $stop.pid -isnot [ValueType] -or $stop.pid -le 0 -or
       $stop.rolloutLength -isnot [ValueType] -or $stop.rolloutLastWriteMs -isnot [ValueType]){throw '정상 종료·대화 idle 정지 영수증이 아닙니다.'}
    $file=Get-Item -LiteralPath $Record.rollout
    if($file.Length -ne $stop.rolloutLength -or ([DateTimeOffset]$file.LastWriteTimeUtc).ToUnixTimeMilliseconds() -ne [long]$stop.rolloutLastWriteMs){throw '정지 이후 대화가 바뀌었습니다.'}
    # Re-read only this conversation's OCX fence rows; other conversations' UNKNOWN rows do not gate it.
    $stateRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
    $registry=ConvertFrom-PhoneJson ([IO.File]::ReadAllText((Join-Path $stateRoot 'runtime\ocx-local\current.json')))
    $ocxHome=Join-Path $stateRoot 'runtime\ocx-local\home'
    if([IO.Path]::GetFullPath([string]$registry.opencodexHome) -ne [IO.Path]::GetFullPath($ocxHome)){throw '등록 OCX home이 다릅니다.'}
    $fence=ConvertFrom-PhoneJson ([Text.Encoding]::UTF8.GetString((Read-PhonePinnedArtifact (Join-Path $ocxHome 'external-request-lifecycle.json'))))
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$key=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$Record.threadId)))).Replace('-','').ToLowerInvariant().Substring(0,32)}finally{$sha.Dispose()}
    $rows=@($fence.rows|Where-Object key -eq $key)
    if($fence.schemaVersion -ne 1 -or $rows.Count){throw '이 대화의 OCX 요청이 진행 중이거나 UNKNOWN입니다. 재개하지 않습니다.'}
    $writerPath=[IO.Path]::GetFullPath([string]$Record.writerRecordPath)
    $wb=Read-PhonePinnedArtifact $writerPath;$sha=[Security.Cryptography.SHA256]::Create()
    try{$wh=([BitConverter]::ToString($sha.ComputeHash($wb))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    $owner=ConvertFrom-PhoneJson ([Text.Encoding]::UTF8.GetString($wb))
    if($owner.owner -cne $Record.threadId -or $owner.writerReleased -ne $true){return $false}
    $known=Get-PhoneKnownContext $Record;$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $release=[ordered]@{schemaVersion=1;kind='aicc-terminal-resume-release';recordId=$Record.id;threadId=$Record.threadId;
        provider=[string]$known.meta.model_provider;model=[string]$known.context.model;effort=$known.context.effort;
        normalExit=$true;writerReleased=$true;activeCount=0;unknownCount=0;stoppedPid=[int]$stop.pid;
        observedAt=$now;expiresAt=$now+55000;rolloutLength=$file.Length;rolloutLastWriteUtc=$file.LastWriteTimeUtc.ToString('o');
        writerRecord=[ordered]@{path=$writerPath;sha256=$wh};stopReceipt=[ordered]@{path=$stopPin.path;sha256=$stopPin.sha256};automaticRetry=$false}
    $directory=Join-Path $script:PhoneRoot 'releases';[void][IO.Directory]::CreateDirectory($directory)
    $target=Join-Path $directory ($Record.id+'-'+$now+'.release.json')
    $out=[Text.UTF8Encoding]::new($false).GetBytes(($release|ConvertTo-Json -Depth 6))
    $fd=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$fd.Write($out,0,$out.Length);$fd.Flush($true)}finally{$fd.Dispose()}
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$releaseSha=([BitConverter]::ToString($sha.ComputeHash($out))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    Register-PhoneResumeRelease -RecordId $Record.id -ReceiptPath $target -ExpectedSha256 $releaseSha
    $true
}
function Register-PhoneResumeRelease {
    param([ValidatePattern('^[a-f0-9]{32}$')][string]$RecordId,[string]$ReceiptPath,
          [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256)
    if(-not [IO.Path]::IsPathRooted($ReceiptPath)){throw '원 소유자의 절대 영수증 경로가 필요합니다.'}
    Invoke-PhoneStore {
        param($state)
        $rows=@($state.items|Where-Object id -eq $RecordId)
        if($rows.Count -ne 1 -or $rows[0].pending){throw '원 항목 또는 불명 열기부터 조정하세요.'}
        $candidate=ConvertFrom-PhoneJson ($rows[0]|ConvertTo-Json -Depth 12)
        $candidate|Add-Member -NotePropertyName resumeRelease -NotePropertyValue ([pscustomobject]@{path=[IO.Path]::GetFullPath($ReceiptPath);sha256=$ExpectedSha256}) -Force
        [void](Assert-PhoneResumeRelease $candidate)
        $rows[0]|Add-Member -NotePropertyName resumeRelease -NotePropertyValue $candidate.resumeRelease -Force
    }
}
function Read-PhoneHistory {ConvertFrom-PhoneJson ([IO.File]::ReadAllText($script:PhoneStore))}
function Format-PhoneText {
    param([string]$Value,[int]$Width=62)
    $Value=$Value -replace '[\x00-\x1f\x7f]',' '
    $result='';$used=0
    foreach($ch in $Value.ToCharArray()){
        $size=if([int]$ch -ge 0x1100){2}else{1}
        if($used+$size -gt $Width){return $result+'…'}
        $result+=$ch;$used+=$size
    }
    $result
}
function Select-PhoneItem {
    param([string]$Heading,[array]$Items)
    if($Items.Count -eq 0){Write-Host '해당 항목이 없습니다.';[void](Read-Host 'Enter: 돌아가기');return -1}
    $selected=0
    while($true){
        $width=60;$pageSize=5
        try {$width=[Math]::Max(24,[Console]::WindowWidth-5);$pageSize=[Math]::Max(2,[Math]::Min(6,[int](([Console]::WindowHeight-8)/4)));[Console]::Clear()}catch{}
        Write-Host $Heading -ForegroundColor Cyan
        Write-Host '↑ ↓ 이동 · Enter 선택 · Esc/0 뒤로'
        Write-Host 'j/k·숫자도 가능 · i: 제목과 정보 전체 보기'
        $start=[int]([Math]::Floor($selected/$pageSize)*$pageSize)
        $end=[Math]::Min($Items.Count,$start+$pageSize)
        for($i=$start;$i -lt $end;$i++){
            $prefix=if($i -eq $selected){'>'}else{' '}
            $color=if($i -eq $selected){'Cyan'}else{'Gray'}
            Write-Host ($prefix+' '+($i-$start+1)+'. '+(Format-PhoneText $Items[$i].label $width)) -ForegroundColor $color
            if($Items[$i].detail){Write-Host ('     '+(Format-PhoneText $Items[$i].detail $width)) -ForegroundColor Gray}
            if($Items[$i].extra){Write-Host ('     '+(Format-PhoneText $Items[$i].extra $width)) -ForegroundColor Gray}
            Write-Host ''
        }
        Write-Host (($selected+1).ToString()+'/'+$Items.Count)
        try {$key=[Console]::ReadKey($true)}catch{
            # SSH/ConPTY may reject ReadKey; empty Enter selects the highlighted item.
            $answer=Read-Host '목록 번호 또는 Enter로 선택 (0: 뒤로)'
            if([string]::IsNullOrEmpty($answer)){return $selected}
            $number=0
            if([int]::TryParse($answer,[ref]$number)){
                if($number -eq 0){return -1}
                if($number -gt 0 -and $number -le ($end-$start)){return ($start+$number-1)}
            }
            continue
        }
        if($key.KeyChar -eq 'i'){
            try{[Console]::Clear()}catch{}
            Write-Host $Items[$selected].label -ForegroundColor Cyan
            Write-Host $Items[$selected].detail
            if($Items[$selected].extra){Write-Host $Items[$selected].extra}
            [void](Read-Host 'Enter: 목록으로')
            continue
        }
        if($key.Key -eq [ConsoleKey]::Escape -or $key.KeyChar -eq '0'){return -1}
        if($key.Key -eq [ConsoleKey]::UpArrow -or $key.KeyChar -eq 'k'){$selected=($selected+$Items.Count-1)%$Items.Count;continue}
        if($key.Key -eq [ConsoleKey]::DownArrow -or $key.KeyChar -eq 'j'){$selected=($selected+1)%$Items.Count;continue}
        # Some SSH clients deliver CR/LF without ConsoleKey.Enter.
        if($key.Key -eq [ConsoleKey]::Enter -or $key.KeyChar -eq [char]13 -or $key.KeyChar -eq [char]10){return $selected}
        $number=0
        if([int]::TryParse([string]$key.KeyChar,[ref]$number) -and $number -ge 1 -and $number -le ($end-$start)){return ($start+$number-1)}
    }
}
function Connect-PhoneRecord {
    param($Record)
    $live=@(Get-PhoneLive|Where-Object {$_.key -eq $Record.key -and -not $_.dead})
    if($live.Count -ne 1){throw '터미널이 닫혔거나 바뀌었습니다. 목록을 다시 선택하세요.'}
    Invoke-PhoneStore {param($state);($state.items|Where-Object id -eq $Record.id).lastOpened=[DateTimeOffset]::Now.ToString('o')}
    $target=$Record.session+':'+$Record.window+'.'+$Record.pane
    & $script:PhoneMux -L aicc-phone select-window -t ($Record.session+':'+$Record.window)
    if($LASTEXITCODE -ne 0){throw '창 선택 실패: 다시 생성하지 않았습니다.'}
    & $script:PhoneMux -L aicc-phone select-pane -t $target
    if($LASTEXITCODE -ne 0){throw '패널 선택 실패: 다시 생성하지 않았습니다.'}
    if($env:TMUX -or $env:PSMUX){& $script:PhoneMux -L aicc-phone switch-client -t $Record.session}
    else {& $script:PhoneMux -L aicc-phone attach-session -t $Record.session}
    if($LASTEXITCODE -ne 0){throw '연결 결과 불명: 기존 터미널을 보존했습니다.'}
}
function Start-PhoneRecord {
    param($Record,[switch]$Detached,[string]$ExpectedResumeReleaseSha256)
    $selectedBinding=$Record.key+'|'+$Record.threadId
    Update-PhoneHistory
    $matches=@((Read-PhoneHistory).items|Where-Object id -eq $Record.id)
    if($matches.Count -ne 1){throw '정확한 기존 항목이 없습니다.'};$Record=$matches[0]
    if(($Record.key+'|'+$Record.threadId) -cne $selectedBinding){throw '선택 이후 대화 결속이 바뀌었습니다. 새로 고침하세요.'}
    if($ExpectedResumeReleaseSha256 -and (($Record.present -and -not $Record.dead) -or $Record.resumeRelease.sha256 -cne $ExpectedResumeReleaseSha256)){throw '조회한 재개 대상 또는 해제 근거가 바뀌었습니다.'}
    if($Record.present -and -not $Record.dead){return $Record}
    if($Record.pending){throw '이전 열기 결과가 UNKNOWN입니다. 중복 실행하지 않습니다.'}
    if($Record.codex -eq 'UNKNOWN'){throw '종류를 확인하지 못한 터미널입니다.'}
    if($Record.codex -eq 'YES'){
        if(-not $ExpectedResumeReleaseSha256 -and $Record.stopReceipt -and (New-PhoneResumeReleaseFromStop $Record)){$Record=@((Read-PhoneHistory).items|Where-Object id -eq $Record.id)[0]}
        [void](Assert-PhoneResumeRelease $Record)
    }
    if(-not (Test-Path -LiteralPath $Record.cwd -PathType Container)){throw '기존 작업 폴더가 없습니다.'}
    $name='phone-'+$Record.id.Substring(0,12);$attempt=[guid]::NewGuid().ToString('N')
    Invoke-PhoneStore {
        param($state)
        $r=$state.items|Where-Object id -eq $Record.id
        if($ExpectedResumeReleaseSha256 -and (($r.key+'|'+$r.threadId) -cne $selectedBinding -or $r.resumeRelease.sha256 -cne $ExpectedResumeReleaseSha256)){throw '잠금 안에서 재개 대상 또는 해제 근거가 바뀌었습니다.'}
        if($r.pending -or ($r.present -and -not $r.dead)){throw '다른 접속에서 먼저 열었습니다.'}
        $r.pending=[pscustomobject]@{id=$attempt;state='UNKNOWN_UNTIL_OBSERVED';at=[DateTimeOffset]::Now.ToString('o')}
        $r.session=$name;$r.window='0';$r.pane='0';$r.codexPid=0;$r.codexStarted=$null
    }
    $shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $runner=Join-Path $script:PhoneSourceRoot 'Resume-PhoneTerminal.ps1'
    $environmentBefore=$env:AICC_PHONE_TERMINAL_ROOT;$env:AICC_PHONE_TERMINAL_ROOT=$script:PhoneRoot
    $checkedArgs=if($ExpectedResumeReleaseSha256){@('-ExpectedResumeReleaseSha256',$ExpectedResumeReleaseSha256)}else{@()}
    try{& $script:PhoneMux -L aicc-phone new-session -d -s $name -n terminal -c $Record.cwd -- $shell -NoLogo -NoProfile -NoExit -File $runner -RecordId $Record.id -AttemptId $attempt @checkedArgs;$code=$LASTEXITCODE}finally{$env:AICC_PHONE_TERMINAL_ROOT=$environmentBefore}
    if($code -ne 0){throw '열기 결과 UNKNOWN: 자동 재시도하지 않습니다.'}
    Update-PhoneHistory
    (Read-PhoneHistory).items|Where-Object id -eq $Record.id
}
function Open-PhoneRecord {
    param($Record)
    $opened=Start-PhoneRecord $Record
    Connect-PhoneRecord $opened
}
function global:Show-AiccPhoneTerminals {
    while($true){
        $main=@(
            [pscustomobject]@{label='열린 터미널';detail='작업 중인 창과 입력 대기 중인 창 모두 포함'},
            [pscustomobject]@{label='닫힌 터미널 다시 열기';detail='기록된 폴더 또는 정확한 코덱스 대화 재개'},
            [pscustomobject]@{label='PowerShell';detail='일반 명령 입력 · mux로 메뉴 복귀'}
        )
        $category=Select-PhoneItem '폰 터미널' $main
        if($category -lt 0 -or $category -eq 2){return}
        try {
            Update-PhoneHistory
            $snapshot=Get-PhonePickerSnapshot
            $display=@($snapshot.items|Where-Object {if($category -eq 0){$_.opened}else{-not $_.opened}})
            $records=@(foreach($item in $display){(Read-PhoneHistory).items|Where-Object id -eq $item.id})
            $items=@(foreach($r in $display){[pscustomobject]@{label=$r.title;detail=($r.session+' · '+$r.kind+' · '+$r.model+' / '+$r.effort);extra=('마지막 열기 '+$r.lastOpened+' · '+$r.disabledReason)}})
            $heading=if($category -eq 0){'열린 터미널 · 모델 작업 여부 미확인'}else{'최근 대화 · 닫힌 기록'}
            $selection=Select-PhoneItem $heading $items
            if($selection -lt 0){continue}
            Open-PhoneRecord $records[$selection]
            if($env:TMUX -or $env:PSMUX){return}
        }catch{Write-Host $_.Exception.Message -ForegroundColor Yellow;[void](Read-Host 'Enter: 메뉴로')}
    }
}
function global:mux {Show-AiccPhoneTerminals}
function global:Connect-AiccPhoneSession {
    param([string]$SessionName)
    Update-PhoneHistory
    $r=(Read-PhoneHistory).items|Where-Object {$_.session -eq $SessionName -and $_.present -and -not $_.dead}|Select-Object -First 1
    if($r){Connect-PhoneRecord $r}else{Write-Host '실행 중인 대상이 없습니다. mux의 닫힌 목록을 사용하세요.'}
}
function global:g1 {Connect-AiccPhoneSession 'g1-auto'}
function global:g1old {Connect-AiccPhoneSession 'g1-dev'}
