# 구성요소 원본과 반영 기준

이 지도는 Codex, AICC, Web GPT의 모든 구성요소를 원본·설치본·개인 상태로
구분하는 기준이다. 각 소유 원본은 유지하며 Notion AI 자산에는 자산 지도와
재사용 지침을 둔다. 전체 점검과 목록 갱신은 사용자가 요청했을 때만 한다.
예약 점검·자동 최신화·대체 예약은 만들지 않는다.

## 제품과 소유권

| 구성요소 | 수정할 원본 | 설치본·상태와 반영 방법 |
| --- | --- | --- |
| Codex Desktop·CLI·App Server·터미널 도구 | 공급자의 배포·공식 소스 | 설치 실행 파일·패키지는 설치본이다. 현재 작업 중 재시작하지 않고 승인된 업데이트 절차를 사용한다. |
| Codex 설정·사용자 모델 정책·사용자 규칙 | 사용자 Codex home의 config·policies·rules | 사용자 소유 원본이다. 인증과 세션은 분리하며 원문 설정을 공개 저장소에 옮기지 않는다. |
| Codex 훅 | hooks 등록과 실제 호출된 스크립트 | AICC notification hook은 tools/platform/codex 원본, 사용자 model policy hook은 사용자 home 원본이다. |
| Codex agent | guidance/agents/codex | home agents는 manifest 소유 생성본이다. 사용자 비관리형 역할은 사용자 원본을 유지한다. |
| 전역 지침 | guidance/directives/fragments, guidance/directives/README.md | generated와 home AGENTS는 생성·배포본이다. |
| 관리형 스킬 | guidance/skills, guidance/config/agent-catalog.toml | 활성 home 스킬은 deploy-only다. cold 스킬·참고 문서·스크립트도 원본 목록에 포함한다. |
| 사용자·프로젝트 스킬 | 사용자 소유 스킬 또는 프로젝트 저장소 | 시스템·플러그인 스킬과 소유권을 혼동하지 않는다. |
| 플러그인·MCP·connector | 공급자 패키지, plugins, 실제 서버 원본과 사용자 연결 설정 | 설치 캐시 직접 수정은 원본 반영이 아니다. 인증 성공은 파일 존재와 별도다. |
| Codex 메모리·세션·SQLite·로그·대화·첨부·잠금 | 사용자·공급자 상태 저장소 | 운영 데이터다. 소스나 Notion 본문으로 복제하지 않고 위치·소유권·복구 경계만 기록한다. |
| Codex 자동화·복구·관리자 실행 helper | 해당 사용자 소유 원본과 AICC 관리 도구 | 예약 여부는 사용자 지시를 따른다. 기존 다른 업무 자동화는 이 목록 정리만으로 변경하지 않는다. |
| AICC CLI·control API·대시보드·TUI | bin, src, public | 배포 CLI·서비스는 해당 릴리스 설치본이다. |
| job·attempt·checkpoint·artifact·lease·outbox | src/jobs, src/goals, src/orchestration 및 관련 contracts | 개인 jobs·artifacts·control-plane 원장과 소스는 다르다. |
| Workspace MCP·gateway·snapshot·app lifecycle | components/workspace-mcp, components/remote-gateway, src/workspace*, tools/platform/workspace-mcp | workspace registry·Tunnel profile·인증·lease는 개인 상태다. 클라우드 앱 schema 게시와 로컬 설치는 별도다. |
| Account Manager·OCX adapter | components/account-manager, src/adapters, tools/platform/ocx, tools/platform/opencodex | upstream OCX와 A1 계정 허브는 별도 소유다. 공개 코드에 계정·토큰을 복제하지 않는다. |
| Web GPT adapter·browser broker·압축·callback | src/adapters 및 각 Web GPT public/private 저장소 | Web GPT 제품 자산으로 구분한다. Codex 승인·모델·계정을 전달된 것으로 간주하지 않는다. |
| 브라우저·CDP·확장·target lease·Computer Use | src/browser, extensions, tools/platform/web-automation, tools/platform/windows | 등록 런처·브라우저 프로필·인증·lease·외부 도구는 각각 소유한다. |
| Slack·Telegram·사용자 개입·알림 callback | src/notifications, tools/platform/slack, tools/platform/telegram 및 관련 src | 채널·키·메시지 원문은 개인 상태다. 실제 알림 전송은 현재 요청의 권한을 따른다. |
| 프로젝트·포트폴리오·자산·지식·동기화·API 사용량 | 해당 src 모듈·tools/platform·contracts | Notion DB와 개인 state의 현재값을 별도 소스로 복제하지 않는다. |
| 설치·업데이트·호환성·service·복구·배포 | install.ps1, install.sh, scripts, tools, compatibility | 공급자 원본과 AICC adapter를 구분하고 component-only 복구한다. |
| 문서·제품 설계·schema·검사·공급망 | docs, specs, contracts, test, guidance, package manifest, .github, vendor provenance | 상위 설명은 원본 링크만 유지한다. Git·의존성·빌드 캐시를 원본으로 분류하지 않는다. |

표는 역할 지도다. 실제 전체 파일 목록과 발견한 top-level 항목은 수동 원본 검사기의
owner-local inventory에서 확인한다. 표에 아직 없는 새 디렉터리도 목록에서 숨기지 않는다.

## 전체 반영의 의미와 확인

1. 발견한 모든 구성요소에 소유자·원본·생성/설치본·개인 상태 분류가 있어야 한다.
2. 요청된 변경은 소유 원본에 먼저 반영한다. 생성본만 수정한 상태로 완료하지 않는다.
3. AICC 관리형 스킬·agent·directive는 source와 delivery를 대조한다.
4. 실행 코드의 설치·runtime·클라우드 게시가 별도로 남으면 남은 단계로 표시한다.
   소스 파일 hash 일치만으로 전체 기능 정상·원격 게시 완료를 선언하지 않는다.
5. Codex 공급자 바이너리·시스템 정책·외부 MCP 원본이 로컬에 없으면 외부 소유로 명시한다.
   제공되지 않은 코드를 모두 수정·복제했다고 주장하지 않는다.
6. 원본 경로·파일 목록·hash만으로 원본 위치를 찾을 수 있게 한다. 인증·세션·대화 원문·로그는
   복제하지 않는다. 설치본을 공개 원본에 역복사하지 않는다.

## 수동 목록 갱신

`tools/platform/inspect/inspect-component-sources.mjs`는 Git source 목록과 Codex home의
구성요소 경계를 기록한다. 경로·크기·hash·source ownership만 저장하며 설정 원문은 저장하지
않는다. 기본은 요약 출력이며 `--output`을 명시했을 때만 owner-local 목록을 쓴다.
Git submodule은 포인터와 공급자 출처로 관리하고 의존성·Git·cache를 재귀 탐색하지 않는다.

Notion AI 자산의 Codex, AICC, Web GPT 입구에서 필요한 항목만 찾아 읽는다. 전체 목록을
매 작업 시작 시 로드하지 않는다. 해당 요청에서 바뀐 목록·설명만 갱신하며 날짜가 지났다는
이유로 점검하지 않는다.
