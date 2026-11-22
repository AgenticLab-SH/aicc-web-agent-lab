import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parse, version as acornVersion } from 'acorn';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const utf8 = new TextDecoder('utf-8', { fatal: true });

export const WORKSPACE_MCP_RUNTIME_ENTRYPOINTS = Object.freeze([
  'components/workspace-mcp/server.mjs'
]);

export const WORKSPACE_MCP_RUNTIME_SOURCES = Object.freeze([
  'components/workspace-mcp/runtime-integrity.mjs',
  'components/workspace-mcp/runtime-marker.mjs',
  'components/workspace-mcp/windows-owner-environment.mjs',
  'components/workspace-mcp/server.mjs',
  'components/workspace-mcp/bounded-search.mjs',
  'components/workspace-mcp/bounded-file-read.mjs',
  'components/workspace-mcp/web-management-provider.mjs',
  'components/workspace-mcp/codex-cli-provider.mjs',
  'components/workspace-mcp/gpt-queue-provider.mjs',
  'src/lib/windows-owner-only-acl.mjs',
  'src/lib/windows-pwsh.mjs',
  'src/codex-cli-routes.mjs',
  'src/codex-checkpoint-handoff.mjs',
  'src/codex-checkpoint-stop.mjs',
  'src/native-rescue.mjs',
  'src/codex-route-launchers.mjs',
  'components/workspace-mcp/destructive-command-guard.mjs',
  'components/workspace-mcp/remote-authority.mjs',
  'components/workspace-mcp/input-schemas.mjs',
  'components/workspace-mcp/tool-manifest.mjs',
  'components/workspace-mcp/local-source-provider.mjs',
  'components/workspace-mcp/local-access-policy.mjs',
  'components/workspace-mcp/local-read-grant-authority.mjs',
  'components/workspace-mcp/codex-session-provider.mjs',
  'components/workspace-mcp/codex-session-activity.mjs',
  'components/workspace-mcp/fast-read.mjs',
  'src/jobs/durable-store.mjs',
  'src/remote/durable-writer-authorizer.mjs',
  'src/local-access/grant-store.mjs',
  'src/workspace-snapshots/service.mjs',
  'src/workspace-snapshots/change-transaction.mjs',
  'src/workspace-snapshots/portable-bundle.mjs'
]);

export const WORKSPACE_MCP_RUNTIME_PARSER = Object.freeze({
  name: 'acorn',
  version: acornVersion
});

function integrityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function posixRelative(value) {
  return value.split(path.sep).join('/');
}

function normalizedRelative(value, label = 'runtime path') {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw integrityError('SOURCE_PATH_IDENTITY_HOLD', `${label} is invalid`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..'
    || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw integrityError('SOURCE_PATH_IDENTITY_HOLD', `${label} escapes or aliases the repository: ${value}`);
  }
  return normalized;
}

function canonicalRoot(root) {
  const resolved = path.resolve(root);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory()) throw integrityError('SOURCE_PATH_IDENTITY_HOLD', 'Workspace MCP runtime root is not a directory');
  return fs.realpathSync.native(resolved);
}

function bigintIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertNoSymlinkSegments(rootRealpath, relative) {
  let current = rootRealpath;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw integrityError('SOURCE_PATH_IDENTITY_HOLD', `Workspace MCP runtime path contains a symlink: ${relative}`);
    }
  }
}

export function sealWorkspaceRuntimeFile(root, relativePath) {
  const rootRealpath = canonicalRoot(root);
  const relative = normalizedRelative(posixRelative(relativePath));
  const absolute = path.join(rootRealpath, ...relative.split('/'));
  assertNoSymlinkSegments(rootRealpath, relative);
  const realpath = fs.realpathSync.native(absolute);
  const canonicalRelative = posixRelative(path.relative(rootRealpath, realpath));
  if (canonicalRelative !== relative || canonicalRelative.startsWith('../') || path.isAbsolute(canonicalRelative)) {
    throw integrityError('SOURCE_PATH_IDENTITY_HOLD', `Workspace MCP runtime path identity mismatch: ${relative}`);
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(absolute, flags);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw integrityError('SOURCE_PATH_IDENTITY_HOLD', `Workspace MCP runtime import is not a regular file: ${relative}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const beforeIdentity = bigintIdentity(before);
    const afterIdentity = bigintIdentity(after);
    if (!sameIdentity(beforeIdentity, afterIdentity) || BigInt(bytes.length) !== after.size) {
      throw integrityError(
        'SOURCE_CHANGED_DURING_SEAL',
        `Workspace MCP runtime source changed while it was read: ${relative}`
      );
    }
    return Object.freeze({
      relativePath: relative,
      realpath,
      identity: afterIdentity,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkAst(value, visit);
    }
  }
}

function literalString(node) {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

function memberName(node) {
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  return literalString(node.property);
}

function workerUrlSpecifier(node) {
  if (node?.type !== 'NewExpression' || node.callee?.type !== 'Identifier' || node.callee.name !== 'URL') return null;
  const specifier = literalString(node.arguments?.[0]);
  const base = node.arguments?.[1];
  const importMeta = base?.type === 'MemberExpression'
    && base.object?.type === 'MetaProperty'
    && base.object.meta?.name === 'import'
    && base.object.property?.name === 'meta'
    && !base.computed
    && base.property?.name === 'url';
  return importMeta ? specifier : null;
}

function reviewedDynamicKey(importer, kind, specifier) {
  return `${importer}\0${kind}\0${specifier}`;
}

export function parseWorkspaceRuntimeImports(
  bytes,
  importer,
  reviewedDynamicImports = ['components/workspace-mcp/bounded-search.mjs\0Worker\0./bounded-search.mjs']
) {
  const relativeImporter = normalizedRelative(posixRelative(importer), 'runtime importer');
  let ast;
  try {
    const source = utf8.decode(bytes);
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true
    });
  } catch (error) {
    throw integrityError(
      'SOURCE_CLOSURE_CONFLICT',
      `Workspace MCP runtime source cannot be parsed: ${relativeImporter}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const reviewed = new Set(reviewedDynamicImports);
  if (reviewed.size !== reviewedDynamicImports.length) {
    throw integrityError('SOURCE_CLOSURE_CONFLICT', 'Workspace MCP reviewed dynamic import allowlist contains duplicates');
  }
  const specifiers = new Set();
  const addStatic = specifier => {
    if (specifier?.startsWith('.')) specifiers.add(specifier);
  };
  const addReviewedDynamic = (kind, specifier) => {
    if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
      throw integrityError(
        'workspace_runtime_dynamic_import_unreviewed',
        `Workspace MCP ${kind} target is not a reviewed relative literal: ${relativeImporter}`
      );
    }
    if (!reviewed.has(reviewedDynamicKey(relativeImporter, kind, specifier))) {
      throw integrityError(
        'workspace_runtime_dynamic_import_unreviewed',
        `Workspace MCP ${kind} target is not reviewed: ${relativeImporter} -> ${specifier}`
      );
    }
    specifiers.add(specifier);
  };

  walkAst(ast, node => {
    if (node.type === 'ImportDeclaration'
      || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration') {
      addStatic(literalString(node.source));
      return;
    }
    if (node.type === 'ImportExpression') {
      const specifier = literalString(node.source);
      if (specifier === null) {
        throw integrityError(
          'workspace_runtime_dynamic_import_unreviewed',
          `Workspace MCP dynamic import is not a literal: ${relativeImporter}`
        );
      }
      addStatic(specifier);
      return;
    }
    if (node.type === 'CallExpression') {
      const directName = node.callee?.type === 'Identifier' ? node.callee.name : null;
      const property = memberName(node.callee);
      if (directName === 'createRequire' || property === 'createRequire') {
        throw integrityError(
          'workspace_runtime_dynamic_import_unreviewed',
          `Workspace MCP createRequire loader is not reviewed: ${relativeImporter}`
        );
      }
      if (directName === 'require') addReviewedDynamic('require', literalString(node.arguments?.[0]));
      if (property === 'fork') addReviewedDynamic('fork', literalString(node.arguments?.[0]));
      if (property === 'register') addReviewedDynamic('module.register', literalString(node.arguments?.[0]));
      return;
    }
    if (node.type === 'NewExpression'
      && node.callee?.type === 'Identifier'
      && node.callee.name === 'Worker') {
      const first = node.arguments?.[0];
      addReviewedDynamic('Worker', literalString(first) ?? workerUrlSpecifier(first));
    }
  });
  return Object.freeze([...specifiers].sort());
}

function resolveLocalModule(importer, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
    throw integrityError('SOURCE_CLOSURE_CONFLICT', `Workspace MCP runtime import is invalid: ${importer}`);
  }
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  normalizedRelative(relative, 'runtime import');
  if (!path.posix.extname(relative)) {
    throw integrityError(
      'SOURCE_CLOSURE_CONFLICT',
      `Workspace MCP runtime import must include its extension: ${importer} -> ${specifier}`
    );
  }
  return relative;
}

export function buildWorkspaceRuntimeSnapshot(
  root = repositoryRoot,
  entrypoints = WORKSPACE_MCP_RUNTIME_ENTRYPOINTS,
  reviewedDynamicImports = ['components/workspace-mcp/bounded-search.mjs\0Worker\0./bounded-search.mjs']
) {
  const rootRealpath = canonicalRoot(root);
  const pending = entrypoints.map(entrypoint => normalizedRelative(posixRelative(entrypoint), 'runtime entrypoint'));
  const files = new Map();
  while (pending.length > 0) {
    const relative = pending.pop();
    if (files.has(relative)) continue;
    const sealed = sealWorkspaceRuntimeFile(rootRealpath, relative);
    files.set(relative, sealed);
    for (const specifier of parseWorkspaceRuntimeImports(sealed.bytes, relative, reviewedDynamicImports)) {
      pending.push(resolveLocalModule(relative, specifier));
    }
  }
  const closure = Object.freeze([...files.keys()].sort());
  return Object.freeze({
    schemaVersion: 2,
    parser: WORKSPACE_MCP_RUNTIME_PARSER,
    rootRealpath,
    closure,
    files
  });
}

function listedSourceAudit(listedSources) {
  if (!Array.isArray(listedSources)) {
    throw integrityError('SOURCE_CLOSURE_CONFLICT', 'Workspace MCP runtime source allowlist must be an array');
  }
  const listedInOrder = listedSources.map(value => normalizedRelative(posixRelative(value), 'runtime allowlist path'));
  const counts = new Map();
  for (const relative of listedInOrder) counts.set(relative, (counts.get(relative) ?? 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([relative]) => relative).sort();
  return {
    listed: Object.freeze([...listedInOrder].sort()),
    duplicates: Object.freeze(duplicates)
  };
}

function closureAudit(snapshot, listedSources) {
  const { listed, duplicates } = listedSourceAudit(listedSources);
  const closureSet = new Set(snapshot.closure);
  const listedSet = new Set(listed);
  const missing = Object.freeze(snapshot.closure.filter(relative => !listedSet.has(relative)));
  const extra = Object.freeze(listed.filter(relative => !closureSet.has(relative)));
  return Object.freeze({
    ok: duplicates.length === 0 && missing.length === 0 && extra.length === 0
      && snapshot.closure.length === listed.length,
    closure: snapshot.closure,
    listed,
    duplicates,
    missing,
    extra
  });
}

export function workspaceMcpStaticImportClosure(
  root = repositoryRoot,
  entrypoints = WORKSPACE_MCP_RUNTIME_ENTRYPOINTS
) {
  return buildWorkspaceRuntimeSnapshot(root, entrypoints).closure;
}

export function workspaceMcpRuntimeClosureAudit(
  root = repositoryRoot,
  listedSources = WORKSPACE_MCP_RUNTIME_SOURCES
) {
  return closureAudit(buildWorkspaceRuntimeSnapshot(root), listedSources);
}

export function assertWorkspaceMcpRuntimeClosure(
  root = repositoryRoot,
  listedSources = WORKSPACE_MCP_RUNTIME_SOURCES
) {
  const audit = workspaceMcpRuntimeClosureAudit(root, listedSources);
  if (!audit.ok) {
    throw integrityError('SOURCE_CLOSURE_CONFLICT', `Workspace MCP runtime hash closure mismatch: ${JSON.stringify({
      duplicates: audit.duplicates,
      missing: audit.missing,
      extra: audit.extra
    })}`);
  }
  return audit;
}

function verifySealedFile(snapshot, sealed) {
  assertNoSymlinkSegments(snapshot.rootRealpath, sealed.relativePath);
  const realpath = fs.realpathSync.native(path.join(snapshot.rootRealpath, sealed.relativePath));
  if (realpath !== sealed.realpath) {
    throw integrityError('SOURCE_PATH_IDENTITY_HOLD', `Workspace MCP runtime realpath changed: ${sealed.relativePath}`);
  }
  const current = bigintIdentity(fs.statSync(realpath, { bigint: true }));
  if (!sameIdentity(current, sealed.identity)) {
    throw integrityError(
      'SOURCE_CHANGED_DURING_SEAL',
      `Workspace MCP runtime source changed after snapshot: ${sealed.relativePath}`
    );
  }
}

export function hashWorkspaceRuntimeSnapshot(
  snapshot,
  listedSources = WORKSPACE_MCP_RUNTIME_SOURCES
) {
  const audit = closureAudit(snapshot, listedSources);
  if (!audit.ok) {
    throw integrityError('SOURCE_CLOSURE_CONFLICT', `Workspace MCP runtime hash closure mismatch: ${JSON.stringify({
      duplicates: audit.duplicates,
      missing: audit.missing,
      extra: audit.extra
    })}`);
  }
  const digest = createHash('sha256');
  for (const relative of audit.listed) {
    const sealed = snapshot.files.get(relative);
    if (!sealed) throw integrityError('SOURCE_CLOSURE_CONFLICT', `Workspace MCP snapshot omitted ${relative}`);
    verifySealedFile(snapshot, sealed);
    digest.update(relative);
    digest.update('\0');
    digest.update(sealed.bytes);
    digest.update('\0');
  }
  return digest.digest('hex');
}

export function workspaceMcpRuntimeHash(root = repositoryRoot) {
  return hashWorkspaceRuntimeSnapshot(buildWorkspaceRuntimeSnapshot(root));
}
