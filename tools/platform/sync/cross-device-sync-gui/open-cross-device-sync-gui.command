#!/bin/zsh
set -euo pipefail
aicc_root="${AICC_ROOT:-${0:A:h:h:h:h:h}}"
exec pwsh -NoProfile -File "$aicc_root/tools/platform/sync/cross-device-sync-gui/Open-CrossDeviceSyncGui.ps1" -ScanNow
