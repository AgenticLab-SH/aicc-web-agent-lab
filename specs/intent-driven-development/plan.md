# Intent-driven development plan

## Architecture

- AICC 정본: `guidance/skills/develop-from-project-spec/`
- 노출 정책: `guidance/config/agent-catalog.toml`의 Codex `active_skills`
- 생성 대상: `C:\demo\owner\.agents\skills\develop-from-project-spec`
- 기능 문서: `specs/intent-driven-development/`

## Implementation order

1. FR-001~FR-004: 기존 스킬을 정본으로 승격하고 intent 선별, 승인, 단일 정본, 문서 역할을 추가한다.
2. FR-002·FR-005: intent 템플릿과 `check_intent.py`, source 연결을 지원하는 `check_project_spec.py`를 추가한다.
3. FR-001~FR-007: 계약 테스트를 추가하고 Codex 활성 목록만 갱신한다.
4. FR-006: 제한된 plan/deploy/check와 source/home 해시 비교를 수행한다.
5. SC-004: Windows 저장소 검증 게이트를 실행한다.

## Rollout and recovery

- 전체 스킬 prune 대신 `-SkillNames develop-from-project-spec`로 변경 범위를 제한한다.
- 배포 전 dry-run JSON을 검토한다.
- 정본과 테스트가 실패하면 홈 배포를 진행하지 않는다.
- 배포 후 실패하면 정본 diff를 복구한 뒤 같은 스킬 이름으로 다시 배포한다.
