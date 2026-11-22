# open-AICC 통합과 마이그레이션

## 최종 구조

`open-AICC`는 재사용·공개를 목표로 하는 코드, 계약, 설치 도구, 테스트, 일반화된 문서와
agent guidance의 유일한 정본이다. 안정화 기간에는 저장소를 private로 유지할 수 있다.
기존 `aicc` 명령, `AICC_` 환경변수, `~/.ai-control-center` 상태
루트와 `cm` 호환 별칭은 유지한다. 저장소 이름 변경 때문에 사용자의 설치·자동화·
런타임 상태를 다시 만들지 않는다.

```text
open-AICC reusable core source
  ├─ src, components, contracts, guidance, tools, tests, docs
  ├─ generic examples and adapter interfaces
  └─ package: open-aicc; commands: aicc, cm

owner-selected Private Home
  └─ open-AICC-owned declarative state, backups, inventory, secret references

external application-owned state
  ├─ Codex / OCX authentication and task state
  ├─ browser profiles and macOS Keychain
  └─ optional private Web GPT adapter and login partition
```

개인 상태를 모두 한 저장소나 DB에 물리적으로 합치는 것이 목표가 아니다. 공개
제어면 하나에서 소유자, 위치, 백업, 복구와 삭제 방법을 알 수 있게 하되 각 앱의
공식 상태 경계는 보존한다.

## 이전 private 상위 저장소에서 흡수하는 것

| 분류 | open-AICC 처리 |
| --- | --- |
| provider-neutral 계약 15종 | `contracts/`의 공개 JSON Schema로 흡수 |
| one-writer, durable job, browser/remote lease 규칙 | 공개 구현·테스트·문서로 유지 |
| Private Home 및 external state 경계 | 공개 installer와 `docs/private-home.md`로 유지 |
| portable profile 생성 방식 | `tools/private-profile/export-safe-profile.mjs`로 유지; 생성 결과는 owner-only |
| 운영 계획에서 일반화 가능한 원칙 | `docs/`와 canonical `guidance/`로 요약 |

다음은 흡수하지 않는다.

- 사용자 요청 원장, raw 대화, 장기 실행 evidence, screenshot, 개인 디자인 원본
- 계정 alias, workspace 목록, provider 선택, 절대 사용자 경로가 든 profile export
- 인증, session, account DB, cookie, browser profile, Keychain/Tunnel/API key
- 비공개 Web GPT 구현, 로그인 partition, 서명된 앱과 owner-only rollback
- 설치 Codex 버전에서 재생성 가능한 928개 App Server schema snapshot

마지막 항목은 compatibility 작업공간에서 설치본으로부터 재생성하고 버전·tree hash만
기록한다. 공개 저장소에 낡은 대형 snapshot을 영구 복제하지 않는다.

## 무중단 이관 순서

1. **보존점**: public core와 private 상위 저장소의 commit, submodule revision,
   remote visibility와 private bundle/checksum을 기록한다.
2. **공개 흡수**: 새 경로만 추가하고 기존 CLI·state·launch label을 유지한다.
3. **독립 검증**: `npm ci`, 전체 테스트, `npm run test:distribution`, gitleaks,
   clean clone/install/smoke를 수행한다. private adapter 없이 public core가 동작해야 한다.
4. **원격 이름 변경**: 활성 작업이 모두 끝난 안전 창에서 public GitHub 저장소
   `AICC`를 `open-AICC`로 한 번만 변경한다. 각 clone의 `origin`과 상위 저장소의
   submodule URL을 새 URL로 갱신한다. GitHub redirect는 편의일 뿐 정본으로 의존하지 않는다.
5. **경로 정리**: 활성 task가 참조하지 않을 때만 로컬 public checkout을
   `repos/open-AICC`로 이동하고 workspace registry·문서·검사를 함께 갱신한다.
6. **private owner overlay 분리**: clean-clone 동등 기능, private export 복구 rehearsal,
   reference-count 0, rollback bundle 검증 뒤 혼합 제품명 `my-AICC`를 폐기한다. 개인 원장·
   evidence·profile은 installer가 선택한 Private Home과 별도 private superproject에 보존한다.
   특정 제품명을 다시 고정하지 않고, active owner overlay를 read-only archive하거나 공개
   저장소에 합치지 않는다.

## 폐기 gate

기존 혼합 제품 역할은 다음 조건을 모두 만족하기 전에는 폐기 완료가 아니다.

- 공개 `open-AICC`가 private 저장소 없이 설치·status·guidance·generic smoke PASS
- 공개 package에 개인 경로·alias·private URL·credential/runtime 파일 0
- optional private Web GPT가 공개 contract만 구현하고 public core를 fork하지 않음
- owner overlay의 backup/restore rehearsal과 external-state inventory PASS
- 실행 중인 Codex 작업, writer lease와 해당 checkout 참조 0
- private Git bundle과 commit/checksum으로 롤백 가능

조건을 통과한 뒤 private source가 더 이상 쓰이지 않을 때만 archive를 고려한다. 삭제는 별도
명시 승인과 retention 기간, 복구 불필요 증거가 있을 때만 한다.

## 현재 호환성 결정

- 제품·GitHub 저장소: `open-AICC`
- npm 배포 이름: `open-aicc` (2026-08-13 조회 시 registry 미사용; 게시 전 재확인·로그인 필요)
- CLI: `aicc`, `cm` 유지
- 환경변수와 상태: `AICC_*`, `~/.ai-control-center` 유지
- agent guidance의 명칭: 문맥상 AICC를 호환 약칭으로 유지 가능
- private Web GPT: 별도 선택 adapter; 공개 패키지에 포함하지 않음
