param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$broker = Join-Path $PSScriptRoot '../tools/platform/windows/Invoke-AiccWorkspaceSandbox.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($broker, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Broker parse failed' }
$definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Protect-SandboxSensitivePath' }, $false)
if (-not $definition) { throw 'Sensitive ACL implementation missing' }
. ([ScriptBlock]::Create($definition.Extent.Text))

$root = Join-Path ([IO.Path]::GetTempPath()) ('aicc-sensitive-acl-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$sid = 'S-1-15-2-111-222-333-444-555-666-777'
$identity = [Security.Principal.SecurityIdentifier]::new($sid)
$rootAcl = Get-Acl -LiteralPath $root
$rootAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $root -AclObject $rootAcl
$file = Join-Path $root '.env.fixture'
[IO.File]::WriteAllText($file, 'fixture only')
$fileAcl = Get-Acl -LiteralPath $file
$fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Deny'))
Set-Acl -LiteralPath $file -AclObject $fileAcl
$originalRules = @((Get-Acl -LiteralPath $file).Access | Where-Object { $_.IdentityReference -ne $identity } | ForEach-Object { '{0}|{1}|{2}' -f $_.IdentityReference, $_.AccessControlType, [int]$_.FileSystemRights } | Sort-Object)

Protect-SandboxSensitivePath $file $sid
$protected = Get-Acl -LiteralPath $file
if (-not $protected.AreAccessRulesProtected) { throw 'Sensitive inheritance not disabled' }
if (@($protected.Access | Where-Object { $_.IdentityReference -eq $identity -and $_.AccessControlType -eq 'Allow' }).Count) { throw 'Package allow retained' }
if (-not @($protected.Access | Where-Object { $_.IdentityReference -eq $identity -and $_.AccessControlType -eq 'Deny' }).Count) { throw 'Existing deny lost' }
$otherRules = @($protected.Access | Where-Object { $_.IdentityReference -ne $identity } | ForEach-Object { '{0}|{1}|{2}' -f $_.IdentityReference, $_.AccessControlType, [int]$_.FileSystemRights } | Sort-Object)
if (Compare-Object $originalRules $otherRules) { throw 'Other trustee rights changed' }
if ([IO.File]::ReadAllText($file) -cne 'fixture only') { throw 'Owner access changed' }
$firstSddl = $protected.Sddl
Protect-SandboxSensitivePath $file $sid
if ((Get-Acl -LiteralPath $file).Sddl -cne $firstSddl) { throw 'Repeated protection changed ACL' }

$directory = Join-Path $root 'credentials'
$nested = Join-Path $directory 'nested'
[IO.Directory]::CreateDirectory($nested) | Out-Null
$nestedFile = Join-Path $nested 'fixture.txt'
[IO.File]::WriteAllText($nestedFile, 'fixture only')
$explicit = Get-Acl -LiteralPath $nestedFile
$explicit.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'Read', 'Allow'))
Set-Acl -LiteralPath $nestedFile -AclObject $explicit
Protect-SandboxSensitivePath $directory $sid
foreach ($entry in @($directory, $nested, $nestedFile)) {
  $result = Get-Acl -LiteralPath $entry
  if (-not $result.AreAccessRulesProtected -or @($result.Access | Where-Object { $_.IdentityReference -eq $identity -and $_.AccessControlType -eq 'Allow' }).Count) { throw 'Nested package grant retained' }
}

$broad = Join-Path $root '.env.broad'
[IO.File]::WriteAllText($broad, 'fixture only')
$broadAcl = Get-Acl -LiteralPath $broad
$broadAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-15-2-1'), 'Read', 'Allow'))
Set-Acl -LiteralPath $broad -AclObject $broadAcl
$broadBefore = (Get-Acl -LiteralPath $broad).Sddl
$refused = $false
try { Protect-SandboxSensitivePath $broad $sid } catch { if ($_.Exception.Message -notlike 'Ambiguous AppContainer*') { throw }; $refused = $true }
if (-not $refused -or (Get-Acl -LiteralPath $broad).Sddl -cne $broadBefore) { throw 'Broad grant was not refused without mutation' }
[ordered]@{ status = 'PASS'; checks = @('inherited_allow_removed', 'deny_preserved', 'other_trustees_preserved', 'owner_read_preserved', 'idempotent', 'nested_explicit_allow_removed', 'broad_grant_refused_without_mutation'); fixture = $root } | ConvertTo-Json -Compress
