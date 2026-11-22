import test from 'node:test';
import assert from 'node:assert/strict';
import { documentedToolIds, dashboardProductSpec } from '../src/dashboard-product.mjs';
import { toolCatalog } from '../src/catalog.mjs';
import { listTasks } from '../src/tasks.mjs';
import fs from 'node:fs';

test('dashboard product spec documents every user-facing catalog tool', () => {
  const documented = documentedToolIds();
  const missing = toolCatalog().items.map(item => item.id).filter(id => !documented.has(id));
  assert.deepEqual(missing, []);
});

test('every journey explains use, prerequisites, success and recovery', () => {
  const spec = dashboardProductSpec({ actions: [{ name: 'sample' }], tasks: listTasks() });
  assert.equal(spec.schemaVersion, 2);
  assert.equal(spec.name, 'Luminous Control Ledger');
  assert.ok(spec.journeys.length >= 13);
  assert.ok(spec.flows.length >= 6);
  assert.equal(spec.flows[0].id, 'daily');
  for (const flow of spec.flows) {
    assert.ok(flow.label);
    assert.ok(flow.journeyIds.length > 0);
    assert.ok(flow.journeyIds.every(id => spec.journeys.some(journey => journey.id === id)));
  }
  for (const journey of spec.journeys) {
    assert.ok(journey.title);
    assert.ok(journey.outcome);
    assert.ok(journey.when);
    assert.ok(journey.prerequisites.length > 0);
    assert.ok(journey.steps.length > 0);
    assert.ok(journey.success);
    assert.ok(journey.recovery);
  }
  assert.equal(spec.inventory.actionCount, 1);
  assert.equal(spec.inventory.taskCount, listTasks().length);
  for (const id of ['projects', 'knowledge-review', 'local-access']) {
    assert.ok(spec.journeys.some(journey => journey.id === id));
  }
});

test('dashboard exposes intent-first planner and activity evidence surfaces', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const id of ['flowSelector', 'activeFlowSummary', 'task-planner', 'taskBrief', 'activitySummary']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(script, /function plannedPrompt\(/);
  assert.match(script, /function renderActivity\(/);
  assert.match(script, /localStorage\.setItem\('aicc\.activeFlow'/);
  assert.doesNotMatch(script, /localStorage\.setItem\([^\n]*taskBrief/);
});

test('public distribution checker accepts npm 11 object reports and legacy arrays', () => {
  const source = fs.readFileSync(new URL('../scripts/check-public-distribution.mjs', import.meta.url), 'utf8');
  assert.match(source, /Array\.isArray\(rawReport\) \? rawReport : Object\.values\(rawReport\)/);
  assert.match(source, /process\.env\.npm_lifecycle_event !== 'prepack'/);
});
