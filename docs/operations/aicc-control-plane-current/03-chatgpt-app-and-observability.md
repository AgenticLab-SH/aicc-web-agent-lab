# ChatGPT MCP 앱 등록과 관측성

## 등록 전략

현재 목표는 public marketplace 배포가 아니라 사용자/워크스페이스용 Custom MCP App이다.
따라서 첫 연결은 public HTTPS endpoint보다 OpenAI Secure MCP Tunnel을 우선한다.

```text
ChatGPT
  -> Custom MCP App
  -> OpenAI Secure MCP Tunnel
  -> AICC Relay @ A1 (upstream: NexusDock, private/loopback)
  -> AICC Endpoint @ Windows (upstream: AgentDock)
  -> AICC Workspace MCP / bounded AICC actions
```

## 앱 생성 시점

다음이 PASS한 뒤 Create app을 진행한다.

- AICC Endpoint Windows isolated POC와 reboot/reconnect PASS
- AICC Relay A1 ARM64 isolated POC와 restart recovery PASS
- AICC Workspace MCP downstream 연결 PASS
- tunnel-client doctor/health/ready
- read-only tool ABI 고정
- tool descriptions/schemas/annotations 검토
- metrics/log redaction 검토
- rollback path

Business에서 published custom app의 tool snapshot 변경 제약이 있으므로,
스키마가 흔들리는 동안은 개발 상태에서 테스트한다.

## ChatGPT 연결 절차

1. Developer mode 활성화
2. Apps/Plugins의 Create 또는 MCP 앱 만들기 진입
3. Connection에서 Tunnel 선택
4. 대상 tunnel 선택 또는 tunnel ID 입력
5. 앱 이름/설명 등 metadata 입력
6. Tool Scan
7. 발견된 tools/schema/annotations 확인
8. Dev 상태에서 evaluation prompt 실행
9. read-only acceptance PASS 후 사용
10. 게시가 필요하면 별도 publication gate

## Evaluation set

- 특정 tool을 직접 요구하는 prompt
- 같은 목표를 간접 표현한 prompt
- 이전 결과 identifier를 재사용하는 follow-up
- 지원하지 않는 요청
- device offline 상태
- stale snapshot 상태
- timeout 상태
- read-only surface에 write를 요구하는 요청

## MCP 관측 지표

필수:
- `mcp_requests_total{method,status}`
- `tool_calls_total{tool,status}`
- `tool_duration_ms{tool}`
- `broker_queue_wait_ms`
- `device_online`
- `device_disconnect_total`
- `inflight_requests`
- `queued_requests`
- `timeouts_total{stage}`
- `tool_result_bytes{tool}`

가능한 경우:
- `workspace_cache_hit_total`
- `workspace_cache_miss_total`
- `snapshot_stale_total`
- `lease_open_total`
- `lease_close_total`

## 누적 비용/토큰

MCP backend는 ChatGPT의 모델 inference token 사용량을 신뢰성 있게 직접 관측하지 못한다.
따라서 ChatGPT token/cost를 AICC Relay/Endpoint/Control Plane에서 추정하지 않는다.

별도 OpenAI API 호출이 usage 객체나 정확한 조직 Usage API 데이터를 제공하는 경우에만:
- input/output/cached token
- API-side estimated cost
를 별도 source label로 저장한다.

ChatGPT 구독 사용량과 API billing을 합산해 하나의 비용으로 표시하지 않는다.

## 로그 개인정보 경계

저장 금지:
- prompt/input 원문
- file contents
- access/OAuth/runtime token
- SSH key
- auth header
- raw MCP result

저장 허용:
- timestamp
- tool name
- request correlation ID의 비가역 hash
- duration
- status/error class
- byte count
- cache/snapshot metadata
- endpoint/relay generation

## 최종 backend 경계

- ChatGPT 앱의 production target은 자작 `10311` gateway가 아니라 AICC Remote Fabric 경로다.
- 자작 gateway는 AICC Relay/Endpoint acceptance 전까지 reference/rollback prototype로만 유지한다.
- AICC Endpoint의 upstream unrestricted shell/filesystem은 초기 ChatGPT app tool surface에 노출하지 않는다.
- ChatGPT 앱이 보는 기본 도구는 AICC의 bounded read surface부터 시작한다.
- write/command는 별도 acceptance 이후에만 추가한다.
