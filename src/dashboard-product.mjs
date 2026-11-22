const journeys = Object.freeze([
  {
    id: 'overview', index: '01', stage: 'start', accent: 'copper', statusComponent: 'dashboard',
    title: '전체 상태를 한눈에 파악하기', eyebrow: 'CONTROL PLANE',
    outcome: '정상 경로는 유지하고 확인이 필요한 구성 요소만 찾습니다.',
    when: '작업을 시작할 때, 업데이트 후, 또는 어느 경로가 문제인지 확실하지 않을 때 사용합니다.',
    prerequisites: ['open-AICC 로컬 대시보드가 실행 중', '조회 대상 CLI와 서비스는 설치된 범위에서만 판정'],
    steps: ['상단 준비율과 주의 대기열을 확인합니다.', '주의 항목의 읽기 전용 점검을 먼저 실행합니다.', '상세 구역에서 버전·소유자·경로 근거를 확인합니다.'],
    success: '주의 항목이 0이거나, 각 비정상 항목의 정확한 원인과 다음 조치가 표시됩니다.',
    recovery: '새로고침 실패는 다른 구역을 지우지 않습니다. 전체 상태 확인을 다시 실행하고 실패한 구역만 진단합니다.',
    section: 'home', toolIds: ['dashboard', 'status', 'setup-check', 'cli-status', 'compatibility-status']
  },
  {
    id: 'projects', index: '02', stage: 'start', accent: 'green', statusComponent: 'project-catalog',
    title: '프로젝트·아이디어 우선순위 보기', eyebrow: 'PROJECT LEDGER',
    outcome: 'Notion 수명주기·우선순위와 로컬 소스·런타임 근거를 덮어쓰지 않고 한 원장에 투영합니다.',
    when: '오늘 진행할 프로젝트를 고르거나 Notion과 로컬 구조 사이의 DRIFT를 확인할 때 사용합니다.',
    prerequisites: ['허용된 로컬 프로젝트 루트', 'owner-only Notion 읽기 snapshot', 'title 추측이 아닌 명시 ID mapping'],
    steps: ['프로젝트 필터에서 활성·아이디어·DRIFT를 구분합니다.', '수명주기·진척도·정본 상태와 다음 행동을 확인합니다.', '우선순위 변경은 preview한 뒤 미전송 outbox 기록만 확인합니다.'],
    success: '각 항목이 LOCAL_ONLY·NOTION_ONLY·DRIFT·IN_SYNC 중 하나로 분리되고 외부 write 없이 다음 행동을 고를 수 있습니다.',
    recovery: 'Notion과 로컬 값을 자동 병합하지 않습니다. 충돌을 DRIFT로 보존하고 정확한 ID mapping과 current snapshot을 다시 확인합니다.',
    section: 'projects', toolIds: []
  },
  {
    id: 'knowledge-review', index: '03', stage: 'operate', accent: 'blue', statusComponent: 'knowledge-review',
    title: '공식 OpenAI·Anthropic 지식 점검하기', eyebrow: 'OFFICIAL KNOWLEDGE',
    outcome: '공식 registry만 조건부로 수집하고 변경 후보를 owner-only durable evidence로 남깁니다.',
    when: 'API·Codex·Plugins·Workspace Agents·Anthropic 문서의 누적 변경을 검토할 때 사용합니다.',
    prerequisites: ['exact official host와 path registry', 'manual preview와 요청 상한 확인', '자동 적용이 꺼진 durable job'],
    steps: ['공식 source와 예상 최대 요청 수를 preview합니다.', '확인한 범위만 durable queue에 넣습니다.', 'run manifest와 후보를 검토하고 source·guidance·Wiki·Skill·MCP 적용은 별도로 결정합니다.'],
    success: '조건부 요청·checkpoint·content hash·run artifact가 기록되고 automaticApply는 계속 false입니다.',
    recovery: '403·429·robots·부분 실패를 우회하지 않습니다. 실패한 source만 HOLD하고 성공한 source의 checkpoint는 보존합니다.',
    section: 'manual-reviews', toolIds: []
  },
  {
    id: 'local-access', index: '04', stage: 'connect', accent: 'amber', statusComponent: 'local-access',
    title: '정확한 로컬 루트와 Codex session 읽기 승인하기', eyebrow: 'EXPLICIT READ GRANT',
    outcome: 'whole-home 편의 별칭 없이 exact root·TTL·denylist·redaction으로 제한된 읽기 권한만 엽니다.',
    when: '등록 Git workspace 밖의 자료나 Codex session metadata·제한 발췌가 실제로 필요할 때 사용합니다.',
    prerequisites: ['사용자가 입력한 정확한 절대 루트', 'include·deny·TTL preview', 'session 원문은 별도 1회용 approval'],
    steps: ['루트와 source 유형, include·deny·TTL을 입력합니다.', 'path escape·symlink·민감 경로 거부 결과를 포함한 preview를 확인합니다.', '필요한 grant만 발급하고 session 발췌는 UUID와 byte·line·turn 상한을 다시 승인합니다.'],
    success: 'grant가 exact root와 audit hash에 묶이고 write·권한 확대·approval replay가 거부됩니다.',
    recovery: 'TCC·Keychain·브라우저·인증 경로를 우회하지 않습니다. 범위를 줄여 새 grant를 preview하거나 HOLD합니다.',
    section: 'manual-reviews', toolIds: []
  },
  {
    id: 'web-gpt', index: '02', stage: 'work', accent: 'violet', statusComponent: 'web-gpt',
    title: 'Codex에서 Web GPT 사용하기', eyebrow: 'CHATGPT WEB MODELS',
    outcome: 'Codex Desktop의 파일·터미널·도구를 유지한 채 ChatGPT Web을 추론 모델로 사용합니다.',
    when: 'Codex 모델 선택기에서 Web / 임시·저장 / 추론 수준 모델을 사용하려는 경우입니다.',
    prerequisites: ['17841 브리지 정상', 'Codex Web GPT 로그인', 'Full 하네스와 전용 Tunnel 준비'],
    steps: ['Web GPT 상태와 노출 모델을 확인합니다.', 'Codex 모델 선택기에서 원하는 Web 모델을 선택합니다.', '현재 프로젝트에서 평소처럼 요청하고 완료·도구 결과를 확인합니다.'],
    success: '모델 목록이 노출되고 브라우저 턴이 완료되며 현재 프로젝트의 도구 결과가 반환됩니다.',
    recovery: 'Web GPT 점검 → 남은 Web 작업 확인 → 해당 경로만 복구합니다. OCX와 Native 경로는 유지합니다.',
    section: 'web-gpt', toolIds: ['web-gpt', 'web-gpt-doctor'], taskIds: ['web-gpt.doctor']
  },
  {
    id: 'orchestration', index: '03', stage: 'work', accent: 'violet', statusComponent: 'job-manager',
    title: '여러 Web GPT 역할로 협업하기', eyebrow: 'ROLE DAG ORCHESTRATION',
    outcome: '한 상위 작업이 연구자·비판자·writer·verifier를 필요한 만큼 나누고 결과를 안전하게 합칩니다.',
    when: '독립 조사, 대안 비교, 코드 변경과 검증처럼 한 모델의 한 번 답변보다 역할 분리가 유리할 때 사용합니다.',
    prerequisites: ['chatgpt-web/* Full 모드', '현재 턴에 광고된 orchestration 도구', '정확한 프로젝트 경계와 최대 한 명의 writer'],
    steps: ['작업 설계기에서 “여러 Web GPT 협업”을 선택합니다.', '역할·도구·쓰기 범위를 확인한 뒤 Codex에 생성된 요청을 전달합니다.', '실행 현황에서 역할 완료, 단일 writer, verifier와 cleanup을 확인합니다.'],
    success: '역할 결과와 근거가 구조화되고 정확히 하나의 writer 변경을 독립 verifier가 확인한 뒤 active run과 lease가 0이 됩니다.',
    recovery: '실패한 역할과 UNKNOWN을 보존합니다. 다른 provider나 계정으로 몰래 우회하지 않고 소유 run만 취소·정리합니다.',
    section: 'task-planner', toolIds: ['orchestration-status', 'codex-agents', 'browser-status'], taskIds: ['jobs.status', 'agents.status', 'browser.status']
  },
  {
    id: 'ocx', index: '04', stage: 'work', accent: 'cyan', statusComponent: 'ocx',
    title: 'OCX 계정·모델 라우팅하기', eyebrow: 'MULTI-PROVIDER ROUTING',
    outcome: '새 Codex 작업이 사용할 OCX 계정과 provider를 기존 작업을 훼손하지 않고 관리합니다.',
    when: '계정 할당량을 분리하거나 OCX 모델 catalog를 갱신해야 할 때 사용합니다.',
    prerequisites: ['10100 OCX 상태 확인', '활성 작업 수가 알려짐', 'AICC가 관리하는 계정 선택지'],
    steps: ['OCX 운영 센터에서 provider·모델·작업 수를 확인합니다.', '계정 또는 연결 변경의 미리보기를 엽니다.', '영향·경고·롤백을 읽고 한 번만 확인합니다.'],
    success: '10100이 정상이고 새 작업의 선택 계정·catalog가 의도와 일치합니다.',
    recovery: 'OCX 독립 진단을 실행하고, 활성 작업이 0일 때만 시작·동기화·중지를 수행합니다.',
    section: 'ocx-console', toolIds: ['codex-ocx', 'ocx', 'ocx-accounts', 'ocx-account-switch', 'ocx-account-import', 'ocx-start', 'ocx-sync', 'ocx-stop', 'ocx-diagnostics'], taskIds: ['ocx.diagnostics'], actionNames: ['ocx.start', 'ocx.sync', 'ocx.stop', 'ocx.account.use', 'ocx.account.import-cm']
  },
  {
    id: 'workspace', index: '05', stage: 'connect', accent: 'green', statusComponent: 'workspace-mcp',
    title: '외부 ChatGPT에서 로컬 프로젝트 사용하기', eyebrow: 'REMOTE WORKSPACE MCP',
    outcome: '폰이나 웹 ChatGPT에서 등록한 Git 작업공간의 고정 도구를 안전하게 사용합니다.',
    when: 'Codex Desktop 밖에서 이 Mac의 승인된 프로젝트를 읽거나 작업해야 할 때 사용합니다.',
    prerequisites: ['등록 workspace_id', '로컬 MCP와 Secure Tunnel 정상', 'ChatGPT 앱의 게시 snapshot 일치'],
    steps: ['등록 프로젝트와 Tunnel 상태를 확인합니다.', '게시 사전검사에서 도구 수와 hash를 확인합니다.', 'ChatGPT에서 AICC Workspace 앱을 선택하고 만료 lease 범위 안에서 작업합니다.'],
    success: 'Tunnel이 준비되고 게시 snapshot이 일치하며 고정 도구가 등록 작업공간에서만 동작합니다.',
    recovery: '게시 사전검사로 로컬·원격 snapshot 차이를 확인합니다. 임의 경로나 다른 browser 계정으로 우회하지 않습니다.',
    section: 'workspace', toolIds: ['workspace-mcp', 'workspace-publish'], taskIds: ['workspace.status', 'workspace.publish-preflight']
  },
  {
    id: 'accounts', index: '06', stage: 'configure', accent: 'amber', statusComponent: 'accounts',
    title: '계정 경계를 안전하게 관리하기', eyebrow: 'ACCOUNT BOUNDARIES',
    outcome: '기본 GPT Desktop 계정과 OCX 라우팅 계정을 혼동 없이 분리해 확인합니다.',
    when: '새 작업의 계정을 바꾸거나 인증 상태가 예상과 다른 경우입니다.',
    prerequisites: ['계정 목록 조회 성공', '전환 대상 확인', '재시작 영향과 활성 작업 확인'],
    steps: ['기본 계정과 OCX 계정 영역을 구분해 현재 선택을 확인합니다.', '대상을 선택하고 변경 내용 미리보기를 엽니다.', '재시작·새 작업 적용 범위와 롤백을 확인합니다.'],
    success: '선택 계정이 의도한 영역에만 반영되고 다른 계정의 인증 파일은 변경되지 않습니다.',
    recovery: '계정 전환을 반복하지 말고 상태를 다시 읽습니다. 인증 파일이나 DB를 직접 복사·편집하지 않습니다.',
    section: 'accounts', toolIds: ['auth-portal', 'accounts', 'account-switch'], actionNames: ['account.switch']
  },
  {
    id: 'activity', index: '07', stage: 'operate', accent: 'green', statusComponent: 'job-manager',
    title: '진행 중 작업과 결과 확인하기', eyebrow: 'ACTIVITY & EVIDENCE',
    outcome: '내구 작업, 역할 run, writer, 브라우저 lease와 검증 산출물을 한곳에서 확인합니다.',
    when: '작업이 오래 걸리거나 여러 역할·브라우저·재시작을 거친 뒤 실제로 끝났는지 확인할 때 사용합니다.',
    prerequisites: ['AICC Private Home 무결성', '작업·산출물 저장소', '조회 가능한 agent와 browser broker 상태'],
    steps: ['실행 현황에서 active job·writer·run을 확인합니다.', 'agent와 browser lease가 의도한 범위인지 확인합니다.', '완료 작업의 artifact와 cleanup 상태를 읽기 전용으로 검증합니다.'],
    success: '완료 작업은 검증 산출물을 가지며 active writer와 소유 lease가 정리되고 중복 작업이 없습니다.',
    recovery: '상태가 UNKNOWN이면 완료로 간주하지 않습니다. 상담용 진단 묶음을 만들고 작업 소유 범위만 조사합니다.',
    section: 'activity', toolIds: ['orchestration-status', 'browser-status', 'codex-agents'], taskIds: ['jobs.status', 'browser.status', 'agents.status']
  },
  {
    id: 'recovery', index: '08', stage: 'recover', accent: 'red', statusComponent: 'codex-routes',
    title: '고장 난 경로만 진단하고 복구하기', eyebrow: 'FAILURE ISOLATION',
    outcome: 'Web GPT, OCX, Native, Workspace 중 정상 경로를 보존하고 실패한 구성 요소만 복구합니다.',
    when: '502, stream disconnect, catalog 불일치 또는 특정 로컬 포트 장애가 발생했을 때 사용합니다.',
    prerequisites: ['모델 경로 상태 조회', '활성 turn 수의 정확한 값', 'Native rescue 준비 여부'],
    steps: ['모델 경로 점검과 해당 구성 요소 진단을 실행합니다.', '주의 대기열에서 소유자·활성 작업·권장 조치를 확인합니다.', '필요할 때만 미리보기와 롤백이 있는 단일 복구 작업을 실행합니다.'],
    success: '문제가 난 경로가 정상화되고 다른 생존 경로의 PID·상태가 유지됩니다.',
    recovery: '상태가 UNKNOWN이면 중지·재시작하지 않습니다. 상담용 진단 묶음을 복사해 독립 경로에서 분석합니다.',
    section: 'troubleshoot', toolIds: ['routes-status', 'support-bundle'], taskIds: ['routes.status', 'support.bundle'], actionNames: ['codex.web-gpt.cancel-turns', 'codex.web-gpt.recover', 'codex.native.recover', 'codex.bridge.reconnect']
  },
  {
    id: 'api-guard', index: '09', stage: 'operate', accent: 'blue', statusComponent: 'openai-usage',
    title: 'OpenAI API 사용량을 예측하고 제한하기', eyebrow: 'COST & POLICY GUARD',
    outcome: '원시 API key를 프로젝트에 배포하지 않고 모델 정책과 공유 token 풀을 관리합니다.',
    when: 'API 호출을 시작하기 전, 무료 대상 catalog를 확인하거나 사용량이 임계치에 가까울 때 사용합니다.',
    prerequisites: ['Keychain 소유 key', 'AICC gateway', '공식 eligibility와 실호출 결과 구분'],
    steps: ['호출 전 estimate로 예상 token을 확인합니다.', '허용 모델·기본 모델·계정 실호출 상태를 검토합니다.', '80% 경고, 90% 자동 정지, 95% 하드 차단을 모니터링합니다.'],
    success: '허용된 모델만 AICC gateway로 호출되고 프로젝트별 원장과 공유 풀 사용량이 갱신됩니다.',
    recovery: '공식 catalog와 계정 접근을 다시 확인합니다. 가드 우회나 원시 key 배포로 실패를 숨기지 않습니다.',
    section: 'openai-usage', toolIds: []
  },
  {
    id: 'maintenance', index: '10', stage: 'operate', accent: 'slate', statusComponent: 'guidance',
    title: '설치·지침·확장 기능 유지하기', eyebrow: 'PLATFORM MAINTENANCE',
    outcome: 'AICC 정본, 배포된 지침, 하위 에이전트와 호환성 상태를 일관되게 유지합니다.',
    when: 'AICC 업데이트 후, 새 기능 설치 후, 또는 Codex·Claude 동작이 서로 다를 때 사용합니다.',
    prerequisites: ['AICC canonical source', '관리 대상 manifest', '변경 전 plan과 호환성 canary'],
    steps: ['설치·CLI·호환성 상태를 읽기 전용으로 확인합니다.', '지침 plan에서 대상별 변경과 제외 항목을 확인합니다.', '관리 명령으로만 배포하고 check를 다시 실행합니다.'],
    success: '정본과 대상 배포가 일치하고 제외된 기능·소유하지 않은 파일은 보존됩니다.',
    recovery: '생성된 home을 직접 편집하지 않습니다. 소유 manifest와 백업을 이용해 정확한 대상만 복구합니다.',
    section: 'system', toolIds: ['codex', 'claude', 'codex-agents', 'codex-plugins-status', 'cli-setup', 'guidance-check', 'guidance-manage', 'extensions-status', 'compatibility-status', 'terminal-tabs'], taskIds: ['agents.status', 'codex.plugins.status', 'guidance.check', 'extensions.status', 'compatibility.status']
  }
]);

const flows = Object.freeze([
  { id: 'daily', label: '일상 작업', description: '상태 확인 → 프로젝트 선택 → Web GPT 작업 → 결과 확인', journeyIds: ['overview', 'projects', 'web-gpt', 'activity'] },
  { id: 'team', label: '여러 AI 협업', description: '상태 확인 → 역할 분할 → 독립 검증', journeyIds: ['overview', 'web-gpt', 'orchestration', 'activity'] },
  { id: 'provider', label: 'OCX·계정', description: '상태 확인 → 계정 확인 → OCX 경로 사용', journeyIds: ['overview', 'accounts', 'ocx', 'activity'] },
  { id: 'remote', label: '외부 ChatGPT', description: '상태 확인 → 명시 권한 → Workspace 연결 → 원격 결과 확인', journeyIds: ['overview', 'projects', 'local-access', 'workspace', 'activity'] },
  { id: 'recover', label: '문제 복구', description: '상태 확인 → 원인 분리 → 고장 난 경로만 복구', journeyIds: ['overview', 'recovery', 'activity'] },
  { id: 'operate', label: '운영 관리', description: '상태 확인 → 공식 지식·비용·업데이트·확장 점검', journeyIds: ['overview', 'projects', 'knowledge-review', 'activity', 'api-guard', 'maintenance'] },
  { id: 'all', label: '전체 보기', description: '모든 기능을 목적별 분류로 확인', journeyIds: journeys.map(journey => journey.id) }
]);

const glossary = Object.freeze([
  { term: 'Web GPT', meaning: 'Codex Desktop에서 선택하는 chatgpt-web/* 모델과 17841 브리지. 인앱 브라우저 조작과 다릅니다.' },
  { term: 'OCX', meaning: '10100에서 여러 provider·계정을 새 Codex 작업에 라우팅하는 독립 서비스입니다.' },
  { term: 'Native rescue', meaning: '17841과 OCX를 거치지 않는 공식 OpenAI Codex 복구 경로입니다.' },
  { term: 'Workspace MCP', meaning: '외부 ChatGPT에서 등록한 로컬 Git 작업공간만 사용하는 고정 도구 서버입니다.' },
  { term: 'UNKNOWN', meaning: '안전하게 판정할 근거가 없는 상태입니다. 0이나 정상으로 간주하지 않습니다.' },
  { term: '미리보기', meaning: '변경 전 현재 상태·영향·경고·롤백을 묶은 짧은 수명의 일회용 확인 단계입니다.' }
]);

export function dashboardProductSpec({ actions = [], tasks = [] } = {}) {
  return {
    schemaVersion: 2,
    name: 'Luminous Control Ledger',
    promise: '프로젝트, 독립 AI 경로, current 근거와 수동 승인을 한 원장에서 분리해 보고 필요한 조치만 안전하게 실행합니다.',
    flows: flows.map(flow => ({ ...flow, journeyIds: [...flow.journeyIds] })),
    journeys: journeys.map(journey => ({ ...journey, prerequisites: [...journey.prerequisites], steps: [...journey.steps], toolIds: [...journey.toolIds], taskIds: [...(journey.taskIds || [])], actionNames: [...(journey.actionNames || [])] })),
    glossary: glossary.map(item => ({ ...item })),
    inventory: { actionCount: actions.length, taskCount: tasks.length }
  };
}

export function documentedToolIds() {
  return new Set(journeys.flatMap(journey => journey.toolIds));
}
