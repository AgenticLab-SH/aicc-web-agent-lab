import { authPortalDetails } from './adapters/auth-portal.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function openLocalApp(id, options = {}) {
  if (id === 'auth-portal') {
    const details = authPortalDetails({ env: options.env });
    if (!details.configured) throw new Error('웹 로그인 전달 포털 주소가 구성되지 않았습니다.');
    return { ok: true, id, started: false, url: details.url };
  }
  if (id === 'web-gpt') {
    const application = options.application ?? (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Codex Web GPT', 'Codex Web GPT.exe')
      : '/Applications/Codex Web GPT.app');
    if (!fs.existsSync(application)) throw new Error('Codex Web GPT 앱이 설치되어 있지 않습니다.');
    const opener = process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'start', '', application]]
      : process.platform === 'darwin'
        ? ['/usr/bin/open', ['-g', application]]
        : ['xdg-open', [application]];
    const result = (options.spawnSync ?? spawnSync)(opener[0], opener[1], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error((result.stderr || 'Codex Web GPT 앱을 열지 못했습니다.').trim());
    return { ok: true, id, started: true };
  }
  const error = new Error('허용되지 않은 로컬 앱입니다.');
  error.code = 'app_not_allowed';
  error.status = 404;
  throw error;
}
