# 에이전트 컨텍스트 최적화 운영 지식

상태: 채택된 운영 playbook
범위: Codex·AICC 지침, skill, plugin, MCP, config와 Web GPT context packet

## 지피티와 코덱스의 공통 계약

지피티는 ChatGPT Web 일반 Chat, 코덱스는 로컬 Codex CLI·Desktop이다. 지피티 스킬은 지피티에 등록·설치된 작업 절차, 지피티 플러그인은 지피티에서 연결·설치하는 도구·스킬 묶음, 지피티 지침은 사용자 지정 지침과 프로젝트 지침, 지피티 프로젝트는 지피티의 프로젝트 공간, 지피티 대화는 그 안팎의 개별 대화다. 코덱스 스킬은 코덱스가 사용하는 로컬 스킬이다. 코덱스의 일반 작업은 OCX 경로를 사용한다. 네이티브 코덱스는 OCX를 거치지 않는 코덱스이며, OCX·AICC 업그레이드로 OCX 연결이 끊기는 구간의 독립 유지보수·복구에만 사용한다. 작업 범위·독립 복구·복귀 조건을 갖추고, 정비 후 원래 OCX 작업으로 돌아간다. 지피티 자산과 도구 호출은 위 명칭으로 설명하며, 실제 slug·API 키·불변 ID는 유지한다.

사용자에게 브라우저 작업용 탭 생성·prompt 전송·해당 응답 회수를 설명할 때는 **지피티 대화 전송·응답 회수 도구**라는 기능명을 쓴다. 상세 절차와 구현 연결은 use-web-gpt 스킬을 따른다. OCX 계정 전환이나 상시 감시 도구와 혼용하지 않는다.

| 내용 | 한 곳의 정본 | 전달·운영 경계 |
|---|---|---|
| 짧은 공통 원칙 | guidance/directives/fragments/common.md | 생성/홈 지침과 승인된 원격 Instructions는 전달본 |
| 작업 절차와 참조 | guidance/skills/기존-slug | 홈과 지피티 패키지는 전달본; 절차 중복 금지 |
| MCP | 기존 서버·등록 도구 schema·호스트 권한 | 실제 노출 도구·인증·grant가 능력 근거 |
| 플러그인 | 기존 plugin 패키지·권한·설정 | 도구·스킬 포장; 설치만으로 현재 연결을 증명하지 않음 |
| 목표·제외·현재/HOLD·다음 담당 | 기존 context/PROJECT.md | 변화와 결과 위치만 인계 |
| 재사용 교훈 | capture-operational-knowledge 색인과 기존 소유 사례 | 다른 스킬에는 링크만 유지 |
| journal/cache/backup | 각 제품의 기존 제품별 경로·owner-local 원장 | 공통 로그/세션 원문 복제본을 새로 만들지 않음 |

공개 정본은 재사용 절차·코드·문서만 소유한다. 계정·인증·profile·lease·attempt·개인 자료·복구 ZIP은 소유자의 기존 runtime/state/backup에 둔다. 사용자 PC 경로를 지피티 컨테이너로 해석하지 않는다. 실제 경로는 프로젝트 지도와 등록 정보를 따른다.

담당자가 아직 인수하지 않은 요청은 소유자 로컬 상태 루트의 `pending-work`에 요청당 문서 하나로 둔다. 목적·상태·담당·적용 대상·기존 정본 링크·인수 조건만 기록하고 로그·백업·대화 원문은 넣지 않는다. 담당자는 인수 후 자기 정본에 합치며 등록·원본 수정·배포·실제 반영을 구분한다. 완료 내용은 기존 정본/완료 기록에 흡수하고 대기 문서를 정리하되 영구삭제는 기존 확인 규칙을 따른다. 지피티는 기존 AICC Workspace의 등록 경로와 grant가 있을 때만 이 Windows 위치를 읽거나 쓸 수 있다. 접근 미지원이면 그렇게 기록하며 새 광범위 grant를 만들지 않는다. 대기 등록은 자동 실행·주기 감시·대화 발신을 허가하지 않는다.

토큰은 전체 홈·대화·로그 재주입을 줄여 아낀다. exact 대상·시각·소스 버전/SHA·접수/불명 상태와 이번 차이만 읽고 결정을 바꿀 원문만 연다. 캐시는 fresh 신원·권한·현재 draft/생성·불명 조정·원격 변경 전 preimage를 대신하지 않는다. 측정 없는 절감률은 주장하지 않는다.

지피티는 실제 제공된 공식 AICC 도구와 권한 안에서 조사·분석·정본 읽기와 쓰기·명령 실행·적용까지 우선 맡는다. 코덱스는 서버 작업과 실제 도구 미지원·해결 못한 부분을 이어받으며 같은 Git root와 원격 대상의 작성·발신 소유권을 조정한다. 전송·접수·응답 회수·정본 반영은 별도다. 설계 초안은 서버/공통 정본 직접 쓰기나 사후 코드 검증 대리가 아니다. 현재 모델의 사후 검증 금지를 외부 GPT로 우회하지 않는다.

원격 재구성은 기존 manage-chatgpt-skills/manage-chatgpt-assets manager가 맡는다. 현재 사용자 소유·workspace·ID·버전/전체 ZIP SHA·설치·의존 참조·preimage/rollback을 대상별로 결속한다. 타인/공용/소유 불명·불명 전송은 분리한다. SCREEN과 사용자 제외 프로젝트는 내용 읽기부터 제외한다. 새 등록은 ID·설치가 바뀔 수 있어 참조 이관과 복구를 별도로 기록한다.

## AI 협업 환경과 구성자산

전체를 **AI 협업 환경**, 환경별 묶음을 **지피티 구성자산**·**코덱스 구성자산**, 함께 지킬 규칙을 **공통 운영 계약**으로 부른다. 지피티는 ChatGPT Web 일반 Chat, 코덱스는 로컬 Codex CLI·Desktop이다. 실제 slug·도구/API 필드·불변 ID·저장 경로는 이 표시 용어로 바꾸지 않는다.

| 묶음 | 구성과 맡는 역할 |
|---|---|
| 지피티 구성자산 | 전역지침(사용자 특성·항상 필요한 원칙), 스킬(반복 절차), 플러그인(앱·실행 도구 연결의 배포 묶음), 프로젝트(이름·프로젝트 지침·소스파일) |
| 코덱스 구성자산 | 전역지침, 스킬, 플러그인, config(실행 설정), 공식 구조에 맞춘 프로젝트 문서·폴더 |
| 대화 | 작업 흐름/요청/결과를 담은 개별 채팅. 프로젝트·구성자산 종류·모델 공급자와 구분 |
| 지피티 프로젝트 | ChatGPT의 프로젝트 공간. 표시 이름·지침·첨부/소스와 대화가 연결됨 |
| 코덱스 프로젝트 | 로컬 개발 작업공간. 코드 저장소·가까운 지침·제품 문서가 연결됨 |

스킬은 절차, MCP/연결 도구는 실제 실행 능력, 플러그인(앱)은 이를 연결·배포하는 묶음이다. 설치·활성·권한·실제 호출은 별도 상태다. 다른 제품 용어와 실제 관리 UI의 구분은 유지한다.

사용자 설명에서는 Windows 데스크톱 앱 조작(Computer Use), 웹페이지 조작(Browser Use), Chrome 연결·조작(Chrome Use), OCX를 거치지 않는 네이티브 코덱스를 구체적으로 구분한다. 특정 도구에 API가 없거나 일반 명령이 실패한 사실을 제품 전체의 기능 부재 또는 보안 거절로 확대하지 않는다. 실제 호출 결과와 원인 추정도 분리한다. Windows 보안 승인창을 화면 조작 도구가 대신 승인한다고 안내하지 않는다.

### [공통] 명칭·규칙의 편집과 보기

명칭과 짧은 운영 규칙의 편집 정본은 `public/ai-cowork.json`이다. 각 항목의 `scope`를 `common`(공통), `gpt`(지피티), `codex`(코덱스)로 지정하며 표시 기호는 **[공통] · [지피티] · [코덱스]**로 통일한다. 색만으로 구분하지 않는다. 기존 도구 이름·API 필드·불변 ID·slug·경로는 바꾸지 않는다. 긴 절차는 기존 스킬, 제품 사용법은 제품 정본, 개인 상태·백업은 소유자 비공개 기록이 맡는다.

트레이의 **AI 협업** 탭과 기존 PC·휴대폰 웹 제어의 **AI 협업** 탭은 같은 JSON에서 명칭·역할·공통/환경별 규칙을 읽는다. 검색·범위 필터는 표시만 바꾸며 실행이나 계정을 변경하지 않는다. 소스 작성·설치판 전달·실제 표시 상태는 제품 current에 따로 기록한다. 아래 전체 명칭표는 이 JSON의 읽기용 투영이며 직접 편집하지 않는다.

### [지피티] 구성자산을 스스로 개선·적용하는 범위

승인된 목표 안에서 현재 도구가 지원하는 소유 전역지침·프로젝트·스킬·플러그인은 지피티가 개선·실제 반영할 수 있다. 변경 전 정확한 계정/workspace/대상 ID·현재 내용·버전과 의존 참조를 읽고 기존 비공개 목적지에 필요한 원본/변경본을 백업한다. 기존 관리 도구로 변경하고 필수 저장 재조회를 채택하며 설치·활성·실제 호출은 별도다. 지원되지 않는 프로젝트 소스 회수, 타인/공용 자산, 원 보안 거절·불명 요청은 자가 개선 성공으로 넓혀 해석하지 않는다. 고정 제공판 기능 추가·설치와 사용자 인증이 필요한 구간은 해당 실제 소유자가 맡는다.

### [코덱스] 공통 계약 연결과 미지원 인수

코덱스는 같은 용어·분류·제품 진입점·인계 기준을 사용하고 전달본의 적용 상태와 지피티의 실제 기능을 구별한다. 지피티가 수행한 부분을 재사용하며 미지원·미해결만 잇는다. 설정이나 스킬에 규칙이 있다는 사실만으로 모든 제품 인수, 최적화 성과 또는 전체 AI 완료를 선언하지 않는다.

<!-- ai-cowork-glossary:start -->
| 범위 | 분류 | 명칭 | 뜻 |
|---|---|---|---|
| [공통] | 전체와 역할 | AICC 관리기 / 코덱스 관리기 / 지피티 관리기 | AICC 관리기 아래 관리 대상을 코덱스·지피티로 나눕니다. 관리기 이름은 실행 주체를 제한하지 않으며 현재 도구·권한과 실제 지원이 실행 범위를 정합니다. |
| [공통] | 전체와 역할 | AI 협업 환경 | 사용자·지피티·코덱스와 실행 도구·구성자산·제품 문서를 함께 운영하는 전체 환경. |
| [공통] | 전체와 역할 | 공통 운영 계약 | 역할, 작업 분류, 정본, 인계, 동시 작업, 보관과 완료 근거를 함께 지키는 규칙. |
| [공통] | 전체와 역할 | 사용자 | 목표와 제외 범위를 정하는 소유자. 전문 개발 지식이 없어도 이해할 쉬운 한국어로 결과부터 설명합니다. |
| [지피티] | 전체와 역할 | 지피티 / Web GPT / ChatGPT Web | 웹 ChatGPT 일반 Chat. extra high를 기본으로 하며 Work 모드는 사용하지 않습니다. |
| [코덱스] | 전체와 역할 | 코덱스 / Codex | 로컬 CLI·Desktop. 관제와 실제 도구 미지원·미해결 부분 및 필요한 서버·화면 작업을 잇습니다. |
| [공통] | 전체와 역할 | 메인 관제 / 제품 관제 / 작성자 | 메인은 목표·순서·충돌·회수를, 제품 관제는 담당 제품의 진행을, 작성자는 정확한 파일·데이터·배포 효과를 맡습니다. |
| [지피티] | 구성자산 | 지피티 구성자산 | 전역지침·스킬·플러그인(앱)·프로젝트(이름·지침·소스파일)의 묶음. |
| [코덱스] | 구성자산 | 코덱스 구성자산 | 전역지침·스킬·플러그인·config·프로젝트 문서와 폴더의 묶음. |
| [공통] | 구성자산 | 전역지침 / Instructions | 모든 작업에 필요한 짧고 안정된 사용자 특성·작업 원칙. 긴 절차나 실행 로그는 넣지 않습니다. |
| [공통] | 구성자산 | 스킬 / SKILL.md / 참조문서 | 반복 작업의 절차와 판단 기준. 필요한 본문·참조만 읽으며 설치 자체가 실행 권한을 주지는 않습니다. |
| [공통] | 구성자산 | 플러그인 / 앱 / 커넥터 | 도구·스킬·연결을 제공하는 묶음과 서비스 연결. 제품 UI의 원래 이름과 실제 권한 구분을 보존합니다. |
| [공통] | 구성자산 | 프로젝트 | 작업 목적별 공간. 지피티의 프로젝트 공간과 코덱스의 로컬 작업공간은 서로 다른 대상입니다. |
| [지피티] | 구성자산 | 프로젝트 이름 / 프로젝트 지침 / 소스파일 | ChatGPT 프로젝트의 표시 이름, 전용 지침, 첨부·소스 자료. 로컬 소스코드와 구분합니다. |
| [코덱스] | 구성자산 | AGENTS.md / config.toml | 코덱스 작업 지침과 실행 설정. 생성 AGENTS는 원본 fragment와 공식 배포기로 관리합니다. |
| [공통] | 실행과 연결 | AICC / AI Control Center | 기존 로컬 AI 운영·도구·설정·연결 관리 체계. 트레이와 웹 화면은 같은 실행 주체를 안내합니다. |
| [공통] | 실행과 연결 | AICC Workspace / Workspace MCP | 등록 작업폴더의 파일·명령·스킬을 실제 grant와 lease 안에서 다루는 연결. |
| [공통] | 실행과 연결 | MCP / 도구 / API | 호스트가 실제 노출한 실행 기능과 호출 계약. 문서나 스킬에 언급됐다는 이유만으로 사용할 수는 없습니다. |
| [공통] | 실행과 연결 | RDC / Remote Desktop Commander | 등록된 예비 도구 경로. 실제 제공 기능과 권한 안에서 사용하며 보안 거절의 우회 경로로 쓰지 않습니다. |
| [공통] | 실행과 연결 | 예비 AICC / 보조 경로 | 기존 독립 보조 연결. 읽기 전용이면 읽기만 지원하며 원 불명 요청을 자동 재전송하지 않습니다. |
| [코덱스] | 실행과 연결 | OCX / OpenCodex | 일반 코덱스 작업의 기존 모델 경로. 지피티 일반 Chat과 별도이며 자동 계정·경로 전환을 추정하지 않습니다. |
| [코덱스] | 실행과 연결 | Native / 네이티브 코덱스 | OCX를 거치지 않는 코덱스. 자기 OCX·AICC가 끊기는 정비·복구에 한정하고 정비 후 OCX로 돌아갑니다. |
| [코덱스] | 실행과 연결 | CLI / Desktop / resume | 명령줄 실행, 데스크톱 앱, 정확한 기존 대화 ID 재개. 승인된 대화형 독립 CLI 기본은 기존 OCX·모델과 -C 폴더 -a on-request -c approvals_reviewer=auto_review -s danger-full-access입니다. 실제 도구의 승인 설정과 보안 거절은 별도이며 never가 모두 허용을 뜻하지는 않습니다. |
| [지피티] | 실행과 연결 | 일반 Chat / extra high / Work | 지피티는 일반 Chat·extra high 기본. Work 금지. 사용 가능 모델과 현재 도구는 실제 화면·등록으로 판단합니다. |
| [공통] | 실행과 연결 | CUA / 컴퓨터 유즈 / CDP / 브라우저 슬롯 | 화면 조작, 브라우저 제어 연결, 등록 프로필 단위. 소유 탭·창을 분리하고 물리 포커스는 겹치지 않게 조정합니다. |
| [공통] | 실행과 연결 | 계정 / identity / workspace / provider / route | 로그인 신원, 서비스 공간, 모델 공급자, 실행 경로는 별개입니다. 계정 번호나 포트 순서로 실제 신원을 추정하지 않습니다. |
| [공통] | 실행과 연결 | 트레이 / 웹 제어 / 로컬·원격 | Windows 알림영역의 관리창과 PC·폰 공용 화면. 로컬 loopback과 승인된 원격 인증 경로를 구분합니다. |
| [공통] | 작업과 기록 | 정본 / source / 전달본 / consumer | 한 곳의 편집 원본과 이를 받아 쓰는 홈·설치판·원격 자산. 전달본만 고쳐 원본과 어긋나게 만들지 않습니다. |
| [공통] | 작업과 기록 | README / PROJECT / SPEC·PRODUCT / plan·tasks | 진입점, 현재·다음 행동, 요구·제품 계약, 실행 순서·할 일의 기존 문서. 같은 내용을 새 원장에 중복하지 않습니다. |
| [공통] | 작업과 기록 | 전역 / 제품 / 작업 / 운영 / 복구 | 공통 규칙은 전역, 제품 사용법은 제품 정본, 이번 변경은 작업 current, 실제 실행은 운영 기록, 되돌림은 복구 기록에 둡니다. |
| [공통] | 작업과 기록 | 대화 / 채팅 / thread / turn | 대화는 작업 기록 공간, turn은 그 안의 한 번의 요청·응답 실행입니다. 한 turn 완료가 전체 목표 완료는 아닙니다. |
| [공통] | 작업과 기록 | 원 요청 / exact ID·URL / operation / attempt | 무엇을 어느 대상에 몇 번째로 실행했는지 묶는 식별 정보. 불명 전송은 기존 operation부터 조정합니다. |
| [공통] | 작업과 기록 | Git root / 작성권 / lease / grant | 저장소 경계, 쓰기 담당, 임시 점유, 실제 허용 범위. 독립 폴더는 병렬, 같은 파일·데이터·배포 효과는 담당을 조정합니다. |
| [공통] | 작업과 기록 | queue / Claim / ACK / Observe / 부모 채택 | 큐 등록, 실행 점유, 전달 응답, 실제 새 turn 관측, 결과 채택의 서로 다른 단계. 접수·응답·전체 완료를 합치지 않습니다. |
| [공통] | 작업과 기록 | 인계 / 체크포인트 / cache·cursor | 담당·원 요청·정확 ID·현재·다음·불명을 남기고 이번 차이만 이어갑니다. 캐시가 현재 신원·권한 확인을 대신하지는 않습니다. |
| [공통] | 완료와 안전 | 작성 / 패키징 / 빌드 / 설치 / 배포 / 실제 작동 | 소스, 묶음, 실행파일 생성, 설치판 반영, 실행 환경 전달, 실제 사용 성공은 각각 따로 기록합니다. |
| [공통] | 완료와 안전 | 재조회 / readback / E2E / 검증 미실행 | 저장 후 실제 값 읽기, 사용자 흐름 전체 확인, 실행하지 않은 검사. 검사 범위는 현재 모델 정책과 사용자 명시 요청을 따릅니다. |
| [공통] | 완료와 안전 | HOLD / UNKNOWN / NOT_RUN / QUOTA_WAIT | 해제 조건이 있는 보류, 결과 불명, 미실행, 한도 대기. 정상 대기나 변화 없음은 반복 보고하지 않습니다. |
| [공통] | 완료와 안전 | 사전 원본 / preimage / SHA / revision·CAS | 변경 전 실제 내용과 정확 버전을 보존하고 다른 편집을 덮어쓰지 않는 조건. 개인 자산 백업은 기존 비공개 목적지를 사용합니다. |
| [공통] | 완료와 안전 | 보관 / 백업 / rollback / 최종 삭제 | 정리는 보관이 기본. 원본·작은 백업·dirty·로그인·진행/불명은 보존하며 최종 영구삭제는 사용자와 코덱스가 함께 합니다. |
| [공통] | 완료와 안전 | READY / drain·정상 중지 / active·unknown | 해당 작업의 신선한 복구 준비, 진행 작업을 보존한 종료, 활성·불명 수. 과거 준비 기록을 새 정비의 증거로 쓰지 않습니다. |
<!-- ai-cowork-glossary:end -->

### 사용자와 실행 환경

사용자는 전문 개발 지식이 적으므로 쉬운 한국어로 결론부터 결과·필요 근거·남은 일을 설명한다. 기존 좋은 지피티 지침의 보고 방식을 재사용하고 정상 대기/변화 없음을 반복 보고하지 않는다. 코덱스 토큰 사용을 줄이기 위해 지피티의 실제 도구 수행을 우선하며 절감률을 임의로 주장하지 않는다.

지피티는 **일반 Chat·extra high 기본, Work 모드 금지**다. 소유자가 등록한 계정·workspace의 기존 AICC Workspace로 파일 읽기·쓰기·명령·내부 도구/스킬·적용을 우선 수행한다. 대상 작업공간은 실제 등록/grant 안에서 선택한다. 웹 컨테이너는 사용자 PC가 아니며, 스킬 설치나 플러그인 표시로 없는 권한을 가정하지 않는다. 계정별 실제 로그인 identity·workspace·현재 capability는 소유자 비공개 설정에서 확인한다.

RDC와 예비 AICC는 실제 지원 범위가 확인된 예비경로다. 읽기 전용 연결은 읽기만 지원한다. 보안 거절을 다른 경로로 우회하거나 원 불명 요청을 재발신하지 않는다. 지피티에 CUA가 실제 제공되면 승인 범위에서 시도할 수 있으며 없으면 지원되는 도구 또는 코덱스로 인계한다.

코덱스는 관제와 도구 미지원·미해결·필요한 직접 로컬/화면 조작을 잇는다. 서버도 지피티의 실제 도구가 지원하면 문서화된 권한으로 우선 수행한다. AI 환경을 만드는 현재 단계는 코덱스가 통합 수행할 수 있다. 일반 코덱스는 OCX, Native는 자기 OCX/AICC 경로를 끊는 구간의 독립 정비·복구에 한정하고 이후 OCX로 복귀한다. 실제 실행·인계 절차는 codex-web-low-token-workflow가 소유한다.

### 제품을 지피티가 운영할 수 있게 개발하기

각 제품의 기존 README/AGENTS/PROJECT 중 시작 지점 하나가 기존 SPEC/PRODUCT·계획·현재와 실제 도구/CLI/API·서버 운영·권한·설정 이름·설치/실행/중지·저장/재열기·적용/복구 문서로 안내해야 한다. 호출 예제는 입력·출력·외부 효과·실패/불명 조정 조건까지 누적한다. 비밀 값은 문서에 넣지 않는다. 새 매뉴얼 묶음을 기계적으로 추가하지 않고 완료된 작업을 재사용하며 바뀐 부분만 읽는다.

지피티가 실제 권한 안에서 수행한 요청/응답과 코덱스 직접 실행을 구분한다. 소스 작성·설치·실제 작동·미실행을 각각 기록하며 사용자가 검증을 명시했을 때 그 범위의 실제 흐름을 확인한다. 이후 제품 개발은 중앙 current가 정한 단계의 완료 조건을 지킨다.

### 동시 작업·사용자 공존·보관

같은 Git root/파일·데이터·배포 효과에는 작성자와 발신 소유권을 조정한다. 브라우저는 소유 탭/창·프로필/lease로 분리하고 공식 도구/API·명령·비점유 브라우저를 우선한다. 한 물리 데스크톱의 입력/포커스 조작은 겹치지 않게 조정한다. 사용자가 Chrome/앱을 계속 사용해도 사용자 창을 닫거나 입력을 빼앗지 않는다. 탭/창 분리가 실제 OS 포커스 독립을 보장하는지는 구분한다.

시스템·디스크 전체를 지우는 치명적 명령을 쓰지 않는다. 불필요 확정 자료는 **보관**하고 최종 영구삭제는 사용자와 코덱스가 함께 한다. 원본·작은 백업·dirty·계정·로그인·서비스·진행/불명·복구 기록을 보존한다. 이미 참조되는 파일·설치본을 잔여물로 추정하지 않는다. 공개 코드/재사용 절차는 공개 GitHub, 개인 지침/계정별 설정/상태는 기존 비공개 저장소와 소유자 runtime 경계를 지킨다. 비밀·인증·브라우저 프로필은 GitHub에 올리지 않는다.
## 목표

목표는 토큰 수 자체를 최소화하는 것이 아니라 **자동 주입되는 내용마다 반복 가치와 행동
정확도를 최대화하는 것**이다. 모델이 이미 아는 일반론은 지침으로 복제하지 않고, 놓치면
복구 비용이 큰 프로젝트 고유 경계와 정본 라우팅만 항상 보인다.

이 문서가 지침 정합성·효율 관리의 정본이다. 상세 상태는 기존 `context/PROJECT.md`,
기계 목록은 owner-local `inventory/skill-catalog.json`과 `inventory/guidance-maintenance-state.json`에 둔다.

## 지식 배치 원칙

| Surface | 넣는 것 | 비용·경계 |
| --- | --- | --- |
| `AGENTS.md` | 모든 작업에 필요한 짧고 안정된 정본·안전 경계 | 매 작업에 주입되므로 가장 비싼 위치다. |
| `context/PROJECT.md` | 목적, 정본, 결정, 현재/HOLD, 다음 행동 | 세션 연속성만 유지하고 로그·원문은 넣지 않는다. |
| Skill | 반복되는 목표와 일반 모델이 모르는 판단 절차 | implicit 항목의 description만 항상 보이고 본문·reference는 선택 뒤 읽는다. 명시 전용 skill은 호출 전 비용이 없다. |
| Cold workflow·문서 | 드물지만 보존할 절차와 상세 설명 | 등록하지 않고 `aicc guidance find`나 문서 링크로 찾는다. |
| Config | 환경별 값, feature, 명시적 허용 목록 | 의미 판단과 긴 workflow를 넣지 않는다. |
| Plugin·MCP·connector | 실제 도구, 인증, 외부 시스템 연결 | 지침과 다르며 현재 host가 capability를 제공해야 쓸 수 있다. |
| Validator | 결정적인 budget, schema, manifest, hash, 중복 검사 | 모델 판단 대신 재현 가능한 실패만 자동화한다. |

같은 규칙은 한 정본에만 둔다. 상위 문서는 한 줄 설명과 링크만 유지한다.
전역 지침의 포함 조건·문장 형식·자동화 전환·검증 절차는
`guidance/directives/README.md`가 소유한다.

## 유지해야 할 결정

1. Codex가 기본 배포 대상이다. Claude는 필요할 때 같은 정본에서 명시적으로 생성·배포한다.
2. 전역 지침은 프로젝트 연속성처럼 모든 작업에 필요한 규칙만 가진다. 프로젝트 고유 안전
   경계는 기본 모델 지식과 비슷해 보여도 제거하지 않는다.
3. 기본 등록 skill은 반복 사용되고 trigger가 분명하며 누락 비용이 큰 진입점만 둔다. 드문
   workflow는 삭제하지 않고 cold source로 보존한다.
4. `high-risk-change`처럼 짧고 좁은 자동 계약은 인증·결제·보안·DB migration·infra·large
   refactor·multi-writer에만 trigger한다. 일반 작업을 지연시키는 범용 체크리스트로 넓히지 않는다.
5. Browser, Chrome, Computer Use와 Visualize는 역할이 다르다. 이름이 비슷하다는 이유만으로
   합치지 않는다. MCP transport도 exact tool surface·hook dependency·host ownership이 모두 같고
   제거 canary가 있을 때만 중복으로 판정한다.
6. 자주 쓰는 Notion은 curated plugin과 owner-local desired policy로 활성 상태를 유지한다.
   추천 plugin 자동 노출은 끄며 OAuth·권한·연결 상태는 plugin 설치와 별도로 확인한다.
7. Public AICC, private adapter, Native, Web GPT, OCX와 Claude의 source·runtime·auth·failure
   domain을 합치지 않는다. 최적화가 복구 경로를 하나로 수렴시키면 회귀다.

## 시행착오에서 확정한 사실

- **Skill은 MCP 대체물이 아니다.** Skill은 지침·reference·script를 제공할 뿐 도구, 인증,
  세션과 연결을 현재 대화에 추가하지 않는다. 제품의 공식 CLI/API가 같은 기능을 제공할 때만
  MCP를 retire할 수 있다.
- **비활성 capability는 현재 대화에서 쓸 수 있다고 가정하지 않는다.** 새 작업이나 격리
  프로세스도 시작 시 실제 도구 목록을 확인해야 한다. 하위 에이전트의 자동 상속을 추측하지 않는다.
- **설치와 활성은 다르다.** Plugin cache나 설치 폴더는 사용 가능성의 증거가 아니다.
  `codex plugin list --json`의 installed+enabled와 관련 feature를 함께 본다.
- **등록 skill도 공짜가 아니다.** implicit skill의 name·description은 선택 문맥에 참여한다.
  본문은 호출 뒤 적재되고 명시 전용 skill은 호출 전 노출이 없으므로 세 비용을 섞어 세지 않는다.
  trigger가 넓거나 일회성인 skill은 cold source가 낫다.
- **안전 경계 삭제는 최적화가 아니다.** 짧은 지침이 목적이어도 child Git 경계, destructive
  cleanup gate, public/private 분리, active-turn 보호와 직접 복구 경로는 남긴다.
- **working tree PASS는 commit PASS가 아니다.** 다른 dirty 파일이 누락 dependency를 가릴 수
  있으므로 exact-path stage 후 `git checkout-index` 같은 격리 snapshot에서 다시 검사한다.
- **생성 홈은 정본이 아니다.** home을 직접 고치면 다음 배포에서 유실되고 source와 drift한다.
  canonical source와 기존 배포기를 사용한다. plan/check·사후 검증은 현재 정책과 명시 요청이 허용하는 범위만 따른다.
- **Web GPT의 로컬 읽기는 실제 AICC capability로 판단한다.** 등록된 도구가 있으면 호스트 정본을 직접 읽고, 없으면 요청·필요 근거·출력 계약을 작은
  self-contained packet으로 보내고, 파일이 필요하면 실제 attachment chip을 확인하거나 제한된
  본문으로 제공한다. 같은 전달 실패를 반복하지 않으며 정본 반영과 실제 동작 근거는 호스트 담당이 현재 권한·정책 범위에서 구분한다.

## 기본 작업 절차

1. **관측**: 가장 가까운 지침, Git root·dirty state, 현재 skill/plugin/MCP/config와 실제 tool
   목록을 읽기 전용으로 확인한다.
2. **분류**: 새 내용을 prompt, `AGENTS.md`, project context, skill, cold doc, validator, config,
   plugin/MCP 중 하나의 정본에 배치한다.
3. **감량**: 기본 모델이 아는 설명, 중복 규칙, 과거 로그, 사용하지 않는 target과 trigger가
   겹치는 metadata를 제거한다. 기능을 제거했다면 복구·발견 경로가 남았는지 확인한다.
4. **배포**: `aicc guidance plan --target codex`의 exact 변경과 refused/prune 대상을 확인한 뒤
   기존 배포기를 사용한다. check는 현재 정책·명시 범위만 따르며 Claude는 명시 요청 없이는 배포하지 않는다.
5. **검증**: 현재 모델 정책과 명시 요청이 허용한 때만 변경 영역의 필요한 검사를 실행한다.
   commit·출시를 요청받았고 해당 변경이 포함될 때만 staged-tree를 검사한다. 문서 정리만을 위해
   stage·commit하거나 전체 OS 게이트를 반복하지 않는다.
6. **실측**: 정책과 명시 요청이 허용하면 새 코덱스 작업에서 실제 전역+nearest project 지침, 노출 skill metadata, 사용 가능한
   도구와 기능 회귀를 확인한다. 현재 작업의 snapshot으로 새 작업 결과를 대신하지 않는다.

## 측정 기준

다음 before/after가 있어야 최적화 완료를 주장할 수 있다.

- 자동 지침의 UTF-8 bytes·lines와 중복 문장 수
- canonical/registered/cold/deployed skill 수, implicit/explicit-only 수, implicit description
  budget, deferred entry bytes, trigger 충돌
- enabled plugin, user MCP transport와 노출 tool 수; 설치 cache 수와 구분
- fresh task의 실제 주입 지침과 capability 목록
- strict guidance, 배포 manifest/home 비교, targeted·staged-tree 테스트
- 기능 보존: Notion, Browser/Chrome/Computer Use/Visualize, Native/Web GPT/OCX 직접 경로

토큰 수 감소만 PASS로 삼지 않는다. 안전 경계 누락, 발견성 하락, capability 회귀 또는 실패 시
재시도 증가가 생기면 총비용은 오히려 커진다.

## 말투와 산출물 기준

- 결과를 먼저 말하고 필요한 근거만 붙인다.
- 계획·상태·결론을 반복하거나 당연한 모범 사례를 장식적으로 설명하지 않는다.
- 모델이 판단할 여지를 불필요한 금지 목록으로 소진하지 않는다.
- 사용자·프로젝트의 기존 어휘와 디자인 문법을 따르고, 근거 없는 유행어·과장·칭찬·범용
  AI 문체를 넣지 않는다.
- UNKNOWN과 HOLD를 PASS처럼 쓰지 않는다.

## 운영 명령과 복구

```bash
aicc guidance find '<workflow>'
aicc guidance plan --target codex
aicc guidance deploy --target codex
aicc guidance check --target codex
aicc task run codex.plugins.status --json
codex plugin list --json
```

Guidance 회귀는 변경 영수증의 exact 파일과 현재 hash를 비교해 해당 preimage 또는 자기 변경만 복원하고 같은 배포 절차로 배포한다. 이후 사용자 수정은 덮어쓰지 않는다. 자기 변경만 포함된 commit일 때만 commit revert를 사용한다. Plugin·feature 회귀는
owner-local desired policy와 지원 CLI의 현재 상태를 비교해 exact 대상만 되돌린다. Desktop
재시작은 active task가 없고 새 snapshot 로드가 실제로 필요할 때 별도 maintenance로 수행한다.

## 2026-09-06 실측 기준

- 공통 전역 지침 source는 8개 항목, 1,702 UTF-8 bytes다. 생성·배포된 `AGENTS.md`는 1,781 bytes이며
  source와 owner home의 SHA-256이 일치한다. Windows terminal 세부 규칙은 항상 적재하지 않고 전용
  `present-agent-terminal-status` skill에서만 읽는다.
- AICC canonical skill은 45개이며 Codex active/cold는 16/29다. active 가운데 implicit 14개,
  explicit-only 2개다. implicit description은 1,595자이고 active entry body는 합계 70,861 bytes지만
  호출 전에는 적재되지 않는다. 실제 숫자와 byte는 owner-local scanner 결과를 정본으로 하고 이 문장을
  영구 상수로 취급하지 않는다.
- 서로 다른 active skill 사이의 40자 이상 exact repeated instruction line은 0개다. 이 값은
  의미 중복의 부재를 증명하지 않으며 review 후보를 줄이는 기계적 신호로만 쓴다.
- 현재 MCP 세 개는 역할이 다르다. `aicc_workspace_windows`는 18개 read-only workspace 도구,
  `node_repl`은 Windows Computer Use와 stop hook의 runtime, `cua_repl`은 Browser/Chrome용 app-managed
  표면이다. 이름이나 기반 runtime이 겹친다는 이유만으로 끄지 않는다.

## 정본과 출처

- 배치·MCP/skill 경계: `guidance/skills/aicc-guidance-review/references/placement-rules.md`
- 전역 지침 작성·배포·복구: `guidance/directives/README.md`
- 배포 policy: `guidance/config/agent-catalog.toml`
- 현재 결정·HOLD: `context/PROJECT.md`
- 공식 source·검토일·권리 상태: `guidance/skills/aicc-guidance-review/references/absorption-ledger.json`
- 공식 근거: [GPT-6 Astra model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra),
  OpenAI Codex `AGENTS.md`·Skills·config reference와
  [Claude Code extension loading](https://code.claude.com/docs/en/features-overview). URL과 source별
  현재 checkpoint는 Knowledge Review와 absorption ledger가 소유한다.

## HOLD와 재검토

- AICC의 Notion validator는 설치·활성·feature만 확인한다. 실제 계정 연결과 source-system
  read/write 권한은 독립 canary가 필요하다.
- 모델·제공자·권한 기본값은 현재 사용자의 config와 실제 app-server readback이 소유한다.
  과거 문서의 모델 이름이나 관측값을 현재 설정으로 강제하지 않는다. 지침 감사는 모델·계정 경로를 바꾸지 않는다.
- 공식 문서 또는 Codex plugin/config 동작이 바뀌거나 Knowledge Review freshness가 stale/signalled가
  되면 exact affected source만 다시 확인한다.

## 지속 관리

전체 구성요소 원본·설치본·개인 상태의 분류는 `component-source-map.md`를 따른다.
지침·스킬 목록만으로 Codex·AICC 전체 구성요소가 반영됐다고 선언하지 않는다.
전체 구성요소 검사기 역시 요청 때만 실행하며 source 반영·설치·runtime·원격 게시를
각각 구분한다. 사용자 직접 원본인 모델별 정책·훅은 해당 home에서 유지한다.

- 2026-10-05 사용자 결정: 예약 점검과 자동 최신화는 하지 않는다. 기존 heartbeat `codex-2`는 PAUSED이며 사용자 요청 없이 재활성화하거나 대체 예약을 만들지 않는다. 점검은 사용자가 필요할 때 요청한 범위에서만 수행한다.
- 사람용 자산 정본은 Notion AI 자산의 `Codex` (`https://app.notion.com/p/00000000000000000000000000000000`)다. `Web GPT · ChatGPT 자산` (`https://app.notion.com/p/00000000000000000000000000000000`)과 계정·승인·실행 상태를 구분한다. 요청받은 변경에서 실제 바뀐 설정·지침·목록만 해당 자산에 반영하고 읽어 확인한다. 로컬 실행 원본·프로젝트 현재 상태는 각 소유 정본을 유지하며 비밀값·세션·대화 원문은 옮기지 않는다.
- 요청받은 점검에서 `tools/platform/inspect/inspect-guidance-maintenance.mjs`를 읽기 전용으로 실행한다. 달라진 파일의 검토·검사가 끝났을 때만 `--write-state`로 기준 hash를 갱신한다. 중단된 검토를 소비하지 않는다. 같은 파일과 결과의 재독·전체 스캔·검사를 반복하지 않는다.
- 공식 문서 확인과 목록 갱신도 해당 요청에 필요할 때만 수행한다. freshness 기한은 참고 정보이며 자동 실행 근거가 아니다. 프로젝트 지침은 catalog의 `instructionFiles`로 확인하고 필요한 경우 목록을 갱신한다. 실제 확인한 출처만 absorption ledger와 `--mark-reviewed --write-state`로 갱신하며 조회 실패를 최신화 완료로 표시하지 않는다.
- 스킬 본문과 참고 자료는 사용 시 읽는다. 모든 원문을 하나의 프롬프트로 합치거나, 긴 매뉴얼을 정상화했다는 이유로 매번 적재하지 않는다. 변경 파일의 positive·near-miss·충돌 사례로 의미를 확인한다.
- 같은 짧은 이름도 플러그인 namespace나 서로 다른 project scope가 있으면 독립이다. `|`·`>` YAML 소개를 실제 문장으로 집계한다. cache 존재·구형 기록·숫자 감소를 기능 검증으로 대신하지 않는다.
- 승인한 소유 범위의 가역적 문구 수정·중복 정리·Codex 배포는 자율 수행한다. 사용자 수정은 보존한다. 게시·모델·계정·권한·비용·서비스 재시작·플러그인 기능 제거로 감사를 확대하지 않는다. 제품이 관리하는 bundled skill·시스템 지침은 cache를 패치하지 않고 지원 설정과 상위 우선순위를 따른다.
- `blocked by policy`는 도구 단계의 관찰된 거부다. 자동 검토 에이전트의 결정이 실제 기록됐을 때만 자동 검토 거부로 분류한다. 승인 정책·격리 모드·Windows 관리자 권한·연결 앱의 승인·실행 도구 제한은 별개다.
- 의미 있는 새 충돌·수정·실패·필요한 사용자 행동만 알린다. 날짜와 수치는 관측 시점과 갱신 방법을 붙이며, 과거 표·HOLD를 현재 사실처럼 인용하지 않는다. 반복되는 장문의 상태는 기존 정본의 해당 섹션만 갱신한다.

### 플러그인 경로를 정리할 때

개인 marketplace의 root가 사용자 HOME이면 `./plugins/aicc-workspace-windows` 같은 상대경로는 그 root에 결속한다. checkout 위치로 잘못 해석해 원본을 이동하지 않는다. 설치 구성을 생성할 때는 기존 resolver와 소유 설정으로 Node 실행기, AICC source, owner config를 함께 받아 같은 marketplace root에 결속한다. 현재 확인한 resolver는 src/workspace-mcp.mjs의 workspaceMcpPaths·workspaceMcpCommand·configureLocalWorkspaceMcp, src/runtime-layout.mjs→private-home.mjs 및 guidance-root.mjs다. 개인 plugin의 .mcp.json과 사용자 node_repl 설정의 원 생성기는 제한 조사에서 발견하지 못했으며 그 부분의 자동 생성·활성 적용은 미해결이다. 개인 실행기 버전이나 checkout 절대경로는 공개 기본값으로 넣지 않는다. 생성 소스 개선, 새 설치 구성 준비, 활성 runtime 전환은 서로 다른 단계다.

공급자 AppData/Codex runtime와 node_repl·notify/env의 cache는 공급자가 소유한다. 이 경로를 개인 source로 옮기거나 직접 고쳐 경로 문제를 숨기지 않는다. 기존 plugin 원본과 설치 영수증·rollback을 보존하고 활성 연결 전환은 해당 manager의 지원 절차로만 수행한다.
2026-10-17 후속 생성기 경계: 기대했던 owner .codex/plugins/aicc-workspace-windows 경로는 현재 부재이고, 읽은 config 상단에는 personal marketplace가 없다. 기존 node_repl은 공급자 AppData runtime와 browser-service를 참조한다. 제한된 canonical/private scripts 및 owner normalization 조사에서 원 producer는 미확정이다. 경로 부재만으로 구판 plugin을 재생성하거나 현재 공급자 설정을 다른 곳으로 이동하지 않는다. 원 생성기/현재 설치 영수증·marketplace owner가 확인되면 위 기존 resolver에 결속하며, 현재 source/활성 config/cache 변경은 하지 않았다.

개인설정 생성 후속: 기존 workspace manager의 `prepare-client-config --surface PROFILE`에 owner bindings 기반 후보 생성 경로를 구현했다. 기존 local-stdio resolver/config를 재사용하고 marketplace root/상대 plugin 경로는 명시 입력으로만 결속한다. node_repl은 기본 보존, 명시 설정은 별도 TOML 후보이며 supplier cache/runtime을 쓰지 않는다. source 구현 완료·검증/후보생성/설치 미실행이다. 현재 등록 목록에서 AICC 개인 plugin은 관측되지 않아 실제 적용만 exact target/installer owner/rollback 영수증과 공급자 runtime 재결속 담당 식별까지 HOLD다. 원 생성기의 전역 부재를 증명한 것으로 해석하지 않는다. 상세 입력/출력은 docs/operations/aicc-runtime-handbook/04-workspace-mcp-and-chatgpt-apps.md에 있다.

## 기록 통합과 대화 보관

현재 상태는 기존 PROJECT의 해당 절을 교체하고 과거 실행 이력은 기존 journal·역사 링크로 찾는다. 중앙 통합 문서는 여러 프로젝트의 업무 지도와 결과 위치만 소유하며 앱별 상태 원장을 대체하지 않는다. 새 산출물은 쓰기 전에 기존 소유 위치·소비자·수명을 정한다.

전체 대화 종합·인수 반납·중복 문서 정리의 절차는 [control-project-work 기록 수명과 통합](../guidance/skills/control-project-work/references/control-contract.md#기록-수명과-통합) 한 곳에 둔다. 이미 배포한 내용, 실행 중 서비스와 불명 전송을 문서 정리만으로 완료·재실행·삭제하지 않는다.

## 개발 준비와 파일 수명주기

새 개발·큰 변경의 준비는 기존 develop-from-project-spec가 소유한다. 최소 문서·의존 순서·첫 결과·파일 담당·완료 기준을 현재 프로젝트에 연결하고, 파일 정리의 상세는 해당 references/file-lifecycle.md를 읽는다. 제품 계약과 현재/실행 근거를 같은 문서에 섞거나 중앙에 전부 복제하지 않는다. 작은 수정에 전체 문서 묶음·타임라인·새 도구를 의무화하지 않는다. 사용자 요청이 준비까지만이면 제품 구현은 시작하지 않는다.

ChatGPT 입력/저장 구조의 재사용 교훈은 기존 web-gpt-driving/references/failure-solutions.md가 소유하며 use-web-gpt는 링크만 유지한다. 마지막 source 작성·홈/원격 전달·설치·실제 호출을 별도 기록한다.

### 대화형 Codex 승인 기본 정정 · 2026-10-24

사용자가 자동 검토를 기본으로 선택했다. 대화형 CLI·Desktop은 approval_policy=on-request, approvals_reviewer=auto_review를 사용한다. 연결 앱 기본 reviewer도 같은 선택을 따르며 앱/도구별 필수 승인은 별개다. 기존 실행 예시의 고정 -a never는 현재 기본값이 아니다. 승인 화면이 없는 비대화형 exec/continuity/격리 Workspace provider의 never는 별도 계약이며 대화형 세션의 자동 검토 성공으로 해석하지 않는다.

never는 승인 요청을 금지하며, Codex의 Windows 위험 명령 판별에 걸리면 Full Access에서도 실행 전에 거절될 수 있다. rejected: blocked by policy만으로 자동 검토자 거부·소유권 부재·관리자 권한 부재를 단정하지 않는다. 실제 검토 기록, 유효 승인 설정, 공식 판별 조건을 구분한다. 일반 작업은 기존 승인 범위에서 계속하며, 무조건 허용하는 reviewer 정책이나 보호 해제를 추가하지 않는다. 설정 작성·배포와 실행 중 대화의 정책 반영·실사용은 별도 상태다.

공식 설정: https://learn.chatgpt.com/docs/config-file/config-reference
공식 자동 검토: https://learn.chatgpt.com/docs/sandboxing/auto-review

### 기존1그룹 명령 단순화 · command-route-r2

일반 명령은 공식 codex 하나와 공유 HOME이다. 목표 base는 OCX10100이며 model/추론/승인/reviewer/sandbox/personality/skills/plugins를 상속한다. 공식0.165 V2 native.config.toml/aicc-webgpt.config.toml만 명시 -p로 opt-in하고 새 깨끗한 HOME을 강제하지 않는다. ocx는 서비스 관리, aicc codex ocx는 명시 계정/admission·진단 호환만 맡는다. 원래 명시6.1/high는 지원되며 미지정 model/catalog의 낡은 강제만 제거한다.

공식 command-backed auth는 기존 등록 credential을 private stdout pipe로 전달하고 config에 secret을 쓰지 않는다. 실제 OCX catalog의 단일 private owner, 별도 Web catalog, caller/트레이/GPT global/project instructions·skills/plugin 설명과 정상 배포 의존은 [기존 CLI 제품 runbook](runbooks/workspace-codex-cli.md#command-route-r2-적용-준비와-정확-owner-의존)이 소유한다. source·HOME 적용·설치·daemon/Desktop effective route·실제 call·전체완료는 각각 별개다. 현재 source만 작성했고 실제 설정·설치·runtime·GPT 자산 변경은0이다.
