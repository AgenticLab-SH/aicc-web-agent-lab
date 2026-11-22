#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STABLE_METHODS = Object.freeze([
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/list',
  'thread/read',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'model/list',
  'modelProvider/capabilities/read',
  'skills/list',
  'hooks/list',
  'app/installed'
]);

// Optional on older binaries; never infer availability from public docs alone.
const OPTIONAL_READ_METHODS = Object.freeze(['thread/goal/get', 'account/rateLimits/read']);

const DENIED_METHODS = Object.freeze([
  'plugin/list',
  'plugin/installed',
  'plugin/install',
  'plugin/uninstall',
  'marketplace/add',
  'marketplace/remove',
  'marketplace/upgrade',
  'config/value/write',
  'config/batchWrite',
  'account/login/start',
  'account/logout'
]);

function parseVersion(output) {
  return String(output ?? '').trim().match(/(?:codex-cli\s+)?([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)/)?.[1] ?? null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function files(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...files(full));
    else if (entry.isFile()) output.push(full);
  }
  return output.sort();
}

export function treeHash(directory) {
  const rows = files(directory).map(file => {
    const relative = path.relative(directory, file).split(path.sep).join('/');
    return `${sha256(fs.readFileSync(file))}  ${relative}\n`;
  });
  return sha256(rows.join(''));
}

function treeMap(directory) {
  if (!directory || !fs.existsSync(directory)) return new Map();
  return new Map(files(directory).map(file => [
    path.relative(directory, file).split(path.sep).join('/'),
    sha256(fs.readFileSync(file))
  ]));
}

function treeDiff(beforeDirectory, afterDirectory) {
  const before = treeMap(beforeDirectory);
  const after = treeMap(afterDirectory);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [name, hash] of after) {
    if (!before.has(name)) added += 1;
    else if (before.get(name) !== hash) changed += 1;
  }
  for (const name of before.keys()) if (!after.has(name)) removed += 1;
  return { added, removed, changed };
}

function clientMethods(typescriptDirectory) {
  const source = fs.readFileSync(path.join(typescriptDirectory, 'ClientRequest.ts'), 'utf8');
  return new Set([...source.matchAll(/"method": "([^"]+)"/g)].map(match => match[1]));
}

function assertPrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const canonical = fs.realpathSync(directory);
  if (canonical !== path.resolve(directory)) throw new Error('contract_output_root_alias');
  const stat = fs.lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('contract_output_root_unsafe');
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) throw new Error('contract_output_root_permissions_unsafe');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('contract_output_root_owner_unsafe');
  }
  return canonical;
}

function runOrThrow(runCommand, executable, args, code) {
  const result = runCommand(executable, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (result?.error || result?.status !== 0) {
    const detail = String(result?.stderr || result?.stdout || result?.error?.message || 'unknown').trim().slice(0, 2_000);
    throw new Error(`${code}:${detail}`);
  }
  return String(result.stdout ?? '').trim();
}

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

export function prepareAppServerContract(options = {}) {
  const runCommand = options.spawnSync ?? spawnSync;
  const executable = fs.realpathSync(path.resolve(options.executable ?? ''));
  const outputRoot = assertPrivateDirectory(options.outputRoot ?? '');
  const baselineRoot = options.baselineRoot ? fs.realpathSync(path.resolve(options.baselineRoot)) : null;
  const version = parseVersion(runOrThrow(runCommand, executable, ['--version'], 'codex_version_failed'));
  if (!version) throw new Error('codex_version_invalid');
  const finalRoot = path.join(outputRoot, version);
  if (fs.existsSync(finalRoot)) throw new Error('contract_version_preexists');
  const staging = path.join(outputRoot, `.${version}.staging-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    const jsonSchema = path.join(staging, 'json-schema');
    const typescript = path.join(staging, 'typescript');
    runOrThrow(runCommand, executable, ['app-server', 'generate-json-schema', '--out', jsonSchema], 'json_schema_generation_failed');
    runOrThrow(runCommand, executable, ['app-server', 'generate-ts', '--out', typescript], 'typescript_generation_failed');
    const methods = clientMethods(typescript);
    const missingStableMethods = STABLE_METHODS.filter(method => !methods.has(method));
    if (missingStableMethods.length) throw new Error(`stable_methods_missing:${missingStableMethods.join(',')}`);
    const baselineManifest = baselineRoot && fs.existsSync(path.join(baselineRoot, 'manifest.json'))
      ? JSON.parse(fs.readFileSync(path.join(baselineRoot, 'manifest.json'), 'utf8'))
      : null;
    const baselineMethods = baselineRoot && fs.existsSync(path.join(baselineRoot, 'typescript', 'ClientRequest.ts'))
      ? clientMethods(path.join(baselineRoot, 'typescript'))
      : new Set();
    const goalSetSchemaFile = path.join(jsonSchema, 'v2', 'ThreadGoalSetParams.json');
    const goalSetSchema = fs.existsSync(goalSetSchemaFile)
      ? JSON.parse(fs.readFileSync(goalSetSchemaFile, 'utf8')) : null;
    const userGoalResumeSupported = methods.has('thread/goal/set') &&
      methods.has('thread/goal/get') && goalSetSchema?.required?.includes('threadId') &&
      goalSetSchema?.definitions?.ThreadGoalMutationOrigin?.enum?.includes('user') &&
      goalSetSchema?.definitions?.ThreadGoalStatus?.enum?.includes('active') &&
      goalSetSchema?.properties?.origin && goalSetSchema?.properties?.status &&
      !goalSetSchema?.required?.includes('objective');
    const manifest = {
      schemaVersion: 1,
      codexVersion: version,
      executable,
      executableSha256: sha256(fs.readFileSync(executable)),
      generatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      commands: {
        jsonSchema: 'codex app-server generate-json-schema --out <versioned-dir>',
        typescript: 'codex app-server generate-ts --out <versioned-dir>',
        experimentalIncluded: false
      },
      outputs: {
        jsonSchema: { fileCount: files(jsonSchema).length, treeSha256: treeHash(jsonSchema) },
        typescript: { fileCount: files(typescript).length, treeSha256: treeHash(typescript) }
      },
      productionStableAllowlist: [...STABLE_METHODS, ...OPTIONAL_READ_METHODS.filter(method => methods.has(method))],
      userGoalResume: userGoalResumeSupported ? {
        method: 'thread/goal/set', provenanceField: 'origin',
        explicitUserOnly: true, defaultMutationAllowlisted: false,
        paramsSchemaSha256: sha256(fs.readFileSync(goalSetSchemaFile)),
        automaticQuotaResumeProven: false
      } : null,
      officialQuotaRead: methods.has('account/rateLimits/read') ? {
        method: 'account/rateLimits/read',
        generatedClientRequestSha256: sha256(fs.readFileSync(path.join(typescript, 'ClientRequest.ts'))),
        readOnly: true, accountScope: 'connected-app-server-auth',
        originalCliIssuerBound: false, quotaRecoveryAuthority: false,
        senderAllowed: false
      } : null,
      nativeParentGoalAuthority: {
        readMethod: methods.has('thread/goal/get') ? 'thread/goal/get' : null,
        authorityWiring: 'not-implemented',
        revisionAndMonotonicStopEpoch: 'not-established',
        authorityReady: false
      },
      denyByDefault: [...DENIED_METHODS],
      compatibilityDiff: baselineRoot ? {
        baseline: baselineManifest?.codexVersion ?? path.basename(baselineRoot),
        jsonSchema: treeDiff(path.join(baselineRoot, 'json-schema'), jsonSchema),
        typescript: treeDiff(path.join(baselineRoot, 'typescript'), typescript),
        clientRequestMethods: {
          added: [...methods].filter(method => !baselineMethods.has(method)).length,
          removed: [...baselineMethods].filter(method => !methods.has(method)).length
        }
      } : null,
      callbackRequiredMethods: ['initialize', 'thread/read', 'thread/resume', 'turn/start'],
      compatibilityGaps: [
        'App Server is experimental; callback consumers pin this exact executable, version and manifest hash.',
        'Only reviewed stable methods are allowed; plugin, marketplace, config and account mutations remain denied.',
        'A generated contract proves protocol shape, not a running daemon, Desktop attachment or callback delivery.',
        'Official rate limits read describes the connected App Server account, not original OCX issuer/ownerRevision/stopEpoch/sender authority.'
      ]
    };
    atomicJson(path.join(staging, 'manifest.json'), manifest);
    fs.renameSync(staging, finalRoot);
    return Object.freeze({
      ok: true,
      version,
      root: finalRoot,
      manifestFile: path.join(finalRoot, 'manifest.json'),
      executableSha256: manifest.executableSha256,
      jsonSchema: manifest.outputs.jsonSchema,
      typescript: manifest.outputs.typescript,
      compatibilityDiff: manifest.compatibilityDiff,
      stableMethodCount: STABLE_METHODS.length,
      optionalReadMethodCount: OPTIONAL_READ_METHODS.filter(method => methods.has(method)).length,
      deniedMethodCount: DENIED_METHODS.length
    });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function required(name) {
  const value = String(option(name) ?? '').trim();
  if (!value) throw new Error(`missing_option:${name}`);
  return value;
}

function main() {
  const result = prepareAppServerContract({
    executable: required('--binary'),
    outputRoot: required('--output-root'),
    baselineRoot: option('--baseline') ?? undefined
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(); }
  catch (error) {
    process.stderr.write(`HOLD: ${error.message}\n`);
    process.exitCode = 1;
  }
}
