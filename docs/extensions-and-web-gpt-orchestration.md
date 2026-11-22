# Extensions and Web GPT orchestration

AICC ships a public extension registry and one initial Codex plugin package, `web-gpt-orchestrator`. The plugin is an optional orchestration surface; it is not a model route, account manager, browser profile owner, or private Web GPT implementation.

## Package boundary

- Canonical skill source: `guidance/skills/web-gpt-orchestrator/`
- Generated plugin skill copy: `plugins/web-gpt-orchestrator/skills/web-gpt-orchestrator/`
- Codex plugin manifest: `plugins/web-gpt-orchestrator/.codex-plugin/plugin.json`
- MCP descriptor: `plugins/web-gpt-orchestrator/.mcp.json`
- Public registry: `extensions/registry.json`
- Repo-local Codex marketplace: `.agents/plugins/marketplace.json` (`aicc-local`)
- Runtime command: `aicc orchestration mcp`
- Durable state: the owner-only AICC job store, never the plugin package

Run `node scripts/build-web-gpt-orchestrator-plugin.mjs` after changing the canonical skill. It copies only the canonical skill files, copies the repository MIT license, and regenerates an exact SHA-256 manifest. The package also carries NOTICE and CycloneDX SBOM metadata.

The MCP descriptor calls the separately installed public `aicc` executable. It does not import or copy the private Web GPT source. If AICC or the plugin is absent, the orchestration tools are unavailable, but the configured Web GPT, Native Codex and OCX model routes are unchanged.

## Tool and authority model

The plugin exposes exactly eight tools:

1. `plan_run`
2. `start_role`
3. `wait_role`
4. `submit_result`
5. `request_writer`
6. `status`
7. `cancel_run`
8. `cleanup_run`

`plan_run` persists an expiring snapshot of exact tool IDs advertised by the current outer Codex turn. Wildcards and claims that all installed skills/plugins are inherited are rejected. Full mode may declare one writer only when a write-class tool is in the snapshot. Browser-only mode rejects local writers.

The plugin is a durable broker, not a hidden model launcher. `start_role` and `request_writer` authorize a host-mediated dispatch; the outer Codex host must still provide and advertise the actual child/agent mechanism. Separate evidence is required for the model result, local artifact and browser-visible behavior.

Default fan-out is 2 or 3 and hard active cap is 5. Every role is a durable job. Result submission stores only a bounded claim, evidence hashes, counterexample, recommendation and UNKNOWN, then creates an exact-byte verified private artifact. Prompt bodies, transcripts, cookies, credentials, browser profiles and tab content are prohibited.

## Lifecycle and supply chain

Every registry entry declares owner, source/version/revision, distribution, license, NOTICE, SBOM, checksums, permissions, compatibility, lifecycle and health. Validation fails before install for:

- a missing or extra package file;
- a checksum mismatch or symlink;
- a manifest/version mismatch;
- an unsafe MCP command;
- secret-like content or a private owner path;
- an incomplete permission or lifecycle declaration.

The task-owned extension manager installs a verified copy, switches enable state without modifying routes, upgrades only after verifying the replacement, retains a verified prior package for rollback, and moves uninstall targets to recoverable quarantine. It never owns user artifacts, authentication, browser profiles or native application state.

Useful checks:

```bash
node scripts/build-web-gpt-orchestrator-plugin.mjs
aicc extension validate --json
aicc extension status --json
aicc orchestration status --json
npm run smoke:extensions
```

Codex plugin installation into the user's active home is a cutover operation. Back up current plugin/config state, prove active work is zero, install from the intended marketplace, verify exact advertised tool IDs in a new task, and retain the prior package/config for rollback. Do not hand-edit generated Codex home copies or marketplace state.

For a source checkout, the explicit non-default marketplace flow is `codex plugin marketplace add <AICC-repository-root>` followed by `codex plugin add web-gpt-orchestrator@aicc-local`. Perform it only in the Phase 11 zero-active cutover window; source validation and clean-package smokes do not add this marketplace to the user's active Codex configuration.
