# 이미지 프롬프트 계약

## 정본

- [Codex 이미지 생성](https://developers.openai.com/codex/image-generation)
- [GPT Image 모델 프롬프팅 가이드](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide)

공식 문서가 바뀌기 쉬운 모델명, 인증, 사용량, 입력 제한을 판단할 때는 위 원문을 다시
확인한다. 현재 모델명·인증·입력 제한·사용량은 실제 제공된 도구 계약이나 당시 공식 문서로 판단하며 과거 확인값을 현재 사실로 사용하지 않는다.

## 프롬프트 구조

필요한 줄만 사용한다.

```text
Use case: <ui-mockup | photo | illustration | product-mockup | edit>
Asset type: <사용 위치와 대상 사용자>
Primary request: <주요 대상과 동작>
Input images: <Image 1의 역할; Image 2의 역할>
Scene/backdrop: <공간과 배경>
Style/medium: <현실적 UI, 사진, 3D, 일러스트 등>
Composition/framing: <viewport, 비율, 시점, 주요 요소 배치>
Lighting/mood: <빛의 방향과 분위기>
Color palette: <핵심 색과 대비>
Materials/textures: <재질과 표면>
Text (verbatim): "<정확히 표시할 문구>"
Constraints: <반드시 유지할 조건>
Avoid: <금지 요소>
```

## 작성 원칙

- 목적과 대상 사용자를 먼저 적고, 주요 대상·동작·공간·구도·스타일 순서로 구체화한다.
- 빛, 크기, 색, 재질, framing이 성공 조건이면 수치나 위치를 명시한다.
- 모호한 감탄사 대신 빛의 방향, 표면, 밀도, 여백처럼 보이는 언어를 쓴다.
- 편집은 `change only X; keep Y unchanged`를 매 iteration 반복한다.
- 정확한 텍스트는 따옴표로 묶고 추가 글자를 금지한다. 화면 구현용 mock은 긴 본문보다
  실제 hierarchy와 spacing을 우선한다.
- 레퍼런스는 이미지 번호와 역할을 명시한다. 특정 작가·브랜드·저작물의 복제 대신
  허용된 고수준 속성을 추출하고 결과를 독창적으로 만든다.
- 첫 결과 뒤에는 전체 프롬프트를 갈아엎지 말고 한 가지 변경만 요청한다.
