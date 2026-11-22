# Independent Codex CLI routes plan

## Architecture

- `src/codex-cli-routes.mjs`가 공식 Codex 실행 파일과 선택 모델을 설명하는 검증된 local catalog를 읽고 고정 invocation을 만든다. OCX 전용 catalog가 없으면 같은 모델의 Native metadata를 읽어 쓸 수 있어 17841 준비 절차에 의존하지 않는다.
- Native는 공식 ChatGPT Codex endpoint를 사용하고 loopback service에 의존하지 않는다.
- OCX는 10100만 사용하며 health, ready, model 세 조건이 모두 참일 때만 같은 공식 Codex 실행 파일을 시작한다.
- `src/cli.mjs`가 `aicc codex` 명령을 제공하고 `src/catalog.mjs`의 두 TUI 항목이 이를 호출한다.

## Interfaces

- `aicc codex status [--json]`
- `aicc codex native [--route-model MODEL] [Codex args]`
- `aicc codex ocx [--route-model MODEL] [Codex args]`

## Safety and recovery

- config/profile/model override 인수는 실행 전에 거부한다.
- 전역 config, service, account를 쓰는 API는 이 실행 경로에 없다.
- OCX 실패 시 spawn 0회이며 fallback도 없다.
- 실제 연결은 최종 검토 뒤 별도 승인 전까지 실행하지 않는다.

## Verification order

1. route invocation, config 불변, override 차단 fixture
2. OCX down/ready fake HTTP와 fake spawn fixture
3. TUI catalog 계약
4. 문법, focused tests, diff review, live config fingerprint 불변 확인


## 일반 Chat 접근 구현

기존 route builder/preflight를 prepareCodexCliLaunch로 재사용한다. optional codexCli owner
binding만 start/status 도구를 노출한다. provider는 prompt bytes를 stdin으로 보내고 pinned
PowerShell/기존 Job Object를 사용한다. durable operation ID와 writer.lock은 unknown 시
보존한다. 기존 AppContainer, Web manager, Desktop/OCX runtime을 재설계하지 않는다.
적용 상세/rollback: docs/runbooks/workspace-codex-cli.md. 전체 dirty source 배포 금지.