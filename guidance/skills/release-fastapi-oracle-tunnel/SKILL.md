---
name: release-fastapi-oracle-tunnel
description: 승인된 FastAPI·프런트엔드를 Cloudflare Tunnel로 Oracle에 배포하고 복구·브라우저 검증한다.
---

# Release FastAPI to Oracle Tunnel

Turn an authorized local FastAPI product into a verified production service
without guessing an account, host, domain, credential, or neighboring service.

## Load the owning workflows

Read and apply `agentic-website-maker`,
`oracle-server-safe-ops`, `cloudflare`, `wrangler`, `choose-browser-session`, and
`browser-qa`. Read [references/release-evidence.md](references/release-evidence.md)
before the first provider mutation.

Use a Cloudflare connector/API or authenticated CLI before browser UI. Use a
task-owned browser target only to verify account identity or browser-visible
behavior, then release it. Never inspect cookies, profiles, or unrelated tabs.

## Establish the release contract

1. Read the nearest instructions, README, handoff, source-root website profile,
   and central workspace registry.
2. Inspect Git status and preserve unrelated dirty files. Build from an exact
   committed SHA with narrow pathspecs.
3. Require explicit production authorization. An old `unrecorded-local` record
   is a discovery gate, not permission to guess infrastructure.
4. Discover the current Cloudflare account, allowed root domain, exact zone,
   existing DNS, Pages, Workers routes, and Tunnel names through read-only calls.
5. Discover an existing Oracle connection contract from private runtime state.
   Require mode `0600`; pass its path explicitly. Never copy it into the app or
   print its values.
6. Select one unoccupied hostname and one unoccupied localhost port. Record the
   pre-state and exact rollback targets before mutation.

Stop before mutation when account, zone, origin, host, connection contract, or
hostname ownership conflicts. Do not reuse another product's Tunnel, systemd
unit, port, service user, DNS record, or persistent directory.

## Prepare the app-owned release

Prefer an existing app-local deploy helper. If absent, add a narrow app-owned
bundle with:

- allowlisted backend source and built frontend only;
- no Git history, tests, docs, source maps, `.env`, key, token, or local data;
- a dedicated system user and `/opt/<service>/releases/<id>` layout;
- an atomic `current` symlink and recorded previous release;
- app-owned shared data/runtime/log/model directories;
- one uvicorn worker for a DuckDB writer unless the app proves a different DB
  concurrency model;
- an environment file and Tunnel token under `/etc`, mode `0640` or stricter;
- dedicated app and Tunnel systemd units;
- `deploy.sh`, `verify.sh`, and conditional `rollback.sh`.

Generate application secrets on the origin. Preserve an existing environment
file on subsequent releases and append only non-secret forward configuration.
Never place a password or Tunnel token in a command argument, source file,
commit, shared log, or final response.

For financial software, explicitly set paper/mock backend, live unlock off,
live ordering off, live dry-run on, and real-account opt-in off. Verification
must prove these runtime values through the authenticated API without submitting
an order, cancellation, amendment, or mode change.

## Release the origin

1. Run local tests, typecheck, lint, and production build.
2. Create an exact-SHA bundle and record its SHA-256 and allowlist count.
3. Audit the Oracle host through the private contract: machine fingerprint,
   available memory/disk, failed units, protected units, port ownership, Python,
   and cloudflared. Do not report the target, address, instance identifier, or
   key path.
4. Create a dedicated remotely managed Tunnel only after the audit passes.
   Configure exactly one hostname ingress to `http://192.0.2.1:<port>` plus a
   final `http_status:404` rule. Do not create DNS yet.
5. Retrieve the Tunnel token without printing it and install it through stdin or
   a mode-`0600` transient channel. Start the app and Tunnel units.
6. Verify local public paths, anonymous protected API denial, a real operator
   login, session cookie/CSRF behavior, runtime safety gates, and protected
   neighboring units.
7. Confirm the Tunnel is healthy with at least one connector.

If deployment fails before the active symlink changes, do not roll back. If it
fails after the switch and a previous release exists, run the app-owned rollback
once and verify it. Keep DNS absent until origin and connector checks pass.

## Connect and prove the hostname

Create one proxied CNAME from the selected hostname to the exact Tunnel UUID.
Recheck that no record appeared between preflight and creation.

Verify all of the following on the normal hostname:

- authoritative and two public recursive DNS views;
- valid TLS and HSTS for a TLS-only production service;
- homepage/title and all allowlisted public preview/spec paths;
- anonymous protected API denial and health response;
- authenticated desktop and mobile critical flows;
- source/freshness/error labels, no fixture presented as live;
- responsive overflow and interactive target sizes;
- keyboard semantics/focus, reduced-motion behavior, console errors, and failed
  network requests;
- no production live-order call.

Use the browser evidence to find and fix user-visible release mismatches. A
trust/status strip must show the recorded production provider and hostname; it
must not keep claiming local-only after release.

## Record and hand off

After production verification only:

1. Update the app profile and central registry with the exact provider,
   provider resource, primary URL, deployment mode, data mode, critical paths,
   and verification time.
2. Record the release SHA, bundle hash, remote release ID, Tunnel name, hostname,
   systemd units, port, public paths, safety gate, test results, and rollback.
3. Store an operator password only in an OS secret store. On macOS, call
   `security add-generic-password ... -w` with the password on stdin so it is not
   present in process arguments. Report the Keychain service and account, never
   the password.
4. Commit and push only task-owned files. Query the exact CI run; absence of a
   workflow is not green CI.
5. Report remaining degraded dependencies and UNKNOWN browser checks precisely.

Do not claim completion from a deploy command alone. Require user-visible HTTPS
evidence and a final post-release Oracle/Cloudflare audit.
