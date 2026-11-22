#requires -Version 7.5
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$InvocationFile,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$InvocationSha256
)
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false,$true)
[Console]::InputEncoding=$utf8
[Console]::OutputEncoding=$utf8
$OutputEncoding=$utf8
$invocationPath=(Resolve-Path -LiteralPath $InvocationFile).ProviderPath
$invocationBytes=[IO.File]::ReadAllBytes($invocationPath)
if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($invocationBytes)).ToLowerInvariant() -cne $InvocationSha256){throw 'Invocation changed before process creation'}
$invocation=$utf8.GetString($invocationBytes)|ConvertFrom-Json
if($invocation.schemaVersion -ne 1 -or -not [IO.Path]::IsPathFullyQualified($invocation.executable) -or -not [IO.Path]::IsPathFullyQualified($invocation.cwd)){throw 'Owner invocation required'}
if((Get-FileHash -LiteralPath $invocation.processJob -Algorithm SHA256).Hash.ToLowerInvariant() -cne $invocation.processJobSha256){throw 'Process lifetime boundary changed'}
. $invocation.processJob
# Existing Windows Job Object terminates every descendant when this host exits.
$startInfo=[Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName=$invocation.executable
$startInfo.WorkingDirectory=$invocation.cwd
$startInfo.UseShellExecute=$false
$startInfo.CreateNoWindow=$true
$startInfo.RedirectStandardInput=$true
$startInfo.RedirectStandardOutput=$true
$startInfo.RedirectStandardError=$true
$startInfo.StandardInputEncoding=$utf8
foreach($argument in $invocation.args){$startInfo.ArgumentList.Add([string]$argument)}
$process=[Diagnostics.Process]::new()
$process.StartInfo=$startInfo
try {
 if(-not $process.Start()){throw 'Codex process creation failed'}
 $outCopy=$process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
 $errCopy=$process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
 $inCopy=[Console]::OpenStandardInput().CopyToAsync($process.StandardInput.BaseStream)
 [void]$inCopy.GetAwaiter().GetResult()
 $process.StandardInput.Close()
 $process.WaitForExit()
 [void]$outCopy.GetAwaiter().GetResult()
 [void]$errCopy.GetAwaiter().GetResult()
 $exitCode=$process.ExitCode
} finally {$process.Dispose()}
exit $exitCode
