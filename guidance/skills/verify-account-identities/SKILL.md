---
name: verify-account-identities
description: 작업·보고 전 Chrome·Web GPT·OCX 신원을 확인한다. 포트·목록 순서로 추정하지 않는다.
---

# 실제 계정 확인

계정 보고·선택 전에 사용자가 선택한 surface와 필요한 서비스만 조회한다. 과거 대응표는 현재 로그인
증거가 아니다. 일반 Chrome 확장, registered CDP, routed Web GPT, OCX를 서로 대신 조회하지 않는다.

- Chrome 등록 slot은 제어 위치다. Google 프로필 로그인과 ChatGPT 로그인도 별개다.
- 일반 Chrome GPT 확장은 현재 확장 provider와 요청된 기존 탭 또는 소유 탭에 연결한 뒤 같은 탭의
  ChatGPT 계정·workspace 표시로 확인한다. Chrome profile 표시명은 ChatGPT 계정 증거가 아니다.
  provider나 탭 연결이 없으면 로그인 상태는 미확인이다. 사용자가 대체 CDP 포트·계정을 명시하면
  그 등록 경로를 별도 선택·검증해 작업을 계속하며, 그 결과를 일반 Chrome 신원 확인으로 보고하지 않는다.
- registered CDP를 요청했을 때만 `aicc-account-identities --web-only` 또는 등록된 private adapter의
  account-surface-status로 등록 slot의 ChatGPT 세션을 읽는다. 명령이 여러 slot을 반환하면 요청된
  exact slot의 결과만 사용한다. 새 소유 탭만 쓰고 대화는 보내지 않는다.
- routed Web GPT는 해당 route의 실제 session/provider 증거로 확인한다. 일반 Chrome 로그인이나
  CDP listener만으로 routed 계정·연결을 확인했다고 보고하지 않는다.
- OCX만 필요하면 `aicc-ocx-hub -Action identity`로 서버의 실제 계정명·selector·해시·active를 읽는다. Windows는 client여서 로컬 pool이 비어 있어도 서버 계정이 없는 것은 아니다.
- Native Codex/CM은 활성 CODEX_HOME과 `cm status`를 확인한다. Web GPT/OCX 대응을 대신 쓰지 않는다.

보고에는 서비스와 확인 시각을 붙인다. 번호는 해당 서비스의 명시적 등록 번호만 사용한다. 다른 서비스와의 대응은 현재 emailHash가 유일하게 일치할 때만 연결한다. OCX에 번호가 없으면 `OCX selector(계정명)`으로 보고하고 번호를 만들어 붙이지 않는다.

일반 Chrome 연결 실패는 `use-web-gpt/references/surface-selection.md`의 동일 확장 재발견 절차로
진단한다. 앱 실행·확장 설치·native host 등록·현재 연결·인증 실패를 구분하고 CDP offline이나 빈
인벤토리만으로 Chrome 종료·로그아웃을 단정하지 않는다.

로그인·workspace가 등록값과 다르면 확인된 불일치와 `identity_mismatch`를 보고하고 변경 작업은 중지한다. 다른 계정을 대신 쓰거나 로그인·workspace를 자동 전환하지 않는다. 실패는 미확인으로 표시한다. 토큰·전체 이메일·대화 본문은 출력하거나 저장하지 않는다.
