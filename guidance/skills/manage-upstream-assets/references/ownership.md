# 데이터 소유 관계

| 자원 | 기존 정본 | 스냅샷의 의미 |
| --- | --- | --- |
| 관리 프로젝트/원격 Git | `~/.ai-control-center/cross-device/project-portfolio.toml` | ready 원본만 열거. worktree 중복 제외 |
| AICC 외부 참고·복사·채택, 라이선스 | `guidance/skills/aicc-guidance-review/references/absorption-ledger.json` | active/hold 상태 기록. 설치했다는 뜻은 아님 |
| 공식 크롤링 문서 | `src/knowledge-review/policy.mjs` `OFFICIAL_SOURCE_REGISTRY` | exact host/path 범위만. 자동 crawler 시작 금지 |
| 언어별 직접 의존성 | 등록 프로젝트의 `package.json`, `pyproject.toml`, `requirements.txt` | 선언된 버전 범위, 실제 설치 버전 아님 |
| AICC 원격 update 신호 | `src/upstream-monitor.mjs`, `guidance/monitoring.json` | 버전 차이를 발견하는 신호, 자동 적용 0 |
| Native/OCX/Web GPT runtime | 각 프로세스, 등록 release, `/healthz`, `/readyz` | 서로 다른 버전과 소유자; runtime 교차 적용 금지 |
| 스킬·플러그인 목록 | `docs/skill-ecosystem.md`, owner-local skill catalog | 설치/노출/활성은 별도로 검증 |

스캐너는 선언된 프로젝트 루트와 제한된 디렉터리에서만 manifest를 읽는다. Git 소스와 crawler 범위는 가능하면 URL의 query와 fragment를 제거한다. 프로젝트 밖의 불특정 다운로드·프로필·계정·세션, node_modules 구현 코드를 통째로 수집하지 않는다. 출력의 `unknown`은 미확인을 의미한다.

### 점검 명령
```powershell
python C:\demo\open-AICC\guidance\skills\manage-upstream-assets\scripts\inventory.py --json
python C:\demo\open-AICC\guidance\skills\manage-upstream-assets\scripts\inventory.py --write
aicc task run routes.status --json
```

`--write`는 owner-local `~/.ai-control-center/inventory/upstream-assets.json`만 atomic 갱신하고 Git/Notion/서비스를 수정하지 않는다. 최신 release/업데이트 가능 여부는 공식 npm/GitHub 등에서 **당시 다시** 검증한다. 모든 오픈소스의 무조건 자동 갱신은 금지한다.

원본 설정·원장·runtime·개인 경로는 owner host에 보존하며 공유 패키지에 복제하지 않는다. credential이 포함된 URL은 출력하지 않으며 query·fragment에 민감값이 있으면 제거한 안전한 참조만 기록한다. 스킬 목록의 존재는 설치·노출·활성·실사용 각각의 증거를 대신하지 않는다.
