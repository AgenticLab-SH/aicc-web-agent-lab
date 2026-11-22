---
name: escalate-unresolved-service-failures
description: 소유자 재시도 범위 후 지속된 외부 장애의 서비스·로컬 원인과 복구를 확인한다.
---

# 해결되지 않는 서비스 실패 확대 진단

일반 진단으로 풀리지 않은 외부 서비스 실패만 단계적으로 확대한다. 상태 페이지는
초기 점검이 아니라 로컬·대상별 진단 뒤에 사용하는 후반 증거다.

## 0단계: 진입 게이트

다음 조건을 모두 충족하기 전에는 이 스킬로 진입하지 않는다.

1. 해당 서비스나 작업을 소유한 skill, runbook, 공식 사용법으로 정상 경로를 한 번
   점검한다.
2. 실패한 작업, 대상 component, 시각과 timezone, 오류 문구 또는 상태 코드, 이미
   확인한 항목을 기록한다.
3. 읽기 작업이면 입력을 확인한 뒤 한 번만 통제된 재시도를 수행한다. 쓰기·배포·결제
   같이 중복 효과가 날 수 있는 작업이면 재시도하지 말고 먼저 원격 post-state를
   읽는다.
4. 실패가 계속되고, 동일 증상 반복·5xx·timeout·disconnect·여러 독립 surface의
   동시 이상 중 하나가 있는지 확인한다.

조건이 부족하면 이 스킬을 중단하고 소유 workflow의 초기 진단으로 돌아간다. 사용자가
처음부터 이 스킬을 명시해도 게이트를 생략하지 않는다.

## 1단계: 범위와 기준선을 고정

- 계정, provider, workspace, repository, branch, region, endpoint, model과 client
  version을 확인 가능한 범위에서 기록한다.
- 한 번에 변수 하나만 바꾼다. 다른 계정·provider·region·browser profile로 조용히
  우회하지 않는다.
- 원문 오류, request/correlation ID, 응답 코드와 header 중 비밀이 아닌 값, 로컬과
  UTC 시각을 보존한다. token, cookie, credential, 개인 데이터는 수집하거나 노출하지
  않는다.
- 현재 성공하는 인접 component도 기록해 정상 구역을 복구 대상으로 만들지 않는다.

## 2단계: 일반적인 로컬 원인을 좁게 제외

서비스별 소유 skill이나 공식 진단 명령을 우선 사용하고 읽기 전용 검사를 선택한다.

1. 대상·identity·권한 범위가 의도와 일치하는지 확인한다.
2. 로컬 network/DNS/proxy, client version, 설정 파일, quota/rate limit을 오류와 직접
   관련된 범위에서만 확인한다.
3. 최소 read-only health probe나 동일 대상의 조회를 한 번 수행한다.
4. `401/403`은 인증·권한, `404`는 대상·version, `429`는 rate/quota 가능성을 먼저
   검토한다. `5xx`, gateway timeout과 연결 단절은 외부 장애 신호일 수 있지만 단독으로
   확정하지 않는다.

원인이 확인되면 소유 workflow로 넘기고 여기서 멈춘다. 재설치, cache/profile 삭제,
credential 재발급, 계정 전환은 진단 실험으로 사용하지 않는다.

## 3단계: 반복성과 영향 범위를 판별

- 원래 작업과 같은 identity·target을 유지한 안전한 probe로 재현 여부를 확인한다.
- 가능하면 같은 서비스의 서로 독립적인 component를 읽기 전용으로 비교한다. 예를 들어
  GitHub Actions 실패를 Git Operations 실패로 일반화하지 않는다.
- 다른 사람도 겪는다는 일화나 커뮤니티 글은 보조 신호로만 취급한다.
- 재현되지 않으면 일시적 실패로 기록하고 원래 작업을 무한 재시도하지 않는다.

## 4단계: 공식 서비스 상태와 상관관계 확인

이 단계에 도달한 뒤에만 [공식 상태 확인](references/official-status-checks.md)을 읽고
현재 웹 정보를 조회한다.

1. vendor의 공식 status page에서 정확한 product와 component를 찾는다.
2. 진행 중 incident뿐 아니라 실패 시각과 겹치는 history를 확인한다.
3. region, plan, API/UI, 인증, Git operation, CI처럼 영향 범위가 증상과 맞는지 비교한다.
4. 조회 시각과 timezone, incident 제목·상태·공식 URL을 기록한다.
5. status가 green이어도 미탐지·게시 지연·부분 영향 가능성을 남긴다. 반대로 incident가
   있어도 component와 시간대가 다르면 현재 실패의 원인으로 단정하지 않는다.

## 5단계: 판정에 따라 행동

다음 중 하나로 명시적으로 분류한다.

- `CONFIRMED_EXTERNAL_INCIDENT`: 공식 incident가 component·시간·증상과 일치한다.
  로컬 변경과 반복 재시도를 멈추고 공식 복구를 기다린다.
- `PROBABLE_EXTERNAL_INCIDENT`: 외부 장애 증거가 강하지만 공식 확인이 없다. 공식
  support 공지나 별도 공식 surface를 한 번 더 확인하고 `UNKNOWN`을 유지한다.
- `LOCAL_OR_TARGET_SPECIFIC`: 공식 상태와 비교 probe는 정상이고 특정 identity·target·
  client에서만 실패한다. 축적한 증거와 함께 소유 workflow로 돌아간다.
- `MIXED`: 정상 component와 실패 component를 분리하고 실패 범위만 멈춘다.
- `UNKNOWN`: 더 이상의 안전한 분리가 불가능하다. 최소 재현, 시각, version, request ID,
  sanitized log와 수행한 검사를 묶어 공식 support나 사용자에게 전달한다.

사용자가 감시를 요청한 경우에만 공식 상태를 적절한 간격으로 다시 확인한다. 자동 전환,
우회 provider 사용, 무한 polling을 시작하지 않는다.

## 6단계: 복구를 검증

1. 공식 복구 공지만으로 완료 처리하지 않는다.
2. 먼저 이전에 실패했던 최소 안전 probe를 같은 변수로 다시 실행한다.
3. probe가 통과하면 원래 작업을 재실행한다. 중복 효과가 있는 write는 원격 post-state를
   다시 확인한 뒤 필요한 경우에만 실행한다.
4. 실제 사용자 결과와 후속 상태까지 확인해 `RECOVERED`로 바꾼다.
5. incident 시간대, 영향, workaround 사용 여부와 남은 `UNKNOWN`을 짧게 남긴다.

## 중단 규칙

- 상태 확인을 첫 오류의 기본 반응으로 만들지 않는다.
- auth bypass, TLS/security 완화, 비밀 출력, profile·credential·cache 삭제, 무단 계정·
  provider 전환으로 장애를 숨기지 않는다.
- status page, CLI 성공, 배포 명령 성공을 실제 사용자 작업 성공과 동일시하지 않는다.
- 같은 요청을 빠르게 반복해 rate limit이나 중복 mutation을 만들지 않는다.
- 소유 skill이 있는 작업은 그 skill을 대체하지 않는다. GitHub Actions 자체 진단은
  `gh-fix-ci`, Codex route·port·catalog 복구는 `manage-codex-model-routes`, 로그인 문제는
  `choose-browser-session`과 `complete-site-login`이 소유한다. 위험한 복구 변경은
  mutation 전에 대상·검증·복구·중단 조건을 고정한다.

## 결과 형식

다음을 간결하게 보고한다.

- **판정**: 위 상태값 하나와 확신 수준
- **실패 기준선**: 작업·component·target·최초/최근 시각·오류
- **초기 진단**: 이 스킬 전에 수행한 정상 workflow와 결과
- **외부 근거**: 공식 상태 URL·incident·조회 시각·증상과의 일치/불일치
- **로컬 근거**: identity·version·read-only probe·정상인 인접 component
- **행동**: 멈춘 재시도, 기다릴 조건, 소유 workflow 또는 support handoff
- **복구 검증**: 같은 probe와 원래 작업의 실제 결과 또는 아직 `UNKNOWN`인 이유
