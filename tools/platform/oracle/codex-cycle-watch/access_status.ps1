[CmdletBinding()]
param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference = 'Stop'
function Resolve-OpenSshTool([string]$Name) {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git) {
        $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
        $candidate = Join-Path $gitRoot "usr\bin\$Name.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $fallback = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
    if ($fallback) { return $fallback.Source }
    throw "$Name executable not found."
}
$resolvedRoot = [IO.Path]::GetFullPath($Root)
if (-not [IO.Path]::IsPathFullyQualified($Root) -or (Split-Path $resolvedRoot -Leaf) -ne 'oracle-a1-access') { throw 'Exact access root required' }
$contractPath = Join-Path $resolvedRoot 'connection.json'
if ((Get-Item -LiteralPath $contractPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Link refused' }
$contract = Get-Content -Raw -LiteralPath $contractPath | ConvertFrom-Json
if ($contract.version -ne 1 -or $contract.target -ne 'a1' -or $contract.user -notmatch '^[a-z_][a-z0-9_-]*$' -or $contract.host -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'Invalid contract' }
& (Join-Path $PSScriptRoot 'access_key.ps1') -Action status -Target a1 -Root $resolvedRoot | Out-Null
$knownHosts = Join-Path $resolvedRoot 'known_hosts'
if ((Get-FileHash -LiteralPath $knownHosts -Algorithm SHA256).Hash -ne $contract.knownHostsSha256) { throw 'Pinned host identity changed' }
$sshArgs = @('-F','none','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$knownHosts",'-o','HostKeyAlias=aicc-oracle-a1','-o','ConnectTimeout=15','-i',(Join-Path $resolvedRoot 'id_rsa'),"$($contract.user)@$($contract.host)")
$ssh = Resolve-OpenSshTool 'ssh'
& $ssh @sshArgs 'id -un; hostname; uptime; systemctl --no-pager --plain list-units --type=service --state=running; systemctl --no-pager --plain list-timers aicc-ocx-cycle-watch.timer; if test -f "$HOME/.local/share/aicc-ocx-cycle-watch/hub_cycle_watch.py"; then python3 -B "$HOME/.local/share/aicc-ocx-cycle-watch/hub_cycle_watch.py" status --root "$HOME/.local/state/aicc-ocx-cycle-watch"; fi'
if ($LASTEXITCODE -ne 0) { throw 'SSH status failed' }
