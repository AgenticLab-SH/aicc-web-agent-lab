import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCodexSessionActivity as read } from '../components/workspace-mcp/codex-session-activity.mjs';
const now = Date.parse('2026-11-17T00:00:00Z');
const e = (type, age = 1000, extra = {}) => ({ type: 'event_msg', timestamp: new Date(now-age).toISOString(), payload: { type, turn_id: 't', ...extra } });
test('new turn overrides old completion and item_completed is not turn completion', () => {
  const events = [e('task_complete', 10000), e('task_started', 2000), e('item_completed')];
  const result = read(events, { now });
  assert.equal(result.status, 'active');
  assert.equal(result.activity.state, 'RECENT_EXECUTION_EVENT');
  assert.equal(result.activity.liveOwnerVerified, false);
  assert.equal(result.activity.writeAuthorized, false);
});
test('tool events refresh observation but do not leak command text or grant completion', () => {
  const events = [e('task_started', 200000), { type: 'response_item', timestamp: new Date(now-1000).toISOString(), payload: { type: 'custom_tool_call_output', output: 'secret command private path' } }];
  const result = read(events, { now });
  assert.equal(result.activity.state, 'RECENT_EXECUTION_EVENT');
  assert.equal(result.activity.evidence, 'TOOL_EVENT');
  assert.equal(result.activity.completionVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
});
test('stale and future start events never prove recent execution', () => {
  for (const age of [120000, -1]) assert.equal(read([e('task_started', age)], { now }).activity.state, 'STALE_OR_WAITING');
  assert.equal(read([{ type: 'event_msg', payload: {type:'task_started'} }], { now }).activity.state, 'STALE_OR_WAITING');
});
test('terminal state is exact, interruption and mismatched turn remain distinct', () => {
  assert.equal(read([e('task_started'), e('task_complete')], { now }).status, 'completed');
  assert.equal(read([e('task_started'), e('turn_aborted')], { now }).status, 'interrupted');
  assert.equal(read([e('task_started'), e('task_complete', 1, {turn_id:'foreign'})], { now }).status, 'unknown');
  assert.equal(read([e('task_started'), {type:'invalid_json_redacted'}], { now }).status, 'unknown');
  assert.equal(read([{type:'function_call_output',payload:{status:'completed'}}, e('item_completed')], { now }).status, 'unknown');
});
