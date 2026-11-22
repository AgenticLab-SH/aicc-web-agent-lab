#!/usr/bin/env python3
"""Explicit fresh credential enrollment over verified SSH stdin, never argv/logs."""
import argparse
import json
from pathlib import Path
import sys

from cycle_watch import atomic_json, credentials, locked, private_path, validate_root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--expect-count', type=int, required=True)
    args = parser.parse_args()
    root = validate_root(args.root)
    private_path(root, directory=True)
    with locked(root):
        path = root / 'credentials.json'
        if path.exists() or path.is_symlink():
            raise ValueError('existing_enrollment_refused')
        raw = sys.stdin.buffer.read(131073)
        if len(raw) > 131072:
            raise ValueError('input_too_large')
        value = json.loads(raw)
        accounts = credentials(value)
        if len(accounts) != args.expect_count:
            raise ValueError('account_count_mismatch')
        atomic_json(path, value)
        print(json.dumps({'status': 'enrolled', 'count': len(accounts)}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 'enrollment_failed'}))
        raise SystemExit(1)
