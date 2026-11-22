# 참고 자료와 도입 경계

2026-10-21 사용자의 가이드를 기존 UI 스킬과 비교해 정리했다. 아래는 공식 참고 링크다. 외부 스킬 본문·데이터셋·실행 코드를 복제하거나 설치한 패키지는 없다.

- [Pretendard](https://github.com/orioncactus/pretendard): 기준이 없는 한영 콘텐츠 폰트 후보. 실제 배포 파일·license·로딩은 프로젝트별로 판단한다.
- [Windows typography](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography): 시스템형 UI의 Windows 기본 타이포그래피 보존.
- [MDN overflow-wrap](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow-wrap): 긴 문자열의 비상 줄바꿈. 본문·코드·표의 공백 계약은 구분한다.
- [WCAG resize text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html): 내용·기능을 잃지 않는 200% 글자 확대.
- [WCAG reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html): 320 CSS px 폭 재배치와 본질적인 2차원 콘텐츠 예외.

## 선택적 도입

UI UX Pro Max는 여러 플랫폼의 디자인 참고 후보다. 기존 제품 설계·Windows·웹 스킬과 중복되므로 전체 설치·기존 스킬 교체를 기본값으로 삼지 않는다. [원 저장소](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)의 지원 범위와 MIT 표시는 조사 시 확인했지만 코드·데이터는 채택하지 않았다. 실제 도입 시 version/commit·license·채택 범위와 충돌을 먼저 고정한다.

Vercel Web Interface Guidelines·Anthropic Frontend Design은 기존 설계/검토 스킬의 정본·채택 이력을 우선한다. Style Dictionary는 여러 플랫폼에 동일 token을 반복 배포할 필요가 확인될 때 고려하며 단일 화면 수정의 의존성으로 추가하지 않는다. Playwright 시각 비교도 선택 사항이다. SUIT·JetBrains Mono 등의 실제 파일·license는 도입 시 공식 배포처에서 확인한다.

이 링크는 조사 출처이며 런타임/CI에서 mutable main 지침을 자동 다운로드하라는 지시가 아니다. 외부 자산 업데이트는 기존 `manage-upstream-assets`와 현재 검증 정책을 따른다.
