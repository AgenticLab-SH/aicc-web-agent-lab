#requires -Version 7.5
# Metadata-only fake; does not inspect real current, process or model.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../windows/CodexContinuityGroupInstall.ps1')
. (Join-Path $PSScriptRoot '../windows/CodexContinuityGroupOwner.ps1')
$passed=0
function Pass([string]$name){$script:passed++;Write-Output ('PASS '+$script:passed+' '+$name)}
function Refuse([string]$name,[scriptblock]$work,[string]$reason){
 $errorText=$null;try{& $work}catch{$errorText=$_.Exception.Message}
 if(-not $errorText -or $errorText -notlike ('*'+$reason+'*')){throw ('missing_refusal:'+ $name +':'+$errorText)}
 Pass $name
}
$scratch=Join-Path $PSScriptRoot ('g1-managed-release-fake-'+[guid]::NewGuid().ToString('N'))
$standalone=Join-Path $scratch 'standalone'
$leaf='0.166.0-x86_64-pc-windows-msvc'
$bin=Join-Path $standalone ('releases/'+$leaf+'/bin')
try{
 New-Item -ItemType Directory -Path $bin -Force|Out-Null
 [IO.File]::WriteAllText((Join-Path $bin 'codex.exe'),'FAKE_NOT_OFFICIAL',[Text.UTF8Encoding]::new($false))
 $target='releases/'+$leaf
 function FakeJunction($t){
  [pscustomobject]@{
   LinkType='Junction';PSIsContainer=$true
   Attributes=([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)
   FullName=(Join-Path $standalone 'current');Target=$t
  }
 }
 $ok=FakeJunction $target
 $expected=[IO.Path]::GetFullPath((Join-Path $standalone $target))
 foreach($entry in @('GroupInstall-ManagedReleasePath','GroupOwner-ManagedReleasePath')){
  if((& $entry $standalone $ok) -ine $expected){throw ('direct_release_mismatch:'+ $entry)}
  Pass ($entry+' exact relative metadata succeeds without current traversal')
 }
 $slash=FakeJunction ('releases\'+$leaf)
 if((GroupInstall-ManagedReleasePath $standalone $slash) -ine $expected){throw 'windows_path_separator_failure'}
 Pass 'one relative Windows separator accepted'
 $array=FakeJunction @($target)
 if((GroupOwner-ManagedReleasePath $standalone $array) -ine $expected){throw 'single_target_array_failure'}
 Pass 'single array element accepted'
 $absolute=FakeJunction $expected
 foreach($entry in @('GroupInstall-ManagedReleasePath','GroupOwner-ManagedReleasePath')){
  if((& $entry $standalone $absolute) -ine $expected){throw 'exact_absolute_junction_target_failure'}
  Pass ($entry+' exact managed absolute Junction.Target accepted')
 }
 $bad=@(
  @{name='missing';value=''},
  @{name='absolute';value=('C:\foreign\releases\'+$leaf)},
  @{name='traversal';value=('..\releases\'+$leaf)},
  @{name='nested child';value=('releases\nested\'+$leaf)},
  @{name='dot segment';value=('releases\..\'+$leaf)},
  @{name='extra segment';value=('releases\'+$leaf+'\.')},
  @{name='foreign platform';value='releases/0.166.0-x86_64-unknown'},
  @{name='network';value=('\\server\share\'+$leaf)},
  @{name='multiple';value=@($target,'releases/0.167.0-x86_64-pc-windows-msvc')}
 )
 foreach($case in $bad){
  $j=FakeJunction $case.value
  Refuse ('preview '+$case.name) {GroupInstall-ManagedReleasePath $standalone $j} 'recovered_cli_release_target_unsafe'
  Refuse ('runtime '+$case.name) {GroupOwner-ManagedReleasePath $standalone $j} 'recovered_cli_release_target_unsafe'
 }
 $badCurrent=FakeJunction $target;$badCurrent.LinkType='SymbolicLink'
 Refuse 'non-junction current rejected' {GroupInstall-ManagedReleasePath $standalone $badCurrent} 'recovered_cli_managed_current_required'
 $badCurrent=FakeJunction $target;$badCurrent.FullName=(Join-Path $standalone 'other')
 Refuse 'foreign current rejected' {GroupOwner-ManagedReleasePath $standalone $badCurrent} 'recovered_cli_managed_current_required'
 $badCurrent=FakeJunction $target;$badCurrent.Attributes=[IO.FileAttributes]::Directory
 Refuse 'nonreparse current rejected' {GroupInstall-ManagedReleasePath $standalone $badCurrent} 'recovered_cli_managed_current_required'
 function Invoke-FakeReparse([string]$resolver){
  # A scoped fake Get-Item simulates a linked direct exe without creating
  # a junction or changing any Windows mount/security policy.
  function Get-Item {
   param([string]$LiteralPath,[string]$ErrorAction)
   if($LiteralPath -ieq (Join-Path $bin 'codex.exe')){
    return [pscustomobject]@{
     Attributes=([IO.FileAttributes]::Archive -bor [IO.FileAttributes]::ReparsePoint)
     LinkType='SymbolicLink';PSIsContainer=$false
    }
   }
   Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -ErrorAction Stop
  }
  & $resolver $standalone $ok
 }
 Refuse 'preview direct exe reparse rejected' {Invoke-FakeReparse 'GroupInstall-ManagedReleasePath'} 'recovered_cli_direct_release_reparse_forbidden'
 Refuse 'runtime direct exe reparse rejected' {Invoke-FakeReparse 'GroupOwner-ManagedReleasePath'} 'recovered_cli_direct_release_reparse_forbidden'
 # The synthetic positive case is never a replacement for Authenticode,
 # current anchor bytes, exact process/argv or Task/registry CAS.
 Write-Output ('G1_MANAGED_RELEASE_FAKE_PASS='+$passed)
}finally{
 if(Test-Path -LiteralPath $scratch){Remove-Item -LiteralPath $scratch -Recurse -Force}
}
