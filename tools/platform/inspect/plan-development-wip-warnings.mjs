#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planDevelopmentWipWarnings } from '../../../src/projects/development-wip-warnings.mjs';

function readJson(file, label, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback;
    throw new Error(`${label} could not be read: ${error.message}`);
  }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ACL-only platform */ }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return path.resolve(value);
}

const stateRoot = path.resolve(process.env.AICC_STATE_ROOT?.trim() || path.join(os.homedir(), '.ai-control-center'));
const syncRoot = path.join(stateRoot, 'project-catalog', 'development-notion-sync');
const warningRoot = path.join(stateRoot, 'project-catalog', 'development-wip-warnings');
const portfolioFile = argument('--portfolio', path.join(stateRoot, 'git-portfolio', 'latest.json'));
const projectsFile = argument('--projects-current', path.join(syncRoot, 'notion-current.json'));
const tasksFile = argument('--tasks-current', path.join(syncRoot, 'notion-tasks-current.json'));
const stateFile = argument('--state', path.join(warningRoot, 'state.json'));
const policyFile = argument('--policy', path.join(warningRoot, 'policy.json'));
const outputFile = argument('--output', path.join(warningRoot, 'latest.json'));

const portfolioReport = readJson(portfolioFile, 'portfolio report');
const projectPayload = readJson(projectsFile, 'Notion project snapshot');
const taskPayload = readJson(tasksFile, 'Notion task snapshot');
const previousState = readJson(stateFile, 'WIP warning state', null);
const policy = readJson(policyFile, 'WIP warning policy', {});
const projectRecords = Array.isArray(projectPayload) ? projectPayload : projectPayload.projects;
const taskRecords = Array.isArray(taskPayload) ? taskPayload : taskPayload.tasks;
if (!Array.isArray(projectRecords)) throw new Error('Notion project snapshot requires a projects array');
if (!Array.isArray(taskRecords)) throw new Error('Notion task snapshot requires a tasks array');

const result = planDevelopmentWipWarnings({ portfolioReport, projectRecords, taskRecords, previousState, policy });
writeAtomic(stateFile, result.nextState);
writeAtomic(outputFile, { ...result, nextState: undefined, ownerLocalWritePerformed: true });

console.log([
  `warnings=${result.summary.warningCount}`,
  `focus_programs=${result.summary.focusProgramCount}`,
  ...Object.entries(result.summary.counts).map(([code, count]) => `${code.toLowerCase()}=${count}`),
  'external_write=false',
  `output=${outputFile}`
].join(' '));
