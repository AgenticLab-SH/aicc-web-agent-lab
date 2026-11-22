# 인증 상세

## 인증

- Git은 운영체제의 Git Credential Manager 등 이미 설정된 credential helper를 재사용한다. 토큰을 명령줄, 파일, 문서, 채팅에 기록하지 않는다.
- Windows 서비스/SSH의 Session0에서 `gh auth status`가 실패하면 로그인된 사용자 세션의 기존 실행 경로에서 같은 gh 실행 파일·OS 사용자·설정 경로와 `gh api user`, 해당 Git 원격 읽기를 비교한다. keyring의 현재 세션 접근 실패를 계정 전체의 인증 부재로 보고하거나 사용자가 완료한 device login을 되풀이하지 않는다. CLI 인증과 Git helper는 별도다. CLI가 정상인데 helper 선택창이 멈추면 공식 `gh auth git-credential`을 사용하는 해당 명령의 일회 credential helper로 기존 인증을 재사용할 수 있다. 토큰 복사·새 credential 저장·전역 helper 덮어쓰기는 하지 않는다.
- Windows에서 Git이 `dubious ownership`을 보고하면 실제 저장소 절대 경로와 소유자를 확인한 뒤 그 저장소 하나만 `safe.directory`에 등록한다. 상위 폴더나 wildcard를 등록하지 않는다.
- Cloudflare는 먼저 `npx.cmd wrangler whoami`로 현재 계정과 권한을 확인한다. macOS/Linux에서는 `npx wrangler whoami`를 사용한다.
- 인증이 없고 사용자가 해당 배포나 로그인을 승인한 경우에만 `wrangler login`을 실행한다. OAuth 완료 후 `whoami`를 다시 읽는다. Wrangler가 제공하는 암호화 저장소와 운영체제 credential manager를 사용하며 토큰을 별도 복사하지 않는다.
- 계정 ID와 프로젝트/Worker 이름이 기존 운영 설정과 일치하지 않으면 배포를 멈추고 불일치를 보고한다.

