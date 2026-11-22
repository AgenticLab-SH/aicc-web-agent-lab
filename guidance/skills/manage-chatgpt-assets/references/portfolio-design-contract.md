# Project 포트폴리오 설계 계약

Project 추가·분리·융합·전면 재편 요청에서만 읽는다.

## 설계 기준

- Project 하나는 반복되는 작업 방식, 공통 Instructions, 교체 가능한 source set과 대화 문맥이 함께 유지될 때 가치가 있다.
- 입력 source, 출력 품질 기준, 보안·권한 경계 또는 작업 리듬이 다르면 분리한다.
- 같은 source와 규칙을 쓰고 한 대화 문맥에서 자연스럽게 이어지면 융합한다.
- 회사, 시험 회차, repository, 과정, 채널처럼 교체 가능한 대상마다 Project를 만들지 않는다. base shell을 유지하고 active source set만 바꾼다.
- 같은 workspace에서 여러 계정이 필요하면 replica를 기본으로 만들지 말고 소유 stable ID 하나와 최소 권한 공유를 검토한다.

## Candidate 필수 항목

- logical ID, 자연스러운 표시 이름, 목적, 포함·제외 범위
- owner account/workspace와 공유 대상
- base source와 active source set, rotation·archive 규칙
- Instructions 초안과 8,000자 이하 검증
- predecessor 흡수·분리 관계와 중복 방지 설명
- source provenance·권리·개인정보 disposition
- create/update/retrieval canary와 rollback 조건

Candidate는 로컬과 Notion에만 둘 수 있다. 사용자 승인과 exact remote preflight 전에는 create하지 않는다.

## 품질 경계

- 모든 자료를 한꺼번에 올리는 것은 completeness가 아니다. 현재 retrieval에 필요한 작은 source set을 우선한다.
- raw 대화는 먼저 owner-only backup과 증류를 거치며, 원문이 필요하지 않으면 검증된 knowledge만 편입한다.
- 개인 사실을 여러 Project에 복제해야 할 때는 단일 canonical source에서 빌드하고 각 복사본의 hash를 추적한다.
- Custom GPT의 좁은 역할·starter·tool 설정이 꼭 필요하지 않으면 Project Instructions의 mode/output contract로 흡수할 수 있다.
