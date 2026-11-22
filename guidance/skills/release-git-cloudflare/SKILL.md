---
name: release-git-cloudflare
description: 검증된 Git 커밋을 기존 Cloudflare Workers 또는 Pages 프로젝트에 배포·검증한다. 신규 도메인·요금제·credential 발급에는 사용하지 않는다.
---

# Git·Cloudflare 출시

검증된 소스와 공개 산출물만 기존 Git 원격과 기존 Cloudflare 프로젝트에 반영한다. Git push, Cloudflare 배포, 운영 확인, 복구 지점을 한 작업으로 추적하되 각 단계의 성공을 따로 증명한다.

## 시작 전 확인

1. 저장소에서 가장 가까운 `AGENTS.md`, 배포 문서, hosting profile, `wrangler.toml` 또는 `wrangler.jsonc`, package scripts를 읽는다. 저장소 규칙이 이 스킬의 일반 절차보다 우선한다.
2. `git status --short --branch`, `git remote -v`, `git log -n 5 --oneline`으로 현재 branch, HEAD, remote, dirty 파일을 확인한다. 다른 사람이나 다른 작업의 변경은 수정·stage·commit하지 않는다.
3. 배포 대상이 Workers인지 Pages인지 설정 파일, 기존 배포 기록, Cloudflare의 실제 상태로 확인한다. 이름이 비슷하다는 이유로 추정하지 않는다.
4. 사용자 요청이 운영 반영을 포함하는지 확인한다. 이미 승인된 push와 기존 프로젝트 배포는 이어서 수행한다. 신규 결제, 신규 도메인, provider 이전, 복구 어려운 삭제, 권한 확대는 별도 승인이 필요하다.

명령은 저장소의 절대 경로를 작업 디렉터리로 지정해 실행한다. 현재 셸 위치에 의존하는 `cd` 연쇄는 사용하지 않는다.

## 인증

이 단계는 [상세 절차](references/authentication.md)를 읽고 수행한다.

## 출시 준비

1. 기존 Cloudflare deployment, version, traffic, route 또는 Pages deployment를 새로 읽는다. 현재 운영 version을 rollback 후보로 기록한다.
2. 저장소가 지정한 검사와 빌드를 실행한다. 공개 allowlist export 절차가 있으면 그 산출물만 배포 입력으로 사용한다.
3. 공개 산출물에서 source map, 비밀값, credential, 사용자 데이터, 내부 문서, 로컬 절대 경로를 검사한다. 금지 항목이 발견되면 배포하지 않는다.
4. Wrangler dry run 또는 저장소의 동등한 검사로 실제 entrypoint, assets, compatibility date, bindings를 확인한다. production binding이 preview나 staging을 가리키지 않는지 본다.
5. `git diff --check`와 필요한 테스트를 통과시킨다. 실패한 검사는 원인과 영향이 해결되기 전까지 성공으로 처리하지 않는다.

## Git 반영

1. 승인된 파일만 stage한다. 큰 dirty tree에서는 파일별 diff와 staged diff를 다시 읽는다.
2. commit 후 `git show --stat --oneline HEAD`로 포함 범위를 확인한다.
3. 정확한 branch를 정확한 remote에 push한다. push 결과와 원격 branch SHA가 로컬 commit SHA와 같은지 확인한다.
4. push 성공을 Cloudflare 배포 성공으로 간주하지 않는다.

## Cloudflare 반영

- 저장소의 기존 배포 명령을 우선한다. 임의로 Workers와 Pages 방식을 바꾸지 않는다.
- Workers는 기존 script/config로 upload 또는 deploy하고, 필요한 경우 version traffic을 명시적으로 전환한다. 배포 후 deployment ID, 새 version ID, traffic 비율, 직전 version ID를 읽는다.
- Pages는 정확한 프로젝트와 production branch를 확인한 뒤 검증된 output directory만 `pages deploy`한다. deployment URL과 production 상태를 읽는다.
- 동일 결과를 얻기 위해 업로드를 반복하지 않는다. 출력이 끊기거나 cleanup이 실패하면 먼저 Cloudflare의 deployment/version 목록을 다시 읽고 실제 반영 여부를 판정한다.

## 운영 검증

배포 직후 다음을 좁게 확인한다.

- DNS, TLS, HTTPS와 custom domain이 예상 프로젝트를 가리키는지
- release marker나 핵심 asset의 hash가 배포한 산출물과 같은지
- 홈과 핵심 경로가 정상 응답하는지, 보호 API가 예상된 `401` 또는 `403`을 반환하는지, 존재하지 않는 경로가 실제 `404`인지
- 모바일과 데스크톱의 핵심 흐름, console error, 실패한 network 요청
- Workers면 현재 traffic이 새 version에 원하는 비율로 연결됐는지, Pages면 production deployment가 새 배포인지

운영 주소를 과도하게 반복 호출하지 않는다. 한 단계의 성공 로그만으로 전체 출시 완료를 주장하지 않는다.

## 기록과 완료 기준

출시 전 [완료·인계 계약](references/completion-contract.md)을 읽는다. Git 원격 동기화, 배포 반영, 운영 주소 확인을 각각 증명하고 기존 정본에 변화만 기록한다.
