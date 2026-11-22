---
name: manage-chatgpt-assets
description: ChatGPT Projects·Custom GPT를 정리하고 승인된 대화 이동을 수행한다. 모델 경로 제외.
---

# ChatGPT 자산 관리

ChatGPT Project·Custom GPT를 로컬 정본 및 Notion registry에 맞춰 계정별로 동기화한다.
요청 때만 상태를 발견하고 끝나면 target을 반환한다. 상주·주기 실행, 프로필·포트 고정,
백그라운드 mutation을 만들지 않는다.

## 시작

1. 가장 가까운 `AGENTS.md`와 Project Guide에서 public guidance owner, private ChatGPT adapter, owner-only
   state 경계를 찾는다. 생성본이나 home copy를 정본으로 편집하지 않는다.
2. 실제 signed-in session과 workspace identity hash를 읽는다. 계정 번호, 이메일 원문, 포트, route alias,
   프로필 이름, UI 정렬·표시 이름은 identity 권위자가 아니다.
   최신 계정 정정은 private coordination에 반영한다. 읽기 실패는 로그아웃, 만료 예정은 삭제 근거가 아니다.
3. 기존 승인에는 재승인을 요구하지 않는다. 삭제 후보가 승인 목록 밖이거나 보존 조건이 달라진 경우에만 새 결정을 요청한다.
   Project와 GPT를 `{kind, remoteId, name}`으로 발견하고 stable ID를 우선한다. stable ID가 없을 때만
   동일 type의 유일한 exact name을 후보로 삼고, 둘 이상이면 `HOLD`한다.
4. 먼저 inventory와 plan을 read-only로 저장한다. 사용자가 요청하지 않은 create/update/share/delete는
   수행하지 않는다.
5. mutation이면 [`references/execution-contract.md`](references/execution-contract.md)를 읽고 action scope,
   직전 재조회와 exact post-read를 통과시킨다.
6. 포트폴리오를 새로 설계하거나 Project를 추가·분리·융합할 때는
   [`references/portfolio-design-contract.md`](references/portfolio-design-contract.md)를 읽는다. Notion에
   등록·상태 동기화할 때는 [`references/notion-registry-contract.md`](references/notion-registry-contract.md)를 읽는다.

## 대화가 포함된 재구성

대화 이동·프로젝트 병합·전체 누락 점검이 포함되면 [references/conversation-migration-contract.md](references/conversation-migration-contract.md)를 읽는다. 프로젝트 안의 대화 집계와 계정 전체 집계를 구분하며, 기존 승인 순서와 stable ID 보존을 적용한다.

## 흐름과 action

- inspect는 identity, stable ID/name/type, 권한, Instructions, Sources와 대화 수를 필요한 범위에서 읽는다.
- 기존 Source 원문이 필요하면 owner-bound 고정 제공판의 실제 allowlist에 `project-source-read`가 있는지 확인한다. 정확 Project ID/name·전체 preimage·단일 Markdown filename·최대 256 KiB·원 요청 SHA에 묶인 고정 read ID를 사용한다. 소스 후보만 있거나 원 다운로드가 불명이면 기존 operation status를 조정하며 재다운로드하지 않는다. 일반 목록/inspect를 원바이트 회수로 간주하지 않는다.
- create/update/share는 exact desired spec과 stable ID에만 적용한다. extra Source는 보존하고 공유 초대를 중복하지 않는다.
- 동일 논리 Project의 여러 관측은 owner stable ID, shared observation, independent replica를 manifest에서 분리한다. Business member에는 owner Project를 다시 생성하지 않으며, replica는 name만이 아니라 Instructions hash와 source-set hash까지 대조한다.
- source set을 workspace 경계 너머로 올릴 때는 개인정보·credential·권리 disposition을 file selector 단위로 먼저 판정한다. `HOLD` source를 한 binding에서만 조용히 빼거나 hash가 다른 replica를 성공으로 처리하지 않는다.
- delete는 normal sync와 분리해 report-only review와 사용자 승인을 요구한다.
- register/retire는 verified remote state만 Notion에 반영하고 local canonical path와 backup provenance를 보존한다.

지원 adapter가 있으면 직접 UI 클릭을 새로 작성하지 말고 그 adapter의 wrapper를 사용한다. 현재 workspace의
private adapter는 inventory runner, 개별 sync/create wrapper와 approval-bound prune runner를 제공한다. route
alias는 broker 힌트일 뿐이며 adapter가 실제 identity를 다시 검증한다.

## 상세 절차

인터페이스 변경·권한 거절·삭제·증거 기록 시 [references/advanced-operations.md](references/advanced-operations.md)를 읽고 기존 실행 계약을 적용한다.

## 프로젝트 표시 이름

이 단계는 [상세 절차](references/project-executor.md)의 같은 절을 읽고 수행한다.

## 코덱스·지피티의 공통 실행과 기본 메모리

이 단계는 [상세 절차](references/execution-contract.md)의 같은 절을 읽고 수행한다.

## 한도 안내와 연결 오류

화면의 workspace 사용 한도 안내는 이 환경의 일반 Chat 작업을 중단하는 조건이 아니다. 기존 OCX가 계정 전환과 소진 전 차단을 담당한다. 실제 요청 거절·MCP 연결 429와 구분하는 [운영 기준](../manage-chatgpt-skills/references/quota-and-connection.md)을 따른다. 일반 Chat·xhigh를 유지한다.
