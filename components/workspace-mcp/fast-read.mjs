import { spawnSync } from 'node:child_process';
import { WorkspaceSnapshotError, WorkspaceSnapshotService } from '../../src/workspace-snapshots/service.mjs';

function gitUntracked(root, run = spawnSync) {
  const git = process.platform === 'win32' ? 'git.exe' : '/usr/bin/git';
  const result = run(git, ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').split('\0').filter(Boolean).sort();
}

function publicBinding(binding) {
  if (!binding) return { available: false, reason: 'not_opened' };
  if (!binding.available) return { available: false, reason: binding.reason };
  return {
    available: true,
    snapshot_id: binding.snapshotId,
    cache_scope: 'immutable-read-only',
    complete_workspace_view: binding.completeWorkspaceView,
    excluded_untracked_files: binding.excludedUntrackedFiles,
    live_facts_cached: false,
    reused: binding.reused
  };
}

export class WorkspaceFastReadCoordinator {
  constructor({ allowedRoots, stateRoot, toolSchemaHash, service = null, runGit = spawnSync } = {}) {
    if (!/^[a-f0-9]{64}$/.test(toolSchemaHash ?? '')) {
      throw new WorkspaceSnapshotError('schema_hash_invalid', 'Fast Read requires an exact tool schema hash');
    }
    this.toolSchemaHash = toolSchemaHash;
    this.runGit = runGit;
    this.service = service ?? new WorkspaceSnapshotService({ allowedRoots, stateRoot });
    this.bindings = new Map();
  }

  open({ leaseId, root, selectedUntrackedPaths = [] } = {}) {
    const untracked = gitUntracked(root, this.runGit);
    if (untracked === null) {
      const binding = { available: false, reason: 'not_an_exact_git_workspace' };
      this.bindings.set(leaseId, binding);
      return publicBinding(binding);
    }
    const selected = [...new Set(selectedUntrackedPaths)].sort();
    const selectedSet = new Set(selected);
    try {
      const begun = this.service.begin({
        root,
        toolSchemaHash: this.toolSchemaHash,
        selectedUntrackedPaths: selected
      });
      const binding = {
        available: true,
        snapshotId: begun.manifest.snapshotId,
        completeWorkspaceView: untracked.every(item => selectedSet.has(item)),
        excludedUntrackedFiles: untracked.filter(item => !selectedSet.has(item)).length,
        root,
        selectedUntracked: selected,
        boundedCache: new Map(),
        reused: begun.reused
      };
      this.bindings.set(leaseId, binding);
      return publicBinding(binding);
    } catch (error) {
      const binding = {
        available: false,
        reason: error instanceof WorkspaceSnapshotError ? error.code : 'snapshot_unavailable'
      };
      this.bindings.set(leaseId, binding);
      return publicBinding(binding);
    }
  }

  status(leaseId) {
    return publicBinding(this.bindings.get(leaseId));
  }

  query({ leaseId, operations } = {}) {
    const binding = this.bindings.get(leaseId);
    if (!binding?.available) return null;
    const result = this.service.query({ snapshotId: binding.snapshotId, operations });
    return {
      ...result,
      fastRead: publicBinding(binding)
    };
  }

  // Keep byte paging, rg semantics and path guards in their existing handlers.
  // Only bounded responses from an unchanged complete snapshot are reusable.
  async boundedQuery({ leaseId, key, load, signal } = {}) {
    const binding = this.bindings.get(leaseId);
    signal?.throwIfAborted();
    if (!binding?.available) return load();
    const fresh = () => this.service.query({
      snapshotId: binding.snapshotId, operations: [{ type: 'status' }]
    });
    fresh();
    const untracked = gitUntracked(binding.root, this.runGit);
    const complete = binding.completeWorkspaceView && untracked !== null
      && untracked.every(item => binding.selectedUntracked.includes(item));
    const cacheKey = JSON.stringify(key);
    const cached = complete ? binding.boundedCache.get(cacheKey) : null;
    if (cached) {
      signal?.throwIfAborted();
      return { ...structuredClone(cached), fast_read: { ...publicBinding(binding), cache_hit: true } };
    }
    const value = await load();
    signal?.throwIfAborted();
    fresh();
    const afterUntracked = gitUntracked(binding.root, this.runGit);
    const stillComplete = complete && afterUntracked !== null
      && afterUntracked.every(item => binding.selectedUntracked.includes(item));
    // At most eight 256 KiB responses per lease; large pages still work uncached.
    if (stillComplete && Buffer.byteLength(JSON.stringify(value)) <= 262_144) {
      if (binding.boundedCache.size >= 8) binding.boundedCache.delete(binding.boundedCache.keys().next().value);
      binding.boundedCache.set(cacheKey, structuredClone(value));
    }
    return { ...value, fast_read: { ...publicBinding(binding),
      complete_workspace_view: stillComplete, cache_hit: false,
      ...(!stillComplete ? { reason: 'incomplete_workspace_view' } : {}) } };
  }
  close(leaseId) {
    return this.bindings.delete(leaseId);
  }
}

export function shouldFailClosedOnFastReadError(error) {
  return error instanceof WorkspaceSnapshotError && [
    'sensitive_path',
    'sensitive_content',
    'path_escape',
    'symlink_denied',
    'owner_state_invalid',
    'snapshot_stale'
  ].includes(error.code);
}
