import { AICC_INFLIGHT_CUTOFF_CODE, type AiccInflightQuotaCutoff,
  type createAiccInflightRequestGuard } from '../../codex/routing/aicc-inflight-runtime';
import { applyReplayRefusalClientHeaders, retainReplayRefusal,
  isNonReplayableResponse, markResponseNonReplayable,
  isReplayRefusalResponse } from '../../lib/upstream-retry';
import { isNativePassthroughSseResponse, markNativePassthroughSseResponse,
  isEagerRelaySseResponse, markEagerRelaySseResponse,
  isPreinspectedJsonResponse, markPreinspectedJsonResponse } from '../relay';
import { runTurnAdapterSseResponses } from './core-lifetime';

type Guard = ReturnType<typeof createAiccInflightRequestGuard>;
function payload(error: AiccInflightQuotaCutoff) {
  return { error: { type: 'quota_protection_error', code: AICC_INFLIGHT_CUTOFF_CODE,
    message: error.message, reason: error.reason } };
}
export function aiccInflightCutoffResponse(error: AiccInflightQuotaCutoff): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  applyReplayRefusalClientHeaders(headers);
  return retainReplayRefusal(new Response(JSON.stringify(payload(error)), { status: 429, headers }));
}

/** The guard owns the entire response lifetime, not just the wait for HTTP headers. */
export function finalizeAiccInflightResponse(response: Response, guard: Guard, release: () => void): Response {
  const cut = guard.cutoff();
  if (cut) {
    void response.body?.cancel(cut).catch(() => {});
    release();
    return aiccInflightCutoffResponse(cut);
  }
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  const sse = response.headers.get('content-type')?.includes('text/event-stream') === true;
  let finished = false;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  function finish() {
    if (finished) return;
    finished = true;
    guard.signal.removeEventListener('abort', interrupt);
    release();
  }
  function interrupt() {
    if (finished) return;
    const reason = guard.cutoff();
    // Abort already propagated to HTTP fetch/WS exchange/runTurn by the guard's
    // signal. Cancelling the reader also disposes translated output and leases.
    void reader.cancel(reason ?? guard.signal.reason).catch(() => {});
    finish();
    if (reason && sse) {
      // Explicit error; never emit response.completed or [DONE] for truncated work.
      streamController.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(payload(reason))}\n\n`));
      streamController.close();
    } else streamController.error(reason ?? guard.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      guard.signal.addEventListener('abort', interrupt, { once: true });
      if (guard.signal.aborted) interrupt();
    },
    async pull(controller) {
      if (finished) return;
      try {
        const next = await reader.read();
        if (finished) return;
        if (guard.cutoff()) { interrupt(); return; }
        if (next.done) { finish(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        if (finished) return;
        if (guard.cutoff()) { interrupt(); return; }
        finish(); controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      guard.cancel(reason);
      try { await reader.cancel(reason); } catch { /* transport already aborted */ }
    },
  });
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  if (isNativePassthroughSseResponse(response)) markNativePassthroughSseResponse(wrapped);
  if (isEagerRelaySseResponse(response)) markEagerRelaySseResponse(wrapped);
  if (isPreinspectedJsonResponse(response)) markPreinspectedJsonResponse(wrapped);
  if (runTurnAdapterSseResponses.has(response)) runTurnAdapterSseResponses.add(wrapped);
  if (isNonReplayableResponse(response)) markResponseNonReplayable(wrapped);
  if (isReplayRefusalResponse(response)) retainReplayRefusal(wrapped);
  return wrapped;
}
