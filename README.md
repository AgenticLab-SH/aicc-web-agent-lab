# AICC Web Agent Lab

공개 웹 에이전트와 UI 코드를 주고받기 위한 실행 가능한 샘플입니다. 모든 예시 앱·상태·루틴은 합성 데이터입니다. 저장소는 설치 없이 실행되며, 외부 API나 로그인 연결이 없습니다.

```sh
python -m http.server 4173 --bind 127.0.0.1
node --test
```

| 대화 | 바꿀 폴더 | 시작 화면 | 작업 지시 |
| --- | --- | --- | --- |
| AICC 모바일 홈·내 앱 | `aicc-mobile/` | `/aicc-mobile/` | [AICC 작업 지시](aicc-mobile/BRIEF.md) |
| 미루 오늘·원형 시간표 | `miru-routine/` | `/miru-routine/` | [미루 작업 지시](miru-routine/BRIEF.md) |

한 대화는 한 폴더를 맡습니다. 결과 ZIP에는 맡은 폴더의 전체 소스와 `HANDOFF.md`(기준 SHA, 변경 파일, 실행 방법, 실제 검증, 남은 일)를 넣어 주세요. 화면 캡처를 함께 넣어도 됩니다. GitHub 쓰기 권한이나 로컬 PC 접근은 필요하지 않습니다.
