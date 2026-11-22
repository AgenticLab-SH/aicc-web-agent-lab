---
name: notify-user
description: 필요한 사람 개입 알림이나 사용자가 요청한 결과·계정·그룹 보고를 기존 Slack 봇으로 보낸다. 모바일용 짧은 표와 근거별 상세 보고를 지원하며 자동 진행 스팸은 제외한다.
---

# Notify User

Create one event and let owner-local AICC policy choose the transport. Here,
verified `AICC Alerts` Slack is the required attention route. Never infer a
route from an available connector or fall back to a self-authored DM.
This is the historical route name; the installed owner's display name can be
`AICC 한도 운영`. Match verified IDs, not the display label.

## Requested mobile reports

When the user asks for a Slack report, use
[the mobile report procedure](references/mobile-report.md): conclusion first,
short group bullets or a narrow table, then remaining work and the next action.
Send within the existing authorization; do not wait for another confirmation.
Use the included `scripts/send-mobile-report.mjs` for an internal `report_ready`
body that must retain its full table rather than the compact alert truncation.
Always keep Slack reports easy to scan on mobile: a short conclusion, one or two lines per group, and one next action. Prefer bullets for four groups; omit raw logs, internal IDs and repeated history. Existing urgency, exact route verification, outbox, dedupe and privacy rules apply.

When the owner has enabled the automatic control-report bridge, write meaningful
development results through the existing `aicc report write` contract using its
mapped worker ID. The existing notification task formats and arms Slack reports.
Do not manually send the same result again. See `docs/runbooks/control-plane-reporting.md`
in the AICC source. Unchanged state, raw transcripts and routine polling stay silent.

## Workflow

1. For an execution blocker, apply `$run-evidence-gated-ai-development` and run
   `aicc intervene plan --json`. Alert only for `notify_user`: keep its exact
   notification identity, set `urgency: 5`, and use `aicc notify arm --json`
   after route verification. Continue independent safe work while waiting.
2. Classify the event as `user_response_required`, `approval_required`,
   `critical_error`, `task_completed`, `deployment_complete`, `report_ready`,
   `otp_required`, or `routine_progress`.
3. Do not notify for routine progress, unchanged HOLD, general conversation, or
   ordinary completion/deployment/report availability. Send completion or report
   alerts only when explicitly requested; a real required decision is an
   intervention, not a completion notice. Keep the final answer in the original task.
   The user's phone report is one Slack path, this outbox. "사용자가 할 일" means
   `user_response_required`/`approval_required`; "핵심 결과" means one final
   `report_ready` (urgency 2) per supervised group or long run, sent only where the
   user asked for result reports. Never send per-step progress. Product monitors
   (for example the OCX quota threshold monitor) arm events here too and do not
   post through their own Slack transport.
4. Necessary user response, approval, or a critical failure needing human action
   uses `urgency: 5` (immediate). Urgency must not manufacture a need for intervention.
   For explicitly requested non-intervention alerts use the requested urgency,
   otherwise 2. Use the numeric field, not a color, emoji, or hand-written prefix.

5. Assign stable event and task/thread correlation IDs. Write one short Korean
   sentence each for title and summary, and one action in `nextGate`. Exclude
   secrets and private prompts. Show user times as labelled KST; retain UTC
   internally. Do not add color emoji, English-only titles, or urgency prefixes.
6. Resolve exact project key, owner/route, and Codex task ID; never infer a
   project from its title. Use the registered routing map, else `unmapped`, and
   state the local root only in the original task. Every event includes exact
   `projectKey` and `taskId`; the sender keeps the task UUID private.
7. Run `aicc notify status --verify --json`. For Slack-primary policy, pass one
   event on stdin to `aicc notify arm --json`. Its durable outbox delays by
   urgency, deduplicates by event ID, stores only a bounded redacted payload,
   and purges it at acknowledgement, cancellation, delivery, expiry, or HOLD.
   Do not bypass it with `notify send`.
8. Invoke `telegram-notify` only when the owner policy selects Telegram or an OTP
   flow explicitly requires it. Never send an OTP, password, token, cookie, or
   native-auth value to Slack.
9. Answer in the original task unless the exact Slack response bridge is live.
   Buttons bind one owner/message to one frozen task/operation and expiry;
   ordinary Slack text and protocol ACK are not approval. The ACK hook only
   cancels waiting alerts. CAPTCHA additionally needs an armed exact-task
   callback that starts one continuation turn.
10. After one failed CAPTCHA read, use the live-gated minimal-image and bound
    Slack input flow in [the CAPTCHA procedure](references/captcha-response.md).
11. Record only event ID, channel, delivery state, timestamp, and redacted error
   in task evidence. Do not persist the outbound body when sensitivity is
   restricted.

## Message format

이 단계는 [상세 절차](references/message-format.md)를 읽고 수행한다.

## 발송 보호와 응답

발송 전 [비밀·중복·모바일 알림과 Slack 응답 경계](references/delivery-safety.md)를 따른다. 비밀과 원문을 보내지 않고, 기존 outbox·검증된 신원·사건 중복 억제를 유지한다.
