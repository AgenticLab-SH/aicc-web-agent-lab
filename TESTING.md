# open-AICC dashboard verification

## 전체 현황 · 2026-11-20

`node --test test/portfolio-overview.test.mjs test/mobile-control.test.mjs`:
정본 변경/손상·중복 그룹·비공개 내용 투영 방지·기존 인증/정적 scope·무변경 확인.
Chrome 320/360/768/1280·200% 글자·키보드·상세/검색/빈값·기존 메뉴/뒤로가기·
조회 실패 마지막 목록/복구·오래됨 안내·콘솔 확인. 기존 Windows 게이트 뒤
정식 prepare/독립READY/정상drain/Task CAS/설치판·HTTPS readback을 수행한다.
물리 폰 확인과 과거 설치 근거를 분리한다. 결과는 owner-local 중앙 execution에 연결한다.

## Installed behavior acceptance

Implementation results distinguish source checks, actual installation, running target/version/hash readback, relevant tests and observed user flows. Source tests or a prepared package alone do not establish installed behavior. Reuse unchanged verified artifacts; record NOT_RUN, remaining failures, exact unblock owner and rollback references for incomplete branches. Installation/restart tests preserve active work and uncertain requests and use the supported owner/recovery/idle gates. Test scope does not authorize external publication, financial trades, new permissions or replay of an uncertain delivery.

## G3 AI 통합 대시보드

가까운 검사: `node --test test/dashboard-workspace.test.mjs test/mobile-control.test.mjs test/dashboard-homepage.test.mjs test/server.test.mjs`. 임시 owner 원장에서 9그룹 투영, 편집/이동/보관/복원, revision 충돌, 단일 writer, 중복 operation, 완료 숨김 방지, 미전송 2개 저장/정렬/재접속, UNKNOWN 잠금, HTTP 인증/CSRF/일회용 확인/응답 유실 조회를 확인한다. 실제 제품 지시·모델 발신은 없다.

현재 합성 종단은 **HTTP 저장 종단**이다. 실제 2개 지시 실행/회수·자동 다음 실행과 구분한다. OS 게이트는 `npm run verify:windows`이며 기존 dirty의 실패와 구분한다.

실화면 인수: 1440/390px, 320px 재배치·200% 확대, 긴 한영/UUID, 빈 목록/로딩/오류/offline, 키보드·터치 정렬, dialog 포커스/복귀, 뒤로가기/재접속, console/network, PWA 설치, Android APK와 PC↔폰 동기화. Aside 미기동·CUA browser host 부재로 렌더 NOT_RUN, 실기기 미확인이다. 테스트 통과로 대체하지 않는다.

검증은 빌드, 브라우저, 오류·부분 실패 상태를 서로 분리한다.

## Deterministic gates

```powershell
npm test -- --test-name-pattern='dashboard|Web GPT'
npm run test:distribution
npm run verify:windows -- --DryRun
```

```bash
npm test -- --test-name-pattern='dashboard|Web GPT'
npm run test:distribution
npm run verify:mac
```

The Windows dry-run validates the exact command plan without starting the full suite. Before publication, run `npm run verify:windows` without `--DryRun`. Also run the repository's server, status, action, and workspace app focused tests before runtime apply.

## Browser matrix

Verify the shipped local dashboard at 320, 390, 768, and 1440 CSS px. Exercise initial loading, empty data, partial region failure, offline 17841, global ACTIVE, lifecycle UNKNOWN, exact idle, out-of-order evidence, UNCERTAIN reconcile-only, publication HOLD, and success. The repair sequence must expose no action control, no stage when the gate is blocked, and exactly one read-only preflight when exact idle. Check refresh/deep links, keyboard order, visible focus, dialogs and focus return, 200% zoom, reduced motion, console, network, and horizontal overflow.

## Evidence levels

Record source complete, installed complete, runtime verified, browser-visible verified, publication verified, and callback verified separately. A passing unit test does not satisfy the browser or deployed-runtime gate.

## Recovery GUI matrix

Run `npm run check:recovery-gui` and `npm run test:recovery-gui`. Fixtures must cover missing/tampered pointers, ACTIVE, UNKNOWN, exact idle, status HOLD, dry-run HOLD, successful one-use dispatch, applied replay denial, and ambiguous dispatch denial. Browser acceptance must confirm that the button is visible and keyboard reachable, disabled outside exact readiness, opens the standard preview, and never reveals owner paths or silently changes another failure domain.

## Web GPT monitor settings

Run `node --test test/web-jjonku-monitor-config.test.mjs test/web-jjonku-monitor-server.test.mjs test/web-jjonku-monitor-ui.test.mjs`. Cover default read, migration from the former GPT seven-tab config without losing its values, valid save/readback, invalid cadence/threshold/message bounds, storage failure preserving old state, loopback/same-origin writes, exactly seven unique tab IDs in the `GPT` Chrome group, anchor membership HOLD, scheduler-state qualification, and 320/390/768/1440px browser reflow. After saving in AICC, read the same owner-local config from the deployed Codex skill and verify its effective cadence and message values.
