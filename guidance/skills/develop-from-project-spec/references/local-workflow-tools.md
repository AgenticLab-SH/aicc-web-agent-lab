# 로컬 개발 보조 도구

기존 개발 흐름 안에서 필요한 도구만 선택한다. 해커톤 `sh-workflows`의 범용 부분을 흡수했으며 시험 운영·전용 UI·서버·MCP 등록·모델 실행·자동 설치는 포함하지 않는다. 기존 README/SPEC/current와 실제 사용자 지시를 기준으로 쓰고 별도 Workroom 문서 체계를 만들지 않는다.

## 실행

이 스킬의 `scripts/workflow-tools/`에 Python 표준 라이브러리 스크립트가 있다. 도구 절대경로와 승인된 입력 파일을 지정한다. 현재 작업 폴더를 키트로 옮길 필요가 없다. Windows 출력은 `PYTHONIOENCODING=utf-8`로 지정하고 `python -B`를 사용하면 캐시 생성을 피할 수 있다. 전역 Python/환경 설정은 바꾸지 않는다.

| 필요 | 도구와 인수 | 결과·한계 |
|---|---|---|
| CSV 품질 | `audit_csv.py <file.csv> --required id,date --unique id` | 행수·결측·중복·형식 요약. 원본/행 값 변경 없음 |
| JSON 필수 키 | `validate_json.py <file.json> --required version,name` | 구조 검사이며 JSON Schema 전체 검사가 아님 |
| JSON 변경 확인 | `compare_json.py <before.json> <after.json>` | 값 대신 변경 경로/종류. 키/경로도 민감할 수 있음 |
| 분류 품질 | `metrics.py <labels.csv> --actual actual --pred predicted --positive yes` | 분모와 혼동행렬·지표, 정의 불가 비율은 null |
| 현업 질문 후보 | `question_candidates.py <file.csv> --examples 0 --format json` | 결측·단위·키 충돌 등 결정 초안. 정답/전송/확정 아님 |
| 질문 원장 | `question_ledger.py lint <ledger.csv>` / `summary <ledger.csv>` / `next <ledger.csv> --format json` | 기존 CSV를 읽어 미결·구체적 질문을 정리, 메시지 자동 전송 없음 |
| 문맥 크기 | `context_budget.py --root <approved-root> --budget 12000` | 파일 내용 없이 크기/추정 토큰. 실제 모델 tokenizer/한도·절감량 아님 |
| 작은 최적화 | `opt_kit.py demo` / `assign --costs <matrix.csv> --capacities 2,2,1` | 기준선·정확해 비교용. 목적/제약을 제품이 결정하며 운영 주문/작업 실행 없음 |

실행 전 각 명령의 `--help`로 현재 옵션을 확인한다. 종료 0/1/2의 의미는 도구별 도움말·결과를 따른다. CSV 필수 검사 실패와 실행 자체 실패를 구분한다. 읽는 파일은 승인 범위로 한정하고 출력은 기존 비공개 작업 근거에 남긴다. 원격 전송·로그인·계정 변경은 없다. 입력 파일/디렉터리 이름과 질문 맥락은 출력될 수 있으므로 비밀 파일을 넣거나 결과를 그대로 공개하지 않는다. 질문 후보는 기본 예시 대신 `--examples 0`으로 시작한다. 링크/크기 제한은 접근 권한을 대신하지 않는다.

원장 CSV 헤더: `id,category,priority,context,question,status,answer,decision,test_case`. 실제 답변과 가정을 구별하고 기존 원장이 있으면 그것을 쓴다. 도구 출력을 사용자 확인으로 승격하지 않는다.

## 기존 스킬과 결합

요구/현업 질문·업무/데이터·방법 선택·작업 분해·구조 설명·기능별 검토/인계는 `develop-from-project-spec`에 통합한다. 질문·서지·방법 선택 카드 전체를 반복 작성하지 않고 필요한 연결만 기존 명세에 남긴다.

병렬/goal/비용·workflow는 `control-project-work`, `run-deadline-work`, `codex-web-low-token-workflow`를 재사용한다. 독립 writer와 원 요청·UNKNOWN·정식 자동재개 계약을 보존한다. 키트의 별도 goal·MCP·subagent 실행기를 등록하지 않는다.

프런트/UI·접근성·한영 표현·실제 화면 검증은 `codex-frontend`, `korean-ui-quality`, `browser-qa`를 따른다. 시험 환경의 '참가자만 Browser 사용' 문안을 로컬 앱 전체에 이식하지 않는다. 저장 파일/편집기 충돌은 현재 dirty·미저장 상태를 보호한다.

외부 리서치는 `evidence-first-web-research`, 보안/운영 변경은 기존 해당 운영 스킬, 개인 글은 `write-as-demo-owner`를 쓴다. 시험 대비 말하기/답안·제출·감독 기능은 일반 Codex 기본 기능으로 설치하지 않는다. 실제 사용을 종료한 도구나 옛 공개 유지 규칙을 되살리지 않는다.

테스트 설계는 완료 기준·위험에서 필요한 검사만 고른다. 반례 생성/축소는 기존 프로젝트가 이미 쓰거나 이번 요구로 필요할 때만 그 프로젝트의 의존성 계약으로 채택한다. 이 묶음은 Hypothesis를 설치하지 않는다.

원본·라이선스·파일 SHA는 `scripts/workflow-tools/provenance.json`과 `LICENSE`에 있다. 원 저장소가 비공개로 바뀌어도 출처·MIT 고지는 보존한다. 도구 복사/홈 배포와 실제 제품 적용·사용자 성공은 별도다.
