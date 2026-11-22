"""Prepare the existing OCX pipeline for local execution and A1-owned credentials."""
import hashlib, importlib.util, json, os, pathlib, sys

HERE=pathlib.Path(__file__).parent
PINS={
 'src/codex/account-store.ts':'5ff40b2960a690ba95e8c6789de47c709ea5940dd1d4d9c11106bcb2d661c8b5',
 'src/server/index.ts':'4dccb67ff39abf761c72a449819c7d04bdbab0ebd7ff59db6547a4d0ab0c3fed',
 'src/codex/auth-api/routes.ts':'e1cf949c54f9c63141b5a5316d7f5cc9e14a23df45d03ac5ac0898eead022466',
 'src/server/index/serve-options.ts':'c19e839c8c67c43524f60cc12bc4fe71b52e7b27d66e829a754f9c7f91f33e4e',
 'src/server/responses/compact.ts':'2a4c065ce18b3dfe24ee085df8abab976a8f1fb5e26cd01267d98fb18d60c9ca',
}
def replace(text,before,after):
    if text.count(before)!=1:raise RuntimeError('local_patch_anchor_changed')
    return text.replace(before,after,1)
def main(source,output):
    source=pathlib.Path(source);output=pathlib.Path(output)
    original=source/'node_modules/@bitkyc08/opencodex'
    for relative,digest in PINS.items():
        if hashlib.sha256((original/relative).read_bytes()).hexdigest()!=digest:raise RuntimeError('local_upstream_pin_changed')
    spec=importlib.util.spec_from_file_location('window_builder',HERE/'build-window-policy.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.build(source,output,dynamic_policy=True,inflight_policy=True)
    package=output/'node_modules/@bitkyc08/opencodex'
    store=(package/'src/codex/account-store.ts').read_text(encoding='utf8')
    store='import {remoteMode,remoteRecords,persistRemoteRecords,remoteToken} from "../aicc-local-auth";\n'+store
    store=replace(store,'function loadCodexAccountRecordStore(): CodexAccountStore {','function loadCodexAccountRecordStore(): CodexAccountStore {\n  if(remoteMode()) return remoteRecords();')
    store=replace(store,'function persist(store: CodexAccountStore): void {','function persist(store: CodexAccountStore): void {\n  if(remoteMode()){persistRemoteRecords(store);return;}')
    store=replace(store,'): Promise<CodexTokenResult & { rotated: boolean; selfRefreshed: boolean; provenance: CodexRefreshProvenance }> {','''): Promise<CodexTokenResult & { rotated: boolean; selfRefreshed: boolean; provenance: CodexRefreshProvenance }> {
  if(remoteMode()){
    try{const result=await remoteToken(id,options);try{void Promise.resolve(options.onSettled?.({kind:"resolved",provenance:"external-replacement",generation:result.generation,rotated:result.rotated})).catch(()=>{});}catch{}return result;}
    catch(error){try{void Promise.resolve(options.onSettled?.({kind:"failed",error})).catch(()=>{});}catch{}throw error;}
  }''')
    store=replace(store,'): Promise<CodexTokenResult> {','): Promise<CodexTokenResult> {\n  if(remoteMode()) return remoteToken(id,options);')
    (package/'src/codex/account-store.ts').write_text(store,encoding='utf8')
    server=(package/'src/server/index.ts').read_text(encoding='utf8')
    server='import {remoteMode,bindRemoteConfig} from "../aicc-local-auth";\n'+server
    server=replace(server,'  warnPlaintextV2AgentMessagesStartup(config);','  if(remoteMode()) bindRemoteConfig(config);\n  warnPlaintextV2AgentMessagesStartup(config);')
    server=replace(server,'  const loopbackListenerPort = effectiveLoopbackListenerPort(config, listenPort);','  const loopbackListenerPort = remoteMode() && process.env.AICC_OCX_COMPAT_PORT === "10101" ? 10101 : effectiveLoopbackListenerPort(config, listenPort);')
    server=replace(server,'    if (requestServer === loopbackServer) return "unauthenticated-loopback";','    if (requestServer === loopbackServer) return remoteMode() ? "public" : "unauthenticated-loopback";')
    server=replace(server,'  if (loopbackServer) {','  if (loopbackServer && !remoteMode()) {')
    (package/'src/server/index.ts').write_text(server,encoding='utf8')
    core=(package/'src/server/responses/core.ts').read_text(encoding='utf8')
    core='import {remoteMode,refreshRemoteSnapshot} from "../../aicc-local-auth";\n'+core
    core=replace(core,'  const ownsBudget = options.translatorBudget === undefined;','  if(remoteMode()) await refreshRemoteSnapshot();\n  const ownsBudget = options.translatorBudget === undefined;')
    core=replace(core,'  const abortSignal = aiccGuard?.signal ?? originalAbortSignal;','  const abortSignal = aiccGuard?.signal ?? originalAbortSignal;\n  if(aiccGuard) req=new Request(req,{signal:abortSignal});')
    (package/'src/server/responses/core.ts').write_text(core,encoding='utf8')
    compact=(package/'src/server/responses/compact.ts').read_text(encoding='utf8')
    compact='''import {remoteMode,refreshRemoteSnapshot} from "../../aicc-local-auth";
import {createAiccInflightRequestGuard} from "../../codex/routing/aicc-inflight-runtime";
import {finalizeAiccInflightResponse,aiccInflightCutoffResponse} from "./aicc-inflight-response";
const aiccCompactGuards=new WeakMap<Request,ReturnType<typeof createAiccInflightRequestGuard>>();
export async function handleResponsesCompact(req:Request,config:OcxConfig,logCtx:RequestLogContext,turnAdmissionLease?:AdmissionLease,admission?:DataPlaneAdmission,options:HandleResponsesCompactOptions={}){
  if(!remoteMode())return handleResponsesCompactInner(req,config,logCtx,turnAdmissionLease,admission,options);
  await refreshRemoteSnapshot();
  const guard=createAiccInflightRequestGuard(req.signal);
  const guarded=new Request(req,{signal:guard.signal});
  aiccCompactGuards.set(guarded,guard);
  const release=()=>{guard.dispose();aiccCompactGuards.delete(guarded);};
  try{return finalizeAiccInflightResponse(await handleResponsesCompactInner(guarded,config,logCtx,turnAdmissionLease,admission,options),guard,release);}
  catch(error){release();const cutoff=guard.cutoff();if(cutoff)return aiccInflightCutoffResponse(cutoff);throw error;}
}
'''+compact
    compact=replace(compact,'export async function handleResponsesCompact(\n','async function handleResponsesCompactInner(\n')
    anchor='        logCtx.accountLogLabel = codexAuthContextLogLabel(authCtx, config);'
    if compact.count(anchor)<1:raise RuntimeError('compact_auth_anchor_changed')
    compact=compact.replace(anchor,'        aiccCompactGuards.get(req)?.bind(authCtx);\n'+anchor)
    (package/'src/server/responses/compact.ts').write_text(compact,encoding='utf8')
    routes=(package/'src/codex/auth-api/routes.ts').read_text(encoding='utf8')
    routes='import {remoteMode} from "../../aicc-local-auth";\n'+routes
    routes=replace(routes,'): Promise<Response | null> {','): Promise<Response | null> {\n  if(remoteMode() && req.method!=="GET") return jsonResponse({error:"Use the AICC tray; A1 owns login and account preferences."},403);')
    (package/'src/codex/auth-api/routes.ts').write_text(routes,encoding='utf8')
    serve=(package/'src/server/index/serve-options.ts').read_text(encoding='utf8')
    serve='import {timingSafeEqual as aiccEqual} from "node:crypto";\nimport {remoteMode,refreshRemoteSnapshot} from "../../aicc-local-auth";\n'+serve
    # Authenticate both loopback entry points without widening the bind address.
    serve=replace(serve,'      const requestUrl = codexCompatibleUrl(req.url);','''      const requestUrl = codexCompatibleUrl(req.url);
      if(remoteMode() && requestUrl.pathname.startsWith("/v1/")){
        const expected=Buffer.from("Bearer "+(process.env.OPENCODEX_API_AUTH_TOKEN??""));
        const received=Buffer.from(req.headers.get("authorization")??"");
        if(!process.env.OPENCODEX_API_AUTH_TOKEN || received.length!==expected.length || !aiccEqual(received,expected))return Response.json({error:{code:"authentication_error",message:"Local OCX data credential required"}},{status:401});
      }''')
    serve=replace(serve,'        if (apiAuthError) return withManagementCors(apiAuthError, req, config);','''        if (apiAuthError) return withManagementCors(apiAuthError, req, config);
        if(remoteMode() && url.pathname==="/api/aicc-local/sync" && req.method==="POST"){
          await refreshRemoteSnapshot(true);
          if(req.headers.get("x-aicc-local-use")==="1" && typeof config.activeCodexAccountPinned==="string"){
            config.activeCodexAccountId=config.activeCodexAccountPinned;
            const routing=await import("../../codex/routing");
            routing.resetCodexRoutingForManualSelection(config.activeCodexAccountPinned);
            const storage=await import("../../config");
            storage.saveConfigPreservingClaudeCode(config);
          }
          return withManagementCors(Response.json({ok:true,requestExecution:"windows-local",credentialWriter:"a1"}),req,config);
        }''')
    (package/'src/server/index/serve-options.ts').write_text(serve,encoding='utf8')
    (package/'src/aicc-local-auth.ts').write_bytes((HERE/'local-credential-runtime.ts').read_bytes())
    (package/'aicc-local-bootstrap.ts').write_bytes((HERE/'local-bootstrap.ts').read_bytes())
    info=json.loads((package/'package.json').read_text());info['version']='2.77.0-aicc.local.3'
    (package/'package.json').write_text(json.dumps(info,indent=2)+'\n')
    manifest=json.loads((package/'aicc-policy-manifest.json').read_text())
    manifest.update(version=info['version'],requestExecution='windows-local',credentialWriter='a1')
    manifest['admissionSourceSha256']={relative:hashlib.sha256((package/relative).read_bytes()).hexdigest() for relative in manifest['admissionSourceSha256']}
    changed=[*PINS,'src/server/responses/core.ts','src/aicc-local-auth.ts','aicc-local-bootstrap.ts']
    manifest['localSourceSha256']={relative:hashlib.sha256((package/relative).read_bytes()).hexdigest() for relative in changed}
    (package/'aicc-policy-manifest.json').write_text(json.dumps(manifest,sort_keys=True)+'\n')
    print(json.dumps({'version':info['version'],'package':str(package),'manifestSha256':hashlib.sha256((package/'aicc-policy-manifest.json').read_bytes()).hexdigest(),'credentialWriter':'a1','requestExecution':'windows-local'}))
if __name__=='__main__': main(*sys.argv[1:])
