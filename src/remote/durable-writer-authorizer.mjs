import crypto from 'node:crypto';

export class RemoteWriterAuthorizationError extends Error {
  constructor(code, message) { super(message); this.name = 'RemoteWriterAuthorizationError'; this.code = code; }
}

export class DurableRemoteWriterAuthorizer {
  constructor({ store } = {}) {
    if (!store) throw new RemoteWriterAuthorizationError('store_required', 'durable job store is required');
    this.store = store;
  }

  async #authorize({ workspaceId, jobId, attemptId, identityBinding, writerLeaseRef = null }) {
    const state = this.store.read().state;
    const job = state.jobs[jobId];
    if (!job || job.workspaceId !== workspaceId || job.identityBinding !== identityBinding || job.mode !== 'write' || job.state !== 'running') {
      throw new RemoteWriterAuthorizationError('remote_job_binding_invalid', 'remote write job binding is not active or does not match workspace and identity');
    }
    const attempt = job.attempts.find(item => item.attemptId === attemptId && item.state === 'running');
    const writer = state.workspaceLeases[workspaceId];
    if (!attempt || !writer || writer.jobId !== jobId || writer.attemptId !== attemptId || job.writerLease?.mode !== 'write') {
      throw new RemoteWriterAuthorizationError('remote_writer_lease_invalid', 'remote write attempt does not own the durable workspace writer lease');
    }
    const currentWriterLeaseRef = `writer_${crypto.createHash('sha256').update(`${workspaceId}\0${jobId}\0${attemptId}`).digest('hex')}`;
    if (writerLeaseRef !== null && writerLeaseRef !== currentWriterLeaseRef) {
      throw new RemoteWriterAuthorizationError('remote_writer_lease_invalid', 'remote write capability is bound to a different durable writer lease');
    }
    return {
      ok: true,
      writerLeaseRef: currentWriterLeaseRef
    };
  }

  async acquire(input) {
    return this.#authorize(input);
  }

  async validate(input) {
    return this.#authorize(input);
  }

  async release({ writerLeaseRef }) {
    return { ok: true, writerLeaseRef, durableJobLeasePreserved: true };
  }
}
