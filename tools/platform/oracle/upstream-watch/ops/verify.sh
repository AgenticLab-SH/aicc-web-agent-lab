#!/usr/bin/env bash
set -euo pipefail
sudo systemctl is-active --quiet open-aicc-upstream-watch.timer
sudo systemctl is-enabled --quiet open-aicc-upstream-watch.timer
sudo test -s /var/lib/open-aicc-upstream-watch/state.json
sudo -u upstream-watch test -r /etc/open-aicc/upstream-watch.json
sudo python3 - <<'PY'
import json
from pathlib import Path
data=json.loads(Path('/var/lib/open-aicc-upstream-watch/state.json').read_text())
assert data['schemaVersion'] == 1
assert data['automaticApply'] is False
assert sum(data['counts'].values()) == len(data['sources'])
print(json.dumps({'VERIFY_OK': True, 'counts': data['counts']}))
PY
