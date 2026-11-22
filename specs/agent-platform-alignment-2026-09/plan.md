# Agent platform alignment plan

## Architecture

- Guidance source: `guidance/directives/fragments/common.md` and focused skills
- Discovery: `src/guidance.mjs`
- Documentation review: `src/knowledge-review/`
- Plugin observation: `src/adapters/codex-plugins.mjs`
- Skill delivery: `guidance/config/agent-catalog.toml` and `tools/platform/core/`
- Runtime default: owner-local `C:\demo\owner\.codex\config.toml`

## Order

1. Tighten user/skill priority, intent acceptance, composition, and Korean discovery.
2. Add exact Claude Academy coverage, diagnostic IDs, and bulk-change signals.
3. Expand plugin topology reporting without mutating plugins or accounts.
4. Add ownership-safe legacy skill-root migration and deploy to the official root.
5. Apply the bounded Codex permission preset with an owner-only recovery copy.
6. Refresh the platform baseline, dated review, project context, and validation evidence.

## Recovery

- Repository changes are source-first and recover through Git.
- Skill deployment removes only content matching the prior AICC manifest.
- Owner-local config is copied to a timestamped owner-only recovery file before changing three permission keys.
- A failed fresh discovery canary restores the legacy skill root from its manifest-owned source deployment.
