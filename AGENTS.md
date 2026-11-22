# open-AICC

- Start with `docs/agent-operations.md`; follow only links needed for the task and verify mutable state live.
- This child is the public core. Keep personal paths/accounts, secrets, sessions, browser profiles, auth stores, and runtime state out of tracked or displayed output; native owners keep their state.
- Work and Git only in this repository. Preserve dirty work; integrate vendored upstream through narrow adapters.
- `guidance/` is the only source for managed directives and skills. Generated files and agent-home copies are deploy-only; Codex is default and other targets are explicit.
- Keep local control on `127.0.0.1`. Control-plane mutations require a named action, fresh preview, one-use confirmation, single writer, pre/post-state checks, and rollback. Workspace MCP stays within its registered grant, lease, and OS sandbox.
- Tests use fake runners; never switch real accounts/routes or stop live OCX. Run nearest tests, then the OS gate (`verify:windows` or `verify:mac`) before publication.
