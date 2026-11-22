# 하네스와 오케스트레이션

## 실행 기판

에이전트 성능은 다음 요소가 함께 결정한다.

```text
모델 x 명세와 context x 도구와 권한 x 환경 x 피드백과 검증
```

강한 모델이 약한 환경·권한·검증을 보완한다고 가정하지 않는다.

## Context

- 가장 가까운 지침, 공식 요구사항, 실제 코드와 현재 런타임을 우선한다.
- 오래된 README, 생성물과 다른 프로젝트 예시는 보조 근거로 표시한다.
- 필요한 파일만 읽고 비밀·세션·개인 데이터는 context에 넣지 않는다.
- 긴 작업은 결정, 완료, 미착수, `HOLD`·`UNKNOWN`과 재개점을 짧게 남긴다.

## 도구와 권한

- 읽기와 진단을 먼저 하고 쓰기 범위를 좁힌다.
- 설치 전 package 이름, registry, 버전, lockfile과 알려진 취약점을 확인한다.
- 네트워크, 삭제, 계정, 배포와 결제를 별도 경계로 취급한다.
- sandbox 해제나 권한 확대로 실패를 숨기지 않는다.

## 관측과 메모리

명령, 변경 파일, 테스트 출력, 실패 원인과 사람 승인을 현재 revision에 연결한다. 로그는 비밀을 가리고 오래된 성공 로그를 최신 변경의 증거로 재사용하지 않는다.

## 다중 에이전트

- 독립적인 조사나 구현만 병렬화한다.
- 각 writer에게 파일 또는 책임 소유권을 준다.
- 공유 worktree의 다른 변경을 되돌리지 않게 한다.
- 각 결과에 diff와 검증 근거를 요구한다.
- 최종 통합자가 전체 테스트와 설계 일관성을 다시 확인한다.

여러 에이전트가 같은 결론을 내는 것은 독립 검증이 아니다. 다른 데이터나 검사로 확인한다.

## 조직 도입

도구 구매보다 repository instructions, 완료 조건, 허용 도구·권한, CI 품질·보안 게이트, 실패·재작업·결함·리뷰 시간과 책임자의 최종 승인을 먼저 표준화한다. 한 사람이 모든 결과를 수동 검토하는 병목에는 위험 기반 리뷰와 자동 검증을 조합한다.

## Native 부모 목표의 지원 접점과 소비 권위

공식 App Server의 `thread/goal/get` 지원, 설치된 binary schema/allowlist, 실제 호출과 Native 부모 소비 권위는 별개다. goal getter가 있어도 exact owner/session·goal incarnation·scope·최신 revision·단조 stop epoch와 one-use 소비/CAS 계약이 없으면 localtracker나 COOPERATIVE 원장으로 대체하지 않는다. 실제 seam과 최소 계약은 기존 [PK02 명세](../../../../specs/delegation-completion-resume/spec.md#pk02-공식-goal-reader와-권위-연결-seam--2026-10-29)에 둔다. 네이티브의 pause→resume/clear→replace 이력을 단순 ACTIVE나 timestamp로 축약하지 않는다. UNKNOWN은 권위 복구 전까지 유지하며 원 ACK의 exact 조회를 새 effect로 재생하지 않는다. 이 계약 확인을 독립 Native 실행이나 반복 source 검증의 근거로 사용하지 않는다.
