# Token-free worker reporting

Worker tasks do not use Codex task messages as an event bus. They write one bounded,
owner-local JSON report through the AICC CLI. Collection, validation, deduplication,
attention classification, and snapshot generation are deterministic and make no model
or network call.

## Write a report

Pass exactly one JSON object on stdin:

```powershell
$report = @{
  schemaVersion = 1
  controlPlaneId = 'integrated-work-control'
  workerId = 'windows'
  workerSequence = 1
  status = 'DONE'
  revision = 'windows-canonical-r1'
  summary = 'Windows canonical path verification passed.'
  completed = @('Canonical source checks passed.')
  remaining = @('Live installation is pending.')
  choices = @()
  nextAction = 'Prepare the existing runtime candidate.'
  evidence = @(
    @{ type = 'receipt'; ref = 'dev-junction-retirement'; sha256 = ('a' * 64) }
  )
}
$report | ConvertTo-Json -Depth 5 -Compress | aicc report write --json
```

Allowed statuses are `PROGRESS`, `DONE`, `HOLD`, `APPROVAL_REQUIRED`, and `DRIFT`.
`HOLD`, `APPROVAL_REQUIRED`, and `DRIFT` require one concise `nextGate`. A worker owns
its monotonically increasing `workerSequence`. Replaying exact content is idempotent;
reusing the sequence for different content or sending an older sequence fails closed.

Reports accept at most eight evidence references and reject unknown fields, prompt
bodies, and secret-like assignments. Runtime state is stored under the existing
owner-local `~/.ai-control-center/control-plane/reports-v1` root, never in Git.
The published input contract is [`control-report.schema.json`](../../contracts/control-report.schema.json).

The fixed dashboard form reads optional `completed`, `remaining`, `choices`, and
`nextAction` from this same report. Each list has at most six single-line strings of
240 characters; `nextAction` has at most 160 characters. Omit fields a producer does
not support; use an empty list only when it explicitly has no entries. Evidence keeps
its existing eight-reference limit. Write a new worker sequence when any field changes;
do not paste a terminal transcript or repeat the full handoff. Legacy v1 reports and
journal hashes remain valid. `DONE` describes the producer report and is never proof
of overall task completion.

Only `session-registry.reportWorkerIds` associates a report with an exact agent thread.
For a registered worker, a report with a strictly newer timestamp may replace display
fields; an absent, invalid, equal, or older timestamp keeps the worker result. Newer
reports cannot confirm overall completion or hide a running worker. Pending user
decisions remain visible. Writes do not themselves send messages or wake agents.
The explicitly enabled bridge below consumes this store and arms the existing
Slack outbox without creating a second report ledger.

## Read without creating a Codex turn

```powershell
aicc report status --json
aicc report digest --since EXACT_SHA256 --json
```

`digest --since` returns no worker payload when nothing changed. The central task reads
the snapshot only when the user asks for a report or an external deterministic hook
finds a changed digest. Workers never call `send_message_to_thread` for status updates.
On change, the bounded worker digest includes the optional structured fields. An
unchanged digest returns an empty worker array including after process restart.

The store uses one writer lock, atomic snapshot replacement, a bounded hash-linked
JSONL journal, strict identity/schema checks, and replay after a crash between journal
append and snapshot rename. It never schedules a Codex heartbeat by itself.

## Owner-enabled automatic Slack reports

`Install-AiccControlReportBridge.ps1 -TaskId <exact UUID> -ProjectKey <key>`
connects the existing one-minute notification task to a pinned reporting candidate.
It preserves the registered Slack sender, credentials, schedule and outbox.
It creates no model call, new scheduled task, hook trust entry or agent message.
The previous launcher, scheduler metadata and task XML are backed up; restore
the launcher and metadata together from that exact backup to roll back.

Only explicitly mapped worker IDs and reports written after enablement are read.
The controller writes `central-controller` or `g1-controller` through
`g4-controller` using the existing `report write` contract and increasing sequence.
One meaningful result per completed development unit is sufficient. PROGRESS
without a completed item is silent. DONE means a unit result, not portfolio completion.

The bridge renders at most 700 characters: conclusion, KST, changes, remaining
work and next action. It strips local paths, links, email addresses, UUIDs and
secret-like values. Semantic content determines the outbox ID: repeated polling,
sequence/revision/timestamp changes and restarts do not resend unchanged content.
Normal reports retain the existing two-minute delay; approval requests use the
existing immediate priority. Historical HOLDs are not broadcast on installation.
An outbox receipt, actual Slack delivery and mobile push remain separate evidence.

### Writer compatibility

If an older installed CLI rejects structured fields before writing, record the
version/contract mismatch. Do not discard completed/remaining to make an empty
progress report pass. In an authorized source workspace, its existing CLI can write
the same owner-local contract with `node bin/aicc report write --json`; this changes
neither the installed runtime nor the sender. A PowerShell component helper that
does not accept pipeline input is not a stdin report writer. Reconcile unknown
write outcomes before retrying; a parser rejection before storage is distinct.
