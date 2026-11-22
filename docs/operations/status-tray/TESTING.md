# 후속 인수 기준

이 문서는 이번 변경 후 실행한 결과가 아니라 다음 인수에 필요한 항목이다.

- 기존 Install-AiccStatusTray.ps1로 immutable snapshot을 빌드·설치한다. active account operation을 보존하고 이전 release와 single task/launcher를 유지한다.
- 실제 Windows 11에서 Acrylic와 시스템 투명 효과 off, dark/light, high contrast, remote-session/미지원 fallback을 구분해 확인한다. DrawToBitmap만으로 backdrop을 판정하지 않는다.
- 100/125/150/200% DPI, 작은 모니터, 키보드 Tab/Enter/Esc, focus 유지, 메뉴 열린 중 자동 갱신, 고정 footer/스크롤을 확인한다.
- 실제 계정 변경 없이 fake state로 선택/차단/중지/미확인/지연을 확인하고 숫자·reset time·cache age·threshold labels를 대사한다.
- 시작/창 열기/수동 refresh가 최신 조회를 요청하고 visible 3초 cache 반영 및 hidden 5분 관찰을 구분한다. 단일 collector, 30초 debounce, EOF 종료, 실패 시 backoff를 확인한다.
- 계정 mutation·reset-credit는 기존 preview/one-use/ledger 경계를 보존한다. 초기화권 소비, 실제 계정 전환 또는 Slack 전송은 별도 명시적 인수 범위다.

이번 Sol 턴: 수정 후 테스트·빌드·실행·렌더링 검증 미실행. 새 native UI는 빌드/설치 전이며 현재 설치본과 다르다.

## 공통 웹 화면 후속 인수 항목
이번 변경 후 검증 미실행. 아래는 실행 결과가 아닌 후속 인수 목록이다.
- 360/390/768/1280/1920px, 글자 확대, safe-area, 가로 화면에서 메뉴·계정·설정·확인 창의 잘림과 터치 영역.
- 페이지 세로 스크롤과 로그 가로 스크롤 구분, 키보드 포커스·뒤로 가기·읽기 순서.
- 인증 없음·만료·오프라인·빈 목록·미확인 한도·조회 실패를 서로 구분.
- 검색/상태 필터·그룹 펼침·편집 입력 보존·저장 안내, 기존 정책/알림/순서/원 결과 조회 계약.
- 실제 휴대폰 쿠키 유지·재부팅·변경 요청·Slack 수신은 별도 실제 인수이며 설치 영수증과 구분한다.

## 독립 웹·초기화 시각 후속 인수
이번 코드 변경 후 검증 미실행. 후속 범위: GUI·Workspace·CDP를 끈 상태의 계정/정책/초기화권 요청, 현재 API 관측과 초기화 시각 결속, OCX 중단의 오래됨 표시, 두 창 비교·정렬·계정 결속 도구 이동·그룹 펼침 보존·44px 터치·편집값 보존. 설치 ACK와 실제 브라우저 동작은 별도다.
