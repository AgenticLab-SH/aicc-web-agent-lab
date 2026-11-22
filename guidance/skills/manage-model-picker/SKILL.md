---
name: manage-model-picker
description: Codex Desktop의 계정별 모델 이름과 지원 추론 단계를 짧게 정렬하고, 모델 업데이트 때 실제 최신 메타데이터를 안전하게 반영한다.
---

# 모델 선택자 관리

모델 추가·업데이트, 계정 이름 변경, Desktop 모델 표시 정리를 요청받으면 이 절차를 적용한다. 실제 계정 연결과 사용자에게 보이는 이름을 분리한다.

## 표시와 지원 정보

- Web은 `w A1 k-8 · 임시 · 높음`처럼 표시한다. 임시/저장과 추론 표기는 유지한다. Web의 각 경로는 원래 지원하는 단일 추론 단계다.
- OCX는 `A1 k-8 · Sol 6.1`처럼 표시한다. 계정 번호는 확인된 `N번(이름)` 별칭에서 얻고, 선택 순서·우선순위·포트에서 추측하지 않는다. 내부 selector와 account ID는 표시하지 않는다.
- 계정 짧은 이름은 첫 글자와 마지막 글자다. `demo-ownerd28`은 `k-8`이다. 충돌하면 끝 세 글자, 이어서 계정 번호로 구분한다.
- 계정→Sol/Astra/Luna/Terra→버전→지원 추론 순서를 유지한다. OCX 모델 제목에 특정 추론 단계를 붙이지 않고 Desktop의 추론 선택자에 실제 지원 단계를 모두 둔다. 기본은 지원될 때 high다. Fast는 사용하지 않는다.
- 새 버전은 등록된 정상 관리 경로로 확보한 실제 native catalog의 `slug`, `supported_in_api`, `visibility`, `supported_reasoning_levels`를 사용한다. 공개 이름이나 버전 추측으로 연결을 만들지 않는다. 계정의 실제 이용 권한과 한도는 요청 시 별도로 판정한다.

## 업데이트 실행

정확 저장소는 기존 등록 원장이 가리키는 private adapter root다. 아래 REGISTERED_PRIVATE_ADAPTER_ROOT와 REGISTERED_OWNER_OPERATION은 그 등록 경로와 해당 소유자의 새 작업 경로로 치환한다. 기존 writer와 파일 소유권을 맞춘 뒤 다음 기존 생성기를 쓴다.

```powershell
bun REGISTERED_PRIVATE_ADAPTER_ROOT/scripts/apply-ocx-config-account-catalog.mjs --apply --operation REGISTERED_OWNER_OPERATION
```

새 모델 메타데이터를 기존 관리 경로로 갱신한 경우 같은 명령에 `--native-catalog VERIFIED_ABSOLUTE_CATALOG_FILE`을 추가한다. 입력 파일의 출처·시각·SHA256은 해당 작업 증거에 연결한다. 모델 이름 갱신 요청에는 이 생성기 적용까지 포함한다. 시간 기반 감시를 새로 등록하는 기능은 아니다.

생성기는 등록된 local OCX 계정 별칭과 namespace, Desktop owner journal을 읽는다. 파일 변경 잠금·현재 SHA256 비교·정확 원본 백업을 거쳐 catalog만 교체한다. 같은 family의 가장 높은 지원 버전을 새 선택 목록에 노출하며 이전 slug는 숨겨 보존한다. 실행 중이거나 기존에 저장된 대화의 모델, 인증, 계정 우선순위, 서비스, endpoint는 변경하지 않는다. Sol 외 family도 실제 지원 메타데이터가 있을 때 동일하게 반영한다.

## 검증과 실패 조정

- 변경한 projector 검사와 기존 owner 검사를 실행한다: `bun test tests/model-picker-presentation.test.ts tests/ocx-account-catalog.test.ts`.
- `intent.json`, `catalog.preimage.json`, `result.json`에서 원본/결과 SHA256과 APPLIED를 확인한다. 등록된 원장과 catalog를 재조회해 계정별 이름, 최신 family, 추론 metadata를 확인한다.
- 실제 Desktop 화면을 관찰했는지는 별도로 기록한다. catalog 적용은 모델 호출 성공이나 실제 UI 관찰의 증거가 아니다.
- 큰 원본이나 복구 본문을 도구 사이에 전달하면 수신한 전체 길이와 SHA256을 원본과 대조한 뒤 원격에 쓴다. 단일 큰 필드가 변형될 수 있으므로 원본을 읽었다는 응답만으로 전송 직전 검산을 대신하지 않는다. 원격에서도 실제 전체 bytes를 회수·대조한다. 큰 파일 조회의 빈 content나 blob 메타데이터만으로 완료 처리하지 않는다.
- 본문 불일치는 원본과 잘못된 commit/blob를 보존하고 같은 객체의 정확한 현재 버전을 조건으로 정정한다. 실제 보안·입력 제한 거절을 분할·인코딩·다른 도구로 우회하지 않는다. 허용된 메모리 안의 짧은 순수 체크섬 계산은 외부 실행·전송과 구분한다.
- CAS 충돌·실패·불명 결과는 해당 원 operation부터 조정한다. 같은 operation을 재실행하거나 인증·보안 경계를 바꿔 우회하지 않는다. 새 operation은 기존 시도 상태를 확인한 후 만든다.

## command-route-r2의 단일 catalog owner 계약

일반 codex CLI/Desktop의 base는 같은 OCX-only catalog를 사용하고 Web17841의 chatgpt-web/*는 aicc-webgpt V2 profile 전용 별도 catalog로 둔다. 위 private 생성기와 기존 lock/CAS/backup/owner journal을 재사용하며 공개 root에 다른 projector나 고정 모델 목록을 만들지 않는다. 새 실제 OCX 광고 ID와 검증 metadata를 join하되 raw supported_reasoning_levels=null을 high 지원으로 채우지 않는다. 현재 session의 명시6.1/high 근거와 catalog metadata는 별개다.

이 분리 및 public shared-HOME 후보 manifest를 같은 owner transaction으로 인수하는 기능은 private root owner의 같은 G1 후속 의존이다. 기존 integrated catalog apply를 그대로 재실행하거나 지원되지 않는 새 flag를 추측하지 않는다. 구체 입력·기존 명령·root 정상 적용 gate는 [제품 runbook](../../../docs/runbooks/workspace-codex-cli.md#command-route-r2-적용-준비와-정확-owner-의존)에 둔다. 원 slug/저장 대화/숨긴 이전 버전/기존 rescue·account 권위는 보존한다. 이 public source 작업은 private root·HOME·catalog·CLI 설치·Desktop·GPT 자산을 변경하지 않았다. 앞선 검사 목록은 정책과 명시 범위가 허용할 때만 수행하며 이번 검증 미실행이다.
