# Message format 상세

## Message format

The sender renders every delivered alert in this compact Korean form. The first
character is always the urgency number so a mobile banner is readable without
color:

```text
5 긴급 | 사람 확인 필요
상태: 실제 차단 원인 한 줄
할 일: 원래 Codex 작업에서 필요한 행동 한 가지
출처: ai-platform
응답: 원래 Codex 작업
```

Omit empty optional lines. The delivery record keeps event and owner metadata,
including the exact task ID, so do not repeat an English event type, owner tag,
event ID, UUID, or correlation ID in the message.
For `restricted` events the sender replaces the caller title, summary, and next
gate with event-type-specific safe Korean. For `otp_required` it always uses a
fixed safe message and ignores all caller content, including bare numeric codes.

An example event is in [the response procedure](slack-responses.md).

