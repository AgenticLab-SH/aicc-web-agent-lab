# manage-chatgpt-personal-skills 선택 절차

이 문서에서 선택한 단계만 읽는다. 명령 예제의 기준 작업 폴더와 인라인 리소스 경로는 상위 스킬 루트다. Markdown 링크는 이 파일 위치를 기준으로 한다.

## Commands

Use the exact account alias from owner configuration. `list` and `inspect` are read-only. Do not infer a skill ID from its title: `inspect` returns the exact ID and separate hashes for description and instruction body.

```powershell
$cli = Join-Path $env:USERPROFILE '.agents\skills\manage-chatgpt-personal-skills\scripts\personal-skill-manager.cjs'

node $cli list --account ACCOUNT_ALIAS
node $cli inspect --account ACCOUNT_ALIAS --name example --display-name "Example"

node $cli upload --account ACCOUNT_ALIAS --name example --file "C:\approved\skill.zip" --commit --ack example

node $cli update --account ACCOUNT_ALIAS --name example --display-name "Example" --skill-id EXACT_ID --expected-current-sha DESCRIPTION_SHA --description-file "C:\approved\description.txt" --commit --ack example

node $cli update-body --account ACCOUNT_ALIAS --name example --display-name "Example" --skill-id EXACT_ID --expected-current-sha BODY_SHA --body-file "C:\approved\instructions.md" --commit --ack example

node $cli delete --account ACCOUNT_ALIAS --name example --display-name "Example" --skill-id EXACT_ID --expected-current-sha DESCRIPTION_SHA --commit --ack example --allow-owned-delete

# Remote skill path, not a resource in this local skill package
$referencePath = 'references' + '/new-file.md'
# add-file: dry run (read-only plan) first, then one commit per file
node $cli add-file --account ACCOUNT_ALIAS --name example --display-name "Example" --skill-id EXACT_ID --file-path $referencePath --body-file "C:\approved\new-file.md" --body-file-sha SOURCE_BYTES_SHA --backup-receipt "C:\private\RECEIPT.receipt.json" --identity-module "C:\registered\chatgpt-account-identity-audit.mjs" --expected-identity-hash IDENTITY_HASH --expected-workspace-hash WORKSPACE_HASH
node $cli add-file ...same arguments... --expected-current-sha SKILL_SHA --expected-tree-sha TREE_SHA --commit --ack example --confirm ("ADD-FILE:EXACT_ID:" + $referencePath)
```

Before any mutation, obtain a fresh `list` and `inspect` result. Uploads require one validated `SKILL.md` and ZIP below 25 MB. Do not retry an uncertain upload blindly; inspect the installed list first. The personal UI may **change display names asynchronously** after upload: `--name` is the immutable frontmatter slug and `--display-name` is the **current** exact created-row label.

The preimage `--expected-current-sha` refers to **description SHA** for `update` and `delete`, and to **logical Markdown body SHA** for `update-body`. `update-body` updates actual instructions, not the description. The web editor adds boundary newlines around Markdown; compare its exact *internal* lines, and report if boundary normalization occurred.

## Add one new references file (`add-file`)

Observed official UI (read-only probes, 2026-11-01): editor dialog `스킬 편집` → `업로드` menu → `새 텍스트 파일` creates a local root draft `untitled.txt` (selected, empty CodeMirror, Save enabled, no network write) → draft row `untitled.txt 액션` → `이름 변경` opens `input[aria-label="파일 경로"]` holding `untitled.txt` → `변경 사항 저장`. The rename commit key (Enter), whether a full path moves the draft into `references/`, and the save response/version change were **not** observed. The manager therefore verifies the local tree shows exactly the target path before Save and lets only a fresh reload readback decide success.

Order: live identity (identity module + expected hashes) → exact owned editor ID/slug → tree read (all folders expanded) → refuse if the path exists → preimage (sorted tree file list SHA, SKILL.md logical body SHA) → backup gate check (read-only) → dry run returns `ADD_FILE_PLAN_READY` with both SHAs and the confirm token, no write → commit: preimage must match → local draft, rename, body input, each verified → identity again → one-use `beginMutation` → exactly one Save click → reload (fresh document, Save disabled) → tree and body SHA readback.

- Backup receipt: assetKey `skill|ACCOUNT|EXACT_ID`, operation `create`, preimage = SHA-256 of empty bytes, desired = SHA of the BOM-stripped LF body, and the bundle must hold `desired/<file-path>` with those bytes. The receipt is consumed only immediately before Save; a local HOLD before Save leaves it reusable.
- Results: `file_added_verified`; `REFUSED_ADD_FILE_PATH_EXISTS`; `HOLD_*` (no Save click, `remoteMutation:false`); `FAILED_ADD_FILE_READBACK_MISMATCH` / `FAILED_ADD_FILE_WRONG_PATH` / `FAILED_ADD_FILE_COLLATERAL_CHANGE` (saved but wrong); `UNKNOWN_ADD_FILE_OUTCOME` (click or readback uncertain). FAILED/UNKNOWN mark `.operation.json` `OUTCOME_UNKNOWN_RECONCILE`. Never click Save again, re-run commit, or use a new receipt; reconcile with read-only `inspect --file-path`.
- Apply one file, read it back, and only then plan the next file with a fresh dry run (the tree SHA changes after each add).
- Fake-driver tests: `tests/add-file-*.test.cjs`. The Playwright driver itself has not been exercised against a live save.


Read the whole logical CodeMirror document for body hashes. Viewport `.cm-line` text is incomplete when the editor virtualizes long files. The companion uses a narrow DOM bridge to locate the exact editor and revalidates it through `EditorView.findFromDOM`; if unavailable, return HOLD rather than hashing a partial document. This is a compatibility dependency, not a global page API guarantee.

## Existing reference Markdown

`inspect --file-path $referencePath --include-body` reads an existing owned reference. `update-body` accepts the same file path with its fresh full logical body SHA and an approved body file. Keep the full package preimage and a durable exact ID/path attempt before dispatch. A preimage conflict stops before writing; inspect and compare it before making a new guarded plan. An uncertain save is never replayed.

The observed file tree exposes full relative paths as accessible names. Wait for the references folder to load and expand it only when aria-expanded is false. Selecting an auxiliary file can hide the description textarea; preserve the description captured before selection. Two reference saves and their reload text matches were observed in the requested bounded scenario. This is not evidence for arbitrary file operations or all browser versions. Final manager changes have no general post-change validation.

