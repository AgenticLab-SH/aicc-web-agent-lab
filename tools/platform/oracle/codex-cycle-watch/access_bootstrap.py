#!/usr/bin/env python3
"""Receipt-bound temporary Oracle Bastion bootstrap. Never creates VMs or IAM."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

MARKER = "aicc-oracle-access-v1"


def root_path(value):
    root = Path(value)
    if not root.is_absolute() or root.name != "aicc-oracle-access" or ".." in root.parts:
        raise ValueError("exact_root_required")
    if any(p.is_symlink() for p in [root, *root.parents]):
        raise ValueError("symlink_refused")
    return root


def private(path):
    info = path.lstat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077 or path.is_symlink():
        raise ValueError("private_storage_required")


def save(root, value):
    private(root)
    fd, tmp = tempfile.mkstemp(dir=root)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, root / "receipt.json")
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def cli(*args):
    result = subprocess.run(["oci", *args, "--output", "json"], capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError("oci_request_failed")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def config_with_bastion(before, enabled):
    result = {"areAllPluginsDisabled": before["are-all-plugins-disabled"],
              "isManagementDisabled": before["is-management-disabled"],
              "isMonitoringDisabled": before["is-monitoring-disabled"]}
    plugins = [{"name": p["name"], "desiredState": p["desired-state"]}
               for p in before.get("plugins-config") or [] if p["name"] != "Bastion"]
    plugins.append({"name": "Bastion", "desiredState": "ENABLED" if enabled else "DISABLED"})
    result["pluginsConfig"] = plugins
    return result


def check_agent_drift(before, current):
    def normalize(config):
        value = config_with_bastion(config, False)
        value["pluginsConfig"].sort(key=lambda p: p["name"])
        return value
    if normalize(before) != normalize(current):
        raise ValueError("agent_config_changed")


def owned_bastions(receipt):
    data = cli("bastion", "bastion", "list", "--compartment-id", receipt["compartment"], "--all").get("data", [])
    return [x for x in data if x.get("freeform-tags", {}).get("aicc-operation") == MARKER
            and x.get("target-subnet-id") == receipt["subnet"] and x["lifecycle-state"] != "DELETED"]


def stop(receipt, dry=False):
    bastions = owned_bastions(receipt)
    if len(bastions) > 1:
        raise ValueError("ambiguous_owned_resource")
    for bastion in bastions:
        sessions = cli("bastion", "session", "list", "--bastion-id", bastion["id"], "--all").get("data", [])
        for session in sessions:
            if session["lifecycle-state"] not in ("DELETED", "DELETING"):
                if session.get("display-name") != MARKER:
                    raise ValueError("foreign_session_refused")
                if not dry:
                    cli("bastion", "session", "delete", "--session-id", session["id"], "--force")
    return bastions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["plan", "start", "session", "status", "stop", "rollback"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--instance", required=True)
    parser.add_argument("--subnet")
    parser.add_argument("--cidr")
    parser.add_argument("--public-key")
    parser.add_argument("--user")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root = root_path(args.root)
    if not re.fullmatch(r"ocid1\.instance\.[a-zA-Z0-9.-]+", args.instance):
        raise ValueError("exact_instance_required")
    if args.dry_run:
        print(json.dumps({"action": args.action, "mutation": False, "unit": MARKER}))
        return
    if os.name != "posix" or os.getuid() == 0:
        raise ValueError("nonroot_linux_required")
    if args.action in ("plan", "start"):
        cidr = ipaddress.ip_network(args.cidr)
        if cidr.version != 4 or cidr.prefixlen != 32:
            raise ValueError("single_client_ipv4_required")
        vm = cli("compute", "instance", "get", "--instance-id", args.instance)["data"]
        if vm["lifecycle-state"] != "RUNNING":
            raise ValueError("running_instance_required")
        vnics = cli("compute", "instance", "list-vnics", "--instance-id", args.instance)["data"]
        if args.subnet not in [x["subnet-id"] for x in vnics]:
            raise ValueError("subnet_mismatch")
        receipt = {"marker": MARKER, "instance": args.instance, "subnet": args.subnet,
                   "cidr": str(cidr), "compartment": vm["compartment-id"],
                   "beforeAgent": vm["agent-config"], "stage": "prepared"}
        if owned_bastions(receipt):
            raise ValueError("owned_resource_already_exists")
        if args.action == "plan":
            print(json.dumps({"ready": True, "unit": MARKER, "newVm": False, "newIam": False,
                              "clientCount": 1, "sessionSeconds": 10800}))
            return
        root.mkdir(mode=0o700)  # fresh transaction; never overwrite another receipt
        save(root, receipt)
        cli("compute", "instance", "update", "--instance-id", args.instance,
            "--agent-config", json.dumps(config_with_bastion(receipt["beforeAgent"], True)), "--force")
        receipt["stage"] = "plugin_enabled"
        save(root, receipt)
        data = cli("bastion", "bastion", "create", "--bastion-type", "STANDARD",
                   "--compartment-id", receipt["compartment"], "--target-subnet-id", args.subnet,
                   "--name", "aiccaccess", "--client-cidr-list", json.dumps([str(cidr)]),
                   "--max-session-ttl", "10800", "--freeform-tags", json.dumps({"aicc-operation": MARKER}))["data"]
        receipt.update(bastion=data["id"], stage="bastion_created")
        save(root, receipt)
        print(json.dumps({"stage": receipt["stage"]}))
        return
    private(root)
    private(root / "receipt.json")
    receipt = json.loads((root / "receipt.json").read_text())
    if receipt["marker"] != MARKER or receipt["instance"] != args.instance:
        raise ValueError("receipt_target_mismatch")
    if args.action == "session":
        bastions = owned_bastions(receipt)
        if len(bastions) != 1 or bastions[0]["lifecycle-state"] != "ACTIVE":
            raise ValueError("bastion_not_active")
        bastion = bastions[0]
        existing = cli("bastion", "session", "list", "--bastion-id", bastion["id"], "--all").get("data", [])
        if any(s["lifecycle-state"] not in ("DELETED", "FAILED") for s in existing):
            raise ValueError("session_already_exists")
        key = Path(args.public_key).read_text().strip()
        if not re.fullmatch(r"ssh-rsa [A-Za-z0-9+/=]+(?: [a-zA-Z0-9._-]+)?", key) or len(key) > 4096:
            raise ValueError("rsa_public_key_required")
        if not args.user or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", args.user):
            raise ValueError("exact_os_user_required")
        data = cli("bastion", "session", "create-managed-ssh", "--bastion-id", bastion["id"],
                   "--target-resource-id", args.instance, "--target-os-username", args.user,
                   "--ssh-public-key-file", args.public_key, "--session-ttl", "10800",
                   "--display-name", MARKER)["data"]
        receipt.update(session=data["id"], stage="session_created")
        save(root, receipt)
        print(json.dumps({"stage": receipt["stage"]}))
    elif args.action == "status":
        bastions = owned_bastions(receipt)
        output = {"stage": receipt["stage"], "bastions": [{"id": b["id"], "state": b["lifecycle-state"]} for b in bastions]}
        if receipt.get("session"):
            data = cli("bastion", "session", "get", "--session-id", receipt["session"])["data"]
            output["session"] = {"state": data["lifecycle-state"], "ssh": data.get("ssh-metadata")}
        print(json.dumps(output))
    else:
        bastions = stop(receipt)
        if args.action == "rollback":
            current = cli("compute", "instance", "get", "--instance-id", args.instance)["data"]["agent-config"]
            check_agent_drift(receipt["beforeAgent"], current)
            for b in bastions:
                if b["lifecycle-state"] != "DELETING":
                    cli("bastion", "bastion", "delete", "--bastion-id", b["id"], "--force")
            before = receipt["beforeAgent"]
            previous = next((p["desired-state"] for p in before.get("plugins-config") or [] if p["name"] == "Bastion"), "DISABLED")
            cli("compute", "instance", "update", "--instance-id", args.instance,
                "--agent-config", json.dumps(config_with_bastion(before, previous == "ENABLED")), "--force")
        receipt["stage"] = args.action
        save(root, receipt)
        print(json.dumps({"stage": args.action, "privateKeyPreserved": True}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, KeyError, subprocess.SubprocessError):
        print(json.dumps({"status": "blocked", "reason": "inspect_exact_bootstrap_stage"}))
        raise SystemExit(1)
