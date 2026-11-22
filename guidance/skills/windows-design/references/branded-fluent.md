# Branded Fluent: WinUI 3 표면

시스템 컨트롤과 창 동작은 Windows App SDK의 공식 WinUI 3 규칙을 따른다. 콘텐츠 영역의 서체·강약·색 조합은 앱 브랜드에 맞게 차별화하되, 기본 타이틀바의 Snap Layouts, 다크·고대비 테마, 키보드 포커스와 접근성을 훼손하지 않는다.

## 설계 절차
1. 먼저 도구/콘텐츠/상태/작업 우선순위를 정의하고, 시스템 앱 형태를 그대로 복제하지 않는다.
2. Windows 창·설정·대화상자는 ThemeResource와 Fluent 기본 컨트롤을 사용한다. 배경효과는 Mica를 장기 레이어에, Acrylic을 임시 Flyout에 제한한다.
3. 앱 고유 디자인은 편집기, 검사 화면, 시각화 같은 콘텐츠 표면에 집중한다. 고정 폭 카드보다 명확한 정보 위계를 우선한다.
4. 라이트·다크·고대비·125~200% 배율·좁은 창 너비에서 조작 가능성을 검증한다.
5. 사용자 승인 없이 시스템 전역 테마, 폰트 파일, 레지스트리 설정을 변경하지 않는다.

참고: https://learn.microsoft.com/windows/apps/design/ 및 https://fluent2.microsoft.design/
