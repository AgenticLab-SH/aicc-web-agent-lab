import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceSnapshotService } from './service.mjs';
import { ensureWindowsOwnerOnlyDirectory } from '../lib/windows-owner-only-acl.mjs';

const MAX_REQUEST_BYTES = 65_536;
const MAX_REQUEST_FILE_BYTES = 8_388_608;

function decodeRequestBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 131_072 || !/^[A-Za-z0-9+/=]+$/.test(value)) {
    throw new Error('workspace snapshot request base64 is invalid');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > MAX_REQUEST_BYTES) throw new Error('workspace snapshot request exceeds 65536 bytes');
  return JSON.parse(decoded.toString('utf8'));
}

function decodeRequestFile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('workspace snapshot request file must be an absolute path');
  }
  const stat = fs.lstatSync(value, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REQUEST_FILE_BYTES
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('workspace snapshot request file is missing, oversized, or unsafe');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('workspace snapshot request file belongs to another user');
  }
  return JSON.parse(fs.readFileSync(value, 'utf8'));
}

function publicManifest(manifest) {
  const { root: _ownerOnlyRoot, ...portable } = manifest;
  return portable;
}

export function runWorkspaceSnapshotCommand(args, options = {}) {
  const requestIndex = args.indexOf('--request-base64');
  const requestFileIndex = args.indexOf('--request-file');
  if ((requestIndex < 0 && requestFileIndex < 0) || (requestIndex >= 0 && requestFileIndex >= 0)) {
    throw new Error('workspace snapshot requires exactly one of --request-base64 or --request-file');
  }
  const request = requestIndex >= 0
    ? decodeRequestBase64(args[requestIndex + 1])
    : decodeRequestFile(args[requestFileIndex + 1]);
  const cwd = options.cwd ?? process.cwd();
  const stateIndex = args.indexOf('--state-root');
  let stateRoot;
  if (stateIndex >= 0) {
    const value = args[stateIndex + 1];
    const expected = path.join(fs.realpathSync(cwd), '.aicc-workspace-snapshots');
    if (!value || !path.isAbsolute(value) || path.resolve(value) !== expected
      || args.lastIndexOf('--state-root') !== stateIndex) {
      throw new Error('task snapshot state must be the exact project .aicc-workspace-snapshots directory');
    }
    const existing = fs.lstatSync(value, { throwIfNoEntry: false });
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
      throw new Error('task snapshot state cannot be a link or file');
    }
    stateRoot = value;
    if (process.platform === 'win32') ensureWindowsOwnerOnlyDirectory(stateRoot,
      options.nativeAclHelper ? { nativeHelper: options.nativeAclHelper } : {});
  }
  const service = options.service ?? new WorkspaceSnapshotService({ allowedRoots: [cwd], ...(stateRoot ? { stateRoot } : {}) });
  if (request.action === 'begin_query') {
    const begun = service.begin({
      root: cwd,
      toolSchemaHash: request.toolSchemaHash,
      selectedUntrackedPaths: request.selectedUntrackedPaths ?? [],
    });
    const query = service.query({ snapshotId: begun.manifest.snapshotId, operations: request.operations });
    return {
      ok: true,
      action: request.action,
      begun: { ...begun, manifest: publicManifest(begun.manifest) },
      query,
    };
  }
  if (request.action === 'query') {
    const query = service.query({ snapshotId: request.snapshotId, operations: request.operations });
    return { ok: true, action: request.action, query };
  }
  if (request.action === 'materialize') {
    const materialized = service.materialize({ snapshotId: request.snapshotId });
    const { root: _ownerOnlyRoot, ...portable } = materialized;
    return { ok: true, action: request.action, materialized: portable };
  }
  if (request.action === 'export_bundle') {
    const bundle = service.exportPortableBundle({ snapshotId: request.snapshotId });
    return { ok: true, action: request.action, bundle };
  }
  if (request.action === 'plan_change') {
    const planned = service.planChange({
      snapshotId: request.snapshotId,
      changes: request.changes,
      verification: request.verification,
    });
    return { ok: true, action: request.action, planned };
  }
  if (request.action === 'apply_verify_change') {
    const applied = service.applyVerifyChange({ operationId: request.operationId, planHash: request.planHash });
    return { ok: true, action: request.action, applied };
  }
  if (request.action === 'reconcile_change') {
    const reconciled = service.reconcileChange({ operationId: request.operationId, planHash: request.planHash });
    return { ok: true, action: request.action, reconciled };
  }
  if (request.action === 'rollback_change') {
    const rolledBack = service.rollbackChange({ operationId: request.operationId, planHash: request.planHash, reason: request.reason });
    return { ok: true, action: request.action, rolledBack };
  }
  if (request.action === 'change_status') {
    const status = service.changeStatus({ operationId: request.operationId, planHash: request.planHash });
    return { ok: true, action: request.action, status };
  }
  throw new Error(`unsupported workspace snapshot action: ${String(request.action)}`);
}
