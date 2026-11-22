---
name: codex-frontend
description: 검증된 React/Vite 구성으로 반응형 UI를 구현한다. 배포·브라우저 QA 제외.
---

# Codex Frontend

프로젝트의 실제 제품 흐름과 시각 체계를 보존하며 큰 UI 변경을 구현한다. 작은 CSS 수정이나
일반 코드 설명에는 자동 적용하지 않는다.

## 시작

1. 가장 가까운 지침, `package.json`, lockfile, 현재 화면, 디자인 토큰, API 계약과 관련
   테스트만 확인한다.
2. 기존 framework, rendering, styling, state와 배포 계약을 보존한다. 사용자가 요구하지
   않은 migration이나 새 상태 관리·UI 라이브러리를 추가하지 않는다.
3. 새 React/Vite 프로젝트 또는 같은 stack의 구조 변경에만
   [React/Vite structure](references/react-vite-structure.md)를 읽는다.
4. 시각 방향·design system·reference 재구성이 핵심인 작업에만
   [design integration](references/design-integration.md)을 읽는다.
5. 새 제품의 시각 방향이나 큰 재설계가 실제로 필요한 경우에만 `establish-design-direction`으로
   프로젝트 `DESIGN.md`의 기존 결정과 새 방향을 연결한다. 확정된 사용자 디자인은 임의로
   재설계하지 않고, 구현·QA·배포 단계의 소유권은 각각 구분한다.

한영 글꼴·문구·줄바꿈·잘림은 [한영 UI 품질](../korean-ui-quality/SKILL.md)을 함께 적용한다. 기존 token·언어 정책을 보존하고 웹 구현 부분만 읽는다. 아래 검사 항목은 현재 모델 정책과 사용자의 명시 검증 범위가 허용할 때 수행한다.

## 구현

- 정보 우선순위와 핵심 행동이 desktop·mobile에서 유지되게 한다.
- 프로젝트 token과 component 체계를 재사용하고, generic dashboard filler, 과도한 카드·
  gradient·문구, 동일 정보의 반복을 넣지 않는다.
- loading, empty, error, permission, offline 등 실제로 가능한 상태를 제품 문맥에 맞게
  처리한다. 색만으로 의미를 전달하거나 핵심 정보를 hover에만 숨기지 않는다.
- 기본·비활성·선택·포커스·로딩 상태의 글자색과 배경색을 함께 정의한다. 일반 정보 글자는
  4.5:1, 큰 글자는 3:1 대비를 목표로 하고 미측정 상태를 준수 완료라 부르지 않는다.
  비활성 버튼도 이름과 불가 이유를 읽을 수 있게 한다. 부속 창에도 같은 component를 쓴다.
- 기능별로 목적·사용법·결과·불가 이유를 짧게 제공한다. 호버와 키보드 포커스 설명,
  접근성 설명을 연결하고 터치·클릭 도움말도 제공한다. 핵심 사용 순서와 오류는 항상
  보이는 곳에 둔다. disabled가 포인터/포커스를 받지 못하면 인접 설명으로 보완한다.
- 사용자 정의 설명 팝업은 닫기·포인터 이동·읽는 동안 유지를 지원한다. 긴 설명은 스크롤
  가능한 도움말로 옮기며 같은 문구를 모든 버튼에 반복하지 않는다.
- 실제 API가 필요한 기능을 임의 mock·fixture·성공 fallback으로 바꾸지 않는다.
  production과 test data의 경계를 명시한다.
- keyboard, focus, zoom, reduced motion, 긴 텍스트와 좁은 화면을 변경 범위에 맞게 확인한다.

관련 format·lint·typecheck·test·build를 실행한다. 시각 또는 상호작용 동작이 바뀌고 runnable
page가 있으면 `browser-qa`로 critical flow를 검증한다. 배포·provider·domain 변경은 이
스킬의 책임이 아니다. 최종 보고에는 구현, 실행한 검사, 브라우저 증거, 미확인만 구분한다.
