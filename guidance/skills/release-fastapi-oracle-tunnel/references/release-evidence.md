# Release evidence and recovery matrix

## Pre-mutation evidence

- application repository, branch, exact commit, dirty files excluded
- build command, allowlisted output, bundle SHA-256 and file count
- registry provider/domain pre-state
- selected hostname absent from DNS, Pages domains, Worker routes, and registry
- selected port unoccupied or owned by the same app service
- Oracle machine fingerprint, available memory/disk, failed-unit count
- protected unit names and active states
- current Tunnel names and states

Do not record an account ID, zone ID, Tunnel token, origin address, instance ID,
SSH target, identity path, operator password, cookie, or session token.

## Mutation sequence

| Phase | Mutation | Required proof | Recovery |
| --- | --- | --- | --- |
| Tunnel | create one dedicated remotely managed Tunnel and bounded ingress | exact name, inactive/healthy state, ingress host/service, 404 catch-all | delete only the new Tunnel while DNS is absent |
| Origin | install release, environment, token, and two units | local 2xx, protected API denial, authenticated safety gate, units active | rollback symlink only after a switch; otherwise leave previous release |
| Connector | start cloudflared | Tunnel healthy and connector count at least one | stop/remove only the new Tunnel unit and token |
| DNS | create one proxied CNAME | exact name/type/proxy/comment and public recursive answers | delete only the exact new record |
| Public | verify TLS, app, API, desktop/mobile | browser-visible release evidence and zero relevant failures | delete DNS first, then stop new Tunnel/app; retain origin release for diagnosis |

## Final evidence

- primary HTTPS URL and exact critical route statuses
- TLS/HSTS, DNS resolver counts, Tunnel health and connector count
- origin release ID, commit SHA, app/Tunnel units, local port
- provider trust/status text visible in the app
- desktop and mobile viewport/overflow/target-size results
- console and failed-network results
- reduced-motion and preview play/reset results
- authenticated paper/mock safety snapshot and live-order count zero
- tests, typecheck, lint warnings, build, push, and exact CI state
- Keychain service/account or equivalent secret-store locator, without value
- degraded dependencies and UNKNOWN checks

Run a final read-only provider and Oracle audit. Compare protected units and
unrelated Tunnel/DNS lists with the pre-state before reporting isolation.

## Uncertain mutation and acceptance

Preserve existing secret environments and paper/mock/live-off locks across releases; do not create test orders to prove a release. An ambiguous provider mutation requires reconciliation of that exact operation before any new send. Keep the previous active release on a pre-switch failure and use the actual recorded previous release for a post-switch rollback. Tests, builds, audits and post-reads run only when current policy and explicit scope allow them. Unrun checks are NOT_RUN and the corresponding live acceptance remains incomplete.
