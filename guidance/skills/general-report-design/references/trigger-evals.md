# General Report Design 트리거 평가

## Positive

- "일반 업무 보고서에 계속 쓸 디자인과 문체를 정해줘."
- "이 Markdown 보고서를 같은 스타일의 DOCX와 PDF로 만들 수 있게 구조를 잡아줘."
- "브랜드 가이드가 없으니 전문적인 기술 보고서 디자인을 적용해줘."
- "보고서 문체를 자연스러운 습니다체로 통일하고 표·그림 규칙도 정해줘."

## Near-miss negative

- "매출 데이터를 분석해서 경영 보고서를 작성해줘." → 분석은 `data-analytics:build-report`가 먼저 소유하고, 시각 프리셋이 필요할 때 이 스킬을 함께 사용한다.
- "이 DOCX의 오탈자 한 줄만 고쳐줘." → Documents가 소유한다.
- "이 PDF 두 개를 합쳐줘." → PDF가 소유한다.
- "아키텍처 다이어그램을 SVG로 만들어줘." → `diagram-design`이 소유한다.
- "SKALA 과제 보고서를 작성해줘." → SKALA checkout-local `build-skala-assignment-submission`이 소유한다.
- "우리 회사의 브랜드 시스템을 새로 정해줘." → `establish-design-direction`이 먼저 소유한다.

## Handoff

- 디자인 라이브러리 검색은 `manage-design-library`, 프로젝트 고유 방향 결정은
  `establish-design-direction`, 일반 보고서 기본 프리셋은 이 스킬이 맡는다.
- 분석 결과와 수치는 Data Analytics에서 받고, 이 스킬은 정보 위계·보고서체·페이지 구성으로
  전달한 뒤 Documents 또는 PDF가 최종 파일을 생성·검증한다.
- 사용자 제공 템플릿이 있으면 이 스킬의 토큰을 덮어쓰고 정보 구조·문체·검증 원칙만 적용한다.
