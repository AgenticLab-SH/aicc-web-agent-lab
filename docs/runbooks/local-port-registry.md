# Local port registry and live inventory

포트의 **의도된 배정**과 **현재 점유**는 서로 다른 사실이다. 장치별 정적 배정은
`~/.ai-control-center/guidance/port-registry.toml`, 현재 리스너는 감사 시점의
Windows `Get-NetTCPConnection`/CIM 또는 macOS `lsof` 결과를 정본으로 삼는다.
오래된 PID, 열린 탭, 앱 표시명만으로 소유권을
판단하지 않는다.

## Registry contract

공개 예시는 `guidance/config/port-registry.example.toml`이다. 개인 계정 별칭,
워크스페이스와 절대 경로는 private registry에만 둔다. 각 `[[services]]`에는 최소한
`port`, `name`, `owner`, `purpose`, `bind`, `lifecycle`을 기록하고, 고정 프로세스는
`expected_process_contains`로 실행 파일·프로필·포트를 함께 묶는다.

- `persistent-on-demand`: 정적 배정이지만 항상 LISTEN할 필요는 없다.
- `launch-agent`: 로그인 시 또는 장애 복구 시 재기동되는 로컬 서비스다.
- `project-session`: 개발 작업 중에만 점유하며 종료 뒤 재사용될 수 있다.
- `docker-project`: Docker가 비루프백으로 게시할 수 있으므로 프로젝트 소유자를 함께 적는다.
- IDE, Gradle, OS, Spotify와 같은 임시 포트는 정적 registry에 억지로 고정하지 않고
  live report의 `unregistered_current`로 남긴다.

## Read-only audit

```powershell
python tools/platform/inspect/local_port_inventory.py
python tools/platform/inspect/local_port_inventory.py --json
python tools/platform/inspect/local_port_inventory.py --write --strict
```

`--write` 결과는 Git 밖의 `~/.ai-control-center/reports/ports/`에 JSON과 Markdown으로
저장된다. 보고서는 명령행의 일반적인 token/password/secret 인자를 마스킹한다.
`occupied_conflict`는 등록된 포트의 프로세스 정체성이 다르다는 뜻이며, 자동으로
프로세스를 종료하거나 다른 포트로 이동하지 않는다.

## Change procedure

1. registry와 `coordination.toml`, LaunchAgent, Docker publish 설정을 읽는다.
2. 플랫폼 probe가 반환한 PID의 전체 명령에서 executable, bind address, profile, port를 검증한다.
3. 계정·브라우저 슬롯 변경이면 `choose-browser-session`과 exact target lease를 사용한다.
4. 충돌 시 기존 프로세스를 중단하지 말고 소유 프로젝트와 변경 권한을 확인한다.
5. 의도된 배정을 private registry에 먼저 갱신하고 새 live report로 post-state를 남긴다.

브라우저 포트는 이 문서만으로 선택하지 않는다. 개인 계정과 프로필 연결의 정본은
`~/.ai-control-center/guidance/coordination.toml`이며 registry는 감사와 충돌 탐지를
위한 중복 검증 계층이다. Web GPT 17841과 OCX 10100의 provider 경계는
`manage-codex-model-routes`를 따른다.
