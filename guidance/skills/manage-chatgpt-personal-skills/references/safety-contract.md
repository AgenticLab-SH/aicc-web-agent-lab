# Personal skill manager safety contract

1. Scope to `https://chatgpt.com/skills`, the user's enabled AICC account alias, and a task-owned CDP lease. Never borrow a user tab, capture credentials, or alter workspace administrator skills.
2. Distinguish the ZIP frontmatter **slug**, the async-changing **display name**, the editor **server ID**, the description SHA, and the CodeMirror instruction body SHA.
3. `list` and `inspect` are read-only. `upload`, `update`, `update-body`, `delete` all require `--commit` plus exact `--ack`. Permanent delete also requires `--allow-owned-delete`, exact ID and matching description hash.
4. Confirm an exact Created by me section row, not the Installed list duplicate. Stop on collision, ambiguous selection, 429, unknown response, unloaded page, mismatched preimage, failed reread, or uncertain lease cleanup.
5. Created by me may initially display slug then change to `agents/openai.yaml` display name. Re-list before modifications rather than retrying a stale display-name command blindly.
6. CodeMirror `innerText` counts layout blank lines. Use the full CodeMirror document through the exact editor bridge; never hash only viewport `.cm-line` children. On web save/reload, the provider may normalize leading/trailing newlines; require byte-identical *interior* content and report boundary normalization.
7. Keep receipts without auth tokens, cookies or original private conversation content. Keep copies of original source ZIP and files before changes. Prefer a disposable self-created skill for destructive end-to-end tests.
8. Do not restart services, modify CDP account mappings, or perform automatic update of another chat's code or skills. Use exact owned lease and release it in a `finally` block.

## Verified acceptance evidence (2026-10-11)

- Uploaded a disposable fixture via `POST /backend-api/hazelnuts/uploads/create` HTTP 201 and fresh readback.
- Successfully saved and reloaded a changed description.
- Confirmed a changed Markdown instruction body persisted; the source boundary newline behavior was observed and accounted for.
- Deleted a disposable fixture with `DELETE /backend-api/hazelnuts/<exact ID>` HTTP 200 and fresh-list absence.
- Uploaded the independent `chatgpt-conversation-import` personal skill with HTTP 201 and a fresh installed listing; did not modify Web GPT-Codex Handoff.

## Exact target selection

Select only the page carrying the issued lease task_target_nonce before opening a CDP session, then compare its exact target ID. Do not attach to every foreign page to search for the leased target. Missing or ambiguous nonce is HOLD; never fall back to another page. The current source change has not been independently verified after editing.

For an existing references Markdown file or agents/openai.yaml, bind the same exact owned skill ID plus its full relative path and logical document preimage. The YAML path is limited to its existing display metadata; preserve every other value and the immutable skill ID. Preserve the package ZIP and each file intent. A returned preimage-conflict error proves the manager rejected that write before edit/save; an unclassified error does not. Do not treat an older downloaded ZIP as the current package after a body or reference save.

## Explicit workspace caller

The default personal workflow above remains owner-created only. The companion may be reused by the separately authorized workspace-skill workflow only for inspect/update-body with an explicit preserved-ID editor binding and a live identity audit module. That caller follows manage-chatgpt-skills/references/manager-contract.md. This mode cannot upload, delete, transfer ownership, or change descriptions; denied access is HOLD. An admin download alone does not prove edit permission.

## 계획된 기존 supporting-file 변경 · source-only

- personal-skill-plan-file은 기존 개인 references Markdown의 exact ID/path/full logical preimage와 desired 원바이트 SHA, 양쪽 VERIFIED backup만 결속한다. workspace editor/new file/script/asset/whole ZIP 작업은 이 계획의 권한이 아니다.
- FILE_PLAN_READY는 실제 저장·설치·전체 package 최신성의 증거가 아니다. 원 계획 request_id와 그 결과 바이트 plan_sha256을 existing provider record에서 인수한다.
- 적용은 기존 personal-skill-update-body에 원 planRequestId/planSHA256과 같은 target/source/backupReceipt를 전달한다. 변경 직전 fresh preimage·backup bundle을 재대조하고 기존 one-use .operation.json을 보존한다.
- 불명 결과는 원 apply request_id의 status/file_target으로 재열며 새로운 apply나 receipt로 재생하지 않는다. 새 파일을 읽지 못했다는 사실만으로 원격 부재나 생성 지원을 주장하지 않는다.
- 이 소스 변경은 검증 미실행·홈 미배포·plugin release/runtime 미반영이다. 기존 설치 action allowlist와 실제 권한이 우선한다.

## New references file (`add-file`)

- Only one new `references/<lowercase-slug>.md` per run, into an existing `references` folder of an owner-created skill. Traversal, absolute, backslash, root, nested, script and asset paths are rejected. An existing path is refused (use `update-body`).
- Requires live identity hashes through the registered identity module, exact editor ID and slug, a fresh sorted-tree SHA and SKILL.md SHA, a two-destination VERIFIED receipt (`create`, empty preimage, `desired/<path>` bytes), `--commit`, `--ack` and `--confirm ADD-FILE:<id>:<path>`. Without `--commit` it is a read-only plan.
- Local draft steps (new text file, rename, body) are verified before the one-use mutation start. Exactly one Save click follows; a fresh reload readback decides. Uncertain click/readback is UNKNOWN and is never replayed.

## Mandatory two-destination backup

When the existing AICC connector advertises owner-bound `aicc_web_management_start/status`, use its `personal-skill-list/inspect/upload/update/update-body/delete` actions from ordinary Chat. Keep the same registered workspace, exact request JSON SHA, fresh owner-created ID/preimage, and backup receipt. The `skill` object uses `name`, `displayName`, `skillId`, `expectedCurrentSha`, `file`+`fileSHA256`, `bodyFile`+`bodyFileSHA256`, or `descriptionFile`+`descriptionFileSHA256` as appropriate. `includeBody/includeFiles` apply to inspect. File paths are absolute regular files inside the registered workspace. Mutations declare `commit:true`; delete additionally declares `confirm:"DELETE:EXACT_ID"`. The host supplies account, identity, executable and config. Do not put those in remote JSON or replace the isolated exec with unrestricted execution. Start once, poll the same request, and reconcile UNKNOWN before another mutation.

Before committed upload/update/update-body/delete, follow [the shared asset lifecycle](../../manage-chatgpt-skills/references/asset-lifecycle.md). Pass `--backup-receipt ABSOLUTE_RECEIPT` binding exact account, skill ID (new upload: slug), action and before/desired SHA256 to recoverable GitHub and Notion bytes. Read-only list/inspect needs no backup. Unchanged content needs no write. A delete requires the full package preimage. The content-addressed receipt and durable attempt prevent duplicate backups and replay of uncertain writes. Both Codex and ChatGPT use the same host runner through the existing AICC Workspace connection.

## 원격 ID와 업로드 영수증

개인 스킬 list는 공식 ‘내가 만든 항목’ 화면이 실제 요청한 owner 목록에서 읽은 exact id/name/version을 함께 반환할 수 있다. 제목만으로 ID를 추정하지 않는다. ID가 없는 행은 inspect로 기존 편집기의 exact ID를 확보한다. personal 스킬의 내용이 Business 공용 스킬 관리라고 해도 그 개인 자산의 scope는 personal이다. 지피티 스킬 ID와 같은 이름의 플러그인 skill을 합치지 않는다.

변경 요청을 만들기 전에 기존 Inbox List/Show를 읽고 같은 대상과 후보를 재사용한다. 등록 성공은 원격 적용이 아니다. 기존 본문과 references를 읽어 Web용 조정 내용을 보존하며 필요한 파일만 변경한다. 전체 ZIP 교체나 없는 supporting file 추가를 본문 갱신으로 포장하지 않는다. 새 references 파일은 `add-file`만 사용한다.

새 mutation은 기존 backup receipt 옆 .transport.jsonl에 실제 응답의 method/status/path와 반환된 식별자 후보만 즉시 기록한다. 응답 본문·로그인 정보는 기록하지 않는다. 반환 ID는 미검증 힌트이며 fresh owner/editor 및 원문 readback 전에는 설치 성공으로 인정하지 않는다. HTTP201 뒤 목록에 없으면 같은 원 operation/receipt를 조정한다. 목록 부재만으로 NOT_CREATED 처리하거나 global writer.lock을 삭제하지 않는다. 이미 발생한 불명 요청에 이 개선을 소급해 원격 결과를 만들어 넣지 않는다.

소스·홈 스킬 배포·관리 플러그인 release·owner-bound 고정 runtime은 별도다. 플러그인 파일 갱신만으로 고정 runtime이 바뀌지 않는다. active/UNKNOWN이 있는 실행 경로의 교체는 기존 운영 계약에 따라 HOLD한다.

