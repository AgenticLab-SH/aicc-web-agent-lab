# open-AICC information architecture

## 전체 현황 진입 · 2026-11-20

`/mobile.html#overview` → 전체 현황·내 앱·AI 보고·지시/목표·설정.
전체 현황은 목적/현재/확인 결과/잔여/다음 행동 순서이며 처음·제품·이력·근거는 상세로
펼친다. 작업 편집은 전체 현황의 바로가기, 계정·도구·협업·웹·관리기는 설정에서 찾는다.
기존 hash·뒤로가기·인증·큐/편집 동작을 보존한다. 검색·활성/전체/대기 필터, 로딩·빈값·
미연결·자료미등록·오래됨·조회실패/마지막화면보존·복구를 구분한다.

## G3 세 주 메뉴

- `#ai-reports`: 등록 보고→고정 양식→핀/근거/다음 지시. 완료함·보관함에서도 소유 원본을 남긴다.
- `#ai-work`: 등록 그룹→프로젝트→기능→설명/이동/추가/정렬/보관/복원→미리보기→일회용 저장.
- `#ai-queue`: exact 대상→기존 큐의 접수/새 turn 근거→미전송 지시 저장/순서 변경. 전달 시작 항목은 잠근다. 추적 목표와 Codex goal을 구분한다.

선택은 URL query `agent`/`work`, 메뉴는 fragment가 소유한다. 새로고침·뒤로가기는 같은 선택을 읽는다. PC·폰은 같은 서버 원장·인증/API를 사용한다. 운영/설정에서 기존 트레이·계정·기기·도움말을 찾고 주 메뉴로 돌아온다. 폰의 목록/상세는 한 열이다.

조회 실패는 마지막 관측을 유지한다. 확인 응답 유실은 confirmation hash로 원 영수증을 조회하며 재전송하지 않는다.

이 문서는 경로, 상태 소유권, 모바일 읽기 순서를 정의한다.

## Core route

`#home` owns the daily operating job. Its shortest path is:

`Master goals → Projects → independent survival routes → Attention → safe repair order → current evidence → manual reviews`

`#goals` reads the owner-local canonical master-goals JSON and joins only personal review checks from a separate dashboard state file. Search, status filter, and deterministic sorting are view state. A checkbox never changes `ACTIVE`, `HOLD`, `REVIEW_READY`, `USER_MANAGED_READY`, `COMPLETE`, or `UNASSIGNED`.

The survival ledger exposes Integrated 17841, direct 17842, OCX 10100, and Native separately. Each row keeps configured source, installed runtime, live health, exact active gate, browser/harness readiness, and acceptance evidence distinct.

The safe repair order is read-only. It shows the global Codex ACTIVE/UNKNOWN gate, exactly one eligible preflight stage, and that stage's backup, success, and stop conditions. It never dispatches a repair, account action, browser action, or publication action.

## Recovery route

`#troubleshoot` owns component recovery. The return path after any failure is the same read-only status ledger. UNKNOWN disables mutation and preserves the user's place. `aicc restore` is the cwd-independent emergency command; route-specific controls remain previewed and one-shot.

Its entry order is `latest sealed recovery → independent route controls → read-only diagnostics → support bundle`. The latest recovery API never lists arbitrary scripts or paths. It exposes only availability, typed state, component, update time, and ACTIVE/UNKNOWN counts; private script and backup paths remain owner-only.

## Secondary routes

- `#projects`: local/Notion catalog and drift.
- `#activity`: jobs, writers, agents, browser leases, and artifacts.
- `#workspace`: Business and Personal source/installed/runtime/browser-visible/publication evidence.
- `#monitoring`: update signals without automatic apply, plus owner-local Web GPT continuation settings. The latter fixes the target to the existing `GPT` group and seven conversations; AICC stores cadence, stalled threshold, enabled state, and continuation messages. Codex heartbeat owns browser observation and action. The page does not claim scheduler health it cannot read.
- `#system`, `#architecture`, `#tools`: expert detail after operational surfaces.

Hash navigation is the URL state. Refresh and copied deep links return to the same section. Mobile keeps the same reading order and uses the menu only as a shortcut.
