[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StateRoot,
    [Parameter(Mandatory)][version]$CurrentVersion
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($StateRoot)
if (-not [IO.Path]::IsPathFullyQualified($StateRoot) -or (Split-Path $root -Leaf) -ne 'codex-desktop-update') { throw 'Exact state root required' }
$statusPath = Join-Path $root 'status.json'
function Save-Status([hashtable]$Value) {
    $temporary = Join-Path $root ('status-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $Value | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding utf8NoBOM
    Move-Item -LiteralPath $temporary -Destination $statusPath -Force
}
Save-Status @{status='waiting_for_app_exit';currentVersion=$CurrentVersion.ToString();updatedAt=(Get-Date).ToUniversalTime().ToString('o')}
while (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }
$winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
if (-not (Test-Path -LiteralPath $winget -PathType Leaf)) { Save-Status @{status='failed';reason='winget_missing';updatedAt=(Get-Date).ToUniversalTime().ToString('o')}; exit 1 }
$arguments = @('install','--id','9PLM9XGG6VKS','--source','msstore','--accept-source-agreements','--accept-package-agreements','--silent','--force')
$process = Start-Process -FilePath $winget -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
$package = Get-AppxPackage -Name OpenAI.Codex
$installed = if ($package) { [version]$package.Version } else { [version]'0.0.0.0' }
if ($process.ExitCode -ne 0 -or $installed -lt $CurrentVersion) {
    Save-Status @{status='failed';reason='store_install_failed';exitCode=$process.ExitCode;installedVersion=$installed.ToString();updatedAt=(Get-Date).ToUniversalTime().ToString('o')}
    exit 1
}
Save-Status @{status='completed';installedVersion=$installed.ToString();updatedAt=(Get-Date).ToUniversalTime().ToString('o')}
Start-Process -FilePath explorer.exe -ArgumentList 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'
