#!/bin/sh
set -eu

SOURCE=/demo/owner/aicc-cycle-source
PROGRAM=/demo/owner/.local/share/aicc-ocx-cycle-watch
STATE=/demo/owner/.local/state/aicc-ocx-cycle-watch
SECRET_DIR=/etc/aicc-ocx-cycle-watch
SYSTEMD=/etc/systemd/system
UNIT=aicc-ocx-cycle-watch

test "$(id -u)" = 0
test -f "$SOURCE/hub_cycle_watch.py"
test -f "$SOURCE/start_paused_cycle.py"
test -f "$SOURCE/cycle_policy.py"
test -f "$SOURCE/aicc-ocx-cycle-watch.service"
test -f "$SOURCE/aicc-ocx-cycle-watch.timer"
test -f "$SECRET_DIR/slack.json"
test -f "$SECRET_DIR/slack-bot-token"

install -d -o ubuntu -g ubuntu -m 0700 "$PROGRAM" "$STATE"
install -o ubuntu -g ubuntu -m 0600 "$SOURCE/hub_cycle_watch.py" "$PROGRAM/hub_cycle_watch.py"
install -o ubuntu -g ubuntu -m 0600 "$SOURCE/start_paused_cycle.py" "$PROGRAM/start_paused_cycle.py"
install -o ubuntu -g ubuntu -m 0600 "$SOURCE/cycle_policy.py" "$PROGRAM/cycle_policy.py"
install -o root -g root -m 0644 "$SOURCE/aicc-ocx-cycle-watch.service" "$SYSTEMD/aicc-ocx-cycle-watch.service"
install -o root -g root -m 0644 "$SOURCE/aicc-ocx-cycle-watch.timer" "$SYSTEMD/aicc-ocx-cycle-watch.timer"

test "$(stat -c %a "$SECRET_DIR/slack-bot-token")" = 600
test "$(stat -c %U "$SECRET_DIR/slack-bot-token")" = root
test "$(stat -c %G "$SECRET_DIR/slack-bot-token")" = root

systemd-analyze verify "$SYSTEMD/aicc-ocx-cycle-watch.service" "$SYSTEMD/aicc-ocx-cycle-watch.timer"
systemctl daemon-reload
systemctl enable --now "$UNIT.timer"
systemctl is-enabled "$UNIT.timer"
systemctl is-active "$UNIT.timer"
