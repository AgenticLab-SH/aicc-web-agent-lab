# Background Computer Use runbook

## 목적
사용자의 현재 브라우저 탭·마우스·키보드·포커스를 가능한 한 건드리지 않고
브라우저 자동화를 수행하는 재사용 가능한 운영 계약을 정의한다.
특정 owner의 경로, 포트, 계정, 프로필 이름은 이 문서에 고정하지 않는다.

## 선택 우선순위
1. 공식 API·connector·서비스 전용 tool
2. 파일·CLI·DB·workspace 같은 구조화된 로컬 tool
3. DOM/CDP 기반 browser automation
4. 위 경로로 불가능할 때만 GUI Computer Use

## 브라우저 계약
- 사용자 normal browser profile과 agent automation profile을 분리한다.
- agent browser는 loopback CDP endpoint만 사용한다.
- background target attach/switch를 기본으로 하고 visible activation은 명시 요청 때만 한다.
- physical mouse/keyboard 또는 foreground SendInput을 자동 fallback으로 사용하지 않는다.
- login, MFA, consent, ambiguous account selection은 사용자에게 넘긴다.

## 사용자 권한 경계
Computer Use OFF는 승인 철회다.
wrapper, MCP, auto-recovery, agent 모두 OFF를 스스로 ON으로 바꾸지 않는다.
OFF 상태의 실행기는 fail-closed로 실패해야 한다.

## 검증
완료는 process exit code가 아니라 독립적인 post-state로 판정한다.
- browser: URL/DOM/page state
- transport: loopback listener identity
- input: expected value/action result
- non-intrusive: foreground/cursor invariant가 필요한 경우 별도 probe

## 장애 처리
- background action 실패를 foreground action으로 조용히 승격하지 않는다.
- 같은 dispatch를 blind retry하지 않는다.
- port 충돌은 process identity를 확인한 뒤 해결한다.
- 사용자 normal Chrome이나 다른 registered CDP slot을 대체 종료하지 않는다.
- package/update 후에는 background input/click, OFF fail-closed, MCP handshake를 다시 검증한다.

## 문서 분리
재사용 가능한 원칙은 open-AICC docs에 둔다.
특정 owner의 exact port, profile, path, version, shortcut, current state는 private owner 문서에 둔다.
live 상태는 문서가 아니라 현재 probe가 최종 정본이다.
