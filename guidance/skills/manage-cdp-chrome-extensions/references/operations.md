# 확장 변경과 비활성 슬롯 준비

## 기존 관리자의 경로와 기동 경계

등록된 AICC state root의 browser-extensions 아래 Manage-AiccChromeExtensions.ps1과 Edit-AiccChromeExtensionRegistry.ps1을 사용한다. 저장소의 tools/platform/web-automation에 설치·관리 소스가 있다. owner path, token, 계정 별칭을 공개 예제에 넣지 않는다.

아래 인수는 기존 manager의 절차이며 실행 허가는 아니다. 실제 지원 인수와 exact 등록을 변경 전에 확인한다. 변수는 이미 확인한 절대 경로, 등록 포트와 키를 뜻한다.

~~~powershell
pwsh -NoProfile -File $manager -Action Status -Target $registeredPort -Extension $extensionKey -NoStart
pwsh -NoProfile -File $manager -Action Ensure -Target $registeredPort -Extension $extensionKey -DryRun -NoStart
pwsh -NoProfile -File $manager -Action Ensure -Target $registeredPort -Extension $extensionKey -NoStart
pwsh -NoProfile -File $manager -Action Reload -Target $registeredPort -Extension $extensionKey -DryRun -NoStart
pwsh -NoProfile -File $manager -Action Configure -Target $registeredPort -Extension $extensionKey -DryRun -NoStart
~~~

Ensure는 기본 구현에서 offline 기동을 포함할 수 있으므로 NoStart를 기본으로 유지한다. Reload는 이미 로드된 확장만 대상으로 하고 Configure는 registry 옵션·storage를 적용한다. Status는 읽기 전용이다. 같은 exact action의 preview를 실제 적용에 연결하며 무관한 all 대상은 사용하지 않는다.

상세 options는 enabled, incognito_access, file_access, error_collection, host_access, show_access_requests_in_toolbar이며 pin_to_toolbar는 최상위 필드다. host_access는 ON_CLICK/ON_SPECIFIC_SITES/ON_ALL_SITES다. 사이트 접근 옵션을 바꿀 때 host allowlist와 runtime grants의 영향을 함께 다룬다.

## 등록과 업데이트

기존 registry schema의 key, path, slots, allowed_permissions, allowed_host_permissions, allowed_optional_host_permissions, allowed_content_script_matches, pin_to_toolbar, options, storage, verify를 사용한다. path는 승인된 trusted root의 exact 확장 폴더, slots는 승인된 등록 포트만 포함한다. manifest의 권한과 세 host/content allowlist가 정확히 일치해야 한다. host 범위가 없을 때도 기존 fail-closed guard를 낮추지 않는다.

Register/Replace 전 키·확장 ID·경로·manifest version, preimage와 rollback을 고정한다. 다른 Git 저장소는 기존 TrustRoot 계약의 exact root/origin/HEAD를 따르며 임의 복제하지 않는다. 폴더·표시 이름만으로 동일 자산이라고 판정하지 않는다. 지원하지 않는 UI/API를 추측하거나 권한 allowlist를 자동 확장하지 않는다.

~~~powershell
pwsh -NoProfile -File $registryEditor -Action Register -Key $extensionKey -Definition $definitionPath -DryRun
~~~

실제 Register와 Replace는 승인된 exact preview의 대상만 적용한다. 이후 Ensure도 NoStart와 같은 대상을 유지한다. 신규 권한 확대가 기존 승인 밖이면 적용을 보류한다.

## 삭제와 복구

현재 요청에서 exact 확장 삭제가 승인됐을 때만 같은 대상의 Remove DryRun 뒤 NoStart Remove, 이어 Unregister DryRun과 Unregister 순서로 처리한다. 순서를 바꾸면 manager가 실행 세션의 exact 경로·ID를 확인할 수 없다. 반환·삭제의 불명 응답은 원래 ID 상태부터 조정하고 재실행하지 않는다.

날짜가 박힌 과거 transaction의 Stop/Restore 스크립트를 재사용하지 않는다. 현재 receipt가 가리키는 backup과 exact rollback만 사용한다. Chrome stop/restart는 확장 관리 승인에 자동 포함되지 않는다. 사용자 탭·다른 lease·로그인을 보호한다.

## 슬롯 확장과 용량

미래 슬롯의 비활성 설정 예시와 활성화 전제는 기존 docs/runbooks/browser-slots.md를 사용한다. Manage-CdpChromeSlotLease.ps1은 cdp_slot_count와 cdp_slotN_* 등록을 읽고 usage의 pending/disabled/reserved를 제외한다. cdp_slotN_exclusive=true는 해당 슬롯의 lease target 상한을 1로 만든다. 이것은 OS resource capacity 확인이 아니다.

Windows Start-AiccCdpChromeSlot.ps1의 Port ValidateSet은 현재 9222/9223/9224/9225로 고정돼 있다. Windows installer의 OnlyPorts 필터는 등록 후보를 새로 생성하는 기능이 아니다. 미래 포트를 문서에 넣었다고 시작·확장 manager까지 지원된다고 보고하지 않는다. config-only에서는 count를 늘리거나 후보를 live 파일에 합치지 않는다.

활성화 전에 exact port 중복·profile 경계·identity·lease·영향받는 active/unknown 0과 resource capacity를 확인하고, 지원 부족은 별도 좁은 구현 작업으로 분리한다. 확인하지 않은 값은 UNKNOWN이다. 17841/9336 변경, 새 Chrome 실행, 프로필 복제와 새 로그인은 준비에 포함되지 않는다.

완료에 필요한 확인은 공통 검증 계약과 사용자 요청 범위를 따른다. 모델 이름만으로 생략하지 않는다. 예시 전체를 무조건 실행하지 않고 변경 대상의 설치·실제 호출·종료만 필요한 만큼 확인한다.
