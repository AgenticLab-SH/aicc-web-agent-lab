# React + Vite 구조

## 기본 디렉터리

```text
src/
├── api/
│   ├── client.js
│   └── <feature>.js
├── components/
│   ├── common/
│   │   ├── Navbar.jsx
│   │   ├── Footer.jsx
│   │   ├── Button.jsx
│   │   └── Modal.jsx
│   └── <feature>/
├── pages/
├── store/
│   ├── useAuthStore.js
│   └── useUserStore.js
├── styles/
│   └── index.css
└── main.jsx
```

기능이 작으면 빈 디렉터리를 미리 만들지 않고 실제 책임이 생길 때 추가한다.

## 글로벌 스타일

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: Pretendard, sans-serif;
  background: var(--color-bg);
  color: var(--color-text);
}
```

폰트 파일과 `@font-face`는 프로젝트의 정본 asset package를 우선하고 외부 CDN을
추가하기 전에 CSP, privacy, cache 정책을 확인한다.

## 상태 배치

| 상태 | 위치 |
|---|---|
| 인증·사용자·여러 화면의 현재 주요 선택 | Zustand store |
| form 입력·modal·dropdown·임시 선택 | component hook |
| 검색·filter·tab처럼 공유/복원이 필요한 값 | URL state |
| 원격 데이터·freshness·retry·cancellation | API/query layer |

파생 가능한 값을 store에 중복 저장하지 않는다.

## API module 계약

- 공통 client에서 base URL, header, timeout, cancellation과 표준 오류 변환을 관리한다.
- 기능별 module은 `fetchList`, `fetchDetail`, `submitForm`처럼 domain action으로 노출한다.
- page는 결과 상태를 렌더링하며 transport 세부를 알지 않는다.
- 실패 응답을 삼키거나 성공 모양의 빈 배열로 바꾸지 않는다.
