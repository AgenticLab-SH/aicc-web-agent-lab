---
name: manage-chatgpt-personal-skills
description: AICC로 본인 ChatGPT 개인 스킬 조회·ZIP 설치·설명/본문 수정·참조 Markdown 추가·정확 삭제. Business·플러그인 제외.
---

# Manage ChatGPT personal skills

Manage **personal** ChatGPT skills at `https://chatgpt.com/skills`, not workspace administrator skills at `/admin/skills`. Use an exact owner-approved Windows device through the available local or connected tools and one isolated CDP lease. Never use a user's already-open browser tab, export login secrets, or change another chat's ongoing work.

Read [safety-contract.md](references/safety-contract.md) first. Run this skill's companion script from its own `scripts` directory on the **authorized Windows computer**. The machine must have the AICC owner configuration, CDP lease helper, installed PowerShell, and `playwright-core`; the web-hosted skill instructions alone cannot access the Windows disk.

The caller must supply its existing owner configuration with `--config` or `AICC_CHATGPT_ARCHIVE_CONFIG` (absolute path). There is no dated-folder fallback. PowerShell uses `AICC_PWSH` (absolute executable) or the existing `pwsh` on PATH. Playwright uses `--playwright-module` / `AICC_PLAYWRIGHT_CORE` (absolute module path) or normal Node module resolution. Resolve these from the registered host; do not put a personal repository or toolchain version into this public skill. For an authorized GPT task, the user has standing authorization to start the existing registered dedicated browser when it is offline. Do not ask for browser-start approval again. This manager does not start Chrome itself: first prepare that same existing profile through the broker procedure in use-web-gpt/references/surface-selection.md, then continue the manager. Preserve user tabs, existing sessions and account/workspace identity. Missing registration, identity mismatch, or an authentication refusal stays HOLD.
## Commands

이 단계는 [상세 절차](references/personal-file-operations.md)의 같은 절을 읽고 수행한다.

## Acceptance criteria

- `upload`: HTTP 201, successful upload dialog, fresh Created by me listing. Keep source ZIP and its SHA-256.
- `update`: editor ID + slug + description preimage match; save; reread after reload.
- `update-body`: editor ID + slug + actual body preimage match; edit through CodeMirror; save; compare full canonical text after reload.
- `delete`: unique owner-created row, exact editor ID and preimage, explicit commit/ack/allow-owned-delete, target-named confirmation, HTTP DELETE 200 to that exact ID, fresh-list absence.
- `add-file`: exact ID + slug + live identity, path absent, tree/SKILL preimage match, verified local draft at the exact path, one Save, fresh-reload tree = before + path, body and SKILL.md SHA readback.

Only temporary disposable skills may be used for lifecycle tests. Never delete or modify another chat's existing skill, any Business workspace-owned skill, or any item with ambiguous account ownership. If a step cannot be verified, report `HOLD` instead of assuming success.

**Scope limitation:** replacing the whole ZIP stays unsupported (the official UI has no same-ID ZIP replacement). Existing references Markdown files use the exact file-path option below. A **new** file is supported only through `add-file` for one `references/<lowercase-slug>.md` in an existing top-level `references` folder of an owner-created skill. Root files, nested folders, new folders, scripts, assets, binary uploads, rename/remove of existing files and the editor's "파일 업로드/폴더 업로드" stay unsupported. Do not claim `add-file` replaces the full package.

## Add one new references file (`add-file`)

이 단계는 [상세 절차](references/personal-file-operations.md)의 같은 절을 읽고 수행한다.

## Existing reference Markdown

이 단계는 [상세 절차](references/personal-file-operations.md)의 같은 절을 읽고 수행한다.

## Reuse by an explicitly authorized workspace workflow

이 단계는 [상세 절차](references/workspace-bridge.md)의 같은 절을 읽고 수행한다.

## Mandatory two-destination backup

Before any mutation, including add-file, bind exact identity/ID/action/preimage/desired bytes to the GitHub and Notion VERIFIED backup receipt. Start once; reconcile UNKNOWN on its original operation and receipt.

이 단계는 [상세 절차](references/safety-contract.md)의 같은 절을 읽고 수행한다.

## 원격 ID와 업로드 영수증

이 단계는 [상세 절차](references/safety-contract.md)의 같은 절을 읽고 수행한다.

## 기존 보조파일의 명시 계획·단회 적용 · source 계약

이 단계는 [상세 절차](references/workspace-bridge.md)의 같은 절을 읽고 수행한다.

