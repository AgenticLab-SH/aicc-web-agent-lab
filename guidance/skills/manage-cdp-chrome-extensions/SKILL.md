---
name: manage-cdp-chrome-extensions
description: AICC에 등록된 전용 Chrome CDP 슬롯의 로컬 확장과 미래 슬롯 설정 준비를 관리한다. 기존 프로필·로그인을 보존하며 일반 Chrome, 주식 전용 슬롯과 새 로그인은 요청 범위 밖이다.
---

# CDP Chrome 확장과 슬롯 준비

AICC 전용 등록 Chrome 프로필과 로컬 확장만 관리한다. 최신 private coordination의 slot/profile/role/account/workspace 등록과 owner extension registry가 정본이다. 포트 9222~9225 고정 범위나 과거 계정표를 현재 권한으로 쓰지 않는다. listener PID·프로필 일치와 실제 로그인 identity는 별개다.

기존 owner-local Manage-AiccChromeExtensions.ps1과 Edit-AiccChromeExtensionRegistry.ps1을 재사용한다. 배포 경로는 등록된 AICC state root에서 찾으며 개인 절대 경로를 스킬에 넣지 않는다. 필요한 절차만 [references/operations.md](references/operations.md)에서 읽는다.

## 확장 변경

1. exact port와 extension key를 좁혀 변경 전 상태, 같은 action의 DryRun, preimage와 rollback을 준비한다. 최신 preview와 해당 action의 1회 확인이 필요한 control-plane 계약을 따른다. all은 모든 대상이 승인된 경우에만 사용한다.
2. 기본은 기존 브라우저 재사용과 NoStart다. offline은 고장이 아니라 휴면일 수 있다. 기존 등록 프로필 기동까지 승인된 작업만 시작하며, 포커스 탈취·일반 Chrome·임의 새 계정으로 우회하지 않는다.
3. manifest identity, 권한 allowlist, trusted root와 profile guard 중 하나라도 불일치하면 HOLD한다. registry가 허용하지 않는 host 범위를 자동 확장하지 않는다. 프로필·쿠키·Preferences를 직접 편집하지 않는다.
4. CDP load/reload는 세션 범위이며 영구 설치라고 표현하지 않는다. 영구 등록 상태와 세션 로드를 구분하고 현재 지원된 공식 UI 경로를 따른다. 보호된 확장 UI를 다른 수단으로 우회하지 않는다.
5. Remove는 실행 세션 제거, Unregister는 이후 관리 대상 해제다. 정확한 삭제 승인과 backup·rollback 없이 실행하지 않는다. 고유 ID·키·경로·버전을 사용하며 이름만으로 다른 소유자의 확장을 건드리지 않는다.

## 미래 슬롯의 config-only 준비

기존 docs/runbooks/browser-slots.md의 미래 슬롯 절차를 재사용한다. 적은 비활성 후보만 문서로 준비하고 live coordination/registry/count, 런처, 프로필과 로그인은 바꾸지 않는다. pending/disabled는 lease 후보에서 제외되지만 시작기의 직접 실행까지 차단한다고 가정하지 않는다.

등록 전 포트 중복, 전용 profile 경계, account/workspace identity, lease와 active/unknown의 exact-zero, RAM·CPU·프로세스·target 여유 및 런처 지원 범위를 별도로 확인해야 한다. 리소스를 읽지 않았으면 capacity 미확인이다. lease target 상한을 늘린 것이 메모리 여유 증거는 아니다.

슬롯 변경의 exact-idle은 해당 슬롯과 영향받는 구성요소에 적용한다. 일반 1회 Chat에 무관한 17841 HTTP counter를 잘못 적용하지 않는다. 포트 17841과 주식 전용 9336은 이 작업에서 현상유지이며 미래 후보·fallback에 넣지 않는다. 의미 없는 Chrome 실행, 프로필 복제와 새 로그인은 하지 않는다.

## 정책과 결과

완료에 필요한 검증은 공통 지침과 사용자 요청 범위를 따른다. 모델 이름만으로 생략하지 않는다. live 변경이 요청됐는데 필수 preview/identity/idle 근거를 얻을 수 없으면 config-only 준비와 HOLD를 보고한다. 확인 근거 없이 live 변경을 수행하지 않는다.

설정 준비, 소스 수정, 홈 배포, registry 적용, 세션 로드와 실제 작동은 별도 상태다. 사용자 탭·다른 lease·프로필·로그인을 보호하고 작업 소유 target만 반환한다.
