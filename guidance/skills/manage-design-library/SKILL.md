---
name: manage-design-library
description: 개인 디자인 참고자료를 매체별 관리한다. 프로젝트 방향 결정·산출물 제작 제외.
---

# Manage Design Library

Use the user's registered personal design library as the canonical home for private raw references.
Do not use generated Codex or Claude skill folders as storage, and do not place raw private or
rights-unknown material in public AICC source.

## Resolve the library

1. Read `${AICC_STATE_ROOT:-~/.ai-control-center}/config/design-library.json`.
2. Resolve its `root` and require a real directory containing `.design-library.json`.
3. Never guess or create a different root when the registry is missing or invalid. Report the hold.
4. Read the library `README.md` before changing its contents.

The public skill must never embed a user's absolute library path. The owner-local registry is the
only machine-specific pointer.

## Classify an incoming reference

Read [the classification contract](references/classification.md). Inspect enough of the artifact to
identify its intended output and strongest design responsibility. For long Markdown, inspect the
title, purpose, headings, evidence boundary, and representative sections before reading everything.

Choose exactly one primary category: `web`, `presentation`, `word`, `pdf`, `report`, `image`,
`visualization`, `cross-media`, or `motion`. Use tags for secondary uses. Use `cross-media` only for
an intentional system spanning at least three output families; do not use it merely because an idea
could be reused elsewhere. If evidence is insufficient, copy the file to `00_INBOX` only when the
user asked to collect it, then report what is needed for final classification.

## Collect safely

1. Preserve the supplied original by default. Copy unless the user explicitly says `move`, `옮겨`,
   or asks to remove the source after intake. Only then pass `--move-source`; never infer deletion
   from `save`, `collect`, `absorb`, or `분류해 넣어`.
2. Determine source type, public URL, owner, license or permission, redistribution status, and the
   boundary between observed, inferred, and recommended content. Use `UNKNOWN` instead of guessing.
3. Run `scripts/design_library.py add` with the selected category and metadata. Pass `--dry-run`
   first when the target or metadata is uncertain.
4. Review the JSON result. Treat `duplicate` as success without making another copy.
5. Confirm the item directory contains the original, `SOURCE.md`, and `METADATA.json`, and that the
   catalog contains the same id and SHA-256.
6. With `--move-source`, require the stored file's SHA-256 to match before deleting the exact source.
   Report whether the source was removed and that the library copy is the recovery copy.
7. Do not commit or publish merely because collection succeeded. Public redistribution and private
   Git versioning are separate decisions.

Example:

```bash
python3 scripts/design_library.py add /absolute/input/design.md \
  --category web \
  --title "Interactive portfolio navigation" \
  --tags web,motion,image \
  --source-type user-authored \
  --source-url UNKNOWN \
  --source-owner UNKNOWN \
  --license UNKNOWN \
  --redistribution UNKNOWN
```

## Handle direct user additions

Users may put undecided files in `00_INBOX` or create an item folder directly under a named category.
For inbox cleanup, run `scripts/design_library.py audit`, classify each unregistered file, then collect
it without deleting the inbox copy unless the user explicitly requests cleanup. For direct category
items, audit and add missing `SOURCE.md`/`METADATA.json`; never overwrite a user's notes.

## Retrieve for a new artifact

1. Read [the artifact routing map](references/artifact-routing.md), then search the primary category,
   `cross-media`, and the listed adjacent tags. Do this proactively for a materially visual creation
   task; do not wait for the user to name a specific saved reference.
2. Shortlist 1–3 references whose metadata and original files still exist. Prefer the user's saved
   preferences over generic defaults when they fit the audience, purpose, and rights boundary.
3. Compare reusable principles, desired mood, audience fit, accessibility, implementation cost, and
   rights constraints. A favorite is evidence of preference, not permission to clone.
4. Use `establish-design-direction` to turn the selected principles into the target project's
   `DESIGN.md` or equivalent design decision artifact.
5. Hand the selected item ids, `reuse` principles, `avoid` notes, and relevant design decisions to the
   mapped specialist workflow. Actively combine compatible skills when the artifact spans surfaces;
   for example, use `diagram-design` for a report figure and the Documents or PDF workflow for the
   containing artifact. Keep project facts separate from library preferences.

For an intentional multi-format system, distinguish a stable **frame** from a replaceable **design layer**
and medium **adapters**. If a shortlisted item includes `frame.md`, `design.md`, or an optional
`SYSTEM.json`, inspect the declared roles and hashes. Use the frame for hierarchy, accessibility,
provenance, privacy, and validation; use one design layer for expression; then use the target adapter.
Do not copy literal web geometry into slides/documents or treat a palette as the cross-media invariant.

## Privacy and provenance

- Keep raw references private unless their license and intended publication are verified.
- Do not store credentials, cookies, account databases, browser profiles, private links, or raw
  personal records.
- Do not treat local possession as copyright permission.
- Preserve distinctive third-party copy, logos, assets, and compositions only as private evidence;
  do not reproduce them in public output without authorization.
- If code, text, or assets are later copied into a project, update that project's attribution record.
  Pattern influence alone should be described as a pattern, not a clone or fork.
