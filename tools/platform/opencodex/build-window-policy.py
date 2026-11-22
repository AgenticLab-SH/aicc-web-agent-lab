"""Build a separate, reproducible OCX software fork; never edit the live package."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import os,base64

UPSTREAM_VERSION='2.76.0'
SOURCE_SHA='4f172a9a4fee53c9814e59bba91d8103e5e251f00025ad29f15269465a640844'
FORK_VERSION='2.76.0-aicc.windows.3'
REVIEWED_UPSTREAM={
 '2.76.0': {'version':FORK_VERSION, 'math':SOURCE_SHA,
   'update':'da41013bf8395c2a4e248e8c65974a5514002980f21c1d3a4d503cd48d638dee',
   'selection':'a8b915fc7a7b69a388ec14a2b17aea38759825c7f7458f37b79b4aa788717fbc',
   'auth':'b57bae637842573d2e7c27c1d578f87ae95f0c55906e4d324d992890eed74794'},
 '2.77.0': {'version':'2.77.0-aicc.windows.1',
   'math':'cb1b4b90fa879561138dabeacab7f2979a1a81a717ad3da708118355bad92684',
   'update':'a8e37c1e2816f1d6082cddb3d21d9d526f395bab78ecdbc1f0073c0375f57eba',
   'selection':'7e664a512d56788f080e8e6998cdbe2c8038d2f5b440c7c7447b4ceae12ef9bf',
   'auth':'2c8242642dd6f23c6a36bf988dd473b96b5e10133028e32857d219bdf3bbc0b4'},
}
INFLIGHT_UPSTREAM={
 'src/server/responses/core.ts':'e988a9700c7a6ac7025673643fef5e7cf4c1ed89fcd8d0e4f5e1e3ec3de88ab3',
 'src/server/responses/core-codex-account.ts':'53602a707e6d7bf7ad5e10f8965266b39e06d56177d3937deb95f40c15f196ec',
 'src/lib/upstream-retry.ts':'9a239b498ce5cc709d45a803c1fb6b0afac3ebf477016d4face8c577b3d57684',
}
RELATIVE='src/codex/routing/cooldown-math.ts'
OLD='''  const values = finite(quota.shortPercent) ? [...knownLong, quota.shortPercent] : knownLong;
  return Math.max(...values);'''
NEW='''  const values = finite(quota.shortPercent) ? [...knownLong, quota.shortPercent] : knownLong;
  const raw = Math.max(...values);
  // AICC fork: preserve unknown, exhaustion and account override behavior. Normalize
  // the two windows against the existing 95-point proactive selection boundary.
  // This environment is set only on the A1 account-owner service, never on Native.
  const policy = process.env.AICC_OCX_WINDOW_THRESHOLDS;
  if (!policy || raw >= 100) return raw;
  const parts = policy.split(",").map(Number);
  if (parts.length !== 2 || parts.some(n => !Number.isInteger(n) || n < 80 || n > 99))
    throw new Error("invalid AICC per-window thresholds; refuse silent policy fallback");
  const [shortThreshold, longThreshold] = parts as [number, number];
  const normalizedLong = knownLong.map(percent => percent * 95 / longThreshold);
  const normalized = finite(quota.shortPercent)
    ? [...normalizedLong, quota.shortPercent * 95 / shortThreshold] : normalizedLong;
  return Math.max(...normalized);'''

def patch(source,version=UPSTREAM_VERSION):
    reviewed=REVIEWED_UPSTREAM.get(version)
    if not reviewed or hashlib.sha256(source).hexdigest()!=reviewed['math']:raise RuntimeError('upstream_source_pin_changed')
    text=source.decode('utf-8')
    if version=='2.77.0':
        old='  const score = Math.max(...values);'
        # Leave upstream paid-credit behavior unchanged outside the strict pool policy.
        # Inside it, raw window limits remain authoritative even with paid credits.
        new=old+'\n'+NEW.split('  const raw = Math.max(...values);',1)[1].replace(
            'if (!policy || raw >= 100) return raw;', 'if (policy) {\n  if (score >= 100) return score;').replace(
            'return Math.max(...normalized);','return Math.max(...normalized);\n  }')
        if text.count(old)!=1:raise RuntimeError('unique_upstream_transform_required')
        text=text.replace(old,new)
        terminal='? (allowCredits && hasSpendableCodexCredits(quota, now)) ? CODEX_EXHAUSTED_USAGE_PERCENT - 1 : CODEX_EXHAUSTED_USAGE_PERCENT'
        if text.count(terminal)!=1:raise RuntimeError('unique_terminal_credit_guard_required')
        return text.replace(terminal,terminal.replace('(allowCredits &&','(!process.env.AICC_OCX_WINDOW_THRESHOLDS && allowCredits &&')).encode('utf-8')
    if text.count(OLD)!=1:raise RuntimeError('unique_upstream_transform_required')
    return text.replace(OLD,NEW).encode('utf-8')

def patch_update(source,version=UPSTREAM_VERSION):
    reviewed=REVIEWED_UPSTREAM.get(version)
    if not reviewed or hashlib.sha256(source).hexdigest()!=reviewed['update']:raise RuntimeError('update_source_pin_changed')
    text=source.decode('utf-8')
    entry='  if (url.pathname === "/api/update/run" && req.method === "POST") {'
    if text.count(entry)!=1:raise RuntimeError('unique_update_guard_required')
    return text.replace(entry,entry+'''\n    if (process.env.AICC_OCX_WINDOW_THRESHOLDS) {
      return jsonResponse({ error: "A1 window policy is active. Use aicc-ocx-update; the reviewed policy must be preserved.", code: "AICC_POLICY_UPDATE_REQUIRED" }, 409);
    }''').encode('utf-8')

def reviewed_patch(source, expected, transformations):
    if hashlib.sha256(source).hexdigest()!=expected:raise RuntimeError('admission_source_pin_changed')
    text=source.decode('utf-8')
    for old,new in transformations:
        if text.count(old)!=1:raise RuntimeError('unique_admission_transform_required')
        text=text.replace(old,new)
    return text.encode('utf-8')

def admission_patches(package,version=UPSTREAM_VERSION):
    reviewed=REVIEWED_UPSTREAM[version]
    selection='src/codex/routing/selection.ts'
    auth='src/codex/auth-context.ts'
    selection_bytes=reviewed_patch((package/selection).read_bytes(),
      reviewed['selection'],[
        ('import { getEffectiveCodexAutoSwitchThreshold }', 'import { aiccAccountAdmission } from "./aicc-window-admission";\nimport { getEffectiveCodexAutoSwitchThreshold }'),
        ('  return !isCodexAccountPaused(config, accountId)', '  return aiccAccountAdmission(accountId, now).allowed\n    && !isCodexAccountPaused(config, accountId)'),
        ('  if (isCodexAccountPaused(config, accountId)) return "paused";', '  if (!aiccAccountAdmission(accountId, now).allowed) return "quota_headroom";\n  if (isCodexAccountPaused(config, accountId)) return "paused";'),
        ('      && account.id !== excludeId', '      && account.id !== excludeId\n      && aiccAccountAdmission(account.id, now).allowed'),
        ('    excludeId !== MAIN_CODEX_ACCOUNT_ID', '    excludeId !== MAIN_CODEX_ACCOUNT_ID\n    && aiccAccountAdmission(MAIN_CODEX_ACCOUNT_ID, now).allowed'),
    ])
    auth_bytes=reviewed_patch((package/auth).read_bytes(),
      reviewed['auth'],[
        ('import { noteMainAccountActivity }', 'import { aiccWindowPolicyEnabled, aiccAccountAdmission, aiccQuotaAdmission, noteAiccAdmissionObservation } from "./routing/aicc-window-admission";\nimport { noteMainAccountActivity }'),
        ('    const substituteStoredMain = options.substituteMainCredentialForDirect === true;', '''    if (mode === "pool" && aiccWindowPolicyEnabled()) {
      const refusal = new CodexAccountCooldownError(MAIN_CODEX_ACCOUNT_ID, Date.now() + 60_000);
      refusal.message = "A1 OCX pool admission blocked: no verified pool account; caller-credential fallback is disabled.";
      throw refusal;
    }
    const substituteStoredMain = options.substituteMainCredentialForDirect === true;'''),
        ('  if (preserveRequestOwnedMainPin()) {', '  if (preserveRequestOwnedMainPin() && !aiccWindowPolicyEnabled()) {'),
        ('    if (!selected) {', '''    if (!selected) {
      if (aiccWindowPolicyEnabled()) {
        const refusal = new CodexAccountCooldownError(fixedAccountId ?? MAIN_CODEX_ACCOUNT_ID, Date.now() + 60_000);
        refusal.message = "A1 OCX pool admission blocked: no eligible account with fresh quota below 95/98.";
        throw refusal;
      }'''),
        ('  try {\n    const excludeAccountIds = nativeMainReadsForbidden', '''  try {
    if (aiccWindowPolicyEnabled()) {
      // Await exact fresh WHAM evidence before selection. The official helper joins
      // concurrent requests and fences credential generations. Failed refreshes may
      // return cached quota; freshQuota is deliberately required here.
      const { fetchPoolAccountQuota } = await import("./auth-api/pool-quota-probe");
      await Promise.all((config.codexAccounts ?? []).map(async account => {
        try {
          const result = await fetchPoolAccountQuota(account.id, true, account.plan);
          noteAiccAdmissionObservation(account.id, result.freshQuota !== undefined
            && aiccQuotaAdmission({ ...result.freshQuota, updatedAt: Date.now() }, Date.now()).reason !== "quota_incomplete"
            && result.freshCredentialGeneration !== undefined
            && isCodexAccountGenerationLive(account.id, result.freshCredentialGeneration)
            && !result.needsReauth);
        } catch { noteAiccAdmissionObservation(account.id, false); }
      }));
    }
    const excludeAccountIds = nativeMainReadsForbidden'''),
        ('  // Lazy prime: if the selected account has no quota yet,', '''  const windowAdmission = aiccAccountAdmission(accountId);
  if (!windowAdmission.allowed) {
    releaseTransientProbeGrant();
    const refusal = new CodexAccountCooldownError(accountId, windowAdmission.retryAt, "reset-derived", quotaScope);
    refusal.message = "A1 OCX pool admission blocked: " + windowAdmission.reason + " (5h >=95%, weekly/monthly >=98%; fresh quota required).";
    throw refusal;
  }
  // Lazy prime: if the selected account has no quota yet,'''),
    ])
    template=base64.b64decode(os.environ['AICC_POLICY_ADMISSION']) if os.environ.get('AICC_POLICY_ADMISSION') else Path(__file__).with_name('window-admission.ts').read_bytes()
    if hashlib.sha256(template).hexdigest()!='6aa03fbb546eb1e37d1efa78ce8564eb4b28dbb7de4841f41b8d0ec3f7271c6c':raise RuntimeError('admission_template_pin_changed')
    return {selection:selection_bytes,auth:auth_bytes,'src/codex/routing/aicc-window-admission.ts':template}

def inflight_patches(package):
    # Only the pinned 2.77 ingress is supported. Keep account selection, credential
    # storage and upstream cancellation semantics with their existing owners.
    core='src/server/responses/core.ts'
    observer='src/server/responses/core-codex-account.ts'
    retry='src/lib/upstream-retry.ts'
    patches={core:reviewed_patch((package/core).read_bytes(),INFLIGHT_UPSTREAM[core],[
      ('import { runWithCompactionRecovery } from "./compaction-recovery";', '''import { runWithCompactionRecovery } from "./compaction-recovery";
import { aiccWindowPolicyEnabled } from "../../codex/routing/aicc-window-admission";
import { createAiccInflightRequestGuard } from "../../codex/routing/aicc-inflight-runtime";
import { finalizeAiccInflightResponse, aiccInflightCutoffResponse } from "./aicc-inflight-response";'''),
      ('  const abortSignal = options.abortSignal ?? req.signal;', '''  const originalAbortSignal = options.abortSignal ?? req.signal;
  const aiccGuard = aiccWindowPolicyEnabled() ? createAiccInflightRequestGuard(originalAbortSignal) : undefined;
  const abortSignal = aiccGuard?.signal ?? originalAbortSignal;'''),
      ('  function release() { accountLoad.lease?.release(); accountLoad.lease = null; abortSignal.removeEventListener("abort", cancel); }',
       '  function release() { accountLoad.lease?.release(); accountLoad.lease = null; abortSignal.removeEventListener("abort", cancel); aiccGuard?.dispose(); }'),
      ('      ...options,', '''      ...options,
      abortSignal,
      onCodexAuthContextResolved: context => {
        aiccGuard?.bind(context);
        options.onCodexAuthContextResolved?.(context);
      },'''),
      ('    if (!accountLoad.lease) { release(); return finalResponse; }', '''    if (aiccGuard) return finalizeAiccInflightResponse(finalResponse, aiccGuard, release);
    if (!accountLoad.lease) { release(); return finalResponse; }'''),
      ('    if (ownsBudget) translatorBudget.dispose();\n    throw error;', '''    if (ownsBudget) translatorBudget.dispose();
    const cutoff = aiccGuard?.cutoff();
    if (cutoff) return aiccInflightCutoffResponse(cutoff);
    throw error;'''),
    ]),observer:reviewed_patch((package/observer).read_bytes(),INFLIGHT_UPSTREAM[observer],[
      ('import { isCodexAccountGenerationLive } from "../../codex/account-store";', '''import { isCodexAccountGenerationLive, isPoolQuotaWriterLive } from "../../codex/account-store";
import { parseUpstreamQuotaHeaders } from "../../codex/quota";
import { observeAiccInflightQuota } from "../../codex/routing/aicc-inflight-runtime";'''),
      ('''    applyCapturedCodexQuota(accountId, headers, writerGeneration, mainWriter, { modelId, poolWriter: authCtx.kind === "pool" ? authCtx.poolQuotaWriter : undefined,
      poolResponse: authCtx.kind === "pool" });''', '''    applyCapturedCodexQuota(accountId, headers, writerGeneration, mainWriter, { modelId, poolWriter: authCtx.kind === "pool" ? authCtx.poolQuotaWriter : undefined,
      poolResponse: authCtx.kind === "pool" });
    if (authCtx.kind === "pool" && authCtx.poolQuotaWriter && isPoolQuotaWriterLive(authCtx.poolQuotaWriter)) {
      const quota = parseUpstreamQuotaHeaders(headers, { modelId });
      if (quota) observeAiccInflightQuota(accountId, authCtx.generation, { ...quota, updatedAt: Date.now() });
    }'''),
    ]),retry:reviewed_patch((package/retry).read_bytes(),INFLIGHT_UPSTREAM[retry],[
      ('  UPSTREAM_RESET_REPLAY_REFUSED_CODE,\n]);', '  UPSTREAM_RESET_REPLAY_REFUSED_CODE,\n  "aicc_window_inflight_cutoff",\n]);'),
      ('  return code === UPSTREAM_RESET_REPLAY_REFUSED_CODE;', '  return code === UPSTREAM_RESET_REPLAY_REFUSED_CODE || code === "aicc_window_inflight_cutoff";'),
    ])}
    for environment,local,relative in [
      ('AICC_POLICY_INFLIGHT_MONITOR','window-inflight-monitor.ts','src/codex/routing/aicc-inflight-monitor.ts'),
      ('AICC_POLICY_INFLIGHT_RUNTIME','window-inflight-runtime.ts','src/codex/routing/aicc-inflight-runtime.ts'),
      ('AICC_POLICY_INFLIGHT_RESPONSE','window-inflight-response.ts','src/server/responses/aicc-inflight-response.ts')]:
        patches[relative]=base64.b64decode(os.environ[environment]) if os.environ.get(environment) else Path(__file__).with_name(local).read_bytes()
    return patches

def build(source_root,output_root,dynamic_policy=False,inflight_policy=False):
    inflight_policy=inflight_policy or os.environ.get('AICC_OCX_INFLIGHT_POLICY')=='1'
    dynamic_policy=dynamic_policy or inflight_policy
    dynamic_policy=dynamic_policy or os.environ.get('AICC_OCX_DYNAMIC_POLICY')=='1'
    source_root=Path(source_root).absolute();output_root=Path(output_root).absolute()
    if source_root.is_symlink() or source_root.parts[-3:]!=('.bun','install','global'):raise RuntimeError('stock_bun_global_required')
    if output_root.exists() or output_root.is_relative_to(source_root) or source_root.is_relative_to(output_root):raise RuntimeError('fresh_separate_output_required')
    package=source_root/'node_modules/@bitkyc08/opencodex'
    info=json.loads((package/'package.json').read_text(encoding='utf-8'))
    upstream_version=info.get('version')
    if upstream_version not in REVIEWED_UPSTREAM:raise RuntimeError('exact_reviewed_upstream_version_required')
    transformed=patch((package/RELATIVE).read_bytes(),upstream_version)
    update_relative='src/server/management/config-routes.ts'
    update_bytes=(package/update_relative).read_bytes()
    update_transformed=patch_update(update_bytes,upstream_version)
    admission=admission_patches(package,upstream_version)
    if dynamic_policy:
        if upstream_version!='2.77.0':raise RuntimeError('dynamic_policy_requires_277')
        settings=base64.b64decode(os.environ['AICC_POLICY_SETTINGS']) if os.environ.get('AICC_POLICY_SETTINGS') else Path(__file__).with_name('window-policy-settings.ts').read_bytes()
        admission['src/codex/routing/aicc-window-settings.ts']=settings
        admission['src/codex/routing/aicc-window-admission.ts']=base64.b64decode(os.environ['AICC_POLICY_ADMISSION_V2']) if os.environ.get('AICC_POLICY_ADMISSION_V2') else Path(__file__).with_name('window-admission-v2.ts').read_bytes()
        math=transformed.decode('utf-8')
        math='import {readAiccWindowSettings} from "./aicc-window-settings";\n'+math
        math=math.replace('const parts = policy.split(",").map(Number);','const configured = readAiccWindowSettings();\n  const parts = [configured.fiveHour.usedThreshold, configured.longWindow.usedThreshold];')
        math=math.replace('n < 80 || n > 99','n < 1 || n > 100')
        transformed=math.encode('utf-8')
        auth_key='src/codex/auth-context.ts'
        auth=admission[auth_key].decode('utf-8')
        auth=auth.replace('aiccWindowPolicyEnabled, aiccAccountAdmission,','aiccWindowPolicyEnabled, aiccStopPolicyAdmission, aiccAccountAdmission,',1)
        anchor='  const writerGeneration = captureConfigGeneration();'
        if auth.count(anchor)!=1:raise RuntimeError('request_scope_config_anchor_changed')
        auth=auth.replace(anchor,'  const aiccOriginalPolicyAccount = mode === "pool" && aiccWindowPolicyEnabled() ? config.activeCodexAccountId : undefined;\n'+anchor,1)
        auth=auth.replace('    const excludeAccountIds = nativeMainReadsForbidden','    const stopPolicy = aiccStopPolicyAdmission(aiccOriginalPolicyAccount);\n    if (!stopPolicy.allowed) {\n      const refusal = new CodexAccountCooldownError(aiccOriginalPolicyAccount ?? MAIN_CODEX_ACCOUNT_ID, stopPolicy.retryAt);\n      refusal.message = "AICC window policy stopped new pool requests: " + stopPolicy.reason;\n      throw refusal;\n    }\n    const excludeAccountIds = nativeMainReadsForbidden',1)
        admission[auth_key]=auth.encode('utf-8')
    if inflight_policy:
        if upstream_version!='2.77.0' or not dynamic_policy:raise RuntimeError('inflight_requires_dynamic_277')
        admission.update(inflight_patches(package))
    shutil.copytree(source_root,output_root,symlinks=True)
    target=output_root/'node_modules/@bitkyc08/opencodex'
    (target/RELATIVE).write_bytes(transformed)
    (target/update_relative).write_bytes(update_transformed)
    for relative,content in admission.items():(target/relative).write_bytes(content)
    info['version']='2.77.0-aicc.windows.3' if inflight_policy else ('2.77.0-aicc.windows.2' if dynamic_policy else REVIEWED_UPSTREAM[upstream_version]['version'])
    (target/'package.json').write_text(json.dumps(info,indent=2)+'\n',encoding='utf-8')
    if dynamic_policy:
        manifest={'schemaVersion':1,'version':info['version'],'dynamicSettings':True,'inflightProtection':inflight_policy,
          'policySourceSha256':hashlib.sha256(transformed).hexdigest(),
          'updateSourceSha256':hashlib.sha256(update_transformed).hexdigest(),
          'admissionSourceSha256':{relative:hashlib.sha256(content).hexdigest() for relative,content in admission.items()}}
        (target/'aicc-policy-manifest.json').write_text(json.dumps(manifest,sort_keys=True)+'\n',encoding='utf-8')
    receipt={'schemaVersion':1,'upstreamVersion':upstream_version,'version':info['version'],'dynamicSettings':dynamic_policy,'inflightProtection':inflight_policy,
      'upstreamSourceSha256':REVIEWED_UPSTREAM[upstream_version]['math'],'policySourceSha256':hashlib.sha256(transformed).hexdigest(),
      'policyEnv':'AICC_OCX_WINDOW_THRESHOLDS','defaultPolicy':'95,98','selectionBoundary':95,
      'policyManifestSha256':hashlib.sha256((target/'aicc-policy-manifest.json').read_bytes()).hexdigest() if dynamic_policy else None,
      'scope':'software-only','originalPackageChanged':False,'accountHomesIncluded':False,
      'changedFiles':[RELATIVE,update_relative,*admission,'package.json'],
      'admissionSourceSha256':{relative:hashlib.sha256(content).hexdigest() for relative,content in admission.items()},
      'strictAdmission':True,'freshQuotaRequired':True,'quotaFreshnessMs':60000,
      'inflightPollMs':5000 if inflight_policy else None,'inflightFreshnessMs':15000 if inflight_policy else None,
      'inflightReplay':'never' if inflight_policy else None,
      'updateSourceSha256':hashlib.sha256(update_transformed).hexdigest()}
    (output_root/'aicc-window-policy.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    return receipt

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args();print(json.dumps(build(args.source,args.output)))

if __name__=='__main__':main()
