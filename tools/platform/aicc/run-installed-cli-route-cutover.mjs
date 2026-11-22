import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTokenHash } from '../../../src/recovery/attempt-journal.mjs';
import { createInstalledCliRouteAdapter } from '../../../src/recovery/installed-cli-route-adapter.mjs';
import { createRestoreV2Candidate } from '../../../src/recovery/restore-v2-candidate.mjs';
import { codexWorkGateStatus } from '../../../src/codex-work-gate.mjs';

function option(argv, name, { required = true, multiple = false } = {}) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(argv[index + 1]);
  }
  if (required && values.length === 0) throw new Error(`${name} is required`);
  if (!multiple && values.length > 1) throw new Error(`${name} must appear once`);
  return multiple ? values : values[0] ?? null;
}

function absolute(value, name) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return path.resolve(value);
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('owner_directory_unsafe');
}

function atomicReceipt(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}-${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function writerIdentity() {
  const executableHash = crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex');
  const startedAt = new Date(Date.now() - Math.max(0, process.uptime() * 1_000)).toISOString();
  return {
    pid: process.pid,
    processStartTokenHash: processStartTokenHash({ pid: process.pid, startedAt, executableHash }),
    executableHash
  };
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function runInstalledCliRouteCutover(argv = process.argv.slice(2), dependencies = {}) {
  const stateRoot = absolute(option(argv, '--state-root'), '--state-root');
  const entryPath = absolute(option(argv, '--entry'), '--entry');
  const candidatePath = absolute(option(argv, '--candidate'), '--candidate');
  const backupRoot = absolute(option(argv, '--backup-root'), '--backup-root');
  const receiptPath = absolute(option(argv, '--receipt'), '--receipt');
  const recoveryScriptPath = absolute(option(argv, '--recovery-script'), '--recovery-script');
  const wrapperPaths = option(argv, '--wrapper', { multiple: true }).map(value => absolute(value, '--wrapper'));
  const legacyPointerValue = option(argv, '--legacy-pointer', { required: false });
  const legacyPointerPath = legacyPointerValue ? absolute(legacyPointerValue, '--legacy-pointer') : null;
  const waitMs = Number(option(argv, '--wait-ms', { required: false }) ?? 0);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30 * 60_000) throw new Error('--wait-ms is out of range');
  privateDirectory(backupRoot);
  const inspectGate = dependencies.inspectGate ?? codexWorkGateStatus;
  const sleep = dependencies.wait ?? wait;
  const deadline = Date.now() + waitMs;
  let gate;
  while (true) {
    gate = inspectGate();
    if (gate?.readOk === true && gate?.exactIdle === true && gate.activeCount === 0 && gate.unknownCount === 0) break;
    if (Date.now() >= deadline) {
      const receipt = {
        schemaVersion: 1,
        component: 'installed-cli-route',
        terminal: 'HOLD_PRE_DISPATCH',
        reason: 'exact_idle_not_reached',
        activeCount: Number.isInteger(gate?.activeCount) ? gate.activeCount : null,
        unknownCount: Number.isInteger(gate?.unknownCount) ? gate.unknownCount : null,
        completedAt: new Date().toISOString()
      };
      atomicReceipt(receiptPath, receipt);
      return { exitCode: 3, receipt };
    }
    await sleep(5_000);
  }
  const adapter = createInstalledCliRouteAdapter({
    entryPath,
    candidatePath,
    backupRoot,
    wrapperPaths,
    legacyPointerPath,
    recoveryScriptPath
  });
  const inspection = await adapter.inspect({ mode: 'status' });
  if (inspection.current === true && inspection.fingerprintVerified === true) {
    const receipt = {
      schemaVersion: 1,
      component: 'installed-cli-route',
      terminal: 'NOT_APPLICABLE',
      reason: 'candidate_already_installed',
      candidatePath,
      completedAt: new Date().toISOString()
    };
    atomicReceipt(receiptPath, receipt);
    return { exitCode: 0, receipt };
  }
  if (!inspection.fingerprintVerified || !inspection.fingerprintHash) {
    const receipt = {
      schemaVersion: 1,
      component: 'installed-cli-route',
      terminal: 'HOLD_PRE_DISPATCH',
      reason: inspection.reason ?? 'candidate_unverified',
      completedAt: new Date().toISOString()
    };
    atomicReceipt(receiptPath, receipt);
    return { exitCode: 3, receipt };
  }
  const operationId = `installed-cli-cutover-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const attemptId = `attempt-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const backupTarget = path.join(backupRoot, `${operationId}-${attemptId}`);
  const candidate = createRestoreV2Candidate({
    adapters: { 'installed-cli-route': adapter },
    journalRoot: path.join(stateRoot, 'recovery', 'v2'),
    inspectGlobalActivity: () => {
      const current = inspectGate();
      return {
        readOk: current?.readOk === true,
        generationHash: current?.readOk === true
          ? crypto.createHash('sha256').update(`${current.state ?? 'unknown'}:${current.activeCount}:${current.unknownCount}`).digest('hex')
          : null,
        domains: [{ id: 'codex-desktop', active: current?.activeCount ?? null, unknown: current?.unknownCount ?? null }]
      };
    },
    writerIdentity: writerIdentity(),
    gateSamples: 5,
    gateIntervalMs: 2_000
  });
  const execution = await candidate.run([
    'installed-cli-route', '--apply',
    '--operation-id', operationId,
    '--attempt-id', attemptId
  ]);
  const postRead = await adapter.inspect({ mode: 'status' });
  const receipt = {
    schemaVersion: 1,
    component: 'installed-cli-route',
    terminal: execution.result?.terminal ?? 'UNCERTAIN',
    reason: execution.result?.reason ?? 'unknown',
    operationId,
    attemptId,
    backupTarget,
    candidatePath,
    installedCandidate: postRead.current === true && postRead.fingerprintVerified === true,
    completedAt: new Date().toISOString()
  };
  atomicReceipt(receiptPath, receipt);
  return { exitCode: execution.exitCode, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const execution = await runInstalledCliRouteCutover();
    process.stdout.write(`${JSON.stringify(execution.receipt)}\n`);
    process.exitCode = execution.exitCode;
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 4;
  }
}
