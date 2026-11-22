# 미루 · 나의 비서 — Android 작업본

미루는 오늘 계획과 반복 루틴, 기상과 조명을 한 앱에서 다루는 Android 앱이다. 이 브랜치는 웹 에이전트용 소스 스냅샷이다. Android 정본의 Compose 소스·Manifest·Gradle Wrapper·단위시험·설치 도구를 포함한다.

## Android 기준 기능

- 오늘 화면의 원형과 시간순 목록에서 날짜 일정의 같은 상세를 연다. 이름·날짜·시간·고정/유연을 편집하고 앱을 다시 열어 확인할 수 있다. 자정 넘김은 두 날짜에 같은 일정 ID로 표시한다.
- 날짜 일정은 앱 전용 `dated-schedules-v1.json`에 저장한다. 반복 루틴과 날짜별 완료는 `morning_routines`에 유지한다. 서로 다른 저장 형식은 분리한다.
- `com.mysunrise.mobile`의 기상 설정은 `sunrise_settings`를 사용한다. Android 정확 알람과 WiZ 로컬 UDP 일출은 별도 경로다. 코드에 들어 있는 `192.0.2.10`은 문서용 예시 주소다.

## 커밋 ZIP에서 웹 미리보기 실행

GitHub에서 작업 기준 커밋의 소스 ZIP을 내려받아 풀고, `web-preview`가 있는 폴더에서 실행한다. Python 3만 필요하며 설치할 프런트엔드 패키지는 없다.

```sh
python -m http.server 4173 --bind 127.0.0.1 --directory web-preview
```

브라우저에서 `http://127.0.0.1:4173/`을 연다. [미리보기 범위와 데이터](web-preview/README.md)를 참조한다.

## 커밋 ZIP에서 Android 빌드

JDK 21과 Android SDK Platform 36을 준비하고 `JAVA_HOME` 및 `ANDROID_HOME`을 자신의 환경에 맞춘다. Windows PowerShell에서는 ZIP을 푼 폴더에서 다음 명령을 실행한다.

```powershell
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

macOS/Linux에서는 같은 Gradle 인자와 `sh ./gradlew`를 사용한다. 첫 빌드에는 Gradle 배포 및 의존성 저장소 연결이 필요하다. 결과 APK 경로는 `app/build/outputs/apk/debug/app-debug.apk`다. 디버그 서명은 SDK/Gradle에서 로컬로 생성한다. 휴대폰을 연결하지 않아도 빌드와 단위시험이 가능하다.

기준 Android 구현의 Windows 검증 기록은 단위시험 16건 통과, 디버그 APK 빌드·서명 통과, Lint 오류 0건과 경고 13건이다. 이 기록은 이 소스 ZIP에서 빌드를 다시 했다는 의미가 아니다. APK와 서명 키는 포함하지 않는다.

## 공개 작업 범위

공개본의 Android 소스는 WiZ 입력 예시를 문서용 주소로 치환했고, 공개 README·인수 문서와 제외 규칙을 따로 작성했다. 운영 데이터, 개인 일정·캘린더 DB, 백업·로그·APK, 키·토큰·서명키, 실제 전구 주소는 스냅샷에 포함하지 않는다. 실기기·운영 서비스 접속은 이 웹 작업의 범위 밖이다. 자세한 다음 작업은 [CODEX_NEXT.md](CODEX_NEXT.md)에 있다.
