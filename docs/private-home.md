# AICC Private Home

AICC가 직접 소유하고 이동 가능한 개인 상태의 기본 root는 `~/.ai-control-center`다. 사용자가 `AICC_STATE_ROOT`를 절대 경로로 지정하면 installer는 그 경로를 사용한다. root, manifest, inventory와 backup은 소유자 전용이며 filesystem root나 symlink root를 허용하지 않는다.

`aicc private-home init`은 현재 root를 등록하고 `private-home.json`과 `inventory/external-state.json`을 만든다. 이미 이 root를 사용하고 있다면 파일을 이동하지 않는다. backup은 명시된 AICC 선언 상태만 whitelist로 복사하며 credential, Tunnel key, browser profile, account database, raw prompt/response와 notification credential은 포함하지 않는다.

```bash
aicc private-home status --json
aicc private-home backup --label before-update --json
aicc private-home restore-rehearsal --backup /absolute/backup/path --json
aicc private-home erase-plan --json
```

Codex Desktop, `~/.codex`, Claude, OCX, private Web GPT, Chrome/Whale profile와 macOS Keychain 또는 Windows Credential Manager는 external state다. AICC는 이를 강제 이동하거나 symlink하지 않고 각 공식 owner의 backup, login, restore와 erase 절차만 사용한다. `erase-plan`은 계획만 출력하며 삭제를 실행하지 않는다.
