# 아키텍처와 장애 경계

```text
Codex Desktop
  ├─ Native direct ──────────────────────────────> OpenAI Codex
  └─ 17841 Integrated router
       ├─ chatgpt-web/* ── browser session ──────> ChatGPT Web
       │                    └─ full harness Tunnel -> 현재 Codex task tools
       └─ non-Web model ─────────────────────────> configured upstream
                                                     ├─ default: official Codex
                                                     └─ explicit OCX route

External ChatGPT
  └─ Workspace Secure MCP Tunnel
       └─ AICC Workspace MCP ────────────────────> 등록된 workspace
```

## 포트와 소유권

| 표면 | 기본 loopback | 소유자 | readiness 의미 |
|---|---:|---|---|
| Integrated Web GPT router | 17841 | `codex-chatgpt-web` 서비스 | Responses route와 browser broker가 현재 릴리스로 준비됨 |
| Web GPT direct rescue | 17842 | 별도 rescue 서비스 | 17841과 독립된 제한 복구 경로 |
| OCX client / data plane | 10100 / 10101 | OpenCodex client + A1 hub | 현재 stock runtime의 client 연결과 data-plane 준비 상태를 각각 확인 |
| AICC control API | 설치별 고정 포트 | AICC | control plane status와 job store 접근 가능 |

정적 포트 배정은 현재 점유 증거가 아니다. `lsof`의 listener PID와 exact command, 서비스
manifest, health payload의 PID가 일치해야 한다. 다른 프로그램이 포트를 점유하면 자동 종료나
임의 포트 이동을 하지 않는다.

## 네 생존 경로

1. Integrated 17841: 일반 Codex 모델 선택기와 Web GPT 통합 경로
2. Web GPT direct 17842: 17841 장애 시 별도 복구 경로
3. OCX direct 10100: Web GPT와 독립된 upstream 모델 경로
4. Native direct: 로컬 브리지·OCX와 독립된 공식 Codex 경로

한 경로가 실패해도 다른 경로로 조용히 바꾸지 않는다. 실패 경로, 선택된 대체 경로와
복원 기준을 사용자에게 보이는 상태로 남긴다.

## Tunnel을 합치지 않는 이유

Web GPT full-harness Tunnel은 현재 Codex turn의 동적 도구를 broker에서 받는다. Workspace
Tunnel은 외부 ChatGPT가 고정된 workspace 도구를 사용한다. 둘을 한 profile이나 프로세스로
multiplex하면 인증·권한·lifecycle·장애가 함께 전파된다. 대시보드와 정책은 통합하되 Tunnel
ID, 인증과 복구는 분리한다.
