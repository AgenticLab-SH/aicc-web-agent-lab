---
name: web-gpt-orchestrator
description: 명시된 Web GPT 복수 역할 작업을 제한된 역할·writer 한 명으로 조정한다. 단일 답변 작업 제외.
---

# Web GPT 오케스트레이션

Use the installed `web-gpt-orchestrator` MCP plugin as the authority for run, role, capability, budget, result and cleanup state. Treat the skill as the entry workflow, not as an authority that can bypass the plugin or the current Codex host.

## Preflight

1. Confirm that the current model route is the intended `chatgpt-web/*` route. Do not switch provider, account, saved/temporary mode or route silently. Never select Pro without explicit user approval.
2. Find the eight orchestration tools actually advertised by the current host: `plan_run`, `start_role`, `wait_role`, `submit_result`, `request_writer`, `status`, `cancel_run`, and `cleanup_run`. Their displayed IDs may be namespaced; call the exact advertised IDs.
3. Call `status` read-only. If the plugin is missing, disabled or unhealthy, report orchestration as unavailable while leaving the normal Web GPT route untouched. Do not emulate a successful durable run in prose.
4. Classify the current surface:
   - `full`: only the local tools actually advertised in this outer turn are eligible.
   - `browser-only`: local files, shell, installed skills and plugins are unavailable unless separately advertised. A local writer role is unsupported.
5. Build the capability snapshot from exact current tool IDs. Classify each only as needed: `read`, `write`, `browser`, `computer-use`, or `network`. Do not add wildcards, installed-but-unadvertised tools, skills, plugins, credentials or presumed Computer Use.

## Plan the run

Call `plan_run` once with a stable request ID, root task ID, opaque workspace ID, exact route and identity binding, surface, current tool list, role DAG and budgets.

- Default to 2 concurrent roles; use 3 only when the work is cleanly separable.
- Keep the hard active cap at 5 or lower. A request for more roles queues the remainder and does not justify more tabs.
- Give every role a distinct `roleId`, one of `coordinator`, `researcher`, `critic`, `solver`, `merger`, `writer`, or `verifier`, explicit dependencies and the minimum required tool IDs.
- Declare at most one `writer` with mode `write`. All other roles are `read-only`.
- Use refs and hashes for task material. Never put prompt bodies, transcripts, cookies, secrets, profiles or tab contents into MCP arguments.
- Keep the returned capability snapshot hash. Every start and result call must bind to it. If it expires or changes, stop and re-plan.

Good default DAGs:

- Independent analysis: `researcher + critic -> merger`
- Competing solutions with a change: `solver-a + solver-b -> writer -> verifier`
- Investigation: `researcher-a + researcher-b + critic -> merger`

## Execute roles

1. Call `start_role` for dependency-ready read-only roles up to the returned active limit.
2. Dispatch a role only through a child/agent mechanism actually advertised by the outer Codex turn. Pass only the role request ref, run/role/job/attempt identifiers, exact allowed tool IDs and the minimum verified context. If no host dispatch mechanism is advertised, return a clear unavailable result; do not claim independent or parallel Web GPT execution.
3. Keep each role on the exact route and identity returned by the plugin. Do not auto-switch provider/account or replay the role elsewhere after quarantine.
4. Use `wait_role` to observe state. Submit only a compact claim, evidence refs with SHA-256, counterexample, recommendation and explicit UNKNOWN through `submit_result`.
5. Start a merger only after its dependencies are completed. Preserve disagreements rather than making the merger erase them.
6. Before local mutation, call `request_writer` for the sole declared writer. The writer may use only exact write tools from the snapshot and the current project boundary. A second writer must fail before apply.
7. Start a verifier only when the current model policy and the user's explicit verification scope allow it. Never dispatch a verifier to bypass a post-change verification restriction.

`start_role` and `request_writer` authorize host-mediated dispatch; they do not themselves prove that a model, tab, browser or tool ran. Preserve separate evidence for the role result, local artifact and browser-visible behavior.

## Browser rules

- Use Browser or Computer Use only when its exact tool ID is in the snapshot and an exact task-owned target/session lease is available.
- Never attach to, activate, close or rename an existing user tab. Root cancel and cleanup apply only to owned child targets and leases.
- Respect the broker's 30-second identity cadence, tab TTL, saved/streaming/total budgets and quarantine. Do not create uncontrolled live tab fan-out.
- Web GPT turn-harness tools are turn-bound. AICC Workspace MCP is persistent and separately authenticated. Never transfer a capability, lease, process session or health assumption between them.

## Terminal handling

- On user cancellation, call `cancel_run` once with a stable request ID, stop only owned child work, then call `cleanup_run` after all roles are terminal.
- On failure, record the exact role, failure class and UNKNOWN. Retry only with a changed hypothesis and within the same bounded budget.
- On capability expiry/change, do not reuse the old call. Refresh the current advertised tools and create a new plan.
- On terminal cleanup, revoke the snapshot and clean only run-owned lease records. Keep durable job/result/artifact evidence.

Report the surface, exact route, roles, active limit, one-writer status, actual tool IDs used, artifact/browser verification and remaining UNKNOWNs. Never claim that every installed skill/plugin was inherited.

## 적용 범위

이 문서의 8개 도구와 역할 상한은 해당 선택형 플러그인의 계약이다. 일반 지피티 사용·공식 코덱스 채팅 조율의 전제 조건으로 확대하지 않는다. 현재 도구 노출이 없으면 플러그인 실행만 미지원으로 남기고 승인된 일반 작업은 control-project-work/use-web-gpt로 잇는다. 소스에 구현됐다는 사실은 현재 호스트 도구 노출·실행의 증거가 아니다.
