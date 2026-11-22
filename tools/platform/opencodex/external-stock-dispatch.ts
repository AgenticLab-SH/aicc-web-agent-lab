// Read-only compatibility facade around the pinned official supplier package.
// The supplier tree/version are never rewritten by this adapter.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readExternalRequestJson } from './external-request-body';
import type { DispatchEvidence } from './external-safe-fault';

export async function bindOfficialOcxDispatch(packageRoot: string, version: string) {
  const root = realpathSync(packageRoot);
  const manifest = JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if (manifest.name !== '@bitkyc08/opencodex' || manifest.version !== version || !['2.81.0','2.96.0'].includes(version)) {
    throw Error('unaccepted_stock_package_identity');
  }
  const load = (name: string) => import(pathToFileURL(join(root,name)).href);
  const [official, budgets, quotas, portability, router, responses, websocket, core, compactCore, execution, requestLog, catalog, fast, opaque, search, controlModels, controlCatalog] = await Promise.all([
    load('src/index.ts'), load('src/lib/translator-budget.ts'),
    load('src/codex/quota.ts'), load('src/server/responses/account-change-state.ts'), load('src/router.ts'),
    load('src/adapters/openai-responses.ts'), load('src/server/ws-bridge.ts'),
    load('src/server/responses/core.ts'),load('src/server/responses/compact.ts'),
    load('src/lib/request-execution-budget.ts'),load('src/server/request-log.ts'),
    load('src/codex/catalog/build-entries.ts'),load('src/server/fast-row.ts'),
    load('src/server/responses/core-opaque-recovery.ts'),
    load('src/server/search.ts'),
    load('src/codex/control-plane-models.ts'), load('src/codex/catalog/control-plane.ts'),
  ]);
  if (typeof official.parseRequest !== 'function' || typeof official.createResponsesPassthroughAdapter !== 'function'
    || typeof budgets.createTranslatorBudget !== 'function' || typeof quotas.parseUsageQuota !== 'function'
    || typeof portability.collectConversationStateCarriers !== 'function'
    || typeof search.handleSearch !== 'function'
    || typeof controlModels.isCodexControlPlaneModel !== 'function'
    || typeof controlCatalog.withCodexControlPlaneRows !== 'function') throw Error('stock_adapter_contract_unavailable');
  const provider = { adapter: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex',
    authMode: 'forward', codexAccountMode: 'direct' };
  const websocketRequests=new WeakSet<Request>();
  const dispatchProofs=new WeakMap<Request,()=>DispatchEvidence>();
  const dispatchEvidence=(request:Request):DispatchEvidence => {
    try{return dispatchProofs.get(request)?.() ?? {dispatchStarted:null,source:'supplier_handoff'};}
    catch{return {dispatchStarted:null,source:'supplier_handoff'};}
  };
  function resolveRoute(config:any,model:string) {
    const synthetic=fast.parseSyntheticRowId(model,config);
    const base=synthetic.fastRow?.baseId ?? synthetic.effortRow?.baseId ?? model;
    const route=router.previewRouteModel(config,base);
    if(route.providerName!=='openai' || route.provider?.authMode!=='forward'
      || route.provider?.baseUrl!==provider.baseUrl || route.combo || route.credentialDomainRewrite
      || route.codexAccountId==='__main__') throw Error('external_provider_route_not_admitted');
    if(synthetic.effortRow) throw Error('external_effort_row_contract_required');
    return {modelId:route.modelId,wireModel:route.modelId+(synthetic.fastRow?'--fast':''),
      accountId:route.codexAccountId,provider:route.provider};
  }
  async function dispatchFull(request:Request,context?:{supplierContext?:Record<string,unknown>;supplierConfig?:Record<string,unknown>;
    originalIssuerDispatch?:(send:()=>Promise<Response>)=>Promise<Response>}):Promise<Response> {
    // A recovery continuation has exactly one send. Stock core can await and
    // repair/retry internally, so use its existing direct serializer + explicit
    // physical-fetch fence. Ordinary requests keep the full stock behavior.
    if(context?.originalIssuerDispatch) {
      if(websocketRequests.has(request)||!/^\/(?:v1\/)?responses$/.test(new URL(request.url).pathname))
        throw Error('original_issuer_http_responses_required');
      return dispatch(request,context);
    }
    dispatchProofs.set(request,()=>({dispatchStarted:false,source:'before_supplier'}));
    const routed=context?.supplierContext;
    if(!routed || routed.authMode!=='forward' || routed.baseUrl!==provider.baseUrl
      || routed.adapter!=='openai-responses' || routed.apiKey || routed._codexAccountOverride
      || routed._codexAccountRequired) throw Error('external_supplier_context_invalid');
    // The external owner has already selected and admitted an A1 access lease.
    // Request-owned Direct forwarding keeps all stock response handling, without
    // enabling its stored-account pool or accessing the real Native home.
    const featureKeys=['multiAgentMode','subagentModels','fastRows','emptyCompletionRetry','dropSafetyBuffering',
      'stallTimeoutSec','maxUpstreamBodyBytes','codexNativeSteering','codexNativeInjection','websockets','streamMode',
      'codexReasoningEfforts','codexDefaultReasoningEffort','codexModelContextWindows','modelPickerOrder'];
    const features=Object.fromEntries(featureKeys.filter(key=>context?.supplierConfig?.[key]!==undefined)
      .map(key=>[key,context!.supplierConfig![key]]));
    const config={...features,port:10100,hostname:'127.0.0.1',runtimeRole:'standalone',
      providers:{openai:{...routed,codexAccountMode:'direct'}},defaultProvider:'openai',
      codexAccounts:[],codexAccountNamespaces:{},pausedCodexAccountIds:[],
      codexAutoStart:false,clientIntegrations:{codex:false},codexQuotaAutoRefresh:{},
      claudeCode:{enabled:false,intercept:{enabled:false}},modelDiscovery:{enabled:false},visionSidecar:{enabled:false}};
    const logCtx={requestId:requestLog.nextRequestLogId()};
    // Standalone search is a distinct official relay, not a Responses request or
    // an arbitrary URL proxy. The external boundary has already applied the same
    // model entitlement, A1 lease generation and fresh-window admission. Direct
    // mode consumes only its request-owned bearer; no stored/Native account or
    // paid sidecar fallback exists in this isolated supplier configuration.
    if (/^\/(?:v1\/)?alpha\/search$/.test(new URL(request.url).pathname)) {
      dispatchProofs.set(request,()=>({dispatchStarted:null,source:'supplier_handoff'}));
      return search.handleSearch(request,config,logCtx);
    }
    // A production execution-budget seam enforces one physical model send across
    // stock transient/auth/repair/compaction branches; it is not a global fetch patch.
    const sendBudget=execution.createRequestExecutionBudget({maxTotalModelSends:1,
      baseSendAllowance:1,finalRecoveryAllowance:0,maxAlternateTargetSends:0,maxTargetTransitions:0});
    // The supplier ledger is real request-scoped evidence, but a reservation or
    // physical-start claim is not a transport acknowledgement. Keep UNKNOWN.
    dispatchProofs.set(request,()=>({dispatchStarted:null,source:'supplier_handoff',
      budgetPhysicalClaims:Number.isInteger(sendBudget.physicalStarted)?sendBudget.physicalStarted:null}));
    const options={abortSignal:request.signal,sendBudget,openAiSidecarAuth:null,
      ...(websocketRequests.has(request)?{inboundTransport:'websocket',forceEmptyResponseId:true}:{}),
      nativeCallerAuth:null,allowStoredOpenAiSidecarAuth:false};
    if(new URL(request.url).pathname.endsWith('/responses/compact')) {
      return compactCore.handleResponsesCompact(request,config,logCtx,undefined,undefined,options);
    }
    return core.handleResponses(request,config,logCtx,options);
  }

  function controlPlaneModel(rows:any[],model:string):any|undefined {
    if(!controlModels.isCodexControlPlaneModel(model)) return undefined;
    // The pinned supplier admits hidden control-plane metadata only alongside
    // an ordinary OpenAI native row. Account choices, reserve and routed rows
    // do not establish support. The helper's native pin is its existing fallback.
    const projected=controlCatalog.withCodexControlPlaneRows(
      structuredClone(rows),structuredClone(rows),true,false);
    const exact=projected.filter((row:any)=>row?.slug===model);
    if(exact.length!==1 || exact[0].supported_in_api!==true || exact[0].visibility!=='hide') return undefined;
    return exact[0];
  }
  function buildCatalog(config:any,rows:any[]) {
    const gptSlugs=[...new Set(rows.map(row=>row.slug))] as string[];
    const entries=catalog.buildCatalogEntriesFromObservedState({template:null,gptSlugs,goModels:[],
      featured:config.subagentModels,modelPickerOrder:config.modelPickerOrder??[],
      wsEnabled:config.websockets!==false,multiAgentMode:config.multiAgentMode??'default',
      exactComboSlugs:new Set(),accountSelectors:[],suppressedBareNativeSlugs:new Set(),
      disabledNativeAccountSlugs:new Set(),multiAgentV2Enabled:config.multiAgentMode==='v2'});
    // Only observed physical-account entitlements are public. Stock internal
    // control-plane rows have no externally admitted serving account here.
    return entries.filter((row:any)=>gptSlugs.includes(row.slug));
  }
  function discovery(config:any,rows:any[]) {
    return rows.flatMap(row=>fast.expandFastRow({id:row.slug,object:'model',owned_by:'opencodex'},
      Array.isArray(row.additional_speed_tiers)&&row.additional_speed_tiers.includes('fast')
        && fast.catalogFastRowEligible(config,{provider:'openai',id:row.slug,native:true}),config));
  }
  function parseQuota(body:any) {
    const quota=quotas.parseUsageQuota(body);
    if(!quota) return null;
    const primary=body?.rate_limit?.primary_window;
    // A missing burst reading is normally UNKNOWN. The explicit monthly-only
    // WHAM shape is different: it has no burst window to read or protect.
    // Do not infer applicability from a plan label or fill missing usage with 0.
    if(Number.isFinite(primary?.limit_window_seconds) && primary.limit_window_seconds>=28*24*60*60
      && typeof primary.used_percent==='number' && Number.isFinite(primary.used_percent)
      && primary.used_percent>=0 && primary.used_percent<=100
      && body.rate_limit.secondary_window===null && body.rate_limit.tertiary_window==null
      && quota.shortPercent===undefined && quota.monthlyPercent===primary.used_percent) {
      return {...quota,shortWindowApplicable:false};
    }
    return quota;
  }
  async function scrubAccountChange(body:any,preserveCurrentAccountFiles=false):Promise<any> {
    const copy=structuredClone(body);
    const historyNotice=!!copy.previous_response_id || !!copy.conversation
      || (Array.isArray(copy.input) && copy.input.some((item:any)=>
        ['item_reference','compaction','compaction_summary','context_compaction'].includes(item?.type)));
    // A reference-only item belongs to the old provider store. Preserve its
    // absence explicitly rather than forwarding a foreign id or an invalid item.
    if(Array.isArray(copy.input)) copy.input=copy.input.map((item:any)=>item?.type==='item_reference'
      ? {role:'assistant',content:[{type:'output_text',text:'[Prior account-bound item reference unavailable after account rotation.]'}]}
      : item);
    if(!preserveCurrentAccountFiles && portability.collectConversationStateCarriers(copy).fileIds?.length) throw Error('uploaded_files_cannot_change_account');
    if(Array.isArray(copy.input)) for(const item of copy.input) {if(item && typeof item==='object') delete item.id;}
    portability.scrubUnportableConversationStateInPlace(copy);
    const parsed=official.parseRequest(copy);
    opaque.prepareOpaqueBlobRecovery(parsed);
    const budget=budgets.createTranslatorBudget();
    try {
      const output=await official.createResponsesPassthroughAdapter(provider).buildRequest(parsed,
        {headers:new Headers({'content-type':'application/json'}),providerName:'openai',translatorBudget:budget});
      try {
        const result=JSON.parse(output.body);
        const carriers=portability.collectConversationStateCarriers(result);
        if(carriers.previousResponseId || carriers.providerConversationId || carriers.encryptedReasoning
          || (!preserveCurrentAccountFiles && carriers.fileIds?.length)) throw Error('account_change_scrub_incomplete');
        if(historyNotice && Array.isArray(result.input)) result.input.unshift({role:'developer',content:[{
          type:'input_text',text:'Account rotation removed provider-bound continuation state. Some earlier context may be unavailable. Continue from the readable conversation and available project records; do not invent omitted results or repeat completed actions merely because their context is missing.'
        }]});
        return result;
      } finally {output.releaseBodyObservation?.();}
    }finally{budget.dispose();}
  }

  async function readBody(request: Request): Promise<any> {
    return readExternalRequestJson(request);
  }

  async function dispatch(request: Request, context?:{supplierContext?:Record<string,unknown>;
    originalIssuerDispatch?:(send:()=>Promise<Response>)=>Promise<Response>}): Promise<Response> {
    dispatchProofs.set(request,()=>({dispatchStarted:false,source:'before_supplier'}));
    const budget = budgets.createTranslatorBudget();
    let serialized: any;
    try {
      const body = await readBody(request);
      const compact = new URL(request.url).pathname.endsWith('/responses/compact');
      const parsed = official.parseRequest(body);
      const routed=context?.supplierContext;
      if(routed && (routed.authMode!=='forward' || routed.baseUrl!==provider.baseUrl || routed.adapter!=='openai-responses'
        || routed.apiKey || routed._codexAccountOverride || routed._codexAccountRequired)) throw Error('external_supplier_context_invalid');
      const adapter=official.createResponsesPassthroughAdapter(routed ?? provider);
      // Native compaction keeps its original envelope; the ordinary supplier
      // adapter deliberately builds /responses, not /responses/compact.
      serialized = compact ? {
        url: provider.baseUrl + '/responses/compact', method: 'POST',
        headers: { 'content-type':'application/json',
          ...Object.fromEntries(responses.FORWARD_HEADERS.filter((key:string)=>request.headers.has(key))
            .map((key:string)=>[key,request.headers.get(key)!])) },
        body: JSON.stringify(body),
      } : await adapter.buildRequest(parsed, {
        headers: request.headers, providerName: 'openai', translatorBudget: budget,
        abortSignal: request.signal,
      });
      const target = new URL(serialized.url);
      if (target.origin !== 'https://chatgpt.com' || !['/backend-api/codex/responses','/backend-api/codex/responses/compact'].includes(target.pathname)) {
        throw Error('stock_dispatch_destination_changed');
      }
      // Single physical send. Redirects and provider retries are forbidden here.
      const send=()=>{
        if(request.signal.aborted)throw Error('request_cancelled');
        dispatchProofs.set(request,()=>({dispatchStarted:null,source:'supplier_handoff'}));
        const pending=fetch(target,{method:'POST',headers:serialized.headers,
          body:serialized.body,signal:request.signal,redirect:'error'});
        dispatchProofs.set(request,()=>({dispatchStarted:true,source:'provider_fetch_invoked'}));
        return pending;
      };
      const pending = context?.originalIssuerDispatch ? context.originalIssuerDispatch(send) : send();
      const response = await pending;
      return budgets.finalizeTranslatorBudgetResponse(response,budget);
    } catch {
      budget.dispose();
      throw Error('stock_dispatch_not_completed');
    } finally { serialized?.releaseBodyObservation?.(); }
  }
  return { dispatch, dispatchFull, dispatchEvidence, readBody, resolveRoute, controlPlaneModel, buildCatalog, discovery, scrubAccountChange, parseQuota,
    sendResponseToWebSocket:websocket.sendResponseToWebSocket,
    buildWarmupCompletionFrames:websocket.buildWarmupCompletionFrames,
    markWebsocketRequest:(request:Request)=>websocketRequests.add(request),
    collectCarriers: portability.collectConversationStateCarriers,
    supplier: { name:manifest.name, version:manifest.version, root },
    // Private read-only imports are pinned compatibility dependencies, not
    // evidence that a new supplier release is automatically compatible.
    compatibilityImports: ['src/index.ts','src/lib/translator-budget.ts','src/codex/quota.ts','src/server/responses/account-change-state.ts','src/router.ts','src/adapters/openai-responses.ts','src/server/ws-bridge.ts',
      'src/server/responses/core.ts','src/server/responses/compact.ts','src/lib/request-execution-budget.ts','src/server/request-log.ts',
      'src/codex/catalog/build-entries.ts','src/server/fast-row.ts','src/server/responses/core-opaque-recovery.ts',
      'src/server/search.ts','src/codex/control-plane-models.ts','src/codex/catalog/control-plane.ts'] };
}
