import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensionRegistry } from '../extensions/registry.mjs';
import { createProjectCatalogService } from '../projects/service.mjs';
import { buildAssetInventory, collectSkillAssets, pluginAsset, projectAsset } from './asset-registry.mjs';
import { ChatGptAssetImportStore } from './chatgpt-import.mjs';
import { ChatGptArchiveCatalogStore } from './chatgpt-catalog.mjs';
import { AssetOperationJournal } from './operation-journal.mjs';
import crypto from 'node:crypto';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function stateRoot(options = {}) {
  return path.resolve(options.root ?? path.join(options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center'), 'asset-control'));
}

export class AssetControlService {
  constructor({ root, stateRoot: ownerStateRoot, projectService, extensionRegistry, skillRoot = path.join(repositoryRoot, 'guidance', 'skills'), now = () => Date.now() } = {}) {
    this.root = stateRoot({ root, stateRoot: ownerStateRoot });
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(this.root, 0o700);
    this.now = now;
    this.projectService = projectService ?? createProjectCatalogService({ stateRoot: ownerStateRoot });
    this.extensionRegistry = extensionRegistry ?? new ExtensionRegistry({ root: repositoryRoot });
    this.skillRoot = skillRoot;
    this.chatgpt = new ChatGptAssetImportStore({ root: path.join(this.root, 'imports'), now });
    this.chatgptArchive = new ChatGptArchiveCatalogStore({ root: path.join(this.root, 'imports'), now });
    this.operations = new AssetOperationJournal({ root: path.join(this.root, 'operations'), now });
    this.notionAssetFile = path.join(this.root, 'notion-asset-snapshot.json');
  }

  inventory() {
    const observedAt = new Date(this.now()).toISOString();
    const projects = this.projectService.catalog().projects.map(project => projectAsset(project, observedAt));
    const skills = collectSkillAssets({ skillRoot: this.skillRoot, observedAt });
    const plugins = this.extensionRegistry.load().extensions.map(entry => pluginAsset(entry, observedAt));
    const chatgpt = new Map(this.chatgptArchive.assets().map(asset => [asset.assetId, asset]));
    for (const asset of this.chatgpt.read().assets) chatgpt.set(asset.assetId, asset);
    return buildAssetInventory({ projects, skills, plugins, chatgpt: [...chatgpt.values()], generatedAt: observedAt });
  }

  status() {
    const notionAssets = this.notionAssetSnapshot();
    return {
      ...this.inventory(),
      operations: this.operations.status(),
      notionAssetSource: { available: notionAssets.version !== null, version: notionAssets.version, capturedAt: notionAssets.capturedAt, count: notionAssets.assets.length },
      chatgptArchive: this.chatgptArchive.status(),
      externalWritePerformed: false
    };
  }

  notionAssetSnapshot() {
    try {
      const stat = fs.lstatSync(this.notionAssetFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Notion asset snapshot must be a regular owner file');
      return JSON.parse(fs.readFileSync(this.notionAssetFile, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, version: null, capturedAt: null, assets: [] };
      throw error;
    }
  }

  saveNotionAssetSnapshot(snapshot) {
    if (!snapshot || !/^notion-assets-[a-f0-9]{64}$/.test(String(snapshot.version ?? '')) || !Array.isArray(snapshot.assets) || !Number.isFinite(Date.parse(snapshot.capturedAt))) {
      throw new Error('Notion asset snapshot is invalid');
    }
    const temporary = `${this.notionAssetFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, this.notionAssetFile);
    return { saved: true, version: snapshot.version, capturedAt: snapshot.capturedAt, assets: snapshot.assets.length, externalWritePerformed: false };
  }

  importChatGptSnapshot(snapshot) { return this.chatgpt.import(snapshot); }
  importChatGptArchiveCatalog(catalog) { return this.chatgptArchive.import(catalog); }
  queryChatGptArchiveCatalog(input) { return this.chatgptArchive.query(input); }
  previewOperation(input) { return this.operations.preview(input); }
  confirmOperation(token) { return this.operations.confirm(token); }
  prepareOperation(operationId, input) { return this.operations.prepare(operationId, input); }
  completeOperation(operationId, input) { return this.operations.complete(operationId, input); }
  failOperation(operationId, input) { return this.operations.fail(operationId, input); }
}

export function createAssetControlService(options = {}) { return new AssetControlService(options); }
