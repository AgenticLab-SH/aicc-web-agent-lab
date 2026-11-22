// Build the queue delta from the installed generation. Unrelated installed fixes
// must survive; copying the current source server over an older release cannot
// establish that property. This module changes text only, never live files.
export const GPT_QUEUE_OVERLAY_FILES = Object.freeze([
  'components/workspace-mcp/server.mjs',
  'components/workspace-mcp/input-schemas.mjs',
  'components/workspace-mcp/tool-manifest.mjs',
  'components/workspace-mcp/runtime-integrity.mjs',
  'components/workspace-mcp/runtime-marker.mjs',
  'src/workspace-mcp.mjs',
  'tools/platform/chatgpt/Prepare-AiccWorkspacePublish.mjs',
  'components/workspace-mcp/gpt-queue-provider.mjs',
  'src/lib/windows-owner-only-acl.mjs',
  'src/lib/windows-pwsh.mjs'
]);

export const GPT_QUEUE_PROVIDER_ONLY_DELTA = Object.freeze([
  'components/workspace-mcp/gpt-queue-provider.mjs',
  '.aicc-release.json',
  'workspace-drive-manifest.json'
]);
const QUEUE_PROVIDER='components/workspace-mcp/gpt-queue-provider.mjs';
// The initial overlay is intentionally not idempotent. An installed generation
// is accepted only when its queue integration is complete and already present.
// Stage must also pin the installed release and the exact old/new provider SHA.
function assertInstalledQueueBaseline(installed) {
  const markers = {
    'components/workspace-mcp/server.mjs': ['gpt-queue-provider.mjs','aicc_gpt_queue_register','gptQueueAvailable:'],
    'components/workspace-mcp/input-schemas.mjs': ['aicc_gpt_queue_register:'],
    'components/workspace-mcp/tool-manifest.mjs': ['WORKSPACE_GPT_QUEUE_TOOLS'],
    'components/workspace-mcp/runtime-integrity.mjs': ["'components/workspace-mcp/gpt-queue-provider.mjs'"],
    'components/workspace-mcp/runtime-marker.mjs': ['gptQueueAvailable:'],
    'src/workspace-mcp.mjs': ['gptQueueAvailable:'],
    'tools/platform/chatgpt/Prepare-AiccWorkspacePublish.mjs': ['gptQueueAvailable:'],
    [QUEUE_PROVIDER]: ['verifyGptQueueOwnerConfig','createGptQueueExecutor']
  };
  for (const relative of GPT_QUEUE_OVERLAY_FILES) {
    const bytes = installed[relative];
    if (typeof bytes !== 'string' || bytes.includes('\0'))
      throw Error('QUEUE_OVERLAY_INSTALLED_BASELINE_UNPROVEN:' + relative);
    if ((markers[relative] ?? []).some(marker => !bytes.includes(marker)))
      throw Error('QUEUE_OVERLAY_INSTALLED_BASELINE_UNPROVEN:' + relative);
  }
}

const normalize = value => {
  if (typeof value !== 'string' || value.includes('\0')) throw Error('QUEUE_OVERLAY_TEXT_REQUIRED');
  return value.replace(/\r\n/g, '\n');
};
function insertOnce(text, anchor, addition, label) {
  if (!anchor || text.split(anchor).length !== 2) throw Error('QUEUE_OVERLAY_ANCHOR_CHANGED:' + label);
  return text.replace(anchor, addition);
}
function section(text, start, end, label) {
  const offset = text.indexOf(start);
  const stop = text.indexOf(end, offset + start.length);
  if (offset < 0 || stop <= offset || text.indexOf(start, offset + start.length) !== -1)
    throw Error('QUEUE_OVERLAY_SOURCE_BOUNDARY_CHANGED:' + label);
  return text.slice(offset, stop);
}
export function buildGptQueueRuntimeOverlay(installed, source, options = {}) {
  const mode = options.mode ?? (installed[QUEUE_PROVIDER] === undefined
    ? 'initial-install' : 'installed-provider-only');
  if (!['initial-install','installed-provider-only'].includes(mode))
    throw Error('QUEUE_OVERLAY_EXPLICIT_MODE_REQUIRED');
  const out = {};
  if (mode === 'installed-provider-only') {
    assertInstalledQueueBaseline(installed);
    const desiredProvider = normalize(source[QUEUE_PROVIDER]);
    if (!desiredProvider.includes('verifyGptQueueOwnerConfig') ||
        !desiredProvider.includes('createGptQueueExecutor') ||
        normalize(installed[QUEUE_PROVIDER]) === desiredProvider)
      throw Error('QUEUE_OVERLAY_PROVIDER_DELTA_NOT_REVIEWED');
    // Do not normalize, reserialize or copy unknown installed fixes. Return the
    // existing text byte-for-byte; only the reviewed provider is replaced.
    for (const relative of GPT_QUEUE_OVERLAY_FILES)
      out[relative] = relative === QUEUE_PROVIDER ? desiredProvider : installed[relative];
    return out;
  }
  for (const relative of GPT_QUEUE_OVERLAY_FILES) {
    const desired = normalize(source[relative]);
    if (relative.endsWith('/gpt-queue-provider.mjs')||relative.startsWith('src/lib/windows-')) {
      if (installed[relative] !== undefined) throw Error('QUEUE_OVERLAY_ALREADY_PRESENT');
      out[relative] = desired;
      continue;
    }
    let text = normalize(installed[relative]);
    if (text.includes('gptQueueAvailable:') || text.includes('aicc_gpt_queue_') ||
        text.includes('./gpt-queue-provider.mjs')) throw Error('QUEUE_OVERLAY_ALREADY_PRESENT');
    if (relative.endsWith('/server.mjs')) {
      const imported = "import { createCodexCliExecutor } from './codex-cli-provider.mjs';";
      text = insertOnce(text, imported, imported + "\nimport { createGptQueueExecutor } from './gpt-queue-provider.mjs';", relative);
      const executor = section(desired, '  const gptQueue = ', '  const remoteAuthority = ', 'executor');
      text = insertOnce(text, '  if (codexCli) codexCliExecutors.add(codexCli);',
        '  if (codexCli) codexCliExecutors.add(codexCli);\n' + executor, 'executor');
      const boundary = '  if (!personalReadFetch && config.webManagement?.enabled === true) {';
      const registration = section(desired, '  if (gptQueue) {', boundary, 'registrations');
      text = insertOnce(text, boundary, registration + boundary, 'registrations');
      const capability = 'codexCliAvailable: config.codexCli?.enabled === true';
      text = insertOnce(text, capability, capability + ',\n        gptQueueAvailable: config.gptQueue?.enabled === true', relative);
    } else if (relative.endsWith('/input-schemas.mjs')) {
      const boundary = '  aicc_web_management_start: {';
      text = insertOnce(text, boundary,
        section(desired, '  aicc_gpt_queue_register: {', boundary, 'schemas') + boundary, relative);
    } else if (relative.endsWith('/tool-manifest.mjs')) {
      const boundary = 'const PERSONAL_EXCLUDED_TOOLS = new Set([';
      text = insertOnce(text, boundary,
        section(desired, 'export const WORKSPACE_GPT_QUEUE_TOOLS = ', boundary, 'tools') + boundary, relative);
      const tail = '  return tools\n';
      text = insertOnce(text, tail,
        "  if (options.gptQueueAvailable === true && surfaceProfile === WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL)\n" +
        '    tools = [...tools,...WORKSPACE_GPT_QUEUE_TOOLS];\n' + tail, relative);
    } else if (relative.endsWith('/runtime-integrity.mjs')) {
      const anchor = "  'components/workspace-mcp/codex-cli-provider.mjs',";
      text = insertOnce(text, anchor, anchor + "\n  'components/workspace-mcp/gpt-queue-provider.mjs',\n  'src/lib/windows-owner-only-acl.mjs',\n  'src/lib/windows-pwsh.mjs',", relative);
    } else if (relative.endsWith('/Prepare-AiccWorkspacePublish.mjs')) {
      const anchor = 'codexCliAvailable: runtime.hostCapabilities?.codexCli === true';
      if (text.split(anchor).length !== 3) throw Error('QUEUE_OVERLAY_PUBLICATION_ANCHORS_CHANGED');
      text = text.replaceAll(anchor, anchor + ', gptQueueAvailable: runtime.hostCapabilities?.gptQueue === true');
    } else {
      const anchor = 'codexCliAvailable: config.codexCli?.enabled === true';
      text = insertOnce(text, anchor, anchor + ', gptQueueAvailable: config.gptQueue?.enabled === true', relative);
      if (relative === 'src/workspace-mcp.mjs') {
        const host = 'codexCli: config?.codexCli?.enabled === true';
        text = insertOnce(text, host, host + ', gptQueue: config?.gptQueue?.enabled === true', 'host capabilities');
      }
    }
    out[relative] = text;
  }
  return out;
}
