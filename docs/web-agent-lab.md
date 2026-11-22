# AICC 공개 작업 범위

## 작업 위치와 실행

브랜치 **aicc-source-20261122**의 public/, src/, components/android-client/, tools/platform/windows/, contracts/, test/에 최신 개발 소스와 계약을 제공합니다. examples/lab-server.mjs가 실제 화면의 합성 API를 제공하고 examples/lab-server.test.mjs가 권한·단회 확인을 검사합니다. 운영 초기화와 계정 도구 실행은 승인된 소유자 환경에서 수행합니다.

- 빠른 확인은 **npm ci --ignore-scripts**, **npm run check:lab**, **npm test**, **npm run preview**를 사용합니다. Windows 추가 검사는 **npm run verify:windows**입니다.
- 브라우저에서 /mobile.html#overview, /mobile.html#apps, /mobile.html#tools, /mobile.html#accounts, /install.html을 확인합니다. ‘연결 진단 (모의)’는 미리보기 → 단회 확인 → 원 결과 읽기를 재현합니다. 예시 demo-unconfirmed 작업은 조회할 때 UNKNOWN을 반환합니다. 연결 실패 시 이전 표시를 유지하는 동작을 점검하세요.
- Android 디버그 빌드는 JDK 21·Gradle 8.14·Android SDK 36으로 **gradle -p components/android-client :app:assembleDebug**를 실행합니다. 기본 주소는 예약 도메인 예시입니다. 앱 서명, 웹 인증과 Windows의 PC 복구는 제품이 운영하는 별도 경계입니다.
- 원 서버와 Windows용 운영 도구의 코드와 명세를 읽어 계약을 이해할 수 있습니다. 실기기·서명·외부 연동 검증에 필요한 원장과 비밀은 이 작업본과 분리돼 있습니다.

## 제공 대체물과 제외

- 합성 앱·계정·현황과 가상 주소를 사용합니다. 홈·로컬 저장·신뢰·키·서명은 복사하지 않았습니다. 배포 APK 경로는 모의 환경에서 404이며 버전 JSON만 합성 예시입니다.
- 운영 및 개인 주소는 예시 주소로 바꿨습니다. 실사용 운영 영수증·백업·사용자 설정·유출 위험이 있는 자료·전용 어댑터와 원 유저 상태는 제외했습니다. 비공개 issuer 모듈은 외부 호출 없이 거절하는 인터페이스를 제공합니다.
- OpenCodex는 별도 공개 업스트림입니다. 이 브랜치에는 외부 업스트림 소스를 함께 저장하지 않습니다. 공급자 설정이 필요하면 [기존 공개 모델 어댑터 계약](../contracts/model-adapter/)을 사용하세요.
- 공개 저장소의 main과 web-design-v1에는 기존 디자인 자료가 있습니다. 이 브랜치는 AICC 전용 작업 공간입니다.

## 다음 웹 에이전트 프롬프트

AICC 공개 스냅샷의 docs/web-agent-lab.md와 docs/dashboard-product-spec.md를 먼저 읽어 주세요. npm ci --ignore-scripts, npm test, npm run preview로 합성 환경을 실행하고 /mobile.html#overview, #apps, #tools, /install.html에서 사용자 흐름을 확인하세요. 이번에 요청받은 AICC 기능만 수정하고 로그인·권한·미리보기·단회 확인·원 결과 불명/회복의 구분을 유지하세요. 실제 계정·기기·서명키·운영 주소를 요구하거나 연결하지 마세요. 320/360/768px와 키보드, 조회 실패·빈값을 검증하고 수정 파일, 실행 결과와 남은 점을 알려 주세요. 변경은 이 브랜치에서 시작한 ZIP 또는 패치로 돌려주세요.

CI 정의 원형은 examples/ci/의 참고 파일로 제공합니다. 공개 작업본 브랜치에는 push로 실행되는 배포 구성이 없습니다.
