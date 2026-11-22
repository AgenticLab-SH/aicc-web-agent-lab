"""Two-target updater's A1 half; reuse stock update and code-only rollback."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import native_versions as versions
import hub_accounts as hub

ROOT = Path.home() / '.bun/install/global'
STORE = Path.home() / '.local/share/ocx-native/versions'
UNIT = Path.home() / '.config/systemd/user/opencodex-proxy.service'


def status():
    _, version = versions.validate_root(ROOT)
    runtime = hub.recover_hub(False)  # Attestation only; never starts an off hub.
    if runtime['terminal'] != 'PASS':
        return {'version': version, 'running': False, 'activeTurns': None}
    memory = hub.native_cli('system', 'status', '--json')['memory']
    package = hub.registered_package()
    custom = package != hub.PACKAGE
    policy=json.loads(hub.POLICY_REGISTRY.read_text()) if custom else None
    return {'version': runtime['version'] if custom else version, 'upstreamVersion': policy['upstreamVersion'] if custom else version,
            'windowPolicyActive': custom, 'running': True, 'runtimeVersion': runtime['version'],
            'activeTurns': memory['activeTurnCount'], 'draining': memory['isDraining']}


def assert_idle(state, version):
    if (state.get('version') != version or state.get('runtimeVersion') != version
            or state.get('running') is not True or state.get('activeTurns') != 0
            or state.get('draining') is not False):
        raise RuntimeError('hub_changed_busy_or_intentionally_off')


def update(expected, target):
    if hub.registered_package() != hub.PACKAGE:
        raise RuntimeError('reviewed_window_policy_must_be_rebuilt_before_stock_update')
    assert_idle(status(), expected)
    saved = versions.snapshot(ROOT, STORE)
    unit_before = UNIT.read_bytes()
    # Only config backup; no token/account stores are copied or restored.
    backup = STORE.parent / 'recovery' / ('update-' + str(time.time_ns()))
    backup.mkdir(parents=True, mode=0o700)
    for source in (UNIT, hub.CONFIG):
        destination = backup / source.name
        destination.write_bytes(source.read_bytes())
        destination.chmod(0o600)
    assert_idle(status(), expected)
    env = dict(os.environ, OPENCODEX_HOME=str(hub.CONFIG.parent), CODEX_HOME=str(hub.CONFIG.parent / 'codex-runtime'))
    env['PATH'] = str(Path(hub.BUN).parent) + ':' + str(Path.home() / '.local/share/ocx-native/runtime/node-v22.23.2-linux-arm64/bin') + ':' + env.get('PATH', '')
    # Stock updater resolves the concrete registry version, owns stop/drain and service restart.
    try:
        result = subprocess.run([hub.BUN, str(hub.PACKAGE / 'src/cli/index.ts'), 'update', '--tag', 'latest'],
                                env=env, capture_output=True, timeout=300)
        if result.returncode:
            raise RuntimeError('stock_hub_update_failed')
        state = status()
        if state.get('version') != target or state.get('runtimeVersion') != target or state.get('running') is not True:
            raise RuntimeError('hub_update_version_or_readiness_unconfirmed')
        return {'terminal': 'PASS_UPDATED', **state, 'snapshot': saved['snapshot'], 'accountStateRestored': False}
    except Exception:
        # Fail closed if the service is live/unknown. Never kill a foreign or busy owner.
        pid = subprocess.run(['systemctl', '--user', 'show', 'opencodex-proxy.service', '--property=MainPID', '--value'], capture_output=True, text=True, timeout=10)
        if pid.returncode or pid.stdout.strip() != '0' or UNIT.read_bytes() != unit_before:
            raise RuntimeError('hub_update_unconfirmed_live_owner_preserved')
        current_digest = versions.digest_tree(ROOT)
        versions.restore(ROOT, STORE, saved['snapshot'], current_digest, 10100, True)
        recovered = hub.recover_hub(True)
        if recovered['terminal'] != 'PASS' or recovered.get('version') != expected:
            raise RuntimeError('hub_rollback_restart_unconfirmed')
        return {'terminal': 'ROLLED_BACK', 'version': expected, 'snapshot': saved['snapshot'], 'accountStateRestored': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('status', 'snapshot', 'update'))
    parser.add_argument('--expected')
    parser.add_argument('--target')
    args = parser.parse_args()
    if args.action == 'status':
        result = {'terminal': 'PASS', **status()}
    elif args.action == 'snapshot':
        result = versions.snapshot(ROOT, STORE)
    else:
        if not all(re.fullmatch(r'\d+\.\d+\.\d+', value or '') for value in (args.expected, args.target)):
            raise RuntimeError('exact_stable_versions_required')
        result = update(args.expected, args.target)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'terminal': 'HOLD', 'reason': str(error) if isinstance(error, RuntimeError) else 'hub_update_unconfirmed', 'requestReplay': False}))
        raise SystemExit(1)
