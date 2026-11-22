# open-AICC 공개 작업본

이 브랜치는 AICC 앱과 Windows 트레이의 공개 개발용 스냅샷입니다. 합성 목록과 상태로 실제 HTML/CSS/JS를 편집하고 검증할 수 있습니다.

    npm ci --ignore-scripts
    npm run check:lab
    npm test
    npm run preview

브라우저에서 [AICC 미리보기](http://127.0.0.1:4173/mobile.html#overview)를 엽니다. Windows의 합성 검사 전체는 PowerShell 7에서 **npm run verify:windows**로 실행합니다. **npm run preview -- 4174**로 미리보기 포트를 지정할 수 있습니다. Node.js 22 이상이 필요합니다.

- 합성 API는 loopback에만 연결하며 예시 세션·CSRF·단회 확인을 메모리에서 재현합니다. 합성 진단과 원 결과 조회를 제공하며 외부 전송·페어링·계정 변경을 거절합니다. 각 상태를 확인할 입력은 [공개 작업 범위](docs/web-agent-lab.md)를 보세요.
- Windows 트레이 소스·Android Gradle 프로젝트·기존 서버와 테스트는 수정할 수 있습니다. 기본 테스트는 공개 스냅샷만으로 실행할 수 있습니다. 운영 설치·서명·공용 서비스 중단은 소유자가 별도 절차로 처리합니다.
- 실제 사용자 상태, 운영 백업·로그, 서명 APK와 키, 비공개 어댑터를 제외했습니다. [제품 명세](docs/dashboard-product-spec.md) · [공개 작업 범위](docs/web-agent-lab.md)

## 최종 구조

```text
Codex Desktop -> Web GPT bridge 17841 -> ChatGPT Web (Web 모델 추론)
                 |                         |
                 |                         \-> Web GPT 작업 하네스 전용 Tunnel
                 |                             -> 현재 Codex 작업의 도구 하네스
                 \-> OCX 10100 (Web 외 모델 전달)

Native Codex profile -> OpenAI 공식 Codex 경로 (복구·독립 사용)

외부 ChatGPT -> AICC 원격 작업공간 전용 Tunnel -> AICC 원격 작업공간 MCP
                                             -> 등록 Git 워크스페이스
```

Codex Desktop에서는 `Web / 임시|저장 / 낮음~매우 높음` 모델을 선택해 ChatGPT
Web을 추론 백엔드로 쓸 수 있습니다. Web 모델의 추론은 OCX나 로컬 Codex 모델
토큰을 사용하지 않습니다. 브라우저 전용 모드는 문맥·이미지만 전달하고, 별도 MCP
설정을 마친 전체 하네스 모드에서만 현재 Codex 작업의 파일·터미널·승인·도구를
사용합니다. 이 전용 Tunnel은 외부 ChatGPT용 `AICC 원격 작업공간 MCP` Tunnel과 다른
런타임입니다. 두 경로를 한 Tunnel ID로 재사용하지 않습니다. 외부 ChatGPT에서
로컬을 편집하는 별도 경로는 `AICC 원격 작업공간 MCP`가 담당하며 Codex 작업을
생성하거나 OCX를 호출하지 않습니다.

제품 문서는 [open-AICC 문서 홈](docs/README.md)에서 한 번에 찾을 수 있습니다.
안정된 사용 계약은 [현재 사용 계약](docs/current-state-and-usage.md)을 따르고,
이 checkout의 특정 owner 설치 live 검증 상태는 [context/PROJECT.md](context/PROJECT.md)와
owner-private 운영 원장에서 관리합니다. `C:\demo\projects\ai-platform`은 목표 구조와 acceptance를
관리하며 현재 runtime 값을 복제하지 않습니다.

이 문서의 **지피티**는 ChatGPT Web 일반 Chat, **코덱스**는 로컬 CLI·Desktop입니다.
전체는 **AI 협업 환경**, 묶음은 **지피티 구성자산**과 **코덱스 구성자산**으로 부릅니다.
용어·역할·동시 작업·보관 규칙의 정본은 [공통 운영 계약](docs/agent-context-optimization.md)입니다.
일반 Chat은 실제 연결된 AICC Workspace 도구·권한으로 파일 읽기·쓰기·명령·스킬·적용을
우선 맡고, 코덱스는 실제 미지원·미해결 부분을 잇습니다. Work 모드는 사용하지 않습니다.
기술 설정의 `chatgpt-web/*`·17841은 별도의 모델 실행 경로이며 일반 Chat과 혼동하지 않습니다.
Codex Desktop 인앱 Browser는 실제 제공되는 별도의 UI 조작 수단입니다.

Workspace MCP는 공식 Tunnel이 고정 STDIO 서버를 실행하며, 임의 절대 경로 대신
등록된 워크스페이스 별칭과 승인된 grant를 사용합니다. 파일·명령은 선택 작업공간의
실제 권한과 설치된 OS별 격리 경로에 한정됩니다. Windows와 macOS의 실행 계약은
[현재 사용 계약](docs/current-state-and-usage.md)에서 시작합니다.
일반 파일/명령 도구는 Codex 작업을 자동 생성하지 않으며, 명시적으로 등록된 Codex CLI
도구는 별도 owner binding 안에서만 실행합니다. [Codex CLI 운영 절차](docs/runbooks/workspace-codex-cli.md)를 따릅니다.

Business 쓰기 도구와 Personal 읽기 전용 surface는 앱·Tunnel·state·게시 계약을 구분합니다.
읽기 전용 연결을 쓰기 권한으로 해석하지 않습니다. 도구 개수와 사용 가능성은 옛 숫자 대신
현재 도구 목록·게시 영수증·실제 요청 결과로 판단합니다. [프로젝트 현재](context/PROJECT.md)는
소스·설치·원격 적용·실제 동작·미실행을 나눠 기록합니다.

