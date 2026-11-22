---
name: audit-local-ports
description: 등록된 Windows TCP 포트와 listener 소유자를 조회한다. 서비스 중지·경로 복구·정리 제외.
---

# Audit local ports

Treat intended assignment and current occupancy as separate evidence. Never reuse a port,
kill a listener, restart a service, or change a browser account merely to make the report clean.

## Workflow

1. Read `docs/runbooks/local-port-registry.md` and the private port registry under the configured
   AICC state root (normally `$env:USERPROFILE\.ai-control-center\guidance\port-registry.toml`).
2. For browser ports, also read private `coordination.toml` and apply
   `$choose-browser-session`; verify executable, user-data root, profile directory, CDP port,
   account alias and returned target. A listener or tab alone is not identity.
3. For Web GPT 17841 or OCX 10100, apply `$manage-codex-model-routes`. Do not restart an
   active bridge or proxy during an inventory.
4. Run the read-only inventory:

   ```bash
   python tools/platform/inspect/local_port_inventory.py --json
   ```

   Only when the user asks to retain a capture, rerun with `--write`; that writes timestamped
   JSON and Markdown under private AICC state.

5. Check registered `occupied_conflict` rows first. On Windows, use the inventory's
   `Get-NetTCPConnection`/process evidence and inspect a registered service or `docker ps` only when
   needed to explain ownership; do not stop or mutate it during an audit.
6. Record deliberate assignment changes in the private registry. Keep personal aliases,
   absolute home paths, PIDs and snapshots out of the public repository.
7. Report the capture time. Mark stopped registered services as `available_or_stopped` and
   dynamic unregistered listeners as observations, not durable reservations.

## Verification

- The private registry parses and has no duplicate port.
- Every fixed port names its owner, purpose, bind scope and lifecycle.
- A browser row matches the registered process/profile/port tuple.
- If capture was requested, a written report exists under private AICC state and contains no
  unredacted secret arguments; otherwise the audit leaves no report files.
- Any unresolved conflict is explicit; the skill never hides it by silently selecting another port.
