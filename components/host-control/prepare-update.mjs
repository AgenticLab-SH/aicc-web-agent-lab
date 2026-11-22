import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, builtinModules } from 'node:module';
import { parse as parseJavascript } from 'acorn';
import { HOST_TOOLS } from './server.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hostToolHash = tools => digest(JSON.stringify(canonical([...tools].sort((a, b) => a.name.localeCompare(b.name)))));
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function exact(target, kind = 'file', missing = false) {
  if (!path.isAbsolute(target ?? '')) throw Error('ABSOLUTE_PATH_REQUIRED');
  for (let cursor = target;; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw Error('LINK_REFUSED');
      if (cursor === target && (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) throw Error('WRONG_PATH_KIND');
    } else if (cursor === target && !missing) throw Error('PATH_MISSING');
    if (path.dirname(cursor) === cursor) break;
  }
  return target;
}
const hash = file => digest(fs.readFileSync(exact(file)));
const HOST_SOURCE_DEPENDENCIES = Object.freeze([
 'components/host-control/server.mjs',
 'components/host-control/cdp-browser.mjs',
 'src/browser/cdp-lease-provider.mjs',
 'src/browser/session-broker.mjs'
]);
export function hostSourceDependencyPins(root = fileURLToPath(new URL('../..', import.meta.url))) {
 const pins = HOST_SOURCE_DEPENDENCIES.map(relative => ({ relative, sha256: hash(path.join(root, relative)) }));
 return { pins, sha256: digest(JSON.stringify(pins)) };
}
const read = file => JSON.parse(fs.readFileSync(exact(file), 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value, resume = false) => {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n';
  if (resume && fs.existsSync(file)) {
    if (!fs.readFileSync(exact(file)).equals(Buffer.from(bytes))) throw Error('PARTIAL_PREPARE_BYTES_DIFFER_RECONCILE');
    return;
  }
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
};
function within(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('MANAGED_DESCENDANT_REQUIRED');
}
function validateGraph(config) {
  if (config.schemaVersion !== 1 || config.surfaceProfile !== 'business-full' || config.hostControl !== 'task-owned-v1'
    || !Array.isArray(config.providers) || config.providers.length !== 3
    || [...config.providers.map(p => p.id)].sort().join(',') !== 'host,native,workspace') throw Error('EXACT_EXISTING_HOST_GRAPH_REQUIRED');
  for (const provider of config.providers) {
    if (!Array.isArray(provider.files) || new Set(provider.files.map(pin => pin.path)).size !== provider.files.length
      || provider.args?.[0] !== provider.entrypoint || !provider.files.some(pin => pin.path === provider.command)
      || !provider.files.some(pin => pin.path === provider.entrypoint)) throw Error('PINNED_PROVIDER_REQUIRED');
    for (const pin of provider.files) if (hash(pin.path) !== pin.sha256) throw Error('PROVIDER_PIN_CHANGED');
  }
}

function proveWorkspaceOverlay(directory, { stateRoot, registry, oldGateway, manifest, configFile }) {
  exact(directory, 'directory'); within(path.join(stateRoot, 'backups'), directory);
  const files = Object.fromEntries(['plan.json', 'registry.before.json', 'journal.json', 'config.before.json', 'gateway-consume.json'].map(name => [name, path.join(directory, name)]));
  const plan = read(files['plan.json']), before = read(files['registry.before.json']), journal = read(files['journal.json']);
  if (plan.schemaVersion !== 1 || plan.status !== 'START_ACCEPTED_RUNTIME_UNOBSERVED' || journal.status !== plan.status
    || journal.operationId !== plan.operationId || journal.startAttempts !== 1 || journal.rollbackStartAttempts !== 0
    || !equal(plan.modelRoutesChanged, []) || plan.gatewayCandidate !== oldGateway
    || registry.components.workspace.releaseRoot !== plan.workspaceCandidate
    || !equal(plan.beforeWorkspace, before.components.workspace) || !equal(plan.beforeGateway, before.components['unified-mcp'])
    || plan.config !== configFile || plan.configBeforeSha256 !== hash(files['config.before.json']) || plan.configBeforeSha256 !== hash(configFile)
    || plan.desiredConfigSha256 !== plan.configBeforeSha256 || hash(plan.desiredConfig) !== plan.configBeforeSha256
    || plan.gatewayEntryHash !== hash(path.join(oldGateway, 'gateway.cjs'))) throw Error('WORKSPACE_OVERLAY_PROVENANCE_MISMATCH');
  const baseline = exact(plan.beforeGateway.releaseRoot, 'directory');
  within(path.join(stateRoot, 'releases', 'unified-mcp'), baseline);
  const baselineManifest = path.join(baseline, 'manifest.json'), baselineConfig = path.join(baseline, 'config.json');
  const consumedRecord = read(files['gateway-consume.json']);
  const consumed = read(consumedRecord.client.responseFile);
  const projected = structuredClone(consumedRecord.response), comparable = structuredClone(consumed);
  for (const value of [projected, comparable]) {
    if (value?.operation?.operationExpiresAt) value.operation.operationExpiresAt = new Date(value.operation.operationExpiresAt).toISOString();
  }
  const consumedRequest = read(consumedRecord.client.requestFile);
  if (hash(baselineManifest) !== hash(path.join(oldGateway, 'manifest.json'))
    || consumed?.ok !== true || consumed.phase !== 'CONSUMED' || consumed.action !== 'consume'
    || consumed.operation?.operationId !== plan.operationId || consumed.configSha256
    || path.resolve(consumed.identity?.configPath ?? '') !== path.resolve(baselineConfig)
    || consumed.identity?.configSha256 !== hash(baselineConfig)
    || consumedRecord.client.requestSha256 !== hash(consumedRecord.client.requestFile)
    || consumedRequest.operationId !== plan.operationId || consumedRequest.action !== 'consume'
    || consumedRequest.readySnapshotSha256 !== consumed.consumedSnapshotSha256
    || !equal(projected, comparable)) throw Error('WORKSPACE_OVERLAY_BASELINE_PROVENANCE_MISMATCH');
  const expected = read(baselineConfig), actual = read(path.join(oldGateway, 'config.json'));
  const workspace = expected.providers?.filter(provider => provider.id === 'workspace');
  if (workspace?.length !== 1) throw Error('EXACT_WORKSPACE_OVERLAY_PROVIDER_REQUIRED');
  const previousRoot = plan.beforeWorkspace.releaseRoot, candidateRoot = plan.workspaceCandidate;
  within(path.join(stateRoot, 'releases', 'workspace'), previousRoot); within(path.join(stateRoot, 'releases', 'workspace'), candidateRoot);
  const replace = value => value.split(previousRoot).join(candidateRoot);
  workspace[0].entrypoint = replace(workspace[0].entrypoint);
  workspace[0].args = workspace[0].args.map(replace);
  for (const pin of workspace[0].files) {
    if (pin.path.toLowerCase().startsWith(previousRoot.toLowerCase() + path.sep)) {
      pin.path = replace(pin.path); pin.sha256 = hash(pin.path);
    }
  }
  if (!equal(expected, actual)) throw Error('WORKSPACE_OVERLAY_GRAPH_CLOSURE_MISMATCH');
  const evidenceFiles = [...Object.values(files), consumedRecord.client.requestFile, consumedRecord.client.responseFile, plan.desiredConfig, baselineManifest, baselineConfig];
  return { kind: 'completed-workspace-provider-overlay', operationId: plan.operationId, directory,
    installedConfigSHA256: hash(path.join(oldGateway, 'config.json')), baselineConfigSHA256: hash(baselineConfig),
    files: evidenceFiles.map(file => ({ path: file, sha256: hash(file) })) };
}


const sha256Pattern = /^[a-f0-9]{64}$/;
const cdpKeys = new Set(['enabled','identities','leaseHelper','leaseHelperSha256','identityGuard','identityGuardSha256',
 'powershellSha256','playwrightModule','playwrightModuleSha256','identityAuditModule','identityAuditModuleSha256','downloadRoot']);
const identityKeys = new Set(['identityId','role','engine','appIdentity','executable','executableSha256','userDataRoot',
 'profile','cdpEndpoint','accountAlias','workspaceAlias','owner','ownershipPolicy','sessionIdentityHash','workspaceIdentityHash']);
const ownKeys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
function exactKeys(value, allowed, required = [...allowed]) {
 const keys = ownKeys(value);
 if (!keys.length || keys.some(key => !allowed.has(key)) || required.some(key => !keys.includes(key))) throw Error('CDP_BINDING_UNEXPECTED_OR_MISSING_FIELD');
}
function registeredBrowserSlots(coordinationFile) {
 const values = new Map(); let section = '';
 for (const raw of fs.readFileSync(exact(coordinationFile), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const line = raw.trim(); if (!line || line.startsWith('#')) continue;
  const head = line.match(/^\[([^\]]+)\]$/); if (head) { section = head[1]; continue; }
  if (section !== 'browser') continue;
  const pair = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (!pair || !/^cdp_slot(?:_count|[0-9]+_)/.test(pair[1])) continue;
  if (values.has(pair[1])) throw Error('CDP_COORDINATION_DUPLICATE_SLOT_FIELD');
  const value = pair[2].trim();
  const quoted = value.match(/^"([^"]*)"\s*(?:#.*)?$/);
  const integer = value.match(/^([0-9]+)\s*(?:#.*)?$/);
  values.set(pair[1], quoted ? quoted[1] : integer ? integer[1] : null);
 }
 const count = Number(values.get('cdp_slot_count'));
 if (!Number.isInteger(count) || count < 1 || count > 32) throw Error('CDP_COORDINATION_COUNT_UNPROVEN');
 const slots = [];
 for (let index = 1; index <= count; index++) {
  const prefix = 'cdp_slot' + index + '_';
  const fields = Object.fromEntries(['port','profile_dir','profile_directory','account_alias','workspace','usage']
   .map(key => [key, values.get(prefix + key)]));
  if (!Number.isInteger(Number(fields.port)) || Number(fields.port) < 1024 ||
      Number(fields.port) > 65535 || !fields.profile_dir || !fields.account_alias || !fields.workspace ||
      !fields.usage) throw Error('CDP_COORDINATION_REGISTRATION_INCOMPLETE');
  slots.push(fields);
 }
 return slots;
}
export function validateOwnerCdpBinding({ stateRoot, hostConfigFile, bindingFile, bindingSha256 }) {
 if (!sha256Pattern.test(bindingSha256 ?? '') || !path.isAbsolute(bindingFile ?? '')) throw Error('EXACT_OWNER_CDP_BINDING_PIN_REQUIRED');
 exact(bindingFile); within(stateRoot, bindingFile);
 if (hash(bindingFile) !== bindingSha256) throw Error('OWNER_CDP_BINDING_HASH_CHANGED');
 const binding = read(bindingFile);
 exactKeys(binding, new Set(['schemaVersion','kind','hostConfigBeforeSha256','coordinationFile','coordinationSha256','cdp']));
 if (binding.schemaVersion !== 1 || binding.kind !== 'host-cdp-owner-binding/v1' ||
     !sha256Pattern.test(binding.hostConfigBeforeSha256 ?? '') ||
     hash(hostConfigFile) !== binding.hostConfigBeforeSha256) throw Error('OWNER_CDP_HOST_PREIMAGE_CHANGED');
 const coord = path.join(stateRoot, 'guidance', 'coordination.toml');
 if (binding.coordinationFile !== coord || !sha256Pattern.test(binding.coordinationSha256 ?? '') ||
     hash(coord) !== binding.coordinationSha256) throw Error('OWNER_CDP_COORDINATION_PIN_CHANGED');
 const oldConfig = read(hostConfigFile);
 if (Object.hasOwn(oldConfig, 'cdp') || oldConfig.schemaVersion !== 1 || oldConfig.scope !== 'task-owned-v1')
  throw Error('OWNER_CDP_MUST_ONLY_ADD_CDP_TO_EXISTING_HOST');
 const cdp = binding.cdp;
 exactKeys(cdp, cdpKeys, [...cdpKeys].filter(key => key !== 'downloadRoot'));
 if (cdp.enabled !== true || !Array.isArray(cdp.identities) ||
     cdp.identities.length < 1 || cdp.identities.length > 16) throw Error('OWNER_CDP_ENABLED_IDENTITIES_REQUIRED');
 const repo = fileURLToPath(new URL('../..', import.meta.url));
 const helper = path.join(repo, 'tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1');
 const guard = path.join(repo, 'tools/platform/web-automation/Assert-CdpEndpointIdentity.ps1');
 if (cdp.leaseHelper !== helper || cdp.identityGuard !== guard) throw Error('OWNER_CDP_OFFICIAL_HELPER_REQUIRED');
 for (const [file, expected] of [
  [helper, cdp.leaseHelperSha256], [guard, cdp.identityGuardSha256],
  [oldConfig.powershell, cdp.powershellSha256],
  [cdp.playwrightModule, cdp.playwrightModuleSha256],
  [cdp.identityAuditModule, cdp.identityAuditModuleSha256]
 ]) {
  if (!sha256Pattern.test(expected ?? '') || !path.isAbsolute(file ?? '') || hash(file) !== expected)
   throw Error('OWNER_CDP_DEPENDENCY_PIN_CHANGED');
 }
 if (cdp.downloadRoot !== undefined) {
  if (!path.isAbsolute(cdp.downloadRoot) || !fs.statSync(exact(cdp.downloadRoot, 'directory')).isDirectory())
   throw Error('OWNER_CDP_DOWNLOAD_ROOT_UNSAFE');
  within(stateRoot, cdp.downloadRoot);
 }
 const slots = registeredBrowserSlots(coord);
 const used = new Set(), ports = new Set(), roots = new Set();
 for (const identity of cdp.identities) {
  exactKeys(identity, identityKeys);
  const endpoint = /^http:\/\/127\.0\.0\.1:([0-9]{4,5})$/.exec(identity.cdpEndpoint ?? '');
  const slot = endpoint && slots.find(row => Number(row.port) === Number(endpoint[1]));
  const root = path.resolve(identity.userDataRoot ?? '');
  if (!slot || !identity.identityId || !/^[a-zA-Z0-9_-]{1,64}$/.test(identity.identityId) ||
      used.has(identity.identityId) || ports.has(String(slot.port)) ||
      roots.has(root.toLowerCase()) || !path.isAbsolute(identity.userDataRoot ?? '') ||
      !path.isAbsolute(identity.executable ?? '') ||
      identity.role !== 'registered-cdp' || identity.engine !== 'chrome' ||
      identity.appIdentity !== 'Google Chrome' || identity.ownershipPolicy !== 'task-created-target-only' ||
      !identity.owner || !/^[a-f0-9]{64}$/.test(identity.sessionIdentityHash ?? '') ||
      (identity.workspaceIdentityHash !== null && !sha256Pattern.test(identity.workspaceIdentityHash ?? '')) ||
      identity.accountAlias !== slot.account_alias || identity.workspaceAlias !== slot.workspace ||
      identity.profile !== (slot.profile_directory || 'Default') ||
      root.toLowerCase() !== path.resolve(slot.profile_dir).toLowerCase() ||
      /pending|disabled|reserved|telegram_admin|admin_reserved/i.test(slot.usage))
   throw Error('OWNER_CDP_REGISTERED_ACCOUNT_WORKSPACE_PROFILE_REQUIRED');
  if (!sha256Pattern.test(identity.executableSha256 ?? '') || hash(identity.executable) !== identity.executableSha256)
   throw Error('OWNER_CDP_BROWSER_EXECUTABLE_PIN_CHANGED');
  exact(identity.userDataRoot, 'directory');
  used.add(identity.identityId); ports.add(String(slot.port)); roots.add(root.toLowerCase());
 }
 return { bindingFile, bindingSha256, coordinationFile: coord, coordinationSha256: binding.coordinationSha256,
  beforeFile: hostConfigFile, beforeSha256: binding.hostConfigBeforeSha256,
  after: { ...oldConfig, cdp: structuredClone(cdp) },
  dependencies: [[helper, cdp.leaseHelperSha256], [guard, cdp.identityGuardSha256],
   [oldConfig.powershell, cdp.powershellSha256], [cdp.playwrightModule, cdp.playwrightModuleSha256],
   [cdp.identityAuditModule, cdp.identityAuditModuleSha256],
   ...cdp.identities.map(value => [value.executable, value.executableSha256])]
    .map(([file, sha256]) => ({ file, sha256 })) };
}


const materializedPackageNames = Object.freeze(['playwright', 'playwright-core']);
const builtinImports = new Set(builtinModules.flatMap(value => [value, value.startsWith('node:') ? value.slice(5) : 'node:' + value]));
function sourceFile(file) {
  // Source may be npm/pnpm HARDLINK. Source is read-only; reparse and junction
  // links remain prohibited. Only immutable copied files enter Regular().
  exact(file);
  if (fs.realpathSync.native(file).toLowerCase() !== path.resolve(file).toLowerCase()) throw Error('CDP_SOURCE_REPARSE_REFUSED');
  if (!fs.lstatSync(file).isFile()) throw Error('CDP_SOURCE_REGULAR_BYTES_REQUIRED');
  return file;
}
function strictPackage(entry, name) {
  if (!materializedPackageNames.includes(name) || !path.isAbsolute(entry) ||
      path.basename(entry) !== 'index.js') throw Error('CDP_OFFICIAL_PACKAGE_ENTRY_REQUIRED');
  const root = path.dirname(sourceFile(entry)), descriptor = read(path.join(root, 'package.json'));
  if (path.basename(root) !== name || descriptor.name !== name || typeof descriptor.version !== 'string' ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(descriptor.version))
    throw Error('CDP_OFFICIAL_PACKAGE_IDENTITY_REQUIRED');
  // 1.62.1 playwright-core legitimately has NO main; its CommonJS entry
  // is selected by exports["."].require. Full playwright declares main.
  if ((name === 'playwright' && descriptor.main !== 'index.js') ||
      (name === 'playwright-core' && descriptor.main !== undefined && descriptor.main !== 'index.js'))
    throw Error('CDP_OFFICIAL_PACKAGE_MAIN_CHANGED');
  const declared = descriptor.exports;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared) ||
      !declared['.'] || !equal(declared['.'], {
        types: './index.d.ts', import: './index.mjs',
        require: './index.js', default: './index.js'
      }) || declared['./package.json'] !== './package.json')
    throw Error('CDP_OFFICIAL_PACKAGE_EXPORTS_CHANGED');
  for (const [key, value] of Object.entries(declared)) {
    if (key !== '.' && (!/^\.\/[A-Za-z0-9_./-]+$/.test(key) ||
        key.split('/').some(segment => segment === '..')))
      throw Error('CDP_PACKAGE_UNAPPROVED_EXPORT_KEY');
    const paths = typeof value === 'string' ? [value] : value && typeof value === 'object' &&
      !Array.isArray(value) && Object.keys(value).every(condition =>
        ['types', 'import', 'require', 'default'].includes(condition))
      ? Object.values(value) : null;
    if (!paths || !paths.length) throw Error('CDP_PACKAGE_UNAPPROVED_EXPORT_SHAPE');
    for (const target of paths) {
      if (typeof target !== 'string' || !/^\.\/[A-Za-z0-9_./-]+$/.test(target) ||
          target.split('/').some(segment => segment === '..'))
        throw Error('CDP_PACKAGE_EXPORT_ESCAPE_REFUSED');
      const resolved = path.resolve(root, target);
      within(root, resolved);
      if (!fs.existsSync(resolved)) throw Error('CDP_PACKAGE_EXPORT_TARGET_MISSING');
      sourceFile(resolved);
    }
  }
  if (!equal(Object.keys(descriptor.dependencies ?? {}).sort(), name === 'playwright' ? ['playwright-core'] : []))
    throw Error('CDP_PACKAGE_UNDECLARED_DEPENDENCY');
  if (descriptor.optionalDependencies && Object.keys(descriptor.optionalDependencies).length)
    throw Error('CDP_PACKAGE_OPTIONAL_DEPENDENCY_UNPROVEN');
  return { root, name, version: descriptor.version, descriptor };
}
function auditImports(sourceFilePath) {
  if (!/\.(?:[cm]?js)$/.test(sourceFilePath)) return [];
  const code = fs.readFileSync(sourceFile(sourceFilePath), 'utf8');
  let ast;
  try { ast = parseJavascript(code, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch { ast = parseJavascript(code, { ecmaVersion: 'latest', sourceType: 'script' }); }
  const imports = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
      imports.push(node.source);
    if (node.type === 'ImportExpression') imports.push(node.source);
    if (node.type === 'CallExpression' && (node.callee?.name === 'require' ||
        node.callee?.object?.name === 'require')) {
      if (node.callee?.name !== 'require' || node.arguments.length !== 1) throw Error('CDP_AUDIT_DYNAMIC_REQUIRE_REFUSED');
      imports.push(node.arguments[0]);
    }
    if (node.type === 'NewExpression' && node.callee?.name === 'URL' && node.arguments?.[1]?.type === 'MemberExpression')
      imports.push(node.arguments[0]);
    for (const [key, value] of Object.entries(node))
      if (key !== 'source' || !['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)) walk(value);
  };
  walk(ast);
  return imports.map(node => {
    if (node?.type !== 'Literal' || typeof node.value !== 'string') throw Error('CDP_AUDIT_DYNAMIC_IMPORT_REFUSED');
    return node.value;
  });
}
function resolveAuditImport(root, importing, spec) {
  if (builtinImports.has(spec)) return null;
  if (!spec.startsWith('./') && !spec.startsWith('../')) throw Error('CDP_AUDIT_NONRELATIVE_IMPORT_REFUSED');
  const base = path.resolve(path.dirname(importing), spec);
  within(root, base);
  const candidates = [base, ...['.mjs','.js','.cjs','.json'].map(ext=>base+ext),
    ...['index.mjs','index.js','index.cjs','index.json'].map(name=>path.join(base,name))]
    .filter(file => fs.existsSync(file) && fs.lstatSync(file).isFile());
  if (candidates.length !== 1) throw Error('CDP_AUDIT_RELATIVE_IMPORT_MISSING_OR_AMBIGUOUS');
  return sourceFile(candidates[0]);
}
function captureCdpDependencyClosure(cdp) {
  const initialEntry = sourceFile(cdp.playwrightModule);
  const declaredName = read(path.join(path.dirname(initialEntry), 'package.json')).name;
  if (!materializedPackageNames.includes(declaredName))
    throw Error('CDP_ONLY_OFFICIAL_PLAYWRIGHT_PACKAGES_ALLOWED');
  const primary = strictPackage(initialEntry, declaredName);
  if (hash(initialEntry) !== cdp.playwrightModuleSha256) throw Error('CDP_PLAYWRIGHT_SOURCE_CHANGED');
  const packageKind = declaredName === 'playwright-core' ? 'playwright-core-only' : 'playwright-plus-core';
  let packages = [primary];
  if (packageKind === 'playwright-plus-core') {
    const coreEntry = createRequire(pathToFileURL(initialEntry)).resolve('playwright-core');
    const core = strictPackage(coreEntry, 'playwright-core');
    if (primary.descriptor.dependencies['playwright-core'] !== core.version ||
        primary.version !== core.version) throw Error('CDP_PLAYWRIGHT_CORE_VERSION_MISMATCH');
    packages = [primary, core];
  }
  const files = [], maximumFiles = 8000, maximumBytes = 200 * 1024 * 1024;
  let bytes = 0;
  const add = (source, relative) => {
    if (!/^[A-Za-z0-9_.@/-]+$/.test(relative) || relative.split('/').some(x=>x==='..') ||
        files.some(row=>row.relative===relative)) throw Error('CDP_MATERIALIZED_RELATIVE_PATH_REFUSED');
    sourceFile(source);
    const size=fs.statSync(source).size;
    if (size > 24*1024*1024 || (bytes+=size) > maximumBytes || files.length >= maximumFiles)
      throw Error('CDP_DEPENDENCY_CLOSURE_SIZE_LIMIT');
    files.push({ source, relative, sha256: hash(source), size });
  };
  for (const pkg of packages) {
    const walk = folder => {
      exact(folder,'directory');
      for (const item of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        const file=path.join(folder,item.name); const metadata=fs.lstatSync(file);
        if (metadata.isSymbolicLink() || fs.realpathSync.native(file).toLowerCase() !== path.resolve(file).toLowerCase())
          throw Error('CDP_SOURCE_REPARSE_REFUSED');
        if (item.isDirectory()) {
          if (item.name==='node_modules') throw Error('CDP_NESTED_PACKAGE_DEPENDENCY_REFUSED');
          walk(file);
        } else if (item.isFile()) {
          const rel=path.relative(pkg.root,file).split(path.sep).join('/');
          add(file,'node_modules/'+pkg.name+'/'+rel);
        } else throw Error('CDP_PACKAGE_NONFILE_ENTRY_REFUSED');
      }
    };
    walk(pkg.root);
  }
  const audit = sourceFile(cdp.identityAuditModule), auditRoot = path.dirname(audit);
  const queue=[audit],seen=new Set();
  while(queue.length) {
    const file=sourceFile(queue.shift());
    if(seen.has(file)) continue;
    seen.add(file);
    const rel=path.relative(auditRoot,file).split(path.sep).join('/');
    add(file,'cdp-audit/'+rel);
    if(file.endsWith('.json')) { JSON.parse(fs.readFileSync(file,'utf8')); continue; }
    for(const spec of auditImports(file)) {
      const dependency=resolveAuditImport(auditRoot,file,spec);
      if(dependency) queue.push(dependency);
    }
  }
  if (hash(audit) !== cdp.identityAuditModuleSha256) throw Error('CDP_AUDIT_SOURCE_CHANGED');
  files.sort((a,b)=>a.relative.localeCompare(b.relative));
  const packageInfo=packages.map(pkg=>({name:pkg.name,version:pkg.version,sourceRoot:pkg.root}));
  return {kind:'host-cdp-dependency-materialization/v1',schemaVersion:1,packageKind,
    originalPlaywright:cdp.playwrightModule,originalPlaywrightSHA256:cdp.playwrightModuleSha256,
    originalAudit:audit,originalAuditSHA256:cdp.identityAuditModuleSha256,
    playwrightRelative:'node_modules/'+primary.name+'/index.js',
    auditRelative:'cdp-audit/'+path.basename(audit),packageInfo,files,
    sourceClosureSHA256:digest(JSON.stringify(files))};
}
function materializeCdpDependencyClosure(closure, hostRoot, resume) {
  const entries={};
  for(const item of closure.files) {
    const target=path.join(hostRoot,...item.relative.split('/'));
    within(hostRoot,target);
    sourceFile(item.source);
    if(hash(item.source)!==item.sha256 || fs.statSync(item.source).size!==item.size)
      throw Error('CDP_DEPENDENCY_SOURCE_DRIFT');
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    if(fs.existsSync(target)) {
      if(!resume || hash(target)!==item.sha256 || fs.statSync(target).nlink!==1)
        throw Error('CDP_MATERIALIZED_DESTINATION_ALREADY_EXISTS');
    } else fs.copyFileSync(item.source,target,fs.constants.COPYFILE_EXCL);
    if(fs.statSync(exact(target)).nlink!==1 || hash(target)!==item.sha256 ||
       hash(item.source)!==item.sha256) throw Error('CDP_MATERIALIZED_BYTES_OR_HARDLINK_CHANGED');
    entries[item.relative]=item.sha256;
  }
  const proof={...closure,files:closure.files.map(row=>({...row,target:path.join(hostRoot,...row.relative.split('/'))}))};
  const file=path.join(hostRoot,'dependency-provenance.json');
  write(file,proof,resume);
  entries['dependency-provenance.json']=hash(file);
  return { manifestFile:file,manifestSHA256:hash(file),files:entries,packageKind:closure.packageKind,
    playwrightModule:path.join(hostRoot,...closure.playwrightRelative.split('/')),
    identityAuditModule:path.join(hostRoot,...closure.auditRelative.split('/')),
    sourceClosureSHA256:closure.sourceClosureSHA256};
}

/** Pure, owner-invoked verifier of the immutable CDP closure. Never starts Chrome or writes files. */
export function verifyMaterializedCdpRelease(candidateReceiptFile) {
  const candidate=read(candidateReceiptFile),m=candidate.dependencyMaterialization;
  if(candidate.kind!=='host-runtime-update'||candidate.hostConfigUnchanged!==false||
     m?.kind!=='host-cdp-dependency-materialization/v1'||m.schemaVersion!==1||
     m.manifestFile!==path.join(candidate.hostRoot,'dependency-provenance.json')||
     hash(m.manifestFile)!==m.manifestSHA256 ||
     !['playwright-core-only','playwright-plus-core'].includes(m.packageKind))
    throw Error('CDP_MATERIALIZATION_CANDIDATE_PIN_REQUIRED');
  const stateRoot=path.dirname(path.dirname(path.dirname(candidate.hostRoot)));
  const registered=validateOwnerCdpBinding({
    stateRoot,hostConfigFile:candidate.oldHostConfigFile,
    bindingFile:candidate.cdpBinding.bindingFile,bindingSha256:candidate.cdpBinding.bindingSha256
  });
  if(hash(candidate.oldHostConfigFile)!==candidate.oldHostConfigSHA256) throw Error('CDP_ORIGINAL_CONFIG_CHANGED');
  const capture=captureCdpDependencyClosure(registered.after.cdp);
  const material=read(m.manifestFile);
  const expectedRows=capture.files.map(row=>({...row,target:path.join(candidate.hostRoot,...row.relative.split('/'))}));
  if(!equal(material,{...capture,files:expectedRows})||
     m.packageKind!==capture.packageKind ||
     m.sourceClosureSHA256!==capture.sourceClosureSHA256)
    throw Error('CDP_MATERIALIZATION_SOURCE_CLOSURE_CHANGED');
  const expectedManifestFiles={'host.cjs':candidate.hostEntrySHA256,
    'host-config.json':candidate.hostConfigDesiredSHA256};
  const additional={};
  for(const row of expectedRows) {
    const target=path.join(candidate.hostRoot,...row.relative.split('/'));
    if(row.target!==target||fs.statSync(exact(target)).nlink!==1||
       fs.statSync(target).size!==row.size||hash(target)!==row.sha256||hash(row.source)!==row.sha256)
      throw Error('CDP_MATERIALIZATION_FILE_DRIFT');
    additional[row.relative]=row.sha256;
  }
  additional['dependency-provenance.json']=m.manifestSHA256;
  if(!equal(additional,m.files)||
    m.playwrightModule!==path.join(candidate.hostRoot,...capture.playwrightRelative.split('/'))||
    m.identityAuditModule!==path.join(candidate.hostRoot,...capture.auditRelative.split('/')))
    throw Error('CDP_MATERIALIZATION_ENTRY_OR_INVENTORY_CHANGED');
  Object.assign(expectedManifestFiles,additional);
  const manifest=read(path.join(candidate.hostRoot,'manifest.json'));
  if(!equal(manifest.files,expectedManifestFiles)||manifest.releaseHash!==candidate.hostEntrySHA256)
    throw Error('CDP_MATERIALIZATION_MANIFEST_CHANGED');
  const present=[];
  const enumerate=folder=>{
    exact(folder,'directory');
    for(const item of fs.readdirSync(folder,{withFileTypes:true})) {
      const target=path.join(folder,item.name);
      if(fs.lstatSync(target).isSymbolicLink())throw Error('CDP_MATERIALIZATION_LINK_REFUSED');
      if(item.isDirectory())enumerate(target);
      else if(item.isFile()) {
        if(fs.statSync(target).nlink!==1)throw Error('CDP_MATERIALIZATION_HARDLINK_TARGET_REFUSED');
        present.push(path.relative(candidate.hostRoot,target).split(path.sep).join('/'));
      } else throw Error('CDP_MATERIALIZATION_NONFILE_ENTRY_REFUSED');
    }
  };
  enumerate(candidate.hostRoot);
  if(!equal(present.sort(),[...Object.keys(expectedManifestFiles),'manifest.json'].sort()))
    throw Error('CDP_MATERIALIZATION_EXTRA_OR_MISSING_FILE');
  const expected=registered.after;
  expected.cdp.playwrightModule=m.playwrightModule;
  expected.cdp.playwrightModuleSha256=hash(m.playwrightModule);
  expected.cdp.identityAuditModule=m.identityAuditModule;
  expected.cdp.identityAuditModuleSha256=hash(m.identityAuditModule);
  if(!equal(expected,read(candidate.hostConfigDesiredFile)))
    throw Error('CDP_MATERIALIZATION_UNRELATED_CONFIG_CHANGE');
  return {ok:true,kind:m.kind,packageKind:m.packageKind,fileCount:expectedRows.length,
    sourceClosureSHA256:capture.sourceClosureSHA256};
}
/** Build a new immutable host and replace exactly the existing host provider. No process or live owner writes. */
export async function prepareHostUpdate({ stateRoot = path.join(os.homedir(), '.ai-control-center'), operationDirectory, workspaceOverlayOperation, ownerCdpBindingFile, ownerCdpBindingSha256, resumeLocalPrepare = false, buildHost } = {}) {
  stateRoot = exact(stateRoot, 'directory');
  exact(operationDirectory, 'directory', true);
  within(path.join(stateRoot, 'asset-control'), operationDirectory);
  if (fs.existsSync(operationDirectory) && (!resumeLocalPrepare || fs.existsSync(path.join(operationDirectory, 'candidate-receipt.json')))) throw Error('OPERATION_EXISTS_RECONCILE');
  const put = (file, value) => write(file, value, resumeLocalPrepare);
  const registryFile = path.join(stateRoot, 'runtime', 'components.json');
  const registry = read(registryFile), registryHash = hash(registryFile);
  const component = registry.components?.['unified-mcp'];
  const oldGateway = component?.releaseRoot;
  exact(oldGateway, 'directory'); within(path.join(stateRoot, 'releases', 'unified-mcp'), oldGateway);
  if (component.entry !== path.join(oldGateway, 'gateway.cjs') || hash(component.entry) !== component.entryHash) throw Error('GATEWAY_ENTRY_PIN_CHANGED');
  const oldManifestFile = path.join(oldGateway, 'manifest.json');
  const manifest = read(oldManifestFile), manifestHash = hash(oldManifestFile);
  if (manifest.schemaVersion !== 1 || !manifest.files || Array.isArray(manifest.files)
    || !manifest.files['gateway.cjs'] || !manifest.files['config.json']) throw Error('EXACT_GATEWAY_MANIFEST_REQUIRED');
  const configFile = path.join(stateRoot, 'workspace-mcp', 'config.json');
  let manifestProvenance = null;
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = path.join(oldGateway, relative); within(oldGateway, file);
    if (hash(file) !== expected) {
      if (relative !== 'config.json' || !workspaceOverlayOperation) throw Error('GATEWAY_MANIFEST_PIN_CHANGED');
      manifestProvenance = proveWorkspaceOverlay(workspaceOverlayOperation, { stateRoot, registry, oldGateway, manifest, configFile });
    }
  }
  const before = read(path.join(oldGateway, 'config.json'));
  validateGraph(before);
  const original = before.providers.find(p => p.id === 'host');
  if (original.args.length !== 3 || original.args[1] !== '--config'
    || !original.files.some(pin => pin.path === original.args[2])) throw Error('EXACT_HOST_ARGUMENTS_REQUIRED');
  const hostConfig = read(original.args[2]);
  if (hostConfig.schemaVersion !== 1 || hostConfig.scope !== 'task-owned-v1') throw Error('EXACT_HOST_SCOPE_REQUIRED');
  const oldHostConfigFile = original.args[2], oldHostConfigSHA256 = hash(oldHostConfigFile);
  const oldHostPins = original.files.filter(pin => pin.path === oldHostConfigFile);
  if (oldHostPins.length !== 1 || oldHostPins[0].sha256 !== oldHostConfigSHA256 ||
      original.files.some(pin => pin.path === original.entrypoint && pin.path === oldHostConfigFile))
   throw Error('EXACT_HOST_CONFIG_PIN_REQUIRED');
  if (Boolean(ownerCdpBindingFile) !== Boolean(ownerCdpBindingSha256))
   throw Error('OWNER_CDP_BINDING_PATH_AND_SHA_REQUIRED');
  // Verify the owner-local registration and every dependency before writing
  // the operation or creating an immutable candidate. No live config edits.
  const cdpBinding = ownerCdpBindingFile ? validateOwnerCdpBinding({
   stateRoot, hostConfigFile: oldHostConfigFile, bindingFile: ownerCdpBindingFile,
   bindingSha256: ownerCdpBindingSha256
  }) : null;
  const profile = path.join(stateRoot, 'workspace-mcp', 'tunnel', 'profiles', 'aicc-workspace.yaml');
  const configBytes = fs.readFileSync(exact(configFile)), profileBytes = fs.readFileSync(exact(profile));
  const profileText = profileBytes.toString('utf8');
  const spellings = [...new Set([oldGateway, oldGateway.replaceAll('\\', '/'), oldGateway.replaceAll('\\', '\\\\')])].filter(value => profileText.includes(value));
  if (spellings.length !== 1 || profileText.split(spellings[0]).length !== 3) throw Error('EXACT_GATEWAY_PROFILE_BINDING_REQUIRED');
  const spelling = spellings[0];
  const owner = read(configFile);
  if (!owner.webManagement?.enabled || !owner.webManagement.bindingFile || !owner.webManagement.bindingSha256
    || hash(owner.webManagement.bindingFile) !== owner.webManagement.bindingSha256) throw Error('EXISTING_FIXED_MANAGER_BINDING_REQUIRED');
  const cdpDependencyClosure = cdpBinding ? captureCdpDependencyClosure(cdpBinding.after.cdp) : null;
  const source = fileURLToPath(new URL('./server.mjs', import.meta.url)), sourceSHA256 = hash(source);
  const hostSourceClosure = hostSourceDependencyPins();
  const preparerSourceFile = fileURLToPath(import.meta.url), preparerSourceSHA256 = hash(preparerSourceFile);
  fs.mkdirSync(operationDirectory, { recursive: true, mode: 0o700 });
  exact(operationDirectory, 'directory');
  const entry = path.join(operationDirectory, 'host-entry.mjs');
  put(entry, `import {runHostServer} from ${JSON.stringify(source.replaceAll('\\', '/'))};const a=process.argv.slice(2);if(a.length!==2||a[0]!=='--config')throw Error('Exact config required');runHostServer(a[1]).catch(()=>{console.error('AICC host control failed closed');process.exitCode=1;});\n`);
  const buildDirectory = path.join(operationDirectory, 'build-' + randomUUID());
  fs.mkdirSync(buildDirectory, { mode: 0o700 });
  const bundle = path.join(buildDirectory, 'host.cjs');
  if (buildHost) await buildHost({ entry, output: bundle });
  else {
    if (!globalThis.Bun?.build) throw Error('BUN_BUILD_REQUIRED');
    const built = await Bun.build({ entrypoints: [entry], target: 'node', format: 'cjs', outdir: buildDirectory, naming: 'host.cjs', minify: true });
    if (!built.success) throw Error('HOST_BUILD_FAILED');
  }
  const hostEntrySHA256 = hash(bundle);
  put(path.join(operationDirectory, 'host.cjs'), fs.readFileSync(bundle));
  if (hash(source) !== sourceSHA256 || hostSourceDependencyPins().sha256 !== hostSourceClosure.sha256 ||
      hash(preparerSourceFile) !== preparerSourceSHA256) throw Error('HOST_SOURCE_CLOSURE_CHANGED_DURING_BUILD');
  const id = digest(hostSourceClosure.sha256 + hostEntrySHA256 + hash(path.join(oldGateway, 'config.json')) + (cdpBinding?.bindingSha256 ?? '') + (cdpDependencyClosure?.sourceClosureSHA256 ?? '')).slice(0, 20);
  const hostRoot = path.join(stateRoot, 'releases', 'host-control', 'host-update-' + id);
  const gateway = path.join(stateRoot, 'releases', 'unified-mcp', 'host-update-' + id);
  for (const directory of [hostRoot, gateway]) {
    exact(directory, 'directory', true);
    if (fs.existsSync(directory) && !resumeLocalPrepare) throw Error('IMMUTABLE_CANDIDATE_EXISTS_RECONCILE');
  }
  for (const directory of [hostRoot, gateway]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const nextEntry = path.join(hostRoot, 'host.cjs');
  put(nextEntry, fs.readFileSync(bundle));
  const materializedDependencies=cdpDependencyClosure ? materializeCdpDependencyClosure(cdpDependencyClosure,hostRoot,resumeLocalPrepare) : null;
  const hostConfigDesiredFile = cdpBinding ? path.join(hostRoot, 'host-config.json') : null;
  if (cdpBinding) {
    const proposed=structuredClone(cdpBinding.after);
    proposed.cdp.playwrightModule=materializedDependencies.playwrightModule;
    proposed.cdp.playwrightModuleSha256=hash(materializedDependencies.playwrightModule);
    proposed.cdp.identityAuditModule=materializedDependencies.identityAuditModule;
    proposed.cdp.identityAuditModuleSha256=hash(materializedDependencies.identityAuditModule);
    put(hostConfigDesiredFile, proposed);
  }
  const hostConfigDesiredSHA256 = cdpBinding ? hash(hostConfigDesiredFile) : null;
  put(path.join(hostRoot, 'manifest.json'), { schemaVersion: 1, releaseHash: hostEntrySHA256,
   files: { 'host.cjs': hostEntrySHA256, ...(cdpBinding ? { 'host-config.json': hostConfigDesiredSHA256, ...materializedDependencies.files } : {}) } });
  const next = structuredClone(before);
  const replacement = next.providers.find(p => p.id === 'host');
  replacement.entrypoint = nextEntry;
  replacement.args[0] = nextEntry;
  if (cdpBinding) replacement.args[2] = hostConfigDesiredFile;
  replacement.files = replacement.files.map(pin => pin.path === original.entrypoint ? { ...pin, path: nextEntry, sha256: hostEntrySHA256 }
   : cdpBinding && pin.path === oldHostConfigFile ? { ...pin, path: hostConfigDesiredFile, sha256: hostConfigDesiredSHA256 } : pin);
  if (materializedDependencies) for (const [relative, sha256] of Object.entries(materializedDependencies.files))
    replacement.files.push({path:path.join(hostRoot,...relative.split('/')),sha256});
  replacement.toolNames = HOST_TOOLS.map(tool => tool.name);
  replacement.toolHash = hostToolHash(HOST_TOOLS);
  // Existing host config, executors, registry apps, journals, driver pins and all other providers remain exact.
  if (!equal(before.providers.filter(p => p.id !== 'host'), next.providers.filter(p => p.id !== 'host'))) throw Error('OTHER_PROVIDER_CHANGED');
  validateGraph(next);
  for (const relative of Object.keys(manifest.files)) {
    if (relative === 'config.json') continue;
    const destination = path.join(gateway, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    put(destination, fs.readFileSync(path.join(oldGateway, relative)));
  }
  put(path.join(gateway, 'config.json'), next);
  const nextManifest = structuredClone(manifest);
  nextManifest.files['config.json'] = hash(path.join(gateway, 'config.json'));
  nextManifest.releaseHash = nextManifest.files['config.json'];
  put(path.join(gateway, 'manifest.json'), nextManifest);
  const profileReplacement = spelling === oldGateway ? gateway : spelling === oldGateway.replaceAll('\\', '/') ? gateway.replaceAll('\\', '/') : gateway.replaceAll('\\', '\\\\');
  const nextProfileText = profileText.split(spelling).join(profileReplacement);
  const configDesiredFile = path.join(operationDirectory, 'workspace-config.desired.json');
  const profileDesiredFile = path.join(operationDirectory, 'workspace-profile.desired.yaml');
  put(path.join(operationDirectory, 'workspace-config.before.json'), configBytes);
  put(configDesiredFile, configBytes); put(profileDesiredFile, nextProfileText);
  // Reject concurrent owner changes instead of silently rebasing the reviewed operation.
  if (cdpBinding && (hash(cdpBinding.bindingFile) !== cdpBinding.bindingSha256 ||
      hash(cdpBinding.coordinationFile) !== cdpBinding.coordinationSha256 ||
      hash(cdpBinding.beforeFile) !== cdpBinding.beforeSha256 ||
      cdpBinding.dependencies.some(pin => hash(pin.file) !== pin.sha256)))
   throw Error('OWNER_CDP_BINDING_CHANGED_DURING_PREPARE');
  if (hash(registryFile) !== registryHash || hash(oldManifestFile) !== manifestHash
    || hash(configFile) !== digest(configBytes) || hash(profile) !== digest(profileBytes)) throw Error('LIVE_PREIMAGE_CHANGED_DURING_PREPARE');
  const receipt = {
    schemaVersion: 1, kind: 'host-runtime-update', status: 'PREPARED_NOT_ACTIVE',
    baseline: registry.components.workspace.releaseRoot, backend: registry.components.workspace.releaseRoot,
    oldGateway, gateway, hostRoot, configFile, profile,
    configBeforeSHA256: digest(configBytes), configDesiredFile, configDesiredSHA256: hash(configDesiredFile),
    profileBeforeSHA256: digest(profileBytes), profileDesiredFile, profileDesiredSHA256: hash(profileDesiredFile),
    bindingFile: owner.webManagement.bindingFile, bindingSHA256: owner.webManagement.bindingSha256,
    gatewayConfigSHA256: hash(path.join(gateway, 'config.json')), oldGatewayManifestSHA256: manifestHash,
    oldGatewayConfigSHA256: hash(path.join(oldGateway, 'config.json')), manifestProvenance,
    hostEntrySHA256, sourceSHA256, hostSourceClosure, preparerSourceFile, preparerSourceSHA256,
    hostSourceRoot: fileURLToPath(new URL('../..', import.meta.url)), toolNames: replacement.toolNames, toolHash: replacement.toolHash,
    otherProvidersUnchanged: true, gatewayCodeUnchanged: true, hostConfigUnchanged: !cdpBinding,
    oldHostConfigFile, oldHostConfigSHA256,
    ...(cdpBinding ? { hostConfigDesiredFile, hostConfigDesiredSHA256,
     dependencyMaterialization:{schemaVersion:1,kind:'host-cdp-dependency-materialization/v1',...materializedDependencies},
     cdpBinding: { schemaVersion: 1, kind: 'host-cdp-owner-binding/v1',
      bindingFile: cdpBinding.bindingFile, bindingSha256: cdpBinding.bindingSha256,
      coordinationFile: cdpBinding.coordinationFile, coordinationSha256: cdpBinding.coordinationSha256,
      dependencies: cdpBinding.dependencies } } : {}),
    stopMode: 'bootstrap-planned-maintenance-stop', liveCutover: false
  };
  put(path.join(operationDirectory, 'candidate-receipt.json'), receipt);
  return receipt;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = new Map(), allowed = new Set(['--state-root','--operation','--workspace-overlay-operation','--owner-cdp-binding','--owner-cdp-binding-sha256']);
  let resumeLocalPrepare = false;
  if (args.at(-1) === '--resume-local-prepare') { resumeLocalPrepare = true; args.pop(); }
  if (args.length % 2 !== 0) throw Error('Exact named options required');
  for (let i = 0; i < args.length; i += 2) {
   if (!allowed.has(args[i]) || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
    throw Error('Unknown or repeated host prepare argument');
   flags.set(args[i], args[i + 1]);
  }
  if (!flags.has('--state-root') || !flags.has('--operation') ||
      flags.has('--owner-cdp-binding') !== flags.has('--owner-cdp-binding-sha256'))
   throw Error('Usage: prepare-update.mjs --state-root ABS --operation NEW_PRIVATE_DIRECTORY [--workspace-overlay-operation EXACT_COMPLETED_OPERATION] [--owner-cdp-binding OWNER_LOCAL_JSON --owner-cdp-binding-sha256 EXACT_SHA256] [--resume-local-prepare]');
  const receipt = await prepareHostUpdate({ stateRoot: flags.get('--state-root'), operationDirectory: flags.get('--operation'),
   workspaceOverlayOperation: flags.get('--workspace-overlay-operation'),
   ownerCdpBindingFile: flags.get('--owner-cdp-binding'), ownerCdpBindingSha256: flags.get('--owner-cdp-binding-sha256'),
   resumeLocalPrepare });
  console.log(JSON.stringify({ status: receipt.status, kind: receipt.kind, toolCount: receipt.toolNames.length, candidateReceipt: path.join(flags.get('--operation'), 'candidate-receipt.json'), liveCutover: false }));
}
