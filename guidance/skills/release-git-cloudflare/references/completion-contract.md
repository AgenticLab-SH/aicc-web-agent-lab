# 기록과 완료 기준

## 기록과 완료 기준

저장소의 기존 handoff, runtime report, worklog에 변화만 기록한다. 최소 기록 항목은 다음과 같다.

- KST 시각, 저장소, branch, commit SHA, remote SHA
- 공개 산출물 또는 검증 receipt의 SHA-256
- Cloudflare account와 프로젝트/Worker 이름
- deployment ID, 새 version ID, traffic 비율
- 직전 version ID 또는 rollback 대상
- 운영 검증 결과와 남은 위험

완료는 Git 원격 동기화, Cloudflare 반영, custom domain 검증이 모두 확인된 상태다. 일부만 끝났으면 완료 범위, 실패 원인, 재개 조건, 다음 주체를 명확히 남긴다.

## 웹 에이전트 경계

브라우저 전용 에이전트가 로컬 Git·Wrangler 셸을 실행할 수 없으면 AICC Workspace 같은 승인된 로컬 실행 경로를 사용한다. 그런 경로도 없으면 저장소 절대 경로, 목표 branch/commit, Cloudflare 프로젝트, 실행할 검사, 필요한 결과 필드를 포함해 로컬 에이전트에 정확히 인계한다. 웹 화면만 확인하고 push나 배포를 완료했다고 보고하지 않는다.
