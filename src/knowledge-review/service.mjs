import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ArtifactRegistry } from '../artifacts/registry.mjs';
import { DurableJobStore } from '../jobs/durable-store.mjs';
import { JobManager } from '../jobs/job-manager.mjs';
import { crawlOfficialSources } from './crawler.mjs';
import { SafeOfficialFetcher } from './fetcher.mjs';
import {
  evaluateKnowledgeReviewEntry,
  KNOWLEDGE_REVIEW_ENTRY_POLICY,
  OFFICIAL_SOURCE_REGISTRY,
  sourceById,
  validateSourceRegistry
} from './policy.mjs';
import { KnowledgeReviewStore } from './storage.mjs';

const REQUEST_REF = /^knowledge-review:\/\/requests\/([a-f0-9]{64})$/;
const ACTIVE = new Set(['leased', 'running', 'verifying']);
const WORKER = Object.freeze({
  workerId: 'knowledge-review-local',
  workloadClasses: ['batch'],
  modes: ['read-only'],
  routeIds: ['local-deterministic'],
  maxActive: 1
});

export class KnowledgeReviewServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KnowledgeReviewServiceError';
    this.code = code;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function ownerPaths(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  return { stateRoot, knowledgeRoot: options.knowledgeRoot ?? path.join(stateRoot, 'knowledge-review'), jobsRoot: options.jobsRoot ?? path.join(stateRoot, 'jobs') };
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new KnowledgeReviewServiceError('invalid_request', `${label} is required`);
  return value.trim();
}

function selectedSources(registry, sourceIds) {
  const ids = sourceIds === undefined ? registry.sources.map(source => source.id) : sourceIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string')) throw new KnowledgeReviewServiceError('invalid_request', 'at least one source id is required');
  return [...new Set(ids)].map(id => sourceById(registry, id));
}

export class KnowledgeReviewService {
  constructor({ registry = OFFICIAL_SOURCE_REGISTRY, store, manager, artifactRegistry, fetcher, now = () => Date.now(), ...options } = {}) {
    this.registry = validateSourceRegistry(registry);
    this.now = now;
    const paths = ownerPaths(options);
    this.store = store ?? new KnowledgeReviewStore({ root: paths.knowledgeRoot, registry: this.registry, now });
    const durableStore = manager?.store ?? new DurableJobStore({ root: paths.jobsRoot, now });
    this.manager = manager ?? new JobManager({ store: durableStore, now });
    this.artifacts = artifactRegistry ?? new ArtifactRegistry({ store: this.manager.store, now });
    this.fetcher = fetcher ?? new SafeOfficialFetcher();
    if (typeof this.fetcher.fetch !== 'function') throw new KnowledgeReviewServiceError('fetcher_required', 'knowledge review requires a safe fetcher');
  }

  status() {
    const jobs = this.manager.read().filter(job => String(job.requestRef).startsWith('knowledge-review://requests/'));
    const manifests = this.store.listRunManifests();
    const sourceStates = this.registry.sources.map(source => {
      const cursor = this.store.readCursor(source.id);
      return {
        sourceId: source.id,
        seedUrl: source.seedUrl,
        lastOutcome: cursor.lastOutcome,
        lastCompletedAt: cursor.lastCompletedAt,
        lastSuccessfulCompletedAt: cursor.lastCompletedAt,
        indexHash: cursor.index?.indexHash ?? null,
        pageCount: Object.keys(cursor.pages ?? {}).length
      };
    });
    const entry = evaluateKnowledgeReviewEntry({
      sourceStates,
      affectedSourceIds: sourceStates.map(source => source.sourceId),
      now: this.now()
    });
    const entryBySource = new Map(entry.sources.map(source => [source.sourceId, source]));
    const sources = sourceStates.map(source => ({ ...source, freshness: entryBySource.get(source.sourceId) }));
    return {
      schemaVersion: 1,
      manualOnly: true,
      automaticApply: false,
      entryPolicy: structuredClone(KNOWLEDGE_REVIEW_ENTRY_POLICY),
      staleSourceIds: entry.sources.filter(source => source.stale).map(source => source.sourceId),
      runningJobIds: jobs.filter(job => ACTIVE.has(job.state)).map(job => job.jobId),
      queuedJobIds: jobs.filter(job => job.state === 'queued').map(job => job.jobId),
      lastSuccessfulAt: manifests.find(run => run.outcome === 'completed')?.finishedAt ?? null,
      latestRun: manifests[0] ?? null,
      pendingCandidates: this.store.listCandidates().filter(candidate => !this.store.readLedger().some(event => event.candidateId === candidate.candidateId)).length,
      sources
    };
  }

  preview({ sourceIds } = {}) {
    const sources = selectedSources(this.registry, sourceIds);
    const distinctHosts = new Set(sources.map(source => new URL(source.seedUrl).hostname)).size;
    const pageMaximum = sources.reduce((sum, source) => sum + source.maxPages, 0);
    return {
      schemaVersion: 1,
      manualOnly: true,
      automaticApply: false,
      requiresConfirmation: true,
      sources: sources.map(source => ({ sourceId: source.id, seedUrl: source.seedUrl, allowedHosts: [...source.allowedHosts], allowedPathPrefixes: [...source.allowedPathPrefixes] })),
      estimatedRequests: { seeds: sources.length, robotsAtMost: distinctHosts, pagesAtMost: pageMaximum, totalAtMost: sources.length + distinctHosts + pageMaximum },
      writes: {
        ownerOnlyRoot: this.store.root,
        kinds: ['source-cursor', 'content-addressed-object', 'run-manifest', 'candidate', 'append-only-decision-ledger'],
        sourceOrGuidanceMutation: false
      },
      agentBudget: { modelCalls: 0, automaticPromotion: 0 }
    };
  }

  enqueue({ sourceIds, confirmed = false, requestId, idempotencyKey } = {}) {
    if (confirmed !== true) throw new KnowledgeReviewServiceError('confirmation_required', 'bounded knowledge review confirmation is required');
    const sources = selectedSources(this.registry, sourceIds);
    const request = {
      requestId: requireText(requestId, 'request id'),
      sourceIds: sources.map(source => source.id),
      manualOnly: true,
      automaticApply: false
    };
    const requestHash = hash(request);
    const saved = this.store.writeRequest(requestHash, request);
    const submitted = this.manager.submit({
      jobId: `knowledge-${requestHash.slice(0, 24)}`,
      idempotencyKey: requireText(idempotencyKey, 'idempotency key'),
      workloadClass: 'batch',
      workspaceId: this.store.root,
      requestedRoute: 'local-deterministic',
      identityBinding: 'owner-local',
      mode: 'read-only',
      requestRef: saved.ref,
      requestHash
    });
    if (submitted.duplicate && submitted.job.requestHash !== requestHash) throw new KnowledgeReviewServiceError('idempotency_conflict', 'idempotency key already refers to a different knowledge review request');
    return { job: submitted.job, duplicate: submitted.duplicate, request: saved.record };
  }

  async runOnce(jobId) {
    let job = this.manager.read(requireText(jobId, 'job id'));
    if (!String(job.requestRef).startsWith('knowledge-review://requests/')) throw new KnowledgeReviewServiceError('job_scope_denied', 'job is not a knowledge review job');
    if (job.state === 'completed') return { job, duplicate: true, manifest: this.store.listRunManifests().find(run => run.jobId === job.jobId) ?? null };
    if (job.state === 'paused') { this.manager.resume(job.jobId); job = this.manager.read(job.jobId); }
    if (job.state !== 'queued') throw new KnowledgeReviewServiceError(ACTIVE.has(job.state) ? 'job_already_active' : 'job_not_runnable', `knowledge review job is ${job.state}`);
    const requestHash = REQUEST_REF.exec(job.requestRef)?.[1];
    if (!requestHash || requestHash !== job.requestHash) throw new KnowledgeReviewServiceError('request_ref_invalid', 'knowledge review request reference is invalid');
    const request = this.store.readRequest(requestHash);
    const sources = selectedSources(this.registry, request.sourceIds);
    const lease = this.manager.dispatch(job.jobId, WORKER);
    const attemptId = lease.attempt.attemptId;
    this.manager.start(job.jobId, attemptId);
    const startedAt = new Date(this.now()).toISOString();
    try {
      const backup = this.store.backupCursorState(`before-${job.jobId}`);
      const results = await crawlOfficialSources({
        sources,
        store: this.store,
        fetcher: this.fetcher,
        now: this.now,
        onCheckpoint: async progress => {
          const checkpoint = this.store.writeCheckpoint(job.jobId, { requestHash, progress });
          this.manager.heartbeat(job.jobId, attemptId, { ref: checkpoint.ref, sha256: checkpoint.sha256 });
        }
      });
      const outcome = results.every(result => result.outcome === 'completed')
        ? 'completed'
        : results.some(result => result.outcome === 'hold') ? 'hold' : 'partial';
      const manifest = this.store.writeRunManifest(job.jobId, {
        jobId: job.jobId,
        requestId: request.requestId,
        requestHash,
        startedAt,
        finishedAt: new Date(this.now()).toISOString(),
        outcome,
        sources: results,
        changedUrls: [...new Set(results.flatMap(result => result.changed))],
        errors: results.flatMap(result => result.errors.map(error => ({ sourceId: result.sourceId, ...error }))),
        candidateCount: 0,
        promotionCount: 0,
        rollback: {
          scope: 'run-local manifest and owner cursor state only',
          sourceOrGuidanceChanged: false,
          requiresOwnerBackupForCursorRollback: true,
          cursorBackupId: backup.manifest.backupId,
          cursorBackupRef: `knowledge-review://backups/${backup.manifest.backupId}`,
          automaticRestore: false
        }
      });
      const artifactId = `knowledge-manifest-${job.jobId}`;
      this.artifacts.register({
        artifactId,
        jobId: job.jobId,
        inputSources: [{ ref: job.requestRef, sha256: requestHash }],
        generator: { tool: 'aicc-knowledge-review', version: '1', routeId: 'local-deterministic' },
        outputRef: manifest.ref,
        privatePath: manifest.file,
        mediaType: 'application/json',
        sensitivity: 'private',
        rollbackRef: `knowledge-review://runs/${job.jobId}/rollback`
      });
      this.artifacts.verify(artifactId, [{ type: 'exact-bytes', expectedSha256: manifest.sha256 }]);
      this.manager.beginVerification(job.jobId, attemptId);
      this.manager.recordResult(job.jobId, attemptId, {
        resultId: `knowledge-result-${job.jobId}`,
        claim: outcome === 'completed' ? 'All selected official sources completed.' : `Official source review completed with outcome ${outcome}.`,
        evidence: [{ ref: manifest.ref, sha256: manifest.sha256 }],
        unknown: outcome === 'completed' ? null : 'One or more source pages remain held, failed, or partial.',
        recommendation: 'Review candidates and the append-only decision ledger; do not apply automatically.',
        artifactRefs: [artifactId],
        validatorStatus: outcome === 'completed' ? 'pass' : 'unknown'
      });
      const completed = this.manager.complete(job.jobId, attemptId, [artifactId]);
      return { job: completed, duplicate: false, manifest: manifest.record };
    } catch (error) {
      try { this.manager.failAttempt(job.jobId, attemptId, error?.code ?? 'knowledge_review_failed'); } catch { /* preserve original failure */ }
      throw error;
    }
  }
}

export function createKnowledgeReviewService(options = {}) {
  return new KnowledgeReviewService(options);
}
