# 모델 경로 공통 변경 계약

이 문서는 Native, Web GPT 17841, OCX 10100 변경에 공통인 경계만 소유한다. 대상별 절차는
한 파일만 추가로 읽는다.

| 대상 | 추가 reference |
|---|---|
| Native profile·공식 endpoint·CM account | [native-recovery.md](native-recovery.md) |
| OCX 10100·provider·service | [ocx-maintenance.md](ocx-maintenance.md) |
| Web GPT 17841·bridge·harness·app | [web-gpt-maintenance.md](web-gpt-maintenance.md) |
| Codex Desktop 종료·재시작 | [desktop-maintenance.md](desktop-maintenance.md) |

## 공통 transaction

대화/도구 연결이 끊길 수 있는 AICC·OCX·Codex 변경은 실제 중단 전에 `codex-rescue-preflight`의 [중단 사전 안내](../../codex-rescue-preflight/references/request-and-ack.md#중단-사전-안내)를 출력한다. 영향·예상 단절 시간·완료 시각(KST)·복구 방법이 필수이며 오래 대기했으면 변경 직전에 갱신한다.

1. 현재 `openai_base_url`, 대상 version/health/PID, route journal과 비대상 health를 읽는다.
2. 대상이 보고하는 active-turn counter를 읽는다. 실패한 read는 0이 아니라 `UNKNOWN`이다.
3. 변경할 exact 파일·service·account와 성공 조건을 고정하고 owner-only 복구본을 만든다.
4. 대상 active turn이 0이 아니거나 상태가 UNKNOWN이면 stop, restart, restore, reinstall, account
   전환을 하지 않는다.
5. 한 transaction에서 한 경로만 바꾼다. Web GPT 작업은 OCX를, OCX 작업은 Web GPT를,
   account 작업은 다른 account/profile을 바꾸지 않는다.
6. 변경 직전 설정·PID·active-turn을 다시 읽고 single writer를 확인한다.
7. 변경 뒤 대상 health/version/catalog, 비대상 경로 생존, route journal과 작은 read-only 요청을
   확인한다. 이전 release canary를 현재 증거로 재사용하지 않는다.

## 경로 계약

```text
chatgpt-web/* -> ChatGPT Web 브라우저 추론
그 밖의 통합 모델 -> OCX 10100
codex-native profile -> 공식 Codex endpoint
```

Codex process 하나는 `openai_base_url` 하나만 사용한다. 모델 표시명, 로그인 메뉴, 실행 중인
listener만으로 route나 account를 추측하지 않는다. provider·account·profile을 조용히 대체하지
않고, bridge와 OCX를 동시에 재시작하지 않는다.

## 실패와 복구

- 변경 전 실패면 대상에 mutation이 없음을 확인하고 종료한다.
- 변경 후 postcondition 실패면 같은 transaction에서 변경한 대상만 복구한다.
- 결과가 불명확하면 자동 재시도하지 않고 `HOLD`와 마지막 확정 상태를 남긴다.
- 활성 작업 때문에 재시작만 남으면 남은 단계와 안전한 실행 시점을 보고한다.

## 기존1그룹 명령 단순화 · command-route-r2

일반 명령은 공식 codex, ocx는 서비스 status/start/recover/dashboard/update 전용이다. 같은 HOME에서 `codex -p native`/`native.config.toml`은 독립 정비에만, `codex -p aicc-webgpt`/`aicc-webgpt.config.toml`은 Web17841에만 opt-in한다. user model/reasoning/approval/reviewer/sandbox/personality/skills/plugins를 상속하며 새 깨끗한 HOME을 강제하지 않는다. 명시6.1/high는 기존 지원이므로 '항상5.6강제'로 설명하지 않는다.

새 source의 compat는 표준 --model/-m와 기존 --route-model/--route-effort를 명시 입력으로만 처리한다. 고정 endpoint·기존 account namespace/admission/paused·실행 직전 동일성 보호는 유지한다. auth.command와 env_key를 같은 provider에 섞지 않고 token을 config에 쓰지 않는다. 등록 helper는 공식 Codex의 secret pipe로만 읽게 하며 사람이 일반 도구로 실행해 stdout을 회수하지 않는다.

실제 OCX catalog 단일 관리기·별도 Web catalog·CLI/Desktop caller·트레이·GPT 지침/스킬/plugin 설명의 준비/정상 적용/복귀는 [기존 제품 runbook](../../../../docs/runbooks/workspace-codex-cli.md#command-route-r2-적용-준비와-정확-owner-의존)을 따른다. private catalog owner는 다른 Git root이며 그 source를 중복 수정하지 않는다. 이 scope의 source 작성/구성 후보 생성 소스와 실제 HOME 적용·설치·daemon 수용·call은 별개다. 이번 HOME 배포·runtime 변경·실행 확인·검증은0이며 과거 routing 스킬/HOME 반영은 보존한다.

