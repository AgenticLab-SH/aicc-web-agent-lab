# Agent context simplification plan

## Touchpoints

- `tools/platform/inspect/inspect-skill-ecosystem.mjs` and `test/skill-ecosystem.test.mjs`
- `guidance/skills/run-evidence-gated-ai-development/` and trigger tests
- `docs/agent-context-optimization.md`, `docs/skill-ecosystem.md`, platform baseline/review, and `context/PROJECT.md`
- `guidance/config/agent-catalog.toml` only if the measured active/cold review supports a change

## Order

1. Correct the official user-skill root and add deterministic context-cost fields.
2. Review every active description and explicit invocation policy; narrow only demonstrated overlap.
3. Separate intent/spec ownership from long-running execution evidence.
4. Record current MCP/plugin topology and keep/retire/defer decisions.
5. Deploy canonical guidance and run focused, live, and full Windows checks.

## Recovery

- Revert only the exact source files changed by this slice.
- Re-run `aicc guidance deploy --target codex` to restore the owner home from canonical source.
- Do not mutate live plugin, MCP, model, account, or route state in this slice.
