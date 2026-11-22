import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectCodexDesktopTransport } from './codex-desktop-transport-diagnostics.mjs';
import { inspectNativeCallbackSafety, inspectWebGptReleaseMatrix } from './codex-callback-safety.mjs';
import { sanitize } from './lib/redact.mjs';

const execFileAsync = promisify(execFile);
const MARKDOWN_FILE = 'AICC-WEB-GPT-RECOVERY.md';
const JSON_FILE = 'aicc-web-gpt-recovery.json';
const MANIFEST_FILE = 'manifest.json';
const BUNDLE_ID = /^[0-9TZ]+-[a-f0-9]{12}$/;
const SUPPORT_WORKER = fileURLToPath(new URL('./recovery-support-worker.mjs', import.meta.url));
const MIRROR_MARKDOWN_FILE = 'LATEST.md';
const MIRROR_JSON_FILE = 'LATEST.json';
const MIRROR_MANIFEST_FILE = 'LATEST.manifest.json';
export const DEFAULT_RECOVERY_SUPPORT_TIMEOUT_MS = 15_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function aliasHome(value, home) {
  if (typeof value === 'string') return value.split(home).join('~');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => aliasHome(item, home));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, aliasHome(item, home)]));
}

function ownerSafe(value, home) {
  return aliasHome(sanitize(value), home);
}

function ensureOwnerDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writeOwnerFile(file, content) {
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
}

function replaceOwnerFile(file, content) {
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function compactTimestamp(iso) {
  return iso.replace(/[-:.]/g, '');
}

async function withinTimeout(operation, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function collectSupportIsolated(timeoutMs) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [SUPPORT_WORKER], {
      timeout: Math.max(250, timeoutMs - 250),
      maxBuffer: 1_048_576,
      killSignal: 'SIGTERM'
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') {
      return {
        ok: false,
        state: 'UNKNOWN_SUPPORT_COLLECTION_TIMEOUT',
        generatedAt: new Date().toISOString(),
        timeoutMs,
        components: [],
        attention: ['support-collection-timeout'],
        privacy: { credentialsIncluded: false, rawOutputIncluded: false }
      };
    }
    throw error;
  }
}

function statusComponent(support, id) {
  return support?.components?.find(component => component.id === id) ?? null;
}

function workspaceRouteSummary(component) {
  if (!component) return { state: 'UNKNOWN' };
  return {
    state: component.state ?? 'UNKNOWN',
    surfaceProfile: component.surfaceProfile ?? null,
    serverReady: component.serverReady ?? null,
    workspaceCount: component.workspaceCount ?? null,
    runtimeReady: component.remoteAuthority?.runtimeReady ?? null,
    runtimeReasons: Array.isArray(component.remoteAuthority?.runtimeReasons)
      ? [...component.remoteAuthority.runtimeReasons]
      : [],
    activeLeases: component.remoteAuthority?.activeLeases ?? null,
    tunnel: component.tunnel ? { ...component.tunnel } : null,
    publication: component.publication ? { ...component.publication } : null
  };
}

function sectionBody(text, name) {
  const lines = String(text).split(/\r?\n/);
  const header = `[${name}]`;
  const start = lines.findIndex(line => line.trim() === header);
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start + 1, end).join('\n');
}

export function inspectCodexRootOnlyContainment(options = {}) {
  const home = options.home ?? os.homedir();
  const configFile = options.configFile ?? path.join(home, '.codex', 'config.toml');
  try {
    const text = fs.readFileSync(configFile, 'utf8');
    const features = sectionBody(text, 'features');
    const dedicated = sectionBody(text, 'features.multi_agent_v2');
    const agents = sectionBody(text, 'agents');
    const inline = features.match(/^\s*multi_agent_v2\s*=\s*\{([^}]*)\}/m)?.[1] ?? '';
    const scalarV2 = features.match(/^\s*multi_agent_v2\s*=\s*(true|false)\b/m)?.[1] ?? null;
    const v2Body = dedicated || inline;
    const v1Disabled = /^\s*enabled\s*=\s*false\b/m.test(agents);
    const v2Declared = scalarV2 !== null || Boolean(dedicated || inline);
    const v2Disabled = scalarV2 === 'false'
      || /(?:^|,)\s*enabled\s*=\s*false\b/m.test(v2Body)
      || (!v2Declared && options.v2DefaultEnabled !== true);
    const v2TotalLimitMatch = v2Body.match(/(?:^|,)\s*max_concurrent_threads_per_session\s*=\s*(\d+)/m)
      ?? v2Body.match(/^\s*max_concurrent_threads_per_session\s*=\s*(\d+)/m);
    const v2TotalLimit = v2TotalLimitMatch ? Number(v2TotalLimitMatch[1]) : null;
    const rootOnly = v1Disabled && v2Disabled;
    return {
      ok: rootOnly,
      state: rootOnly ? 'ROOT_ONLY_CONTAINMENT_ACTIVE' : 'ROOT_ONLY_CONTAINMENT_NOT_PROVEN',
      configSource: normalizePublicPath(configFile, home),
      v1AgentsDisabled: v1Disabled,
      v2FeatureDisabled: v2Disabled,
      v2FeatureDeclared: v2Declared,
      v2DefaultAssumedDisabled: !v2Declared && options.v2DefaultEnabled !== true,
      v2TotalThreadLimit: v2TotalLimit,
      strategy: rootOnly ? 'ALL_LOCAL_MULTI_AGENT_SURFACES_DISABLED' : 'NOT_PROVEN',
      appliesToNewSessions: true,
      rollbackCondition: 'restore concurrency only after an updated Desktop/App Server build passes the same current JSONL stress canary',
      rawConfigIncluded: false
    };
  } catch (error) {
    return {
      ok: false,
      state: 'UNKNOWN_CONTAINMENT_CONFIG_UNREADABLE',
      configSource: normalizePublicPath(configFile, home),
      error: error.message,
      rawConfigIncluded: false
    };
  }
}

export function buildRecoveryPayload({ support, transport, containment, nativeSafety, releaseMatrix, generatedAt, home = os.homedir(), projectsRoot }) {
  const webGpt = statusComponent(support, 'web-gpt');
  const webGptRescue = statusComponent(support, 'web-gpt-rescue');
  const workspaceBusiness = statusComponent(support, 'workspace-mcp-business') ?? statusComponent(support, 'workspace-mcp');
  const workspacePersonal = statusComponent(support, 'workspace-mcp-personal');
  const browser = statusComponent(support, 'browser-broker');
  const routes = statusComponent(support, 'codex-routes');
  const resolvedProjectsRoot = projectsRoot ?? process.env.AICC_WORKSPACE_PROJECTS_ROOT?.trim() ?? path.join(home, 'dev', 'projects');
  const aiPlatformRoot = path.join(resolvedProjectsRoot, 'ai-platform');
  return ownerSafe({
    schemaVersion: 2,
    generatedAt,
    purpose: '모든 로컬 연결 통로가 실패했을 때 Web GPT에 전달하는 비밀 제외 open-AICC 복구 자료',
    evidenceBoundary: '이 문서는 생성 시점의 로컬 읽기 결과다. historical/source/test를 current runtime PASS로 대체하지 않는다.',
    safety: {
      ownerOnlyAtRest: true,
      credentialsIncluded: false,
      tokensIncluded: false,
      cookiesIncluded: false,
      browserProfilesIncluded: false,
      conversationBodiesIncluded: false,
      rawDesktopLogsIncluded: false,
      prohibitedActions: [
        'active 또는 UNKNOWN 작업을 종료해 idle을 만들지 않는다',
        '정상인 17841, 17842, 10100, browser, auth, Docker, Mac을 함께 재시작하지 않는다',
        'provider, account, workspace, browser profile을 조용히 바꾸지 않는다',
        '기존 app 또는 rollback 자료를 삭제하지 않는다'
      ]
    },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      sourceWorkspace: aiPlatformRoot,
      publicCore: path.join(aiPlatformRoot, 'repos', 'open-AICC'),
      controlState: '~/.ai-control-center',
      codexState: '~/.codex',
      ocxState: '~/.opencodex'
    },
    routeTopology: {
      integratedWebGpt: {
        port: 17841,
        state: webGpt?.healthy === false ? 'UNKNOWN' : webGpt?.state ?? 'UNKNOWN',
        configuredState: webGpt?.state ?? 'UNKNOWN',
        healthy: webGpt?.healthy ?? null,
        version: webGpt?.version ?? null,
        active: {
          http: webGpt?.activeHttpTurns ?? null,
          browserHttp: webGpt?.activeBrowserHttpTurns ?? null,
          browser: webGpt?.activeBrowserTurns ?? null
        }
      },
      directWebGptRescue: {
        port: 17842,
        state: webGptRescue?.operationalState ?? webGptRescue?.state ?? 'UNKNOWN',
        version: webGptRescue?.version ?? null,
        active: webGptRescue?.active ? { ...webGptRescue.active } : null,
        requiredIndependence: 'separate runtime and browser-only auth'
      },
      ocxDirect: { port: 10100, state: statusComponent(support, 'ocx')?.state ?? 'UNKNOWN' },
      nativeDirect: { state: routes?.nativeReady === true ? 'ready' : 'UNKNOWN', dependency: 'does not depend on 17841 or 10100' },
      workspaceMcp: {
        state: workspaceBusiness?.state ?? 'UNKNOWN',
        workspaceCount: workspaceBusiness?.workspaceCount ?? null,
        toolCount: workspaceBusiness?.publication?.toolCount ?? null,
        needsPublish: workspaceBusiness?.publication?.needsPublish ?? null
      },
      workspaceSurfaces: {
        business: workspaceRouteSummary(workspaceBusiness),
        personal: workspaceRouteSummary(workspacePersonal)
      },
      browserGate: {
        state: browser?.state ?? 'UNKNOWN',
        activeTaskTargets: browser?.activeTaskTargets ?? null
      }
    },
    currentSupport: support,
    desktopTransport: transport,
    desktopContainment: containment,
    nativeCallbackSafety: nativeSafety,
    webGptReleaseMatrix: releaseMatrix,
    recoveryOrder: [
      '문서 generatedAt과 현재 시각을 비교하고 오래됐으면 current 상태를 다시 수집한다',
      '17841, 17842, 10100, Native, Workspace MCP를 별개 구성요소로 판정한다',
      'Desktop 재시작이나 same-task callback 전 Native compact route와 inactive Web GPT journal을 확인한다',
      'launcher embedded runtime, owner config, durable service와 LaunchAgent release가 하나인지 확인한다',
      '같은 17841 owner에서 active_http_turns, active_browser_http_turns, active_browser_turns가 연속 exact 0/0/0인지 먼저 확인한다',
      'browser broker active target 0과 active Codex task 0이 확인되기 전에는 종료, 재시작, drain을 하지 않는다',
      '고장 난 구성요소만 복구하고 rollback hash와 기존 앱을 보존한다',
      '복구 뒤 새 로그의 JSONL parse error 0과 공식 task API 응답을 확인한다',
      '현재 build의 root-only containment는 새 build가 같은 stress canary를 통과하기 전까지 해제하지 않는다',
      'source test나 historical evidence 대신 fresh runtime/browser acceptance를 수행한다'
    ],
    safeReadOnlyCommands: [
      'aicc status --json',
      'aicc task run routes.status --json',
      'aicc task run browser.status --json',
      'aicc task run workspace.status --json',
      'aicc task run support.bundle --json',
      'aicc codex-desktop status --json',
      'aicc web-gpt doctor --json',
      'aicc web-gpt rescue status',
      'aicc native-rescue status',
      'ocx health --json'
    ],
    mutationRule: '변경은 exact owner와 exact-zero gate, preview, backup, rollback, postcondition이 모두 있을 때만 한 구성요소에 적용한다.',
    requestToWebGpt: [
      '확인 사실, 강한 추론, UNKNOWN을 분리해라.',
      '정상 구역은 유지하고 실패 구역 하나의 가장 작은 안전 조치만 제안해라.',
      '각 조치 전에 필요한 read-only preflight와 rollback을 먼저 적어라.',
      'same-task callback의 terminal status가 completed가 아니면 전달 성공으로 판정하지 마라.',
      '이 문서에 없는 계정, 토큰, 포트 owner, 브라우저 profile은 추측하지 마라.',
      '사용자에게 명령 실행을 요구할 때는 비밀을 출력하지 않는 exact 명령만 제시해라.'
    ]
  }, home);
}

export function buildRecoveryMarkdown(payload) {
  const json = JSON.stringify(payload, null, 2);
  return `# open-AICC 최후 복구 전달문\n\n`
    + `생성 시각: ${payload.generatedAt}\n\n`
    + `이 문서는 로컬 AICC, Codex Desktop, Web GPT 연결이 모두 막힌 경우 Web GPT에 그대로 전달하는 owner-only 복구 자료입니다. 비밀, 토큰, 쿠키, 브라우저 프로필, 대화 본문과 원시 로그는 포함하지 않습니다.\n\n`
    + `## Web GPT에게 요청\n\n`
    + `${payload.requestToWebGpt.map(item => `- ${item}`).join('\n')}\n\n`
    + `## 절대 경계\n\n`
    + `${payload.safety.prohibitedActions.map(item => `- ${item}`).join('\n')}\n\n`
    + `## 안전한 복구 순서\n\n`
    + `${payload.recoveryOrder.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n\n`
    + `## 구조화된 현재 근거\n\n`
    + `\`\`\`json\n${json}\n\`\`\`\n`;
}

export function createRecoveryHandoffService(options = {}) {
  const home = options.home ?? os.homedir();
  const projectsRoot = options.projectsRoot
    ?? (options.home === undefined ? process.env.AICC_WORKSPACE_PROJECTS_ROOT?.trim() : null)
    ?? path.join(home, 'dev', 'projects');
  const platform = options.platform ?? process.platform;
  const root = options.root ?? path.join(home, '.ai-control-center', 'recovery', 'web-gpt-handoff');
  const bundlesRoot = path.join(root, 'bundles');
  const latestFile = path.join(root, 'latest.json');
  const mirrorRoot = options.mirrorRoot === false
    ? null
    : options.mirrorRoot ?? path.join(projectsRoot, 'ai-platform', '.aicc-recovery');
  const transportInspector = options.transportInspector ?? inspectCodexDesktopTransport;
  const containmentInspector = options.containmentInspector ?? (() => inspectCodexRootOnlyContainment({ home }));
  const nativeSafetyInspector = options.nativeSafetyInspector ?? (() => inspectNativeCallbackSafety({ home }));
  const releaseMatrixInspector = options.releaseMatrixInspector ?? (() => inspectWebGptReleaseMatrix({ home }));
  const openFinder = options.openFinder ?? (file => execFileAsync('/usr/bin/open', ['-R', file]));
  const now = options.now ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? 2 * 60 * 60_000;
  const supportTimeoutMs = Math.max(250, Number(options.supportTimeoutMs ?? DEFAULT_RECOVERY_SUPPORT_TIMEOUT_MS));
  const supportCollector = options.supportCollector ?? (() => collectSupportIsolated(supportTimeoutMs));

  function readLatest() {
    if (!fs.existsSync(latestFile)) return null;
    const pointer = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    if (!BUNDLE_ID.test(pointer.bundleId ?? '')) throw Object.assign(new Error('invalid recovery bundle pointer'), { code: 'recovery_pointer_invalid' });
    const bundleRoot = path.join(bundlesRoot, pointer.bundleId);
    const manifestPath = path.join(bundleRoot, MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const markdownPath = path.join(bundleRoot, MARKDOWN_FILE);
    const jsonPath = path.join(bundleRoot, JSON_FILE);
    const markdown = fs.readFileSync(markdownPath, 'utf8');
    const json = fs.readFileSync(jsonPath, 'utf8');
    if (sha256(markdown) !== manifest.files.markdown.sha256 || sha256(json) !== manifest.files.json.sha256) {
      throw Object.assign(new Error('recovery bundle checksum mismatch'), { code: 'recovery_checksum_mismatch' });
    }
    return { bundleRoot, manifest, markdownPath, jsonPath, markdown, json };
  }

  function status() {
    const latest = readLatest();
    if (!latest) return { ok: true, available: false, root: normalizePublicPath(root, home), finderAvailable: platform === 'darwin' };
    const ageMs = Math.max(0, now().getTime() - Date.parse(latest.manifest.generatedAt));
    const mirror = mirrorRoot == null ? null : {
      root: normalizePublicPath(mirrorRoot, home),
      markdownPath: normalizePublicPath(path.join(mirrorRoot, MIRROR_MARKDOWN_FILE), home),
      jsonPath: normalizePublicPath(path.join(mirrorRoot, MIRROR_JSON_FILE), home),
      manifestPath: normalizePublicPath(path.join(mirrorRoot, MIRROR_MANIFEST_FILE), home),
      workspaceReadable: true,
      ownerOnly: [
        [mirrorRoot, 0o700],
        [path.join(mirrorRoot, MIRROR_MARKDOWN_FILE), 0o600],
        [path.join(mirrorRoot, MIRROR_JSON_FILE), 0o600],
        [path.join(mirrorRoot, MIRROR_MANIFEST_FILE), 0o600]
      ].every(([file, expectedMode]) => fs.existsSync(file) && ownerModeOk(file, expectedMode))
    };
    return {
      ok: true,
      available: true,
      root: normalizePublicPath(root, home),
      finderAvailable: platform === 'darwin',
      latest: {
        bundleId: latest.manifest.bundleId,
        generatedAt: latest.manifest.generatedAt,
        ageMs,
        stale: ageMs > staleAfterMs,
        markdownPath: normalizePublicPath(latest.markdownPath, home),
        jsonPath: normalizePublicPath(latest.jsonPath, home),
        markdownSha256: latest.manifest.files.markdown.sha256,
        jsonSha256: latest.manifest.files.json.sha256,
        ownerOnly: ownerModesOk(latest)
      },
      mirror
    };
  }

  function content() {
    const latest = readLatest();
    if (!latest) return status();
    return {
      ...status(),
      documents: { markdown: latest.markdown, json: latest.json }
    };
  }

  async function refresh() {
    const generatedAt = now().toISOString();
    const [support, transport, containment, nativeSafety, releaseMatrix] = await Promise.all([
      withinTimeout(
        () => supportCollector(),
        supportTimeoutMs,
        {
          ok: false,
          state: 'UNKNOWN_SUPPORT_COLLECTION_TIMEOUT',
          generatedAt,
          timeoutMs: supportTimeoutMs,
          components: [],
          attention: ['support-collection-timeout'],
          privacy: { credentialsIncluded: false, rawOutputIncluded: false }
        }
      ).catch(error => ({
        ok: false,
        state: 'UNKNOWN_SUPPORT_COLLECTION_FAILED',
        generatedAt,
        error: error.message,
        components: [],
        attention: ['support-collection-failed'],
        privacy: { credentialsIncluded: false, rawOutputIncluded: false }
      })),
      Promise.resolve().then(() => transportInspector()).catch(error => ({
        ok: false,
        state: 'UNKNOWN_TRANSPORT_INSPECTION_FAILED',
        error: error.message,
        privacy: { rawLogIncluded: false, conversationContentIncluded: false }
      })),
      Promise.resolve().then(() => containmentInspector()).catch(error => ({
        ok: false,
        state: 'UNKNOWN_CONTAINMENT_INSPECTION_FAILED',
        error: error.message,
        rawConfigIncluded: false
      })),
      Promise.resolve().then(() => nativeSafetyInspector()).catch(error => ({
        ok: false,
        state: 'UNKNOWN_NATIVE_CALLBACK_SAFETY',
        error: error.message,
        rawConfigIncluded: false,
        authMaterialIncluded: false
      })),
      Promise.resolve().then(() => releaseMatrixInspector()).catch(error => ({
        ok: false,
        state: 'UNKNOWN_WEB_GPT_RELEASE_MATRIX',
        error: error.message,
        secretsIncluded: false
      }))
    ]);
    const payload = buildRecoveryPayload({ support, transport, containment, nativeSafety, releaseMatrix, generatedAt, home, projectsRoot });
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    const markdown = buildRecoveryMarkdown(payload);
    const jsonHash = sha256(json);
    const markdownHash = sha256(markdown);
    const bundleId = `${compactTimestamp(generatedAt)}-${jsonHash.slice(0, 12)}`;
    const staging = path.join(root, `.staging-${process.pid}-${randomUUID()}`);
    const finalRoot = path.join(bundlesRoot, bundleId);
    ensureOwnerDirectory(root);
    ensureOwnerDirectory(bundlesRoot);
    ensureOwnerDirectory(staging);
    try {
      writeOwnerFile(path.join(staging, MARKDOWN_FILE), markdown);
      writeOwnerFile(path.join(staging, JSON_FILE), json);
      const manifest = {
        schemaVersion: 1,
        bundleId,
        generatedAt,
        privacy: payload.safety,
        files: {
          markdown: { name: MARKDOWN_FILE, sha256: markdownHash },
          json: { name: JSON_FILE, sha256: jsonHash }
        }
      };
      writeOwnerFile(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
      fs.renameSync(staging, finalRoot);
      const pointerTmp = `${latestFile}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(pointerTmp, `${JSON.stringify({ schemaVersion: 1, bundleId }, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(pointerTmp, 0o600);
      fs.renameSync(pointerTmp, latestFile);
      fs.chmodSync(latestFile, 0o600);
      if (mirrorRoot != null) {
        ensureOwnerDirectory(mirrorRoot);
        replaceOwnerFile(path.join(mirrorRoot, MIRROR_MARKDOWN_FILE), markdown);
        replaceOwnerFile(path.join(mirrorRoot, MIRROR_JSON_FILE), json);
        replaceOwnerFile(path.join(mirrorRoot, MIRROR_MANIFEST_FILE), `${JSON.stringify({
          schemaVersion: 1,
          bundleId,
          generatedAt,
          markdownSha256: markdownHash,
          jsonSha256: jsonHash,
          source: normalizePublicPath(finalRoot, home)
        }, null, 2)}\n`);
      }
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    return { ...status(), documents: { markdown, json } };
  }

  async function reveal() {
    if (platform !== 'darwin') throw Object.assign(new Error('Finder reveal is available only on macOS'), { code: 'finder_unavailable' });
    const latest = readLatest();
    if (!latest) throw Object.assign(new Error('recovery document has not been generated'), { code: 'recovery_document_missing' });
    await openFinder(latest.markdownPath);
    return { ok: true, revealed: true, path: normalizePublicPath(latest.markdownPath, home) };
  }

  return { status, content, refresh, reveal };
}

function normalizePublicPath(file, home) {
  if (file === home) return '~';
  if (!file.startsWith(`${home}${path.sep}`)) return file;
  return `~/${file.slice(home.length + 1).split(path.sep).join('/')}`;
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function ownerModeOk(file, expectedMode) {
  // Node's POSIX mode bits are not authoritative on Windows (NTFS ACLs are).
  // Windows writes are confined to the user-controlled state roots; report the
  // same owner-only contract used by the rest of the Windows private-home code.
  return process.platform === 'win32' || mode(file) === expectedMode;
}

function ownerModesOk(latest) {
  return [
    [latest.bundleRoot, 0o700],
    [latest.markdownPath, 0o600],
    [latest.jsonPath, 0o600],
    [path.join(latest.bundleRoot, MANIFEST_FILE), 0o600]
  ].every(([file, expectedMode]) => ownerModeOk(file, expectedMode));
}
