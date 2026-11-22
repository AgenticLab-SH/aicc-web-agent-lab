---
name: manage-codex-model-routes
description: 일반 OCX Codex와 OCX/AICC 중단 중 독립 정비 경로를 관리한다. 다른 경로는 보존한다.
---

# Codex 모델 경로 관리

실제 route와 활성 작업을 확인하고, 요청한 경로만 바꾼다. 사용량·quota만을 이유로 임의 경로·계정을 바꾸지 않는다.

지피티는 ChatGPT Web 일반 Chat, 코덱스는 로컬 Codex CLI·Desktop이다. 지피티 스킬은 지피티에 등록·설치된 작업 절차, 지피티 플러그인은 지피티에서 연결·설치하는 도구·스킬 묶음, 지피티 지침은 사용자 지정 지침과 프로젝트 지침, 지피티 프로젝트는 지피티의 프로젝트 공간, 지피티 대화는 그 안팎의 개별 대화다. 코덱스 스킬은 코덱스가 사용하는 로컬 스킬이다. 코덱스의 일반 작업은 OCX 경로를 사용한다. 네이티브 코덱스는 OCX를 거치지 않는 코덱스이며, OCX·AICC 업그레이드로 OCX 연결이 끊기는 구간의 독립 유지보수·복구에 사용한다. 사용자가 별도로 선택한 제한된 Daybreak 세부 인계는 아래 계약을 따른다. 작업 범위·독립 복구·복귀 조건을 갖추고, 정비 후 원래 OCX 작업으로 돌아간다. 지피티 자산과 도구 호출은 위 명칭으로 설명하며, 실제 slug·API 키·불변 ID는 유지한다.

## 필요한 것만 읽기

- 상태·모델 목록·현재 endpoint 조회는 이 본문만 사용한다.
- switch, install, restart, recover, account 변경, bridge·harness 변경에는 먼저
  [공통 변경 계약](references/operations.md)을 읽고, 그 표에서 **변경 대상 하나의 reference만**
  추가로 읽는다.
- Codex Desktop 종료만 요청받으면 `aicc guidance find
  quit-codex-desktop-safely`로 비등록 workflow를 찾아 사용한다.

## 경로

| 경로 | endpoint | 추론 소유자 |
|---|---|---|
| 네이티브 코덱스 | 공식 Codex endpoint | OpenAI Codex |
| Web GPT | `http://192.0.2.1:17841/v1` | ChatGPT Web |
| OCX | `http://192.0.2.1:10100/v1` | 선택한 OCX provider |

17841 통합 경로에서는 `chatgpt-web/*`만 ChatGPT Web으로 보내고, 나머지는 OCX로
전달한다. 공식0.165 V2 `native.config.toml`은 `codex -p native`로 선택하는 독립 복구 profile이다. 기존 `codex-native`/rescue는 보존한다.

## 읽기 전용 확인

1. 활성 `$CODEX_HOME`의 `openai_base_url`과 설치된 help/schema를 확인한다.
2. `aicc web-gpt status --json`으로 17841 version, health, active turn, harness와
   현재 검증 상태를 본다.
3. OCX를 다루는 요청이면 10100 health와 실제 provider/catalog를 별도로 확인한다.
4. 네이티브 코덱스는 실제 profile·endpoint로 구분한다. 추론 요청은 해당 정비 범위와 현재 모델 정책·명시 요청이 허용할 때만 수행한다. 모델명만으로 route를 추측하지 않는다.
5. 실패한 health read는 0이 아니라 UNKNOWN으로 보고한다.

## 변경 경계

- 대화를 끊을 수 있는 업데이트·설치·재시작 전에는 `codex-rescue-preflight`의 사전 안내 계약으로 영향·예상 단절 시간·예상 완료(KST)·복구 방법을 매번 출력한다.

- provider·계정·profile·인증을 조용히 대체하지 않는다.
- 활성 turn이 있는 대상은 stop, restart, restore, reinstall하지 않는다.
- Web GPT 작업은 OCX를, OCX 작업은 Web GPT를 바꾸지 않는다.
- Desktop 재시작이나 종료는 현재 작업을 끊을 수 있으므로 운영 계약의 idle·복구 조건과
  사용자의 명시 범위를 모두 만족할 때만 수행한다.
- 변경 뒤 대상 health, 비대상 route 생존, catalog와 작은 read-only 요청을 확인한다.

## 확정 실패의 복구

승인된 업무에서 경로 결함을 확인하면 원인 보고에 멈추지 않고 해당 경로의 수정·필요 적용·원래 실패 동작 재시도를 이어간다. 코드상 미지원과 upstream의 실제 인증·권한 거절을 구분한다. 공통 오류 문구만으로 권한 차단을 단정하지 않는다. 현재 모델의 사후 검증 제한은 유지하며 명시적으로 요청한 재시도만 수행한다. 적용 전 활성 작업·독립 복구 조건이 부족하면 준비물을 마치고 정확한 기존 적용 명령과 해제 조건을 정본에 남긴다.

## 보고

실제 endpoint, version, health, active turn, 검증한 모델/catalog, 변경한 대상, 비대상
보존 여부와 미확인 항목을 구분한다. 이전 release의 canary를 현재 증거로 재사용하지 않는다.


## 독립 CLI와 일반 Chat

이 단계는 [상세 절차](references/native-recovery.md)의 같은 절을 읽고 수행한다.

## 사용자 승인된 제한 Daybreak 인계

이 단계는 [상세 절차](references/ocx-maintenance.md)의 같은 절을 읽고 수행한다.

## 기존1그룹 명령 단순화 · command-route-r2

이 단계는 [상세 절차](references/operations.md)의 같은 절을 읽고 수행한다.

## Windows Kiro 대화 시작·재개 (사용자 선택 경로)

이 단계는 [상세 절차](references/kiro-user-route.md)의 같은 절을 읽고 수행한다.

