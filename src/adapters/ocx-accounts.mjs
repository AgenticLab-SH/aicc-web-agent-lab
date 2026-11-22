import { runCommand } from '../lib/command.mjs';
import path from 'node:path';

function safeAccount(account = {}) {
  const percent = value => Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  const quota = account.quota && typeof account.quota === 'object'
    ? {
        weeklyUsedPercent: percent(account.quota.weeklyPercent),
        weeklyRemainingPercent: percent(account.quota.weeklyPercent) === null ? null : 100 - account.quota.weeklyPercent,
        weeklyResetAt: Number.isFinite(account.quota.weeklyResetAt) ? account.quota.weeklyResetAt : null,
        monthlyUsedPercent: percent(account.quota.monthlyPercent),
        monthlyRemainingPercent: percent(account.quota.monthlyPercent) === null ? null : 100 - account.quota.monthlyPercent,
        shortUsedPercent: percent(account.quota.shortPercent),
        monthlyResetAt: Number.isFinite(account.quota.monthlyResetAt) ? account.quota.monthlyResetAt : null
      }
    : null;
  return {
    id: typeof account.id === 'string' ? account.id : null,
    label: typeof account.label === 'string' ? account.label : null,
    email: typeof account.email === 'string' ? account.email : null,
    plan: typeof account.plan === 'string' ? account.plan : null,
    active: Boolean(account.active),
    paused: Boolean(account.paused),
    needsReauth: Boolean(account.needsReauth),
    priority: Number.isFinite(account.priority) ? account.priority : 0,
    quota
  };
}

function commandInvocation(executable, args, environment = process.env, platform = process.platform) {
  if (platform !== 'win32') return { executable, args };
  const extension = path.extname(executable).toLowerCase();
  const absolute = path.win32.isAbsolute(executable) || path.isAbsolute(executable);
  const requiresCmd = !absolute || ['.bat', '.cmd', '.ps1'].includes(extension) || !extension;
  if (!requiresCmd) return { executable, args };
  const shell = environment.ComSpec?.trim() || process.env.ComSpec?.trim() || 'cmd.exe';
  return { executable: shell, args: ['/d', '/s', '/c', executable, ...args] };
}

function platformRunner(runner, platform, environment) {
  if (platform !== 'win32') return runner;
  return (executable, args, options) => {
    const invocation = commandInvocation(executable, args, environment, platform);
    return runner(invocation.executable, invocation.args, options);
  };
}

export async function ocxAccountStatus(options = {}) {
  const executable = options.executable || process.env.AICC_OCX_EXECUTABLE?.trim() || 'ocx';
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const rawRunner = options.runCommand ?? runCommand;
  const runner = options.runCommand ? rawRunner : platformRunner(rawRunner, platform, environment);
  const refresh = options.refresh === true;
  let result = refresh
    ? await runner(executable, ['account', 'refresh', 'openai', '--json'], { timeoutMs: options.refreshTimeoutMs ?? 8_000 })
    : await runner(executable, ['account', 'list', 'openai', '--quota', '--json'], { timeoutMs: options.timeoutMs ?? 10_000 });
  let quotaSource = refresh ? 'live-refresh' : 'cached-list';
  if (refresh && !result.ok) {
    result = await runner(executable, ['account', 'list', 'openai', '--quota', '--json'], { timeoutMs: options.timeoutMs ?? 10_000 });
    quotaSource = 'cached-list';
  }
  if (!result.ok) {
    return {
      id: 'ocx-accounts',
      label: 'OCX 계정 풀',
      state: result.timedOut ? 'degraded' : 'unavailable',
      detail: result.timedOut ? 'OCX 계정 조회 시간이 초과되었습니다.' : 'OCX 계정 풀을 읽지 못했습니다.',
      accounts: [],
      error: result.error || `exit ${result.exitCode ?? 'unknown'}`
    };
  }
  try {
    const payload = JSON.parse(result.stdout);
    const accounts = Array.isArray(payload.accounts) ? payload.accounts.map(safeAccount) : [];
    const quotaKnownCount = accounts.filter(account => account.quota?.weeklyRemainingPercent != null || account.quota?.monthlyRemainingPercent != null).length;
    const degraded = accounts.length === 0 || accounts.some(account => account.needsReauth) || quotaKnownCount !== accounts.length || (refresh && quotaSource !== 'live-refresh');
    return {
      id: 'ocx-accounts',
      label: 'OCX 계정 풀',
      state: degraded ? 'degraded' : 'ready',
      detail: `${accounts.length}개 라우팅 계정 조회`,
      accountCount: accounts.length,
      activeId: accounts.find(account => account.active)?.id ?? null,
      quotaSource,
      quotaKnownCount,
      quotaFreshness: quotaSource === 'live-refresh' ? 'refresh-response' : 'unreported',
      accounts
    };
  } catch {
    return {
      id: 'ocx-accounts',
      label: 'OCX 계정 풀',
      state: 'degraded',
      detail: 'OCX가 JSON이 아닌 계정 상태를 반환했습니다.',
      accounts: [],
      error: 'invalid JSON response'
    };
  }
}
