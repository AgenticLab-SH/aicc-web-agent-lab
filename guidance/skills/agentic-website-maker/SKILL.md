---
name: agentic-website-maker
description: AgenticFabWorks 사이트의 호스팅·도메인·검색·사업 gate 배포. 로컬 UI·브라우저 QA 제외.
---

# Agentic Website Maker

AgenticFabWorks 사이트의 공개 경계와 실제 release만 소유한다. 로컬 UI 구현은
`codex-frontend`, 실행 후 화면 검증은 `browser-qa`에 맡긴다.

## 필요한 것만 읽기

- publish, provider/domain/DNS 변경, release 기록에는
  [release contract](references/release-contract.md)를 읽는다.
- 모델·crawler 가시성, login gate, indexability에는
  [AI-readable web](references/ai-readable-web.md)를 읽는다.
- AgenticFabWorks의 시각 방향을 크게 바꾸는 요청에만
  [design system](references/design-system.md)과 필요 시
  [pattern library](references/pattern-library.md)를 읽는다.
- profile·registry·검증 작업은 `scripts/site_ops.py --help`의 지원 명령을 사용한다.

## Release 흐름

신규 웹·정식 출시·운영 설정 변경은 중앙 `C:/demo/projects/web/workspace/docs/WEB_STRUCTURE.md`
8절을 먼저 읽는다. 이는 등록→검증→배포→검색→허용된 분석/수익화의 정본이다.
중앙 원장은 모든 프로젝트에 필요하지만, 외부 등록/색인/광고는 제품·경로별 적용 이유가 필요하다.
해당 workspace가 다른 위치면 기존 registry의 documentation 경로에서 같은 정본을 찾고 복제하지 않는다.

1. 가장 가까운 프로젝트 문서, source-root `.openai/hosting.json`,
   `.openai/website-profile.json`, 중앙 website 설정·registry와 현재 Git 상태를 확인한다.
   기록된 provider, account, project ID, domain, data mode를 재사용한다.
   중앙 `web-launch.mjs plan --site <등록 key>`를 여기서 실행하여 등록·공개 범위·provider 충돌을
   외부 변경 전에 확인한다. 충돌이 대상과 무관한 다른 제품의 것이라면 전체 완료는 HOLD로
   유지하되, 별도로 검증한 대상의 기존 복구 계약 내 작업까지 무조건 중단하지 않는다.
2. 사용자 요청이 UI 구현까지 포함하면 기존 stack을 보존해 `codex-frontend`로 구현하고
   관련 build·test를 통과시킨다. 실제 데이터 요청을 mock이나 생성 데이터로 바꾸지 않는다.
3. 정확히 검증한 source에서 allowlisted production output을 만든다. 비밀, repo history,
   내부 문서·도구, 테스트, 로컬 설정, source map과 무관한 파일은 공개하지 않는다.
4. 현재 provider·account·zone·domain 상태를 읽어 확인한 뒤 요청 범위만 변경한다.
   provider, 계정, region, repository, 유료 plan을 조용히 바꾸거나 새로 만들지 않는다.
5. 정상 hostname에서 DNS, TLS, provider 상태, critical flow와 관련 console/network 오류를
   확인한다. login이 필요 없으면 Browser, 기존 로그인 상태가 꼭 필요하면 Chrome을 쓴다.
6. 성공한 실제 상태만 `site_ops.py record`와 기존 release/handoff 문서에 기록한다.
   실패하거나 미확인인 값을 완료 상태로 저장하지 않는다.
7. 중앙 `web-launch.mjs audit`를 대상 key로 실행한다(명령은 매뉴얼 8절).
   새 서비스·공개 경로·provider가 정책에 없거나 source와 live가 충돌하면 먼저 해소한다.
   `use-ops-bookmarks`로 기존 계정의 GSC·Naver·분석·AdSense 중 적용되는 콘솔만 확인한다.
   이미 성공한 sitemap 제출·기존 AdSense 신청은 반복하지 않는다. 공개 noindex·광고/추적 없음과
   로컬·보호 앱을 등록 편의를 위해 변경하지 않는다. 원격 source·공개 결과·소유확인·제출·색인·심사·게재를
   각각 구분하고 실제 확인된 단계만 완료라고 보고한다.

발견할 수 없고 비용·데이터 권리·공개 목적지를 바꾸는 결정만 묻는다. 최종 보고에는
primary URL, 보존한 alias, provider/data mode, 검증 결과와 미확인만 남긴다.
