#!/usr/bin/env python3
"""Website profile, registry, and production verification helper."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import os
import re
import socket
import ssl
import struct
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


RECEIPT_TYPE = "agenticfabworks.production-verification"
RECEIPT_SCHEMA_VERSION = 1
DNS_TYPES = {"A": 1, "NS": 2, "CNAME": 5, "AAAA": 28}
PUBLIC_RESOLVERS = {
    "cloudflare": {
        "doh": "https://cloudflare-dns.com/dns-query",
        "udp": ["1.1.1.1", "1.0.0.1"],
    },
    "google": {
        "doh": "https://dns.google/resolve",
        "udp": ["8.8.8.8", "8.8.4.4"],
    },
}


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def receipt_hash(receipt: dict[str, Any]) -> str:
    payload = {key: value for key, value in receipt.items() if key != "receipt_sha256"}
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()


def file_evidence(path: Path) -> dict[str, Any]:
    payload = path.read_bytes()
    return {
        "path": portable_path(path),
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def parse_timestamp(value: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"Invalid verification timestamp: {value}") from exc
    if parsed.tzinfo is None:
        raise SystemExit("Verification timestamp must include a timezone")
    return parsed


def checked_text(value: str | None, label: str) -> str:
    result = (value or "").strip()
    if not result or len(result) > 512 or any(ch in result for ch in "\r\n\0"):
        raise SystemExit(f"{label} must be a non-empty single-line value")
    return result


def checked_hash(value: str | None, label: str) -> str:
    result = checked_text(value, label).lower()
    if not re.fullmatch(r"[0-9a-f]{7,128}", result):
        raise SystemExit(f"{label} must be a 7-128 character hexadecimal hash")
    return result


def find_config_root(explicit: str | None = None) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    if os.environ.get("AICC_GUIDANCE_CONFIG_ROOT"):
        candidates.append(Path(os.environ["AICC_GUIDANCE_CONFIG_ROOT"]).expanduser())
    candidates.append(Path.home() / ".ai-control-center" / "guidance")
    for candidate in candidates:
        marker = candidate / "website-maker.json"
        if marker.is_file():
            return candidate.resolve()
    raise SystemExit(
        "AICC website configuration not found; run aicc setup or pass --config-root"
    )


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Cannot read JSON {path}: {exc}") from exc


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(payload)
        temp_path = Path(handle.name)
    temp_path.replace(path)


def portable_path(path: Path) -> str:
    resolved = path.expanduser().resolve()
    try:
        return "~/" + resolved.relative_to(Path.home().resolve()).as_posix()
    except ValueError:
        return resolved.as_posix()


def normalize_hostname(value: str) -> str:
    candidate = value.strip().lower().rstrip(".")
    if "://" in candidate:
        candidate = urllib.parse.urlparse(candidate).hostname or ""
    labels = candidate.split(".")
    if (
        not candidate
        or len(candidate) > 253
        or len(labels) < 2
        or any(
            not label
            or len(label) > 63
            or label.startswith("-")
            or label.endswith("-")
            or any(not (ch.isalnum() or ch == "-") for ch in label)
            for label in labels
        )
    ):
        raise SystemExit(f"Invalid hostname: {value}")
    try:
        candidate.encode("ascii")
    except UnicodeEncodeError as exc:
        raise SystemExit("Hostname must be lowercase ASCII or punycode") from exc
    return candidate


def load_settings(config_root: Path) -> dict[str, Any]:
    path = config_root / "website-maker.json"
    settings = read_json(path)
    if not isinstance(settings, dict):
        raise SystemExit(f"Missing or invalid settings: {path}")
    return settings


def assert_allowed(hostname: str, settings: dict[str, Any]) -> None:
    roots = settings.get("allowed_root_domains", [])
    if not any(hostname == root or hostname.endswith("." + root) for root in roots):
        raise SystemExit(f"Hostname is outside allowed root domains: {hostname}")


def csv_values(values: list[str] | None) -> list[str]:
    result: list[str] = []
    for value in values or []:
        for item in value.split(","):
            normalized = item.strip()
            if normalized and normalized not in result:
                result.append(normalized)
    return result


def cmd_config(args: argparse.Namespace) -> int:
    config_root = find_config_root(args.config_root)
    settings = load_settings(config_root)
    print(json.dumps({"config_root": portable_path(config_root), "settings": settings}, ensure_ascii=False, indent=2))
    return 0


def build_profile(args: argparse.Namespace, settings: dict[str, Any]) -> dict[str, Any]:
    hostname = normalize_hostname(args.primary_domain)
    assert_allowed(hostname, settings)
    aliases = [normalize_hostname(item) for item in csv_values(args.alias)]
    for alias in aliases:
        assert_allowed(alias, settings)
    profile = {
        "schema_version": 1,
        "title": args.title.strip(),
        "primary_domain": hostname,
        "aliases": sorted(set(aliases) - {hostname}),
        "hosting_provider": args.provider or settings.get(
            "default_hosting_provider", "cloudflare-pages"
        ),
        "provider_project": args.provider_project,
        "deployment_mode": args.deployment_mode,
        "source_repository": args.source_repository,
        "source_hash": checked_hash(args.source_hash, "source hash") if args.source_hash else None,
        "source_visibility": args.source_visibility,
        "dns_provider": args.dns_provider,
        "data_mode": args.data_mode,
        "brand_sources": csv_values(args.brand_source),
        "data_sources": csv_values(args.data_source),
        "critical_paths": csv_values(args.critical_path) or ["/"],
        "last_verified_at": args.verified_at or None,
    }
    return {key: value for key, value in profile.items() if value is not None}


def cmd_init_profile(args: argparse.Namespace) -> int:
    config_root = find_config_root(args.config_root)
    settings = load_settings(config_root)
    project = Path(args.project).expanduser().resolve()
    if not project.is_dir():
        raise SystemExit(f"Project directory not found: {project}")
    profile = build_profile(args, settings)
    profile_path = project / settings["project_profile_path"]
    if profile_path.exists() and not args.force:
        raise SystemExit(f"Profile exists; pass --force to replace: {profile_path}")
    if args.dry_run:
        print(
            json.dumps(
                {
                    "status": "would-create",
                    "profile": portable_path(profile_path),
                    "profile_value": profile,
                    "mutations": [],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    atomic_json(profile_path, profile)
    print(json.dumps({"status": "created", "profile": portable_path(profile_path)}, ensure_ascii=False))
    return 0


def validate_active_receipt(
    args: argparse.Namespace,
    profile: dict[str, Any],
    project_key: str,
) -> tuple[dict[str, Any], Path]:
    if not args.receipt or not args.receipt_sha256:
        raise SystemExit(
            "Active status requires --receipt and --receipt-sha256 from site_ops.py verify"
        )
    required_profile = {
        "provider project": profile.get("provider_project"),
        "source repository": profile.get("source_repository"),
        "source hash": profile.get("source_hash"),
    }
    missing = [name for name, value in required_profile.items() if not value]
    if missing:
        raise SystemExit("Active status requires " + ", ".join(missing))

    receipt_path = Path(args.receipt).expanduser().resolve()
    receipt = read_json(receipt_path)
    if not isinstance(receipt, dict):
        raise SystemExit(f"Missing or invalid verification receipt: {receipt_path}")
    embedded_hash = str(receipt.get("receipt_sha256", "")).lower()
    supplied_hash = str(args.receipt_sha256).strip().lower()
    computed_hash = receipt_hash(receipt)
    if not (
        len(embedded_hash) == 64
        and hmac.compare_digest(embedded_hash, supplied_hash)
        and hmac.compare_digest(embedded_hash, computed_hash)
    ):
        raise SystemExit("Verification receipt hash does not match its content and CLI hash")

    expected = {
        "receipt_type": RECEIPT_TYPE,
        "schema_version": RECEIPT_SCHEMA_VERSION,
        "status": "passed",
        "target": {
            "url": f"https://{profile['primary_domain']}/",
            "hostname": profile["primary_domain"],
        },
        "site": {
            "project_key": project_key,
            "primary_domain": profile["primary_domain"],
        },
        "provider": {
            "name": profile["hosting_provider"],
            "project": profile["provider_project"],
        },
        "source": {
            "id": profile["source_repository"],
            "hash": profile["source_hash"],
        },
    }
    for field, value in expected.items():
        if receipt.get(field) != value:
            raise SystemExit(f"Verification receipt {field} does not match the record target")

    verified_at = str(receipt.get("verified_at", ""))
    timestamp = parse_timestamp(verified_at)
    if args.verified_at and verified_at != args.verified_at:
        raise SystemExit("Verification receipt timestamp does not match --verified-at")
    age = dt.datetime.now(dt.timezone.utc) - timestamp.astimezone(dt.timezone.utc)
    if age.total_seconds() < -300:
        raise SystemExit("Verification receipt timestamp is more than five minutes in the future")
    if age.total_seconds() > float(args.max_receipt_age):
        raise SystemExit("Verification receipt is older than --max-receipt-age")

    checks = receipt.get("checks")
    if not isinstance(checks, dict):
        raise SystemExit("Verification receipt checks are missing")
    dns = checks.get("dns")
    tls = checks.get("tls")
    https_checks = checks.get("https")
    if not (
        isinstance(dns, dict)
        and dns.get("ok") is True
        and isinstance(dns.get("public_recursive"), dict)
        and dns["public_recursive"].get("ok") is True
        and isinstance(dns.get("authoritative"), dict)
        and dns["authoritative"].get("ok") is True
        and isinstance(tls, dict)
        and tls.get("ok") is True
        and isinstance(https_checks, list)
        and bool(https_checks)
        and all(isinstance(item, dict) and item.get("ok") is True for item in https_checks)
    ):
        raise SystemExit("Verification receipt does not contain passed DNS, TLS, and HTTPS evidence")
    return receipt, receipt_path


def cmd_record(args: argparse.Namespace) -> int:
    config_root = find_config_root(args.config_root)
    settings = load_settings(config_root)
    project = Path(args.project).expanduser().resolve()
    if not project.is_dir():
        raise SystemExit(f"Project directory not found: {project}")
    profile = build_profile(args, settings)

    hosting = read_json(project / ".openai" / "hosting.json", {})
    if (
        profile["hosting_provider"] == "openai-sites"
        and isinstance(hosting, dict)
        and hosting.get("project_id")
    ):
        profile["sites_project_id"] = hosting["project_id"]
        profile["provider_project"] = profile.get("provider_project") or hosting["project_id"]

    registry_path = config_root / settings["registry_path"]
    registry = read_json(
        registry_path,
        {"schema_version": 1, "updated_at": None, "projects": []},
    )
    projects = registry.setdefault("projects", [])
    if not isinstance(projects, list):
        raise SystemExit(f"Invalid projects array: {registry_path}")

    primary = profile["primary_domain"]
    project_key = checked_text(args.project_key or project.name, "project key")
    occupied: dict[str, str] = {}
    for item in projects:
        if not isinstance(item, dict):
            continue
        key = item.get("project_key", "")
        aliases = item.get("aliases") if isinstance(item.get("aliases"), list) else []
        for host in [item.get("primary_domain"), *aliases]:
            if host:
                occupied[str(host)] = str(key)
    for host in [primary, *profile["aliases"]]:
        owner = occupied.get(host)
        if owner and owner != project_key:
            raise SystemExit(f"Domain already belongs to {owner}: {host}")

    receipt: dict[str, Any] | None = None
    receipt_path: Path | None = None
    if args.status == "active":
        receipt, receipt_path = validate_active_receipt(args, profile, project_key)
        verified_at = str(receipt["verified_at"])
        profile["last_verified_at"] = verified_at
        profile["last_verification"] = {
            "status": "passed",
            "receipt_sha256": receipt["receipt_sha256"],
            "target": receipt["target"],
            "site": receipt["site"],
            "provider": receipt["provider"],
            "source": receipt["source"],
            "verified_at": verified_at,
            "checks": receipt["checks"],
        }
    else:
        verified_at = args.verified_at or None
        profile["last_verified_at"] = verified_at
        profile["last_verification"] = {
            "status": args.status,
            "production_url": f"https://{primary}/",
            "notes": csv_values(args.check),
        }

    entry = {
        "project_key": project_key,
        "title": profile["title"],
        "project_root": portable_path(project),
        "primary_domain": primary,
        "aliases": profile["aliases"],
        "hosting_provider": profile["hosting_provider"],
        "provider_project": profile.get("provider_project"),
        "deployment_mode": profile.get("deployment_mode"),
        "source_repository": profile.get("source_repository"),
        "source_hash": profile.get("source_hash"),
        "source_visibility": profile.get("source_visibility"),
        "dns_provider": profile.get("dns_provider"),
        "data_mode": profile["data_mode"],
        "brand_sources": profile["brand_sources"],
        "data_sources": profile["data_sources"],
        "critical_paths": profile["critical_paths"],
        "status": args.status,
        "last_verified_at": verified_at,
        "notes": csv_values(args.check),
    }
    if receipt is not None:
        entry["verification_receipt_sha256"] = receipt["receipt_sha256"]
        entry["checks"] = ["dns.public_recursive", "dns.authoritative", "tls", "https"]
    if profile.get("sites_project_id"):
        entry["sites_project_id"] = profile["sites_project_id"]
    entry = {key: value for key, value in entry.items() if value is not None}
    projects[:] = [
        item
        for item in projects
        if not isinstance(item, dict) or item.get("project_key") != project_key
    ]
    projects.append(entry)
    projects.sort(key=lambda item: str(item.get("project_key", "")))
    registry["updated_at"] = now_iso()

    profile_path = project / settings["project_profile_path"]
    result = {
        "status": "would-record" if args.dry_run else "recorded",
        "project_key": project_key,
        "primary_url": f"https://{primary}/",
        "profile": portable_path(profile_path),
        "registry": portable_path(registry_path),
        "receipt": portable_path(receipt_path) if receipt_path else None,
        "receipt_sha256": receipt.get("receipt_sha256") if receipt else None,
    }
    result = {key: value for key, value in result.items() if value is not None}
    if args.dry_run:
        result["mutations"] = []
        result["planned_writes"] = [portable_path(profile_path), portable_path(registry_path)]
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    atomic_json(profile_path, profile)
    atomic_json(registry_path, registry)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def fetch(url: str, timeout: float) -> tuple[int, str, str, dict[str, str]]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "AgenticWebsiteMakerVerifier/1.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(2_000_000).decode("utf-8", errors="replace")
            headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
            return int(response.status), body, str(response.geturl()), headers
    except urllib.error.HTTPError as exc:
        body = exc.read(200_000).decode("utf-8", errors="replace")
        headers = {str(key).lower(): str(value) for key, value in exc.headers.items()}
        return int(exc.code), body, str(exc.geturl()), headers


def public_dns_query(
    name: str,
    record_type: str,
    timeout: float,
    resolver_name: str,
) -> dict[str, Any]:
    resolver = PUBLIC_RESOLVERS[resolver_name]
    endpoint = str(resolver["doh"])
    query = urllib.parse.urlencode({"name": name, "type": record_type})
    request = urllib.request.Request(
        f"{endpoint}?{query}",
        headers={
            "Accept": "application/dns-json",
            "User-Agent": "AgenticWebsiteMakerVerifier/2.0",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read(1_000_000).decode("utf-8"))
        answers = []
        for answer in payload.get("Answer", []) if isinstance(payload, dict) else []:
            if not isinstance(answer, dict):
                continue
            answers.append(
                {
                    "name": str(answer.get("name", "")).rstrip("."),
                    "type": int(answer.get("type", 0)),
                    "ttl": int(answer.get("TTL", 0)),
                    "data": str(answer.get("data", "")).rstrip("."),
                }
            )
        status = int(payload.get("Status", -1)) if isinstance(payload, dict) else -1
        return {
            "name": name,
            "record_type": record_type,
            "status": status,
            "authenticated_data": bool(payload.get("AD", False)) if isinstance(payload, dict) else False,
            "transport": "doh/https",
            "endpoint": endpoint,
            "ok": status == 0,
            "answers": answers,
        }
    except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as doh_error:
        udp_errors: list[str] = []
        for server in resolver["udp"]:
            try:
                result = recursive_dns_query(str(server), name, record_type, timeout)
                result["doh_error"] = str(doh_error)
                return result
            except (OSError, ValueError) as udp_error:
                udp_errors.append(f"{server}: {udp_error}")
        raise OSError(
            f"DoH failed ({doh_error}); public UDP failed ({'; '.join(udp_errors)})"
        ) from doh_error


def encode_dns_name(name: str) -> bytes:
    labels = name.rstrip(".").split(".")
    return b"".join(bytes([len(label.encode("ascii"))]) + label.encode("ascii") for label in labels) + b"\0"


def decode_dns_name(packet: bytes, offset: int) -> tuple[str, int]:
    labels: list[str] = []
    cursor = offset
    end = offset
    jumped = False
    seen: set[int] = set()
    while True:
        if cursor >= len(packet):
            raise ValueError("Truncated DNS name")
        length = packet[cursor]
        if length == 0:
            if not jumped:
                end = cursor + 1
            break
        if length & 0xC0 == 0xC0:
            if cursor + 1 >= len(packet):
                raise ValueError("Truncated DNS compression pointer")
            pointer = ((length & 0x3F) << 8) | packet[cursor + 1]
            if pointer in seen:
                raise ValueError("DNS compression pointer loop")
            seen.add(pointer)
            if not jumped:
                end = cursor + 2
            cursor = pointer
            jumped = True
            continue
        if length & 0xC0 or cursor + 1 + length > len(packet):
            raise ValueError("Invalid DNS label")
        labels.append(packet[cursor + 1 : cursor + 1 + length].decode("ascii"))
        cursor += 1 + length
        if not jumped:
            end = cursor
    return ".".join(labels), end


def parse_dns_response(packet: bytes, expected_id: int) -> dict[str, Any]:
    if len(packet) < 12:
        raise ValueError("Truncated DNS response")
    transaction_id, flags, questions, answers, authority, additional = struct.unpack(
        "!HHHHHH", packet[:12]
    )
    if transaction_id != expected_id:
        raise ValueError("DNS transaction ID mismatch")
    offset = 12
    for _ in range(questions):
        _, offset = decode_dns_name(packet, offset)
        offset += 4
        if offset > len(packet):
            raise ValueError("Truncated DNS question")

    records: list[dict[str, Any]] = []
    for section, count in (
        ("answer", answers),
        ("authority", authority),
        ("additional", additional),
    ):
        for _ in range(count):
            name, offset = decode_dns_name(packet, offset)
            if offset + 10 > len(packet):
                raise ValueError("Truncated DNS record")
            record_type, record_class, ttl, length = struct.unpack(
                "!HHIH", packet[offset : offset + 10]
            )
            offset += 10
            data_offset = offset
            raw = packet[offset : offset + length]
            offset += length
            if len(raw) != length:
                raise ValueError("Truncated DNS record data")
            if record_type == DNS_TYPES["A"] and length == 4:
                data = str(ipaddress.IPv4Address(raw))
            elif record_type == DNS_TYPES["AAAA"] and length == 16:
                data = str(ipaddress.IPv6Address(raw))
            elif record_type in (DNS_TYPES["NS"], DNS_TYPES["CNAME"]):
                data, _ = decode_dns_name(packet, data_offset)
            else:
                data = raw.hex()
            records.append(
                {
                    "section": section,
                    "name": name.rstrip("."),
                    "type": record_type,
                    "class": record_class,
                    "ttl": ttl,
                    "data": data.rstrip(".") if isinstance(data, str) else data,
                }
            )
    return {
        "rcode": flags & 0x000F,
        "authoritative": bool(flags & 0x0400),
        "authenticated_data": bool(flags & 0x0020),
        "recursion_available": bool(flags & 0x0080),
        "truncated": bool(flags & 0x0200),
        "records": records,
    }


def udp_dns_query(
    server: str,
    name: str,
    record_type: str,
    timeout: float,
    *,
    recursive: bool,
) -> dict[str, Any]:
    transaction_id = int.from_bytes(os.urandom(2), "big")
    header = struct.pack(
        "!HHHHHH",
        transaction_id,
        0x0100 if recursive else 0x0000,
        1,
        0,
        0,
        0,
    )
    question = encode_dns_name(name) + struct.pack("!HH", DNS_TYPES[record_type], 1)
    family = socket.AF_INET6 if ":" in server else socket.AF_INET
    destination: tuple[Any, ...] = (server, 53, 0, 0) if family == socket.AF_INET6 else (server, 53)
    with socket.socket(family, socket.SOCK_DGRAM) as client:
        client.settimeout(timeout)
        client.sendto(header + question, destination)
        packet, _ = client.recvfrom(65535)
    result = parse_dns_response(packet, transaction_id)
    result.update(
        {
            "server": server,
            "transport": "udp/53",
            "name": name,
            "record_type": record_type,
            "ok": result["rcode"] == 0 and not result["truncated"],
        }
    )
    return result


def recursive_dns_query(
    server: str,
    name: str,
    record_type: str,
    timeout: float,
) -> dict[str, Any]:
    result = udp_dns_query(server, name, record_type, timeout, recursive=True)
    result["answers"] = [
        {
            "name": record["name"],
            "type": record["type"],
            "ttl": record["ttl"],
            "data": record["data"],
        }
        for record in result["records"]
        if record["section"] == "answer"
    ]
    return result


def authoritative_dns_query(
    server: str,
    name: str,
    record_type: str,
    timeout: float,
) -> dict[str, Any]:
    result = udp_dns_query(server, name, record_type, timeout, recursive=False)
    result["ok"] = bool(result["ok"] and result["authoritative"])
    return result


def collect_dns_evidence(
    hostname: str,
    timeout: float,
    resolver_name: str,
) -> dict[str, Any]:
    public_queries: list[dict[str, Any]] = []
    for record_type in ("A", "AAAA", "CNAME"):
        try:
            public_queries.append(public_dns_query(hostname, record_type, timeout, resolver_name))
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
            public_queries.append(
                {
                    "name": hostname,
                    "record_type": record_type,
                    "ok": False,
                    "error": str(exc),
                }
            )
    public_ok = any(query.get("ok") and query.get("answers") for query in public_queries)

    labels = hostname.split(".")
    zone = None
    ns_queries: list[dict[str, Any]] = []
    nameservers: list[str] = []
    for index in range(max(1, len(labels) - 1)):
        candidate = ".".join(labels[index:])
        try:
            query = public_dns_query(candidate, "NS", timeout, resolver_name)
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
            query = {"name": candidate, "record_type": "NS", "ok": False, "error": str(exc)}
        ns_queries.append(query)
        current = [
            str(answer.get("data", "")).rstrip(".")
            for answer in query.get("answers", [])
            if answer.get("type") == DNS_TYPES["NS"] and answer.get("data")
        ]
        if current:
            zone = candidate
            nameservers = sorted(set(current))
            break

    nameserver_addresses: dict[str, list[str]] = {}
    for nameserver in nameservers:
        addresses: list[str] = []
        for record_type in ("A", "AAAA"):
            try:
                query = public_dns_query(nameserver, record_type, timeout, resolver_name)
                addresses.extend(
                    str(answer["data"])
                    for answer in query.get("answers", [])
                    if answer.get("type") in (DNS_TYPES["A"], DNS_TYPES["AAAA"])
                )
            except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
                continue
        nameserver_addresses[nameserver] = sorted(set(addresses))

    authoritative_queries: list[dict[str, Any]] = []
    authoritative_ok = False
    server_candidates = [
        address
        for nameserver in nameservers
        for address in nameserver_addresses.get(nameserver, [])
    ]
    for server in server_candidates[:4]:
        server_has_record = False
        for record_type in ("A", "AAAA", "CNAME"):
            try:
                query = authoritative_dns_query(server, hostname, record_type, timeout)
            except (OSError, ValueError) as exc:
                query = {
                    "server": server,
                    "transport": "udp/53",
                    "name": hostname,
                    "record_type": record_type,
                    "ok": False,
                    "error": str(exc),
                }
            authoritative_queries.append(query)
            has_answer = any(
                record.get("section") == "answer"
                and record.get("type") in (DNS_TYPES["A"], DNS_TYPES["AAAA"], DNS_TYPES["CNAME"])
                for record in query.get("records", [])
            )
            server_has_record = server_has_record or bool(query.get("ok") and has_answer)
        if server_has_record:
            authoritative_ok = True
            break

    try:
        system_addresses = sorted(
            {
                item[4][0]
                for item in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
            }
        )
        system = {"resolver": "os-getaddrinfo", "ok": bool(system_addresses), "addresses": system_addresses}
    except socket.gaierror as exc:
        system = {"resolver": "os-getaddrinfo", "ok": False, "error": str(exc)}

    public = {
        "resolver": resolver_name,
        "endpoints": PUBLIC_RESOLVERS[resolver_name],
        "transports": sorted(
            {
                str(query.get("transport"))
                for query in public_queries
                if query.get("transport")
            }
        ),
        "ok": bool(public_ok),
        "queries": public_queries,
    }
    authoritative = {
        "zone": zone,
        "nameservers": nameservers,
        "nameserver_addresses": nameserver_addresses,
        "discovery_queries": ns_queries,
        "transport": "udp/53",
        "ok": bool(authoritative_ok),
        "queries": authoritative_queries,
    }
    return {
        "ok": bool(public["ok"] and authoritative["ok"] and system["ok"]),
        "public_recursive": public,
        "authoritative": authoritative,
        "system": system,
    }


def collect_tls_evidence(hostname: str, timeout: float) -> dict[str, Any]:
    try:
        context = ssl.create_default_context()
        with socket.create_connection((hostname, 443), timeout=timeout) as raw:
            with context.wrap_socket(raw, server_hostname=hostname) as secure:
                certificate = secure.getpeercert()
                certificate_der = secure.getpeercert(binary_form=True)
                cipher = secure.cipher()
                tls_version = secure.version()
        return {
            "ok": True,
            "hostname": hostname,
            "version": tls_version,
            "cipher": cipher[0] if cipher else None,
            "certificate_sha256": hashlib.sha256(certificate_der).hexdigest(),
            "not_after": certificate.get("notAfter"),
            "subject_alt_names": [
                value
                for kind, value in certificate.get("subjectAltName", [])
                if kind == "DNS"
            ],
        }
    except (OSError, ssl.SSLError) as exc:
        return {"ok": False, "hostname": hostname, "error": str(exc)}


def cmd_verify(args: argparse.Namespace) -> int:
    parsed = urllib.parse.urlparse(args.url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.port not in (None, 443):
        raise SystemExit("--url must be an https URL on the default port")
    hostname = normalize_hostname(parsed.hostname)
    timeout = float(args.timeout)
    site = checked_text(args.site, "site")
    provider = checked_text(args.provider, "provider")
    provider_project = checked_text(args.provider_project, "provider project")
    source = checked_text(args.source, "source")
    source_hash = checked_hash(args.source_hash, "source hash")
    verified_at = args.verified_at or now_iso()
    parse_timestamp(verified_at)

    dns = collect_dns_evidence(hostname, timeout, args.public_resolver)
    tls = collect_tls_evidence(hostname, timeout)

    paths = csv_values(args.endpoint) or [parsed.path or "/"]
    expected = csv_values(args.expect)
    rejected = csv_values(args.reject)
    origin = f"https://{hostname}"
    https_checks: list[dict[str, Any]] = []
    for path in paths:
        target = urllib.parse.urljoin(origin + "/", path.lstrip("/"))
        try:
            status, body, final_url, headers = fetch(target, timeout)
            path_ok = 200 <= status < 300
            missing = [text for text in expected if text not in body] if path == paths[0] else []
            present_rejected = [text for text in rejected if text in body]
            path_ok = path_ok and not missing and not present_rejected
            https_checks.append(
                {
                    "url": target,
                    "final_url": final_url,
                    "ok": path_ok,
                    "status": status,
                    "body_bytes": len(body.encode("utf-8")),
                    "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
                    "response_headers": {
                        key: headers[key]
                        for key in ("server", "cf-ray", "content-type")
                        if key in headers
                    },
                    "missing_expected": missing,
                    "present_rejected": present_rejected,
                }
            )
        except (OSError, urllib.error.URLError) as exc:
            https_checks.append({"url": target, "ok": False, "error": str(exc)})

    ok = bool(dns.get("ok") and tls.get("ok") and https_checks and all(item.get("ok") for item in https_checks))
    report: dict[str, Any] = {
        "schema_version": RECEIPT_SCHEMA_VERSION,
        "receipt_type": RECEIPT_TYPE,
        "status": "passed" if ok else "failed",
        "target": {"url": f"https://{hostname}/", "hostname": hostname},
        "site": {"project_key": site, "primary_domain": hostname},
        "provider": {"name": provider, "project": provider_project},
        "source": {"id": source, "hash": source_hash},
        "verified_at": verified_at,
        "checks": {"dns": dns, "tls": tls, "https": https_checks},
    }
    if args.dry_run:
        report["dry_run"] = True
        report["mutations"] = []
        if args.receipt_out:
            report["planned_receipt"] = portable_path(Path(args.receipt_out))
    report["receipt_sha256"] = receipt_hash(report)
    if args.receipt_out and not args.dry_run:
        atomic_json(Path(args.receipt_out).expanduser().resolve(), report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ok else 1


def cmd_list(args: argparse.Namespace) -> int:
    config_root = find_config_root(args.config_root)
    settings = load_settings(config_root)
    registry = read_json(config_root / settings["registry_path"], {"projects": []})
    print(json.dumps(registry, ensure_ascii=False, indent=2))
    return 0


def normalized_compare_value(field: str, value: Any) -> Any:
    if value is None:
        return None
    if field == "project_root":
        return os.path.normcase(str(Path(str(value)).expanduser().resolve())).replace("\\", "/")
    if field == "primary_domain":
        return str(value).strip().lower().rstrip(".")
    if isinstance(value, str):
        return value.strip()
    return value


def keyed_entries(items: Any, key_field: str) -> tuple[dict[str, dict[str, Any]], list[str]]:
    result: dict[str, dict[str, Any]] = {}
    duplicates: list[str] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not item.get(key_field):
            continue
        key = str(item[key_field])
        if key in result:
            duplicates.append(key)
            continue
        result[key] = item
    return result, sorted(set(duplicates))


def workspace_entry_view(item: dict[str, Any], workspace_root: Path) -> dict[str, Any]:
    view: dict[str, Any] = {}
    mappings = {
        "title": "title",
        "primary_domain": "hostname",
        "hosting_provider": "hosting_provider",
        "provider_project": "provider_project",
        "source_repository": "source_repository",
        "source_visibility": "source_visibility",
        "data_mode": "data_mode",
        "status": "domain_status",
    }
    for output_field, input_field in mappings.items():
        if input_field in item:
            view[output_field] = item[input_field]
    if "canonical_path" in item and item.get("canonical_path"):
        view["project_root"] = str((workspace_root / str(item["canonical_path"])).resolve())
    return view


def cmd_reconcile(args: argparse.Namespace) -> int:
    config_root = find_config_root(args.config_root)
    settings = load_settings(config_root)
    registry_path = (config_root / settings["registry_path"]).resolve()
    default_workspace = Path(str(settings.get("workspace_root", ""))) / "website-workspace.json"
    workspace_path = Path(args.workspace or default_workspace).expanduser().resolve()
    if not registry_path.is_file():
        raise SystemExit(f"Registry not found: {registry_path}")
    if not workspace_path.is_file():
        raise SystemExit(f"Workspace manifest not found: {workspace_path}")
    registry = read_json(registry_path)
    workspace = read_json(workspace_path)
    if not isinstance(registry, dict) or not isinstance(workspace, dict):
        raise SystemExit("Registry and workspace manifest must be JSON objects")

    registry_entries, registry_duplicates = keyed_entries(registry.get("projects"), "project_key")
    workspace_items = [
        *(workspace.get("services", []) if isinstance(workspace.get("services"), list) else []),
        *(
            workspace.get("development_projects", [])
            if isinstance(workspace.get("development_projects"), list)
            else []
        ),
    ]
    workspace_entries, workspace_duplicates = keyed_entries(workspace_items, "key")
    workspace_root = Path(
        str(workspace.get("workspace_root") or workspace_path.parent)
    ).expanduser().resolve()

    only_workspace = sorted(set(workspace_entries) - set(registry_entries))
    only_registry = sorted(set(registry_entries) - set(workspace_entries))
    comparisons: list[dict[str, Any]] = []
    drift_count = 0
    unknown_count = 0
    compared_fields = (
        "title",
        "project_root",
        "primary_domain",
        "hosting_provider",
        "provider_project",
        "source_repository",
        "source_visibility",
        "data_mode",
        "status",
    )
    for key in sorted(set(workspace_entries) & set(registry_entries)):
        workspace_view = workspace_entry_view(workspace_entries[key], workspace_root)
        registry_view = registry_entries[key]
        differences: list[dict[str, Any]] = []
        unavailable: list[dict[str, str]] = []
        matches: list[str] = []
        for field in compared_fields:
            has_workspace = field in workspace_view and workspace_view[field] is not None
            has_registry = field in registry_view and registry_view[field] is not None
            if not has_workspace or not has_registry:
                side = "both" if not has_workspace and not has_registry else (
                    "workspace" if not has_workspace else "registry"
                )
                unavailable.append({"field": field, "missing_from": side})
                unknown_count += 1
                continue
            workspace_value = normalized_compare_value(field, workspace_view[field])
            registry_value = normalized_compare_value(field, registry_view[field])
            if workspace_value == registry_value:
                matches.append(field)
            else:
                differences.append(
                    {
                        "field": field,
                        "workspace": workspace_view[field],
                        "registry": registry_view[field],
                    }
                )
                drift_count += 1
        comparisons.append(
            {
                "project_key": key,
                "status": "drift" if differences else ("partial" if unavailable else "match"),
                "matching_fields": matches,
                "differences": differences,
                "unavailable": unavailable,
            }
        )

    has_drift = bool(
        drift_count
        or only_workspace
        or only_registry
        or registry_duplicates
        or workspace_duplicates
    )
    report = {
        "schema_version": 1,
        "mode": "read-only-reconcile",
        "dry_run": bool(getattr(args, "dry_run", False)),
        "inputs": {
            "website_workspace": file_evidence(workspace_path),
            "personal_registry": file_evidence(registry_path),
        },
        "summary": {
            "workspace_entries": len(workspace_entries),
            "registry_entries": len(registry_entries),
            "shared_entries": len(comparisons),
            "field_drifts": drift_count,
            "unknown_fields": unknown_count,
            "only_in_workspace": len(only_workspace),
            "only_in_registry": len(only_registry),
            "has_drift": has_drift,
            "mutations": 0,
        },
        "duplicates": {
            "website_workspace": workspace_duplicates,
            "personal_registry": registry_duplicates,
        },
        "only_in_workspace": only_workspace,
        "only_in_registry": only_registry,
        "comparisons": comparisons,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if args.fail_on_drift and has_drift else 0


def add_profile_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--project", required=True)
    parser.add_argument("--project-key")
    parser.add_argument("--title", required=True)
    parser.add_argument("--primary-domain", required=True)
    parser.add_argument("--alias", action="append")
    parser.add_argument("--provider")
    parser.add_argument("--provider-project")
    parser.add_argument(
        "--deployment-mode",
        choices=("direct-upload", "git-integration", "worker-deploy", "firebase-cli", "saved-version"),
    )
    parser.add_argument("--source-repository")
    parser.add_argument("--source-hash")
    parser.add_argument(
        "--source-visibility",
        choices=("private", "public"),
        default="private",
    )
    parser.add_argument("--dns-provider", default="cloudflare")
    parser.add_argument(
        "--data-mode",
        choices=("live", "user-owned", "static", "fixture-only"),
        default="static",
    )
    parser.add_argument("--brand-source", action="append")
    parser.add_argument("--data-source", action="append")
    parser.add_argument("--critical-path", action="append")
    parser.add_argument("--verified-at")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config-root", "--hub", dest="config_root",
        help="AICC personal guidance configuration root",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    config = sub.add_parser("config", help="show resolved maker configuration")
    config.set_defaults(func=cmd_config)

    init_profile = sub.add_parser("init-profile", help="create a project profile")
    add_profile_args(init_profile)
    init_profile.add_argument("--force", action="store_true")
    init_profile.add_argument("--dry-run", action="store_true", help="validate and print without writing")
    init_profile.set_defaults(func=cmd_init_profile)

    record = sub.add_parser("record", help="record a verified production release")
    add_profile_args(record)
    record.add_argument("--status", choices=("active", "pending", "retired"), default="active")
    record.add_argument("--check", action="append", help="supplementary note; never verification evidence")
    record.add_argument("--receipt", help="JSON receipt written by the verify command")
    record.add_argument("--receipt-sha256", help="canonical SHA-256 printed in the receipt")
    record.add_argument("--max-receipt-age", type=float, default=3600.0)
    record.add_argument("--dry-run", action="store_true", help="validate and print without writing")
    record.set_defaults(func=cmd_record)

    verify = sub.add_parser("verify", help="create structured DNS, TLS, and HTTPS evidence")
    verify.add_argument("--url", required=True)
    verify.add_argument("--site", required=True, help="exact project key")
    verify.add_argument("--provider", required=True)
    verify.add_argument("--provider-project", required=True)
    verify.add_argument("--source", required=True, help="exact source repository or immutable source ID")
    verify.add_argument("--source-hash", required=True, help="exact source revision or artifact hash")
    verify.add_argument("--endpoint", action="append")
    verify.add_argument("--expect", action="append")
    verify.add_argument("--reject", action="append")
    verify.add_argument("--timeout", type=float, default=15.0)
    verify.add_argument("--verified-at", help="timezone-aware timestamp; defaults to now")
    verify.add_argument(
        "--public-resolver",
        choices=tuple(PUBLIC_RESOLVERS),
        default="cloudflare",
    )
    verify.add_argument("--receipt-out", help="optional local JSON receipt path")
    verify.add_argument("--dry-run", action="store_true", help="perform checks but do not write receipt")
    verify.set_defaults(func=cmd_verify)

    listing = sub.add_parser("list", help="print the central website registry")
    listing.set_defaults(func=cmd_list)

    for command in ("reconcile", "diff"):
        reconcile = sub.add_parser(
            command,
            help="compare website-workspace.json with the personal registry without writing",
        )
        reconcile.add_argument("--workspace", help="path to website-workspace.json")
        reconcile.add_argument(
            "--dry-run",
            action="store_true",
            help="explicit read-only mode; reconcile never writes",
        )
        reconcile.add_argument("--fail-on-drift", action="store_true")
        reconcile.set_defaults(func=cmd_reconcile)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
