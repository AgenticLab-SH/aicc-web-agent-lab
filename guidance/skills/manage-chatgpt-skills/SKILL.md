---
name: manage-chatgpt-skills
description: AICC·Codex 스킬의 ChatGPT 활용·설치·동기화와 ID·버전 관리. 본문은 skill-creator, 로컬 자료는 aicc-workspace-operator 재사용.
---

# 지피티 스킬과 플러그인 관리

지피티는 ChatGPT Web 일반 Chat, 코덱스는 로컬 Codex CLI·Desktop이다. 지피티 스킬은 지피티에 등록·설치된 작업 절차, 지피티 플러그인은 지피티에서 연결·설치하는 도구·스킬 묶음, 지피티 지침은 사용자 지정 지침과 프로젝트 지침, 지피티 프로젝트는 지피티의 프로젝트 공간, 지피티 대화는 그 안팎의 개별 대화다. 코덱스 스킬은 코덱스가 사용하는 로컬 스킬이다. 코덱스의 일반 작업은 OCX 경로를 사용한다. 네이티브 코덱스는 OCX를 거치지 않는 코덱스이며, OCX·AICC 업그레이드로 OCX 연결이 끊기는 구간의 독립 유지보수·복구에만 사용한다. 작업 범위·독립 복구·복귀 조건을 갖추고, 정비 후 원래 OCX 작업으로 돌아간다. 지피티 앱은 연결된 외부 서비스, 지피티 플러그인은 스킬·도구·앱 연결의 배포 묶음이다. 개별 등록 스킬과 플러그인이 제공하는 스킬은 출처를 구분한다. 지피티 스킬을 네이티브라고 부르지 않는다. 과거 표시명·기술 식별자는 사용자 용어로 확장하지 않으며 실제 slug·API 필드명·불변 ID는 유지한다.

## 책임과 연결

본문 작성·개선은 기존 skill-creator, Windows 스킬·문서·기록 읽기는 기존 aicc-workspace-operator를 재사용한다. 새 중복 스킬을 만들지 않는다. 이 스킬은 설치·동기화·버전·수명주기를 담당한다. Business 공용 자산은 manage-chatgpt-workspace-skills로 연결한다.

일반 Chat만 사용하며 Work로 전환하지 않는다. Business 계정 1·2의 같은 workspace에 연결된 기존 AICC 플러그인을 재사용한다. 계정별 새 연결이나 Personal 연결을 필수로 만들지 않는다. 개인 스킬 관리와 공용 workspace 등록은 실제 관리 UI와 권한으로 구분한다.

## 목적에 맞는 경로

- 자산 종류를 먼저 나눈다. Project의 이름·설정·지침·파일은 manage-chatgpt-assets, 개인 스킬의 exact-ID 편집은 manage-chatgpt-personal-skills, Business 공용 스킬은 manage-chatgpt-workspace-skills를 사용한다. 플러그인·앱 연결은 현재 Plugin Management/Creator의 공식 도구로 확인하고, 전역 사용자 지침은 실제 Settings의 해당 필드만 다룬다. 이 스킬의 백업·버전 계약을 공통으로 잇고 종류가 다른 자산을 새 스킬/프로젝트로 대체하지 않는다.
- 로컬 절차만 활용: 실제 aicc_skill_inventory의 ID로 aicc_skill_read에서 본문과 필요한 참조를 읽어 적용한다. 지피티 스킬 ZIP 업로드 없이 가능한 경로다.
- 문서·기록 활용: aicc-workspace-operator의 등록 root, 범위, lease/grant와 redaction을 따른다. session metadata와 별도 승인 발췌를 구분한다.
- 지피티 스킬 설치·업데이트: 아래 흐름과 [manager contract](references/manager-contract.md)를 따른다. 플러그인 연결, 로컬 본문 읽기, 관리 UI 등록, 사용자 설치와 실제 지피티 스킬 호출을 별도 상태로 기록한다.

## 설치와 버전 흐름

이 단계는 [상세 절차](references/manager-contract.md)의 같은 절을 읽고 수행한다.

## 정책과 종료

완료에 필요한 검증은 공통 지침과 사용자 요청 범위를 따른다. 모델 이름만으로 생략하지 않는다. 설치·동기화와 실제 호출 시험을 구분한다. 과거 작업의 개수·대화·시험 순서를 현재 작업의 제한으로 재사용하지 않는다.

live 작업을 수행한 경우 해당 작업의 exact lease만 반환한다. cookie 추출, 사용자 profile 직접 수정, 임의 계정 전환, 새 Tunnel과 undocumented API로 부족한 기능을 우회하지 않는다.

보고는 LOCAL_PREPARED, LOCAL_READ, REMOTE_MISSING, REMOTE_ADMIN_VISIBLE, USER_INSTALLED, SKILL_INVOKED, HOLD_EXISTING_UNKNOWN_VERSION, HOLD_UNCERTAIN_UPLOAD 등을 실제 근거에 맞춰 쓴다. 소스 수정·검사·홈 복사·원격 적용·호출은 별도 상태다. 확인하지 않은 동작을 완료로 표현하지 않는다.

## 로컬 변경을 지피티에 연결하기

이 단계는 [상세 절차](references/change-sync.md)의 같은 절을 읽고 수행한다.

## 생성·수정·삭제와 필수 백업

일반 Chat에서 후보를 등록·수정·제거하고 세부 옵션을 명시할 때는 [요청 inbox](references/request-inbox.md)를 따른다. 기존 등록 workspace의 Manage-WebAssetInbox.ps1과 요청 준비기를 사용하며 로컬 요청 삭제와 원격 자산 삭제를 구분한다.

스킬·전역/프로젝트 지침·플러그인을 관리하는 코덱스와 일반 Chat 지피티는 [자산 수명주기](references/asset-lifecycle.md)를 적용한다. 변경 전 원본과 적용할 버전을 GitHub 비공개 저장소·Notion에 실제 바이트로 백업한다. 내용 SHA256으로 같은 버전은 재사용하고 중복 page·업로드·commit을 만들지 않는다. 두 목적지의 저장·바이트 읽기가 확인돼야 변경한다. 기존 AICC Workspace 실행과 Notion/Plugin Creator connector를 사용하며 Web 컨테이너를 Windows 호스트로 간주하지 않는다. 사용자 요청 범위 안의 관리와 실행은 이어가고, 설치 해제와 플러그인 본체 삭제는 구분한다.
## 한도 안내와 연결 오류

이 단계는 [상세 절차](references/quota-and-connection.md)의 같은 절을 읽고 수행한다.

