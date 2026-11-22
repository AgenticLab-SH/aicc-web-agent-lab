---
name: manage-upstream-assets
description: 등록된 오픈소스·Git upstream·OCX/Codex·크롤러 소스의 버전·업데이트를 조정한다. 자동 설치·활성 경로 전환 금지.
---

# 오픈소스·크롤러·버전 통합 관리

목적은 **기존 정본을 연결**하는 것이다. 새 병렬 업데이트 데몬이나 중복 소스 원장은 만들지 않는다.

## 시작

1. `docs/agent-operations.md`, 현재 Git branch/dirty 및 `context/PROJECT.md`의 해당 변경만 확인한다. 다른 agent가 같은 경로를 작업 중이면 HOLD한다.
2. 읽기 전용 전체 목록: `python guidance/skills/manage-upstream-assets/scripts/inventory.py --json`. 검증된 owner-local 집계 저장이 필요할 때만 `--write`를 지정한다.
3. 결과의 `coverage` 및 `unknown`을 읽는다. **등록된 프로젝트 범위만 조회**했으므로 미등록 PC 전체 또는 모든 크롤러를 조사했다고 주장하지 않는다.
4. 외부 최신 버전 확인은 기존 AICC의 `src/upstream-monitor.mjs`, `docs/upstream-updates.md` 및 `guidance/monitoring.json`을 사용한다. `aicc task run routes.status --json`으로 실제 경로를 조회한다. 조회 결과만으로 설치나 갱신을 실행하지 않는다.
5. 공식 문서 크롤링 변경은 `review-agent-platform-updates`와 `src/knowledge-review/policy.mjs`를 사용한다. 그 외 외부 Git 참조·라이선스는 `docs/source-provenance.md`와 `guidance/skills/aicc-guidance-review/references/absorption-ledger.json`에서 확인한다.

## 버전 판단

- 버전/상태를 **PATH CLI**, 실행 서비스, 공식 upstream, pin/lock, A1 허브로 구분한다. `ocx --version`이 2.77이고 `10100/readyz`가 2.81이어도 실행 서버를 CLI 버전으로 덮어쓰지 않는다.
- 10100/10101은 로컬 OCX, 10102는 A1 허브 SSH 터널, 17841은 Web GPT 라우터. `10100/`은 허브 페어링을 요구할 수 있고 계정관리 정본은 10102다.
- OCX는 소스가 요구하는 검증된 전용 Bun을 유지한다. 트레이 WinForms + Node 수집기, Windows PowerShell/작업 스케줄러, 다른 런타임을 **일괄 Bun으로 통일하지 않는다**.
- 각 component의 `설치됨 / 최신 발견 / 호환성 검증 / 적용됨 / 실제 동작`은 서로 다른 상태다. 변경 후보의 license, API/CLI 계약, 계정 소유자, 실행 포트, policy·로그, 사용자 작업 영향, rollback을 확인한다.

## 실제 업데이트 게이트

1. 사용자가 적용까지 요청했으면 component별로 exact target/owner를 정한다. `high-risk-change`, `codex-rescue-preflight` 및 `manage-codex-model-routes` 중 해당하는 기존 스킬을 참조한다.
2. 현재 사용자 작업 및 Web GPT/OCX active-turn이 정확히 0임을 확인한다. UNKNOWN은 HOLD다. Native Codex/SSH/웹 경로를 서로 대신 쓰지 않는다.
3. 공식 원문+checksum/pin 및 staged release, 기존 프로필·인증과 분리된 shadow/canary 테스트, rollback reference를 확보한다. 중요한 프로토콜 변경이 있으면 별도 검토하고 **한 번에 모든 앱을 업데이트하지 않는다**.
4. 기존 적용기 `UpdateCoordinator`와 각 서비스별 승인된 updater만 사용한다. 변경 후 실제 UI·CLI·health/ready·model canary·재부팅 자동시작 여부를 검증하고 미실측은 명확히 남긴다.
5. 다른 Git dirty/staged 변경을 보존하고 본인 파일만 커밋/푸시한다. GitHub 원격 SHA 검증 뒤 운영 정본 문서와 Notion의 원본 링크·적용 상태를 갱신한다.

## Windows Codex/OCX 안정판 업데이트 도우미

- Windows 시작 메뉴와 바탕화면의 `AICC Codex OCX Stable Update`에서 `tools/platform/updates/Invoke-AiccCodexOcxStableUpdater.ps1`을 연다. 등록된 PowerShell 7로 실행하며 메뉴 1은 설치 버전·공식 npm latest·17841/10100/10101을 표시한다. 메뉴 4는 두 최신판의 다운로드와 무결성 검사를 한 번에 준비한다.
- `-Action Status`는 읽기 전용이다. `-Action PrepareCodex`는 `@openai/codex`의 공식 npm SHA512 검증 아카이브만 별도 저장하고, `-Action PrepareOcx`는 기존 `Prepare-AiccOcxUpstream.ps1 -Action Prepare`를 호출한다. `PrepareBoth`도 양쪽 원본 서비스와 계정을 변경하지 않는다.
- 이 도우미는 의도적으로 **다운로드·준비까지만 지원한다**. 성공 출력이나 바로가기를 운영 적용으로 보고하지 않는다. 실제 Codex CLI 설치와 AICC-managed OCX activation은 기존 소유자별 UpdateCoordinator, adapter compatibility, active0, independent recovery 및 rollback 증거를 갖춘 기존 설치기로만 진행한다. `17841`이 다운되었거나 owner가 UNKNOWN이면 중복 실행·실패 요청 재전송을 금지한다.
- 바로가기 설치·정본 스킬 변경·Codex 홈 배포·실행 확인은 각각 실제 결과로 구분한다. 권한 문제는 `read-only` lease와 `write` lease를 먼저 구별하고 기존 grant/OS sandbox를 해제하지 않는다.

자세한 데이터 소유 관계와 구분은 [references/ownership.md](references/ownership.md)를 읽는다. 인증정보·개인 경로·원본 크롤링 내용은 Git이나 스킬 ZIP에 넣지 않는다. Owner-local `inventory/upstream-assets.json`은 정본이 아니라 점검 시 생성하는 파생 **스냅샷**이다.
