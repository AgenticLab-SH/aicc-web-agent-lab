---
name: codex-reset-credit
description: Codex 한도·초기화권 만료를 조회하고 사용자가 명시적으로 요청한 초기화권 1회 사용을 처리한다.
---

# Codex usage and reset credits

Run the bundled wrapper for a sanitized, read-only account report:

```powershell
python scripts/check_reset_credits.py
```

Use `--json` when structured output is needed and `--daily-limit 0` to include every returned daily bucket.

The tool performs the required JSON-RPC handshake and calls only:

- `account/rateLimits/read`
- `account/usage/read`

Report the plan, percentage used and remaining, automatic reset in KST with remaining duration, available Full reset count, each available credit's expiry and remaining duration, and usage summary. Do not reveal account IDs, credit IDs, email addresses, auth tokens, profile URLs, or raw app-server messages.

The bundled reader never consumes credits; keep its method allowlist intact. Read `references/app-server-protocol.md` only when diagnosing handshake or response-shape drift.

## 초기화권 사용은 명시 요청 때만

- 사용자가 현재 작업에서 초기화권을 쓰라고 명시한 경우에만 1장 사용한다. 한도 조회, 개발 계속, 한도 회복 후 자동재개, 만료 임박은 소비 승인이 아니다. 예약·백그라운드 자동소비를 만들거나 켜지 않는다.
- 소비 전에 기존 프로젝트·operation 기록에서 이 요청의 완료 여부를 확인한다. 대화 이관·압축 뒤 같은 요청이 다시 보이면 새 소비 승인으로 세지 않는다. 이미 reset·소진이 확인됐으면 결과를 재사용하고, 추가 1장 사용을 새로 명시한 경우에만 별도 요청으로 처리한다.
- “가장 빠른 초기화권”은 가장 먼저 **만료**되는 권이다. 만료시각은 KST로 설명한다. 특정 개인 계정·selector·신원 해시는 공용 스킬에 저장하지 않는다.
- OCX 계정은 기존 등록 owner 관리기를 사용한다. 정확한 계정 신원을 fresh 조회하고 `credits`로 사용 전 목록을 확보한 뒤 [OCX 단회 사용 절차](references/ocx-reset-on-request.md)를 따른다. 이 스킬은 로그인·계정 선택·provider 전환 승인을 만들지 않는다.
- 특정권 선택 지원과 서비스가 선택하는 1장 사용을 구분한다. 선택 미지원이면 먼저 밝힌다. 사용자가 그 상태를 알고도 사용을 재지시한 경우 기존 단회 기능을 쓰고 실제 소비한 권은 전후 차이로만 판정한다. 특정권만 허용하거나 대체를 거절했다면 선택 보장이 없을 때 HOLD한다.
- 전송 결과가 불명이면 원 operation을 조회하며 새 operation으로 다시 쓰지 않는다. reset 성공, 정확한 권 소진, quota 회복, 작업의 새 turn·완료는 각각 따로 확인한다.
