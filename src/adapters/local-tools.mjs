import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathStatus } from '../lib/fs-status.mjs';

function projectRoot(relative) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, relative);
}

export async function localToolStatus(options = {}) {
  const accountManagerPath = process.env.AICC_ACCOUNT_MANAGER_PATH || projectRoot('../../components/account-manager');
  const desktopPath = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex')
    : '/Applications/ChatGPT.app';
  const desktop = pathStatus(desktopPath);
  const accountManager = pathStatus(accountManagerPath);

  return [
    {
      id: 'gpt-desktop',
      label: 'GPT Desktop',
      ...desktop,
      state: desktop.exists ? 'ready' : 'unavailable',
      detail: desktop.exists ? '앱이 설치되어 있습니다.' : '앱을 찾지 못했습니다.'
    },
    {
      id: 'account-manager',
      label: '통합 계정 관리자',
      ...accountManager,
      state: accountManager.exists ? 'ready' : 'unavailable',
      detail: accountManager.exists ? 'AICC 내부 소스가 준비되어 있습니다.' : '통합 소스를 찾지 못했습니다.'
    }
  ];
}
