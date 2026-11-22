# Windows 상태 트레이 결정

운영 도구 사용법과 실제 적용 범위: [AICC 문제 해결 및 RDC 계정 전환](TROUBLESHOOTING.md).

Upstream Windows design skill: https://github.com/f0d010c/stark/tree/ff94e5b4e1c98d259f3cde9f806406c4528deed4/skills/windows-design (canonical guidance/skills/windows-design).

UI decision / native quality brief
- Surface: system-like Windows tray utility. Main object: selected OCX account and two quota windows. Composition: compact instrument panel; stable account list, no sidebar or hero.
- Window: owner-local WinForms utility preserved. Apply Fluent vocabulary without claiming strict WinUI 3. Native system title/caption, DPI and menus remain. No new runtime/WebView, account route or duplicate task.
- Material: transient unpinned flyout requests Desktop Acrylic; pinned persistent window requests Mica. Respect transparency off, low power, remote session, high contrast and unsupported fallback. No window opacity or decorative reflection. Mica is desktop tint, not transparent glass.
- Type: Segoe UI Variable Text/Display where installed, system fallback otherwise. Body14epx, current account20epx, strong labels14epx. Segoe Fluent Icons for refresh/pin/settings. System accent read once per theme change; semantic error/selection colors never replace status text.
- Commands: footer owns refresh (F5/Ctrl+R) and Settings only. Account row owns switch once; account menu owns pause/resume, priority, one-credit reset and automatic selection only. Current account is a status, not a disabled duplicate button. Window pin exists only in the header. OCX dashboard/Slack/copy/policy/help/refresh preference each exist once in Settings. Tray menu owns open and exit only.
- Density:4epx rhythm;4epx control corners,8epx row corners;448epx width and bounded scroll list; readable14epx text; no animations.
- State: initial/loading retains dimensions; stale quota has observation age; unavailable account switch disabled with reason; uncertain mutation enables read-only result check and preserves control lock. No replay of uncertain operations or reset credit.
- Keyboard: F5/Ctrl+R refresh, Ctrl+Shift+C copy, Ctrl+, Settings, Esc hide; native Tab/menu access and persistent focus.
- Originality: explicit current-account name plus compact quota meter pair; Windows-native restraint, no invented visual metaphor or marketing decoration.
- Acceptance: native build/screenshot/click/high-contrast proof remains pending under current Sol post-code policy; do not claim source delivery as installed new UI.

Layout
[native title/caption]
[AICC status                     pin icon]
[current account · availability]
[connections · quota observation / notice]
[account name · state]
[5h usage/reset] [long-window usage/reset]
[switch (eligible only)]              [account menu]
[quota cache age]
[refresh primary]                    [Settings]

## 공통 웹 화면 결정
웹은 연한 회녹색 배경·진한 녹색 글자·흰 작업 카드로 통일한다. 현재 계정은 테두리와 상태 문구를 함께 쓴다. 5시간·주간은 같은 척도에 사용/잔여와 초기화 남은 시간을 표시한다. 미확인을 0%로 만들지 않는다.
휴대폰: 안전 영역을 둔 고정 하단 메뉴, 44px 이상 조작, 단일 페이지 세로 스크롤. PC 960px 이상: 왼쪽 메뉴와 넓은 본문, 계정·도구 다열 카드. 긴 로그만 가로 스크롤한다. 변경 확인 창은 본문만 세로 스크롤하며 확인·취소를 하단에 유지한다.
한국어 단어 단위 줄바꿈, 긴 ID·URL 비상 줄바꿈, 시스템 글꼴, 16px 이상 입력 글꼴, 명확한 포커스·비활성 상태, reduced-motion·고대비를 보존한다. 표시 수단을 색이나 호버에만 의존하지 않는다.

## 계정 현황 밀도 개선
현재 디자인과 여섯 탐색 항목을 유지한다. 계정별 두 한도 창은 나란히 비교하고, 요약은 낮은 띠 형태로 배치한다. 주요 기능 바로가기, 펼쳐 쓰는 계정 조작, 검색·상태·정렬을 제공한다. 터치 44px와 16px 입력, 페이지 단일 세로 스크롤, 확대/포커스/비활성 대비를 유지한다. 없는 시각은 제공되지 않음 사유로 한 번만 알린다.
