import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { collectTrayAccountStatus } from '../tools/platform/windows/tray-status.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const defaults = Object.freeze({ schemaVersion: 1, basis: 'remaining_to_100', enabled: true,
  warningEnabled: true, urgentEnabled: true, warningMargin: 10, urgentMargin: 6, slackEnabled: true,
  messages: { fiveHourWarning: '{account}: {window} 잔여 {remaining}%입니다. 현재 변경과 다음 행동을 저장하세요.',
    fiveHourUrgent: '{account}: {window} 잔여 {remaining}%입니다. 현재 작업과 복구 지점을 즉시 저장하세요.',
    weeklyUrgent: '{account}: {window} 잔여 {remaining}%입니다. 현재 작업과 복구 지점을 즉시 저장하세요.' } });

function guard(file) {
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('quota_linked_path');
    if (current === path.dirname(current)) break;
  }
  return file;
}
function bytes(file, max = 4 * 1024 * 1024) {
  guard(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) fail('quota_file_invalid');
  return fs.readFileSync(file);
}
function json(file, max) { return JSON.parse(bytes(file, max).toString('utf8').replace(/^\uFEFF/, '')); }
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function validateSettings(value) {
  if (!plain(value) || value.schemaVersion !== 1 || value.basis && value.basis !== 'remaining_to_100') fail('quota_warning_settings_invalid');
  for (const key of ['enabled', 'warningEnabled', 'urgentEnabled', 'slackEnabled']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('quota_warning_toggle_invalid');
  }
  if (typeof value.enabled !== 'boolean' || !Number.isInteger(value.warningMargin) || !Number.isInteger(value.urgentMargin) ||
    value.urgentMargin < 1 || value.warningMargin > 100 || value.warningMargin <= value.urgentMargin) fail('quota_warning_margin_invalid');
  if (!plain(value.messages)) fail('quota_warning_messages_invalid');
  for (const key of ['fiveHourWarning', 'fiveHourUrgent', 'weeklyUrgent']) {
    if (typeof value.messages[key] !== 'string' || !value.messages[key].trim() || value.messages[key].trim().length > 240 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.messages[key])) fail('quota_warning_message_invalid');
  }
  return value;
}
function publicSettings(value) {
  return { schemaVersion: 1, basis: 'remaining_to_100', enabled: value.enabled,
    warningEnabled: value.warningEnabled !== false, urgentEnabled: value.urgentEnabled !== false,
    warningMargin: value.warningMargin, urgentMargin: value.urgentMargin, slackEnabled: value.slackEnabled !== false,
    messages: Object.fromEntries(['fiveHourWarning', 'fiveHourUrgent', 'weeklyUrgent'].map(key => [key, value.messages[key]])) };
}
export function validateOcxQuotaPolicy(value) {
  if (!plain(value) || Object.keys(value).some(key => !['action', 'shortThreshold', 'longThreshold', 'shortAction', 'longAction'].includes(key)) || value.action && value.action !== 'policy') fail('quota_policy_invalid');
  for (const key of ['shortThreshold', 'longThreshold']) if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 100) fail('quota_policy_threshold_invalid');
  for (const key of ['shortAction', 'longAction']) if (!['switch', 'stop'].includes(value[key])) fail('quota_policy_action_invalid');
  return { action: 'policy', shortThreshold: value.shortThreshold, longThreshold: value.longThreshold, shortAction: value.shortAction, longAction: value.longAction };
}

// The same FileShare.None lock as the Windows tray, not an unrelated JS lock.
const saveScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Guard([string]$p){while($p){if([IO.File]::Exists($p)-or[IO.Directory]::Exists($p)){if(([IO.File]::GetAttributes($p)-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'quota_linked_path'}};$next=[IO.Path]::GetDirectoryName($p);if($next-eq$p){break};$p=$next}}
try {
 $payload=[Console]::In.ReadToEnd()|ConvertFrom-Json
 $file=[string]$payload.file; Guard $file
 [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))|Out-Null
 Guard ($file+'.lock')
 $gate=[IO.FileStream]::new($file+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try {
  Guard $file
  $current=if([IO.File]::Exists($file)){[IO.File]::ReadAllBytes($file)}else{$null}
  $revision=if($null-ne$current){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($current)).ToLowerInvariant()}else{'missing'}
  if($revision-cne[string]$payload.expectedRevision){throw 'quota_warning_revision_changed'}
  $temporary=$file+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  $output=[Text.UTF8Encoding]::new($false).GetBytes([string]$payload.text)
  $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($output,0,$output.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  try {if([IO.File]::Exists($file)){[IO.File]::Replace($temporary,$file,[NullString]::Value)}else{[IO.File]::Move($temporary,$file)}}catch{if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)};throw}
  @{ok=$true;revision=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($output)).ToLowerInvariant()}|ConvertTo-Json -Compress
 } finally {$gate.Dispose()}
} catch { $code=if($_.Exception.Message-eq'quota_warning_revision_changed'){'quota_warning_revision_changed'}else{'quota_warning_save_failed'};@{ok=$false;code=$code}|ConvertTo-Json -Compress;exit 1 }
`;
function saveUnderTrayLock(payload) {
  if (process.platform !== 'win32') fail('quota_warning_windows_lock_required');
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(saveScript, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(Object.assign(new Error(error), { code: error })) : resolve(value); };
    const timer = setTimeout(() => finish('quota_warning_save_unknown'), 15000);
    child.stdout.on('data', chunk => { if (output.length < 16384) output += chunk; });
    child.once('error', () => finish('quota_warning_save_unknown'));
    child.stdin.on('error', () => {});
    child.once('close', () => { try { const value = JSON.parse(output.trim()); value.ok ? finish(null, value) : finish(value.code || 'quota_warning_save_failed'); } catch { finish('quota_warning_save_unknown'); } });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function createOcxQuotaDashboard(options = {}) {
  const ownerRoot = path.resolve(options.ownerRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center'));
  const warningFile = path.join(ownerRoot, 'config', 'ocx-quota-warning.json');
  const now = options.now ?? Date.now;
  let collecting = null, accountCollection = null, lastComplete = null;
  function warningRecord() {
    guard(warningFile);
    const raw = fs.existsSync(warningFile) ? bytes(warningFile, 16384) : null;
    const value = raw ? JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')) : structuredClone(defaults);
    validateSettings(value);
    return { value, revision: raw ? sha(raw) : 'missing' };
  }
  async function collector() {
    if (options.collectTray) return options.collectTray;
    return collectTrayAccountStatus;
  }
  function rawQuotas() {
    try {
      const current = json(path.join(ownerRoot, 'runtime', 'ocx-local', 'current.json'));
      if (current.adapterManifest) return new Map();
      if (!path.isAbsolute(current.opencodexHome ?? '')) return new Map();
      const config = json(path.join(current.opencodexHome, 'config.json'));
      const cache = json(path.join(current.opencodexHome, 'codex-quota-cache.json'));
      if (cache.version !== 1) return new Map();
      return new Map((config.codexAccounts ?? []).filter(row => typeof row.id === 'string').map(row => [sha(row.id), cache.quotas?.[row.id]]));
    } catch { return new Map(); }
  }
  function enrich(tray) {
    const cache = rawQuotas(), timestamp = now();
    return (tray.accounts ?? []).map(row => {
      const quota = cache.get(row.identityHash);
      const observedMs = Date.parse(row.quotaObservedAt ?? '');
      const shortUsedPercent = Number.isFinite(row.shortRemaining) ? 100 - row.shortRemaining : null;
      const longUsedPercent = Number.isFinite(row.longRemaining) ? 100 - row.longRemaining : null;
      const matches = quota && quota.updatedAt === observedMs && quota.shortPercent === shortUsedPercent && (quota.weeklyPercent ?? quota.monthlyPercent) === longUsedPercent;
      const epoch = value => Number.isFinite(value) && value > 0 && value * 1000 <= 8640000000000000 ? value * 1000 : null;
      const direct = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value)>0 ? Date.parse(value) : null;
      const shortMs = direct(row.shortResetAt) ?? (matches ? epoch(quota.shortResetAt) : null);
      const longMs = direct(row.longResetAt) ?? (matches ? epoch(quota.weeklyResetAt ?? quota.monthlyResetAt) : null);
      const fresh = tray.quotaReadFailed !== true && !row.needsReauth && !row.quotaError && Number.isFinite(observedMs) && observedMs <= timestamp && timestamp - observedMs <= 120000;
      return { ...row, shortUsedPercent, longUsedPercent, shortResetAt: shortMs ? new Date(shortMs).toISOString() : null,
        longResetAt: longMs ? new Date(longMs).toISOString() : null, shortResetInSeconds: shortMs ? Math.max(0, Math.ceil((shortMs - timestamp) / 1000)) : null,
        longResetInSeconds: longMs ? Math.max(0, Math.ceil((longMs - timestamp) / 1000)) : null,
        resetTimeSource: shortMs || longMs ? row.resetTimeSource ?? 'matched-quota-cache' : 'not-provided', quotaFresh: fresh };
    });
  }
  return Object.freeze({
    async read({ refresh = false, accountsOnly = false } = {}) {
      let tray;
      if (accountsOnly && !refresh && !collecting && lastComplete && now() - lastComplete.at < 5000) {
        tray = lastComplete.value;
      } else {
        if (!collecting) {
          let publishAccounts, rejectAccounts;
          accountCollection = new Promise((resolve, reject) => { publishAccounts = resolve; rejectAccounts = reject; });
          // Full readers (including the Slack monitor) retain the original contract.
          // Only the read-only screen may use the installed early account projection.
          void accountCollection.catch(() => {});
          collecting = Promise.resolve().then(async () => (await collector())({ refresh: refresh === true,
            onAccounts: value => publishAccounts({ ...value, diagnosticsPending: true, selectionVerified: false,
              quotaStatus: '계정 조회 완료 · 전체 서비스 진단 진행 중' })
          })).then(value => {
            lastComplete = { at: now(), value }; publishAccounts(value); return value;
          }, error => { rejectAccounts(error); throw error; }).finally(() => { collecting = null; accountCollection = null; });
          // A screen can finish before the full collection; keep its failure handled.
          void collecting.catch(() => {});
        }
        tray = await (accountsOnly ? accountCollection : collecting);
      }
      let warningSettings = null, warningRevision = null, warningError = null;
      try { const record = warningRecord(); warningSettings = publicSettings(record.value); warningRevision = record.revision; } catch { warningError = 'quota_warning_settings_unavailable'; }
      const accounts = enrich(tray);
      return { schemaVersion: 1, observedAt: new Date(now()).toISOString(), diagnosticsPending: tray.diagnosticsPending === true, tray: { ...tray, accounts }, accounts,
        policy: tray.effectivePolicy ?? null, warningSettings, warningRevision, warningError,
        selectionScope: 'OCX 풀의 현재 선택 · 각 대화의 실제 요청 계정 증명과 별개',
        slack: { enabled: warningSettings?.slackEnabled ?? null, trigger: 'any-fresh-account-at-used-block-threshold', independentOfAdvisoryWarnings: true } };
    },
    get collectionPending() { return collecting !== null; },
    prepareWarnings({ expectedRevision, settings } = {}) {
      if (typeof expectedRevision !== 'string' || !/^(missing|[a-f0-9]{64})$/.test(expectedRevision) || !plain(settings)) fail('quota_warning_request_invalid');
      const allowed = ['enabled', 'warningEnabled', 'urgentEnabled', 'warningMargin', 'urgentMargin', 'messages', 'slackEnabled'];
      if (Object.keys(settings).some(key => !allowed.includes(key))) fail('quota_warning_fields_invalid');
      if (settings.messages && (!plain(settings.messages) || Object.keys(settings.messages).some(key => !['fiveHourWarning', 'fiveHourUrgent', 'weeklyUrgent'].includes(key)))) fail('quota_warning_messages_invalid');
      const record = warningRecord();
      if (record.revision !== expectedRevision) fail('quota_warning_revision_changed');
      const next = validateSettings({ ...record.value, ...settings, basis: 'remaining_to_100', messages: { ...record.value.messages, ...settings.messages } });
      const normalized = publicSettings(next);
      const fingerprint = sha(JSON.stringify({ expectedRevision, settings: normalized }));
      return { fingerprint, expectedRevision, settings: normalized, summary: `사전 경고: ${normalized.enabled ? '사용' : '끔'} · 일반 잔여 ${normalized.warningMargin}% / 긴급 ${normalized.urgentMargin}% · 차단선 Slack ${normalized.slackEnabled ? '켜기' : '끄기'} · 차단 정책은 별도` };
    },
    async saveWarnings(prepared) {
      const check = this.prepareWarnings({ expectedRevision: prepared?.expectedRevision, settings: Object.fromEntries(Object.entries(prepared?.settings ?? {}).filter(([key]) => !['schemaVersion', 'basis'].includes(key))) });
      if (check.fingerprint !== prepared?.fingerprint) fail('quota_warning_preview_changed');
      const record = warningRecord();
      const merged = { ...record.value, ...check.settings, messages: { ...record.value.messages, ...check.settings.messages } };
      const result = await saveUnderTrayLock({ file: warningFile, expectedRevision: check.expectedRevision, text: JSON.stringify(merged) });
      return { ok: true, warningRevision: result.revision, warningSettings: check.settings };
    }
  });
}
