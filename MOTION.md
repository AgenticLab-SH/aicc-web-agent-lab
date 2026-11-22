# open-AICC motion contract

모션은 상태 변화를 설명하고 입력이 접수됐음을 즉시 알리는 보조 수단이다. 운영 사실, 진행률,
성공 여부를 모션만으로 표현하지 않는다.

## 성격과 기술 경계

- 성격은 차분하고 즉각적이며 정밀하고 절제되어야 한다.
- 기본 구현은 CSS만 사용하며 animation package, 원격 asset, ambient loop를 추가하지 않는다.
- 한 화면에는 원인과 결과를 잇는 evidence trace 하나만 허용한다.
- hover가 없는 touch와 keyboard에서도 같은 의미와 완료 경로를 제공한다.

## Tokens

| 역할 | 시간 | easing |
| --- | ---: | --- |
| press·focus feedback | 100–180ms | `ease-out` |
| disclosure·region transition | 180–260ms | `cubic-bezier(.2,.8,.2,1)` |
| state emphasis | 최대 400ms, 1회 | `ease-out` |

입력 feedback은 다음 frame에서 시작해야 한다. 새 입력이 오면 진행 중 모션을 즉시 중단하고 최신 상태로
수렴한다. 모션 종료를 action dispatch, journal commit, readiness 또는 success의 증거로 사용하지 않는다.

## 상태별 계약

- loading은 실제 진행률을 꾸미지 않으며 bounded timeout과 읽는 대상을 text로 알린다.
- partial, stale, offline, HOLD, UNKNOWN, UNCERTAIN은 색이나 pulse 없이도 문장으로 구분된다.
- success emphasis는 post-read 뒤 한 번만 실행하고 반복하지 않는다.
- rollback과 reconcile은 이동 방향이 아니라 명시적 label과 evidence로 구분한다.
- document가 hidden이거나 region이 offscreen이면 필수적이지 않은 animation을 멈춘다.

## Reduced motion과 접근성

`prefers-reduced-motion: reduce`에서는 travel, pulse, parallax, auto-scroll과 smooth scrolling을 제거한다.
visibility, focus order, state text, action 결과는 기본 모드와 같아야 한다. focus ring을 animation으로 숨기지
않고, dialog·disclosure 종료 후 focus를 논리적 trigger로 돌려보낸다.

## 검증

- deterministic state fixture로 loading, partial, active, UNKNOWN, ambiguous, stalled와 rollback을 본다.
- keyboard, touch, 200% zoom, 320/390/768/1440px와 reduced motion을 확인한다.
- hidden-tab과 interruption에서 loop·stale transition이 남지 않는지 확인한다.
- browser-visible PASS는 실제 candidate를 본 뒤에만 기록하며 source test로 대신하지 않는다.
