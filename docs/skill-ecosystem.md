# Skill ecosystem inventory

AICC keeps executable guidance in each skill folder and generates only a compact owner-local index.
Do not combine every `SKILL.md` body into one prompt or tracked document.

The public scanner records frontmatter, ownership, canonical and delivery paths, invocation policy,
resource counts, exact-name collisions, and explicit `$skill-name` handoffs. It also separates the
implicit description budget from deferred `SKILL.md` bytes. Semantic decisions such as merge or
retire remain an `aicc-guidance-review` task rather than a validator rule.

Run it with each project root that should contribute local `.agent/skills` or `.agents/skills`:

```bash
node tools/platform/inspect/inspect-skill-ecosystem.mjs \
  --write \
  --aicc-root "${OPEN_AICC_ROOT}" \
  --codex-home "${CODEX_HOME}" \
  --project-root "${PROJECTS_ROOT}" \
  --state-root "${AICC_STATE_ROOT}"
```

The current user delivery root defaults to the `.agents/skills` sibling of `CODEX_HOME`. Use
`--agent-skills-root` only for a fixture or a nonstandard supported layout. `CODEX_HOME/skills`
remains a separately reported legacy/user and system root; a matching legacy copy never satisfies
the current managed-delivery check.

Owner-local outputs:

- `${AICC_STATE_ROOT}/inventory/skill-catalog.json`: machine-readable source
- `${AICC_STATE_ROOT}/reports/skill-map.md`: generated human map

Both files may contain private absolute paths and project names. Keep them owner-only and out of the
public repository. The scanner prunes dependencies, virtual environments, build output, caches,
backups, and vendored trees. Plugin cache presence is reported separately from the supported
`codex plugin list` installed-and-enabled state.

Routine work should continue to use the current skill metadata and nearest `AGENTS.md`, then read
only the selected `SKILL.md` and necessary references. `aiccImplicitDescriptionCharacters` is the
repeated selection cost of AICC-managed skills; `aiccDeferredEntryBytes` is not startup context and
is reported only to find overly large workflows after invocation. Regenerate the map for ecosystem
audits, relocations, merges, plugin changes, or project-skill changes.

Placement, measurement, deployment, and rollback decisions follow the
[agent context optimization playbook](agent-context-optimization.md).

## Required Codex plugins

Frequently used plugins belong in an owner-local desired-state policy, not in `AGENTS.md` or the
public repository. Copy `guidance/config/codex-capabilities.example.json` to
`${AICC_STATE_ROOT}/config/codex-capabilities.json`, then list only required qualified plugin IDs
and explicit feature values. `aicc task run codex.plugins.status --json` compares that policy with
`codex plugin list --json` and `~/.codex/config.toml`; it reports drift without editing config,
authentication, plugin caches, or Desktop runtime. App OAuth and source-system permissions remain
separate native state and require independent verification.

현재 실제 노출 이름은 플러그인 namespace와 프로젝트 scope를 포함해 비교한다. 서로 다른 플러그인의 `index` 같은 짧은 이름은 충돌이 아니다. 지속 점검은 [관리 정본](agent-context-optimization.md#지속-관리)에 따라 변경 hash와 공식 확인 기한을 분리한다.

## Owner-workspace career procedures

Career writing, interview, and application-portal procedure bodies may be consolidated in the registered Career workspace under `00_운영/채용_작업체계/01_현재_정본`. Its `00_START_HERE.md` is the maintained entrypoint. `operate-job-application` in this repository is a portable forwarding adapter; resolve the owner's registered workspace rather than embedding personal paths or copying policy bodies into public source.

This ownership change does not install a browser driver, change accounts or runtime configuration, or deploy a managed skill. Keep discovery/delivery status separate from the owner's source migration. Old originals are restoration-only and must not be loaded as active guidance. Generic AICC, browser, and WebGPT operations retain their existing owners.
