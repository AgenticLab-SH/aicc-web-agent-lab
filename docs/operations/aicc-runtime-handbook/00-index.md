# AICC runtime handbook

이 디렉터리는 ChatGPT Project의 Sources와 로컬 운영자가 함께 읽을 수 있는 공개 가능한
운영 묶음이다. 계정 이메일, 토큰, Tunnel ID, 브라우저 프로필, 세션 원문, PID와 개인 절대
경로는 넣지 않는다. live 상태는 이 문서가 아니라 각 컴포넌트의 현재 probe가 정본이다.

## 읽는 순서

처음에는 [쉬운 사용 설명서](../../user-guide.html)를 읽습니다.
에이전트용 정본은 [Markdown](../../user-guide.md)이고, 현재 상태는 `context/PROJECT.md`를 따릅니다.

1. [아키텍처와 장애 경계](01-architecture-and-failure-domains.md)
2. [OCX 운영과 복구](02-ocx-operations-and-recovery.md)
3. [Web GPT·압축·Tunnel](03-web-gpt-compaction-and-recovery.md)
4. [Workspace MCP와 ChatGPT 앱](04-workspace-mcp-and-chatgpt-apps.md)
5. [작업 연속성과 Terminal callback](05-continuity-and-terminal-callback.md)
6. [Windows Codex 복구와 Web GPT 안전 지침](06-windows-codex-recovery-and-safety.md)

관련 세부 runbook: [Background Computer Use](../../runbooks/background-computer-use.md)

## 증거 우선순위

1. 현재 listener, exact process identity, `/healthz`, `/readyz`, active-turn/lease probe
2. owner-only 원자적 결과 JSON과 SHA-256
3. 설치 manifest, integration journal, 설정의 redacted hash
4. 소스와 결정 문서
5. 과거 로그와 대화 요약

소스 테스트 PASS는 현재 설치 PASS가 아니며, 과거 복구 PASS는 현재 browser/runtime PASS가
아니다. active 또는 UNKNOWN이 하나라도 있으면 route·Desktop·Tunnel·브라우저 프로필을
변경하지 않는다.

## 고정 원칙

- 하나의 AICC control plane을 유지하되 Native, Web GPT, OCX, Workspace MCP, browser의
  runtime·인증·data plane·복구 failure domain은 합치지 않는다.
- 정상 요청을 살리는 경로와 장애 시 callback 경로는 서로 독립적으로 검증한다.
- 자동 재시도는 pre-dispatch가 확실한 경우에만 제한적으로 허용한다. 전송 여부가 모호한
  요청, 압축 canary와 callback `turn/start`는 blind retry하지 않는다.
- 장기 작업은 내구 결과를 먼저 기록하고, UI나 Terminal 생존을 완료 조건으로 삼지 않는다.
