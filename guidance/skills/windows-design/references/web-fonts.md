# Windows WebView2·Electron 서체 기준

Tauri/Electron 콘텐츠는 웹 텍스트 렌더링이므로 native WinUI와 완전히 같은 결과를 약속하지 않는다. 사용자 언어, 가독성, Windows 시스템과의 조화를 기준으로 서체를 선택한다.

- 본문: system font stack에 Segoe UI Variable/Segoe UI, 한글 맑은 고딕·Noto Sans KR 대체를 적절히 지정한다.
- 제품 개성이 필요한 제목만 별도 display family 후보를 검토한다. 라이선스·다운로드 크기와 로컬 배포 허용 여부를 확인한다.
- 본문 최소 14px 안팎, 충분한 줄간격, 긴 한국어 문장의 줄바꿈과 숫자 단위 정렬을 확인한다.
- 폰트 weight/optical size 지원 여부를 브라우저에서 검증한다. 모든 굵기에 합성 Bold를 강요하지 않는다.
- 원격 웹 폰트 실패 시에도 화면·버튼이 작동하게 font-display와 fallback을 둔다. 사용자 시스템에 폰트를 설치하지 않는다.

검증: Windows 100%·125% 배율, Chromium/WebView2, 다크·고대비, 한국어·영어 혼합 긴 문자열.
