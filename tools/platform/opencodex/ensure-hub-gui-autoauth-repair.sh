#!/bin/sh
set -eu
out=$(/usr/bin/python3 "$HOME/.local/bin/aicc-ocx-gui-autoauth-patch.py")
printf '%s\n' "$out"
case "$out" in
  *'"changed": true'*)
    systemctl --user restart opencodex-proxy.service
    ;;
esac
