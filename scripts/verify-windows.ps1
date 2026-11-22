[CmdletBinding()]
param(
  [switch]$DryRun,
  [ValidateRange(1,8)][int]$TestConcurrency=2
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows) {
  throw 'verify:windows can only run on Windows.'
}

$env:PYTHONDONTWRITEBYTECODE = '1'
$package=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw|ConvertFrom-Json
if($package.scripts.test -notmatch '^node --test(?: test/[A-Za-z0-9.-]+\.mjs)+$'){throw 'Reviewed explicit Node test list required.'}
$testFiles=@($package.scripts.test.Split(' ')|Select-Object -Skip 2)

$steps = @(
  @{ File = 'pwsh'; Arguments = @('-NoProfile', '-File', 'tools/platform/test/Test-AiccCodexContinuityQueueRecovery.ps1') },
  @{ File = 'node'; Arguments = @('--check', 'tools/platform/web-automation/edit-aicc-extension-registry.mjs') },
  @{ File = 'node'; Arguments = @('--check', 'tools/platform/web-automation/manage-aicc-chrome-extensions.mjs') },
  @{ File = 'node'; Arguments = @('--check', 'tools/platform/web-automation/verify-aicc-extension-registry-sources.mjs') },
  @{ File = 'node'; Arguments = @('--test', 'test/extension-registry-editor.test.mjs', 'test/extension-postcondition.test.mjs') },
  @{ File = 'node'; Arguments = @('--check', 'src/web-gpt-maintenance-validator.mjs') },
  @{ File = 'node'; Arguments = @('--test', 'test/web-gpt-maintenance-validator.test.mjs') },
  @{ File = 'npm.cmd'; Arguments = @('run', 'check') },
  @{ File = 'npm.cmd'; Arguments = @('run', 'test:user-actions') },
  @{ File = 'npm.cmd'; Arguments = @('run', 'check:assets') },
  @{ File = 'npm.cmd'; Arguments = @('run','pretest') },
  @{ File = 'node'; Arguments = @('--test',"--test-concurrency=$TestConcurrency")+$testFiles },
  @{ File = 'npm.cmd'; Arguments = @('run', 'test:app-server-daemon') },
  @{ File = 'npm.cmd'; Arguments = @('run', 'smoke') },
  @{ File = 'npm.cmd'; Arguments = @('run', 'test:account-manager') },
  @{ File = 'npm.cmd'; Arguments = @('run', 'test:workspace-mcp') },
  @{ File = 'npm.cmd'; Arguments = @('run', 'test:guidance') },
  @{ File = 'npm.cmd'; Arguments = @('run', 'test:browser') },
  @{ File = 'python'; Arguments = @('-m', 'unittest', 'discover', '-s', 'tools/platform/test', '-p', 'test_project_portfolio.py', '-v') },
  @{ File = 'python'; Arguments = @('-m', 'unittest', 'discover', '-s', 'tools/platform/oracle/upstream-watch/tests', '-p', 'test_*.py', '-v') },
  @{ File = 'python'; Arguments = @('-B', '-m', 'unittest', 'discover', '-s', 'tools/platform/oracle/codex-cycle-watch/tests', '-p', 'test_*.py', '-v') },
  @{ File = 'pwsh'; Arguments = @('-NoProfile', '-File', 'tools/platform/oracle/codex-cycle-watch/tests/test_access_key.ps1') },
  @{ File = 'git'; Arguments = @('diff', '--check') }
)

if ($DryRun) {
  foreach ($step in $steps) {
    $rendered = @($step.File) + @($step.Arguments)
    Write-Output ($rendered -join ' ')
  }
  Write-Output 'gitleaks dir . --redact --no-banner (optional when installed)'
  Write-Output 'Windows verification plan passed.'
  return
}

foreach ($step in $steps) {
  & $step.File @($step.Arguments)
  if ($LASTEXITCODE -ne 0) {
    throw "Verification command failed with exit code ${LASTEXITCODE}: $($step.File)"
  }
}

$gitleaks = Get-Command gitleaks -ErrorAction SilentlyContinue
if ($gitleaks) {
  & $gitleaks.Source dir . --redact --no-banner
  if ($LASTEXITCODE -ne 0) {
    throw "gitleaks failed with exit code $LASTEXITCODE"
  }
} else {
  Write-Warning 'gitleaks is unavailable; secret scanning was skipped.'
}

Write-Output 'Windows verification passed.'
