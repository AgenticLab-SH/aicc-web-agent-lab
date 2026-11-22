# 디자인 통합 실행법

## 원본 선택과 역할 분담

웹 작업을 시작할 때 프로젝트 `DESIGN.md`를 읽고, 필요한 원본을 역할별로 선택한다.

| 필요 | 원본 | 구현에 적용하는 방법 |
| --- | --- | --- |
| 화면 위계와 세련된 마감 | Impeccable | `layout`으로 공간 구조, `typeset`으로 서체 위계, `colorize`로 의미 색, `critique`와 `polish`로 한 번씩 검증한다. |
| 접근 가능한 UI primitive | shadcn/ui | 현재 React/Tailwind 버전과 맞는 컴포넌트 소스를 참고하고, 키보드·focus·dialog state를 보존한 채 프로젝트 token으로 구성한다. |
| 큰 디자인 시스템/카탈로그 | Open Design | token, component family, template, export 경계를 프로젝트 규모에 맞게 가져온다. 앱/daemon 전체가 아니라 현재 산출물에 필요한 구조를 읽는다. |
| URL·스크린샷 재구성 | AI Website Cloner | 관찰 가능한 정보 구조·간격·반응형 우선순위를 측정하고 현재 stack의 component로 다시 구현한다. |

`establish-design-direction/scripts/select-design-sources.mjs`가 반환하는 active snapshot과
recommended path를 사용하면 원본 커밋이 바뀌어도 어떤 자료를 참고했는지 재현할 수 있다.

## 세련된 화면을 만드는 8단계

1. **한 문장 위계**: 사용자가 5초 안에 알아야 할 상태와 해야 할 행동을 한 문장으로 적는다.
2. **공간 구조**: 화면을 named composition으로 잡는다. 예: evidence spine, split-stage,
   operational cockpit, editorial rail. 첫 viewport와 긴 데이터 상태를 같이 설계한다.
3. **타입 역할**: display, body, label, data/code의 family·size·weight·line-height를 토큰으로
   고정한다. 한국어 본문은 실제 문장 길이로 확인한다.
4. **의미 색**: canvas/surface/text/accent/transport/success/warning/danger를 정하고, accent는
   핵심 행동과 현재 선택에 집중한다.
5. **리듬**: 4 또는 8 기반 간격을 쓰되 section, group, control의 세 수준을 구분한다. border,
   radius, depth는 같은 계층에 같은 규칙을 적용한다.
6. **컴포넌트 상태**: 기본·hover·focus·disabled·loading·empty·partial·error를 함께 만든다.
   상태마다 다음 행동과 복구 문구를 제공한다.
7. **반응형 적응**: 넓은 화면의 우선순위를 좁은 화면에서도 유지한다. side panel은 sheet,
   dense table은 summary row + detail, multi-column action은 primary-first stack으로 바꾼다.
8. **마감 루프**: desktop/mobile screenshot을 한 번에 보고 hierarchy → readability → state →
   spacing 순서로 배치 수정한다. 다시 screenshot과 keyboard/console/network로 확인한다.

## shadcn/ui 적용 예

1. `components.json`, Tailwind/React 버전, 현재 primitive와 token을 확인한다.
2. 필요한 동작 단위만 선택한다. 예: update selector라면 Checkbox + Dialog + Button + Badge.
3. source diff와 dependency를 읽고 프로젝트 안에서 소유할 component로 추가한다.
4. focus trap, Escape, label, disabled, loading 동작을 먼저 통과시킨다.
5. `DESIGN.md`의 색·밀도·type·radius를 적용하고 제품 고유 copy와 hierarchy를 넣는다.
6. MIT notice와 새 dependency license를 제품 notice에 기록한다.

## 화면 품질 검토

화면을 아래 다섯 질문으로 읽고, 발견한 문제를 실제 route/selector/line과 수정안으로 기록한다.

1. 가장 중요한 상태와 행동이 크기·위치·대비로 한 번에 보이는가?
2. section, group, control이 서로 다른 spacing과 surface 계층으로 읽히는가?
3. 장식 요소가 제품 데이터·작업·원인 관계를 설명하는가?
4. 본문, label, code, status가 실제 길이와 좁은 화면에서도 읽히는가?
5. empty/loading/error/permission/offline 상태가 다음 행동까지 제공하는가?

각 수정은 `DESIGN.md`의 시각 thesis를 더 잘 표현해야 한다. 접근성·overflow·동작 결함은
별도 기능 finding으로 검증한다.

## URL·스크린샷 재구성 순서

1. 재현 권한과 공개 관찰 범위를 확인한다.
2. desktop과 mobile에서 frame, grid, type scale, spacing, responsive priority, interaction을 측정한다.
3. 로고·고유 copy·미디어·private data는 프로젝트가 권리를 가진 대체 자산과 문구로 매핑한다.
4. 현재 프로젝트 component와 API 경계 안에서 semantic 구조부터 구현한다.
5. 동일 viewport 비교 후 keyboard, console, network, loading/error를 검증한다.
6. 시각 유사성, 기능 동작, 데이터 정합성, 접근성 결과를 각각 보고한다.
