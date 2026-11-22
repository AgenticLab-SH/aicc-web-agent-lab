// AICC-owned HTTP boundary. No imports from or writes into the supplier package.
// The stock dispatcher and the A1 lease client must be bound by the release owner.
import { timingSafeEqual } from 'node:crypto';
import { createCompletionObservation, type RequestSettlement } from './external-conversation-lifecycle';
import { ExternalRequestBodyError } from './external-request-body';
import { ExternalSafeFault, typedFailureCode, safeFailure, failureHeaders, type SafeFailure, type DispatchEvidence, type ContinuationAdvice } from './external-safe-fault';
import { createAiccInflightMonitor, isCompleteInflightQuota, quotaThresholdReason, type InflightQuota, type InflightSettings } from './window-inflight-monitor';

export type ExternalOcxLease = {
  accountId: string; chatgptAccountId: string; accessToken: string; generation: number;
  accountSelector?: string;
  quota: InflightQuota; quotaObservedAt: number; refreshToken?: never;
  supplierContext?: Record<string,unknown>;
  supplierConfig?: Record<string,unknown>;
  // Trusted closure, never body/header JSON. Called only at physical fetch.
  originalIssuerDispatch?: (send:()=>Promise<Response>)=>Promise<Response>;
};
export type ExternalOcxBoundaryDeps = {
  dataToken: () => string;
  settings: (id?: string) => InflightSettings;
  // Selection owns pause/pin/priority, model entitlement and account-scoped input checks.
  // It must not dispatch inference or copy a refresh grant from the A1 owner.
  select: (request: Request, signal: AbortSignal) => Promise<ExternalOcxLease>;
  // The pool owner may lower a public account selector to its native model.
  // It may change only the JSON body; credentials are still set here.
  preparedBody?: (request: Request) => unknown;
  generationLive: (id: string, generation: number) => boolean;
  quota: (id: string) => InflightQuota | null;
  refresh: (id: string) => Promise<{quota: InflightQuota | null; generation?: number; verified: boolean}>;
  // Must use the official Direct/passthrough contract with the request-owned lease.
  dispatch: (request: Request, lease?: ExternalOcxLease) => Promise<Response>;
  dispatchEvidence?: (request:Request) => DispatchEvidence;
  noteDispatch?: (request:Request,lease:ExternalOcxLease,response:Response)=>void;
  beforeDispatch?: (request:Request)=>void;
  noteSettlement?: (request:Request,outcome:RequestSettlement)=>void;
  catalog: (request: Request) => Promise<Response>;
  noteFailure?: (request:Request,status:number,failure:SafeFailure,continuation?:ContinuationAdvice)=>void;
  // Source-only proof from the actual OCX selected/bound account; never user headers.
  noteOriginalQuotaRefusal?: (request:Request,reason:'window_threshold'|'window_stop_policy')=>
    {ownerRequestId:string;receiptSha256:string;kind:string;dispatchable:false;
      codexUsageLimit?:{resetsAt:number;windowMinutes:300}}|null;
};
const percentage = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
// A complete upstream 4xx answer is a definite refusal: the provider answered and
// no model output exists. 408 and every 5xx stay UNKNOWN because execution may
// have happened behind a gateway timeout.
const definiteRejection = (status: number) => status >= 400 && status < 500 && status !== 408;
// Codex shows only "unexpected status N: <message>". Give the typed reason, the
// send state and one next action, built only from allowlisted codes (G1-05).
const NEXT_ACTION: Record<string,string> = {
  request_outcome_unknown:'이전 요청의 자동 반복은 중단했습니다. 같은 대화에 남은 작업을 새 메시지로 보내면 계속할 수 있습니다.',
  conversation_outcome_unknown:'이전 요청의 결과를 확인하지 못했습니다. 같은 대화의 새 지시는 계속할 수 있습니다. 원 요청은 자동 반복하지 않습니다.',
  conversation_request_active:'같은 대화의 이전 요청이 아직 진행 중입니다. 그 응답이 끝난 뒤 다시 보내세요.',
  window_threshold:'설정된 계정 사용량 한도에 도달해 새 요청을 보내지 않았습니다. 자동·우선 모드에 적격 계정이 없거나 고정 모드이면 한도 초기화 뒤 계속하세요.',
  window_stop_policy:'계정 사용량 정지 정책으로 새 요청을 보내지 않았습니다. 한도 초기화 뒤 다시 보내세요.',
  quota_unverified:'계정 사용량을 새로 확인하지 못해 보내지 않았습니다. 잠시 뒤 다시 보내세요.',
  maintenance_draining:'OCX 정비 중이라 새 요청을 받지 않습니다. 정비가 끝난 뒤 다시 보내세요.',
  account_change_readable_checkpoint_required:'계정을 바꾸려면 읽을 수 있는 작업 요약으로 새 대화를 시작해야 합니다.',
  pinned_thread_account_change_refused:'고정(strict) 계정 대화라 다른 계정으로 옮기지 않았습니다. 그 계정 한도가 풀린 뒤 다시 보내세요.',
  uploaded_files_cannot_change_account:'업로드 파일이 원 계정에 묶여 있어 다른 계정으로 옮기지 않았습니다.',
};
export function refusalMessage(code: string, failure?: SafeFailure): string {
  const reason = failure?.code ?? code;
  const sent = !failure ? '' : failure.dispatchStarted === false ? '; 전송 안 됨' : failure.dispatchStarted === true ? '; 전송 후 결과 미확정' : '; 전송 여부 불명';
  const next = NEXT_ACTION[reason] ?? (failure?.dispatchStarted === false
    ? '보내기 전에 거절했습니다. 원인을 해결한 뒤 다시 보내세요.'
    : '결과를 확인한 뒤 필요할 때만 직접 다시 보내세요.');
  return `Request refused or interrupted. It was not replayed. [${reason}${sent}] ${next}`;
}
function refusal(code: string, status = 429, failure?:SafeFailure): Response {
  const unsupported=code==='external_route_contract_required';
  const diagnostic=failure ?? (status===503 && code==='maintenance_draining'
    ? safeFailure('maintenance_draining',false) : undefined);
  const headers=new Headers({'x-should-retry':'false'});
  failureHeaders(headers,status,diagnostic);
  return Response.json({error:{type:unsupported?'unsupported_route_error':'quota_protection_error',code,
    message:unsupported?'Requested route is not implemented by this AICC adapter.':refusalMessage(code,diagnostic),...(failure?{failure}: {})}},
    {status,headers});
}
function quotaRefusal(request: Request, reason: 'window_stop_policy' | 'window_threshold', continuation?:ContinuationAdvice,
  ownerSource?:{ownerRequestId:string;receiptSha256:string;kind:string;dispatchable:false;
    codexUsageLimit?:{resetsAt:number;windowMinutes:300}}|null): Response {
  // These IDs correlate a refusal; they never authorize a caller or prove its
  // identity. Missing/invalid IDs remain null and cannot authorize a queue retry.
  const requestId = request.headers.get('x-request-id') ?? request.headers.get('x-codex-request-id')
    ?? request.headers.get('x-client-request-id');
  const threadId = request.headers.get('thread-id') ?? request.headers.get('session_id') ?? request.headers.get('session-id');
  const turnId = request.headers.get('x-codex-turn-id') ?? request.headers.get('turn-id');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const receipt = {schemaVersion:1,kind:'aicc-pre-dispatch-quota-refusal',reason,phase:'pre_dispatch',dispatchStarted:false,replayed:false,
    requestId:requestId && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(requestId) ? requestId : null,
    threadId:threadId && uuid.test(threadId) ? threadId : null,
    turnId:turnId && uuid.test(turnId) ? turnId : null,observedAt:new Date().toISOString()};
  const message = refusalMessage(reason, safeFailure(reason,false))
    + (continuation?.nextAction==='checkpoint_new_thread' ? ' 다음: 작업 요약으로 새 대화를 시작하세요.'
      : continuation?.nextAction==='wait_for_reset' ? ' 다음: 한도 초기화를 기다리세요.' : '');
  const ownerQuotaEvidence=ownerSource?.kind==='aicc-ocx-original-fivehour-pre-dispatch-refusal/v1' &&
    uuid.test(ownerSource.ownerRequestId) && /^[a-f0-9]{64}$/.test(ownerSource.receiptSha256) &&
    ownerSource.dispatchable===false
    ? {schemaVersion:1,kind:ownerSource.kind,ownerRequestId:ownerSource.ownerRequestId,
      receiptSha256:ownerSource.receiptSha256,sourceOnly:true,originalIssuerVerified:false,dispatchable:false}
    : undefined;
  const limit=ownerSource?.codexUsageLimit;
  const providerExhausted=!!ownerQuotaEvidence && limit?.windowMinutes===300 &&
    Number.isSafeInteger(limit.resetsAt) && limit.resetsAt*1000>Date.now();
  return Response.json({error:{type:providerExhausted?'usage_limit_reached':'quota_protection_error',code:'window_stop_policy',message,quotaRefusal:receipt,
    ...(providerExhausted?{resets_at:limit!.resetsAt,limit_window_minutes:300}:{}),
    ...(ownerQuotaEvidence?{ownerQuotaEvidence}:{}),...(continuation?{continuation}: {})}},
    {status:429,headers:{'x-should-retry':'false'}});
}
export function createExternalOcxHttpBoundary(deps: ExternalOcxBoundaryDeps) {
  let active = 0;
  let draining = false;
  const requestTruth=new WeakMap<Request,()=>boolean|null>();
  const failureFor=(request:Request,error:unknown):SafeFailure=>{
    let started:boolean|null=null;
    try{started=requestTruth.get(request)?.()??null;}catch{/* unknown proof stays null */}
    const code=typedFailureCode(error) ?? (started===false?'selection_failed':'dispatch_failed');
    return safeFailure(code,started);
  };
  const monitor = createAiccInflightMonitor({
    enabled: () => true, now: Date.now, settings: deps.settings,
    snapshot: deps.quota, generationLive: deps.generationLive, refresh: deps.refresh,
    noteObservation: () => {},
    schedule: (callback, milliseconds) => {
      const timer = setInterval(callback,milliseconds);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  });
  async function handle(request: Request): Promise<Response> {
    // Before provider delegation this boundary has made no inference send.
    requestTruth.set(request,()=>false);
    const expectedToken = deps.dataToken();
    const expected = Buffer.from('Bearer '+expectedToken);
    const actual = Buffer.from(request.headers.get('authorization') ?? '');
    if (!expectedToken || expected.length !== actual.length || !timingSafeEqual(expected,actual)) return refusal('authentication_error',401);
    const url = new URL(request.url);
    // WebSocket lifetimes require a distinct adapter; never allow an unguarded upgrade.
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return refusal('external_websocket_contract_required',426);
    if (/\/(models|catalog)$/.test(url.pathname) && request.method === 'GET') return deps.catalog(request);
    const search=/^\/(?:v1\/)?alpha\/search$/.test(url.pathname);
    if ((!/\/responses(?:\/compact)?$/.test(url.pathname) && !search) || request.method !== 'POST') return refusal('external_route_contract_required',404);
    if (draining) return refusal('maintenance_draining',503);
    const controller = new AbortController();
    let cutoff: string | undefined;
    // Set when a quota-policy reason arrives after the single physical dispatch.
    // The admitted response drains; only new requests are refused/reselected.
    let drainReason: string | undefined;
    let dispatchDelegated = false;
    let outcome: Exclude<RequestSettlement,'not_sent'|'unknown'> | undefined;
    let unsubscribe = () => {};
    let released = false;
    // G1-23: a client abort while zero response body bytes have reached the client leaves
    // the client with no output, ids, ciphertext or tool calls from this attempt. It settles
    // as 'abandoned' (fence cleared, no issuer binding) instead of a permanent UNKNOWN.
    // Any delivered byte keeps UNKNOWN. Upstream consumption is still recorded as a failure.
    let clientAbort = false;
    let deliveredBytes = 0;
    const clientAborted = () => { clientAbort = true; controller.abort(request.signal.reason); };
    const release = () => {
      if (released) return;
      released = true;
      unsubscribe();
      request.signal.removeEventListener('abort',clientAborted);
      try {
        let notSent=!dispatchDelegated;
        if(dispatchDelegated) {try {notSent=requestTruth.get(request)?.()===false;} catch {notSent=false;}}
        deps.noteSettlement?.(request,notSent?'not_sent':outcome ?? (clientAbort && deliveredBytes===0 && !cutoff ? 'abandoned' : 'unknown'));
      } catch {
        // The pool keeps its durable UNKNOWN fence if settlement persistence fails.
        try {deps.noteFailure?.(request,503,safeFailure('conversation_outcome_unknown',null));} catch {}
      } finally {active--;}
    };
    active++;
    request.signal.addEventListener('abort',clientAborted,{once:true});
    if (request.signal.aborted) clientAborted();
    try {
      const lease = await deps.select(request,controller.signal);
      if ('refreshToken' in lease || !lease.accessToken || !lease.chatgptAccountId || !Number.isInteger(lease.generation)
        || !deps.generationLive(lease.accountId,lease.generation)) throw new ExternalSafeFault('external_credential_contract_required');
      const age = Date.now()-lease.quotaObservedAt;
      if (!Number.isFinite(age) || age < 0 || age >= 60_000 || !isCompleteInflightQuota(lease.quota)) throw new ExternalSafeFault('quota_unverified');
      const rules = deps.settings(lease.accountId);
      for (const rule of [rules.fiveHour,rules.longWindow]) {
        if (!Number.isInteger(rule?.usedThreshold) || rule.usedThreshold < 1 || rule.usedThreshold > 100
          || !['switch','stop'].includes(rule.action)) throw new ExternalSafeFault('invalid_window_policy');
      }
      if (quotaThresholdReason(lease.quota,rules)) throw new ExternalSafeFault('window_threshold');
      unsubscribe = monitor.subscribe(lease.accountId,lease.generation,reason => {
        // Admission (new request) and in-flight policies are separate. Before the
        // single physical dispatch every monitor reason refuses as not sent. After
        // it, only a rotated/revoked credential interrupts. Threshold and quota
        // freshness reasons drain the admitted response: cutting it creates a
        // durable UNKNOWN fence that blocks the whole conversation. The provider's
        // own hard limit still ends the stream and settles as a definite failure.
        if (dispatchDelegated && reason !== 'credential_changed') { drainReason ??= reason; return; }
        cutoff = reason;
        controller.abort(Error(reason));
      });
      if (controller.signal.aborted) {
        release();
        if (cutoff?.includes('threshold')) {
          try { deps.noteFailure?.(request,429,safeFailure('window_threshold',false)); } catch { /* not sent; nothing to replay */ }
          let ownerSource=null;
          try{ownerSource=deps.noteOriginalQuotaRefusal?.(request,'window_threshold')??null;}catch{/* source writer failure never dispatches */}
          return quotaRefusal(request,'window_threshold',undefined,ownerSource);
        }
        return refusal(cutoff ?? 'request_cancelled');
      }
      const headers = new Headers(request.headers);
      for (const key of ['authorization','proxy-authorization','cookie','x-opencodex-api-key','x-api-key','x-aicc-ocx-account-selector',
        'x-aicc-failure-code','x-aicc-failure-phase','x-aicc-dispatch-started',
        'x-aicc-original-issuer-reservation','x-aicc-native-runtime-id','x-aicc-native-epoch',
        'x-aicc-native-goal-id','x-aicc-native-proof']) headers.delete(key);
      headers.set('authorization','Bearer '+lease.accessToken);
      headers.set('chatgpt-account-id',lease.chatgptAccountId);
      const preparedBody = deps.preparedBody?.(request);
      if (preparedBody !== undefined) {
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.set('content-type','application/json');
      }
      const forwarded = preparedBody === undefined
        ? new Request(request,{headers,signal:controller.signal})
        : new Request(request.url,{method:request.method,headers,body:JSON.stringify(preparedBody),signal:controller.signal});
      // Exactly one physical dispatch. No fallback or replay after an uncertain outcome.
      deps.beforeDispatch?.(request);
      dispatchDelegated = true;
      requestTruth.set(request,()=>deps.dispatchEvidence?.(forwarded)?.dispatchStarted??null);
      const response = await deps.dispatch(forwarded,lease);
      // Search is account-admitted work, but creates no conversation issuer.
      if(!search) deps.noteDispatch?.(request,lease,response);
      // Bind only the admitted request's public selector, never an upstream or caller label.
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('x-aicc-ocx-account-selector');
      for(const key of ['x-aicc-failure-code','x-aicc-failure-phase','x-aicc-dispatch-started']) responseHeaders.delete(key);
      if (/^p[0-9a-f]{6}$/.test(lease.accountSelector ?? '')) responseHeaders.set('x-aicc-ocx-account-selector', lease.accountSelector!);
      if(!response.ok) responseHeaders.set('x-should-retry','false');
      if (cutoff) {
        const failure=failureFor(request,new ExternalSafeFault(cutoff.includes('threshold')?'window_threshold'
          :cutoff==='credential_changed'?'external_credential_contract_required':'quota_unverified'));
        try { deps.noteFailure?.(request,499,failure); } catch { /* UNKNOWN result stays unreplayed */ }
        void response.body?.cancel().catch(()=>{}); release(); return refusal(cutoff);
      }
      // The 4xx status line itself is the provider's definite refusal; a client that
      // stops reading the error body must not turn it into a conversation UNKNOWN.
      if (!response.ok && definiteRejection(response.status)) outcome = 'rejected';
      if (!response.body) {
        release(); return new Response(null,{status:response.status,statusText:response.statusText,headers:responseHeaders});
      }
      const observation=createCompletionObservation(response.headers.get('content-type')??'',url.pathname.endsWith('/responses/compact'));
      const reader = response.body.getReader();
      let output: ReadableStreamDefaultController<Uint8Array>;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        controller.signal.removeEventListener('abort',interrupt);
        release();
      };
      const interrupt = () => {
        if (finished) return;
        const failure=failureFor(request,new ExternalSafeFault(cutoff?.includes('threshold')?'window_threshold'
          :cutoff==='credential_changed'?'external_credential_contract_required':'external_request_not_completed'));
        try { deps.noteFailure?.(request,499,failure); } catch { /* do not retry a partially consumed response */ }
        void reader.cancel(controller.signal.reason).catch(()=>{});
        finish();
        if (cutoff && response.headers.get('content-type')?.includes('text/event-stream')) {
          output.enqueue(new TextEncoder().encode('event: error\ndata: '+JSON.stringify({error:{code:'aicc_window_inflight_cutoff',reason:cutoff}})+'\n\n'));
          output.close();
        } else output.error(Error(cutoff ?? 'request_cancelled'));
      };
      const body = new ReadableStream<Uint8Array>({
        start(c) { output=c; controller.signal.addEventListener('abort',interrupt,{once:true}); if(controller.signal.aborted) interrupt(); },
        async pull(c) {
          if(finished) return;
          // While draining, the monitor no longer watches this account. Keep the
          // credential revocation check that the monitor would otherwise apply.
          if(drainReason && !deps.generationLive(lease.accountId,lease.generation)) {
            cutoff='credential_changed'; controller.abort(Error(cutoff)); return;
          }
          try {
            const chunk=await reader.read();
            if(finished) return;
            if(chunk.done) {
              outcome=response.ok
                ? observation.complete() ? 'completed' : observation.failed() ? 'failed' : undefined
                : definiteRejection(response.status) ? 'rejected' : undefined;
              finish(); c.close();
            } else {
              observation.push(chunk.value);
              // Codex may continue or cancel immediately after response.completed.
              // Commit the observed terminal before exposing it to the client;
              // waiting for transport EOF creates false active/UNKNOWN fences.
              if(response.ok && (observation.completed() || observation.failed())) {
                outcome=observation.failed()?'failed':'completed';
                finish();
                c.enqueue(chunk.value);
                c.close();
                void reader.cancel().catch(()=>{});
              } else {
                // A terminal model failure is a known outcome, not UNKNOWN. Record it
                // before exposure so a client cancel after it cannot erase the proof.
                if(response.ok && observation.failed()) outcome='failed';
                deliveredBytes+=chunk.value.byteLength;
                c.enqueue(chunk.value);
              }
            }
          } catch { if(!finished) {
            try { deps.noteFailure?.(request,502,failureFor(request,new ExternalSafeFault('dispatch_failed'))); } catch { /* preserve UNKNOWN */ }
            finish(); c.error(Error(cutoff ?? 'upstream_transport_failed'));
          } }
        },
        async cancel(reason) { clientAbort = true; finish(); controller.abort(reason); try { await reader.cancel(reason); } catch {} },
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:responseHeaders});
    } catch(error) {
      release();
      if(error instanceof ExternalRequestBodyError) return refusal(error.code,error.status);
      if (!dispatchDelegated && !cutoff && !controller.signal.aborted && error instanceof ExternalSafeFault
        && (error.code === 'window_stop_policy' || error.code === 'window_threshold')) {
        const diagnostic=safeFailure(error.code,false);
        try { deps.noteFailure?.(request,429,diagnostic,error.continuation); } catch { /* never retry a model request for a journal failure */ }
        let ownerSource=null;
        try{ownerSource=deps.noteOriginalQuotaRefusal?.(request,error.code)??null;}catch{/* source writer failure never dispatches */}
        return quotaRefusal(request,error.code,error.continuation,ownerSource);
      }
      // UNKNOWN provider delegation emits no tuple; no message-based inference.
      const status=controller.signal.aborted ? 499 : error instanceof ExternalSafeFault
        && ['request_outcome_unknown','conversation_request_active'].includes(error.code) ? 409 : 503;
      const failure=failureFor(request,error);
      try { deps.noteFailure?.(request,status,failure); } catch { /* preserve original outcome */ }
      return refusal(cutoff ?? 'external_request_not_completed',status,failure);
    }
  }
  return {handle,failureFor,activeTurns:()=>active,drain:()=>{draining=true;return active===0;},isDraining:()=>draining};
}
