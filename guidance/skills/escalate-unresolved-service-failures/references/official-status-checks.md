# 공식 서비스 상태 확인

이 문서는 `SKILL.md`의 0~3단계를 통과한 뒤에만 읽고 적용한다. status page의 표시를
저장된 사실처럼 재사용하지 말고 매번 현재 상태를 조회한다.

## 우선 확인할 공식 source

| 서비스 | 공식 상태 source | component 대응 예시 |
|---|---|---|
| GitHub | [GitHub Status](https://www.githubstatus.com/) | Git Operations, API Requests, Actions, Pages, Packages, Copilot을 구분한다. Enterprise Cloud는 status page에 안내된 region별 상태도 확인한다. |
| Codex, ChatGPT, OpenAI API | [OpenAI Status](https://status.openai.com/) | Codex, ChatGPT, API, login, file upload처럼 실제 실패 surface와 incident 범위를 맞춘다. |

다른 vendor는 공식 문서나 support site가 직접 연결한 status page를 사용한다. 검색 결과의
도메인 이름이나 Statuspage 형식만 보고 공식 source라고 추정하지 않는다. vendor의 공식
문서·support navigation·소유 도메인 중 하나로 관계를 확인한다.

## 조회 순서

1. 현재 component 상태를 확인한다.
2. 실패 시각을 포함하는 incident history를 확인한다.
3. incident 상세에서 시작·완화·복구 시각과 영향 component를 읽는다.
4. region, product tier, API/UI, auth 같은 범위가 현재 증상과 맞는지 비교한다.
5. 공식 support 공지나 release notice가 더 구체적인 경우 보조 근거로 연결한다.

제3자 장애 집계, 소셜 미디어와 커뮤니티 글은 영향 가능성을 찾는 보조 신호일 뿐이다.
공식 incident나 동일 조건의 재현 없이 그것만으로 장애를 확정하지 않는다.

## 최소 증거 기록

```text
checked_at: <ISO-8601 with timezone>
service: <vendor/product>
component: <exact component>
official_url: <status or incident URL>
official_state: operational | investigating | identified | monitoring | resolved | unknown
incident_window: <start/end or unknown>
symptom_match: yes | partial | no | unknown
scope_match: yes | partial | no | unknown
notes: <short sanitized observation>
```

상태가 green이면 `장애 없음`이 아니라 `공식 상태에서 현재 incident를 찾지 못함`이라고
기록한다. incident가 resolved로 바뀌어도 같은 probe와 원래 작업이 성공하기 전에는 복구로
판정하지 않는다.
