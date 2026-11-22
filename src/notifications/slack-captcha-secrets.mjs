import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWindowsPwsh } from '../lib/windows-pwsh.mjs';

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/;
const TOKEN = /^xapp-[A-Za-z0-9-]{20,}$/;

function exactReference(value) {
  const normalized = String(value ?? '').trim();
  if (!REFERENCE.test(normalized)) throw new Error('invalid_slack_app_token_reference');
  return normalized;
}

function runSecretCommand(executable, args, { input, timeoutMs = 12_000 } = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let settled = false;
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, stdout, ...result });
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ code: 'command_timeout' }); }, timeoutMs);
    timer.unref();
    child.stdout.on('data', chunk => { if (stdout.length < 1024) stdout += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); finish({ code: 'spawn_failed' }); });
    child.on('close', exitCode => { clearTimeout(timer); finish({ ok: exitCode === 0, exitCode }); });
    child.stdin.end(input ?? '');
  });
}

function command(reference, action, pwshExecutable) {
  const helper = fileURLToPath(new URL('../../tools/platform/slack/Invoke-WindowsSlackAppTokenStore.ps1', import.meta.url));
  return {
    executable: pwshExecutable,
    args: ['-NoProfile', '-NonInteractive', '-File', helper, '-Action', action,
      '-Service', exactReference(reference?.service), '-Account', exactReference(reference?.account)]
  };
}

export async function storeSlackCaptchaAppToken(reference, tokenValue, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('windows_credential_manager_required');
  const token = String(tokenValue ?? '').trim();
  if (!TOKEN.test(token)) throw new Error('invalid_slack_app_token');
  const target = command(reference, 'Store', options.pwshExecutable ?? resolveWindowsPwsh());
  const result = await (options.runSecretCommand ?? runSecretCommand)(target.executable, target.args, { input: `${token}\n` });
  if (!result.ok) throw new Error('slack_app_token_store_failed');
  return { ok: true, backend: 'windows_credential_manager' };
}

export async function readSlackCaptchaAppToken(reference, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('windows_credential_manager_required');
  const target = command(reference, 'Read', options.pwshExecutable ?? resolveWindowsPwsh());
  const result = await (options.runSecretCommand ?? runSecretCommand)(target.executable, target.args);
  const token = String(result.stdout ?? '').trim();
  if (!result.ok || !TOKEN.test(token)) throw new Error('slack_app_token_unavailable');
  return token;
}
