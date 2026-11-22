#!/usr/bin/env python3
"""External, code-only OCX snapshots. Never copies or restores account homes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
import uuid


def digest_tree(root):
    root = Path(root).resolve()
    items = []
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            target = path.resolve()
            if not target.is_relative_to(root):
                raise RuntimeError('external_package_link_refused')
            items.append([relative, 'link', os.readlink(path)])
        elif path.is_file():
            items.append([relative, 'file', hashlib.sha256(path.read_bytes()).hexdigest()])
    return hashlib.sha256(json.dumps(items, separators=(',', ':')).encode()).hexdigest()


def validate_root(root):
    root = Path(root).absolute()
    if root.parts[-3:] != ('.bun', 'install', 'global') or root.is_symlink():
        raise RuntimeError('exact_bun_global_root_required')
    package = root / 'node_modules/@bitkyc08/opencodex'
    global_manifest = json.loads((root / 'package.json').read_text(encoding='utf-8'))
    if set(global_manifest.get('dependencies', {})) != {'@bitkyc08/opencodex'}:
        raise RuntimeError('global_root_contains_unrelated_packages')
    version = json.loads((package / 'package.json').read_text(encoding='utf-8'))['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version):
        raise RuntimeError('invalid_package_version')
    if not (package / 'bin/ocx.mjs').is_file():
        raise RuntimeError('original_cli_missing')
    return root, version


def snapshot(root, store):
    root, version = validate_root(root)
    store = Path(store).absolute()
    if store.is_relative_to(root) or root.is_relative_to(store):
        raise RuntimeError('snapshot_store_must_be_separate')
    before = digest_tree(root)
    key = version + '-' + before[:16]
    target = store / key
    store.mkdir(parents=True, exist_ok=True, mode=0o700)
    if target.exists():
        manifest = json.loads((target / 'manifest.json').read_text(encoding='utf-8'))
        if manifest.get('sha256') != before or digest_tree(target / 'global') != before:
            raise RuntimeError('existing_snapshot_corrupt')
    else:
        staging = store / ('.stage-' + uuid.uuid4().hex)
        staging.mkdir(mode=0o700)
        shutil.copytree(root, staging / 'global', symlinks=True)
        if digest_tree(root) != before or digest_tree(staging / 'global') != before:
            raise RuntimeError('package_changed_during_snapshot')
        manifest = {'schemaVersion': 1, 'version': version, 'sha256': before,
                    'scope': 'bun-global-software-only', 'accountHomesIncluded': False}
        (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        staging.rename(target)
    return {'terminal': 'SNAPSHOT_VERIFIED', 'snapshot': key, **manifest}


def assert_offline(port):
    # This check supplements the native service-stop proof supplied by the wrapper.
    for _ in range(5):
        if os.name == 'nt':
            # A closed Windows loopback port can time out with WSAEWOULDBLOCK.
            # Ask the kernel listener table; do not interpret that timeout as idle.
            command = Path(os.environ['SystemRoot']) / 'System32/netstat.exe'
            result = subprocess.run([str(command), '-ano', '-p', 'tcp'],
                                    capture_output=True, text=True, timeout=10)
            assert_windows_listener_table(result.returncode, result.stdout, port)
            time.sleep(0.2)
            continue
        with socket.socket() as connection:
            connection.settimeout(2)
            code = connection.connect_ex(('127.0.0.1', port))
        if code not in (10061, 111):
            raise RuntimeError('runtime_live_or_unknown')
        time.sleep(0.2)


def assert_windows_listener_table(code, output, port):
    if code != 0:
        raise RuntimeError('runtime_live_or_unknown')
    rows = [line.split() for line in output.splitlines() if line.strip().startswith('TCP ')]
    if not rows or any(len(row) != 5 or not row[1].rsplit(':', 1)[-1].isdigit() for row in rows):
        raise RuntimeError('runtime_live_or_unknown')
    for row in rows:
        if int(row[1].rsplit(':', 1)[-1]) == port and row[3] == 'LISTENING':
            raise RuntimeError('runtime_live_or_unknown')
        if row[3] not in ('LISTENING', 'ESTABLISHED', 'SYN_SENT', 'SYN_RECEIVED',
                          'FIN_WAIT_1', 'FIN_WAIT_2', 'CLOSE_WAIT', 'CLOSING',
                          'LAST_ACK', 'TIME_WAIT', 'DELETE_TCB'):
            raise RuntimeError('runtime_live_or_unknown')


def restore(root, store, key, expected, port, commit=False):
    root, current = validate_root(root)
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-[a-f0-9]{16}', key or ''):
        raise RuntimeError('exact_snapshot_required')
    target = Path(store).absolute() / key
    manifest = json.loads((target / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('scope') != 'bun-global-software-only' or manifest.get('accountHomesIncluded') is not False:
        raise RuntimeError('snapshot_scope_refused')
    sha = manifest['sha256']
    if digest_tree(target / 'global') != sha:
        raise RuntimeError('snapshot_corrupt')
    if digest_tree(root) != expected:
        raise RuntimeError('current_package_changed')
    outcome = {'terminal': 'RESTORE_PREVIEW', 'currentVersion': current,
               'targetVersion': manifest['version'], 'accountStateRestored': False}
    if not commit:
        return outcome
    assert_offline(port)
    staging = root.parent / ('.restore-' + uuid.uuid4().hex)
    shutil.copytree(target / 'global', staging, symlinks=True)
    if digest_tree(staging) != sha or digest_tree(root) != expected:
        raise RuntimeError('restore_preimage_changed')
    assert_offline(port)
    previous = root.parent / ('global.pre-restore-' + uuid.uuid4().hex)
    root.rename(previous)
    try:
        staging.rename(root)
        if digest_tree(root) != sha:
            raise RuntimeError('restore_postread_failed')
    except Exception:
        if root.exists():
            root.rename(root.parent / ('global.failed-' + uuid.uuid4().hex))
        previous.rename(root)
        raise
    return {**outcome, 'terminal': 'RESTORED_OFFLINE', 'sha256': sha,
            'previousSoftware': str(previous), 'restartRequired': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('status', 'snapshot', 'restore'))
    parser.add_argument('--root', required=True)
    parser.add_argument('--store', required=True)
    parser.add_argument('--snapshot')
    parser.add_argument('--expected-sha256')
    parser.add_argument('--port', type=int, default=10100)
    parser.add_argument('--commit', action='store_true')
    args = parser.parse_args()
    if args.action == 'snapshot':
        if args.commit or args.snapshot or args.expected_sha256:
            parser.error('snapshot does not accept restore arguments')
        result = snapshot(args.root, args.store)
    elif args.action == 'restore':
        if not re.fullmatch(r'[a-f0-9]{64}', args.expected_sha256 or ''):
            parser.error('exact current package digest required')
        result = restore(args.root, args.store, args.snapshot, args.expected_sha256, args.port, args.commit)
    else:
        root, version = validate_root(args.root)
        result = {'version': version, 'sha256': digest_tree(root),
                  'snapshots': sorted(p.name for p in Path(args.store).glob('*') if (p / 'manifest.json').is_file()),
                  'accountHomesIncluded': False}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
