---
name: operate-cm-auth-portal
description: 기존 macOS cm-auth 동기화와 보호된 OCX 가져오기를 운영한다. Windows 배포 제외.
---

# Operate CM Auth Portal

## Platform boundary

This workflow is retained for the legacy macOS auth-sync installation. On Windows, do not run
`scripts/audit_local_state.py`, install a LaunchAgent, or translate Keychain steps by guesswork.
Audit the remote Oracle/Cloudflare/Firebase portal read-only, use the provider- or project-owned
Windows deployment workflow, and leave local auth sync `HOLD` until a Windows service and secret-store
contract has its own recovery transaction.

Operate the AICC-owned portal without reconstructing infrastructure from chat
history or moving credentials between owners. Treat a deploy command as an
intermediate step; require verified HTTPS, Mac sync, and preservation evidence.

## Load the owning workflows

Read and apply `oracle-server-safe-ops`,
`cloudflare:cloudflare`, `agentic-website-maker`, `choose-browser-session`,
`browser-qa`, and `codex-multi-account`. Read `manage-codex-model-routes` before
stopping, starting, importing into, or changing OCX.

Read [references/runbook.md](references/runbook.md) completely before any
provider, server, browser, Keychain, LaunchAgent, cm, or OCX mutation. Read the
AICC account-manager documents and deploy README identified there.

## Fix the execution contract

Discover every deployment-specific value from the private AICC state, central
website registry, provider, or existing server contract. Never hardcode or
infer an email, account id, hostname, Tunnel id, port, host, key, browser target,
Firebase project, OCX slot, or protected service from an old conversation.

Change only the portal broker, its dedicated Tunnel, its Access application,
the configured Firebase authorized domain, the Mac auth-sync installation, and
the explicit cm/OCX target. Preserve all neighboring services, existing
Tunnels, DNS records, browser profiles, cm accounts, active account selection,
OCX Kiro and other providers, VCN/firewall rules, and cost controls.

Do not create a paid resource, public inbound port, VCN/security-list rule,
reboot, key rotation, or persistent OCX manual-import gate. Never print or log
an OAuth envelope, bearer, session secret, full physical account id, server
address, instance id, private-key path, browser credential, or provider token.

## Follow one guarded state machine

1. Establish one writer and capture a redacted pre-state: source status, tests,
   four cm auth-file hashes without values, active cm account, OCX active slot
   and provider state, Oracle protected units/timers, Tunnel/DNS/Access state,
   Keychain entry presence, and LaunchAgent state.
2. Run `scripts/audit_local_state.py --aicc-root <verified-root>`. Resolve every
   failed prerequisite before remote mutation.
3. Validate the canonical account-manager portal source. Use its existing
   idempotent deploy and rollback units; do not rebuild it in a generated home.
4. Reach Oracle only through a registered private connection contract, existing
   verified SSH path, or an official Run Command path that passes a harmless
   echo preflight. Audit memory, disk, failed units, port ownership, broker
   health, protected units, and cost guards before deployment.
5. Keep the broker on its configured loopback address. Use one dedicated named
   Tunnel and one exact hostname ingress followed by `http_status:404`. Keep
   `/api/mac/*` outside browser Access redirects and protected by its machine
   bearer; allow `/health` bypass only when required for monitoring.
6. Configure the human portal Access policy and Firebase authorized domain from
   the discovered private configuration. Enforce the allowed verified email at
   the broker even when Cloudflare Access is present.
7. Install the machine bearer in Keychain and the rendered LaunchAgent only
   after verifying the exact cm account and stable OCX target. Loading a
   `RunAtLoad` agent may immediately apply retained auth.
8. Import into cm or OCX only after a new external login is complete and the
   incoming full account id matches the pinned target. Require zero active OCX
   turns, one writer, private snapshots, the one-shot import gate, native API
   verification, rollback, and restoration of the prior active slot.
9. Prove the final matrix in the runbook. Record production state only after
   normal DNS, TLS, Access/Firebase flow, bearer API behavior, Mac no-pending or
   applied sync, logs, and protected-state invariants all pass.

## Stop conditions

Stop without changing targets when browser identity, server contract, account
mapping, Firebase project, Tunnel ownership, or OCX slot is ambiguous. Stop on
host-key failure, a Run Command that remains unreceived, a concurrent
CloudShell/terminal writer, nonzero active OCX turns, auth hash drift before an
approved login, or any request for a paid/network/reboot expansion.

Separate infrastructure-ready state from the human-required Google and official
OpenAI device authorization. Never force the human login or report an HTTP 530,
Access loop, missing connector, stale browser screenshot, or unverified import
as complete.
