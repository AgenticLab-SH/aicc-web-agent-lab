#!/usr/bin/env python3
"""Explicit one-account renewal canary. No inference or local OCX/Desktop writes."""
import argparse
import json
from pathlib import Path
import time

from cycle_watch import Client, atomic_json, credentials, locked, private_path, read_json, renewer, validate_root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--alias', required=True)
    args = parser.parse_args()
    root = validate_root(args.root)
    private_path(root, directory=True)
    with locked(root):
        path = root / 'credentials.json'
        document = read_json(path)
        account = next(row for row in credentials(document) if row['alias'] == args.alias)
        client = Client()
        renew = renewer(document, client, lambda value: atomic_json(path, value))
        renew(account, time.time())
        # A fresh successful usage read proves the persisted replacement is usable.
        stored = next(row for row in credentials(read_json(path)) if row['alias'] == args.alias)
        client.usage(stored)
        print(json.dumps({'alias': args.alias, 'status': 'renewed_and_usage_verified', 'expiresAt': stored['expires']}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 'renewal_canary_failed'}))
        raise SystemExit(1)
