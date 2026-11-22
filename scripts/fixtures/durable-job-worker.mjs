import fs from 'node:fs';
import { DurableJobStore } from '../../src/jobs/durable-store.mjs';
import { JobManager } from '../../src/jobs/job-manager.mjs';

const [storeRoot, jobId, attemptId, effectFile] = process.argv.slice(2);
if (!storeRoot || !jobId || !attemptId || !effectFile) throw new Error('store root, job id, attempt id, and effect file are required');

const manager = new JobManager({ store: new DurableJobStore({ root: storeRoot }), leaseDurationMs: 400 });
manager.start(jobId, attemptId);
const reservation = manager.reserveEffect(jobId, attemptId, 'external-write', 'effect://phase07-smoke');
if (reservation.created) {
  fs.appendFileSync(effectFile, `${jobId}\n`, { mode: 0o600 });
  manager.completeEffect(jobId, 'external-write');
}
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, reservationCreated: reservation.created })}\n`);
setInterval(() => {}, 1_000);
