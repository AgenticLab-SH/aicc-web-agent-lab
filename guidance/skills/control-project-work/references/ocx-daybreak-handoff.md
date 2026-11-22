# OCX 일반 업무와 제한된 Daybreak 인계

사용자가 이 운영 방식을 선택한 협업 작업에 적용한다. 일반 관제·조사·구현·문서·결과 회수는 **OCX / gpt-6.1-sol / high**다. Native 현재 로그인 계정의 **gpt-6-sol / high / daybreak_blue**는 OCX로 진행하다 실제 막힌 좁은 세부 항목에만 사용한다. 그룹 전체·후속 구현 전체를 Daybreak로 넘기거나 기존 Native 문맥의 편의 때문에 계속 쓰지 않는다. OCX 연결을 끊는 독립 정비는 기존 별도 복구 계약을 따른다.

## 작은 인계와 반환

1. 기존 작업 정본에서 blocker ID·원 요청/오류·필요한 최소 입력·정확 파일/읽기 범위·산출물·완료/중단 조건을 적는다. 단순 잔여 구현이나 조사 미착수는 blocker가 아니다. 보안 거절·불명 발신·권한 부족을 Daybreak 전환으로 우회하지 않는다.
2. 먼저 정상 OCX 작업의 실제 담당과 terminal/진행 중 명령을 조정한다. 한 Git root에 한 writer. Daybreak에는 해당 blocker만 대여하고 일반 backlog·공통 구현/문서 정리는 OCX에 남긴다. 토큰을 아끼려면 필요한 근거와 질문만 보내고 한 번에 한 Daybreak slice를 기본으로 한다. 새 병렬 Daybreak는 사용자가 요구하고 잔여량이 충분할 때만 쓴다.
3. Daybreak 산출물이 나오면 원 terminal·정상 반환·실제 프로세스를 조정하고 같은 원 OCX 작업으로 후속 구현을 돌린다. 부분 변경·dirty·원본·불명 요청은 보존한다. 실행 중 같은 문맥을 다른 모델/경로로 빼앗지 않는다. 경로를 바꿔야 하면 반환 후 별도 owner-bound 인계로 한다.
4. 경로·모델·effort·access program은 실제 launch/session/turn 근거로 기록한다. 명령 접수·실제 turn·결과·설치·실사용은 별도다. 설치판 approval 계약과 on-request/auto_review를 유지한다. 원 승인 실패를 우회하지 않는다.

## 5시간 한도와 예약

- 같은 Native 로그인 계정의 공식 quota 근거에서 `limit_id`, `window_minutes=300`, used/remaining, `resets_at`, 관측 시각을 기록한다. OCX 풀 계정1이나 다른 세션/계정의 quota로 대신하지 않는다. 사용자 잔여량 제보는 제보 시점 값이며 현재 실측으로 바꾸지 않는다.
- 잔여량이 낮다는 사용자 알림 또는 실제 한도 거절이 있으면 새 Daybreak slice를 시작하지 않고 `DAYBREAK_QUOTA_WAIT`로 둔다. 일괄 확장·추론 probe·다른 계정 자동 전환 없이 일반 OCX 작업을 계속한다.
- 실제 `resets_at` 이후 기존 승인된 관제 단회 wake/정상 예약을 사용한다. 초기화 사건은 기존30분 관제와 합치며 중복 상주 감시기를 만들지 않는다. 정확 시각이 필요하면 기존 다음 trigger를 해당 사건 직후로 앞당기고, 이후 평소 주기로 복귀한다. maintenance quiet·root active·미결 queue 보호를 유지한다.
- 예정 시각 경과는 회복 증거가 아니다. 재개 전 같은 계정의 fresh 공식 quota를 얻는다. 5시간 Codex 한도, 주간 한도와 `workspace_owner_credits_depleted`는 각각 기록한다. 공식 quota 읽기 자체가 거절/불명이면 원 요청을 조정하고 Daybreak 대기를 유지한다. 새 로그인·결제·정책 변경·모델 우회로 해결하지 않는다.
- 일반 작업을 Native credits 대기에 묶지 않는다. 예산이 회복돼도 가장 작은 미완료 blocker 하나만 먼저 배정하며 완료 즉시 OCX로 반환한다. 같은 대기 조건의 무변화 보고·예약 프롬프트/전체 문맥 반복을 피한다.

## 영속 상태

새 별도 원장 대신 기존 dispatch/execution에 `defaultRoute`, `defaultModel`, `effort`, `daybreakScope`, `pendingBlockers`, `quotaObservedAt`, `quotaEvidenceRef`, `resetAt`, `resumeNotBefore`, `freshQuotaRequired`, `premiumState`, `nextOwner`, `exactThread`, `signalOrSendState`를 둔다. pending은 배정/실행이 아니다. 현재 정책의 사후 검증 제한을 그대로 따른다.