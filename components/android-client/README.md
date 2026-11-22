# AICC 휴대폰 진입 앱

현재 상태(2026-11-19 20:24 KST): **release 빌드·Lint·APK 서명/패키지 검증 및 HTTPS 운영 배포 완료**. 외부 HTTPS의 실제 브라우저 다운로드·APK SHA 일치, 360px 설치 안내·업데이트 후 로그인 유지·연결 실패 시 화면 보존을 확인했다. 이번 실제 폰 설치는 미실행이다. 기존 폰 설치본은 Chrome PWA이며 이 APK와 별개다.

설치 주소: https://aicc.example.invalid/install.html · 기존 모바일 lifecycle의 normal ACK/양 process 종료/CAS 전환 후 운영 인수했다. 중앙 증거: `resume-20261117/mobile-download-20261119/operating-download-result.json`. HTML은 기존 Cloudflare가 줄바꿈·스크립트를 변환하므로 원서버 exact SHA와 HTTPS 원문 main 내용 일치를 각각 확인했고, JS/메타데이터/APK는 HTTPS exact SHA로 검증했다. APK 설치 확인은 Android에서 사용자가 진행한다.

기존 모바일 화면을 여는 Android 진입 앱이다. 제어 화면과 같은 HTTPS의 설치 안내만 외부 브라우저로 연다. 새 서버·실행기·감시기·예약·모델 연결을 만들지 않는다. API·큐·인증·기기 기억·해제는 기존 모바일 웹이 소유한다.

## USB 없는 설치와 업데이트

기존 HTTPS의 `/install.html`에서 Chrome PWA 설치 또는 `/downloads/aicc-mobile.apk` 다운로드를 사용한다. APK는 Android 설치 확인이 필요하며 USB 디버깅은 필요 없다. 앱 삭제·데이터 초기화 없이 같은 패키지/서명키의 높은 versionCode로 업데이트한다. 기존 PWA는 제어 화면의 ‘앱 업데이트’로 최신 화면을 가져온다. 편집 중에는 갱신하지 않고 네트워크 오류 시 화면을 보존한다. 실제 폰 설치 성공은 별도 확인한다.

확인한 빌드 도구는 기존 Gradle 8.14와 JDK21·Android SDK36이다. Android Studio JBR25+Gradle8.14 조합은 실패했으므로 기존 AICC Temurin21을 사용한다. `assembleRelease`의 첫 offline 검사는 Lint 의존성 캐시 누락으로 실패했고 정상 의존성 다운로드 후 release/Lint가 통과했다.

`Publish-Apk.ps1 -JavaHome <JDK21> -AndroidSdk <SDK>`는 release unsigned APK만 받아 owner-local 키로 서명하고 서명을 검증한 뒤 `public/downloads`에 배치한다. 키/DPAPI 비밀번호는 owner-local `.ai-control-center/android-client/signing`에만 보관하고 배포하지 않는다. 기존 키를 교체하지 않으며 다음 배포는 versionCode 증가가 필수다. 같은 버전 재발행은 거절한다. 웹 배포는 기존 mobile lifecycle의 후보 봉인·독립복구·정상종료·CAS 전환을 사용한다.

후속 배포 가드: 키·DPAPI 비밀번호 중 하나만 남거나 기존 배포 후 키가 없으면 새 키를 만들지 않는다. APK와 버전 JSON 중 하나만 남은 경우도 먼저 조정한다. 서명한 실제 APK를 기존 SDK의 aapt로 읽어 package/versionName/versionCode·비디버그 여부를 metadata와 대조하고 이전 패키지·인증서·증가 버전을 확인한 뒤 교체한다. `Test-ApkPublication.ps1`의 오프라인 14사례와 기존 서명 APK 읽기 검증 PASS; 새 APK 발행·실폰 업데이트 시험은 수행하지 않았다.

로그인과 일회용 연결 링크는 기존 브라우저에서 처리한다. WebView, OAuth 내장 로그인, 쿠키 추출, 키 저장, 임의 URL 입력, incoming deep link와 shell은 없다. 폰을 인증한 브라우저와 앱 버튼을 여는 브라우저가 다르면 다시 연결해야 한다. 기본 브라우저 선택은 사용자가 관리한다. 앱에서 PC가 켜져 있는지 또는 작업이 끝났는지 추정하지 않는다.

## 집에서 이어갈 진입점

Android Studio에서 **이 폴더**를 프로젝트로 연다. 다른 업무 앱의 Android 프로젝트를 수정하거나 병합하지 않는다. 기존 Studio JBR과 기존 Android SDK를 사용한다. SDK 경로는 `ANDROID_HOME` 또는 이 폴더의 로컬 `local.properties`에 설정하며 개인 경로를 저장소에 넣지 않는다.

원 초안의 도구 후보는 AGP 8.13.2/Gradle8.13/JDK17+/SDK36이었다. 현재 실제 검증 조합은 위 Gradle8.14/JDK21이며 wrapper를 새로 설치하지 않았다.

폰 없이 release 빌드 후 서명·배포할 수 있다. 도구 경로는 현재 호스트의 기존 설치를 사용한다.

```powershell
$env:JAVA_HOME = '<기존 JDK21 경로>'
$env:ANDROID_HOME = '<기존 Android SDK 경로>'
& '<기존 Gradle 8.14 경로>\bin\gradle.bat' --no-daemon -p '<open-AICC>\components\android-client' :app:assembleRelease
```

배포용 산출물은 `public/downloads/aicc-mobile.apk`와 비밀 없는 버전·SHA·인증서 정보 JSON이다. debug APK는 배포하지 않는다. 앱이 생겨도 Desktop 무인 발신 계약이 해결되는 것은 아니다.

실제 폰에서는 PC 발급 링크를 기존 브라우저로 열어 인증하고, 이 앱에서도 같은 브라우저로 제어 화면을 연다. 기기 기억·재부팅·선택 큐 변경·해제는 실제 동작 확인 전까지 미확인으로 유지한다. 앱 소스·빌드·설치·서비스 적용·실제 폰 사용은 별도 단계다. 현재 공개 서비스와 후보·rollback 상태는 루트 `context/PROJECT.md`를 따른다.
