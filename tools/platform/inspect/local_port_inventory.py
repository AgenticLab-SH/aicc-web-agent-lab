#!/usr/bin/env python3
"""Audit local TCP listeners against a private AICC port registry."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tomllib
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SENSITIVE_ARGUMENT = re.compile(
    r"(?i)(--(?:token|password|api[-_]?key|secret|credentials(?:-file)?))(?:=|\s+)([^\s]+)"
)
URL_CREDENTIAL = re.compile(r"(https?://)[^/@\s]+@")
SENSITIVE_ENVIRONMENT = re.compile(
    r"(?i)\b((?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|GITHUB|CLOUDFLARE|AWS|AZURE)?"
    r"(?:_?API_?KEY|_?TOKEN|_?SECRET|_?PASSWORD))=([^\s]+)"
)

WINDOWS_POWERSHELL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$processes = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $processes[[int]$_.ProcessId] = [pscustomobject]@{
    Name = [string]$_.Name
    CommandLine = [string]$_.CommandLine
  }
}
Get-NetTCPConnection -State Listen | ForEach-Object {
  $ownerPid = [int]$_.OwningProcess
  $process = $processes[$ownerPid]
  [pscustomobject]@{
    LocalAddress = [string]$_.LocalAddress
    LocalPort = [int]$_.LocalPort
    OwningProcess = $ownerPid
    ProcessName = if ($null -eq $process) { '' } else { $process.Name }
    CommandLine = if ($null -eq $process) { '' } else { $process.CommandLine }
  }
} | ConvertTo-Json -Compress
""".strip()


def run(command: list[str]) -> tuple[int, str]:
    result = subprocess.run(command, text=True, capture_output=True)
    return result.returncode, result.stdout


def sanitize_command(command: str) -> str:
    command = URL_CREDENTIAL.sub(r"\1<redacted>@", command)
    command = SENSITIVE_ARGUMENT.sub(lambda match: f"{match.group(1)}=<redacted>", command)
    return SENSITIVE_ENVIRONMENT.sub(lambda match: f"{match.group(1)}=<redacted>", command)


def parse_listener_name(value: str) -> tuple[str, int] | None:
    value = value.strip()
    value = re.sub(r"\s+\(LISTEN\)$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"^TCP\s+", "", value, flags=re.IGNORECASE)
    address, separator, port_text = value.rpartition(":")
    if not separator or not port_text.isdigit():
        return None
    return address.strip("[]"), int(port_text)


def parse_lsof_fields(output: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    pid: int | None = None
    process = ""
    for line in output.splitlines():
        if not line:
            continue
        field, value = line[0], line[1:]
        if field == "p":
            pid = int(value)
            process = ""
        elif field == "c":
            process = value
        elif field == "n" and pid is not None:
            parsed = parse_listener_name(value)
            if parsed:
                address, port = parsed
                records.append({"pid": pid, "process": process, "address": address, "port": port})
    return records


def _with_exposure(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for record in records:
        record["command"] = sanitize_command(str(record.get("command", "")))
        address = str(record.get("address", ""))
        try:
            is_loopback = ipaddress.ip_address(address).is_loopback
        except ValueError:
            is_loopback = address.lower() in {"localhost", "loopback"}
        record["exposure"] = "loopback" if is_loopback else "non_loopback"
    return records


def _macos_listeners() -> list[dict[str, Any]]:
    code, output = run(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
    if code not in (0, 1):
        raise RuntimeError("lsof listener inventory failed")
    records = parse_lsof_fields(output)
    commands: dict[int, str] = {}
    for pid in sorted({record["pid"] for record in records}):
        _, command = run(["/bin/ps", "-p", str(pid), "-o", "command="])
        commands[pid] = sanitize_command(command.strip())
    for record in records:
        record["command"] = commands.get(record["pid"], "")
    return _with_exposure(records)


def parse_powershell_listeners(output: str) -> list[dict[str, Any]]:
    """Parse compact ConvertTo-Json output from the Windows listener probe."""
    if not output.strip():
        return []
    payload = json.loads(output)
    rows = payload if isinstance(payload, list) else [payload]
    records: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            pid = int(row.get("OwningProcess", row.get("pid")))
            port = int(row.get("LocalPort", row.get("port")))
        except (TypeError, ValueError):
            continue
        address = str(row.get("LocalAddress", row.get("address", ""))).strip()
        records.append({
            "pid": pid,
            "process": str(row.get("ProcessName", row.get("process", "")) or ""),
            "address": address.strip("[]"),
            "port": port,
            "command": str(row.get("CommandLine", row.get("command", "")) or ""),
        })
    return _with_exposure(records)


def _powershell_executable() -> str | None:
    return shutil.which("pwsh") or shutil.which("powershell")


def _psutil_listeners() -> list[dict[str, Any]]:
    try:
        import psutil  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("Windows listener inventory requires PowerShell or psutil") from exc
    records: list[dict[str, Any]] = []
    for connection in psutil.net_connections(kind="tcp"):
        if str(connection.status).upper() != "LISTEN" or not connection.laddr:
            continue
        address = getattr(connection.laddr, "ip", connection.laddr[0])
        port = getattr(connection.laddr, "port", connection.laddr[1])
        pid = int(connection.pid or 0)
        process = command = ""
        if pid:
            try:
                process_info = psutil.Process(pid)
                process = process_info.name()
                command = " ".join(process_info.cmdline())
            except (psutil.Error, OSError):
                pass
        records.append({"pid": pid, "process": process, "address": str(address), "port": int(port), "command": command})
    return _with_exposure(records)


def _windows_listeners() -> list[dict[str, Any]]:
    executable = _powershell_executable()
    if executable:
        code, output = run([executable, "-NoProfile", "-NonInteractive", "-Command", WINDOWS_POWERSHELL_SCRIPT])
        if code == 0:
            return parse_powershell_listeners(output)
    return _psutil_listeners()


def current_listeners() -> list[dict[str, Any]]:
    """Return TCP listeners using the native probe for the current OS."""
    return _windows_listeners() if platform.system().lower() == "windows" else _macos_listeners()


def load_registry(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    services = data.get("services")
    if not isinstance(services, list):
        raise ValueError("registry must contain [[services]] entries")
    seen: set[int] = set()
    for service in services:
        port = service.get("port")
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError(f"invalid registered port: {port!r}")
        if port in seen:
            raise ValueError(f"duplicate registered port: {port}")
        seen.add(port)
    return data


def expected_match(service: dict[str, Any], listeners: list[dict[str, Any]]) -> bool:
    expected = service.get("expected_process_contains", [])
    if isinstance(expected, str):
        expected = [expected]
    if not expected:
        return True
    haystack = "\n".join(f"{item['process']} {item['command']}" for item in listeners).lower()
    return all(str(token).lower() in haystack for token in expected)


def build_report(registry_path: Path, listeners: list[dict[str, Any]]) -> dict[str, Any]:
    registry = load_registry(registry_path)
    by_port: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for listener in listeners:
        by_port[listener["port"]].append(listener)

    services: list[dict[str, Any]] = []
    registered_ports: set[int] = set()
    for configured in sorted(registry["services"], key=lambda item: item["port"]):
        port = configured["port"]
        registered_ports.add(port)
        occupancy = by_port.get(port, [])
        state = "available_or_stopped"
        if occupancy:
            state = "occupied_expected" if expected_match(configured, occupancy) else "occupied_conflict"
        services.append({**configured, "state": state, "listeners": occupancy})

    unregistered = [
        {"port": port, "state": "unregistered_current", "listeners": occupancy}
        for port, occupancy in sorted(by_port.items())
        if port not in registered_ports
    ]
    conflicts = [item for item in services if item["state"] == "occupied_conflict"]
    return {
        "schema_version": 1,
        "captured_at_utc": datetime.now(timezone.utc).isoformat(),
        "host": platform.node() or socket.gethostname() or "unknown",
        "registry": str(registry_path),
        "summary": {
            "registered": len(services),
            "current_listener_ports": len(by_port),
            "expected_occupied": sum(item["state"] == "occupied_expected" for item in services),
            "registered_stopped": sum(item["state"] == "available_or_stopped" for item in services),
            "conflicts": len(conflicts),
            "unregistered_current": len(unregistered),
        },
        "services": services,
        "unregistered_current": unregistered,
        "ok": not conflicts,
    }


def compact_listener(item: dict[str, Any]) -> str:
    return f"{item['process']} pid={item['pid']} {item['address']}"


def render_markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "# Local port inventory",
        "",
        f"- Captured (UTC): `{report['captured_at_utc']}`",
        f"- Registry: `{report['registry']}`",
        f"- Registered: {summary['registered']}; listener ports: {summary['current_listener_ports']}; conflicts: {summary['conflicts']}",
        "",
        "## Registered services",
        "",
        "| Port | Service | Intended use | Account/workspace | Lifecycle | Current state | Listener |",
        "|---:|---|---|---|---|---|---|",
    ]
    for item in report["services"]:
        identity = "/".join(filter(None, [str(item.get("account_alias", "")), str(item.get("workspace", ""))])) or "-"
        listener = "<br>".join(compact_listener(value) for value in item["listeners"]) or "-"
        lines.append(
            f"| {item['port']} | {item.get('name', '-')} | {item.get('purpose', '-')} | {identity} | "
            f"{item.get('lifecycle', '-')} | `{item['state']}` | {listener} |"
        )
    lines.extend([
        "",
        "## Unregistered current listeners",
        "",
        "These are observations, not durable assignments. Dynamic desktop, IDE, Gradle and OS ports normally appear here.",
        "",
        "| Port | Exposure | Listener |",
        "|---:|---|---|",
    ])
    for item in report["unregistered_current"]:
        exposures = ", ".join(sorted({value["exposure"] for value in item["listeners"]}))
        listener = "<br>".join(compact_listener(value) for value in item["listeners"])
        lines.append(f"| {item['port']} | {exposures} | {listener} |")
    lines.append("")
    return "\n".join(lines)


def default_state_root() -> Path:
    return Path(os.environ.get("AICC_STATE_ROOT", Path.home() / ".ai-control-center")).expanduser()


def main(argv: list[str] | None = None) -> int:
    state_root = default_state_root()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, default=state_root / "guidance" / "port-registry.toml")
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--write", action="store_true", help="write timestamped JSON and Markdown under private AICC state")
    parser.add_argument("--output-dir", type=Path, default=state_root / "reports" / "ports")
    parser.add_argument("--strict", action="store_true", help="exit nonzero on a registered-port conflict")
    args = parser.parse_args(argv)
    try:
        report = build_report(args.registry.expanduser().resolve(), current_listeners())
    except (OSError, RuntimeError, ValueError, tomllib.TOMLDecodeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    if args.write:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        json_path = args.output_dir / f"port-inventory-{stamp}.json"
        md_path = args.output_dir / f"port-inventory-{stamp}.md"
        json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        md_path.write_text(render_markdown(report), encoding="utf-8")
        print(json.dumps({"json": str(json_path), "markdown": str(md_path), "summary": report["summary"]}, ensure_ascii=False))
    elif args.as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(render_markdown(report))
    return 1 if args.strict and not report["ok"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
