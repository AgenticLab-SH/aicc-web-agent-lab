#!/usr/bin/env python3
"""Fail closed on catastrophic local-destructive Codex tool calls."""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any


def deny(reason: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            },
            ensure_ascii=True,
            separators=(",", ":"),
        )
    )


def protected_paths() -> list[str]:
    home = os.path.abspath(os.path.expanduser("~"))
    candidates = [
        os.environ.get("SystemDrive", "C:") + os.sep,
        os.environ.get("SystemRoot", r"C:\Windows"),
        os.environ.get("ProgramFiles", r"C:\Program Files"),
        os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        os.environ.get("ProgramData", r"C:\ProgramData"),
        os.path.dirname(home),
        home,
        os.path.join(home, "AppData"),
        os.path.join(home, ".codex"),
        os.path.join(home, ".ai-control-center"),
        os.path.join(home, ".codex-chatgpt-web"),
        r"C:\src",
        r"C:\demo\projects",
        r"C:\demo\open-AICC",
    ]
    for name in ("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"):
        candidates.append(os.path.join(home, name))
    return sorted({os.path.normpath(path) for path in candidates if path}, key=len, reverse=True)


PROTECTED = protected_paths()


def normalize_command(value: str) -> str:
    text = os.path.expandvars(value).lower()
    home = os.path.expanduser("~").lower()
    for source, target in {
        "%userprofile%": home,
        "$env:userprofile": home,
        "${env:userprofile}": home,
        "$home": home,
        "${home}": home,
    }.items():
        text = text.replace(source, target)
    text = text.replace("/", "\\")
    while "\\\\" in text:
        text = text.replace("\\\\", "\\")
    return re.sub(r"(?<![a-z0-9])\\([a-z])\\", lambda m: m.group(1) + ":\\", text)


def protected_target_in(text: str) -> str | None:
    normalized = normalize_command(text)
    boundary = r"(?=$|[\s\"'=,;&|)\]])"
    for raw in PROTECTED:
        path = normalize_command(raw)
        if re.fullmatch(r"[a-z]:\\", path):
            pattern = re.escape(path) + r"(?:\*|\.\*)?" + boundary
        else:
            path = path.rstrip("\\")
            pattern = re.escape(path) + r"(?:\\(?:\*|\.\*))?" + boundary
        if re.search(pattern, normalized, re.IGNORECASE):
            return raw
    return None


def shell_segments(command: str) -> list[str]:
    return [part.strip() for part in re.split(r"(?:\r?\n|&&|\|\||;)", command) if part.strip()]


def variable_bindings(command: str) -> dict[str, str]:
    bindings: dict[str, str] = {}
    pattern = r"\$(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*['\"](?P<value>[^'\"]+)['\"]"
    for match in re.finditer(pattern, command):
        bindings[match.group("name").lower()] = match.group("value")
    return bindings


def substitute_known_bindings(segment: str, bindings: dict[str, str]) -> str:
    result = segment
    for name, value in bindings.items():
        result = re.sub(
            rf"\$\{{?{re.escape(name)}\}}?",
            lambda _match, replacement=value: replacement,
            result,
            flags=re.IGNORECASE,
        )
    return result


def catastrophic_shell_reason(command: str) -> str | None:
    normalized_all = normalize_command(command)
    if re.search(r"\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:enc|encodedcommand)\b", normalized_all):
        return "Encoded PowerShell is blocked because destructive targets cannot be inspected safely."

    disk_patterns = (
        r"\bdiskpart(?:\.exe)?\b",
        r"\bclear-disk\b",
        r"\binitialize-disk\b",
        r"\bremove-partition\b",
        r"\bremove-volume\b",
        r"\bformat-volume\b",
        r"\bformat(?:\.com)?\s+[a-z]:",
    )
    if any(re.search(pattern, normalized_all, re.IGNORECASE) for pattern in disk_patterns):
        return "Disk/volume destructive commands are blocked by the AICC catastrophic-operation guard."

    if re.search(r"\bgit\s+reset\s+--hard\b", normalized_all):
        return "git reset --hard is blocked to protect uncommitted work."
    if re.search(r"\bgit\s+clean\b[^\r\n]*(?:-[^\s]*[dx]|--force)", normalized_all):
        return "git clean with destructive flags is blocked to protect untracked work."

    destructive = re.compile(
        r"\b(?:remove-item|rm|rmdir|rd|del|erase)\b|"
        r"\b(?:shutil\.rmtree|fs\.(?:rm|rmsync)|rimraf)\b|"
        r"\brobocopy\b[^\r\n]*(?:/mir|/purge)\b",
        re.IGNORECASE,
    )
    bindings = variable_bindings(command)
    for segment in shell_segments(command):
        expanded = substitute_known_bindings(segment, bindings)
        if destructive.search(expanded):
            target = protected_target_in(expanded)
            if target:
                return "Destructive operation on a protected root is blocked. Preserve originals; do not retry through another tool."
    return None


def strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def command_candidates(tool_input: Any) -> list[str]:
    if isinstance(tool_input, str):
        return [tool_input]
    if not isinstance(tool_input, dict):
        return []
    keys = {"command", "cmd", "script", "shell_command", "shellcommand"}
    return [value for key, value in tool_input.items() if key.lower() in keys and isinstance(value, str)]


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0

    tool_name = str(event.get("tool_name") or "")
    tool_input = event.get("tool_input") or {}
    candidates = command_candidates(tool_input)

    for command in candidates:
        reason = catastrophic_shell_reason(command)
        if reason:
            deny(reason)
            return 0

    if tool_name == "Bash" and not candidates:
        for value in strings(tool_input):
            reason = catastrophic_shell_reason(value)
            if reason:
                deny(reason)
                return 0

    serialized = "\n".join(strings(tool_input))
    if tool_name.lower() == "apply_patch":
        delete_count = len(re.findall(r"(?m)^\*\*\* Delete File:", serialized))
        if delete_count >= 20:
            deny(f"Mass deletion patch is blocked ({delete_count} files). Preserve originals; do not split requests to bypass this guard.")
            return 0

    if re.search(r"(?:delete|remove|rmdir|\brm\b|move|rename)", tool_name.lower()):
        target = protected_target_in(serialized)
        if target:
            deny("Tool operation on a protected root is blocked. Preserve originals; do not retry through another tool.")
            return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
