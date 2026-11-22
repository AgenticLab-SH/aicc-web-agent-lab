# 다음 웹 작업 · 날짜 일정 상세 미리보기

이 브랜치의 `web-preview/`를 열고 합성 데이터로 Android의 날짜 일정 흐름을 재현한다. 원형 호와 시간순 목록이 같은 일정 상세를 열고, 상세에서 날짜·시작/종료 시각·고정/유연을 수정하게 한다. 23:30–다음 날 00:15의 양쪽 날짜 표시, 시작·종료 동일 입력 거절, 저장 후 새로고침, 전체 삭제 후 빈 상태를 확인한다.

- Android 정의는 `DatedSchedule.kt`, `DatedScheduleEditor.kt`, `DatedScheduleStore.kt`, `RoutineHome.kt`, `RoutineClock.kt`와 `DatedScheduleTest.kt`를 읽는다. Kotlin·Gradle과 기존 WiZ·알람은 참고한다.
- 기존 미루 색상과 원형·목록 스타일을 재사용한다. 날짜 일정과 매일 반복 루틴을 구분한다. 키보드·큰 글자·좁은 화면에서 같은 정보를 읽고 조작할 수 있게 한다.
- 저장은 웹 미리보기의 합성 데이터만 사용한다. 개인 일정, 기기 설정, 실물 WiZ·알람, 외부 서비스와 연동하지 않는다.
- 작업 기준은 받은 ZIP의 정확한 Git 커밋이다. 결과로 수정 파일, 재실행 방법, 수행한 검사와 미실행 항목을 받는다. Android 반영은 Native Compose에서 별도로 인수한다.
