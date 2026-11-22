# 매체별 디자인 실행 프로필

공통 순서는 `목적 → 원본 선택 → 구조 → 시각 언어 → 대표 장면 → 전체 적용 → native 검증`이다.
각 매체는 같은 브랜드 원리를 쓰되 literal grid와 파일 구조는 자체 adapter가 소유한다.

## Logo and brand kit

1. 브랜드명 정확 표기, 대상, 약속, 3개 성격어, 피해야 할 연상, 기존 mark, 최소 크기,
   배경, 필요한 lockup을 한 페이지 brief로 만든다.
2. `select-design-sources --surface logo`로 Logo Creator와 Open Design의 활성 원본을 찾고,
   brief→독립 variants→selection→brand kit 구조만 참고한다.
3. symbol, wordmark, combination 중 산출물 역할을 정하고, 서로 다른 3개 방향에 각각
   `핵심 은유 + geometry + type character + color behavior`를 부여한다.
4. 각 방향을 독립 이미지로 생성한다. 32px, monochrome, inverse, 가로 lockup에서 살아남는
   후보만 다음 단계로 보낸다.
5. 승인 master에서 favicon, app icon, social avatar, horizontal/stacked lockup, clear space,
   color/type note를 파생한다. 벡터 납품은 geometry/path로 다시 만들고 outline을 검사한다.
6. `generate-images-with-web-gpt`로 bitmap 시안을 생성하고, 정확한 lettering과 유사 상표
   위험은 별도 확인한다. Logo Creator의 license가 `UNKNOWN`인 동안 코드는 로컬 참고만 한다.

## Presentation / PPTX

1. 한 문장 목적, 청중, 발표 후 결정/행동, 시간, evidence inventory를 정한다.
2. 결론 중심 outline을 `hook → context → tension → evidence → decision → next action`으로 쓴다.
   각 slide에 한 takeaway와 발표자 intent를 부여한다.
3. `select-design-sources --surface presentation`으로 Presentation AI의 theme/layout/chart 구현과
   Open Design의 template 구조를 읽는다. 개인 라이브러리의 `presentation`, `cross-media`도 검색한다.
4. theme을 type pair, 5–8 semantic colors, spacing, image treatment, chart grammar, page furniture로
   정의한다. title, section, evidence, comparison, process, quote, appendix layout을 먼저 만든다.
5. 대표 3장(표지, 핵심 evidence, 복합 layout)을 native Presentations workflow로 구현·렌더한다.
   hierarchy와 projector 가독성이 맞으면 전체 deck으로 확장한다.
6. theme → master → layout → slide hierarchy와 placeholder roles를 검사하고, 모든 slide를 렌더해
   clipping, overflow, orphan, chart label, image crop, speaker note를 확인한다.

Example evidence slide:

```text
Title: 배포 시간 42% 단축
Takeaway: 승인 대기와 rollback 준비를 같은 화면에서 처리한 효과
Visual: before/after timeline with one highlighted bottleneck
Evidence: measurement window, sample count, source footnote
Speaker intent: 수치가 자동화 전부의 효과라고 과장하지 않고 범위를 설명
```

## Diagram

1. 독자가 알아야 할 관계를 sequence, hierarchy, flow, state, ownership, comparison 중 하나로 쓴다.
2. `select-design-sources --surface diagram`과 `diagram-design`의 type reference에서 해당 grammar와
   examples를 읽는다.
3. node inventory와 edge meaning을 먼저 줄이고, overview와 detail 분할 여부를 정한다.
4. project token을 paper/ink/muted/accent/link/status 역할에 매핑한다.
5. SVG/HTML의 geometry, connector, label, focus order를 구현하고 실제 크기에서 읽는다.
6. overlap, clipping, crossing, contrast, 200% zoom, mobile/slide embed를 native workflow로 확인한다.

## Word, PDF, and reports

1. 답과 근거 구조를 먼저 정하고 heading depth, body measure, table, callout, caption, footnote 역할을 만든다.
2. `word` 또는 `pdf`, `report`, `cross-media`, `visualization` 라이브러리를 검색한다.
3. 한 representative page에 title, evidence table, figure, footnote를 같이 배치해 page rhythm을 확정한다.
4. editable source의 style/master owner에서 반복 동작을 관리한다.
5. Documents/PDF native workflow로 모든 page를 렌더해 break, widow/orphan, table split, figure resolution,
   bookmark/link를 검사한다.

## Quantitative visualization

1. 질문, measure, dimension, baseline, uncertainty, comparison을 명시한다.
2. magnitude→bar, trend→line, distribution→histogram/box, relationship→scatter처럼 관계에 맞는 encoding을 고른다.
3. annotation은 가장 중요한 변화·예외·결정 지점에 연결하고 source/denominator/time window를 가까이 둔다.
4. color는 series identity와 semantic status를 분리하고 grayscale/contrast에서도 읽히게 한다.
5. 완성 figure를 실제 slide, report, web container 안에서 다시 검증한다.

## URL or screenshot reconstruction

1. 사용자의 재현 권한과 공개 관찰 범위를 확인한다.
2. AI Website Cloner 원본의 skill을 참고해 desktop/mobile frame, grid, type scale, spacing,
   responsive priority, interaction state를 evidence table로 기록한다.
3. 로고·고유 copy·미디어·private data를 권리 있는 프로젝트 자산으로 매핑한다.
4. 현재 프로젝트 stack과 semantic component로 구조부터 구현한다.
5. matching viewport visual comparison 후 keyboard, console, network, loading/error를 각각 검증한다.

## Multi-format output

1. canonical content source와 stable frame을 하나 정한다.
2. replaceable design layer에 type/color/shape/image/motion 규칙을 둔다.
3. web, PPTX, DOCX, PDF, image, video adapter가 literal grid, units, structure, render를 소유하게 한다.
4. hierarchy, evidence, access, status meaning, rights는 모든 adapter에서 invariant로 검사한다.
5. editable source와 rendered output을 구분하고, 실제로 검증한 format만 완료로 보고한다.

자세한 계약은 [cross-media contract](cross-media-contract.md)를 따른다.
