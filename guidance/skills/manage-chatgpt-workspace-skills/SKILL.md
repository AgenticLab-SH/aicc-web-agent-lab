---
name: manage-chatgpt-workspace-skills
description: 기존 AICC로 Business 공용 스킬을 신원·ID·버전 확인 후 등록·동기화한다. 개인 복제·Work 전환 금지.
---

# Business 공용 스킬 관리

실제 관리자 Skills 화면과 권한으로 공용 자산을 식별한다. Business 계정 1·2가 같은 workspace에 속하면 기존 공용 스킬과 AICC 플러그인 연결을 재사용한다. 별도 개인 사본·Personal 연결·계정별 Tunnel 재게시를 기본 요구하지 않는다. 일반 Chat만 사용하며 Work로 전환하지 않는다.

## 정본과 대상

본문 작성은 기존 skill-creator, 지피티 스킬 패키지·버전 관리는 manage-chatgpt-skills, 로컬 Codex 스킬·문서·기록 읽기는 aicc-workspace-operator를 재사용한다. 공용 스킬과 플러그인 연결은 서로 다른 자산이다.

개인 홈 context와 과거 port/account 표를 정본으로 고정하지 않는다. 해당 작업의 등록 프로젝트 상태와 최신 private coordination에서 exact slot/profile/account/workspace를 찾고 실제 로그인 identity와 관리자 권한을 별도로 확인한다. 9224 retired 또는 9225 Naver-only는 과거 관찰일 뿐 현재 규칙이 아니다. pending/disabled/reserved, 불명 identity나 등록 없는 슬롯은 HOLD한다. 포트 번호·화면 순서·요금제는 신원 증거가 아니다.

## 공용 자산 흐름

1. 요청한 로컬 스킬과 필요한 참조만 읽어 manifest, 버전과 ZIP hash를 고정한다. 비밀·원문 대화·capability·개인 설정을 패키지에 넣지 않는다. 무조건 validator를 실행하지 말고 현재 모델 정책과 명시 검증 요청을 따른다.
2. 기존 source-backed manager의 로컬 plan과 실제 관리자 UI 조회를 구분한다. 구현과 지원 명령은 manage-chatgpt-skills/references/manager-contract.md를 따른다. 개인 별칭·workspace ID가 박힌 과거 예제 명령을 재사용하지 않는다.
3. 원격 항목은 owner/workspace/불변 ID와 관찰 가능한 버전·release receipt로 비교한다. 이름만 같으면 skip한다는 규칙을 쓰지 않는다. 이름만 보이거나 버전 불명인 경우 HOLD_EXISTING_UNKNOWN_VERSION이며 source hash만으로 remote bytes 일치를 주장하지 않는다.
4. 신규 업로드는 exact 관리자 계정의 승인 범위에서 이전 pending/uncertain attempt가 없는 항목만 한 번 수행한다. intent와 versioned manifest를 먼저 보존한다. 불명 응답은 이전 receipt를 조정하며 재전송하지 않는다. 두 계정에 같은 ZIP을 각각 올리지 않는다.
5. 업데이트·폐기는 exact ID와 현재 승인, preimage backup·rollback, 참조 관계와 영향 범위, 공식 UI 지원이 있어야 한다. 폐기는 참조 0을 확인한다. 다른 owner의 같은 이름 자산과 공유 AICC 연결은 보호한다. 구형 sync가 name-only skip만 지원하면 그 제한을 보고하고 업데이트를 HOLD한다.
6. 두 계정의 실제 workspace membership·가시성, 필요시 사용자 설치, 일반 Chat의 지피티 스킬 로드 신호와 완료 응답은 별도 사용점검이다. 관리자 목록에 있다고 각 계정에서 호출됐다고 보고하지 않는다. 로컬 reader 활용은 지피티 스킬 설치 없이 가능하다.
7. live 작업이 수행됐다면 해당 exact lease만 반환한다. 반환 응답이 불명일 때 같은 lease 상태를 먼저 확인하고 실제 남아 있는 동일 token에 대해서만 반환을 재시도한다.

## 작성과 실제 점검 분리

완료에 필요한 검증은 공통 지침과 사용자 요청 범위를 따른다. 모델 이름만으로 생략하지 않는다. 과거 작업의 개수·일정은 현재 동작의 제한으로 재사용하지 않는다. 실제 호출 시험과 설치·동기화 요청을 구분한다.

소스 준비, 홈 배포, 패키지 검사, 원격 적용, 두 계정 가시성과 실제 호출을 각각 보고한다. 현재 모델 정책을 이유로 검증 승인을 다시 요구하지 않는다. 미실행을 완료로 바꾸지 않는다.

## 권한과 편집 기능의 경계

관리자 목록·상세를 읽을 수 있는 권한과 기존 항목을 편집하는 제품 기능은 별개다. 현재 UI에 편집이 보이지 않는 관측만으로 권한 부족이나 제품 전체 미지원을 확정하지 않는다. exact 항목·로그인·사용한 화면·관측한 액션을 남기고 지원 갱신 경로 미확인으로 분류한다. 소유권 변경·다른 계정·삭제 후 재등록으로 이를 대신하지 않는다. 원격 적용 보류 중에도 출처를 보존한 로컬 기능 병합은 독립적으로 진행할 수 있다.

## 코덱스·지피티 자체 관리의 공통 입구

스킬·지침·플러그인 전체 수명주기는 manage-chatgpt-skills/references/asset-lifecycle.md, Project는 manage-chatgpt-assets를 따른다. 두 실행 주체는 기존 AICC workspace exec와 같은 내용 주소 백업 원장을 사용한다. GitHub 비공개 저장소와 Notion에 변경 전·후 실제 바이트를 저장하고 같은 버전은 재사용한다. 새 Web Project 이름은 w-형식, memory는 default다. 공용/개인 scope와 설치 해제/본체 삭제의 권한·실제 기능을 구분한다.
## 한도 안내와 연결 오류

화면의 workspace 사용 한도 안내는 이 환경의 일반 Chat 작업을 중단하는 조건이 아니다. 기존 OCX가 계정 전환과 소진 전 차단을 담당한다. 실제 요청 거절·MCP 연결 429와 구분하는 [운영 기준](../manage-chatgpt-skills/references/quota-and-connection.md)을 따른다. 일반 Chat·xhigh를 유지한다.
