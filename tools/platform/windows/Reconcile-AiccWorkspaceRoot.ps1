#requires -Version 7.5
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PlanFile,
  [ValidateSet('Prepare','Status','Apply')][string]$Mode='Status',
  [string]$ExpectedPlanSha256,
  [string]$RescueReadyFile,
  [string]$TaskProfileHistoryPlan,
  [string]$TaskProfileHistoryReceipt,
  [switch]$RequireActionLock
)
$ErrorActionPreference='Stop'
$stateRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ai-control-center'
$runtimeRoot=Join-Path $stateRoot 'runtime'
$configFile=Join-Path $stateRoot 'workspace-mcp\config.json'
$profileFile=Join-Path $stateRoot 'workspace-mcp\tunnel\profiles\aicc-workspace.yaml'
$registryFile=Join-Path $runtimeRoot 'components.json'
$launcherFile=Join-Path $stateRoot 'workspace-mcp\runtime\aicc-workspace.hidden.ps1'
$taskName='AgenticLab-AICC-Workspace-Tunnel'
$taskReceipt=Join-Path $stateRoot ('backups\workspace-tunnel-windows-task\'+$taskName+'.install.json')
. (Join-Path $PSScriptRoot '..\workspace-mcp\Stop-WorkspaceOwnedRuntime.ps1')
function Assert-Regular([string]$File){
  $full=[IO.Path]::GetFullPath($File)
  $item=Get-Item -LiteralPath $full -Force
  if($item.PSIsContainer -or $item.LinkType){throw 'Regular non-linked file required'}
  for($parent=$item.Directory;$parent;$parent=$parent.Parent){if($parent.LinkType){throw 'Linked ancestor refused'}}
  return $full
}
function Hash-File([string]$File){(Get-FileHash -LiteralPath (Assert-Regular $File) -Algorithm SHA256).Hash.ToLowerInvariant()}
function Hash-Text([string]$Text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()}
function Json($Value){ConvertTo-Json -InputObject $Value -Depth 60 -Compress}
# Keep ISO timestamps as protocol strings. DateTime -> string -> Parse loses UTC
# offset and milliseconds, falsely expiring plans and changing mailbox bindings.
function Read-Json([string]$File){Get-Content -LiteralPath (Assert-Regular $File) -Raw | ConvertFrom-Json -AsHashtable -DateKind String}
function Write-New([string]$File,[string]$Text){
  $stream=[IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$bytes=[Text.Encoding]::UTF8.GetBytes($Text);$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Set-Atomic([string]$File,[string]$Text){
  $null=Assert-Regular $File
  $temp=$File+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  Write-New $temp $Text
  Move-Item -LiteralPath $temp -Destination $File -Force
}
function Same($A,$B){(Json $A) -ceq (Json $B)}
function Same-Structure($A,$B){
  if($null -eq $A -or $null -eq $B){return ($null -eq $A -and $null -eq $B)}
  if($A -is [Collections.IDictionary] -and $B -is [Collections.IDictionary]){
    if($A.Count -ne $B.Count){return $false}
    foreach($key in $A.Keys){if(-not $B.Contains($key) -or -not (Same-Structure $A[$key] $B[$key])){return $false}}
    return $true
  }
  if($A -is [array] -and $B -is [array]){
    if($A.Count -ne $B.Count){return $false}
    for($i=0;$i -lt $A.Count;$i++){if(-not (Same-Structure $A[$i] $B[$i])){return $false}}
    return $true
  }
  $aType=[int][Type]::GetTypeCode($A.GetType());$bType=[int][Type]::GetTypeCode($B.GetType())
  if($aType -ge 5 -and $aType -le 15 -and $bType -ge 5 -and $bType -le 15){return ([decimal]$A -eq [decimal]$B)}
  return (Same $A $B)
}
function Require-Owned([string]$File,[string]$Parent){
  $full=Assert-Regular $File
  if(-not $full.StartsWith([IO.Path]::GetFullPath($Parent).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Owner-local exact path required'}
  return $full
}
function Prepare-TaskReceipt($Registry,[string]$OperationId){
  $receipt=Read-Json $taskReceipt
  $launcher=Join-Path $stateRoot 'workspace-mcp\runtime\aicc-workspace.hidden.ps1'
  $binary=Join-Path $stateRoot 'workspace-mcp\bin\tunnel-client.exe'
  if($receipt.schemaVersion -ne 2 -or $receipt.status -cne 'installed' -or $receipt.taskName -cne $taskName -or $receipt.surfaceProfile -cne 'business-full' -or $receipt.runtimeAlias -cne 'aicc-workspace' -or $receipt.profile -ine $profileFile -or $receipt.launcher -ine $launcher -or $receipt.binary -ine $binary -or $receipt.root -ine (Join-Path $stateRoot 'workspace-mcp')){throw 'Exact installed task identity required'}
  foreach($pair in @(@($binary,$receipt.binarySha256),@($Registry.components.workspace.runtime,$receipt.nodeSha256),@($receipt.wscript,$receipt.hostSha256),@($Registry.components.'workspace-host'.entry,$receipt.helperSha256))){if((Hash-File $pair[0]) -cne $pair[1]){throw 'Unchanged task executable contract differs'}}
  $provenance=@()
  if($receipt.profileSha256 -cne (Hash-File $profileFile) -or $receipt.launcherSha256 -cne (Hash-File $launcher)){
    if(-not $TaskProfileHistoryPlan -or -not $TaskProfileHistoryReceipt){throw 'Stale task receipt requires the exact relocation plan and completion receipt'}
    $historyPlan=Require-Owned $TaskProfileHistoryPlan $runtimeRoot
    $historyReceipt=Require-Owned $TaskProfileHistoryReceipt (Join-Path $stateRoot 'receipts')
    $prior=Read-Json $historyPlan;$completion=Read-Json $historyReceipt
    if($prior.schemaVersion -ne 1 -or $prior.profile -ine $profileFile -or $prior.profileAfterHash -cne (Hash-File $profileFile) -or $completion.schemaVersion -ne 1 -or $completion.terminal -cne 'PASS_RELOCATED_WORKSPACE' -or $completion.ownerConfigUnchanged -cne $true -or $completion.nativePidPreserved -cne $true){throw 'Completed relocation does not explain current profile'}
    foreach($pair in @(@('backend','workspace'),@('gateway','unified-mcp'),@('host','workspace-host'))){if($prior[$pair[0]] -ine $completion[$pair[0]] -or $completion[$pair[0]] -ine $Registry.components[$pair[1]].releaseRoot){throw 'Relocation and registered component differ'}}
    $backup=[IO.Path]::GetFullPath($completion.recovery)
    if(-not $backup.StartsWith((Join-Path $stateRoot 'backups\runtime-layout\workspace-'),[StringComparison]::OrdinalIgnoreCase)){throw 'Owned relocation backup required'}
    $beforeLauncher=Require-Owned (Join-Path $backup 'launcher.before.ps1') $backup
    $beforeRegistry=Require-Owned (Join-Path $backup 'components.before.json') $backup
    $beforeTask=Require-Owned (Join-Path $backup 'task.before.xml') $backup
    $oldRegistry=Read-Json $beforeRegistry
    $oldHelper=$oldRegistry.components.'workspace-host'.entry
    $beforeText=[IO.File]::ReadAllText($beforeLauncher)
    if(-not $oldHelper -or $beforeText.Split($oldHelper,[StringSplitOptions]::None).Count -ne 2 -or $prior.helperEntry -ine $Registry.components.'workspace-host'.entry -or $beforeText.Replace($oldHelper,$prior.helperEntry) -cne [IO.File]::ReadAllText($launcher)){throw 'Launcher differs from the exact relocation transform'}
    [xml]$savedTask=[IO.File]::ReadAllText($beforeTask)
    [xml]$liveTask=Export-ScheduledTask -TaskName $taskName
    foreach($section in @('Actions','Principals')){if($savedTask.Task.$section.OuterXml -cne $liveTask.Task.$section.OuterXml){throw 'Task execution or principal changed since relocation'}}
    if($savedTask.Task.RegistrationInfo.Description -cne $liveTask.Task.RegistrationInfo.Description){throw 'Task description changed since relocation'}
    foreach($file in @($historyPlan,$historyReceipt,$beforeLauncher,$beforeRegistry,$beforeTask)){$provenance+=@{file=$file;sha256=(Hash-File $file)}}
    $receipt.launcherSha256=Hash-File $launcher
    $receipt.reconciledByOperation=$OperationId
    $receipt.reconciliationProvenance=$provenance
  }
  return @{receipt=$receipt;provenance=$provenance}
}
function Get-RegisteredDrain($Ownership,$ExpectedSelection=$null){
  try{
    $registered=Read-Json $registryFile;$component=$registered.components.'unified-mcp'
    $root=Join-Path $runtimeRoot 'unified-mcp-maintenance'
    if($registered.root -ine $stateRoot -or -not $component.releaseRoot.StartsWith((Join-Path $stateRoot 'releases\unified-mcp\'),[StringComparison]::OrdinalIgnoreCase) -or $component.entry -ine (Join-Path $component.releaseRoot 'gateway.cjs') -or (Hash-File $component.entry) -cne $component.entryHash){throw 'Registered gateway generation differs'}
    $gatewayConfigPath=Join-Path $component.releaseRoot 'config.json';$configSha=Hash-File $gatewayConfigPath
    $marker=Read-Json (Join-Path $stateRoot 'workspace-mcp\runtime\remote-authority-status.json')
    $gatewayPid=[int]$marker.supervisor.pid
    $owned=@($Ownership.processes|Where-Object pid -eq $gatewayPid)
    if($owned.Count -ne 1 -or $gatewayPid -eq $Ownership.tunnelPid){throw 'Owned shared gateway supervisor missing'}
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$gatewayPid)
    if(-not $process -or $process.CreationDate.ToUniversalTime().Ticks.ToString() -cne $owned[0].created -or $process.ExecutablePath -ine $component.runtime -or (Hash-Text ([string]$process.CommandLine)) -cne $owned[0].commandHash){throw 'Owned gateway process changed'}
    $command=([string]$process.CommandLine).Replace('/','\')
    if(-not $command.Contains($component.entry) -or -not $command.Contains($gatewayConfigPath)){throw 'Gateway command/config differs'}
    $rootItem=Get-Item -LiteralPath $root -Force
    if(-not $rootItem.PSIsContainer -or $rootItem.LinkType -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Shared admission/drain identity unavailable'}
    $selections=@()
    foreach($directory in @(Get-ChildItem -LiteralPath $root -Directory -Filter ($gatewayPid.ToString()+'-*'))){
      if($directory.LinkType -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked maintenance directory refused'}
      if($directory.Name -notmatch '^\d+-[a-f0-9-]{36}$'){continue}
      $identityFile=Join-Path $directory.FullName 'identity.json';$identity=Read-Json $identityFile
      if($identity.schemaVersion -ne 1 -or $identity.kind -cne 'aicc-unified-maintenance' -or $identity.gateway.pid -ne $gatewayPid -or $identity.configSha256 -cne $configSha -or [IO.Path]::GetFullPath($identity.configPath) -ine $gatewayConfigPath -or [IO.Path]::GetFullPath($identity.instanceDirectory) -ine $directory.FullName){continue}
      if($identity.requestDirectory -ine (Join-Path $directory.FullName 'requests') -or $identity.responseDirectory -ine (Join-Path $directory.FullName 'responses') -or $identity.gateway.instanceId -notmatch '^[a-f0-9-]{36}$'){throw 'Maintenance mailbox identity differs'}
      if([Math]::Abs(([DateTimeOffset]::Parse($identity.gateway.startedAt).UtcDateTime-$process.CreationDate.ToUniversalTime()).TotalSeconds) -gt 5){continue}
      $state=Read-Json (Join-Path $directory.FullName 'state.json')
      if($state.schemaVersion -ne 1 -or -not (Same $state.identity.gateway $identity.gateway) -or $state.identity.configSha256 -cne $configSha -or -not $state.providers.ContainsKey('workspace') -or -not $state.providers.ContainsKey('native')){throw 'Maintenance state identity differs'}
      $client=Assert-Regular (Join-Path $PSScriptRoot 'Invoke-AiccUnifiedMaintenance.ps1')
      $selection=@{instanceDirectory=$directory.FullName;identityFile=$identityFile;identitySha256=(Hash-File $identityFile);gateway=$identity.gateway;gatewayPid=$gatewayPid;gatewayCreatedTicks=$process.CreationDate.ToUniversalTime().Ticks.ToString();gatewayCommandSha256=(Hash-Text ([string]$process.CommandLine));gatewayImageSha256=(Hash-File $process.ExecutablePath);configSha256=$configSha;client=$client;clientSha256=(Hash-File $client)}
      $selections+=@{selection=$selection;state=$state}
    }
    if($selections.Count -ne 1){throw 'One exact live drain-capable gateway identity required'}
    if($ExpectedSelection -and -not (Same-Structure $selections[0].selection $ExpectedSelection)){throw 'Selected maintenance generation changed'}
    return @{supported=$true;reason='exact_registered_shared_gateway';selection=$selections[0].selection;state=$selections[0].state}
  }catch{return @{supported=$false;reason=$_.Exception.Message;selection=$null}}
}
function Read-WorkspaceLeases($Plan){
  # Redirected PowerShell can inherit CP949. Decode this UTF-8 protocol locally,
  # without changing the console encoding or exposing publication text.
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$Plan.node;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false,$true)
  $start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false,$true)
  foreach($argument in @((Join-Path $Plan.backend 'bin\aicc'),'workspace','status','--json')){$start.ArgumentList.Add($argument)}
  $child=[Diagnostics.Process]::new();$child.StartInfo=$start
  try{
    if(-not $child.Start()){throw 'Workspace lease inspection child not started'}
    $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
    if(-not $child.WaitForExit(30000)){
      # This object owns only the read-only inspection child, never the runtime.
      try{$child.Kill();$null=$child.WaitForExit(5000)}catch{}
      throw 'Workspace lease inspection timed out; read result unconfirmed'
    }
    $exit=$child.ExitCode
    $raw=$stdout.GetAwaiter().GetResult();$null=$stderr.GetAwaiter().GetResult()
    if($exit -ne 0){throw 'Workspace lease inspection unavailable'}
    $workspace=$raw|ConvertFrom-Json -ErrorAction Stop
  }finally{$child.Dispose()}
  if($workspace.state -cne 'ready' -or $workspace.serverReady -cne $true -or $workspace.remoteAuthority.activeLeases -cne 0){throw 'Target Workspace not ready or leases active/unknown'}
}
function Save-Transaction{
  if($script:transaction -and (Test-Path -LiteralPath $plan.resultFile)){Set-Atomic $plan.resultFile (Json $script:transaction)}
}
function Invoke-DrainCommand([string]$Action,$Selection,$Binding,[string]$ReadySnapshot){
  if((Hash-File $Selection.identityFile) -cne $Selection.identitySha256 -or (Hash-File $Selection.client) -cne $Selection.clientSha256){throw 'Bound maintenance identity or client changed'}
  $arguments=@{Action=$Action;InstanceDirectory=$Selection.instanceDirectory;OperationId=$Binding.operationId;Nonce=$Binding.nonce;OperationExpiresAt=$Binding.operationExpiresAt;ExpectedGatewayPid=$Selection.gatewayPid;ExpectedGatewayCreatedTicks=$Selection.gatewayCreatedTicks;ExpectedGatewayCommandSha256=$Selection.gatewayCommandSha256;ExpectedGatewayImageSha256=$Selection.gatewayImageSha256;ExpectedConfigSha256=$Selection.configSha256;TimeoutSeconds=10}
  if($ReadySnapshot){$arguments.ReadySnapshotSha256=$ReadySnapshot}
  $hostImage=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $event=@{action=$Action;operationId=$Binding.operationId;instanceDirectory=$Selection.instanceDirectory;startedAt=[DateTimeOffset]::UtcNow.ToString('o');outcome='DISPATCH_INTENT'}
  $script:transaction.maintenanceEvents+=@($event);Save-Transaction
  try{
    $output=& $hostImage -NoProfile -NonInteractive -File $Selection.client @arguments
    $exit=$LASTEXITCODE
    try{$reply=($output -join "`n")|ConvertFrom-Json -AsHashtable}catch{throw 'Maintenance client response unavailable; reconcile exact mailbox before any replay'}
    $event.receipt=$reply;$event.clientExit=$exit;$event.completedAt=[DateTimeOffset]::UtcNow.ToString('o')
    if($exit -ne 0 -or $reply.response.ok -cne $true){$event.outcome=if($reply.outcome -ceq 'UNCERTAIN_NO_REPLAY'){'UNCERTAIN_NO_REPLAY'}else{'REJECTED_OR_UNCONFIRMED'};Save-Transaction;throw 'Maintenance mutation/observation not acknowledged; no automatic replay'}
    $event.outcome='ACKNOWLEDGED';Save-Transaction
    return $reply.response
  }catch{$event.outcome=if($event.outcome -ceq 'DISPATCH_INTENT'){'UNCERTAIN_NO_REPLAY'}else{$event.outcome};$script:transaction.reconciliationRequired=$true;Save-Transaction;throw}
}
function Assert-DrainSnapshot($Status){
  if($Status.closed -cne $true -or $Status.initialized -cne $true -or $Status.phase -cne 'DRAINING' -or $Status.fault -or $Status.expired -ceq $true -or $Status.ready -cne $true -or $Status.readySnapshotSha256 -notmatch '^[a-f0-9]{64}$'){throw 'Shared gateway is not a fresh known drained snapshot'}
  foreach($provider in @('workspace','native')){foreach($counter in @('active','unknown','reconnecting')){if(-not $Status.providers[$provider].ContainsKey($counter) -or $Status.providers[$provider][$counter] -cne 0){throw 'Shared gateway provider calls are active or unknown'}}}
}
function Close-SharedAdmission($Selection,$Binding){
  $begun=$false;$consumeAttempted=$false
  try{
    $status=Invoke-DrainCommand 'begin' $Selection $Binding $null;$begun=$true
    $deadline=[DateTimeOffset]::UtcNow.AddSeconds(30)
    while($true){
      if($status.fault -or @('workspace','native'|Where-Object {$status.providers[$_].unknown -ne 0}).Count){throw 'Shared gateway contains unknown outcomes or a fault'}
      if($status.ready -ceq $true){Assert-DrainSnapshot $status;break}
      if([DateTimeOffset]::UtcNow -ge $deadline){throw 'Known shared gateway calls did not drain within the bounded window'}
      Start-Sleep -Milliseconds 250
      $status=Invoke-DrainCommand 'status' $Selection $Binding $null
    }
    $consumeAttempted=$true
    $consumed=Invoke-DrainCommand 'consume' $Selection $Binding $status.readySnapshotSha256
    if($consumed.phase -cne 'CONSUMED' -or $consumed.closed -cne $true -or $consumed.consumedSnapshotSha256 -cne $status.readySnapshotSha256){throw 'One-use drain consumption acknowledgement differs'}
    return @{selection=$Selection;binding=$Binding;readySnapshotSha256=$status.readySnapshotSha256;consumed=$consumed}
  }catch{
    if($begun -and -not $consumeAttempted){
      try{
        $current=Invoke-DrainCommand 'status' $Selection $Binding $null
        if(-not $current.fault -and $current.phase -ceq 'DRAINING' -and $current.initialized -ceq $true -and $current.providers.workspace.unknown -ceq 0 -and $current.providers.native.unknown -ceq 0){$null=Invoke-DrainCommand 'resume' $Selection $Binding $null}
      }catch{$script:transaction.reconciliationRequired=$true;Save-Transaction}
    }
    # Consumption with no ACK is never retried, resumed or treated as stop authorization.
    throw
  }
}
function Get-TaskDefinition{
  $task=Get-ScheduledTask -TaskName $taskName
  $original=[string](Export-ScheduledTask -TaskName $taskName)
  [xml]$xml=$original
  $settings=@($xml.DocumentElement.SelectNodes("*[local-name()='Settings']"))
  if($settings.Count -ne 1){throw 'One exact Task Settings element required'}
  $settings=$settings[0]
  $enabledElements=@($settings.SelectNodes("*[local-name()='Enabled']"))
  if($enabledElements.Count -gt 1){throw 'Duplicate Task Enabled settings refused'}
  # Task Scheduler omits Enabled when it is true. Keep the original export hash,
  # but compare enable/disable transitions with one explicit canonical element.
  $exportEnabled=if($enabledElements.Count -eq 0){$true}else{[Xml.XmlConvert]::ToBoolean($enabledElements[0].InnerText)}
  if($null -eq $task.Settings.Enabled -or [bool]$task.Settings.Enabled -ne $exportEnabled){throw 'Task object and exported Enabled setting disagree'}
  if($enabledElements.Count){$null=$settings.RemoveChild($enabledElements[0])}
  $enabledElement=$xml.CreateElement('Enabled',$settings.NamespaceURI)
  $null=$settings.AppendChild($enabledElement)
  $enabledElement.InnerText='false';$disabledHash=Hash-Text $xml.OuterXml
  $enabledElement.InnerText='true';$enabledHash=Hash-Text $xml.OuterXml
  $current=if($exportEnabled){$enabledHash}else{$disabledHash}
  return [ordered]@{taskName=$taskName;originalXmlSha256=(Hash-Text $original);xmlSha256=$current;disabledXmlSha256=$disabledHash;enabledXmlSha256=$enabledHash;enabled=$exportEnabled;enabledWasOmitted=($enabledElements.Count -eq 0);state=[string]$task.State}
}
function Read-GatewayArtifact($InputArtifact){
  if(-not $InputArtifact -or $InputArtifact.sha256 -notmatch '^[a-f0-9]{64}$' -or $InputArtifact.generation -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'){throw 'Approved exact gateway artifact path, SHA and generation required'}
  $path=Assert-Regular $InputArtifact.path
  if((Hash-File $path) -cne $InputArtifact.sha256){throw 'Approved gateway artifact changed'}
  $artifact=@{path=$path;sha256=$InputArtifact.sha256;generation=$InputArtifact.generation;sourceProvenance=@()}
  if($InputArtifact.manifestPath){
    if($InputArtifact.manifestSha256 -notmatch '^[a-f0-9]{64}$'){throw 'Exact artifact manifest SHA required'}
    $manifestFile=Assert-Regular $InputArtifact.manifestPath
    if((Hash-File $manifestFile) -cne $InputArtifact.manifestSha256){throw 'Artifact manifest changed'}
    $manifest=Read-Json $manifestFile
    if($manifest.schemaVersion -ne 1 -or $manifest.files.'gateway.cjs' -cne $artifact.sha256 -or $manifest.releaseHash -cne $artifact.generation -or (Join-Path (Split-Path $manifestFile -Parent) 'gateway.cjs') -ine $path){throw 'Existing builder manifest does not identify this gateway artifact'}
    $artifact.manifestPath=$manifestFile;$artifact.manifestSha256=$InputArtifact.manifestSha256
  }elseif($InputArtifact.manifestSha256){throw 'Artifact manifest path missing'}
  foreach($reference in @($InputArtifact.sourceProvenance)){
    if(-not $reference){continue}
    $source=Assert-Regular $reference.path
    if($reference.sha256 -notmatch '^[a-f0-9]{64}$' -or (Hash-File $source) -cne $reference.sha256){throw 'Provided artifact source provenance changed'}
    $artifact.sourceProvenance+=@{path=$source;sha256=$reference.sha256}
  }
  return $artifact
}
function Cold-ReceiptPath([string]$Path){
  if(-not $Path -or -not [IO.Path]::IsPathFullyQualified($Path)){throw 'Exact future cold handoff receipt path required'}
  $full=[IO.Path]::GetFullPath($Path);$parent=Get-Item -LiteralPath (Split-Path $full -Parent) -Force
  if(-not $parent.PSIsContainer -or -not $full.StartsWith((Join-Path $stateRoot 'receipts')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Cold handoff must use an existing owner receipt directory'}
  for($cursor=$parent;$cursor;$cursor=$cursor.Parent){if($cursor.LinkType -or ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked receipt ancestor refused'}}
  if(Test-Path -LiteralPath $full){$null=Assert-Regular $full}
  return $full
}
function Read-ColdCondition($Cold){
  $task=Get-TaskDefinition
  if($task.enabled -or $task.state -cne 'Disabled' -or $task.xmlSha256 -cne $Cold.task.disabledXmlSha256){throw 'Cold Task must already be disabled, stopped and definition-pinned; no automatic stop is performed'}
  $ownership=$Cold.ownership
  if($ownership.surface -cne 'business-full' -or @($ownership.processes).Count -lt 1 -or @($ownership.processes|Where-Object {$_.pid -lt 1 -or $_.created -notmatch '^\d+$' -or $_.commandHash -notmatch '^[a-f0-9]{64}$'}).Count){throw 'Exact plan-bound Task subtree ownership is required; prepare before the planned stop'}
  $processes=@(Get-CimInstance Win32_Process -ErrorAction Stop)
  $owned=@{};$active=@();$unknown=@()
  foreach($process in $processes){
    $expected=@($ownership.processes|Where-Object {$_.pid -eq $process.ProcessId -and $_.created -ceq $process.CreationDate.ToUniversalTime().Ticks.ToString()})
    if($expected.Count -gt 1){throw 'Duplicate plan-bound process identity'}
    if($expected.Count -eq 1){
      $owned[[int]$process.ProcessId]=$process
      if(-not $process.CommandLine -or -not $process.ExecutablePath -or $process.ExecutablePath -ine $expected[0].image -or (Hash-Text ([string]$process.CommandLine)) -cne $expected[0].commandHash){$unknown+=@{pid=[int]$process.ProcessId;reason='exact_owned_generation_identity_unknown'}}
      continue
    }
    # Same executables and native entrypoints can serve other owners. Only an exact
    # profile/config recreation is a root here; provider children are scoped below.
    $command=[string]$process.CommandLine
    if(-not $command){continue}
    $normalized=$command.Replace('/','\');$matches=$false
    if($normalized.Contains($Cold.subjects.helperEntry) -and $normalized.Contains($stateRoot) -and $normalized -match '--surface\s+business-full(?:\s|$)'){$matches=$true}
    if($process.ExecutablePath -ieq $Cold.subjects.tunnelImage -and $normalized.Contains($Cold.subjects.tunnelProfile) -and $normalized -match ('(?:^|\s)'+[regex]::Escape($Cold.subjects.tunnelAlias)+'(?:\s|$)')){$matches=$true}
    foreach($gateway in @($Cold.subjects.gateways)){if($normalized.Contains($gateway.entry) -and $normalized.Contains($gateway.config)){$matches=$true}}
    foreach($provider in @($Cold.subjects.providers|Where-Object id -CEQ 'workspace')){if($normalized.Contains($provider.entrypoint) -and $normalized.Contains($configFile)){$matches=$true}}
    if($matches){$owned[[int]$process.ProcessId]=$process}
  }
  do{
    $added=0
    foreach($process in $processes){if($owned.ContainsKey([int]$process.ParentProcessId) -and -not $owned.ContainsKey([int]$process.ProcessId)){$owned[[int]$process.ProcessId]=$process;$added++}}
  }while($added -gt 0)
  foreach($process in $owned.Values){
    if(-not $process.CommandLine -or -not $process.ExecutablePath){$unknown+=@{pid=[int]$process.ProcessId;reason='target_subtree_identity_unavailable'}}
    else{$active+=@{pid=[int]$process.ProcessId;created=$process.CreationDate.ToUniversalTime().Ticks.ToString();commandSha256=(Hash-Text ([string]$process.CommandLine))}}
  }
  if($unknown.Count -or $active.Count){throw 'Cold target helper/Tunnel/gateway/provider presence is active or UNKNOWN; no stop dispatched'}
  # This state is hashed across separate Status processes; Hashtable key order is
  # randomized per process. Preserve the stable task and envelope field order.
  return [ordered]@{task=$task;active=@();unknown=@();cold=$true;ownershipSha256=(Hash-Text (Json $ownership))}
}
function Assert-ColdHandoff($Plan){
  $path=Require-Owned $Plan.coldBootstrap.handoffRef (Join-Path $stateRoot 'receipts')
  $receipt=Read-Json $path
  if($receipt.schemaVersion -ne 1 -or $receipt.kind -cne 'aicc-workspace-cold-handoff' -or $receipt.operationId -cne $Plan.operationId -or $receipt.planSha256 -cne $ExpectedPlanSha256 -or $receipt.scopeHash -cne $Plan.scopeHash -or $receipt.challenge -cne $Plan.challenge -or -not $receipt.operator -or $receipt.operator -isnot [string]){throw 'Operation-bound actual cold handoff receipt required'}
  $expiry=[DateTimeOffset]::Parse($receipt.expiresAt)
  if($expiry -le [DateTimeOffset]::UtcNow -or $expiry -gt [DateTimeOffset]::Parse($Plan.expiresAt)){throw 'Cold handoff expired or exceeds plan'}
  $requiredScope=@('gateway','helper','native','task','tunnel','workspace')
  if($receipt.admission.closed -cne $true -or -not (Same (@($receipt.admission.scope)|Sort-Object) $requiredScope) -or $receipt.shutdown.mode -cnotin @('normal','planned-maintenance-stop') -or $receipt.shutdown.taskName -cne $taskName -or $receipt.shutdown.taskDisabled -cne $true -or $receipt.shutdown.taskStopped -cne $true -or $receipt.shutdown.runtimeStopped -cne $true -or $receipt.shutdown.disabledTaskXmlSha256 -cne $Plan.coldBootstrap.task.disabledXmlSha256){throw 'Cold handoff lacks scoped admission, original result reconciliation or exact Task/runtime maintenance stop'}
  if($receipt.shutdown.mode -ceq 'planned-maintenance-stop' -and $receipt.shutdown.ownershipSha256 -cne (Hash-Text (Json $Plan.coldBootstrap.ownership))){throw 'Planned stop receipt must bind the exact prepared Task subtree'}
  $outcomeMode=if($receipt.outcomes.mode){[string]$receipt.outcomes.mode}else{'reconciled'}
  $sections=@('admission','outcomes','shutdown');$unconfirmed=$false
  if($outcomeMode -ceq 'reconciled'){
    if($receipt.outcomes.activeCount -cne 0 -or $receipt.outcomes.unknownCount -cne 0 -or $receipt.outcomes.lastResult -cnotin @('ACKNOWLEDGED','NO_CALLS')){throw 'Cold handoff lacks scoped admission, original result reconciliation or exact Task/runtime maintenance stop'}
  }elseif($outcomeMode -ceq 'preserve-unconfirmed-no-replay'){
    # A planned interruption is not a drain acknowledgement. The retired generation's
    # unobservable callers/results remain unknown, even after its exact runtime is cold.
    # This admits no live stop: Read-ColdCondition and independent READY still apply.
    $acceptance=$receipt.maintenanceAcceptance;$outcomes=$receipt.outcomes
    if($Plan.transitionMode -cne 'cold-bootstrap' -or $receipt.shutdown.mode -cne 'planned-maintenance-stop' -or $receipt.admission.basis -cne 'exact-runtime-stopped' -or $acceptance.authorizationBasis -cne 'explicit-user-maintenance-request' -or $acceptance.stopScope -cne 'exact-prepared-task-subtree-once' -or $acceptance.interruptionAuthorized -cne $true -or $acceptance.unknownOutcomeRiskAccepted -cne $true -or $acceptance.gatewayDrainClaimed -cne $false -or $acceptance.knownActiveWorkMayBeInterrupted -cne $false){throw 'Explicit scoped planned-interruption acceptance required; this is not drain or permission to stop active work'}
    if(-not $outcomes.Contains('activeCount') -or $null -ne $outcomes.activeCount -or -not $outcomes.Contains('unknownCount') -or $null -ne $outcomes.unknownCount -or $outcomes.lastResult -cne 'UNCONFIRMED_PRESERVED' -or $outcomes.callerInventoryComplete -cne $false){throw 'Unobserved caller/result counts must remain explicit null and UNCONFIRMED_PRESERVED'}
    if(($outcomes.knownActiveCount -isnot [int] -and $outcomes.knownActiveCount -isnot [long]) -or $outcomes.knownActiveCount -ne 0 -or $outcomes.knownActiveOperations -isnot [array] -or @($outcomes.knownActiveOperations).Count -ne 0){throw 'Known active work must finish or be preserved outside the stopped scope before planned interruption'}
    if($outcomes.replayPolicy -cne 'never-automatic' -or $outcomes.preservationScope -cne 'all-requests-to-retired-generation' -or $outcomes.reconciliationRequired -cne $true -or $outcomes.reconciliationOwner -isnot [string] -or [string]::IsNullOrWhiteSpace($outcomes.reconciliationOwner)){throw 'Unconfirmed original results require retained evidence, a reconciliation owner and no automatic replay'}
    $unconfirmed=$true;$sections+='maintenanceAcceptance'
  }else{throw 'Unsupported cold handoff outcome mode'}
  $references=@()
  # A caller's completed response, the operator's current admission-closure acceptance
  # and the actual stop receipt may have different existing source formats. Pin the
  # actual originals; neither their fields nor absence alone manufacture zero counts.
  foreach($section in $sections){
    $part=$receipt[$section]
    $sectionReferences=if($part.sourceRefs){@($part.sourceRefs)}elseif($part.sourceRef){@($part.sourceRef)}else{@()}
    if($sectionReferences.Count -lt 1 -or $sectionReferences.Count -gt 8){throw 'Traceable actual caller/admission/stop evidence references required'}
    foreach($reference in $sectionReferences){
      if(-not $reference -or $reference.sha256 -notmatch '^[a-f0-9]{64}$' -or -not [IO.Path]::IsPathFullyQualified($reference.file)){throw 'Exact original evidence path and SHA required'}
      $source=Assert-Regular $reference.file
      if($source -ieq $path -or $source -ieq $planPath -or $source -ieq $RescueReadyFile -or (Hash-File $source) -cne $reference.sha256){throw 'Original cold handoff source reference missing, changed or self-referential'}
      $references+=@{section=$section;file=$source;sha256=$reference.sha256}
    }
  }
  return @{file=$path;sha256=(Hash-File $path);operator=$receipt.operator;expiresAt=$receipt.expiresAt;shutdownMode=$receipt.shutdown.mode;outcomeMode=$outcomeMode;originalOutcomesReconciliationRequired=$unconfirmed;reconciliationOwner=$receipt.outcomes.reconciliationOwner;sourceReferences=$references}
}
function Restore-BeforeFiles{
  foreach($change in $plan.changes){$hash=Hash-File $change.file;if($hash -cne $change.beforeSha256 -and $hash -cne $change.afterSha256){throw 'Third-party state changed; restore refused'}}
  foreach($change in $plan.changes){Set-Atomic $change.file ([IO.File]::ReadAllText((Join-Path $plan.backup ($change.name+'.before'))))}
}
function Assert-Ready($Plan){
  if(-not $RescueReadyFile){throw 'Operation-specific independent READY not supplied'}
  $ackPath=Require-Owned $RescueReadyFile (Join-Path $stateRoot 'receipts')
  $ack=Read-Json $ackPath
  if($ack.status -cne 'READY' -or $ack.operationId -cne $Plan.operationId -or $ack.challenge -cne $Plan.challenge -or $ack.planSha256 -cne $ExpectedPlanSha256 -or $ack.scopeHash -cne $Plan.scopeHash -or $ack.backup -cne $Plan.backup -or $ack.independent -cne $true -or $ack.transport -cne 'collaboration+direct-exec' -or -not $ack.actor){throw 'Operation-specific independent READY required'}
  if($Plan.transitionMode -ceq 'cold-bootstrap'){
    $coldAck=Assert-ColdHandoff $Plan
    if($ack.coldHandoffSha256 -cne $coldAck.sha256){throw 'Independent rescue READY must bind the actual cold handoff receipt SHA'}
  }
  $expiry=[DateTimeOffset]::Parse($ack.expiresAt)
  if($expiry -le [DateTimeOffset]::UtcNow -or $expiry -gt [DateTimeOffset]::Parse($Plan.expiresAt)){throw 'Rescue READY expired or outside plan lifetime'}
  return $ack
}
# Staging is evidence, not a maintenance authorization. Re-derive this limited
# transform against today's registry, preserving every unrelated key.
function Get-PidGuardLockfile([string]$Backend,$Manifest,[string]$Node){
  # Match runtime-marker's first-existing-file policy; an invalid preferred file
  # is rejected rather than silently falling back to the second lockfile.
  $relative=@('npm-shrinkwrap.json','package-lock.json')|Where-Object {Test-Path -LiteralPath (Join-Path $Backend $_)}|Select-Object -First 1
  if(-not $relative){throw 'PID guard candidate lockfile missing'}
  $file=Require-Owned (Join-Path $Backend $relative) $Backend
  $row=@($Manifest.files|Where-Object {$_.path -ceq $relative})
  $sha=Hash-File $file
  if($row.Count -ne 1 -or $row[0].sha256 -cne $sha -or $row[0].size -ne (Get-Item -LiteralPath $file).Length){throw 'PID guard lockfile manifest pin differs'}
  $realpathScript="import fs from 'node:fs';console.log(JSON.stringify({realpath:fs.realpathSync.native(process.argv[1])}));"
  $raw=& $Node --input-type=module -e $realpathScript $file
  if($LASTEXITCODE -ne 0){throw 'PID guard lockfile realpath unavailable'}
  $realpath=Require-Owned (($raw -join "`n"|ConvertFrom-Json).realpath) $Backend
  if(-not [string]::Equals($realpath,$file,[StringComparison]::OrdinalIgnoreCase)){throw 'PID guard lockfile realpath differs'}
  return @{relativePath=$relative;realpath=$realpath;sha256=$sha}
}
function Get-PidGuardMutation([string]$CandidateFile,[string]$CandidateSha256,[string]$OperationId,[string]$Backup){
  $candidatePath=Require-Owned $CandidateFile $runtimeRoot
  if([IO.Path]::GetFileName($candidatePath) -notmatch '^workspace-home-plan-([a-f0-9]{64})\.json$'){throw 'Exact staged PID guard candidate required'}
  $candidateId=$Matches[1]
  if((Hash-File $candidatePath) -cne $CandidateSha256){throw 'Staged PID guard candidate changed'}
  $c=Read-Json $candidatePath
  $beforeHashes=@{};foreach($pair in @(@('launcher',$launcherFile),@('profile',$profileFile),@('registry',$registryFile),@('task-receipt',$taskReceipt))){$beforeHashes[$pair[0]]=Hash-File $pair[1]}
  $registry=Read-Json $registryFile
  if($c.schemaVersion -ne 1 -or $c.kind -cne 'workspace-pid-reuse-guard' -or $c.nativeProviderUnchanged -cne $true -or $c.workspaceConfigUnchanged -cne $true -or $c.runtimeChanged -cne $false){throw 'PID guard candidate contract differs'}
  if($registry.root -ine $stateRoot -or $registry.schemaVersion -ne 1 -or $registry.components.workspace.releaseRoot -ine $c.originalBackend -or $registry.components.'workspace-host'.releaseRoot -ine $c.originalHost -or $registry.components.'unified-mcp'.releaseRoot -ine $c.oldGateway){throw 'Registered PID guard baseline changed'}
  $runtime=$registry.components.workspace.runtime
  if($registry.components.'workspace-host'.runtime -ine $runtime -or $registry.components.'unified-mcp'.runtime -ine $runtime){throw 'Registered component runtimes differ'}
  foreach($pair in @(@($c.backend,'workspace','bin\aicc'),@($c.originalBackend,'workspace','bin\aicc'),@($c.host,'workspace-host','tools\platform\workspace-mcp\windows-tunnel-secret.mjs'),@($c.originalHost,'workspace-host','tools\platform\workspace-mcp\windows-tunnel-secret.mjs'),@($c.gateway,'unified-mcp','config.json'),@($c.oldGateway,'unified-mcp','config.json'))){$null=Require-Owned (Join-Path $pair[0] $pair[2]) (Join-Path $stateRoot ('releases\'+$pair[1]))}
  if($c.gateway -ine (Join-Path $stateRoot ('releases\unified-mcp\'+$candidateId)) -or $c.profile -ine $profileFile -or $c.helperEntry -ine (Join-Path $c.host 'tools\platform\workspace-mcp\windows-tunnel-secret.mjs')){throw 'PID guard candidate paths differ'}
  if($registry.components.workspace.entry -ine (Join-Path $c.originalBackend 'bin\aicc') -or $registry.components.'workspace-host'.entry -ine (Join-Path $c.originalHost 'tools\platform\workspace-mcp\windows-tunnel-secret.mjs') -or $registry.components.'unified-mcp'.entry -ine (Join-Path $c.oldGateway 'gateway.cjs')){throw 'Registered entrypoints differ'}
  if((Hash-File $registry.components.'workspace-host'.entry) -cne $registry.components.'workspace-host'.entryHash -or (Hash-File $registry.components.'unified-mcp'.entry) -cne $registry.components.'unified-mcp'.entryHash){throw 'Registered component entry pin changed'}
  $markerRelative='components\workspace-mcp\runtime-marker.mjs';$overlay=$c.markerOverlay
  if($overlay.baseline -ine $c.originalBackend -or (Hash-File (Join-Path $c.originalBackend $markerRelative)) -cne $overlay.beforeSha256 -or (Hash-File (Join-Path $c.backend $markerRelative)) -cne $overlay.afterSha256 -or (Hash-File (Join-Path $c.originalHost $markerRelative)) -cne $c.hostMarkerBeforeSha256 -or (Hash-File (Join-Path $c.host $markerRelative)) -cne $c.hostMarkerAfterSha256){throw 'PID guard marker preimage or candidate changed'}
  # Only import the existing PURE function; never call staging or either server.
  $overlayScript=@'
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [moduleFile,canonical,...pairs]=process.argv.slice(2);
const {overlayPidReuseGuard}=await import(pathToFileURL(moduleFile).href);
const source=fs.readFileSync(canonical,'utf8');
for(let i=0;i<pairs.length;i+=2){if(!Buffer.from(overlayPidReuseGuard(fs.readFileSync(pairs[i],'utf8'),source)).equals(fs.readFileSync(pairs[i+1])))throw Error('PID guard exceeds supported overlay');}
console.log('{"ok":true}');
'@
  $overlayModule=Assert-Regular (Join-Path $PSScriptRoot 'stage-workspace-home.mjs')
  $canonicalMarker=Assert-Regular (Join-Path $PSScriptRoot '..\..\..\components\workspace-mcp\runtime-marker.mjs')
  $reply=$overlayScript | & $runtime --input-type=module - $overlayModule $canonicalMarker (Join-Path $c.originalBackend $markerRelative) (Join-Path $c.backend $markerRelative) (Join-Path $c.originalHost $markerRelative) (Join-Path $c.host $markerRelative)
  if($LASTEXITCODE -ne 0 -or ($reply|ConvertFrom-Json).ok -cne $true){throw 'PID guard exact overlay verification failed'}
  $oldManifest=Read-Json (Join-Path $c.originalBackend '.aicc-release.json');$nextManifest=Read-Json (Join-Path $c.backend '.aicc-release.json')
  $markerRows=@($oldManifest.files|Where-Object {$_.path.Replace('/','\') -ceq $markerRelative})
  if($markerRows.Count -ne 1 -or $markerRows[0].sha256 -cne $overlay.beforeSha256){throw 'PID guard original manifest marker differs'}
  $markerRows[0].sha256=$overlay.afterSha256;$markerRows[0].size=(Get-Item -LiteralPath (Join-Path $c.backend $markerRelative)).Length
  $oldManifest.fileCount=$oldManifest.files.Count;$oldManifest.totalBytes=($oldManifest.files|Measure-Object size -Sum).Sum;$oldManifest.pidReuseGuardOverlay=$overlay
  if(-not (Same-Structure $oldManifest $nextManifest)){throw 'PID guard manifest changes unrelated inventory'}
  $expectedLockfile=Get-PidGuardLockfile $c.backend $nextManifest $runtime
  $expectedDrive=Read-Json (Join-Path $c.originalBackend 'workspace-drive-manifest.json')
  $expectedDrive.baseline=$c.originalBackend;$expectedDrive.release=$c.backend
  $expectedDrive.files['components/workspace-mcp/runtime-marker.mjs']=$overlay.afterSha256
  $expectedDrive.files['.aicc-release.json']=Hash-File (Join-Path $c.backend '.aicc-release.json')
  if(-not (Same-Structure $expectedDrive (Read-Json (Join-Path $c.backend 'workspace-drive-manifest.json')))){throw 'PID guard drive manifest changes unrelated pins'}
  $oldHost=$registry.components.'workspace-host'
  $helperKeys=@($oldHost.sourceHashes.Keys|ForEach-Object {$_.Replace('/','\')}|Sort-Object)
  if(-not (Same $helperKeys @($c.helperHashes.Keys|ForEach-Object {$_.Replace('/','\')}|Sort-Object))){throw 'PID guard helper dependency set changed'}
  foreach($key in $c.helperHashes.Keys){
    $relative=$key.Replace('/','\');$oldKey=@($oldHost.sourceHashes.Keys|Where-Object {$_.Replace('/','\') -ceq $relative})[0]
    $old=Require-Owned (Join-Path $c.originalHost $relative) $c.originalHost;$next=Require-Owned (Join-Path $c.host $relative) $c.host
    if((Hash-File $old) -cne $oldHost.sourceHashes[$oldKey] -or (Hash-File $next) -cne $c.helperHashes[$key] -or ($relative -cne $markerRelative -and $c.helperHashes[$key] -cne $oldHost.sourceHashes[$oldKey])){throw 'PID guard helper closure changed outside marker guard'}
  }
  $expectedGateway=Read-Json (Join-Path $c.oldGateway 'config.json');$providers=@($expectedGateway.providers|Where-Object id -CEQ 'workspace')
  if($providers.Count -ne 1 -or @($expectedGateway.providers).Count -ne 2 -or @($expectedGateway.providers|Where-Object id -CEQ 'native').Count -ne 1){throw 'Exact two-provider graph required'}
  foreach($provider in $expectedGateway.providers){foreach($pin in $provider.files){if((Hash-File $pin.path) -cne $pin.sha256){throw 'Original provider pin changed'}}}
  $workspace=$providers[0];$markerPin=$false
  foreach($pin in $workspace.files){
    if($pin.path.StartsWith($c.originalBackend+'\',[StringComparison]::OrdinalIgnoreCase)){
      $relative=$pin.path.Substring($c.originalBackend.Length+1);$next=Require-Owned (Join-Path $c.backend $relative) $c.backend
      $expected=if($relative.Replace('/','\') -ceq $markerRelative){$markerPin=$true;$overlay.afterSha256}elseif($relative -ceq 'workspace-drive-manifest.json'){Hash-File (Join-Path $c.backend $relative)}else{$pin.sha256}
      if((Hash-File $next) -cne $expected){throw 'Candidate provider pin changes unrelated bytes'}
      $pin.path=$next;$pin.sha256=$expected
    }
  }
  if(-not $markerPin){$workspace.files+=@{path=(Join-Path $c.backend $markerRelative);sha256=$overlay.afterSha256}}
  $workspace.entrypoint=Join-Path $c.backend ([IO.Path]::GetRelativePath($c.originalBackend,$workspace.entrypoint))
  $workspace.args=@($workspace.args|ForEach-Object {if($_ -is [string] -and $_.StartsWith($c.originalBackend+'\',[StringComparison]::OrdinalIgnoreCase)){Join-Path $c.backend $_.Substring($c.originalBackend.Length+1)}else{$_}})
  if(-not (Same-Structure $expectedGateway (Read-Json (Join-Path $c.gateway 'config.json'))) -or (Hash-File (Join-Path $c.gateway 'gateway.cjs')) -cne (Hash-File (Join-Path $c.oldGateway 'gateway.cjs'))){throw 'PID guard gateway changes exceed exact Workspace pins'}
  $generationFiles=@{};foreach($name in @('config.json','gateway.cjs','manifest.json')){$generationFiles[$name]=Hash-File (Join-Path $c.gateway $name)}
  $manifest=Read-Json (Join-Path $c.gateway 'manifest.json')
  if($manifest.schemaVersion -ne 1 -or $manifest.releaseHash -cne $candidateId -or $manifest.files.Count -ne 2 -or $manifest.files.'config.json' -cne $generationFiles.'config.json' -or $manifest.files.'gateway.cjs' -cne $generationFiles.'gateway.cjs'){throw 'PID guard gateway manifest differs'}
  $profileBefore=[IO.File]::ReadAllText((Assert-Regular $profileFile));$match=[regex]::Match($profileBefore,'command:\s*("(?:[^"\\]|\\.)*")')
  if(-not $match.Success -or (Hash-File $profileFile) -cne $c.profileBeforeHash){throw 'PID guard profile preimage changed'}
  $command=ConvertFrom-Json $match.Groups[1].Value;$old=$c.oldGateway.Replace('\','/');$next=$c.gateway.Replace('\','/')
  if(@([regex]::Matches($command,[regex]::Escape($old))).Count -ne 2){throw 'Exact old gateway/config references required'}
  $profileAfter=$profileBefore.Remove($match.Groups[1].Index,$match.Groups[1].Length).Insert($match.Groups[1].Index,(ConvertTo-Json -InputObject $command.Replace($old,$next) -Compress))
  if((Hash-Text $profileAfter) -cne $c.profileAfterHash -or (Hash-File (Require-Owned $c.stagedProfile $runtimeRoot)) -cne $c.profileAfterHash){throw 'PID guard profile transform differs'}
  $launcherBefore=[IO.File]::ReadAllText((Assert-Regular $launcherFile))
  if($launcherBefore.Split($oldHost.entry,[StringSplitOptions]::None).Count -ne 2){throw 'Exact original helper launcher reference required'}
  $launcherAfter=$launcherBefore.Replace($oldHost.entry,$c.helperEntry);$receipt=(Prepare-TaskReceipt $registry $OperationId).receipt
  $receipt.profileSha256=Hash-Text $profileAfter;$receipt.launcherSha256=Hash-Text $launcherAfter;$receipt.helperSha256=Hash-File $c.helperEntry
  $registry.components.workspace.previousRelease=$c.originalBackend;$registry.components.workspace.releaseRoot=$c.backend;$registry.components.workspace.entry=Join-Path $c.backend 'bin\aicc';$registry.components.workspace.recovery=$Backup
  $registry.components.'workspace-host'.releaseRoot=$c.host;$registry.components.'workspace-host'.entry=$c.helperEntry;$registry.components.'workspace-host'.entryHash=Hash-File $c.helperEntry;$registry.components.'workspace-host'.sourceHashes=$c.helperHashes;$registry.components.'workspace-host'.recovery=$Backup
  $registry.components.'unified-mcp'.previousRelease=$c.oldGateway;$registry.components.'unified-mcp'.releaseRoot=$c.gateway;$registry.components.'unified-mcp'.entry=Join-Path $c.gateway 'gateway.cjs';$registry.components.'unified-mcp'.entryHash=$generationFiles.'gateway.cjs';$registry.components.'unified-mcp'.recovery=$Backup
  return @{candidate=$c;candidateFile=$candidatePath;candidateSha256=$CandidateSha256;generationFiles=$generationFiles;expectedLockfile=$expectedLockfile;node=$runtime;beforeHashes=$beforeHashes;inputs=@{config=(Hash-File $configFile);overlayModule=(Hash-File $overlayModule);canonicalMarker=(Hash-File $canonicalMarker);candidateLockfile=$expectedLockfile.sha256};entries=@(@{name='launcher';file=$launcherFile;text=$launcherAfter},@{name='profile';file=$profileFile;text=$profileAfter},@{name='registry';file=$registryFile;text=(Json $registry)},@{name='task-receipt';file=$taskReceipt;text=(Json $receipt)})}
}
function Prepare-PidGuard([string]$CandidateFile){
  $operationId='workspace-root-'+[guid]::NewGuid().ToString('N');$backup=Join-Path $stateRoot ('backups\workspace-roots\'+$operationId)
  $candidateSha=Hash-File $CandidateFile;$mutation=Get-PidGuardMutation $CandidateFile $candidateSha $operationId $backup
  $ownership=Get-WorkspaceOwnedRuntime 'business-full';$drain=Get-RegisteredDrain $ownership
  if(-not $drain.supported){throw ('PID guard Prepare requires installed scoped drain: '+$drain.reason)}
  $stage=Join-Path $runtimeRoot $operationId;New-Item -ItemType Directory -Path $stage|Out-Null
  $preimages=Join-Path $stage 'prepared-preimages';New-Item -ItemType Directory -Path $preimages|Out-Null
  $changes=@();foreach($entry in $mutation.entries){
    $candidate=Join-Path $stage ($entry.name+'.after');Write-New $candidate $entry.text
    $beforeHash=Hash-File $entry.file
    if($beforeHash -cne $mutation.beforeHashes[$entry.name]){throw 'Live preimage changed after mutation derivation'}
    Copy-Item -LiteralPath $entry.file -Destination (Join-Path $preimages ($entry.name+'.before'))
    if((Hash-File $entry.file) -cne $beforeHash -or (Hash-File (Join-Path $preimages ($entry.name+'.before'))) -cne $beforeHash){throw 'Preimage changed during PID guard Prepare'}
    $changes+=@{name=$entry.name;file=$entry.file;beforeSha256=$beforeHash;afterSha256=(Hash-Text $entry.text);candidate=$candidate}
  }
  $taskXml=Export-ScheduledTask -TaskName $taskName
  Write-New (Join-Path $preimages 'task.before.xml') $taskXml
  $scope=@{kind='workspace-pid-reuse-guard';taskName=$taskName;taskXmlSha256=(Hash-Text $taskXml);processes=$ownership.processes;changes=@($changes|ForEach-Object {@{file=$_.file;before=$_.beforeSha256;after=$_.afterSha256}});candidateFile=$mutation.candidateFile;candidateSha256=$candidateSha;inputs=$mutation.inputs;expectedLockfile=$mutation.expectedLockfile;maintenance=$drain.selection;nativeProviderUnchanged=$true;workspaceConfigUnchanged=$true}
  $plan=@{schemaVersion=2;operation='workspace-canonical-root-reconcile';kind='workspace-pid-reuse-guard';operationId=$operationId;alias='open-aicc';transitionMode='live-scoped';challenge=[guid]::NewGuid().ToString('N');createdAt=[DateTimeOffset]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(30).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");backup=$backup;preparedPreimages=$preimages;scope=$scope;scopeHash=(Hash-Text (Json $scope));ownership=$ownership;backend=$mutation.candidate.originalBackend;node=$mutation.node;generation=$mutation.candidate.gateway;generationFiles=$mutation.generationFiles;changes=$changes;maintenance=@{supported=$true;selection=$drain.selection;nonce=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()};resultFile=(Join-Path $stage 'result.json')}
  foreach($change in $changes){if((Hash-File $change.file) -cne $change.beforeSha256){throw 'Live preimage changed before plan seal'}}
  $output=Join-Path $runtimeRoot ('workspace-root-plan-'+$operationId+'.json');Write-New $output (Json $plan)
  @{status='PREPARED_NOT_APPLIED';kind=$plan.kind;operationId=$operationId;planFile=$output;planSha256=(Hash-File $output);scopeHash=$plan.scopeHash;challenge=$plan.challenge;backup=$backup;preparedPreimages=$preimages;expiresAt=$plan.expiresAt;runtimeChanged=$false}|ConvertTo-Json
}
function Assert-PidGuardPlan($Plan){
  if((Hash-Text (Export-ScheduledTask -TaskName $taskName)) -cne $Plan.scope.taskXmlSha256){throw 'Exact prepared Task XML changed'}
  $derived=Get-PidGuardMutation $Plan.scope.candidateFile $Plan.scope.candidateSha256 $Plan.operationId $Plan.backup
  if(-not (Same-Structure $derived.expectedLockfile $Plan.scope.expectedLockfile)){throw 'PID guard expected lockfile identity changed'}
  if($Plan.transitionMode -cne 'live-scoped' -or $Plan.backend -ine $derived.candidate.originalBackend -or $Plan.node -ine $derived.node -or $Plan.generation -ine $derived.candidate.gateway -or -not (Same-Structure $derived.generationFiles $Plan.generationFiles) -or -not (Same-Structure $derived.inputs $Plan.scope.inputs)){throw 'PID guard generation or immutable inputs changed'}
  foreach($entry in $derived.entries){
    $change=@($Plan.changes|Where-Object name -CEQ $entry.name)
    if($change.Count -ne 1 -or $change[0].file -ine $entry.file -or $change[0].beforeSha256 -cne $derived.beforeHashes[$entry.name] -or (Hash-Text $entry.text) -cne $change[0].afterSha256){throw 'PID guard plan exceeds the exact bounded transform'}
  }
  return $derived
}
$planPath=[IO.Path]::GetFullPath($PlanFile)
if($Mode -eq 'Prepare'){
  if((Read-Json $planPath).kind -ceq 'workspace-pid-reuse-guard'){Prepare-PidGuard $planPath;return}
  $handoff=Read-Json (Require-Owned $planPath (Join-Path $stateRoot 'receipts'))
  if(-not $TaskProfileHistoryPlan){$TaskProfileHistoryPlan=$handoff.taskProfileHistoryPlan}
  if(-not $TaskProfileHistoryReceipt){$TaskProfileHistoryReceipt=$handoff.taskProfileHistoryReceipt}
  if($handoff.operation -cne 'workspace-canonical-root-reconcile' -or $handoff.alias -cne 'open-aicc' -or $handoff.configPath -ine $configFile -or (Hash-File $configFile) -cne $handoff.expectedBeforeSha256){throw 'Exact root handoff and config preimage required'}
  $transitionMode=if($handoff.transitionMode){[string]$handoff.transitionMode}else{'live-scoped'}
  if($transitionMode -cnotin @('live-scoped','cold-bootstrap')){throw 'Unsupported root transition mode'}
  $coldMode=$transitionMode -ceq 'cold-bootstrap';$artifact=$null;$cold=$null
  if($coldMode){
    $artifact=Read-GatewayArtifact $handoff.gatewayArtifact
    if($handoff.taskRestart.enabled -cne $true -or $handoff.taskRestart.start -cne $true){throw 'Cold bootstrap requires explicit exact Task enable/start intent'}
    $cold=@{artifact=$artifact;handoffRef=(Cold-ReceiptPath $handoff.coldHandoffRef);task=(Get-TaskDefinition);taskRestart=@{enabled=$true;start=$true}}
  }
  $desired=(Resolve-Path -LiteralPath $handoff.desiredRoot).Path
  $directory=Get-Item -LiteralPath $desired
  if($directory.LinkType -or -not (Test-Path -LiteralPath (Join-Path $desired '.git')) -or $desired -ieq $handoff.beforeRoot){throw 'Distinct existing canonical Git root required'}
  $current=Read-Json $configFile;$pending=Read-Json $configFile
  $matches=@($pending.workspaces|Where-Object alias -CEQ 'open-aicc')
  if($matches.Count -ne 1 -or $matches[0].root -ine $handoff.beforeRoot){throw 'Exact original alias required'}
  $matches[0].root=$desired
  $workspaceText=Json $pending
  $registry=Read-Json $registryFile
  if($registry.root -ine $stateRoot -or $registry.schemaVersion -ne 1){throw 'Registered owner root required'}
  $oldGateway=$registry.components.'unified-mcp'.releaseRoot
  if(-not $oldGateway.StartsWith((Join-Path $stateRoot 'releases\unified-mcp\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Managed gateway required'}
  $gatewayConfigFile=Join-Path $oldGateway 'config.json';$gatewayCode=Join-Path $oldGateway 'gateway.cjs'
  if((Hash-File $gatewayCode) -cne $registry.components.'unified-mcp'.entryHash){throw 'Registered gateway entry changed'}
  $gatewayConfig=Read-Json $gatewayConfigFile
  $workspace=@($gatewayConfig.providers|Where-Object id -CEQ 'workspace');$native=@($gatewayConfig.providers|Where-Object id -CEQ 'native')
  if($workspace.Count -ne 1 -or $native.Count -ne 1 -or @($gatewayConfig.providers).Count -ne 2){throw 'Exact two-provider gateway required'}
  foreach($provider in $gatewayConfig.providers){foreach($file in $provider.files){if((Hash-File $file.path) -cne $file.sha256){throw 'Original provider pin changed'}}}
  $pin=@($workspace[0].files|Where-Object path -IEQ $configFile)
  if($pin.Count -ne 1){throw 'Exact Workspace config pin required'}
  $pin[0].sha256=Hash-Text $workspaceText
  $gatewayText=Json $gatewayConfig;$gatewayHash=Hash-Text $gatewayText
  $operationId='workspace-root-'+[guid]::NewGuid().ToString('N')
  # Resolve stale installation metadata before writing any generation artifacts.
  $taskPreparation=Prepare-TaskReceipt $registry $operationId
  $receipt=$taskPreparation.receipt
  $selectedGateway=if($coldMode){$artifact.path}else{$gatewayCode}
  $selectedGatewaySha=Hash-File $selectedGateway
  $generationName=if($coldMode){'cold-root-'+(Hash-Text ($selectedGatewaySha+':'+$gatewayHash))}else{'canonical-root-'+$gatewayHash}
  $generation=Join-Path $stateRoot ('releases\unified-mcp\'+$generationName)
  $files=@{'config.json'=$gatewayHash;'gateway.cjs'=$selectedGatewaySha}
  if(Test-Path -LiteralPath $generation){
    if((Get-Item -LiteralPath $generation).LinkType){throw 'Linked generation refused'}
    $entries=@(Get-ChildItem -LiteralPath $generation -Force)
    if($entries.Count -ne 3 -or @($entries|Where-Object {$_.PSIsContainer -or $_.Name -notin @('gateway.cjs','config.json','manifest.json')}).Count){throw 'Existing incomplete or foreign generation preserved'}
    foreach($name in $files.Keys){if((Hash-File (Join-Path $generation $name)) -cne $files[$name]){throw 'Existing immutable generation differs'}}
    $manifest=Read-Json (Join-Path $generation 'manifest.json')
    if($manifest.schemaVersion -ne 1 -or $manifest.files.Count -ne 2 -or $manifest.files.'config.json' -cne $files.'config.json' -or $manifest.files.'gateway.cjs' -cne $files.'gateway.cjs'){throw 'Existing generation manifest differs'}
  }else{
    New-Item -ItemType Directory -Path $generation|Out-Null
    Copy-Item -LiteralPath (Assert-Regular $selectedGateway) -Destination (Join-Path $generation 'gateway.cjs')
    Write-New (Join-Path $generation 'config.json') $gatewayText
    Write-New (Join-Path $generation 'manifest.json') (Json @{schemaVersion=1;releaseHash=(Hash-Text (Json $files));files=$files})
  }
  $profileBefore=[IO.File]::ReadAllText((Assert-Regular $profileFile));$match=[regex]::Match($profileBefore,'command:\s*("(?:[^"\\]|\\.)*")')
  if(-not $match.Success){throw 'Exact JSON-quoted profile command required'}
  $command=ConvertFrom-Json $match.Groups[1].Value
  $oldNormalized=$oldGateway.Replace('\','/');$newNormalized=$generation.Replace('\','/')
  if(@([regex]::Matches($command,[regex]::Escape($oldNormalized))).Count -ne 2){throw 'Exact gateway and config command references required'}
  $newCommand=$command.Replace($oldNormalized,$newNormalized)
  $profileAfter=$profileBefore.Remove($match.Groups[1].Index,$match.Groups[1].Length).Insert($match.Groups[1].Index,(ConvertTo-Json -InputObject $newCommand -Compress))
  $backup=Join-Path $stateRoot ('backups\workspace-roots\'+$operationId)
  $registry.components.'unified-mcp'.previousRelease=$oldGateway
  $registry.components.'unified-mcp'.releaseRoot=$generation
  $registry.components.'unified-mcp'.entry=Join-Path $generation 'gateway.cjs'
  $registry.components.'unified-mcp'.recovery=$backup
  if($coldMode){$registry.components.'unified-mcp'.entryHash=$selectedGatewaySha}
  $receipt.profileSha256=Hash-Text $profileAfter
  if($coldMode){
    # Capture before the external planned stop; cold absence is later checked against
    # these exact process generations, never against every shared runtime executable.
    $owner=Get-WorkspaceOwnedRuntime 'business-full';$cold.ownership=$owner
    $drain=@{supported=$false;reason='cold_bootstrap_uses_traced_external_handoff';selection=$null}
    $originalConfig=Read-Json $gatewayConfigFile
    $cold.subjects=@{helperEntry=$registry.components.'workspace-host'.entry;tunnelImage=(Join-Path $stateRoot 'workspace-mcp\bin\tunnel-client.exe');tunnelProfile=$profileFile;tunnelAlias='aicc-workspace';gateways=@(@{entry=$gatewayCode;config=$gatewayConfigFile},@{entry=(Join-Path $generation 'gateway.cjs');config=(Join-Path $generation 'config.json')});providers=@($originalConfig.providers|ForEach-Object {@{id=$_.id;entrypoint=$_.entrypoint;command=$_.command}})}
  }else{
    $owner=Get-WorkspaceOwnedRuntime 'business-full'
    $drain=Get-RegisteredDrain $owner
  }
  $maintenanceNonce=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
  $stage=Join-Path $runtimeRoot $operationId;New-Item -ItemType Directory -Path $stage|Out-Null
  $changes=@()
  foreach($entry in @(@{name='config';file=$configFile;text=$workspaceText},@{name='profile';file=$profileFile;text=$profileAfter},@{name='registry';file=$registryFile;text=(Json $registry)},@{name='task-receipt';file=$taskReceipt;text=(Json $receipt)})){
    $candidate=Join-Path $stage ($entry.name+'.after');Write-New $candidate $entry.text
    $changes+=@{name=$entry.name;file=$entry.file;beforeSha256=(Hash-File $entry.file);afterSha256=(Hash-Text $entry.text);candidate=$candidate}
  }
  $scope=@{taskName=$taskName;processes=$owner.processes;changes=@($changes|ForEach-Object { @{file=$_.file;before=$_.beforeSha256;after=$_.afterSha256} });nativeProviderUnchanged=$true;gatewayCodeUnchanged=(-not $coldMode);maintenance=$drain.selection;maintenanceSupported=$drain.supported;transitionMode=$transitionMode;coldBootstrap=$cold}
  $plan=@{transitionMode=$transitionMode;coldBootstrap=$cold;createdAt=[DateTimeOffset]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");maintenance=@{supported=$drain.supported;reason=$drain.reason;selection=$drain.selection;nonce=$maintenanceNonce};schemaVersion=2;operation='workspace-canonical-root-reconcile';operationId=$operationId;challenge=[guid]::NewGuid().ToString('N');expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(30).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");alias='open-aicc';beforeRoot=$handoff.beforeRoot;desiredRoot=$desired;backup=$backup;scopeHash=(Hash-Text (Json $scope));scope=$scope;ownership=$owner;backend=$registry.components.workspace.releaseRoot;node=$registry.components.workspace.runtime;generation=$generation;generationFiles=@{'gateway.cjs'=(Hash-File (Join-Path $generation 'gateway.cjs'));'config.json'=(Hash-File (Join-Path $generation 'config.json'));'manifest.json'=(Hash-File (Join-Path $generation 'manifest.json'))};changes=$changes;resultFile=(Join-Path $stage 'result.json')}
  $output=Join-Path $runtimeRoot ('workspace-root-plan-'+$operationId+'.json');Write-New $output (Json $plan)
  @{status='PREPARED_NOT_APPLIED';transitionMode=$transitionMode;operationId=$operationId;planFile=$output;planSha256=(Hash-File $output);scopeHash=$plan.scopeHash;challenge=$plan.challenge;backup=$backup;expiresAt=$plan.expiresAt;runtimeChanged=$false}|ConvertTo-Json
  return
}
$null=Require-Owned $planPath $runtimeRoot
if([IO.Path]::GetFileName($planPath) -notmatch '^workspace-root-plan-workspace-root-[a-f0-9]{32}\.json$' -or $ExpectedPlanSha256 -notmatch '^[a-f0-9]{64}$' -or (Hash-File $planPath) -cne $ExpectedPlanSha256){throw 'Exact immutable root plan required'}
$plan=Read-Json $planPath
if($plan.schemaVersion -ne 2 -or $plan.operation -cne 'workspace-canonical-root-reconcile' -or $plan.alias -cne 'open-aicc' -or $plan.scope.taskName -cne $taskName){throw 'Unexpected root plan scope'}
$transitionMode=if($plan.transitionMode){[string]$plan.transitionMode}else{'live-scoped'}
if($transitionMode -cnotin @('live-scoped','cold-bootstrap')){throw 'Unexpected transition mode'}
$coldMode=$transitionMode -ceq 'cold-bootstrap'
$pidGuardMode=$plan.kind -ceq 'workspace-pid-reuse-guard'
if($plan.kind -and -not $pidGuardMode){throw 'Unsupported maintenance kind'}
if($pidGuardMode -and $coldMode){throw 'PID guard requires live scoped drain'}
$expectedFiles=@($(if($pidGuardMode){$launcherFile}else{$configFile}),$profileFile,$registryFile,$taskReceipt)|Sort-Object
if(-not (Same (@($plan.changes.file)|Sort-Object) $expectedFiles)){throw 'Plan file set differs from bounded root transaction'}
foreach($change in $plan.changes){$null=Require-Owned $change.candidate $runtimeRoot;if((Hash-File $change.candidate) -cne $change.afterSha256){throw 'Staged file changed'}}
$hashes=@{};foreach($change in $plan.changes){$hashes[$change.name]=Hash-File $change.file}
$allBefore=@($plan.changes|Where-Object {$hashes[$_.name] -cne $_.beforeSha256}).Count -eq 0
$allAfter=@($plan.changes|Where-Object {$hashes[$_.name] -cne $_.afterSha256}).Count -eq 0
$terminal=if(Test-Path -LiteralPath $plan.resultFile){(Read-Json $plan.resultFile).terminal}else{'NOT_DISPATCHED'}
# Re-derive the bounded mutation; an owner-local plan is not an arbitrary file/exec grant.
if($allBefore -and $terminal -ceq 'NOT_DISPATCHED'){
  if($pidGuardMode){$null=Assert-PidGuardPlan $plan}else{
  $currentRegistry=Read-Json $registryFile
  if($plan.backend -ine $currentRegistry.components.workspace.releaseRoot -or $plan.node -ine $currentRegistry.components.workspace.runtime){throw 'Registered backend/runtime changed'}
  $null=Require-Owned (Join-Path $plan.backend 'bin\aicc') (Join-Path $stateRoot 'releases\workspace')
  $configChange=@($plan.changes|Where-Object name -CEQ 'config')
  if($configChange.Count -ne 1){throw 'Single config change required'}
  $expectedConfig=Read-Json $configFile
  $alias=@($expectedConfig.workspaces|Where-Object alias -CEQ 'open-aicc')
  if($alias.Count -ne 1 -or $alias[0].root -ine $plan.beforeRoot){throw 'Alias preimage changed'}
  $desired=(Resolve-Path -LiteralPath $plan.desiredRoot).Path
  if((Get-Item -LiteralPath $desired).LinkType -or -not (Test-Path -LiteralPath (Join-Path $desired '.git'))){throw 'Canonical Git root missing or linked'}
  $alias[0].root=$desired
  if(-not (Same $expectedConfig (Read-Json $configChange[0].candidate))){throw 'Config changes exceed one alias root'}
  $generationConfig=Join-Path $plan.generation 'config.json'
  $null=Require-Owned $generationConfig (Join-Path $stateRoot 'releases\unified-mcp')
  foreach($name in @('config.json','gateway.cjs','manifest.json')){
    if((Hash-File (Join-Path $plan.generation $name)) -cne $plan.generationFiles[$name]){throw 'Immutable generation changed'}
  }
  $oldGateway=$currentRegistry.components.'unified-mcp'.releaseRoot
  if($coldMode){
    $boundArtifact=Read-GatewayArtifact $plan.coldBootstrap.artifact
    if((Hash-File (Join-Path $plan.generation 'gateway.cjs')) -cne $boundArtifact.sha256){throw 'Cold generation differs from approved gateway artifact'}
    $nowTask=Get-TaskDefinition
    if($nowTask.disabledXmlSha256 -cne $plan.coldBootstrap.task.disabledXmlSha256 -or $nowTask.enabledXmlSha256 -cne $plan.coldBootstrap.task.enabledXmlSha256 -or $plan.coldBootstrap.taskRestart.enabled -cne $true -or $plan.coldBootstrap.taskRestart.start -cne $true){throw 'Cold exact Task definition/restart intent changed'}
    $registryCandidate=Read-Json (@($plan.changes|Where-Object name -CEQ 'registry')[0].candidate)
    if($registryCandidate.components.'unified-mcp'.entryHash -cne $boundArtifact.sha256){throw 'Cold registry does not pin the approved gateway artifact'}
  }elseif((Hash-File (Join-Path $plan.generation 'gateway.cjs')) -cne (Hash-File (Join-Path $oldGateway 'gateway.cjs'))){throw 'Gateway code must be reused unchanged'}
  $expectedGateway=Read-Json (Join-Path $oldGateway 'config.json')
  foreach($provider in $expectedGateway.providers){foreach($pin in $provider.files){if((Hash-File $pin.path) -cne $pin.sha256){throw 'Original provider pin changed'}}}
  $wp=@($expectedGateway.providers|Where-Object id -CEQ 'workspace')
  $pins=@($wp[0].files|Where-Object path -IEQ $configFile)
  if($pins.Count -ne 1){throw 'One exact Workspace config pin required'}
  $pins[0].sha256=$configChange[0].afterSha256
  if(-not (Same $expectedGateway (Read-Json $generationConfig))){throw 'Gateway change exceeds one config pin'}
  }
  $allowedBackup=Join-Path $stateRoot ('backups\workspace-roots\'+$plan.operationId)
  $allowedResult=Join-Path $runtimeRoot ($plan.operationId+'\result.json')
  if($plan.backup -ine $allowedBackup -or $plan.resultFile -ine $allowedResult){throw 'Operation backup/result scope changed'}
}
if($Mode -eq 'Status'){
  $ready=$false;$readyHash=$null;$reason='preimage_changed_or_operation_claimed';$coldHandoffSha=$null;$coldStateSha=$null
  if($allBefore -and $terminal -ceq 'NOT_DISPATCHED'){
    try{
      if([DateTimeOffset]::Parse($plan.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'Plan expired'}
      $null=Assert-Ready $plan;$readyHash=Hash-File $RescueReadyFile
      if($coldMode){$coldAck=Assert-ColdHandoff $plan;$coldState=Read-ColdCondition $plan.coldBootstrap;$coldHandoffSha=$coldAck.sha256;$coldStateSha=Hash-Text (Json $coldState)}else{
        if(-not $plan.maintenance.supported -or $plan.maintenance.nonce -notmatch '^[a-f0-9]{64}$'){throw 'shared_toolbridge_admission_drain_not_supported_in_plan'}
        $capability=Get-RegisteredDrain (Get-WorkspaceOwnedRuntime 'business-full') $plan.maintenance.selection
        if(-not $capability.supported){throw $capability.reason}
      }
      $ready=$true;$reason=if($coldMode){'cold_handoff_and_disabled_absent_scope_ready'}else{'prepared_with_rescue_ack'}
    }catch{$reason=$_.Exception.Message}
  }
  @{ready=$ready;reason=$reason;kind=$plan.kind;immutableInputHashes=$(if($pidGuardMode){$plan.scope.inputs}else{$null});transitionMode=$transitionMode;coldHandoffSha256=$coldHandoffSha;coldStateSha256=$coldStateSha;operationId=$plan.operationId;planSha256=$ExpectedPlanSha256;scopeHash=$plan.scopeHash;rescueReadySha256=$readyHash;fileHashes=$hashes;allBefore=$allBefore;allAfter=$allAfter;terminal=$terminal}|ConvertTo-Json -Depth 8
  return
}
if(-not $coldMode -and (-not $plan.maintenance.supported -or $plan.maintenance.nonce -notmatch '^[a-f0-9]{64}$')){throw 'Plan is prepared only: no exact installed shared MCP admission/drain selection; no runtime change dispatched'}
if(-not $allBefore -or $terminal -cne 'NOT_DISPATCHED' -or [DateTimeOffset]::Parse($plan.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'Changed, claimed, or expired plan; no replay'}
if(-not $RequireActionLock){throw 'Use named control-plane preview and one-use execute'}
$actionLock=Read-Json (Join-Path $stateRoot 'action.lock')
$self=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
if($actionLock.action -cne 'workspace.canonical-root-reconcile' -or $actionLock.pid -ne $self.ParentProcessId){throw 'Exact named action writer required'}
$null=Assert-Ready $plan
$registryLock=[IO.File]::Open($registryFile+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$profileLock=$null;$stopped=$false;$stopAttempted=$false;$disabled=$coldMode;$backupReady=$false;$drainConsumed=$false;$filesTouched=0;$taskMayStart=$false
$script:transaction=$null
try{
  $profileLock=[IO.File]::Open($profileFile+'.unified-cutover.lock',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $null=Assert-Ready $plan
  foreach($change in $plan.changes){if((Hash-File $change.file) -cne $change.beforeSha256){throw 'Preimage changed under lock'}}
  if($pidGuardMode){$null=Assert-PidGuardPlan $plan}
  if($coldMode){
    $coldAck=Assert-ColdHandoff $plan;$coldState=Read-ColdCondition $plan.coldBootstrap
  }else{
    $fresh=Get-WorkspaceOwnedRuntime 'business-full'
    if(-not (Same-Structure $fresh $plan.ownership)){throw 'Exact owned process generation changed'}
    $capability=Get-RegisteredDrain $fresh $plan.maintenance.selection
    if(-not $capability.supported){throw $capability.reason}
  }
  New-Item -ItemType Directory -Path $plan.backup|Out-Null
  foreach($change in $plan.changes){Copy-Item -LiteralPath $change.file -Destination (Join-Path $plan.backup ($change.name+'.before'))}
  Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $plan.backup 'task.before.xml') -Encoding utf8
  if(-not $coldMode -and (Get-ScheduledTask -TaskName $taskName).Settings.Enabled -cne $true){throw 'Previously disabled task preserved'}
  $backupReady=$true
  $script:transaction=@{terminal='CLAIMED';transitionMode=$transitionMode;operationId=$plan.operationId;planSha256=$ExpectedPlanSha256;scopeHash=$plan.scopeHash;backup=$plan.backup;maintenanceEvents=@();reconciliationRequired=$false;brokerGlobalIdleClaimed=$false}
  if($coldMode){$script:transaction.coldHandoff=$coldAck;$script:transaction.coldStartState=$coldState;$script:transaction.taskRestartIntent=$plan.coldBootstrap.taskRestart;$script:transaction.originalOutcomesReconciliationRequired=$coldAck.originalOutcomesReconciliationRequired;$script:transaction.reconciliationRequired=$coldAck.originalOutcomesReconciliationRequired}
  Write-New $plan.resultFile (Json $script:transaction)
  if(-not $coldMode){
    $binding=@{operationId=$plan.operationId;nonce=$plan.maintenance.nonce;operationExpiresAt=$plan.expiresAt}
    $consumption=Close-SharedAdmission $capability.selection $binding;$drainConsumed=$true
    $script:transaction.originalDrain=$consumption;Save-Transaction
    Disable-ScheduledTask -TaskName $taskName|Out-Null;$disabled=$true
    $null=Assert-Ready $plan;$null=Read-WorkspaceLeases $plan
    $stillOwned=Get-WorkspaceOwnedRuntime 'business-full'
    if(-not (Same-Structure $stillOwned $fresh)){throw 'Owned process generation changed after consumption'}
    $stopAttempted=$true
    $null=Stop-WorkspaceOwnedRuntime $fresh;$stopped=$true
    Stop-ScheduledTask -TaskName $taskName
  }
  # Cold bootstrap does not stop any runtime to manufacture absence.
  foreach($change in $plan.changes){
    if($coldMode){$null=Read-ColdCondition $plan.coldBootstrap}
    if((Hash-File $change.file) -cne $change.beforeSha256){throw 'File changed before cutover'}
    Set-Atomic $change.file ([IO.File]::ReadAllText($change.candidate));$filesTouched++
  }
  if($coldMode){$null=Read-ColdCondition $plan.coldBootstrap;$null=Assert-Ready $plan}
  $taskMayStart=$true;$script:transaction.taskRestartPhase='ENABLE_START_INTENT';Save-Transaction
  Enable-ScheduledTask -TaskName $taskName|Out-Null;$disabled=$false
  if($coldMode){
    $enabled=Get-TaskDefinition
    if(-not $enabled.enabled -or $enabled.xmlSha256 -cne $plan.coldBootstrap.task.enabledXmlSha256 -or $enabled.state -ceq 'Running'){throw 'Exact Task enable/start boundary changed or another start is already in progress'}
  }
  Start-ScheduledTask -TaskName $taskName
  $script:transaction.taskRestartPhase='START_DISPATCHED';Save-Transaction
  # Admission uses the replacement identity; an old mailbox is never polled after start.
  $admitted=$false;$newCapability=$null
  for($attempt=0;$attempt -lt 20;$attempt++){
    Start-Sleep -Seconds 2
    try{
      $marker=Read-Json (Join-Path $stateRoot 'workspace-mcp\runtime\remote-authority-status.json')
      $owner=Get-WorkspaceOwnedRuntime 'business-full';$newCapability=Get-RegisteredDrain $owner
      $differentOwner=$coldMode -or $owner.instanceId -cne $plan.ownership.instanceId
      $differentMailbox=$coldMode -or $newCapability.selection.instanceDirectory -ine $plan.maintenance.selection.instanceDirectory
      $expectedConfigSha=if($pidGuardMode){$plan.scope.inputs.config}else{($plan.changes|Where-Object name -CEQ 'config').afterSha256}
      $pidPinsMatch=$true
      if($pidGuardMode){
        $registered=Read-Json $registryFile;$c=Read-Json $plan.scope.candidateFile
        $mismatch=@();$lockfile=$plan.scope.expectedLockfile
        if((Hash-File $configFile) -cne $expectedConfigSha){$mismatch+='workspaceConfigSha256'}
        if($registered.components.workspace.releaseRoot -ine $c.backend){$mismatch+='registeredWorkspaceRoot'}
        if($registered.components.'workspace-host'.releaseRoot -ine $c.host){$mismatch+='registeredHostRoot'}
        if($registered.components.'unified-mcp'.releaseRoot -ine $c.gateway){$mismatch+='registeredGatewayRoot'}
        if(-not $marker.installedIdentity.lockfileRealpath -or -not [string]::Equals([IO.Path]::GetFullPath($marker.installedIdentity.lockfileRealpath),$lockfile.realpath,[StringComparison]::OrdinalIgnoreCase)){$mismatch+='installedIdentity.lockfileRealpath'}
        if($marker.installedIdentity.lockfileSha256 -cne $lockfile.sha256){$mismatch+='installedIdentity.lockfileSha256'}
        if((Hash-File $lockfile.realpath) -cne $lockfile.sha256){$mismatch+='candidateLockfile.sha256'}
        foreach($change in $plan.changes){if((Hash-File $change.file) -cne $change.afterSha256){$mismatch+=('file.'+$change.name)}}
        $pidPinsMatch=$mismatch.Count -eq 0
        $script:transaction.admissionObservedPhase=$marker.phase;$script:transaction.admissionMismatchFields=$mismatch;Save-Transaction
      }
      if($marker.phase -ceq 'ready' -and $marker.sourceIdentity.configHash -ceq $expectedConfigSha -and $pidPinsMatch -and $differentOwner -and $newCapability.supported -and $newCapability.selection.configSha256 -ceq $plan.generationFiles.'config.json' -and $differentMailbox -and $newCapability.state.initialized -ceq $true -and -not $newCapability.state.fault){$admitted=$true;break}
    }catch{if($attempt -eq 19){throw}}
  }
  if(-not $admitted){
    if($pidGuardMode -and $script:transaction.admissionObservedPhase -ceq 'ready' -and $script:transaction.admissionMismatchFields.Count){throw ('Ready candidate admission mismatch: '+($script:transaction.admissionMismatchFields -join ','))}
    throw 'Replacement Workspace/shared gateway generation admission unknown'
  }
  $script:transaction.terminal='APPLIED_RUNTIME_ADMITTED';$script:transaction.replacementMaintenance=$newCapability.selection;$script:transaction.generalChatVerified=$false;$script:transaction.completedAt=[DateTimeOffset]::UtcNow.ToString('o');Save-Transaction
  @{ok=$true;terminal='APPLIED_RUNTIME_ADMITTED';transitionMode=$transitionMode;generalChatVerified=$false;originalOutcomesReconciliationRequired=($coldMode -and $coldAck.originalOutcomesReconciliationRequired)}|ConvertTo-Json
}catch{
  $failure=$_.Exception.Message;$restored=$false
  if($coldMode -and $backupReady -and -not $taskMayStart){
    try{
      $null=Read-ColdCondition $plan.coldBootstrap
      Restore-BeforeFiles
      $null=Read-ColdCondition $plan.coldBootstrap
      $restored=$true;$disabled=$true
    }catch{$failure+='; cold starting-point restore refused: '+$_.Exception.Message}
  }elseif(($stopped -or ($coldMode -and $taskMayStart)) -and $backupReady){
    try{
      $null=Assert-Ready $plan
      $currentOwner=Get-WorkspaceOwnedRuntime 'business-full'
      if(-not $coldMode -and $currentOwner.instanceId -ceq $plan.ownership.instanceId){throw 'Replacement process identity is not a new generation'}
      $rollbackCapability=Get-RegisteredDrain $currentOwner
      if(-not $rollbackCapability.supported -or (-not $coldMode -and $rollbackCapability.selection.instanceDirectory -ieq $plan.maintenance.selection.instanceDirectory)){throw 'Replacement scoped drain unavailable; rollback not dispatched'}
      foreach($change in $plan.changes){$h=Hash-File $change.file;if($h -cne $change.beforeSha256 -and $h -cne $change.afterSha256){throw 'Third-party file state changed; rollback refused'}}
      $rollbackBinding=@{operationId=('workspace-rollback-'+[guid]::NewGuid().ToString('N'));nonce=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant();operationExpiresAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")}
      $script:transaction.rollbackSelection=$rollbackCapability.selection;$script:transaction.rollbackBinding=$rollbackBinding;Save-Transaction
      $rollbackConsumption=Close-SharedAdmission $rollbackCapability.selection $rollbackBinding
      $script:transaction.rollbackDrain=$rollbackConsumption;Save-Transaction
      Disable-ScheduledTask -TaskName $taskName|Out-Null;$disabled=$true
      $rollbackOwner=Get-WorkspaceOwnedRuntime 'business-full'
      if(-not (Same-Structure $rollbackOwner $currentOwner)){throw 'Replacement process tree changed before rollback stop'}
      $null=Stop-WorkspaceOwnedRuntime $rollbackOwner
      Stop-ScheduledTask -TaskName $taskName
      if($coldMode){$null=Read-ColdCondition $plan.coldBootstrap}
      Restore-BeforeFiles
      if($coldMode){
        # Rollback restores the externally handed-off disabled/cold starting point.
        $null=Read-ColdCondition $plan.coldBootstrap
      }else{Enable-ScheduledTask -TaskName $taskName|Out-Null;Start-ScheduledTask -TaskName $taskName;$disabled=$false}
      $restored=$true
    }catch{$failure+='; rollback requires independent recovery: '+$_.Exception.Message}
  }elseif($disabled -and -not $coldMode -and -not $stopAttempted -and -not $drainConsumed){
    $sameBefore=@($plan.changes|Where-Object {(Hash-File $_.file) -cne $_.beforeSha256}).Count -eq 0
    if($sameBefore){Enable-ScheduledTask -TaskName $taskName|Out-Null;$disabled=$false}
  }
  if($script:transaction){$script:transaction.terminal=if($restored){'RESTORE_DISPATCHED_NOT_VERIFIED'}else{'HOLD_RECONCILE_REQUIRED'};$script:transaction.failure=$failure;$script:transaction.taskLeftDisabled=$disabled;$script:transaction.reconciliationRequired=$true;Save-Transaction}
  throw $failure
}finally{
  if($profileLock){$profileLock.Dispose();Remove-Item -LiteralPath ($profileFile+'.unified-cutover.lock')}
  $registryLock.Dispose()
}
