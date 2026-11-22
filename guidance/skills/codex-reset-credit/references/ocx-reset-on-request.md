# OCX 초기화권 명시 요청 처리

설치된 `aicc-ocx-hub` 관리기를 사용한다. Windows는 client이며 자격 증명은 등록 A1 owner에 둔다. 토큰·전체 이메일·원 auth 응답을 출력하지 않는다. Native reader의 소비 차단은 변경하지 않는다.

1. 사용자 요청이 소비를 명시했는지 확인한다. `-Action identity`로 요청한 계정명과 정확 selector/identityHash를 결속한다. 번호·과거 대응표로 추측하지 않는다.
2. `-Action credits -Selector <selector> -ExpectedIdentity <hash>`로 목록을 읽는다. `available_count`, 각 `granted_at`/`expires_at` 쌍과 가장 이른 만료를 owner-local 작업 근거에 저장한다. 기한이 지난 권을 후보에 넣지 않는다.
3. 현재 제공판의 특정권 selector 지원을 확인한다. 현재 OCX consume은 `redeem_request_id`를 받으며 특정권 ID는 받지 않는다. 문서나 가장 이른 만료 정렬만으로 제공자의 소비 순서를 보장하지 않는다. 사용자에게 이 한계를 이미 알렸고 단회 사용 재지시가 있으면 다음으로 간다. 특정권만 허용했다면 기존 `ResetCreditGuardBase64`의 exact 조건을 유지하고, 여러 권이면 HOLD한다.
4. 아래 순서로 exact 계정에 fresh preview를 받고 60초 안에 동일 인자로 **한 번만** commit한다. preview와 결과는 기존 owner-local 기록에 보존한다. 계정 선택·우선순위·정책·자동소비는 바꾸지 않는다.

```powershell
aicc-ocx-hub -Action reset -Selector <selector> -ExpectedIdentity <hash>
aicc-ocx-hub -Action reset -Selector <selector> -ExpectedIdentity <hash> -PreviewToken <previewToken> -Commit
```

5. 결과 불명이면 `-Action reconcile -PreviewToken <원 previewToken>`으로만 조정한다. 소비/네트워크 불명 뒤 새 preview·다른 계정·직접 API로 재소비하지 않는다. `reset`은 실제 초기화, `nothing_to_reset`/`no_credit`는 소진 성공이 아니다.
6. 같은 계정의 `credits`를 다시 읽고 전후 차이를 확인한다. 가장 이른 쌍만 사라지고 다른 쌍이 보존됐을 때만 “가장 먼저 만료되는 권 사용”으로 보고한다. 예상과 다르거나 목록 불명이면 추가소비를 중단한다.
7. `-Action refresh`에서 같은 계정의 live quota를 확인한다. 캐시/conditional admission과 실제 요청 성공을 구분한다. 기존 goal/작업을 잇되 UNKNOWN 재전송·계정 강제전환·guard 해제는 하지 않는다.

보고는 사용/미사용, 실제 소비된 만료일(KST), 잔여 수량, fresh quota, 이어간 업무를 짧게 쓴다. 상시소비 권한으로 확대하지 않는다.
