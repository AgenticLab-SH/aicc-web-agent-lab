# AICC guidance surface 배치 기준

| Surface | 넣을 내용 | 넣지 않을 내용 | 판정 질문 |
|---|---|---|---|
| Prompt/chat | 이번 작업의 목표, 현재 상황, 출력 형식, 일회성 제약 | 반복 정책, 장기 운영 규칙 | 다음 작업에서도 반복되는가? |
| `AGENTS.md` | 모든 작업자가 항상 알아야 할 짧고 지속적인 저장소 원칙, 정본, 안전 경계, 핵심 검증 명령 | UI 세부 조작, 긴 절차, 환경별 값 | 모든 작업에 자동 주입할 가치가 있는가? |
| Config | 계정 별칭, 경로, 배포 대상, feature flag, 임계치 | 의미 판단과 긴 workflow | 기기·환경별로 달라지는 값인가? |
| Skill | 반복되는 한 사용자 목표, 비결정적 판단 절차, 조직 고유 지식 | 일반 계획법, 범용 도구 선택, 단순 사실, 네이티브 기능 래퍼 | 같은 판단이 반복되고 일반 모델이 모르는 규칙이 있는가? |
| Validator/script | schema, hash, manifest, 파일 존재, 중복, tree 비교, secret pattern | 유용성·의미 중복 같은 주관 판단 | 같은 입력에 항상 같은 pass/fail이 가능한가? |
| MCP | 인증이 필요한 실시간 외부 데이터, 외부 시스템 조회·행동 | 정적 절차와 템플릿 | 살아 있는 외부 시스템 연결이 필요한가? |
| Plugin | 공유·설치할 skill 묶음, skill과 connector/MCP의 안정된 배포 단위 | 개인용 실험, connector 없는 단일 로컬 절차 | 다른 사용자에게 설치·업데이트할 단위인가? |
| Hook | lifecycle 이벤트마다 반드시 실행할 짧은 결정적 검사 | 광범위한 의미 판단, 숨은 자동 수정 | 이벤트에 예외 없이 자동 집행해야 하는가? |
| Automation | 시간·주기·조건 기반 감사, 알림, 정기 보고 | 현재 요청의 일회성 검토 | 실행 시점이나 미래 조건이 핵심인가? |

둘 이상의 surface가 필요하면 각 surface의 책임을 한 문장으로 분리한다. 같은 규칙을
여러 곳에 복사하지 말고, 한 정본과 얇은 참조 또는 생성 경로를 둔다.

## 기본 노출 예산

- 기본 등록은 반복 사용되는 진입 스킬과 네이티브 도구만 둔다. 나머지 workflow는 정본에 보존하되 agent home·plugin·MCP에는 등록하지 않고 필요할 때 검색해 읽는다.
- 비등록 workflow는 `aicc guidance find`로 찾아 원문만 읽고 현재 도구·CLI·검증된 script로 수행한다. 일회 사용을 위해 등록하지 않는다.
- 살아 있는 기능은 이미 활성화된 제한 gateway, 해당 설정으로 시작한 별도 프로세스·새 작업 순으로 사용한다. 현재 대화를 멈춰 전역 plugin·MCP를 켜고 재시작하는 방식은 불가피할 때만 다음 작업 경계에서 쓴다.
- 도구가 많으면 namespace·tool search·지연 로딩을 우선하고, 중간 결과는 코드에서 필터링해 필요한 근거만 모델에 보낸다. 현재 host가 지원하지 않는 지연 로딩을 가정하지 않는다.
- 새 항목은 기존 hot 항목으로 해결되지 않고 반복 사용이 확인될 때만 기본 등록한다. 등록 수 증가는 같은 수 이상의 통합·비활성화 또는 측정 근거를 요구한다.

## MCP를 skill로 대체하는 gate

- skill은 지침·reference·script를 제공하지만 host에 도구, 인증, 세션이나 연결을 등록하지 않는다.
- 네이티브 도구나 기존 shell/network로 실행 가능한 CLI·공식 API·검증된 script가 같은 기능을 제공할 때만 MCP를 retire하고 skill workflow로 합친다.
- 실시간 외부 데이터, OAuth, 원격 상태 변경이나 host approval이 필요하면 MCP/connector를 유지하고 skill은 사용법과 dependency만 선언한다. 비활성 MCP는 현재 작업에서 사용할 수 없다.
- 하위 에이전트가 새 capability를 자동 상속한다고 가정하지 않는다. 실제 도구 목록을 확인하고, 없으면 그 capability로 시작한 격리 프로세스나 새 작업에 맡긴다.
- MCP on/off만 감싼 skill이나 MCP protocol을 shell에서 다시 구현한 wrapper는 만들지 않는다. 필요 범위가 좁으면 project-scoped MCP나 connector를 쓴다.
