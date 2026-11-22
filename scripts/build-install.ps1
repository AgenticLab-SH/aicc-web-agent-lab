param(
    [Parameter(Mandatory = $false)]
    [string]$Serial = ""
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$wrapper = Join-Path $root "gradlew.bat"
if (-not (Test-Path $wrapper)) {
    throw "Gradle wrapper is missing. Restore gradlew.bat and gradle/wrapper from the project sources."
}
$adb = (Get-Command adb -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
if (-not $adb) {
    foreach ($sdk in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk")) {
        if ($sdk -and (Test-Path (Join-Path $sdk "platform-tools\adb.exe"))) {
            $adb = Join-Path $sdk "platform-tools\adb.exe"
            break
        }
    }
}
if (-not $adb) { throw "ADB not found. Install Android SDK Platform Tools first." }

$raw = @(& $adb devices -l)
$connected = @()
foreach ($line in $raw) {
    if ($line -match '^(\S+)\s+device(?:\s|$)') { $connected += $Matches[1] }
}
if ($Serial) {
    if ($Serial -notin $connected) { throw "Requested authorized device not connected: $Serial" }
} elseif ($connected.Count -eq 1) {
    $Serial = $connected[0]
} else {
    throw "Expected exactly one authorized phone, found $($connected.Count). Select with -Serial."
}
Write-Host "Selected ADB device: $Serial"
Push-Location $root
try {
    & $wrapper :app:assembleDebug --no-daemon
    if ($LASTEXITCODE -ne 0) { throw "Gradle build failed; APK not installed." }
    $apk = Join-Path $root "app\build\outputs\apk\debug\app-debug.apk"
    if (-not (Test-Path $apk)) { throw "APK missing after build." }
    & $adb -s $Serial install -r $apk
    if ($LASTEXITCODE -ne 0) { throw "ADB install failed. Check phone approval / package signature." }
    & $adb -s $Serial shell am start -n "com.mysunrise.mobile/.MainActivity"
    if ($LASTEXITCODE -ne 0) { throw "App installed but launch failed; inspect logcat." }
    Write-Host "Installed and opened. Physical alarm/WiZ validation is STILL REQUIRED."
}
finally { Pop-Location }
