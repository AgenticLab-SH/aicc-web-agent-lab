#requires -Version 7.0
$ErrorActionPreference = 'Stop'
if(-not $IsWindows){throw 'Use npm run check:lab and npm test on other platforms.'}
Push-Location (Split-Path -Parent $PSScriptRoot)
try{
  & npm.cmd run check:lab
  if($LASTEXITCODE){throw 'Lab syntax checks failed.'}
  & npm.cmd test
  if($LASTEXITCODE){throw 'Lab tests failed.'}
  & ./components/android-client/Test-ApkPublication.ps1
}finally{Pop-Location}
