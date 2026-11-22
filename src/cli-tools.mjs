import { runCommand } from './lib/command.mjs';

export const pinnedCliPackages = Object.freeze({
  ocx: '@bitkyc08/opencodex@2.33.0',
  codex: '@openai/codex@0.149.1',
  claude: '@anthropic-ai/claude-code@2.1.245'
});

function firstLine(result) {
  return result.ok ? result.stdout.trim().split(/\r?\n/)[0] : '';
}

function parseJson(result) {
  if (!result.ok) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function runPlatformCommand(runner, executable, args, options, platform) {
  if (platform === 'win32') {
    return runner('cmd.exe', ['/d', '/s', '/c', executable, ...args], options);
  }
  return runner(executable, args, options);
}

async function inspectCli(options = {}) {
  const runner = options.runCommand ?? runCommand;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configuredOcx = env.AICC_OCX_EXECUTABLE?.trim() || null;
  const ocx = configuredOcx || 'ocx';
  const [ocxVersion, shellOcxVersion, codexVersion, claudeVersion, health, systemStatus, claudeConfig] = await Promise.all([
    runPlatformCommand(runner, ocx, ['--version'], { timeoutMs: 8_000 }, platform),
    configuredOcx
      ? runPlatformCommand(runner, 'ocx', ['--version'], { timeoutMs: 8_000 }, platform)
      : Promise.resolve(null),
    runPlatformCommand(runner, 'codex', ['--version'], { timeoutMs: 8_000 }, platform),
    runPlatformCommand(runner, 'claude', ['--version'], { timeoutMs: 8_000 }, platform),
    runPlatformCommand(runner, ocx, ['health', '--json'], { timeoutMs: 8_000 }, platform),
    runPlatformCommand(runner, ocx, ['system', 'status', '--json'], { timeoutMs: 8_000 }, platform),
    runPlatformCommand(runner, ocx, ['claude', 'config', 'status', '--json'], { timeoutMs: 8_000 }, platform)
  ]);
  return {
    commands: {
      ocx: { available: ocxVersion.ok, version: firstLine(ocxVersion) },
      codex: { available: codexVersion.ok, version: firstLine(codexVersion) },
      claude: { available: claudeVersion.ok, version: firstLine(claudeVersion) }
    },
    health: parseJson(health),
    systemStatus: parseJson(systemStatus),
    claudeConfig: parseJson(claudeConfig),
    executable: ocx,
    ocxInstallations: {
      configured: { executable: ocx, available: ocxVersion.ok, version: firstLine(ocxVersion) },
      shell: shellOcxVersion
        ? { executable: 'ocx', available: shellOcxVersion.ok, version: firstLine(shellOcxVersion) }
        : null
    }
  };
}

function summarizeStatus(inspected, platform = process.platform) {
  const proxyReady = inspected.health?.ok === true;
  const codexConnected = inspected.systemStatus?.startup?.routingInjected === true;
  const plainClaudeConnected = platform === 'darwin' && inspected.claudeConfig?.systemEnv === true;
  const commandsReady = inspected.commands.ocx.available
    && inspected.commands.codex.available
    && inspected.commands.claude.available;
  const ocxVersionSkew = Boolean(
    inspected.ocxInstallations.shell?.available
    && inspected.ocxInstallations.configured.available
    && inspected.ocxInstallations.shell.version !== inspected.ocxInstallations.configured.version
  );
  const nativeDefaultsReady = !codexConnected && !plainClaudeConnected;
  const codexRoute = !inspected.commands.codex.available
    ? 'unavailable'
    : codexConnected
      ? proxyReady ? 'ocx-legacy' : 'broken-ocx-legacy'
      : 'native';
  const claudeRoute = !inspected.commands.claude.available
    ? 'unavailable'
    : plainClaudeConnected
      ? proxyReady ? 'ocx-legacy' : 'broken-ocx-legacy'
      : 'native';
  return {
    ok: commandsReady && nativeDefaultsReady && !ocxVersionSkew,
    proxyReady,
    codexConnected,
    codexNative: inspected.commands.codex.available && !codexConnected,
    commands: inspected.commands,
    ocxInstallations: inspected.ocxInstallations,
    ocxVersionSkew,
    routing: {
      codex: codexRoute,
      claude: claudeRoute,
      ocx: proxyReady ? 'ready-explicit' : 'off-explicit'
    },
    plainClaudeConnected,
    note: ocxVersionSkew
      ? 'OCX 설정 경로와 셸 경로의 버전이 다릅니다. 기본 Native 경로는 유지하고 OCX package를 한 번에 정합화하십시오.'
      : codexConnected || plainClaudeConnected
      ? '기본 CLI에 legacy OCX 연결이 남아 있습니다. Codex와 Claude 기본 경로를 Native로 복원한 뒤 OCX는 명시형 실행기만 사용하십시오.'
      : 'Codex와 Claude 기본 경로는 Native입니다. OCX는 codex-ocx 또는 ocx claude로 명시할 때만 사용합니다.'
  };
}

export async function cliToolStatus(options = {}) {
  const platform = options.platform ?? process.platform;
  return summarizeStatus(await inspectCli({ ...options, platform }), platform);
}

async function installPackage(runner, npmExecutable, spec, platform) {
  return runPlatformCommand(runner, npmExecutable, ['install', '--global', spec], { timeoutMs: 180_000 }, platform);
}

export async function setupCliTools(options = {}) {
  const runner = options.runCommand ?? runCommand;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodeMajor = options.nodeMajor ?? Number(process.versions.node.split('.')[0]);
  const npmExecutable = env.AICC_NPM_EXECUTABLE?.trim() || 'npm';
  let inspected = await inspectCli({ runCommand: runner, env, platform });
  const installed = [];

  if (options.installMissing) {
    if (!inspected.commands.claude.available && nodeMajor < 22) {
      throw new Error('Claude Code 설치에는 Node.js 22 이상이 필요합니다. 아무 CLI도 설치하지 않았습니다.');
    }
    for (const name of ['ocx', 'codex', 'claude']) {
      if (inspected.commands[name].available) continue;
      const result = await installPackage(runner, npmExecutable, pinnedCliPackages[name], platform);
      if (!result.ok) throw new Error(`${pinnedCliPackages[name]} 설치에 실패했습니다.`);
      installed.push(pinnedCliPackages[name]);
    }
    inspected = await inspectCli({ runCommand: runner, env, platform });
  }

  const missing = Object.entries(inspected.commands).filter(([, value]) => !value.available).map(([name]) => name);
  const summary = summarizeStatus(inspected, platform);
  if (missing.length > 0) {
    return {
      ...summary,
      ok: false,
      installed,
      missing,
      installCommand: 'aicc cli setup --install-missing'
    };
  }

  const finalState = await inspectCli({ runCommand: runner, env, platform });
  return { ...summarizeStatus(finalState, platform), installed, missing: [] };
}
