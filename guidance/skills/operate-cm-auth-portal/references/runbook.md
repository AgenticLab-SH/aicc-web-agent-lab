# CM auth portal operations runbook

## Contents

1. Sources and ownership
2. Recovery and remote execution
3. Oracle deployment
4. Cloudflare and Firebase
5. Mac, cm, and OCX
6. Verification matrix
7. Failure patterns

## Sources and ownership

Use the current AICC repository and private state, not historical paths:

- portal source: `components/account-manager/ops/auth-portal/`
- account and OCX state machine:
  `components/account-manager/docs/auth-portal-ocx-sync.md`
- deploy contract: `components/account-manager/ops/auth-portal/deploy/README.md`
- local status adapter: `src/adapters/auth-portal.mjs`
- private local configuration: the path selected by AICC, normally under the
  owner-only account-manager state root
- provider/domain ownership: AICC website-maker configuration and registry

Read the nearest repository instructions before work. Keep portal administrator
identity, pinned physical Codex account hash, cm target account, and stable OCX
slot as four explicit fields. Changing one does not authorize changing another.

## Recovery and remote execution

Prefer, in order:

1. the registered mode-0600 Oracle connection contract and safe-ops helper;
2. an existing verified SSH path with host-key checks intact;
3. OCI Run Command after its exact plugin row reports enabled and running and a
   harmless echo command reaches a terminal state;
4. CloudShell only as the official control surface for short OCI CLI/file
   operations.

For a login-bound browser, select the session with `choose-browser-session`.
Use an existing user-browser tab only when the user explicitly requests
that exact state. Verify endpoint, process, profile, account, and exact target.
Replace an unresponsive renderer with a new target in the same verified profile;
do not keep reading cached screenshots or hidden rows from the old target.

For Oracle plugin state, scope the observation to the exact Run Command table
row and its cells. A nearby `running` badge, a stale screenshot, or an offscreen
virtualized row is not proof. Keep one CloudShell writer. Never let a parent and
child agent type concurrently, reuse a prompt with buffered text, or send a long
quoted command through per-character browser input. Require a fresh prompt and
a sentinel after every short command. Prefer uploaded short scripts and bounded
result polling.

Run Command recovery may toggle only the exact Run Command plugin when the user
authorized it. Verify the row before and after. Do not touch other plugins or
reboot as a workaround. If a command stays accepted but unreceived, stop after
bounded polling and preserve the partial deployment.

## Oracle deployment

Before mutation, record without secret values:

- architecture, available memory, disk use, failed-unit count;
- broker, Tunnel, and protected service/timer active/enabled states;
- loopback listener ownership and health;
- cost guard and no-paid-resource boundary;
- previous release and rollback availability.

Use the canonical idempotent deploy bundle. Keep the broker environment mode
0600, state directory mode 0700, and retained OAuth files mode 0600. Bind only
to loopback. Install the pinned Codex package for the detected architecture and
verify the archive hash, not the extracted executable against an archive hash.

Install cloudflared as a dedicated service using one pre-created Tunnel
credential file. Keep the credential directory 0700 and JSON 0600. Do not open
the broker port in the host firewall. After deployment, recheck every protected
unit/timer and bounded logs for token, bearer, and full account-id leakage.

## Cloudflare and Firebase

Discover account, zone, current Tunnel list, DNS, Access applications, and plan
before mutation. Create or reuse only the portal-owned named Tunnel. Never add a
portal origin to an unrelated Tunnel merely because it is healthy.

Configure exactly:

- portal hostname to the broker loopback origin;
- a terminal `http_status:404` ingress rule;
- human portal Access allow policy for the configured operator identity;
- `/api/mac/*` Access bypass, relying on the strong broker bearer;
- optional `/health` bypass for monitoring;
- the exact hostname in the configured Firebase project's authorized domains.

The broker remains the authority for Firebase ID-token verification,
`email_verified`, the server allowlist, session signing, origin, CSRF, and CSP.
Cloudflare headers and client-side allowlists are not sufficient authorization.
Reuse only public Firebase web configuration; never copy another product's
session cookie, ID token, or user credential. Do not enable a paid Cloudflare or
Firebase feature.

Verify authoritative DNS and two public resolvers. A proxied Tunnel record may
answer A/AAAA rather than expose its CNAME. Require a valid certificate and the
expected Access/Firebase behavior on the normal hostname.

## Mac, cm, and OCX

Render the canonical LaunchAgent template with verified absolute launcher,
Node, Python, and home paths. Store the machine bearer under the configured
Keychain service. The local env file must be mode 0600 and must bind an existing
cm account and existing stable OCX slot. Keep the historical LaunchAgent label
only until an intentional unload/load migration window.

Before loading, hash every cm account auth file into a protected snapshot and
record the active account without printing either. With no pending job, require
an exit-zero no-work result. A network or HTTP 530 result is not no-pending.

For a real retained login, apply only after full physical account-id equality.
The OCX importer must:

- observe zero active turns;
- snapshot bounded private OCX state;
- stop only OCX;
- start a one-shot loopback process with the manual import gate;
- update the exact stable target through native API/CLI surfaces;
- verify safe metadata and refresh/access status;
- restore the prior active slot and normal gate-free service;
- roll back natively and from the snapshot on failure.

Never persist the manual-import gate, hand-edit live OCX credential files, create
a duplicate slot for the same owner, or change Kiro/another provider selection.

## Verification matrix

Require all applicable rows before declaring production complete:

| Layer | Evidence |
|---|---|
| Source | Canonical diff only; local tests and static checks pass |
| Oracle | Broker and Tunnel units active; loopback listener and health succeed |
| Preservation | Protected units/timers/cost guard unchanged; failed units do not regress |
| Tunnel | One connector or more on the portal-owned Tunnel; no unrelated Tunnel change |
| DNS/TLS | Authoritative plus two recursive views; valid normal-host TLS |
| Browser gate | Anonymous human portal reaches Access/Firebase gate; wrong identity denied |
| Mac API | Wrong bearer 401; correct bearer returns 204 no-pending or the one expected job |
| Firebase | Server verifies ID token, verified email, allowlist, origin, CSRF, and session |
| Mac | Keychain present; LaunchAgent loaded, RunAtLoad, 900-second interval, exit zero |
| cm | Every non-target auth hash unchanged; target changes only after validated login |
| OCX | Stable target visible and healthy; prior active OpenAI slot and Kiro/provider state restored |
| Logs | No OAuth token, bearer, full account id, session cookie, IP, instance id, or key path |
| Registry | Record only after all production checks pass |

Report `infrastructure ready` and `human login pending` separately. The external
operator must use the allowed Google identity and approve their own official
OpenAI device login; the agent must not bypass CAPTCHA, MFA, consent, or account
selection.

## Failure patterns

- HTTP 530 with valid DNS/TLS usually means the Tunnel has no connected replica;
  do not call it a portal failure or a complete release.
- A CNAME may be hidden by Cloudflare proxy answers; evaluate A/AAAA, provider
  route state, and TLS separately.
- `RunAtLoad` can immediately apply retained auth. Do not load before mappings,
  Keychain, and preservation snapshots are ready.
- A LaunchAgent has a minimal PATH. Render explicit Node/Python paths from the
  canonical template instead of copying an interactive-shell assumption.
- Do not compare a package archive hash with an extracted executable hash.
- Do not treat a hidden/stale DOM row or a screenshot from a replaced browser
  target as current evidence. Use one exact live target and one scoped row.
- Do not recover credentials, hosts, or keys from chat/session logs. Use current
  private state or report the precise missing connection contract.
