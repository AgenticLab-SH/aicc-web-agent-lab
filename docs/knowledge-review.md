# 공식 지식 검토

open-AICC의 Knowledge Review는 OpenAI와 Anthropic의 공식 문서를 owner-only 상태에 증분 수집하고,
변경 후보를 사람이 검토할 수 있게 만든다. crawler는 source나 guidance를 자동으로 수정하지 않는다.

## 정본과 경계

컴파일된 source registry는 다음 exact host를 각각 독립 source로 취급한다.

- `developers.openai.com/llms.txt`: OpenAI API, plugin, workspace agent, commerce, cookbook과 개발자 문서
- `developers.openai.com/api/docs/guides/latest-model`: 현재 최신 모델과 모델별 선택 내용을 담은 canonical HTML 단일 문서
- `learn.chatgpt.com`: ChatGPT와 Codex 문서
- `learn.chatgpt.com/blog`: OpenAI Developer Blog. 문서 색인과 분리된 HTML source로 수집한다.
- `openai.com/news/rss.xml`: OpenAI News의 공식 RSS 변경 신호. 관련 기술·제품 글은 검토 시 공식
  article URL을 별도로 읽는다.
- `platform.claude.com`: Anthropic API와 platform 문서
- `code.claude.com`: Claude Code 문서
- `academy.claude.com/courses/ai-native-sdlc-playbook`: intent, requirements, plan을 포함한 Claude Academy의 공식 AI-Native SDLC 과정
- `claude.com/blog`: Claude 제품·개발 글
- `www.anthropic.com/engineering`: Anthropic Engineering 글

모든 source는 HTTPS, 단일 exact host, 명시한 path prefix, byte 상한과 content type을 가진다.
redirect가 host를 바꾸면 따라가지 않고 별도 source로 등록한다. `llms-index` source는 machine-readable
`.txt`와 `.md`만 순회하고 `llms-full.txt`, 현재 byte 상한을 넘는 exact 문서와 retired URL은
정책에 명시해 반복 요청하지 않는다. `learn.chatgpt.com`이 현재 Markdown에 사용하는
`application/octet-stream`은 그 exact source와 byte 상한 안에서만 허용한다.
현재 2 MiB를 조금 넘는 공식 `codex-manual.md`를 포함하기 위해 `openai-chatgpt`만 3 MiB 상한을
사용하고, 나머지 source는 2 MiB를 유지한다.

owner registry가 컴파일된 정책과 달라지면 이전 파일과 digest manifest를 owner-only backup에 먼저
보존한 뒤 교체한다. 인증, cookie, browser profile과 source 본문은 저장소에 넣지 않는다.

## 실행 계약

Dashboard API는 다음 순서로 쓴다.

1. `GET /api/knowledge-review/status`로 running/queued job과 source cursor를 확인한다.
2. `POST /api/knowledge-review/preview`에 exact `sourceIds`를 보내 scope와 자동 적용 0을 확인한다.
3. 별도 확인 뒤 `POST /api/knowledge-review/jobs`에 `confirmed`, `requestId`, `idempotencyKey`와 같은
   `sourceIds`를 보낸다.
4. scheduler가 confirmed job 하나를 실행한다. Dashboard request thread가 crawl을 소유하지 않는다.
   Windows runner는 자동 등록된 system scheduler가 없으므로 같은 `local-scheduler.mjs`를 hidden one-shot
   child로 한 번 기동한다. Dashboard가 꺼져 있으면 hidden local process를 요청 수명 동안만 기동하고
   완료 후 종료한다. 직접 service `runOnce`를 호출하지 않으며 writer lease는 그대로 유지한다.
5. run manifest의 source outcome, errors, candidate count, promotion count와 rollback ref를 검토한다.

이전 페이지가 20개 이상인 source에서 기존 페이지의 80% 이상이 한 번에 바뀌면
`bulk_source_change_review`를 기록한다. 변경을 무시하거나 자동 승격하지 않고, 전역 템플릿 변경인지
실제 대규모 개정인지 표본 diff와 공식 페이지로 확인한다. 예상하지 못한 내부 오류는 민감한 원문 대신
안정된 `diagnosticId`를 기록한다.

사용자가 최신 OpenAI/Codex·Anthropic/Claude 변화와 로컬 정본의 비교를 명시적으로 요청하면
`$review-agent-platform-updates`가 요청한 exact source에 이 계약을 사용한다. Codex/AICC 관련 작업에
진입할 때는 status만 읽고 source별 마지막 성공을 평가한다. exact affected source의 마지막 성공이
7일을 초과했거나 이미 관찰된 중요 공식 changelog 신호가 있을 때만 그 source를 한 번 갱신한다.
모두 current면 preview와 run을 실행하지 않는다. 두 trigger 모두 source 선택·preview·confirmed durable
job 단계를 생략하지 않는다. 상시 백그라운드 예약과 자동 승격은 금지한다.

한 source의 실패는 다른 source의 cursor를 되돌리지 않는다. partial run에서는 완료 source의 checkpoint만
전진하고 실패 source의 마지막 성공 시각은 유지한다. 다음 eligible trigger는 실패했거나 해당 작업에
영향받는 exact source만 다시 판단하며, 이미 current인 다른 source를 함께 반복하지 않는다. 403, 429와
robots deny는 HOLD이고, network와 5xx retry는 bounded다. ETag와 Last-Modified가 current이면 body를
다시 받지 않으며, 이전 cursor에 남은 URL도 현재 host/path/content 정책을 다시 통과해야 한다.

## 저장과 승격

본문은 content-addressed object, 진행은 source cursor, 실행은 run manifest와 durable job으로 분리한다.
각 page checkpoint 뒤 cursor와 durable checkpoint를 함께 갱신하므로 중단 후 동일 request를 blind
replay하지 않는다. candidate는 별도 decision ledger에서 promote, reject 또는 hold하며 promotion은
항상 수동이다. source나 guidance 변경은 별도 writer lease, backup, test와 배포 절차를 다시 요구한다.

사람이 읽는 최신 기준은 [`agent-platform-baseline.md`](agent-platform-baseline.md)에 유지한다. 각 명시
검토의 비교 결과는 `agent-platform-reviews/YYYY-MM-DD-<scope>.md`에 사실·로컬 증거·차이·제안·판단을
분리해 기록한다. 외부 문서 원문을 복제하지 않고 공식 URL, 확인 시각과 필요한 짧은 요약만 남긴다.

구현 계약은 [`../contracts/knowledge-review/`](../contracts/knowledge-review/)와
[`../src/knowledge-review/`](../src/knowledge-review/)에 있다.
