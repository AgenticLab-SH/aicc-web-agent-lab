#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexAppServerClient, loadAppServerManifest, summarizeReadState } from './adapters/codex-app-server.mjs';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) result[argv[i].replace(/^--/, '')] = argv[i + 1];
  return result;
}

export async function runRescue(options, { Client = CodexAppServerClient } = {}) {
  for (const key of ['route', 'profile-home', 'workspace', 'mode', 'manifest', 'base-url']) if (!options[key]) throw new Error(`--${key} is required`);
  if (!['integrated', 'web-gpt-direct', 'ocx-direct', 'native-direct'].includes(options.route)) throw new Error('unknown explicit route');
  const endpoint = new URL(options['base-url']);
  if (options.route === 'integrated' && endpoint.port !== '17841') throw new Error('integrated route must explicitly target 17841');
  if (options.route === 'ocx-direct' && endpoint.port !== '10100') throw new Error('ocx-direct must explicitly target 10100');
  if (options.route === 'web-gpt-direct' && endpoint.port === '17841') throw new Error('web-gpt-direct cannot depend on 17841');
  if (options.route === 'native-direct' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname)) throw new Error('native-direct cannot target a loopback router');
  let mode = options.mode;
  const writerLease = options['writer-lease'];
  if (writerLease && fs.existsSync(writerLease) && mode === 'write') mode = 'read-only';
  if (mode !== 'read-only') throw new Error('Phase 03 rescue supports read-only diagnosis only');
  const manifest = loadAppServerManifest(options.manifest);
  const args = ['app-server', '--listen', 'stdio://', '-c', `openai_base_url=${JSON.stringify(options['base-url'])}`];
  if (options['model-provider']) args.push('-c', `model_provider=${JSON.stringify(options['model-provider'])}`);
  const client = new Client({ cwd: path.resolve(options.workspace), env: { ...process.env, CODEX_HOME: path.resolve(options['profile-home']), AICC_CODEX_VERSION: manifest.codexVersion }, manifest, args });
  try {
    const runtime = await client.connect();
    const workspace = path.resolve(options.workspace);
    const [models, capabilities, skills, hooks, apps, threads] = await Promise.all([client.modelList(), client.providerCapabilities(), client.skillsList({ cwds: [workspace], forceReload: false }), client.hooksList({ cwds: [workspace] }), client.appsInstalled({ forceRefresh: false }), client.threadList({ limit: 1, cwd: workspace, useStateDbOnly: true })]);
    return { ok: true, route: options.route, endpoint: options['base-url'], mode, workspace: path.resolve(options.workspace), runtime, state: summarizeReadState({ models, capabilities, skills, hooks, apps, threads }), silentFailover: false };
  } finally { client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runRescue(parseArgs(process.argv.slice(2))).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
