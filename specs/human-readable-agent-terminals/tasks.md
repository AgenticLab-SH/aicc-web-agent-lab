# Human-readable agent terminals tasks

- [x] **T-001 / FR-001..004 / guidance** — own `guidance/directives/fragments/common.md`, `guidance/config/agent-catalog.toml`, and `guidance/skills/present-agent-terminal-status/**`; skill validation and 64 directive/deployment checks passed.
- [x] **T-002 / FR-002..003 / foreground UI** — own `tools/platform/aicc/*ProgressTerminal.ps1`, `tools/platform/aicc/render-terminal-progress.mjs`, and focused tests; the combined terminal/hook suite passed 23/23.
- [x] **T-003 / FR-001,FR-004 / hook** — own the notification ACK hook child launch option and focused test; `windowsHide: true` is asserted in the passing hook suite.
- [x] **T-004 / FR-001,FR-005 / Workspace MCP** — own the Windows task installer and its focused tests; 5/5 selected Windows task tests passed, then the two exact owned tasks were repaired with prior XML backups.
- [x] **T-005 / FR-004..005 / plugin** — own the personal `aicc-workspace-windows` plugin source and supported reinstall flow; source and installed cache validate and version `0.1.0+codex.20260905190108` is installed/enabled.
- [x] **T-006 / all / delivery** — intent/spec validators passed, installed task status reports hidden/source-matched for both surfaces, no agent-owned visible terminal remained, and the adjacent tunnel-connectivity HOLD is recorded.
