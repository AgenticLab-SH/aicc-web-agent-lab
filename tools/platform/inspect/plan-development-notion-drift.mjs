#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDevelopmentSyncBaseline, planDevelopmentSync, readDevelopmentSyncBaseline } from '../../../src/projects/development-notion-sync.mjs';
import { createProjectCatalogService } from '../../../src/projects/service.mjs';
import { projectPortfolioDevelopmentState } from '../../../src/projects/registered-portfolio-projection.mjs';

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return path.resolve(value);
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ACL-only platform */ }
}
const stateRoot = path.resolve(process.env.AICC_STATE_ROOT?.trim() || path.join(os.homedir(), '.ai-control-center'));
const portfolioFile = argument('--portfolio', path.join(stateRoot, 'git-portfolio', 'latest.json'));
const notionFile = argument('--notion-current', path.join(stateRoot, 'project-catalog', 'development-notion-sync', 'notion-current.json'));
const outputFile = argument('--output', path.join(stateRoot, 'project-catalog', 'development-notion-sync', 'drift-plan.json'));
const candidateFile = argument('--candidate-output', path.join(stateRoot, 'project-catalog', 'development-notion-sync', 'baseline-candidate.json'));
const projectsRoot = argument('--projects-root', process.env.AICC_PROJECTS_ROOT?.trim() ? path.resolve(process.env.AICC_PROJECTS_ROOT.trim()) : null);
if (!projectsRoot) throw new Error('--projects-root or AICC_PROJECTS_ROOT is required');

const report = readJson(portfolioFile, 'portfolio report');
const notionPayload = readJson(notionFile, 'current Notion snapshot');
const notionRecords = Array.isArray(notionPayload) ? notionPayload : notionPayload.projects;
if (!Array.isArray(notionRecords)) throw new Error('current Notion snapshot requires a projects array');

const baseline = readDevelopmentSyncBaseline({ stateRoot });
if (!baseline) throw new Error('development Notion sync baseline is missing');

const catalog = createProjectCatalogService({ projectsRoot, stateRoot }).catalog();
const projection = projectPortfolioDevelopmentState({
  report,
  baseline,
  notionRecords,
  catalogProjects: catalog.projects
});
const plan = planDevelopmentSync({
  localProjects: projection.localProjects,
  notionRecords,
  baseline,
  binding: baseline.binding
});
const candidateBaseline = createDevelopmentSyncBaseline({
  localProjects: projection.localProjects,
  notionRecords,
  binding: baseline.binding
});
const candidateVerification = planDevelopmentSync({
  localProjects: projection.localProjects,
  notionRecords,
  baseline: candidateBaseline,
  binding: baseline.binding
});
writeAtomic(candidateFile, candidateBaseline);

const result = {
  schemaVersion: 1,
  externalWritePerformed: false,
  portfolioFile,
  notionFile,
  baselineDigest: baseline.digest,
  candidateBaselineDigest: candidateBaseline.digest,
  candidateBaselineFile: candidateFile,
  mappingSummary: projection.mappingSummary,
  portfolioSummary: projection.portfolioSummary,
  candidateVerification: {
    status: candidateVerification.status,
    transportBlocked: candidateVerification.transportBlocked,
    summary: candidateVerification.summary
  },
  drift: {
    status: plan.status,
    transportBlocked: plan.transportBlocked,
    summary: plan.summary,
    nextGate: plan.nextGate,
    operations: plan.operations,
    entries: plan.entries
  }
};
writeAtomic(outputFile, result);

const summary = result.drift.summary;
console.log([
  `status=${result.drift.status}`,
  `registered=${result.portfolioSummary.registeredCount}`,
  `sources=${result.portfolioSummary.sourceCount}`,
  `worktrees=${result.portfolioSummary.worktreeCount}`,
  `dirty=${result.portfolioSummary.dirtyRegisteredCount}`,
  `mapped=${result.mappingSummary.localMatchedCount}/${result.mappingSummary.notionCount}`,
  `notion_only=${result.mappingSummary.notionOnlyCount}`,
  `candidate=${result.candidateVerification.status}`,
  `in_sync=${summary.IN_SYNC}`,
  `local_to_notion=${summary.LOCAL_TO_NOTION}`,
  `notion_to_local=${summary.NOTION_TO_LOCAL}`,
  `both=${summary.BOTH_DIRECTIONS}`,
  `conflict=${summary.CONFLICT}`,
  `output=${outputFile}`
].join(' '));
