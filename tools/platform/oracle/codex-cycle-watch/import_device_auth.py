#!/usr/bin/env python3
"""Import one fresh server-side Codex device login into an existing watcher alias."""
import argparse
import copy
import json
from pathlib import Path
import time

from cycle_watch import (
    Client, WatchError, atomic_json, credentials, dormant, load_state, locked,
    private_path, read_json, validate_root,
)


def source_path(value: Path, alias: str) -> Path:
    path = value.resolve()
    expected = Path.home() / ".aicc-a1-reauth" / alias / "auth.json"
    if path != expected or path.is_symlink():
        raise WatchError("invalid_reauth_source")
    return path


def candidate_from_auth(alias: str, auth: dict) -> dict:
    tokens = auth.get("tokens") if isinstance(auth, dict) else None
    if not isinstance(tokens, dict):
        raise WatchError("invalid_reauth_source")
    row = {
        "alias": alias,
        "accessToken": tokens.get("access_token"),
        "chatgptAccountId": tokens.get("account_id"),
        "refreshToken": tokens.get("refresh_token"),
    }
    if not all(isinstance(row[key], str) and row[key] for key in
               ("accessToken", "chatgptAccountId", "refreshToken")):
        raise WatchError("invalid_reauth_source")
    return credentials({"version": 1, "accounts": [row]})[0]


def validate_provenance(document: dict) -> dict:
    if not isinstance(document, dict) or set(document) != {"version", "accounts"}:
        raise WatchError("invalid_provenance")
    accounts = document.get("accounts")
    if document.get("version") != 1 or not isinstance(accounts, dict) or len(accounts) > 16:
        raise WatchError("invalid_provenance")
    for alias, row in accounts.items():
        if (not isinstance(alias, str) or not isinstance(row, dict)
                or set(row) != {"method", "identity", "verifiedAt"}
                or row.get("method") != "server_device_auth"
                or not isinstance(row.get("identity"), str) or len(row["identity"]) != 64
                or any(char not in "0123456789abcdef" for char in row["identity"])
                or not isinstance(row.get("verifiedAt"), (int, float))
                or isinstance(row.get("verifiedAt"), bool) or row["verifiedAt"] <= 0):
            raise WatchError("invalid_provenance")
    return document


def provenance_with_import(document: dict, alias: str, identity: str, verified_at: float) -> dict:
    validate_provenance(document)
    updated = copy.deepcopy(document)
    updated["accounts"][alias] = {
        "method": "server_device_auth",
        "identity": identity,
        "verifiedAt": int(verified_at),
    }
    validate_provenance(updated)
    return updated


def migrate(alias: str, credential_document: dict, state: dict,
            candidate: dict, sample: dict, now: float) -> tuple[dict, dict]:
    enrolled = {row["alias"]: row for row in credentials(credential_document)}
    current = enrolled.get(alias)
    if current is None:
        raise WatchError("unknown_alias")
    previous = state["accounts"].get(alias)
    if not isinstance(previous, dict) or previous.get("identity") != current["identity"]:
        raise WatchError("state_identity_mismatch")
    if "attempt" in previous:
        raise WatchError("pending_attempt_refused")
    if candidate["identity"] != current["identity"]:
        raise WatchError("identity_changed")
    if candidate["expires"] <= now + 300:
        raise WatchError("fresh_credential_required")

    updated_credentials = copy.deepcopy(credential_document)
    target = next(row for row in updated_credentials["accounts"] if row["alias"] == alias)
    target["accessToken"] = candidate["accessToken"]
    target["refreshToken"] = candidate["refreshToken"]
    target["chatgptAccountId"] = candidate["chatgptAccountId"]
    credentials(updated_credentials)

    updated_state = copy.deepcopy(state)
    row = updated_state["accounts"][alias]
    row["identity"] = candidate["identity"]
    row["sample"] = sample
    row["failures"] = 0
    row["nextPollAt"] = sample["at"] + 120
    row["status"] = "confirming_dormant" if dormant(sample) else "watching"
    return updated_credentials, updated_state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--alias", required=True)
    parser.add_argument("--source", required=True, type=Path)
    args = parser.parse_args()
    root = validate_root(args.root)
    private_path(root, directory=True)
    source = source_path(args.source, args.alias)
    private_path(source)

    with locked(root):
        credential_path = root / "credentials.json"
        state_path = root / "state.json"
        provenance_path = root / "credential-provenance.json"
        old_credentials = read_json(credential_path)
        old_state = load_state(root)
        old_provenance = (read_json(provenance_path)
                          if provenance_path.exists() or provenance_path.is_symlink()
                          else {"version": 1, "accounts": {}})
        candidate = candidate_from_auth(args.alias, read_json(source))
        now = time.time()
        sample = Client().usage(candidate)
        updated_credentials, updated_state = migrate(
            args.alias, old_credentials, old_state, candidate, sample, now
        )
        updated_provenance = provenance_with_import(
            old_provenance, args.alias, candidate["identity"], sample["at"]
        )
        wrote_credentials = False
        try:
            atomic_json(credential_path, updated_credentials)
            wrote_credentials = True
            atomic_json(state_path, updated_state)
            atomic_json(provenance_path, updated_provenance)
            stored = {row["alias"]: row for row in credentials(read_json(credential_path))}
            verified_state = load_state(root)
            verified_provenance = read_json(provenance_path)
            if stored[args.alias]["identity"] != candidate["identity"]:
                raise WatchError("credential_readback_failed")
            if verified_state["accounts"][args.alias]["identity"] != candidate["identity"]:
                raise WatchError("state_readback_failed")
            if verified_provenance != updated_provenance:
                raise WatchError("provenance_readback_failed")
        except Exception:
            if wrote_credentials:
                atomic_json(credential_path, old_credentials)
            atomic_json(state_path, old_state)
            atomic_json(provenance_path, old_provenance)
            raise

        print(json.dumps({
            "alias": args.alias,
            "status": "device_auth_imported_and_usage_verified",
            "expiresAt": candidate["expires"],
            "weeklyUsedPercent": sample["used"],
            "weeklyResetAt": sample["deadline"],
        }))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (WatchError, OSError, ValueError, TypeError, KeyError):
        print(json.dumps({"status": "blocked", "reason": "inspect_protected_configuration_or_runtime"}))
        raise SystemExit(1)
