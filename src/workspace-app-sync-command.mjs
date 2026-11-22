import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { planWorkspaceAppSync, verifyWorkspaceAppSyncPostRead } from './workspace-app-lifecycle.mjs';
import { buildWorkspaceAppSyncRequest } from './workspace-app-topology.mjs';
import { workspaceAppSyncStatus } from './workspace-app-status.mjs';
import { enumerateWorkspaceAppSyncOperations, executeWorkspaceAppSyncOperation } from './workspace-app-sync-executor.mjs';
import { createHash } from 'node:crypto';

export const WORKSPACE_APP_SYNC_HELP = `AICC Workspace app/plugin sync

Usage:
  aicc workspace app-sync status [--state-root ABSOLUTE_DIRECTORY] [--json]
  aicc workspace app-sync inventory --request-file ABSOLUTE_JSON --driver-file ABSOLUTE_MJS --driver-sha256 HASH [--json]
  aicc workspace app-sync plan --request-file ABSOLUTE_JSON [--json]
  aicc workspace app-sync plan --topology-file ABSOLUTE_JSON --inventory-file ABSOLUTE_JSON [--json]
  aicc workspace app-sync operations --plan-file ABSOLUTE_JSON [--json]
  aicc workspace app-sync verify --plan-file ABSOLUTE_JSON --post-read-file ABSOLUTE_JSON [--json]
  aicc workspace app-sync execute --plan-file ABSOLUTE_JSON --operation-id ID --driver-file ABSOLUTE_MJS --driver-sha256 HASH --state-root ABSOLUTE_DIRECTORY [--commit] [--json]
  aicc workspace app-sync --help

status/plan/operations/verify는 읽기 전용입니다. create/update/share/enable/disable/delete를 stable app ID와
account/surface preimage에 결속해 계획하며 원격 변경은 별도 one-shot executor가 수행합니다.`;

const VALUE_OPTIONS = new Set(['--state-root', '--request-file', '--topology-file', '--inventory-file', '--plan-file', '--post-read-file', '--operation-id', '--driver-file', '--driver-sha256']);

function regularJson(file, label) {
  if (!path.isAbsolute(file)) throw new Error(`${label} must be an absolute path`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function parseWorkspaceAppSyncArgs(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) return Object.freeze({ mode: 'help', json: false });
  const mode = argv[0];
  if (!['status', 'inventory', 'plan', 'operations', 'verify', 'execute'].includes(mode)) throw new Error('expected status, inventory, plan, operations, verify or execute');
  const parsed = { mode, json: false, stateRoot: null, requestFile: null, topologyFile: null, inventoryFile: null, planFile: null, postReadFile: null };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (seen.has(token)) throw new Error(`duplicate option: ${token}`);
    seen.add(token);
    if (token === '--json') { parsed.json = true; continue; }
    if (token === '--commit' && mode === 'execute') { parsed.commit = true; continue; }
    if (!VALUE_OPTIONS.has(token)) throw new Error(`unknown option: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${token} requires a value`);
    if (token === '--operation-id') {
      if (!/^appsync-[a-f0-9]{24}$/.test(value)) throw new Error('invalid operation ID');
      parsed.operationId = value; index += 1; continue;
    }
    if (token === '--driver-sha256') {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid driver SHA256');
      parsed.driverHash = value; index += 1; continue;
    }
    if (!path.isAbsolute(value)) throw new Error(`${token} must be an absolute path`);
    index += 1;
    if (token === '--state-root') parsed.stateRoot = path.resolve(value);
    if (token === '--request-file') parsed.requestFile = path.resolve(value);
    if (token === '--topology-file') parsed.topologyFile = path.resolve(value);
    if (token === '--inventory-file') parsed.inventoryFile = path.resolve(value);
    if (token === '--plan-file') parsed.planFile = path.resolve(value);
    if (token === '--post-read-file') parsed.postReadFile = path.resolve(value);
    if (token === '--driver-file') parsed.driverFile = path.resolve(value);
  }
  if (mode === 'status' && (parsed.requestFile || parsed.topologyFile || parsed.inventoryFile || parsed.planFile || parsed.postReadFile)) {
    throw new Error('status accepts only --state-root and --json');
  }
  if (!['status', 'execute'].includes(mode) && parsed.stateRoot) throw new Error('--state-root is only valid with status or execute');
  if (!['execute','inventory'].includes(mode) && (parsed.driverFile || parsed.driverHash || parsed.operationId)) throw new Error('driver options require execute or inventory');
  if(mode==='inventory' && (!parsed.requestFile || !parsed.driverFile || !parsed.driverHash || parsed.operationId || parsed.stateRoot || parsed.planFile || parsed.postReadFile || parsed.topologyFile || parsed.inventoryFile))throw new Error('inventory requires only exact request and pinned driver');
  if (mode === 'execute' && (!parsed.planFile || !parsed.driverFile || !parsed.driverHash || !parsed.operationId || !parsed.stateRoot || parsed.postReadFile || parsed.requestFile || parsed.topologyFile || parsed.inventoryFile)) {
    throw new Error('execute requires an exact plan, operation, pinned driver and state root');
  }
  if (mode === 'plan') {
    const direct = parsed.requestFile && !parsed.topologyFile && !parsed.inventoryFile;
    const expanded = !parsed.requestFile && parsed.topologyFile && parsed.inventoryFile;
    if ((!direct && !expanded) || parsed.planFile || parsed.postReadFile) {
      throw new Error('plan requires --request-file or the exact --topology-file/--inventory-file pair');
    }
  }
  if (mode === 'verify' && (!parsed.planFile || !parsed.postReadFile || parsed.requestFile || parsed.topologyFile || parsed.inventoryFile)) {
    throw new Error('verify requires only --plan-file and --post-read-file');
  }
  if (mode === 'operations' && (!parsed.planFile || parsed.postReadFile || parsed.requestFile || parsed.topologyFile || parsed.inventoryFile)) {
    throw new Error('operations requires only --plan-file');
  }
  return Object.freeze(parsed);
}

export function runWorkspaceAppSyncCommand(argv = []) {
  const parsed = parseWorkspaceAppSyncArgs(argv);
  if (parsed.mode === 'execute') return executeCommand(parsed);
  if (parsed.mode === 'inventory') return inventoryCommand(parsed);
  if (parsed.mode === 'help') return { output: WORKSPACE_APP_SYNC_HELP, result: null, exitCode: 0 };
  const result = parsed.mode === 'status'
    ? workspaceAppSyncStatus(parsed.stateRoot ? { stateRoot: parsed.stateRoot } : {})
    : parsed.mode === 'plan'
    ? planWorkspaceAppSync(parsed.requestFile
      ? regularJson(parsed.requestFile, '--request-file')
      : buildWorkspaceAppSyncRequest(
        regularJson(parsed.topologyFile, '--topology-file'),
        regularJson(parsed.inventoryFile, '--inventory-file')
      ))
    : parsed.mode === 'operations'
      ? enumerateWorkspaceAppSyncOperations(regularJson(parsed.planFile, '--plan-file'))
      : verifyWorkspaceAppSyncPostRead(
      regularJson(parsed.planFile, '--plan-file'),
      regularJson(parsed.postReadFile, '--post-read-file')
    );
  const output = parsed.json ? `${JSON.stringify(result, null, 2)}\n`
    : parsed.mode === 'status'
      ? `${result.state === 'ready' ? 'PASS' : 'HOLD'}: ${result.detail}\n`
      : `${parsed.mode === 'plan' ? 'PLAN' : parsed.mode === 'operations' ? `OPERATIONS ${result.operations.length}` : result.status.toUpperCase()}: AICC Workspace app sync\n`;
  return { output, result, exitCode: result.status === 'hold' ? 3 : 0 };
}

async function loadPinnedDriver(parsed) {
  const driverStat = fs.lstatSync(parsed.driverFile);
  if (!driverStat.isFile() || driverStat.isSymbolicLink() || path.extname(parsed.driverFile) !== '.mjs') throw new Error('driver must be a regular .mjs file');
  const driverHash = createHash('sha256').update(fs.readFileSync(parsed.driverFile)).digest('hex');
  if (driverHash !== parsed.driverHash) throw new Error('driver SHA256 changed');
  const { driver } = await import(pathToFileURL(parsed.driverFile).href);
  if(!driver || typeof driver.inspect!=='function' || typeof driver.apply!=='function')throw new Error('driver must provide inspect and apply');
  return {driver,driverHash};
}

async function inventoryCommand(parsed) {
  const request=regularJson(parsed.requestFile,'--request-file');
  if(request.schemaVersion!==1 || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(request.accountAlias ?? '') || !['business-full','personal-read-fetch'].includes(request.surfaceProfile))throw new Error('inventory requires an exact account and capability surface');
  const {driver}=await loadPinnedDriver(parsed);
  const inventory=await driver.inspect({accountAlias:request.accountAlias,surfaceProfile:request.surfaceProfile});
  if(inventory?.accountAlias!==request.accountAlias)throw new Error('driver inventory account mismatch');
  const result={schemaVersion:1,remoteMutation:false,inventory};
  return {output:`${JSON.stringify(result,null,2)}\n`,result,exitCode:0};
}

async function executeCommand(parsed) {
  const plan = regularJson(parsed.planFile, '--plan-file');
  const {driver,driverHash}=await loadPinnedDriver(parsed);
  const selected = enumerateWorkspaceAppSyncOperations(plan).operations.find(item => item.operationId === parsed.operationId);
  if (!selected) throw new Error('Operation ID is outside the plan');
  const observedAt = plan.accountPlans.find(item => item.accountAlias === selected.accountAlias)?.observedAt;
  const age = Date.now() - Date.parse(observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30 * 60_000) throw new Error('Plan inventory is stale; take a new inventory');
  const root = path.join(parsed.stateRoot, 'workspace-app-sync', 'operations');
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('journal root cannot contain links');
    if (path.dirname(cursor) === cursor) break;
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const journalPath = path.join(root, `${parsed.operationId}.json`);
  let fd;
  if (parsed.commit) {
    // Claim durably before touching the remote. An uncertain or completed operation is never replayed.
    fd = fs.openSync(journalPath, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ schemaVersion: 1, terminal: 'CLAIMED', operationId: parsed.operationId, driverHash }));
    fs.fsyncSync(fd);
  }
  const save = value => {
    if (fd === undefined) return;
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify(value), 0, 'utf8');
    fs.fsyncSync(fd);
  };
  try {
    const result = await executeWorkspaceAppSyncOperation({ plan, operationId: parsed.operationId, commit: parsed.commit === true }, driver, {
      onDispatching: event => save({ schemaVersion: 1, terminal: 'DISPATCHING', ...event, driverHash }),
    });
    save({ ...result, driverHash, completedAt: new Date().toISOString() });
    return { output: `${JSON.stringify(result, null, 2)}\n`, result, exitCode: result.ok ? 0 : 3 };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const execution = await runWorkspaceAppSyncCommand(process.argv.slice(2));
    process.stdout.write(execution.output);
    process.exitCode = execution.exitCode;
  } catch (error) {
    process.stderr.write(`workspace-app-sync: ${error.message}\n`);
    process.exitCode = 1;
  }
}
