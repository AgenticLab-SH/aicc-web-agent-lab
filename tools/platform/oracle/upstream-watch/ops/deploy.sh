#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
release_id="${UPSTREAM_WATCH_RELEASE_ID:?UPSTREAM_WATCH_RELEASE_ID is required}"
release="/opt/open-aicc-upstream-watch/releases/$release_id"
current=/opt/open-aicc-upstream-watch/current
previous=/opt/open-aicc-upstream-watch/previous

rollback() {
  if [ -L "$previous" ]; then sudo ln -sfn "$(sudo readlink -f "$previous")" "$current"; fi
  if sudo test -f /etc/open-aicc/upstream-watch.json.previous; then
    sudo cp -p /etc/open-aicc/upstream-watch.json.previous /etc/open-aicc/upstream-watch.json
  fi
  sudo systemctl daemon-reload || true
  sudo systemctl start open-aicc-upstream-watch.timer || true
}
trap rollback ERR

sudo install -d -m 0755 /opt/open-aicc-upstream-watch/releases
if ! getent passwd upstream-watch >/dev/null; then
  sudo useradd --system --home-dir /var/lib/open-aicc-upstream-watch --shell /usr/sbin/nologin upstream-watch
fi
sudo install -d -o upstream-watch -g upstream-watch -m 0700 /var/lib/open-aicc-upstream-watch
sudo install -d -o root -g upstream-watch -m 0750 /etc/open-aicc
sudo install -d -o root -g root -m 0755 "$release"
if [ -L "$current" ]; then sudo ln -sfn "$(sudo readlink -f "$current")" "$previous"; fi
if sudo test -f /etc/open-aicc/upstream-watch.json; then
  sudo cp -p /etc/open-aicc/upstream-watch.json /etc/open-aicc/upstream-watch.json.previous
fi
sudo install -o root -g root -m 0755 "$root/upstream_watch.py" "$release/upstream_watch.py"
sudo install -o root -g upstream-watch -m 0640 "$root/upstream-watch.json" /etc/open-aicc/upstream-watch.json
sudo install -o root -g root -m 0644 "$root/open-aicc-upstream-watch.service" /etc/systemd/system/open-aicc-upstream-watch.service
sudo install -o root -g root -m 0644 "$root/open-aicc-upstream-watch.timer" /etc/systemd/system/open-aicc-upstream-watch.timer
sudo ln -sfn "$release" "$current"
sudo systemctl daemon-reload
sudo systemctl enable --now open-aicc-upstream-watch.timer
sudo systemctl start open-aicc-upstream-watch.service
sudo systemctl is-active --quiet open-aicc-upstream-watch.timer
sudo test -s /var/lib/open-aicc-upstream-watch/state.json
trap - ERR
echo DEPLOY_OK
