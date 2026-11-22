# Codex Desktop JSONL transport recovery

## Purpose

This runbook handles malformed JSONL frames between Codex Desktop and its child App Server. It is intentionally component-scoped: it does not restart Web GPT 17841/17842, OCX 10100, Workspace MCP, browsers, authentication, Docker, or the Mac.

## Confirmed evidence boundary

- The failure layer is the Desktop child App Server stdout JSONL transport.
- Valid frames larger than 64 KiB and up to the observed 28.7 MB history response parse successfully through an isolated read-only App Server client. A fixed 64 KiB protocol limit is therefore excluded.
- The installed Desktop parser buffers complete newline-delimited messages and permits up to 256 MiB by default. The matching Codex App Server source serializes normal messages through one writer task.
- The matching public tag exposes one normal stdout writer (`mpsc` queue to one `stdout.write_all`). A live file-descriptor
  comparison found no current direct App Server child whose fd 1 shared the App Server's Desktop stdout endpoint, so
  current inherited-child stdout contamination is excluded.
- In the current incident, a burst of hidden/subagent conversation events preceded the first malformed frame by milliseconds. Most parse positions cluster near 64 KiB write boundaries, followed by request queue expiry. This proves the failure layer and trigger correlation; the exact byte writer is not captured by Desktop logs.

Do not describe the byte-level writer as proven until a raw transport capture or an upstream fix identifies it.
The public tag describes expected source semantics but is not a bit-for-bit provenance proof for the signed installed
Desktop binary. Remaining byte-level candidates are therefore bounded to an installed binary delta or the signed
App Server-to-Desktop stream integration; AICC does not patch either in place.

## Fail-closed containment

1. Do not spawn new subagents or fan out parallel task API reads.
2. Ask any foreign active task to stop spawning and checkpoint normally. Do not interrupt or kill it to manufacture idle.
3. Preserve the current Desktop/App Server process while work is active or UNKNOWN.
4. For new local Codex sessions, use root-only containment:
   - `[agents].enabled = false` disables the local multi-agent override.
   - `features.multi_agent_v2 = false` remains in the Web GPT-managed scalar form, so the Web GPT doctor and rollback journal stay consistent.
   - In the installed Codex source, disabled agents take precedence over a model-pinned multi-agent version, so new local sessions receive no subagent surface.
5. AICC-owned App Server clients reject every pending request and close only their own child connection on malformed JSONL. They do not retry a possibly stale request.
6. Keep DOD-08 and any acceptance that depends on official task APIs on HOLD.

## AICC-owned framing evidence

The AICC-owned App Server adapter records only bounded framing metadata for each transport failure:

- frame sequence, byte length, newline completeness, and SHA-256;
- child PID, parent PID, child start time, and a hashed process-start identity to distinguish PID reuse;
- child exit code/signal and the ordering of exit, stdout end, stderr end, and process close;
- stderr byte length and SHA-256 without retaining stderr text;
- one typed terminal: `protocol_invalid_json`, `protocol_invalid_utf8`,
  `protocol_incomplete_jsonl`, or `protocol_frame_too_large`.

An unterminated frame is marked `partialWriteSuspected=true`; all pending requests are rejected and the owned
connection is closed without retry. Valid fragmented frames larger than 64 KiB remain supported up to the bounded
256 MiB adapter limit. Prompts, conversation content, cookies, authorization material, raw frames, and raw stderr are
never included in this evidence.

## Recovery gate

After every active local task has completed naturally:

1. Confirm exact local active and UNKNOWN counts are zero.
2. Quit or restart Codex Desktop once through the safe-quit contract. When recurring
   automation is not allowed, use `aicc codex-desktop foreground-restart-once` from one
   visible Terminal rather than a hand-written shell loop. Do not force quit.
3. Confirm a new Desktop PID and child App Server PID.
4. Observe the new Desktop log for zero malformed JSONL frames, queue rejections, and catalog queue expiry.
5. Run one bounded official project/thread API canary.
6. Keep root-only containment active while executing a bounded stress canary that covers large read-only frames and the previously failing hidden-conversation path.
7. Restore concurrency only after an updated build passes that canary. Restore from the owner-only config backup, then verify the effective new-session limit.

## Last-resort Web GPT handoff

The AICC Dashboard recovery card generates an immutable, checksummed, owner-only bundle under `~/.ai-control-center/recovery/web-gpt-handoff/`. It excludes credentials, tokens, cookies, browser profiles, conversation bodies, raw logs, and absolute home paths.

Support collection runs in a separate AICC-owned child process. If it exceeds five seconds, the Dashboard terminates
only that child and generates the bundle with `UNKNOWN_SUPPORT_COLLECTION_TIMEOUT`; a broken diagnostic path therefore
cannot block the last-resort document.

Use the relevant action in the card:

- **복구 문서 갱신** refreshes the owner-only bundle with the bounded collection rule.
- **Markdown 복사** copies the current cached handoff for pasting into Web GPT.
- **진단 JSON 복사** copies the current cached structured, redacted evidence.
- **Finder에서 열기** reveals the exact Markdown file so it can be attached manually.

Copy starts with the local DOM copy path while the user gesture is active, then uses a one-second Clipboard API fallback.
A failure in both paths is shown explicitly; it does not claim that the document was copied.

Each refresh preserves previous bundles for rollback and atomically advances `latest.json` only after the new Markdown, JSON, and manifest have been written and checksummed.
