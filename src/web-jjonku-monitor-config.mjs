import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const MODES = Object.freeze({
  'response-only': { label: '응답만 중지하고 재개', description: '외부 작업 완료·취소나 모델의 중복 외부 행동 방지는 보장하지 않습니다. 외부 결과는 UNKNOWN으로 보존합니다.' },
  'strict-external': { label: '외부 작업 정리 확인 후 재개', description: '해당 대화의 실제 caller/tool 영수증을 제공할 수 있을 때만 사용합니다.' }
});
const RESUME = '하던 작업 중단 지점부터 재개해';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const defaults = () => ({ schemaVersion: 1, enabled: false, intervalSeconds: 300, targets: [] });
const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_web_jjonku_config' }); };
function safePath(file) {
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('연결 경로를 통해 설정을 읽거나 쓰지 않습니다.');
    if (path.dirname(p) === p) break;
  }
}
function read(file) {
  safePath(file);
  if (!fs.existsSync(file)) return { config: defaults(), revision: 'absent', savedAt: null, isDefault: true };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1048576) fail('안전한 설정 파일이 아닙니다. 기존 파일을 보존했습니다.');
  const bytes = fs.readFileSync(file);
  let value; try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('설정을 읽지 못했습니다. 기존 파일을 보존했습니다.'); }
  if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !Array.isArray(value.targets)) fail('감독기 설정 버전이 맞지 않습니다.');
  return { config: value, revision: digest(bytes), savedAt: value.savedAt ?? null, isDefault: false };
}
function supervisorRunner(configFile, revision, options, now) {
  const result = { liveStatus: 'not-installed', scheduling: 'owner-local-supervisor-timer', rawAutomationWrites: false, actualDispatchesProved: false, processLivenessVerified: false, installationVerified: false, receiptFresh: false, peerDispatchSupported: false };
  function json(file) {
    safePath(file); const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1048576) throw Error('invalid receipt');
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  }
  const installationFile = path.join(path.dirname(configFile), 'installation.json');
  if (!fs.existsSync(installationFile)) return result;
  try {
    const installed = json(installationFile);
    const managed = path.resolve(options.ownerRoot ?? path.join(options.home ?? os.homedir(), '.ai-control-center'), 'releases', 'webgpt-supervisor');
    const release = path.resolve(installed.releaseRoot);
    if (installed.schemaVersion !== 1 || installed.componentId !== 'aicc.owner-local.webgpt-supervisor/v1' || path.resolve(installed.configFile) !== path.resolve(configFile) || !release.startsWith(managed + path.sep) || path.resolve(installed.manifestFile) !== path.join(release, 'manifest.json') || !path.resolve(installed.entrypoint).startsWith(release + path.sep) || !SHA.test(installed.manifestSha256 ?? '')) throw Error('invalid installation');
    safePath(installed.manifestFile);
    if (digest(fs.readFileSync(installed.manifestFile)) !== installed.manifestSha256) throw Error('changed manifest');
    result.peerDispatchSupported = json(installed.manifestFile).capabilities?.peerTemplateDispatch === true;
    result.installationVerified = true; result.liveStatus = 'receipt-unavailable';
    const state = json(path.join(path.dirname(configFile), 'worker-status.json'));
    const age = Date.parse(now()) - Date.parse(state.observedAt);
    if (state.schemaVersion !== 1 || path.resolve(state.configFile) !== path.resolve(configFile) || !['OFF', 'WATCHING', 'HOLD', 'STOPPED'].includes(state.state) || state.configSha256 !== revision || !Number.isFinite(age) || age < -5000 || age > 20000) return { ...result, liveStatus: 'receipt-stale-or-different' };
    return { ...result, liveStatus: 'recent-worker-report', receiptFresh: true, reportedState: state.state, observedAt: state.observedAt, pid: state.pid, targetCount: state.targetCount, aiPolling: state.aiPolling === true };
  } catch { return { ...result, liveStatus: 'receipt-unverified' }; }
}
function roleBinding(role, options) {
  if (options.resolveBinding) return options.resolveBinding(role);
  const home = options.home ?? os.homedir();
  const pwsh = process.platform === 'win32' ? path.join(home, '.ai-control-center', 'toolchain', 'pwsh-7.6.6', 'runtime', 'pwsh.exe') : 'pwsh';
  const reader = fileURLToPath(new URL('../tools/platform/core/Read-AiccCoordination.ps1', import.meta.url));
  const args = ['-NoProfile', '-NonInteractive', '-File', reader, '-WebGptRole', role];
  if (options.coordinationPath) args.push('-Path', options.coordinationPath);
  const result = spawnSync(pwsh, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000 });
  if (result.error || result.status !== 0) fail('등록된 계정 연결을 확인하지 못했습니다.');
  return JSON.parse(result.stdout);
}
function binding(role, options) {
  if (!['default', 'secondary'].includes(role)) fail('지원되는 등록 계정을 선택해 주세요.');
  const b = roleBinding(role, options);
  if (b.role !== role || b.status !== 'active' || !SHA.test(b.identityHash ?? '') || !(b.workspaceIdentityHash === null || SHA.test(b.workspaceIdentityHash ?? '')) || !ID.test(b.accountAlias ?? '') || !ID.test(b.workspaceAlias ?? '')) fail('승인된 계정 신원이 없습니다.');
  return { role, accountAlias: b.accountAlias, workspaceAlias: b.workspaceAlias, identityHash: b.identityHash, workspaceIdentityHash: b.workspaceIdentityHash };
}
function exactUrl(value) {
  let u; try { u = new URL(value); } catch { fail('정확한 ChatGPT 대화 URL을 입력해 주세요.'); }
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  if (u.origin !== 'https://chatgpt.com' || u.search || u.hash || u.username || u.password || !new RegExp('^(?:/c/' + uuid + '|/g/[A-Za-z0-9_-]+/c/' + uuid + ')$').test(u.pathname)) fail('지원되는 원래 대화 URL을 입력해 주세요.');
  return u.href;
}
function canonical(value) { return JSON.stringify(value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))]))); }
function peerGrants(values, targets, previous, options, now) {
  if (!Array.isArray(values) || values.length > 16) fail('대화 간 전달 승인은 16개까지 선택할 수 있습니다.');
  const ids = new Set();
  return values.map(input => {
    if (!input || !ID.test(input.id ?? '') || ids.has(input.id) || typeof input.enabled !== 'boolean') fail('전달 승인 이름과 켜짐 상태를 확인해 주세요.');
    ids.add(input.id); const old = previous.find(g => g.id === input.id);
    const ref = targetId => {
      const t = targets.find(t => t.id === targetId); if (!t) fail('발신·수신 대화를 먼저 선택 목록에 저장해 주세요.');
      const b = input.enabled ? binding(t.role, options) : t;
      if (b.identityHash !== t.identityHash || b.workspaceIdentityHash !== t.workspaceIdentityHash) fail('전달 대상 계정 신원이 바뀌었습니다. 대상을 다시 확인해 주세요.');
      return { targetId: t.id, role: t.role, conversationUrl: t.conversationUrl, accountAlias: t.accountAlias, workspaceAlias: t.workspaceAlias, identityHash: t.identityHash, workspaceIdentityHash: t.workspaceIdentityHash };
    };
    const source = ref(input.sourceTargetId ?? input.source?.targetId);
    const recipientIds = input.recipientIds ?? input.recipients?.map(r => r.targetId);
    if (!Array.isArray(recipientIds) || recipientIds.length < 1 || recipientIds.length > 16 || new Set(recipientIds).size !== recipientIds.length || recipientIds.includes(source.targetId)) fail('발신과 다른 수신 대화를 중복 없이 선택해 주세요.');
    const recipients = recipientIds.map(ref);
    if (old?.enabled && input.enabled && (canonical(old.source) !== canonical(source) || canonical(old.recipients) !== canonical(recipients))) fail('승인된 발신·수신 범위가 바뀌었습니다. 먼저 이 전달 승인을 끄고 저장한 뒤 다시 승인해 주세요.');
    const purpose = input.purpose, text = input.templateText ?? input.template?.text;
    if (typeof purpose !== 'string' || !purpose.trim() || purpose.length > 200 || typeof text !== 'string' || !text.trim() || text.length > 2000) fail('전달 목적과 2000자 이내의 정확한 틀을 적어 주세요.');
    if (!Array.isArray(input.inputFields) || input.inputFields.length > 8) fail('허용 입력 필드는 8개까지입니다.');
    const fieldNames = new Set();
    const inputFields = input.inputFields.map(field => {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(field?.name ?? '') || fieldNames.has(field.name) || !Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 500) fail('허용 필드 이름과 최대 길이(1~500)를 확인해 주세요.');
      fieldNames.add(field.name); return { name: field.name, maxLength: field.maxLength };
    });
    const placeholders = [...text.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]{0,31})\}\}/g)].map(m => m[1]);
    if (text.replace(/\{\{([A-Za-z][A-Za-z0-9_]{0,31})\}\}/g, '').includes('{{') || text.replace(/\{\{([A-Za-z][A-Za-z0-9_]{0,31})\}\}/g, '').includes('}}') || new Set(placeholders).size !== fieldNames.size || placeholders.some(name => !fieldNames.has(name))) fail('틀의 {{필드명}}과 허용 필드가 정확히 같아야 합니다.');
    const expiry = Date.parse(input.expiresAt), current = Date.parse(now);
    if (!Number.isFinite(expiry) || (input.enabled && (expiry <= current || expiry > current + 30 * 86400000))) fail('전달 승인 만료는 현재부터 30일 안으로 지정해 주세요.');
    const grant = { schemaVersion: 1, id: input.id, enabled: input.enabled, revision: old?.revision ?? 1, source, recipients, purpose, template: { text, sha256: digest(text) }, inputFields, expiresAt: new Date(expiry).toISOString(), revokedAt: input.enabled ? null : old?.revokedAt ?? now };
    const approvalFields = g => Object.fromEntries(Object.entries(g).filter(([key]) => key !== 'localApproval'));
    if (old && canonical(approvalFields(old)) !== canonical(grant)) grant.revision++;
    return { ...grant, localApproval: { source: 'owner-local-settings-ui', scope: 'selected-peer-template-dispatch-only', grantDigest: digest(canonical(grant)) } };
  });
}
function normalize(value, options, previousTargets = [], previousGrants = [], now) {
  if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !Array.isArray(value.targets) || value.targets.length > 32 || !Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 30 || value.intervalSeconds > 3600) fail('감시 설정을 확인해 주세요.');
  const ids = new Set(), chats = new Set(), bindings = new Map();
  const targets = value.targets.map(t => {
    if (!t || !ID.test(t.id ?? '') || ids.has(t.id) || typeof t.enabled !== 'boolean' || typeof t.autoResume !== 'boolean' || !MODES[t.autoResumeMode]) fail('중복 없는 대상과 재개 방식을 선택해 주세요.');
    ids.add(t.id);
    const conversationUrl = exactUrl(t.conversationUrl);
    const previous = previousTargets.find(p => p.id === t.id && p.role === t.role && p.conversationUrl === conversationUrl);
    let b;
    if ((!value.enabled || !t.enabled) && previous) b = previous;
    else { if (!bindings.has(t.role)) bindings.set(t.role, binding(t.role, options)); b = bindings.get(t.role); }
    const key = [b.identityHash, b.workspaceIdentityHash, conversationUrl.split('/').at(-1)].join('|');
    if (chats.has(key)) fail('같은 계정의 같은 대화가 중복됐습니다.');
    chats.add(key);
    const target = { id: t.id, enabled: t.enabled, role: t.role, accountAlias: b.accountAlias, workspaceAlias: b.workspaceAlias, identityHash: b.identityHash, workspaceIdentityHash: b.workspaceIdentityHash, conversationUrl, autoResume: t.autoResume, autoResumeMode: t.autoResumeMode };
    if (t.externalStateFile || t.externalStateSha256) {
      if (!path.isAbsolute(t.externalStateFile ?? '') || !SHA.test(t.externalStateSha256 ?? '')) fail('외부 작업 영수증의 절대 경로와 SHA를 확인해 주세요.');
      target.externalStateFile = t.externalStateFile; target.externalStateSha256 = t.externalStateSha256;
    }
    return target;
  });
  const grants = peerGrants(value.peerGrants ?? previousGrants, targets, previousGrants, options, now);
  if (value.enabled && !targets.some(t => t.enabled) && !grants.some(g => g.enabled)) fail('감시할 대화 또는 전달 승인을 하나 이상 선택해 주세요.');
  return { schemaVersion: 1, enabled: value.enabled, intervalSeconds: value.intervalSeconds, targets, peerGrants: grants };
}

export function createWebJjonkuMonitorConfig(options = {}) {
  const home = options.home ?? os.homedir();
  const ownerRoot = options.ownerRoot ?? process.env.AICC_STATE_ROOT ?? path.join(home, '.ai-control-center');
  const configFile = options.supervisorConfigFile ?? (options.ownerRoot ? path.join(ownerRoot, 'webgpt-supervisor', 'config.json') : path.join(home, '.codex-chatgpt-web', 'supervisor', 'config.json'));
  const legacyFile = path.join(ownerRoot, 'control-plane', 'web-jjonku-monitor.json');
  const now = options.now ?? (() => new Date().toISOString());
  function result(saved) {
    const roles = ['default', 'secondary'].map(role => { try { return { ...binding(role, options), available: true }; } catch { return { role, available: false }; } });
    return { ok: true, schemaVersion: 8, ...saved, configFile, roles, capabilities: { capabilitiesVersion: 2, transport: 'registered-cdp', ordinaryChromeExtension: false, autoResumeModes: MODES, resumePrompt: RESUME, stallSeconds: 1800, minimumObservations: 2, sendReplay: false }, runner: supervisorRunner(configFile, saved.revision, options, now), legacyPreserved: fs.existsSync(legacyFile) };
  }
  return {
    status() { return result(read(configFile)); },
    preview(value) {
      const before = read(configFile);
      if (value.expectedRevision !== before.revision) fail('다른 주체가 설정을 바꿨습니다. 새로 조회해 주세요.');
      const config = normalize(value, options, before.config.targets, before.config.peerGrants ?? [], now());
      if (config.peerGrants.some(g => g.enabled) && !supervisorRunner(configFile, before.revision, options, now).peerDispatchSupported) fail('설치된 타이머에 대화 간 전달 기능이 아직 없습니다.');
      return { revision: before.revision, config };
    },
    save(value) {
      safePath(configFile); fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
      const lockPath = configFile + '.ui.lock'; let lock;
      try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch { fail('다른 설정 저장 중입니다. 현재 값을 다시 조회해 주세요.'); }
      try {
        const before = read(configFile);
        if (value.expectedRevision !== before.revision) fail('다른 주체가 설정을 바꿨습니다. 새로 조회해 주세요.');
        const savedAt = now();
        const config = normalize(value, options, before.config.targets, before.config.peerGrants ?? [], savedAt);
        if (config.peerGrants.some(g => g.enabled) && !supervisorRunner(configFile, before.revision, options, now).peerDispatchSupported) fail('설치된 타이머에 대화 간 전달 기능이 아직 없습니다. 전달 승인은 꺼짐으로 보존해 주세요.');
        const stored = { ...config, savedAt, localApproval: { source: 'owner-local-settings-ui', at: savedAt, targetDigest: digest(JSON.stringify(config.targets)), scope: 'selected-exact-chats-fixed-resume-only', arbitraryDispatch: false } };
        const temporary = configFile + '.' + randomUUID() + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, configFile);
        return result(read(configFile));
      } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
    }
  };
}
export const webJjonkuMonitorDefaults = Object.freeze(defaults());
