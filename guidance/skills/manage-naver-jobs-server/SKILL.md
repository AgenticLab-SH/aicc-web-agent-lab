---
name: manage-naver-jobs-server
description: 연장·IP·SSH 변경 후 기존 NAVER Jobs Linux 서버를 복구한다. 무관한 서비스는 보존한다.
---

# NAVER Jobs server operations

The canonical application repository is
`C:/demo/projects/web/apps/semiconductor-job-crawler`. Read its nearest `AGENTS.md`,
`.openai/website-profile.json`, and the **NAVER 운영** section of `deploy/README.md` before acting.
Current observations belong in `HANDOFF.md` or the project context, not in this skill.

## Stable entrypoint

Treat `afw-jobs-naver` as the stable local interface. Do not copy a public IP into routine SSH
commands, source code, or this skill. Start with:

```powershell
pwsh -NoProfile -File operations/Manage-NaverJobsSsh.ps1 -Action Status
```

If it passes, reuse the alias even when a renewal was recently requested. A renewal request is not
proof that the instance, IP, user, key, or expiry actually changed.

## Renewal or address change

When the expiry or instance state matters, use `use-ops-bookmarks` to read the existing signed-in
NAVER Cloud console. Record only the instance identity, state, current public address, and observation
time; do not save browser sessions, tokens, key contents, or full console captures.

If only the public address changed, keep the alias and verify host-key continuity before updating it:

```powershell
pwsh -NoProfile -File operations/Manage-NaverJobsSsh.ps1 -Action Plan -NewHost <verified-address>
pwsh -NoProfile -File operations/Manage-NaverJobsSsh.ps1 -Action Apply -NewHost <verified-address>
```

The helper backs up the two SSH files, changes only the exact alias block, retains strict host-key
checking and batch mode, and rolls back when the canary fails. It refuses a new address whose scanned
host keys do not match the already pinned server keys. A host-key mismatch can mean a recreated or
reinstalled instance: do not delete the old key, accept a key automatically, or use
`StrictHostKeyChecking=no`. Continue only with a separately verified provider-side identity and an
existing owner-supplied key.

`-NewUser` and `-IdentityFile` may be added only when those exact values were verified and the key file
already exists. The helper does not create credentials or change server authorization.

## Server checks and mutations

Use the repository's bounded `naverctl status --target naver-main` command for the application state.
Public HTTP 401 can be the expected Central Access boundary; compare it with the authenticated internal
health check instead of treating it alone as an outage.

Restart, reboot, deployment, tunnel, DNS, firewall, or provider lifecycle changes require the current
user request to cover that mutation. For a reboot, use `high-risk-change`: capture boot ID, failed units,
disk, memory, app units, timers, tunnel, and internal health before and after. Preserve the application
rollback snapshot and unrelated services. Expect SSH to return before the LLM and web health are fully
ready; bounded retries must distinguish startup delay from failure.

If the instance no longer exists or the host key changed, stop at verified diagnosis. Do not recreate a
server, allocate paid resources, rotate keys, or change networking without exact authorization and a
recovery contract.
