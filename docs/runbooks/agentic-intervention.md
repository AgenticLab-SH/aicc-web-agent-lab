# Agentic coding and last-resort intervention

## Outcome

An agent should finish scoped coding work without asking the owner to drive the process. The fixed order is:

```text
code/local files -> CLI -> API -> MCP -> browser -> authorized Computer Use -> human-only gate -> owner-local notification
```

An available automatic route suppresses notification. Computer Use requires an explicit current-screen grant for the exact task and target. The grant is not stored as permanent global authority. Destructive or irreversible external actions keep their separate approval and recovery boundaries.

This follows OpenAI's current guidance to make autonomy and approval boundaries explicit, continue through safe local actions, keep long-running work tied to a definition of done, and separate independent writers. See [model guidance](https://developers.openai.com/api/docs/guides/latest-model), [long-running work](https://learn.chatgpt.com/docs/long-running-work), and [scheduled tasks](https://learn.chatgpt.com/docs/automations).

## Structured decision

Pass a secret-free request on stdin:

```powershell
$request | ConvertTo-Json -Depth 5 | node .\src\cli.mjs intervene plan --json
```

`autonomousRoutes` contains one record per applicable route with `ready`, `succeeded`, `failed`, `unavailable`, `prohibited`, or `not_applicable`. `computerUse` records availability, task-scoped current-screen authorization, and its attempt state. The planner returns one of:

- `continue_automatic`: execute the named route and do not alert.
- `use_computer`: use only the exact authorized screen target and do not alert.
- `complete`: stop because the goal is already satisfied.
- `notify_user`: one human gate remains; the returned event is safe to arm.

Use `intervene arm` with the same input only after the plan has been inspected by the calling automation. It delegates to the durable notification outbox; it does not bypass delay, identity checks, deduplication, or secret filtering.

## Human-only gates

The narrow reason set is CAPTCHA, MFA/OTP, UAC secure desktop, biometric or physical presence, credential entry, identity verification, legal acceptance, payment confirmation, subjective owner judgment, and task-scoped current-screen authorization. Exhausted automatic routes are also a valid blocker only when none is still marked ready.

Slack is an outbound attention path. The owner answers in the original Codex task. OTP and secrets never enter Slack. Routine progress and an unchanged HOLD are not alerts.

## Windows Slack backend

The existing non-secret fields `keychainService` and `keychainAccount` remain schema-compatible references. On macOS they resolve to Keychain; on Windows they resolve to a Generic Credential in Windows Credential Manager. `store-bot-token.mjs` accepts the token only on stdin, never argv, and returns no token.

```powershell
Get-Clipboard | node .\tools\platform\slack\store-bot-token.mjs --service aicc-slack-alerts --account <exact-team-id>
Set-Clipboard -Value $null
node .\tools\platform\slack\inspect-bot-identity.mjs --service aicc-slack-alerts --account <exact-team-id> --team <exact-team-id>
```

Creating or installing the permission-minimal Slack app and selecting its exact workspace remain external account actions. Complete them through an authorized browser/Computer Use flow when possible; otherwise request that single human gate and keep all identifiers and policy files owner-local.
