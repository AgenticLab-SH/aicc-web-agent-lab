"""SSH-only credential owner bridge. No prompt, inference or account selection."""
import json, os, pathlib, subprocess, sys

ROOT = pathlib.Path('/demo/owner/.local/share/aicc-ocx-local')
HOME = pathlib.Path('/demo/owner/.opencodex-hub')
BUN = '/demo/owner/.local/opt/bun-1.4.0/bun-linux-aarch64/bun'

def main():
    # stdin is bounded; errors never echo credentials or subprocess output.
    payload = sys.stdin.buffer.read(8193)
    if len(payload) > 8192:
        raise ValueError('request_too_large')
    request = json.loads(payload)
    if request.get('action') not in ('snapshot', 'lease', 'recover'):
        raise ValueError('unsupported_action')
    active = json.loads(pathlib.Path('/demo/owner/.local/share/ocx-window-policy/active.json').read_text())
    package = pathlib.Path(active['root']) / 'node_modules/@bitkyc08/opencodex'
    if active['version'] != '2.77.0-aicc.windows.2' or not package.is_dir():
        raise ValueError('credential_owner_version_changed')
    env = dict(os.environ, OPENCODEX_HOME=str(HOME), CODEX_HOME=str(HOME / 'codex-runtime'), AICC_OCX_PACKAGE_ROOT=str(package))
    # A lost PC connection must not kill a server refresh after the grant was sent.
    # OCX owns its refresh timeouts/file lock; its child survives the SSH session.
    result = subprocess.run([BUN, str(ROOT / 'local-broker.mjs')], input=payload,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
    if result.returncode or len(result.stdout) > 262144:
        raise ValueError('credential_owner_unavailable')
    response = json.loads(result.stdout)
    sys.stdout.write(json.dumps(response, separators=(',', ':')))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stdout.write('{"ok":false,"error":"credential_owner_unavailable"}')
        sys.exit(2)
