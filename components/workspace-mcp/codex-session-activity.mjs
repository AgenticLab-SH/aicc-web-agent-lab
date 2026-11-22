// Observation only: a saved event never grants a writer or proves a live owner.
const starts = new Set(['task_started', 'turn_started']);
const ends = new Map([['task_complete', 'task_completed'], ['task_completed', 'task_completed'],
  ['turn_complete', 'task_completed'], ['turn_completed', 'task_completed'],
  ['turn_aborted', 'interrupted'], ['task_interrupted', 'interrupted']]);
const tools = new Set(['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output']);

export function summarizeCodexSessionActivity(events, { now = Date.now() } = {}) {
  let status = 'unknown', turn = null, last = null, evidence = 'SAVED_STATE_ONLY';
  for (const event of events) {
    if (event?.type === 'invalid_json_redacted') { status = 'unknown'; last = null; continue; }
    const payload = event?.payload ?? event;
    const kind = event?.type === 'event_msg' ? payload?.type : event?.type;
    const at = event?.timestamp ?? payload?.timestamp;
    const validTime = typeof at === 'string' && Number.isFinite(Date.parse(at));
    if (starts.has(kind) || kind === 'turn_context') {
      status = 'active'; turn = payload?.turn_id ?? null;
      last = validTime ? at : null; evidence = 'TURN_START_EVENT';
    } else if (ends.has(kind)) {
      const mismatch = turn && payload?.turn_id && payload.turn_id !== turn;
      status = mismatch ? 'unknown' : ends.get(kind) === 'task_completed' ? 'completed' : 'interrupted';
      last = validTime ? at : null; evidence = 'TURN_TERMINAL_EVENT';
    } else if (event?.type === 'event_msg' && ['completed', 'active', 'interrupted', 'unknown'].includes(payload?.status)) {
      status = payload.status; last = validTime ? at : null; evidence = 'EXPLICIT_STATUS_EVENT';
    } else if (status === 'active' && event?.type === 'response_item' && tools.has(payload?.type)) {
      last = validTime ? at : null; evidence = 'TOOL_EVENT';
    }
  }
  const age = last === null ? NaN : now - Date.parse(last);
  const recent = status === 'active' && Number.isFinite(age) && age >= 0 && age < 120000;
  return { status, activity: { state: recent ? 'RECENT_EXECUTION_EVENT' : status === 'active' ? 'STALE_OR_WAITING'
    : status === 'completed' ? 'TURN_ENDED' : status === 'interrupted' ? 'INTERRUPTED' : 'UNKNOWN',
  lastObservedAt: last, evidence, freshnessSeconds: 120, liveOwnerVerified: false,
  writeAuthorized: false, completionVerified: false } };
}
