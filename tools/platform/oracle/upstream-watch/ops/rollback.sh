#!/usr/bin/env bash
set -euo pipefail

current=/opt/open-aicc-upstream-watch/current
previous=/opt/open-aicc-upstream-watch/previous
if [ ! -L "$previous" ]; then
  echo ROLLBACK_NOT_AVAILABLE
  exit 2
fi
sudo ln -sfn "$(sudo readlink -f "$previous")" "$current"
if sudo test -f /etc/open-aicc/upstream-watch.json.previous; then
  sudo cp -p /etc/open-aicc/upstream-watch.json.previous /etc/open-aicc/upstream-watch.json
fi
sudo systemctl daemon-reload
sudo systemctl start open-aicc-upstream-watch.timer
sudo systemctl start open-aicc-upstream-watch.service
sudo systemctl is-active --quiet open-aicc-upstream-watch.timer
sudo test -s /var/lib/open-aicc-upstream-watch/state.json
echo ROLLBACK_OK
