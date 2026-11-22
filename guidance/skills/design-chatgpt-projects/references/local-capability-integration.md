# 로컬 지침·skill·plugin 융합

로컬 자산을 ChatGPT Project에 반영할 때 파일 종류가 아니라 실제 역할로 분류한다.

## 세 가지 배치

| 배치 | 적합한 내용 | 결과 |
| --- | --- | --- |
| Instructions | 시작 절차, 출력 계약, 사실 잠금, 검증, 금지와 handoff | Project Instructions에 짧게 통합 |
| Source | 도구와 무관하게 재사용 가능한 방법론·template·검토 기준 | 개인정보와 운영 경로를 제거한 증류본 |
| Runtime connector | Notion, Drive, Slack처럼 현재 제품에서 실제 연결된 읽기·쓰기 기능 | 도구·권한·승인과 post-read 계약으로만 사용 |

한 자산이 여러 역할을 가지면 원문을 통째로 올리지 않고 역할별로 분리한다. Codex skill의 shell 명령,
로컬 repository 경로, browser profile, account/session, plugin 내부 tool name과 agent-only retry 규칙은 대개
ChatGPT Project source가 아니다.

## 판단 순서

1. 이 기능이 Project의 반복 결과를 실제로 개선하는지 확인한다.
2. ChatGPT Project가 그 도구를 실제로 쓸 수 있는지 현재 제품·workspace에서 검증한다.
3. 도구가 없어도 유효한 판단법이면 공유-safe source로 증류한다.
4. 특정 connector가 필요하면 tool/access 층에 dependency, read/write 범위와 승인 조건을 적는다.
5. connector가 없거나 권한이 다르면 도구 사용을 흉내 내지 않고 handoff 또는 `HOLD`로 끝낸다.

## 별도 Project를 만드는 기준

skill·plugin을 관리한다는 이유만으로 메타 Project를 만들지 않는다. 다음이 모두 성립할 때만 실제 업무
Project를 추가한다.

- 사용자가 반복해서 시작하는 독립 작업이다.
- 이웃 Project와 source·대화 history·완료 기준이 다르다.
- 이름만 보고 올바른 시작점을 고를 수 있다.
- 별도 Project가 없어 발생하는 오염이나 누락이 구체적이다.

예를 들어 조사→근거 판정→지식 승격은 코딩·콘텐츠·일정과 다른 source와 history를 가지므로 별도
`리서치·지식 정리` 후보가 될 수 있다. 반면 Project 자산 sync 자체는 운영 agent skill이 소유하므로
일반 ChatGPT Project로 복제할 이유가 없다.

## 금지

- secret, 원문 계정, session, browser profile과 raw private records 업로드
- plugin이 설치되지 않았는데 Notion·Slack·Drive write를 수행했다고 주장
- third-party skill·교재·prompt 원문을 권리 확인 없이 cross-workspace 복제
- AI 탐지 회피, 타인의 문체 모방 또는 플랫폼 정책 우회 지침을 capability로 승격
- local-only 또는 owner-only marker를 무시하고 공유 source로 선택
