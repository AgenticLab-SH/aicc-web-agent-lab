import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { JobManager } from '../src/jobs/job-manager.mjs';
import { ArtifactRegistry } from '../src/artifacts/registry.mjs';

const requestedRoot = process.env.AICC_PHASE07_ARTIFACT_ROOT?.trim();
const root = requestedRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-phase07-artifact-'));
const python = process.env.AICC_PDF_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3');
const pdftoppm = process.env.AICC_PDFTOPPM?.trim() || 'pdftoppm';
const fixture = fileURLToPath(new URL('./fixtures/create-phase07-pdf.py', import.meta.url));
const pdf = path.join(root, 'phase07-durable-artifact.pdf');
const renderPrefix = path.join(root, 'phase07-durable-artifact');
const rendered = `${renderPrefix}.png`;
const store = new DurableJobStore({ root: path.join(root, 'store') });
const manager = new JobManager({ store });
const registry = new ArtifactRegistry({ store });
const requestHash = crypto.createHash('sha256').update('phase07-pdf-job').digest('hex');

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(executable)} failed: ${result.error?.message || result.stderr.trim()}`);
  return result.stdout;
}

try {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  run(python, [fixture, pdf]);
  run(pdftoppm, ['-png', '-r', '144', '-singlefile', pdf, renderPrefix]);
  const inspection = JSON.parse(run(python, ['-c', [
    'import json,sys',
    'from pypdf import PdfReader',
    'r=PdfReader(sys.argv[1])',
    'text="\\n".join((p.extract_text() or "") for p in r.pages)',
    'print(json.dumps({"pages":len(r.pages),"title":r.metadata.title,"hasProof": "Durable Job and Artifact Verification" in text}))'
  ].join(';'), pdf]));

  const submitted = manager.submit({
    jobId: 'phase07-pdf-job', idempotencyKey: 'phase07-pdf-job', workloadClass: 'render',
    workspaceId: '/phase07/task-owned-artifact', requestedRoute: 'native-direct', identityBinding: 'fixture:local',
    mode: 'read-only', requestRef: 'request://phase07/pdf', requestHash
  }).job;
  const lease = manager.dispatch(submitted.jobId, {
    workerId: 'phase07-render-worker', workloadClasses: ['render'], modes: ['read-only'], routeIds: ['native-direct'], maxActive: 1
  });
  manager.start(submitted.jobId, lease.attempt.attemptId);
  const artifact = registry.register({
    artifactId: 'phase07-pdf-artifact', jobId: submitted.jobId,
    inputSources: [{ ref: 'request://phase07/pdf', sha256: requestHash }],
    generator: { tool: 'reportlab', version: '4', routeId: 'native-direct' },
    privatePath: pdf, outputRef: 'artifact://phase07/phase07-durable-artifact.pdf', mediaType: 'application/pdf',
    sensitivity: 'internal', rollbackRef: 'backup://phase07-artifact-smoke'
  }).artifact;
  const verified = registry.verify(artifact.artifactId, [
    { type: 'exact-bytes' },
    { type: 'document-pdf', evidencePath: rendered, evidenceRef: 'evidence://phase07/pdf-render' }
  ]);
  manager.beginVerification(submitted.jobId, lease.attempt.attemptId);
  const completed = manager.complete(submitted.jobId, lease.attempt.attemptId, [artifact.artifactId]);
  const report = {
    ok: completed.state === 'completed' && verified.verificationCurrent && inspection.pages === 1 && inspection.hasProof,
    root,
    pdf: { path: pdf, bytes: fs.statSync(pdf).size, sha256: verified.output.sha256, pages: inspection.pages, title: inspection.title, textMarkerPresent: inspection.hasProof },
    render: { path: rendered, bytes: fs.statSync(rendered).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(rendered)).digest('hex') },
    job: { jobId: completed.jobId, state: completed.state, attemptCount: completed.attempts.length },
    verification: verified.verification.map(item => ({ type: item.type, status: item.status, evidenceSha256: item.evidenceSha256 ?? null }))
  };
  const reportPath = process.env.AICC_PHASE07_ARTIFACT_REPORT?.trim();
  if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  if (!requestedRoot) fs.rmSync(root, { recursive: true, force: true });
}
