# Codex 스킬·지침·플러그인 개선 설계

상태: **DESIGN_ONLY / 실행 전**  
작성일: **2026-09-20 KST**  
범위: Codex 스킬, 전역 지침, 플러그인 라우팅, AICC 관리 배포, Notion TODO 연결

## 1. 목적

Codex가 필요한 기능을 잘 선택하면서도, 일반 작업에서 AICC 전용 운영 규칙이나 외부 변경 기능을
불필요하게 불러오지 않도록 스킬·지침·플러그인의 경계를 정리한다.

이 문서는 구현 지시서가 아니라 개선 순서와 완료 기준을 고정하는 설계 문서다. 런타임, 모델 경로,
브라우저, Tunnel, Workspace publication, Slack/ACL worker는 이 문서에서 변경하지 않는다.

## 2. 확인된 기준

- 설치·캐시·정본을 포함한 `SKILL.md` 116개를 정적 검토했다.
- 모든 frontmatter가 파싱되었고, 내부 validator 기준 112개가 통과했다.
- 4개 벤더 스킬의 validator 실패는 형식 호환성 문제로 분류했다.
- AICC 스킬 생태계 테스트 7개는 모두 통과했다.
- AICC scanner에서 delivery issue와 반복 instruction group은 발견되지 않았다.
- 현재 설치·활성 플러그인은 로컬 CLI 기준 24개다. 캐시 파일 수와 설치 수는 같은 의미로 사용하지 않는다.
- `codex plugin list`가 실제 설치·활성 상태의 기준이며, 플러그인 캐시는 참고 정보다.
- 전역 규칙은 생성본을 직접 수정하지 않고
  `guidance/directives/fragments/common.md`에서 관리한다.

주요 근거:

- 전역 지침: `C:\demo\owner\.codex\AGENTS.md`
- 현재 AICC 정본: `C:\demo\owner\.codex\context\PROJECT.md`
- 스킬 정책: `guidance/config/agent-catalog.toml`
- 스킬 검사 기준: `docs/skill-ecosystem.md`
- 정본 스킬: `guidance/skills/`
- 현재 사용자 배포 스킬: `.agents/skills/`
- legacy 사용자 스킬: `.codex/skills/`

## 3. 핵심 설계 원칙

### 3.1 전역 지침은 안전 경계만 둔다

전역 지침에는 모든 작업에 필요한 공통 원칙만 둔다.

- 근거 기반 판단
- 사용자 변경 보존
- 위험에 맞는 검증
- 외부 변경과 제출의 명시적 경계
- 완료와 HOLD의 구분

AICC, WebGPT, CDP, Slack, 계정, Tunnel, 장기 운영 절차는 해당 스킬이나 해당 프로젝트의
지침으로 내린다. 일반 작업에서 `aicc user-action status`나 Slack 알림을 자동으로 요구하지 않는다.

### 3.2 외부 효과가 있는 스킬은 기본 명시 호출로 한다

다음 작업은 모호한 요청에서 자동 실행되면 안 된다.

- 로그인·CAPTCHA·인증 상태 변경
- ChatGPT Project·Custom GPT·자산 변경
- 모델·route·provider 변경
- Slack·Telegram 등 외부 메시지 발송
- 고위험 변경과 배포·도메인·호스팅 변경
- 장기 멀티 프로젝트 조정과 task dispatch

본문의 승인 절차만으로 충분하지 않은 스킬은 `allow_implicit_invocation: false` 또는 같은 효과의
명시적 trigger gate를 갖는다.

### 3.3 기능 영역은 exclusive routing으로 나눈다

| 요청 | 기본 담당 | 사용하지 않을 영역 |
|---|---|---|
| React/Vite 제품 UI 구현 | `codex-frontend` | Sites 배포, Browser QA 자체 수행 |
| 제품 UX 탐색·감사·시각적 복제 | Product Design | 일반 백엔드 구현 |
| 구현 후 실제 페이지 검증 | `browser-qa` | UI 디자인 재작성 |
| Sites로 웹사이트 생성·수정 | `sites-building` | 일반 로컬 웹 프로젝트 |
| AgenticFabWorks 출시·도메인·호스팅 | `agentic-website-maker` | 로컬 UI 구현 |
| 현재·불확실한 사실의 공식 출처 조사 | `evidence-first-web-research` | 단순 심층 리서치 |
| 다중 출처 심층 조사·경쟁 분석 | Exa Search | 단순 공식 문서 조회 |

한 요청에서 여러 영역이 필요하면 주 담당 하나를 정하고 나머지는 후속 검증 단계로 호출한다.

### 3.4 정본과 배포 경로를 분리한다

- 정본: `C:\demo\open-AICC\guidance\skills`
- 현재 Codex 배포: `C:\demo\owner\.agents\skills`
- legacy 사용자 스킬: `C:\demo\owner\.codex\skills`
- 생성 지침: 원본 fragment에서 재생성
- Notion: 실행 TODO와 개발 작업의 운영 정본
- 로컬 문서: 설계·근거·검증 계약의 기술 정본

legacy에만 존재하는 스킬은 설치된 것으로 보지 않는다. 새 스킬은 정본과 현재 배포 경로를 함께
검증한 뒤에만 완료로 판정한다.

## 4. 개선 작업 목록

### P0 — 안전·오작동 방지

- [ ] 전역 AICC 전용 규칙을 AICC/WebGPT/운영 작업 조건 아래로 이동한다.
- [ ] 외부 효과 스킬의 implicit invocation을 재분류한다.
- [ ] 승인 경계를 외부 메시지, 제출, 로그인·인증, 클라우드 데이터 변경까지 확장한다.
- [ ] 일반 작업에서 `notify-user`가 자동 선택되지 않도록 한다.
- [ ] 현재 런타임 HOLD와 새 guidance 개선 작업을 별도 상태로 유지한다.

완료 기준:

- 일반 로컬 코드 검토가 AICC 상태 확인이나 Slack 발송으로 이어지지 않는다.
- 외부 효과 작업은 명시된 목적·대상·행동이 없으면 실행하지 않는다.
- 기존 사용자 개입 원장과 런타임 route는 변경되지 않는다.

### P1 — 스킬 라우팅 정리

- [ ] Product Design index의 정책과 설명을 일치시킨다.
- [ ] Sites와 Agentic Website Maker의 적용 조건을 명시한다.
- [ ] Exa Search와 evidence-first research의 진입 조건을 분리한다.
- [ ] Product Design, Frontend, Browser QA의 순차 실행 계약을 추가한다.
- [ ] Browser·Chrome·Computer Use·Unified Computer Use의 선택표를 추가한다.
- [ ] `index` 논리 이름 충돌을 경고하거나 namespace를 적용한다.

완료 기준:

- 같은 요청에 경쟁하는 주 스킬이 두 개 이상 자동 선택되지 않는다.
- 명시 호출 전용 스킬은 implicit metadata와 설명이 서로 모순되지 않는다.
- route 선택 결과를 scanner 보고서에서 재현할 수 있다.

### P1 — 정본·배포·검사 체계

- [ ] legacy-only `implementation-completeness`의 정본 위치를 결정한다.
- [ ] 정본 → `.agents/skills` 배포 여부를 검사기에 추가한다.
- [ ] 벤더 스킬의 대문자 이름과 확장 frontmatter를 호환 모드로 처리한다.
- [ ] `plugin://`, plugin-root, repository-root 참조를 구분하는 resolver를 추가한다.
- [ ] 캐시, 설치, 활성, 정본 상태를 검사 결과에서 별도 필드로 표시한다.
- [ ] 모든 개선 항목에 변경 전·후 trigger eval을 추가한다.

완료 기준:

- 벤더 패키지를 직접 고치지 않고도 validator가 의미 있는 실패만 보고한다.
- false broken-link과 cache-as-installed 오판이 제거된다.
- 정본과 현재 배포 스킬의 차이를 한 번의 read-only 검사로 확인할 수 있다.

### P2 — 유지보수성

- [ ] `control-project-work`의 모델명 하드코딩을 capability 기반으로 바꾼다.
- [ ] `openai-docs`의 공식 출처 허용 목록에 `help.openai.com`을 포함한다.
- [ ] 오래된 AICC plugin cache를 삭제하지 않고 stale/inactive로 분류한다.
- [ ] 정기 감사에서 implicit description budget과 deferred entry size를 함께 추적한다.

## 5. 단계별 실행 설계

### Phase 0 — 기준선 고정

1. 현재 `PROJECT.md`, Git dirtiness, `codex plugin list`를 읽는다.
2. AICC scanner와 테스트를 실행한다.
3. 설치 상태와 cache 상태를 별도 저장한다.
4. 새 변경의 owner와 rollback 지점을 기록한다.

### Phase 1 — 전역 규칙과 trigger policy

1. `common.md`에서 전역 AICC 운영 문장을 조건부 규칙으로 줄인다.
2. 외부 효과 스킬의 `agents/openai.yaml` 정책을 조정한다.
3. 각 변경에 대해 명시 호출, 암묵 호출, near-miss 입력을 평가한다.
4. 생성된 `AGENTS.md`를 재생성하고 원본과 일치하는지 확인한다.

### Phase 2 — 라우팅과 validator

1. 겹치는 UI·웹·리서치 스킬의 route matrix를 추가한다.
2. namespace collision 검사를 추가한다.
3. 벤더 호환 frontmatter와 참조 resolver를 구현한다.
4. 기존 벤더 스킬 파일은 수정하지 않는다.

### Phase 3 — 배포와 readback

1. 정본 스킬을 `.agents/skills`에 배포한다.
2. `codex guidance check`와 scanner를 실행한다.
3. 실제 Codex skill inventory와 `codex plugin list`를 다시 읽는다.
4. 변경된 파일, 검사 결과, 미해결 HOLD를 문서와 Notion 작업에 기록한다.

## 6. 금지 범위

이 설계 작업은 다음을 포함하지 않는다.

- Native/OCX/WebGPT route 변경
- 17841, 10100, 17842 재시작
- CDP 계정·브라우저·Tunnel 변경
- Workspace publication 변경
- Slack/ACL worker 재활성화
- 기존 문서·archive·cache의 삭제 또는 reset
- 사용자의 외부 제출·메시지 발송

## 7. 완료 판정

이 작업은 다음 세 층을 모두 만족해야 완료다.

1. **설계 PASS**: 이 문서와 Notion 작업에 우선순위·범위·완료 기준이 연결됨
2. **소스 PASS**: canonical guidance, metadata, validator, tests가 변경됨
3. **배포 PASS**: 현재 `.agents/skills`, 생성 지침, 설치 플러그인 readback이 일치함

설계 문서만 작성된 상태는 `DESIGN_ONLY`다. runtime이 healthy이거나 publication이 존재하는
것만으로 guidance 개선 완료로 기록하지 않는다.

## 8. 관련 정본

- [AICC 운영 지도](../agent-operations.md)
- [스킬 생태계 검사 기준](../skill-ecosystem.md)
- [현재 AICC/Codex 상태](C:\demo\owner\.codex\context\PROJECT.md)
- [현재 AI Platform 다음 실행](C:\demo\projects\ai-platform\plans\NEXT-ACTIONS.md)
- [사용자 할 일 원장](../runbooks/user-action-ledger.md)
- Notion `실행 목록` data source: `collection://00000000-0000-4000-8000-000000000000`
- Notion `개발 작업 원본` data source: `collection://00000000-0000-4000-8000-000000000000`
