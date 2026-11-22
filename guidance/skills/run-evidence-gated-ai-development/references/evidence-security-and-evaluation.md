# 증거, 보안과 평가

## 증거 묶음

위험에 맞게 다음 중 필요한 것을 현재 revision과 연결한다.

- requirements: 목표, 제약과 acceptance criteria
- task plan: 분해, AI 위임 범위와 writer 소유권
- tests: 정상, 경계, 실패와 회귀 시나리오
- quality: lint, type, schema, dependency와 secret 결과
- decision log: 대안, 선택과 사람이 수정·승인한 이유
- retrospective: 실패, 재작업, 한계와 다음 개선

## 보안 게이트

문서, package와 runtime도 공격면으로 취급한다.

1. 도구, 경로, 계정, 데이터와 쓰기 권한을 최소화한다.
2. dependency 이름, 출처, 버전, lock, 취약점과 typosquatting을 확인한다.
3. 실행 격리와 외부 네트워크 범위를 확인한다.
4. 명령, 변경과 승인을 감사 가능하게 남긴다.
5. secret scan, 정적 보안 검사, advisory DB와 실제 구성을 함께 본다.

프롬프트의 안전 지시만으로 공급망 공격을 막았다고 주장하지 않는다.

## 평가와 지표

새 요구를 여러 올바른 구현 중 하나로 만족하고 독립 검증을 통과하는 능력을 본다. 단일 테스트보다 전체 요구사항과 회귀, 긴 작업일수록 체크포인트와 재개 가능성, self-review와 독립 검증의 분리를 확인한다.

생성량 대신 최초 통과 시간, 리뷰·디버깅·통합 시간, 재작업률, 결함 유출, 요구사항 누락, 배포 안정성과 보안·권한 위반을 측정한다.

## 상태 언어

- `LOCAL_COMPLETE`: 로컬 acceptance criteria와 검증 통과
- `REVIEW_READY`: 사람이 볼 근거 묶음 준비
- `DEPLOYED`: 실제 배포 증거 확인
- `SUBMITTED`: 실제 외부 제출 증거 확인
- `UNKNOWN`: 현재 근거로 판정 불가
- `HOLD`: 필요한 입력·권한·외부 상태가 없어 안전하게 중단

앞 단계의 성공을 다음 단계의 완료로 자동 확장하지 않는다.

## 미실행과 근거 보존

요구·계획·쓰기/전달 영수증·revision·검사·runtime·배포·사용자 동작은 각각의 근거로 판정한다. NOT_RUN은 실행하지 않은 검사 또는 단계이며 UNKNOWN·HOLD와 구분한다. source-only를 LOCAL_COMPLETE나 실제 설치·배포 통과로 바꾸지 않는다. 현재 모델 정책이 금지한 사후 검증은 다른 agent에게 넘기지 않는다. 공유 근거 묶음에 raw log·개인 기록·세션·credential을 복제하지 않는다.
