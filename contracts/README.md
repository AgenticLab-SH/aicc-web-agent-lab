# open-AICC public contracts

This directory contains the portable boundaries shared by the public control
plane, optional adapters, durable jobs, browser leases, and owner-local state.
The schemas preserve unknown future fields at the root unless a required
invariant is missing. The two remote local/session read schemas are deliberately
closed so undeclared raw paths, bodies, tokens, or tool output cannot cross that
security boundary.

Included contracts:

- `codex-responses`: router, streaming, and error semantics
- `model-adapter`: provider-neutral capabilities and identity binding
- `jobs`, `artifacts`, and `orchestration`: durable attempts, one writer, and verifiable results
- `browser` and `remote`: exact target/workspace leases; `remote/oob-adapter` keeps OS-level operations/recovery separate from Workspace MCP and forbids silent normal-work fallback
- `private-state`: movable open-AICC state versus external application-owned state
- `mcp`: turn-bound Web GPT tools versus persistent Workspace MCP
- `maintenance` and `compatibility`: zero-active mutation, rollback, and bounded updates
- `extensions`: public or optional-private plugin and adapter lifecycle
- `skills`: owner-local skill catalog shape without private inventory values
- `knowledge-review`: manual official-source crawling, candidates, and append-only review decisions
- `projects`: local/Notion projection, evidence-weighted progress, and guarded priority outbox
- `workspaces`: portable content-addressed snapshot identity, read-query result, and manifest-bound validated ZIP;
  canonical absolute roots and owner-local CAS paths are not part of the adapter response contract
- `assets`: normalized project/skill/plugin/ChatGPT records, provider capabilities, guarded operations,
  inventory projection, and owner-local Notion connector mapping
- `remote/local-source-grant` and `remote/codex-session-index`: explicit exact-root grants and metadata-only session access

Installed Codex App Server schemas are generated from the installed official
binary and are version-specific. They are not copied into this public package
as a permanent second source of truth. Compatibility tooling should generate a
snapshot in an ignored, owner-local compatibility workspace and record only the
version and tree hash needed for reproducibility.

The contracts do not contain provider credentials, account aliases, browser
profiles, workspace inventories, private repository URLs, or absolute user paths.
