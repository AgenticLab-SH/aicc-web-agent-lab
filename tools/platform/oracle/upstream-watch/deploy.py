#!/usr/bin/env python3
"""Deploy the bounded observer through an existing Oracle A1 bastion."""

from __future__ import annotations

import argparse
import shlex
import subprocess
import tarfile
import tempfile
from pathlib import Path

from oracle_a1_connection import load_bastion_config, remote_contract_prelude


HERE = Path(__file__).resolve().parent
BUNDLE_FILES = {
    HERE / "upstream_watch.py": "upstream_watch.py",
    HERE / "ops" / "deploy.sh": "deploy.sh",
    HERE / "ops" / "verify.sh": "verify.sh",
    HERE / "ops" / "rollback.sh": "rollback.sh",
    HERE / "systemd" / "open-aicc-upstream-watch.service": "open-aicc-upstream-watch.service",
    HERE / "systemd" / "open-aicc-upstream-watch.timer": "open-aicc-upstream-watch.timer",
}


def command(args: list[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(args, input=input_text, text=True, capture_output=True, check=True)
    return result.stdout


def create_bundle(manifest: Path, output: Path) -> None:
    with tarfile.open(output, "w:gz") as archive:
        for source, name in BUNDLE_FILES.items():
            archive.add(source, arcname=name)
        archive.add(manifest, arcname="upstream-watch.json")


def deploy(config: dict[str, str], bundle: Path, release_id: str) -> str:
    identity = str(Path(config["identity_file"]).expanduser())
    remote_bundle = f"/tmp/open-aicc-upstream-watch-{release_id}.tgz"
    command(["scp", "-q", "-i", identity, str(bundle), f"{config['bastion_target']}:{remote_bundle}"])
    remote_dir = f"/tmp/open-aicc-upstream-watch-{release_id}"
    script = f"""set -euo pipefail
trap 'rm -f {shlex.quote(remote_bundle)}' EXIT
{remote_contract_prelude()}
"$A1_CONNECTION" copy-to -- {shlex.quote(remote_bundle)} {shlex.quote(remote_bundle)}
"$A1_CONNECTION" exec -- bash -s <<'REMOTE'
set -euo pipefail
release_id={shlex.quote(release_id)}
bundle={shlex.quote(remote_bundle)}
work={shlex.quote(remote_dir)}
trap 'rm -rf "$work"; rm -f "$bundle"' EXIT
mkdir -p "$work"
tar -xzf "$bundle" -C "$work"
UPSTREAM_WATCH_RELEASE_ID="$release_id" bash "$work/deploy.sh"
bash "$work/verify.sh"
REMOTE
"""
    return command([
        "ssh", "-i", identity, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
        config["bastion_target"], "bash", "-s",
    ], input_text=script)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--connection-config", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.apply:
        print("WHAT_IF: no Oracle mutation; add --apply after local tests and server audit")
        return 0
    config = load_bastion_config(args.connection_config.expanduser())
    with tempfile.TemporaryDirectory() as temporary:
        bundle = Path(temporary) / "upstream-watch.tgz"
        create_bundle(args.manifest, bundle)
        output = deploy(config, bundle, args.release_id)
    safe = [line for line in output.splitlines() if not any(word in line.lower() for word in ("token", "host=", "ip=", "identity"))]
    print("\n".join(safe))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
