# Dormant Whale recovery

Whale과 CDP Whale 9335는 현재 기본 운영 경로에서 제외한 선택 기능이다. AICC는
이를 자동 선택·설치·실행·대기·fallback하지 않는다. 벤더 앱, 로그인 profile,
아이콘과 launcher source는 복구 가능성을 위해 보존한다.

## 휴면 상태 계약

- HTTP/HTTPS 기본 handler는 private `coordination.toml`의
  `default_browser_bundle_id`이며, 현재 Mac은 `com.google.Chrome`이다.
- private `coordination.toml`에는 Whale slot이나 9335 endpoint가 없다.
- private port registry에는 9335 서비스가 없다.
- `CDP Whale.app`과 `NAVER Whale (일반).app`은 LaunchServices 및 Dock에서 제외한다.
- `/Applications/Whale.app`과 기존 user-data/profile은 삭제하거나 읽지 않는다.
- 기본 설치기는 `-IncludeWhale` 또는 `-CdpWhaleOnly` 없이는 Whale을 만들지 않는다.

## 명시적 복구 절차

사용자가 다시 Whale 사용을 요청한 유지보수 창에서만 진행한다.

1. 9335 listener, established client, Whale process와 task-owned lease가 모두 0인지 확인한다.
2. owner-only retirement manifest에서 launcher bundle과 coordination/registry 항목을 복구한다.
3. 필요하면 다음처럼 명시적으로 launcher를 다시 생성한다.

```bash
pwsh -NoProfile -File tools/platform/web-automation/Install-SeparatedBrowserAppsOnMac.ps1 -IncludeWhale
pwsh -NoProfile -File tools/platform/web-automation/Install-ImportedBrowserAppsOnMac.ps1 -CdpWhaleOnly
```

4. exact executable, user-data root, profile directory와 9335 listener identity를 검증한다.
5. Whale을 OS 기본 브라우저로 되돌리는 것은 별도 사용자 결정이다. 복구만으로
   HTTP/HTTPS handler를 바꾸지 않는다.
6. Dock 등록 역시 별도 명시 선택이며, profile/cookie/password/Keychain state는 수정하지 않는다.

실패하면 profile을 초기화하거나 다른 브라우저로 조용히 대체하지 말고, 복구 전
휴면 상태로 되돌린다.
