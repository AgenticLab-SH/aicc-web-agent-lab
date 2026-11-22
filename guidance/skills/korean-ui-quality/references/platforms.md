# 플랫폼별 텍스트 배치

현재 작업의 플랫폼 부분만 적용하고 기존 컴포넌트 계약·국제화·언어별 서식을 보존한다.

## 웹·WebView·Electron·Tauri

아래는 기준이 없는 일반 한영 본문 컴포넌트의 출발점이다. 앱 전체에 무조건 붙이지 않는다. 폰트 선언만으로 파일이 로드되지는 않는다. 기존 font loader·로컬 번들/배포 경로·CSP를 재사용하고 배포 파일의 라이선스 고지를 포함한다.

```css
:root {
  --font-ui: "Pretendard Variable", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif;
}
.ui-prose {
  font-family: var(--font-ui);
  line-height: 1.6;
  word-break: keep-all;
  overflow-wrap: anywhere;
  white-space: normal;
}
.ui-flex-content { min-width: 0; }
.ui-content-box { height: auto; box-sizing: border-box; }
```

- flex/grid의 intrinsic minimum이 넘침을 만들면 `min-width: 0`, 필요한 grid track에 `minmax(0, 1fr)`을 쓴다. 세로 스크롤은 부모 높이 계약과 `min-height: 0`을 함께 설계한다.
- 고정 높이 대신 내용 기반 높이·padding·min-height를 사용한다. 긴 URL/ID가 넘칠 때 페이지 overflow를 숨겨 결함을 감추지 않는다.
- 본문·제목·배지·버튼·표·로그별 줄바꿈을 정한다. `keep-all`은 일반 한글 본문 후보이며 모든 언어에 전역 강제하지 않는다. 코드·로그·편집기·표의 공백·정렬·스크롤은 유지한다.
- ellipsis/line-clamp는 의도한 미리보기에 쓴다. 필수 값·오류는 자연스럽게 늘어나게 하고 전체 값 보기·접근성 이름을 연결한다. `title`만으로 터치·키보드 접근을 충족했다고 하지 않는다.
- 허용된 관찰에서는 폰트 로드/fallback, 200% 글자 확대, 320 CSS px reflow를 각각 본다. 320px을 200% 확대의 다른 표현으로 취급하지 않는다. 넓은 데이터 표는 스크롤할 수 있으나 개별 셀 텍스트를 잘라도 된다는 뜻은 아니다.
- 기존 브라우저 도구를 쓰며 Playwright snapshot은 안정된 baseline·폰트·실행 환경이 관리되고 범위에 이득이 있을 때 선택한다. 새 harness를 일괄 설치하지 않는다.

## Windows 기본 UI: WinForms·WPF·WinUI

- 시스템형 UI의 Segoe UI Variable과 플랫폼 한글 fallback을 보존한다. 브랜드 콘텐츠는 요청·기존 체계가 허용할 때 Pretendard/SUIT를 선택한다. 플랫폼 기본 창 구성·Fluent 아이콘은 콘텐츠 폰트로 교체하지 않는다.
- WPF/WinUI는 `TextWrapping`, 내용 기반 행 높이·적절한 `MinHeight`와 부모 Grid/ScrollViewer의 측정 조건을 조합한다. 고정 Height·trimming을 풀어도 부모가 자르면 해결되지 않는다. 두 framework의 API·기본값을 동일하게 추정하지 않는다.
- WinForms는 layout panel·AutoSize·padding·상속 폰트·AutoScaleMode의 기존 계약을 고려한다. owner-draw는 실제 글꼴·DPI·폭으로 측정하고 같은 그리기 API의 계약을 따른다.
- 깨짐은 저장 데이터→프로세스 입출력 UTF-8→JSON→layout/paint를 구분한다. 스크롤 텍스트의 clip·transform·invalidated 영역을 보존한다. 기존 `windows-design`의 텍스트 경계·도움말 참조를 재사용한다.
- 허용된 관찰에서는 지원 DPI·Windows 텍스트 확대·창 축소·대화상자·긴 한영 문구·스크롤·숨김/재표시를 변경 범위에서 본다. 웹 screenshot을 Windows 창 확인으로 보고하지 않는다.

## 모바일: SwiftUI·Android/Compose·Flutter·React Native

- 플랫폼 기본 글꼴·Dynamic Type/글자 크기 설정을 존중한다. 브랜드 글꼴은 지원 glyph와 확대 정책을 함께 설계한다. CSS px를 sp/pt에 그대로 복사하지 않는다.
- 내용 기반 높이와 실제 layout constraint를 쓴다. 핵심 문구를 `lineLimit(1)`, `maxLines: 1`, 강제 ellipsis·shrink-to-fit으로 숨기지 않는다. framework와 버전의 실제 API로 구현한다.
- 긴 문구는 본문/버튼 재배치·여러 줄·확장 보기로 처리한다. 줄바꿈 불가 값은 접근 가능한 상세/복사와 제한된 스크롤을 고려한다.
- 키보드가 열린 상태·safe area·작은 화면·텍스트 확대·터치 도움말·스크린리더 이름/상태를 설계한다. 핵심 안내는 hover에만 두지 않는다.
- 허용된 실기기·시뮬레이터 관찰과 웹 모바일 viewport 관찰을 구분한다. 현재 도구가 지원하지 않으면 관찰 방법만 남기고 정상 표시를 보장하지 않는다.

## 환경별 연결

- 코덱스 구현·지피티 설계/작성·AICC 활용은 [실행 환경별 적용](agent-modes.md)을 읽는다. 환경은 책임의 제한이 아니라 도구와 관찰 근거의 차이다.
- 해당 플랫폼 부분만 [플랫폼별 텍스트 배치](platforms.md)에서 읽는다.
- 기존 `product-design-engineering`의 제품 흐름·시각 방향, `codex-frontend`의 웹 구현, `windows-design`의 Windows 기본 구성, `browser-qa`의 허용된 화면 관찰을 재사용한다. 없는 스킬 설치를 선행 조건으로 만들지 않는다.
- 외부 자료 채택·글꼴 배포가 필요할 때만 [참고 자료와 도입 경계](sources.md)를 읽는다. 원격 스킬 전체나 도구를 자동 설치하지 않는다.

