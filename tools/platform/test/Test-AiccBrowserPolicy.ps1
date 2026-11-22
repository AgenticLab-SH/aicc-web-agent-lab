#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$AiccRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path,
    [string]$CoordinationPath = (Join-Path $HOME '.ai-control-center/guidance/coordination.toml'),
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
$checks = [Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    $checks.Add([pscustomobject]@{ name=$Name; ok=$Ok; detail=$Detail }) | Out-Null
}
function Read-Text([string]$RelativePath) {
    $path = Join-Path $AiccRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
    Get-Content -LiteralPath $path -Raw -Encoding UTF8
}
function Read-TomlValue([string]$Path, [string]$Section, [string]$Key) {
    $current = ''
    foreach ($raw in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $raw.Trim()
        if ($line -match '^\[(?<name>[^\]]+)\]$') { $current = $Matches.name; continue }
        if ($current -eq $Section -and $line -match ('^' + [regex]::Escape($Key) + '\s*=\s*"(?<value>[^"]*)"')) { return $Matches.value }
    }
    return ''
}

$macInstaller = Read-Text 'tools/platform/web-automation/Install-SeparatedBrowserAppsOnMac.ps1'
$whaleInstaller = Read-Text 'tools/platform/web-automation/Install-ImportedBrowserAppsOnMac.ps1'
$whaleLauncher = Read-Text 'tools/platform/web-automation/macos/CdpWhaleLauncher.swift'
$statusLauncher = Read-Text 'tools/platform/web-automation/macos/CdpChromeStatusLauncher.swift'
$normalWhaleLauncher = Read-Text 'tools/platform/web-automation/macos/NormalWhaleLauncher.swift'
$badgeInstaller = Read-Text 'tools/platform/web-automation/Install-CdpPortBadgeExtension.ps1'
$identityGuard = Read-Text 'tools/platform/web-automation/Assert-CdpEndpointIdentity.ps1'
$windowsInstaller = Read-Text 'tools/platform/web-automation/Install-SeparatedBrowserAppsOnWindows.ps1'
$windowsChrome = Read-Text 'tools/platform/web-automation/windows/CDPChromeLauncher.cs'
$windowsWhale = Read-Text 'tools/platform/web-automation/windows/CDPWhaleLauncher.cs'
$lease = Read-Text 'tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1'
$dockRegistrar = Read-Text 'tools/platform/web-automation/Register-CdpChromeDockEntriesOnMac.ps1'
$badgeConfig = Read-Text 'tools/platform/web-automation/extensions/aicc-cdp-port-badge/badge-config.js'
$agentOperations = Read-Text 'docs/agent-operations.md'
$resourceLifecycleRunbook = Read-Text 'docs/runbooks/browser-resource-lifecycle.md'
$dormantWhaleRunbook = Read-Text 'docs/runbooks/dormant-whale-recovery.md'
$extensionRoot = Join-Path $AiccRoot 'tools/platform/web-automation/extensions/aicc-cdp-port-badge'

Add-Check 'mac launchers use private AICC profile roots' (
    $macInstaller -match '\.ai-control-center/browser-profiles/chrome/9222/UserData' -and
    $macInstaller -match '\.ai-control-center/browser-profiles/chrome/9223/UserData' -and
    $whaleLauncher -match '\.ai-control-center/browser-profiles/whale/9335/UserData'
) 'macOS profile defaults'
Add-Check 'mac launchers use AICC bundle and plist identity' (
    $macInstaller -match 'com\.aicc\.chrome\.cdp\.9222' -and
    $macInstaller -match 'com\.aicc\.chrome\.cdp\.9223' -and
    $whaleInstaller -match 'com\.aicc\.whale\.cdp\.9335' -and
    $macInstaller -match "Key 'AICCUserData'" -and
    $statusLauncher -match 'AICC\.CdpChromeStatusLauncher'
) 'bundle and plist identity'
Add-Check 'slot 4 uses a role-neutral dedicated Chrome identity' (
    $macInstaller -match 'CDP Chrome 9224' -and
    $macInstaller -match 'com\.aicc\.chrome\.cdp\.9224' -and
    $macInstaller -match "name = 'CDP Chrome 9225'" -and
    $macInstaller -match "bundle = 'com\.aicc\.chrome\.cdp\.9225'" -and
    $macInstaller -match "url = 'chrome://newtab/'" -and
    $macInstaller -match '\[switch\]\$SlotOnly' -and
    $lease -match 'Port 9226 is the separate AICC-owned isolated QA browser' -and
    $lease -match "usage -notmatch '\(\?i\)pending\|disabled\|reserved'" -and
    $lease -match "usage -notmatch '\(\?i\)telegram_admin\|admin_reserved'"
) 'preserves shared 9222/9223, registers 9224/9225, and keeps login-free QA on 9226'
Add-Check '9224 and 9225 Dock registration is exact and bounded' (
    $dockRegistrar -match 'preserved_other_entries = \$true' -and
    $dockRegistrar -match 'com\.aicc\.chrome\.cdp\.9224' -and
    $dockRegistrar -match "bundle = 'com\.aicc\.chrome\.cdp\.9225'" -and
    $dockRegistrar -notmatch 'legacy_(name|bundle|path)' -and
    $dockRegistrar -match '\[switch\]\$RefreshExisting' -and
    $dockRegistrar -match 'matches\.Count -gt 1' -and
    $dockRegistrar -match 'Delete :persistent-apps:\$\{matchIndex\}' -and
    $dockRegistrar -notmatch '\$removeIndices' -and
    $dockRegistrar -notmatch 'com\.google\.Chrome' -and
    $dockRegistrar -notmatch 'Delete :persistent-apps:\$index'
) 'adds or refreshes only exact launcher tiles and preserves the existing Dock order'
Add-Check 'vendor Chrome is the only ordinary Chrome browser surface' (
    $macInstaller -notmatch 'IncludeNormalController|NormalOnly|New-NormalChromeApp' -and
    $macInstaller.Contains("[ordered]@{name='Google Chrome';bundle='com.google.Chrome';path=`$sourceApp}") -and
    $macInstaller -match 'com\.aicc\.whale\.normal' -and
    $macInstaller -match '\[switch\]\$IncludeWhale' -and
    $macInstaller -match 'if \(\$IncludeWhale\) \{ \$normalRecords \+= New-NormalWhaleApp \}' -and
    $macInstaller -match 'Library/Application Support/Naver/Whale' -and
    $normalWhaleLauncher -match '!command\.contains\("--remote-debugging-port="\)' -and
    $normalWhaleLauncher -match 'runningApplications\(withBundleIdentifier: "com\.naver\.Whale"\)' -and
    $normalWhaleLauncher -match 'finishLaunchVerification\(attempt:'
) 'ordinary Chrome uses only the vendor app; the retired AICC normal Chrome controller cannot be recreated'
Add-Check 'optional normal Whale launcher tolerates only transient duplicate forwarders' (
    $normalWhaleLauncher -match 'duplicateSettleAttempts = 20' -and
    $normalWhaleLauncher -match 'duplicateSettleDelay: TimeInterval = 0\.25' -and
    $normalWhaleLauncher -match 'settleDuplicateApplications\(openWhenResolved:' -and
    $normalWhaleLauncher -match '!\$0\.isTerminated' -and
    $normalWhaleLauncher -match '5초 동안'
) 'waits for singleton URL-forwarding processes to exit but still rejects persistent duplicate profiles'
Add-Check 'mac Chromium launchers disable background app keep-alive' (
    $statusLauncher -match '"--disable-background-mode"' -and
    $whaleLauncher -match '"--disable-background-mode"' -and
    $normalWhaleLauncher -match '"--disable-background-mode"'
) 'keeps profile and session behavior while preventing background apps from independently owning the process'
Add-Check 'mac launchers prefer one stable code-signing identity' (
    $macInstaller -match 'AICC_MACOS_CODESIGN_IDENTITY' -and
    $whaleInstaller -match 'AICC_MACOS_CODESIGN_IDENTITY' -and
    $macInstaller -match 'AgenticLab Local Code Signing' -and
    $whaleInstaller -match 'AgenticLab Local Code Signing' -and
    $macInstaller -match 'Configured macOS code-signing identity is unavailable' -and
    $whaleInstaller -match 'Configured macOS code-signing identity is unavailable' -and
    $macInstaller -match 'codesign --force --sign \$codeSigningIdentity' -and
    $whaleInstaller -match 'codesign --force --sign \$codeSigningIdentity'
) 'reuses a local or distribution identity, fails on an explicit missing identity, and keeps ad-hoc only as a portable fallback'
Add-Check 'optional normal Whale idle exit tracks owned all-window identities' (
    $normalWhaleLauncher -match 'beginManagingBrowser\(running\.processIdentifier\)' -and
    $normalWhaleLauncher -match 'CGWindowListCopyWindowInfo\(options, kCGNullWindowID\)' -and
    $normalWhaleLauncher -match '\[\.optionAll, \.excludeDesktopElements\]' -and
    $normalWhaleLauncher -match 'observedBrowserWindowIDs\.intersection\(allIDs\)' -and
    $normalWhaleLauncher -match 'emptyWindowChecksBeforeTermination = 3' -and
    $normalWhaleLauncher -match 'idleTerminationRequested = running\.terminate\(\)'
) 'only a controller-started exact PID exits; hidden and minimized observed window IDs remain present'
Add-Check 'CDP idle exit preserves active targets leases and clients' (
    $statusLauncher -match 'managedBrowserPID == running\.processIdentifier' -and
    $whaleLauncher -match 'managedBrowserPID == pid' -and
    $statusLauncher -match 'observedManagedPage' -and $whaleLauncher -match 'observedManagedPage' -and
    $statusLauncher -match 'AICC_CDP_LEASE_ROOT' -and $whaleLauncher -match 'AICC_CDP_LEASE_ROOT' -and
    $statusLauncher -match 'expires_at_utc' -and $whaleLauncher -match 'expires_at_utc' -and
    $statusLauncher -match 'TCP:ESTABLISHED' -and $whaleLauncher -match 'TCP:ESTABLISHED' -and
    $statusLauncher -match 'emptyPageChecksBeforeTermination = 3' -and
    $whaleLauncher -match 'emptyPageChecksBeforeTermination = 3' -and
    $statusLauncher -match 'idleTerminationRequested = running\.terminate\(\)' -and
    $whaleLauncher -match 'idleTerminationRequested = NSRunningApplication\(processIdentifier: pid\)\?\.terminate\(\)'
) 'fails closed on lease or client uncertainty and does not infer idleness from CPU, RAM, or visibility'
Add-Check 'Chrome Dock Quit stops only its controller-owned exact CDP process' (
    $statusLauncher -match 'func applicationShouldTerminate' -and
    $statusLauncher -match 'let managedBrowserPID' -and
    $statusLauncher -match 'exactManagedBrowser' -and
    $statusLauncher -match 'listenerPIDs\(configuration\.port\) == \[pid\]' -and
    $statusLauncher -match 'listenerIdentityMismatches\(pid, configuration\)\.isEmpty' -and
    $statusLauncher -match 'switch browserWorkState\(configuration, pid: managedBrowserPID\)' -and
    $statusLauncher -match 'waitForManagedBrowserTermination' -and
    $statusLauncher -match '_ = running\.terminate\(\)' -and
    $statusLauncher -match 'kill\(pid, SIGTERM\)' -and
    $statusLauncher -notmatch 'kill\(pid, SIGKILL\)'
) 'explicit Quit preserves adopted or active slots and uses only bounded graceful termination for an owned PID'
Add-Check 'optional Dock opens normal Whale only through its exact controller' (
    $macInstaller -match 'if \(\$IncludeWhale\)' -and
    $macInstaller -match "name='NAVER Whale \(일반\)';bundle='com\.aicc\.whale\.normal'" -and
    $macInstaller -notmatch "name='NAVER Whale';bundle='com\.naver\.Whale';path='/Applications/Whale\.app'" -and
    $normalWhaleLauncher -match 'NSWorkspace\.didLaunchApplicationNotification' -and
    $normalWhaleLauncher -match 'NSWorkspace\.didTerminateApplicationNotification' -and
    $normalWhaleLauncher -match 'Timer\.scheduledTimer'
) 'prevents vendor bundle activation from selecting CDP Whale 9335'
Add-Check 'Whale launcher keeps vendor engine unchanged' (
    $whaleInstaller -match '/Applications/Whale\.app/Contents/MacOS/Whale' -and
    $whaleInstaller -match 'persistent-status-web-handler-vendor-browser-launcher' -and
    $whaleLauncher -match '/Applications/Whale\.app/Contents/MacOS/Whale' -and
    $whaleLauncher -match 'WHALE_CDP_USER_DATA_DIR' -and
    $whaleInstaller -notmatch '/usr/bin/ditto \$sourceApp \$app' -and
    $whaleInstaller -notmatch 'Whale\.real'
) 'lightweight launcher invokes unchanged vendor executable'
Add-Check 'Whale installers are dormant by default' (
    $whaleInstaller.Contains("Where-Object { `$_.bundle -ne 'com.aicc.whale.cdp.9335' }") -and
    $windowsInstaller -match '\[switch\]\$IncludeWhale' -and
    $windowsInstaller.Contains("Where-Object { `$_.port -ne '9335' }") -and
    $windowsInstaller.Contains("'9335' -in `$OnlyPorts") -and
    $badgeInstaller -match '\[switch\]\$IncludeWhale' -and
    $badgeInstaller.Contains("Where-Object { `$_.slot -ne '9335' }") -and
    $badgeInstaller.Contains("'9335' -in `$OnlySlots")
) 'default install and badge workflows do not recreate, wait for, or configure dormant Whale'
Add-Check 'Whale launcher receives web links and HTML documents' (
    $whaleInstaller -match 'CFBundleURLTypes' -and
    $whaleInstaller -match 'CFBundleURLSchemes:0 string http' -and
    $whaleInstaller -match 'CFBundleURLSchemes:1 string https' -and
    $whaleInstaller -match 'CFBundleDocumentTypes' -and
    $whaleInstaller -match 'LSItemContentTypes:0 string public\.html' -and
    $whaleInstaller -match 'NSUserActivityTypeBrowsingWeb' -and
    $whaleLauncher -match 'handleGetURL' -and
    $whaleLauncher -match 'openFiles filenames'
) 'LaunchServices web-handler contract'
Add-Check 'Whale launcher declares macOS media privacy usage' (
    $whaleInstaller -match "key='NSMicrophoneUsageDescription'" -and
    $whaleInstaller -match "key='NSCameraUsageDescription'"
) 'responsible launcher must survive website microphone and camera requests'
Add-Check 'launcher backups cannot shadow the live LaunchServices identity' (
    $whaleInstaller -match '\$lsregister -u \$app' -and
    $whaleInstaller -match '\$backupName = "\$\(Split-Path -Leaf \$app\)\.backup"' -and
    $macInstaller -match '\$lsregister -u \$target' -and
    $macInstaller -match '\$backupName = "\$\(Split-Path -Leaf \$target\)\.backup"'
) 'all macOS launchers unregister before replacement and preserve recovery bundles with a non-.app suffix'
Add-Check 'Chrome launcher replacement refuses a live CDP browser' (
    $macInstaller -match '/usr/sbin/lsof -nP -iTCP:\$\(\$Definition\.port\) -sTCP:LISTEN -t' -and
    $macInstaller -match 'still has an active browser listener' -and
    $macInstaller -match 'close the exact slot before replacing its launcher'
) 'prevents a new controller from attaching to an older browser and losing close-window lifecycle ownership'
Add-Check 'Whale Dock launcher persistently owns status and focuses the exact CDP slot' (
    $whaleLauncher -match 'applicationShouldHandleReopen' -and
    $whaleLauncher -match 'setActivationPolicy\(\.regular\)' -and
    $whaleLauncher -match 'NSRunningApplication\(processIdentifier:' -and
    $whaleLauncher -match 'startMonitor\(\)' -and
    $whaleLauncher -match 'dockTile\.badgeLabel' -and
    $whaleLauncher -match 'hasExpectedIdentity\(pid:' -and
    $whaleLauncher -match '/json/activate/' -and
    $whaleLauncher -match '/json/new\?' -and
    $whaleLauncher -match 'addingPercentEncoding' -and
    $whaleLauncher -notmatch 'URLQueryItem\(name: "url"' -and
    $whaleLauncher -match 'Target activated' -and
    $whaleLauncher -match 'applicationDidBecomeActive' -and
    $whaleLauncher -match 'hasRestorableSession\(\)' -and
    $whaleLauncher -match '--restore-last-session' -and
    $whaleLauncher -match 'chrome://newtab/' -and
    $whaleLauncher -notmatch 'ps.*-axo'
) 'persistent exact-profile Dock controller'
Add-Check 'Whale launcher creates a visible page after an empty session restore' (
    $whaleLauncher -match 'ensurePageAvailable' -and
    $whaleLauncher -match 'existingPageTargetID' -and
    $whaleLauncher -match 'createPageTarget\("chrome://newtab/"\)' -and
    $whaleLauncher -match '"--max-time", "2", "-fsS"' -and
    $whaleLauncher -match 'could not create a page to show'
) 'zero-page listener recovery'
Add-Check 'Whale Dock Quit stops only the exact CDP engine before launcher exit' (
    $whaleLauncher -match 'applicationShouldTerminate' -and
    $whaleLauncher -match 'return \.terminateLater' -and
    $whaleLauncher -match 'hasExpectedIdentity\(pid: listenerPID\)' -and
    $whaleLauncher -match 'kill\(listenerPID, SIGTERM\)' -and
    $whaleLauncher -match 'waitForBrowserTermination' -and
    $whaleLauncher -match 'reply\(toApplicationShouldTerminate: true\)'
) 'verified child shutdown contract'
Add-Check 'background launch uses AICC environment' (
    $statusLauncher -match 'AICC_BACKGROUND_LAUNCH' -and
    $lease -match 'AICC_BACKGROUND_LAUNCH=1' -and
    $statusLauncher -notmatch 'AGENT_HUB_BACKGROUND_LAUNCH'
) 'background launch contract'
Add-Check 'browser resource lifecycle runbook separates Dock and process state' (
    $resourceLifecycleRunbook -match '고정 아이콘' -and
    $resourceLifecycleRunbook -match '실행 점' -and
    $resourceLifecycleRunbook -match '9222' -and $resourceLifecycleRunbook -match '9225' -and
    $resourceLifecycleRunbook -notmatch '-iTCP:9335' -and
    $resourceLifecycleRunbook -match 'active lease' -and
    $resourceLifecycleRunbook -match 'rollback'
) 'operator semantics, per-slot idle policy, active-work preservation, restart, and rollback'
Add-Check 'browser incident runbook preserves link routing and replacement ordering' (
    $resourceLifecycleRunbook -match '일반 링크 무반응' -and
    $resourceLifecycleRunbook -match 'stale headless Chrome' -and
    $resourceLifecycleRunbook -match 'live listener가 남은 상태에서는 launcher bundle을 교체하지 않는다' -and
    $resourceLifecycleRunbook -match '실제 Quit smoke' -and
    $resourceLifecycleRunbook -match 'HTTP와 HTTPS' -and
    $resourceLifecycleRunbook -match 'canonical path가 정확히 하나' -and
    $resourceLifecycleRunbook -match 'SIGKILL.*fallback은 없다'
) 'keeps the documented symptom, ownership, shutdown, replacement, and post-check contract'
Add-Check 'agent entrypoint routes browser incidents to the canonical Chrome runbook' (
    $agentOperations -match 'runbooks/browser-resource-lifecycle\.md' -and
    $agentOperations -match 'Chrome이 기본 브라우저이며 OS handler는 해당 호스트의 현재 설정으로 확인한다' -and
    $agentOperations -match '일반 링크 무반응' -and
    $agentOperations -notmatch '기본 URL handler는 Safari'
) 'prevents future agents from restoring the retired Safari/default-handler assumption'
Add-Check 'dormant Whale recovery is explicit and reversible' (
    $dormantWhaleRunbook -match '자동 선택·설치·실행·대기·fallback하지 않는다' -and
    $dormantWhaleRunbook -match 'Install-SeparatedBrowserAppsOnMac\.ps1 -IncludeWhale' -and
    $dormantWhaleRunbook -match 'Install-ImportedBrowserAppsOnMac\.ps1 -CdpWhaleOnly' -and
    $dormantWhaleRunbook -match 'default_browser_bundle_id' -and
    $dormantWhaleRunbook -match 'com\.google\.Chrome' -and
    $dormantWhaleRunbook -match 'profile/cookie/password/Keychain state는 수정하지 않는다'
) 'support source is retained without keeping Whale in normal selection or wait procedures'
Add-Check 'badge source is canonical and permission minimal' (
    $badgeInstaller -match 'extensions/aicc-cdp-port-badge' -and
    (Test-Path -LiteralPath (Join-Path $extensionRoot 'manifest.json') -PathType Leaf)
) $extensionRoot
Add-Check 'Chrome launcher bounds badge retries and configures the action directly' (
    $statusLauncher -match 'badgeInstallAttempts < 3' -and
    $statusLauncher -notmatch 'method: "Extensions\.loadUnpacked"' -and
    (Read-Text 'tools/platform/web-automation/install-cdp-port-badge-extension.mjs') -notmatch 'connection\.send\("Extensions\.loadUnpacked"' -and
    (Read-Text 'tools/platform/web-automation/install-cdp-port-badge-extension.mjs') -match 'persistent_badge_extension_missing_manual_install_required' -and
    $statusLauncher -match 'chrome\.action\.setBadgeText' -and
    $statusLauncher -match 'chrome\.action\.getBadgeText' -and
    $badgeConfig -match '"9224"' -and $badgeConfig -match '"9225"'
) 'prevents repeated unpacked-extension reloads and supports every persistent Chrome slot'
Add-Check 'every persistent Chrome slot has a numbered launcher icon' (
    $macInstaller -match 'cdp_chrome_9222\.png' -and
    $macInstaller -match 'cdp_chrome_9223\.png' -and
    $macInstaller -match 'cdp_chrome_9224\.png' -and
    $macInstaller -match 'cdp_chrome_9225\.png' -and
    (Test-Path -LiteralPath (Join-Path $AiccRoot 'tools/platform/app-icons/cdp_chrome_9224.png') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $AiccRoot 'tools/platform/app-icons/cdp_chrome_9225.png') -PathType Leaf)
) 'keeps Dock identity readable without relying on color alone'
Add-Check 'Chrome Dock reopen restores an exact minimized CDP window' (
    $statusLauncher -match 'restoreAndActivatePageWindow' -and
    $statusLauncher -match 'Browser\.getWindowBounds' -and
    $statusLauncher -match 'windowState.*minimized' -and
    $statusLauncher -match 'Browser\.setWindowBounds' -and
    $statusLauncher -match 'windowState.*normal'
) 'restores the selected slot before forwarding activation to vendor Chrome'
Add-Check 'Whale badge incompatibility is explicit' (
    (Read-Text 'tools/platform/web-automation/install-cdp-port-badge-extension.mjs') -match 'whale_persistent_badge_not_installed' -and
    $badgeInstaller -match 'badge_status' -and $badgeInstaller -match 'badge_supported'
) 'unsupported is reported, not treated as installed'
if (Test-Path -LiteralPath (Join-Path $extensionRoot 'manifest.json') -PathType Leaf) {
    $manifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'manifest.json') -Raw | ConvertFrom-Json
    $permissions = @($manifest.permissions)
    Add-Check 'badge requests storage only' (
        $manifest.manifest_version -eq 3 -and $manifest.name -eq 'AICC Chrome Identity Badge' -and
        $permissions.Count -eq 1 -and $permissions[0] -eq 'storage' -and
        $null -eq $manifest.host_permissions -and $null -eq $manifest.content_scripts
    ) 'manifest permissions'
}
Add-Check 'identity guard requires exact endpoint and profile' (
    $identityGuard -match 'ExpectedProfileDir explicitly' -and
    $identityGuard -match 'wrong_browser_profile' -and
    $identityGuard -match 'Only loopback HTTP CDP endpoints are allowed'
) 'listener process profile guard'
Add-Check 'Windows launchers use portable AICC state' (
    $windowsInstaller -match '\.ai-control-center\\browser-launchers' -and
    $windowsInstaller -match 'AI Control Center' -and
    $windowsChrome -match 'AICC_ROOT' -and
    $windowsChrome -match 'aicc-cdp-port-badge' -and
    $windowsWhale -match 'SpecialFolder\.UserProfile' -and
    $windowsWhale -match '"\.ai-control-center", "browser-profiles", "whale", "9335"'
) 'Windows source contract; live Windows verification is separate'

if (Test-Path -LiteralPath $CoordinationPath -PathType Leaf) {
    $stateRoot = [IO.Path]::GetFullPath((Join-Path $HOME '.ai-control-center'))
    $slotProfiles = @(1..4 | ForEach-Object { Read-TomlValue $CoordinationPath browser "cdp_slot${_}_profile_dir" })
    $qa = Read-TomlValue $CoordinationPath browser cdp_qa_profile_dir
    $bundle = Read-TomlValue $CoordinationPath browser default_browser_bundle_id
    Add-Check 'private coordination points only to AICC browser state' (
        @($slotProfiles | Where-Object { -not [IO.Path]::GetFullPath($_).StartsWith($stateRoot, [StringComparison]::OrdinalIgnoreCase) }).Count -eq 0 -and
        [IO.Path]::GetFullPath($qa).StartsWith($stateRoot, [StringComparison]::OrdinalIgnoreCase)
    ) $CoordinationPath
    if ($IsWindows) {
        $vendorChrome = Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'
        Add-Check 'private coordination uses installed vendor Google Chrome' (Test-Path -LiteralPath $vendorChrome -PathType Leaf) $vendorChrome
    } else {
        Add-Check 'private coordination uses Google Chrome default bundle' ($bundle -eq 'com.google.Chrome') $bundle
    }
    Add-Check 'private coordination has no active Whale route' (
        -not (Read-TomlValue $CoordinationPath browser cdp_whale_url) -and
        -not (Read-TomlValue $CoordinationPath browser cdp_whale_profile_dir)
    ) $CoordinationPath
} else {
    Add-Check 'private coordination is optional for public checkout' $true 'not installed'
}

$failed = @($checks | Where-Object { -not $_.ok })
$report = [ordered]@{ ok=($failed.Count -eq 0); check_count=$checks.Count; failed_count=$failed.Count; checks=@($checks) }
if ($AsJson) { $report | ConvertTo-Json -Compress -Depth 5 } else { $report | ConvertTo-Json -Depth 5 }
if ($failed.Count) { exit 1 }
