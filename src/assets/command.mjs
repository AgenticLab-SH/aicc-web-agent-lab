import fs from 'node:fs';
import path from 'node:path';
import { createAssetControlService } from './service.mjs';
import { assetAuditTick } from './scheduled-audit.mjs';
import { NotionAssetConnector } from './notion-connector.mjs';

export class AssetCommandError extends Error {
  constructor(code, message) { super(message); this.name = 'AssetCommandError'; this.code = code; }
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new AssetCommandError('option_required', `${name} requires a value`);
  return value;
}

function readJson(file, label) {
  if (!file || !path.isAbsolute(file)) throw new AssetCommandError('absolute_path_required', `${label} requires an absolute path`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AssetCommandError('file_invalid', `${label} must be a regular file`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new AssetCommandError('json_invalid', `${label} is not valid JSON`); }
}

function notionConnector(configFile, dependencies = {}) {
  const config = readJson(configFile, 'Notion connector config');
  const tokenEnv = String(config.tokenEnv ?? '');
  if (!/^[A-Z][A-Z0-9_]+$/.test(tokenEnv)) throw new AssetCommandError('token_reference_invalid', 'config.tokenEnv must name an explicit environment variable');
  const token = (dependencies.env ?? process.env)[tokenEnv];
  if (!token) throw new AssetCommandError('token_unavailable', `Notion credential is unavailable through ${tokenEnv}`);
  return new NotionAssetConnector({ config, token, fetchImpl: dependencies.fetchImpl });
}

export async function runAssetCommand(args, dependencies = {}) {
  const command = args[0] ?? 'status';
  const service = dependencies.service ?? createAssetControlService(dependencies.serviceOptions);
  if (command === 'status') return service.status();
  if (command === 'audit') return assetAuditTick({ service, ...(dependencies.auditOptions ?? {}), force: args.includes('--force') });
  if (command === 'import-chatgpt') return service.importChatGptSnapshot(readJson(option(args, '--file'), 'ChatGPT asset export'));
  if (command === 'import-chatgpt-catalog') return service.importChatGptArchiveCatalog(readJson(option(args, '--file'), 'ChatGPT archive catalog'));
  if (command === 'chatgpt-catalog') return service.queryChatGptArchiveCatalog({
    accountAlias: option(args, '--account') ?? undefined,
    kind: option(args, '--kind') ?? undefined,
    status: option(args, '--status') ?? undefined,
    query: option(args, '--query') ?? undefined,
    limit: Number(option(args, '--limit') ?? 25),
    cursor: Number(option(args, '--cursor') ?? 0)
  });
  if (command === 'notion-pull') {
    const connector = notionConnector(option(args, '--config'), dependencies);
    const snapshot = await connector.pullSnapshot();
    return { ...service.projectService.refreshNotionSnapshot(snapshot), source: 'notion-official-api', externalWritePerformed: false };
  }
  if (command === 'notion-priority-worker') {
    const connector = notionConnector(option(args, '--config'), dependencies);
    return connector.runPriorityOperation({ projectService: service.projectService, operationId: option(args, '--operation'), workerId: option(args, '--worker') });
  }
  if (command === 'notion-asset-plan') {
    const connector = notionConnector(option(args, '--config'), dependencies);
    const remote = await connector.pullAssetSnapshot();
    service.saveNotionAssetSnapshot(remote);
    return connector.planAssetMirror(service.inventory(), remote);
  }
  if (command === 'notion-asset-worker') {
    const connector = notionConnector(option(args, '--config'), dependencies);
    const operationId = option(args, '--operation');
    const workerId = option(args, '--worker');
    const operation = service.operations.status().operations.find(item => item.operationId === operationId);
    if (!operation) throw new AssetCommandError('operation_not_found', 'asset operation is not present in the journal');
    let prepared = false;
    try {
      let observedFingerprint;
      let targetPage = null;
      if (operation.action === 'create') {
        const local = service.inventory().assets.find(asset => asset.assetId === operation.assetId);
        if (!local) throw new AssetCommandError('asset_not_found', 'local asset is not present');
        observedFingerprint = local.fingerprint;
      } else {
        const pages = await connector.queryPages();
        targetPage = pages.find(page => page.id === operation.patch?.pageId);
        if (!targetPage) throw new AssetCommandError('notion_page_not_found', 'exact Notion asset page is not present');
        observedFingerprint = connector.assetPageFingerprint(targetPage);
      }
      service.prepareOperation(operationId, { workerId, observedFingerprint });
      prepared = true;
      const applied = operation.action === 'create'
        ? await connector.createAssetPage({ values: operation.patch?.values })
        : await connector.updatePageProperties({ pageId: operation.patch?.pageId, expectedLastEditedTime: operation.patch?.expectedLastEditedTime, values: operation.patch?.values });
      const verifiedFingerprint = connector.assetPageFingerprint(applied.page);
      const completed = service.completeOperation(operationId, { workerId, verifiedFingerprint });
      return { ...completed, externalWritePerformed: true };
    } catch (error) {
      if (prepared) service.failOperation(operationId, { workerId, errorCode: error?.code ?? 'notion_asset_sync_failed', effectMayHaveOccurred: error?.effectMayHaveOccurred !== false });
      throw error;
    }
  }
  throw new AssetCommandError('command_unknown', `unknown assets command: ${command}`);
}
