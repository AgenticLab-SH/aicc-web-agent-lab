# 지피티 관리 종합 정리 — 2026-10-17 KST

사용자 직접 요청에 따라 이 대화가 소스·원격 변경권을 한시 인수해 직접 처리했다. 기존 dirty, 계정·로그인, 불변 ID와 PAUSED 예약을 보존했다. 새 대화·새 예약·확장 수작업 설치·개발자 모델 API는 만들지 않았다.

## 결과

| 범위 | 반영한 내용 | 근거 단계 |
|---|---|---|
| 변경 전파 | 로컬 수정 때 공통/환경별 적응/로컬 전용을 판단하고 변경 파일만 기존 manager에 연결 | 소스 구현·운영 manifest 설정; 새 실행기 검증 미실행 |
| 캐시 | 기존 업로드 패키지의 파일 해시와 이번 원격 저장 receipt를 재사용. 캐시는 현재 로그인·권한·원격 최신성 근거가 아님 | private 상태 기록 |
| 관리 계약 | 긴 manager 연혁을 조건부 참조로 분리하고 현재 ID·신원·preimage·불명 전송 조정 계약을 짧게 정리 | 소스·코덱스 홈 배포 |
| 브라우저 | 일반 확장을 필수 기본값으로 단정하지 않고 기존 결속 연결/등록 실행기와 관리 코드 manager를 우선 | 소스·코덱스 홈 배포 |
| 감시 | 과거 7개 고정 대화·옛 주기·상황별 지시를 레거시 참조로 분리 | 소스·코덱스 홈 배포 |
| 전달 | 추가 지시와 방향 전환을 목적에 맞게 설명. 결과 전체 자동 삽입과 고정 문구 의무화 방지 | 기존 지피티 4개 파일 저장 |
| 프로젝트 | Web 표시명 w-, 로컬 Codex 표시명 l-. ID·경로·대화 제목과 구분 | 공식 목록 Web15/로컬4가 원하는 표시명; Web 유튜브 실제 h1도 일치 |
| 공용 스킬 | Web용 변경 전파·이름·선택적 결과 반영 원칙을 기존 공용 관리 스킬에 적응해 추가 | 같은 ID에서 실제 desired 본문 일치로 지연 반영 조정 |
| 저장 지연 | Save 1회 뒤 원본문이 잠시 남으면 제한된 읽기만 반복. 예상 밖 변경은 중단 | 기존 manager 코드 개선; 개선 코드 검증 미실행 |

이번에 바꾼 정본 스킬은 manage-chatgpt-skills, manage-chatgpt-assets, use-web-gpt, web-jjonku-monitor, web-codex-handoff, codex-web-low-token-workflow, manage-chatgpt-personal-skills, capture-operational-knowledge 및 검색형 design-chatgpt-projects, web-gpt-orchestrator, manage-chatgpt-workspace-skills다. 활성 8개는 기존 배포기로 코덱스 홈에 적용했다. 검색형 3개는 정본을 유지하며 상시 등록을 늘리지 않았다.

## 지침·스킬·도구의 역할

| 영역 | 적용 기준 |
|---|---|
| 공통 지침 | 용어·권한·보존·기록 원칙만 유지. 실제 절차를 다시 복제하지 않음 |
| skill-creator / 관리 스킬 | 본문 설계와 설치·동기화를 분리 |
| use-web-gpt / direct-web-gpt-work | 정확한 대화에 짧은 질문·자료·출력 기준을 전달 |
| web-gpt-driving / web-jjonku-monitor | 대상 선택·진행 회수·상황별 복구. 설정 저장을 실제 감시로 주장하지 않음 |
| control-project-work / web-codex-handoff | root별 writer와 원격별 sender, cursor 기반 회수, 관련 결과만 반영 |
| manage-chatgpt-assets / design-chatgpt-projects | 설계와 실제 원격 변경을 분리; 이름만 바꾸면 지침·소스 재작성 없음 |
| 개인·공용 스킬 manager | 실제 UI의 소유권·workspace·불변 ID·fresh 본문 SHA를 사용 |
| verify-account-identities / AICC reader | 등록 별칭·포트로 계정을 추정하지 않음. Web 컨테이너와 Windows 호스트를 구분 |
| 선택형 orchestrator | 현재 호스트에 8개 도구가 노출됨. 도구 노출·실제 run·역할 완료는 별도. 일반 지피티 사용의 필수 조건으로 확대하지 않음 |

## 다음부터의 작동

1. 스킬 수정자는 지피티 영향도를 짧게 판단하고 private manifest의 assessment/reason/파일 승인 SHA를 갱신한다. 환경 적응이 필요하면 Web용 파일을 먼저 준비한다.
2. 기존 deploy_active_skills.ps1이 로컬 홈 배포 뒤 manifest에 결속한 항목의 변경 동기화를 연결한다. AICC_WEB_SKILL_SYNC_MANIFEST의 User 환경값을 설정했다. 경로·계정·ID는 소유자 전용 manifest에만 있다.
3. 변경이 없으면 로컬 해시 캐시로 생략한다. 변경된 파일은 실제 manager inspect 후 fresh SHA 조건으로 저장한다. 새 변경이 승인 SHA와 다르면 재판단 상태로 남긴다.
4. 불명 저장은 재전송하지 않고 같은 ID의 본문을 회수해 조정한다. 등록·홈 복사·원격 저장·설치·실제 native 호출을 나눠 기록한다.

자동화 코드는 구현·설정했지만 새 실행기 자체와 배포 연계의 실제 변경 동기화 호출은 이번에 실행하지 않았다. 이번 원격 적용은 수정 전 기존 manager로 수행했다. 모델 토큰을 쓰지 않는 해시 비교와 캐시를 구성했으며 provider prompt-cache 절감량은 측정하지 않았다.

## 실제 회복과 남은 한계

- 등록 Chrome에서 native 복원 팝업을 확인하고 닫기만 background로 처리한 뒤 같은 편집기 읽기·저장이 성공했다. 팝업이 전체 실패의 원인이었다고 확정하지 않는다.
- 공용 관리 스킬은 최초 저장 직후 이전 SHA가 보였으나 재저장 없이 fresh inspect에서 원하는 전체 본문이 일치했다. 원요청은 APPLIED_LATE_RECONCILED로 조정했다.
- 별도 프로젝트 연결의 No dialog is showing 오류 원인은 미확정이다. 이번 복구는 endpoint 조작을 순차 처리했으며 모든 독립 업무에 전역 병렬 금지를 추가하지 않았다.
- 이름 변경의 최종 표시 상태는 관측했지만 이 작업의 이름 변경 저장 성공 receipt는 없다. 이름을 다시 덧붙이거나 변경 주체를 임의로 단정하지 않았다. 보호 프로젝트의 내용을 읽거나 수정하지 않았다.
- 새 파일·script/asset·전체 ZIP 변경은 기존 본문 manager의 지원 밖이다. 별도 패키지 판단이 필요하며 삭제·재등록으로 우회하지 않는다.
- .codex/skills의 기존 legacy manifest는 기존 배포기가 untrusted-legacy-manifest로 정리하지 않았다. 활성 배포는 .agents/skills에 이뤄졌고 원본은 보존됐다. legacy 전체 삭제나 소유권 증거 조작은 하지 않았다.
- 신규 코드 테스트·빌드·린트·실행 확인은 검증 미실행. 기존 native 자산의 실제 load/invocation은 이번 작업에서 시험하지 않았다.

반복 관측은 capture-operational-knowledge의 기존 ‘기존 결과 회수’ 카드에만 추가했다. 현재 운영 상태·세부 원격 ID·시도 영수증은 소유자 전용 기존 운영 폴더에 있으며 공개 문서에 비밀·대화 원문을 복제하지 않았다.