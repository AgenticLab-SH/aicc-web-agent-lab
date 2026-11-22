---
name: general-report-design
description: 근거 중심 구성과 형식 QA로 편집 가능한 범용 Markdown/DOCX/PDF 보고서를 설계한다.
---

# General Report Design

브랜드가 확정되지 않은 업무·기술·분석·프로젝트 보고서에 재사용할 정보 구조, 한국어
보고서체와 시각 프리셋을 정한다. 이 스킬은 내용을 꾸며내지 않으며 파일 형식별 생성 도구를
대신하지 않는다.

## 경계와 라우팅

1. 가장 가까운 프로젝트 지침, 공식 제출 양식, 기존 템플릿과 디자인 정본을 먼저 확인한다.
2. 프로젝트 전용 보고서 시스템이 있으면 그것을 사용한다. SKALA 과제는 checkout-local
   `build-skala-assignment-submission`의 `SKALA Report Design`을 우선한다.
3. 분석과 계산은 Data Analytics가 맡고, 이 스킬은 분석 결과의 정보 위계와 표현을 맡는다.
4. DOCX는 Documents, PDF는 PDF, 차트는 Data Analytics visualization, 관계 도식은
   `diagram-design`과 결합한다. 렌더 통과를 다른 형식의 통과로 확대하지 않는다.
5. 사용자가 제공한 공식 템플릿은 기본 프리셋보다 우선한다. 작은 편집을 재디자인으로
   확대하지 않는다.

## 입력 확정

다음을 확인하고, 찾을 수 없는 값만 `UNKNOWN`으로 둔다.

- 독자, 목적과 독자가 내려야 할 판단
- 편집 정본과 최종 형식: Markdown, DOCX, PDF 또는 조합
- 필수 섹션, 페이지 제한, 제출명, 로고·폰트·색상 권리
- 사실, 데이터, 출처, 실행 결과와 현재 제한
- 기존 템플릿·스타일·개인 디자인 라이브러리의 적용 가능한 원칙

새로운 시각 방향이 필요한 경우 등록된 개인 디자인 라이브러리의 `report`, `pdf`, `word`,
`cross-media`를 먼저 검색한다. 적합한 항목이 없으면 [General Report Design](references/general-report-design.md)을
기본값으로 사용한다. 레퍼런스는 취향의 증거이지 복제 허가가 아니다.

## 정본 작성

편집 가능한 정본을 먼저 만든다. 새 Markdown은 [report-template.md](assets/report-template.md)를
출발점으로 사용하되, 문서 목적에 맞지 않는 절은 삭제하거나 이름을 바꾼다.

보고서 전체에서 다음 역할을 식별할 수 있게 한다.

- 맥락과 범위
- 핵심 결론 또는 확인할 질문
- 수행·분석 방법
- 결과와 근거
- 해석, 제한과 불확실성
- 결정, 다음 조치 또는 남은 질문

섹션 수를 맞추기 위해 내용이나 문제를 만들지 않는다. 문체를 새로 쓰거나 크게 바꿀 때는
[근거 중심 보고서체](references/evidence-centered-report-voice.md)를 적용한다.

## 디자인 적용

1. 한 페이지에 하나의 주된 설명 역할을 둔다.
2. 제목, 본문, 표, 그림, 캡션과 출처가 같은 읽기 축을 공유하게 한다.
3. 표는 반복 비교에, 목록은 실제 순서·집합에, 콜아웃은 결론·위험·결정에만 사용한다.
4. 장식보다 본문과 근거를 먼저 읽게 한다. 색만으로 상태나 차이를 전달하지 않는다.
5. 페이지 크기, 여백, 제목 계층, 본문 크기, 표·그림 규칙과 페이지 번호를 문서 전체에서
   일관되게 유지한다.

세부 기본값과 예외는 [general-report-design.md](references/general-report-design.md)를 따른다.

## 검증과 전달

1. `scripts/validate_report_markdown.py`로 Markdown 메타데이터, 플레이스홀더, 이미지 경로와
   로컬 절대 경로 노출을 검사한다.
2. 최종 형식의 전문 워크플로로 모든 페이지를 렌더링한다.
3. 제목·표·코드·이미지·캡션의 잘림, 겹침, 빈 페이지, 고아 제목과 흐린 이미지를 확인한다.
4. PDF는 텍스트 선택·추출, 페이지 수, 파일 크기와 링크를 확인한다. DOCX는 네이티브 제목,
   목록, 표와 편집 가능성을 확인한다.
5. 편집 정본과 렌더 결과를 구분하고, 실행하지 않은 검사는 `HOLD` 또는 `UNKNOWN`으로 남긴다.

## 트리거 경계

새 요청에서 이 스킬과 인접 스킬이 겹치면 [trigger-evals.md](references/trigger-evals.md)의
positive, near-miss negative와 handoff를 적용한다.
