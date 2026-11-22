import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function regular(file) {
  for(let cursor=path.resolve(file);;cursor=path.dirname(cursor)) {
    if(fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`linked_health_path:${cursor}`);
    if(path.dirname(cursor)===cursor) break;
  }
  if(!fs.statSync(file).isFile()) throw new Error('health_file_required');
}
function run(command,args,timeout=120000) {
  return new Promise(resolve=>{
    const env={...process.env};
    // A PowerShell 7 caller must not poison Windows PowerShell's module resolution.
    if(/powershell\.exe$/i.test(command)) for(const key of Object.keys(env)) if(key.toLowerCase()==='psmodulepath') delete env[key];
    const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env});
    let stdout='',stderr='',settled=false;
    const timer=setTimeout(()=>child.kill(),timeout);
    child.stdout.on('data',data=>{if(stdout.length<4000000)stdout+=data.toString()});
    child.stderr.on('data',data=>{if(stderr.length<20000)stderr+=data.toString()});
    const finish=(code,error)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({code,stdout,stderr,error});};
    child.on('error',error=>finish(null,error.code));child.on('close',code=>finish(code,null));
  });
}
function json(result) {if(result.error)throw new Error('health_probe_spawn_failed');try{return JSON.parse(result.stdout.replace(/^\uFEFF/,''))}catch{throw new Error('health_probe_invalid_json')}}
// Admit the relocated gateway only through its exact owner registry and immutable hashes.
export function readPinnedGatewayConfig(home,node,gateway,config) {
  const release=path.dirname(gateway), expectedParent=path.join(home,'.codex-chatgpt-web/unified-mcp/releases');
  const legacy=path.dirname(release)===expectedParent&&/^[a-f0-9]{64}$/.test(path.basename(release));
  let registered=false;
  if(path.dirname(release)===path.join(home,'.ai-control-center/releases/unified-mcp')) {
    const registryFile=path.join(home,'.ai-control-center/runtime/components.json');regular(registryFile);
    const registry=JSON.parse(fs.readFileSync(registryFile,'utf8'));
    const component=registry.components?.['unified-mcp'];
    registered=registry.schemaVersion===1&&registry.root===path.join(home,'.ai-control-center')&&
      component?.location==='managed'&&component.entry===gateway&&component.releaseRoot===release&&
      component.runtime===node&&/^[a-f0-9]{64}$/.test(component.entryHash??'');
    if(registered){regular(gateway);registered=digest(gateway)===component.entryHash;}
  }
  if((!legacy&&!registered)||config!==path.join(release,'config.json')||gateway!==path.join(release,'gateway.cjs'))throw new Error('unowned_gateway_refused');
  const manifestFile=path.join(release,'manifest.json');for(const file of [manifestFile,gateway,config,node])regular(file);
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.releaseHash!==path.basename(release)||manifest.files?.['gateway.cjs']!==digest(gateway)||manifest.files?.['config.json']!==digest(config))throw new Error('gateway_integrity_changed');
  const cfg=JSON.parse(fs.readFileSync(config,'utf8'));
  if(!Array.isArray(cfg.providers)||cfg.providers.length!==2)throw new Error('provider_pair_changed');
  for(const provider of cfg.providers)for(const file of provider.files){regular(file.path);if(digest(file.path)!==file.sha256)throw new Error('provider_integrity_changed');}
  return cfg;
}
function pinnedWorkspace(home) {
  const profile=path.join(home,'.ai-control-center/workspace-mcp/tunnel/profiles/aicc-workspace.yaml');
  regular(profile);
  const text=fs.readFileSync(profile,'utf8');
  const matches=[...text.matchAll(/^      command: (.+)$/gm)];
  if(matches.length!==1)throw new Error('exact_workspace_command_required');
  const command=JSON.parse(matches[0][1]);
  const match=/^"([^"]+)" "([^"]+)" --config "([^"]+)"$/.exec(command);
  if(!match)throw new Error('managed_gateway_required');
  const [node,gateway,config]=match.slice(1).map(value=>path.resolve(value));
  const cfg=readPinnedGatewayConfig(home,node,gateway,config);
  const ws=cfg.providers.find(provider=>provider.id==='workspace');
  const cli=path.join(path.dirname(path.dirname(path.dirname(ws.entrypoint))),'bin/aicc');regular(cli);
  return {node:ws.command,cli,toolCount:cfg.providers.reduce((sum,p)=>sum+p.toolNames.length,0),profileSha256:digest(profile)};
}
export function repairPlan(status,{background=false,forceSandbox=false}={}) {
  const plan=[];
  if(status.native.install!=='ok'||status.native.provider!=='openai'||(status.route&&status.route.mode!=='native'))return {allowed:false,reason:'preserve_native_route',actions:[]};
  if(forceSandbox||status.sandbox.provisioning!=='complete'||(status.sandbox.readiness&&status.sandbox.readiness!=='ready'))plan.push(background?'sandbox_requires_foreground':'official_sandbox_setup');
  if(status.workspace.state!=='ready') {
    if(status.workspace.taskOwned!==true||status.workspace.canStart!==true||status.workspace.activeLeases!==0)return {allowed:false,reason:'workspace_owner_or_idle_unknown',actions:plan};
    plan.push('repair_owned_workspace_task');
  }
  return {allowed:true,actions:plan,ocxAction:'none',historyAction:'none',defenderAction:'none'};
}
export function repairActionStatus(result) {
  if(result.code===0)return 'DISPATCHED';
  return /\borchestrator_elevation_required\b/.test(String(result.stderr??'')+String(result.stdout??''))?'NEEDS_FOREGROUND':'FAILED';
}
export function configuredHealthRoute(text,provider) {
  const top=String(text).replace(/^\uFEFF/,'').split(/^\s*\[/m)[0];
  const baseUrl=/^\s*openai_base_url\s*=\s*["']([^"']+)["']\s*$/m.exec(top)?.[1]??null;
  const mode=/^http:\/\/(?:127\.0\.0\.1|localhost):17841\/v1\/?$/.test(baseUrl??'')?'integrated-local':
    /^http:\/\/(?:127\.0\.0\.1|localhost):10100\/v1\/?$/.test(baseUrl??'')?'ocx':
    baseUrl===null&&provider==='openai'?'native':'custom';
  return {mode,configuredBaseUrl:baseUrl,source:'config-only',threadRouteVerified:false};
}
export async function windowsHealthDoctor(options={}) {
  if((options.platform??process.platform)!=='win32')throw new Error('windows_health_only');
  const home=options.home??os.homedir(), executable=path.join(home,'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe');
  // The official standalone updater owns a bin junction; admit only its release target.
  const nativeTarget=fs.realpathSync(executable);
  const releaseParent=path.join(home,'.codex/packages/standalone/releases');
  if(!nativeTarget.startsWith(releaseParent+path.sep)||path.basename(nativeTarget)!=='codex.exe')throw new Error('standalone_release_target_required');
  regular(nativeTarget);
  const doctor=json(await run(executable,['doctor','--json'],180000));
  const checks=doctor.checks;
  const workspace=pinnedWorkspace(home);
  const ws=json(await run(workspace.node,[workspace.cli,'workspace','status','--json'],30000));
  const task=json(await run(process.execPath,[path.join(root,'tools/platform/workspace-mcp/install-windows-task.mjs'),'status','--surface','business-full'],45000));
  const nativeConfig=path.join(home,'.codex/config.toml');regular(nativeConfig);
  const sandbox=checks['sandbox.helpers'];
  const readiness=json(await run(process.execPath,[path.join(root,'tools/platform/codex/probe-windows-sandbox-readiness.mjs')],35000));
  const hookReport=json(await run(process.execPath,[path.join(root,'tools/platform/codex/probe-native-hooks.mjs')],35000));
  const hooks=hookReport.data.flatMap(item=>item.hooks).filter(hook=>hook.command.includes('notification-ack-hook.mjs'));
  const provider=checks['config.load'].details['model provider'];
  const route=configuredHealthRoute(fs.readFileSync(nativeConfig,'utf8'),provider);
  return {schemaVersion:1,observedAt:new Date().toISOString(),mode:route.mode,route,
    native:{executable,install:checks.installation.status,version:checks['runtime.provenance'].details.version??checks['updates.status'].details['cached latest version'],provider:checks['config.load'].details['model provider'],auth:checks['auth.credentials'].status,http:checks['network.provider_reachability'].status,websocket:checks['network.websocket_reachability'].status,configSha256:digest(nativeConfig)},
    sandbox:{backend:sandbox.details['sandbox backend'],provisioning:sandbox.details['sandbox provisioning'],readiness:readiness.readiness.status,status:readiness.readiness.status==='ready'?sandbox.status:'attention'},
    hooks:{configured:hooks.length,enabled:hooks.filter(hook=>hook.enabled).length,trust:hooks.map(hook=>hook.trustStatus),errors:hookReport.data.reduce((sum,item)=>sum+(item.errors?.length??0),0)},
    workspace:{state:ws.state,serverReady:ws.serverReady,tunnelReady:ws.tunnel?.ready,activeLeases:ws.remoteAuthority?.activeLeases,toolCount:workspace.toolCount,taskOwned:task.owned,taskState:task.taskState,sourceMatches:task.sourceMatches,canStart:task.prerequisites?.canStart,profileSha256:workspace.profileSha256},
    ocx:{optional:true,automaticStart:false,accountsAndHistoryPreserved:true},
    warnings:Object.values(checks).filter(check=>check.status!=='ok').map(check=>({id:check.id,status:check.status,summary:check.summary})),
    noMutation:true};
}
export async function windowsHealthRepair(options={}) {
  const before=await windowsHealthDoctor(options),plan=repairPlan(before,options),actions=[];
  if(plan.allowed)for(const action of plan.actions){
    if(action==='sandbox_requires_foreground'){actions.push({action,status:'NEEDS_FOREGROUND'});continue;}
    const result=action==='official_sandbox_setup'
      ?await run(before.native.executable,['sandbox','setup','--elevated','--current-user'],180000)
      :await run(process.execPath,[path.join(root,'tools/platform/workspace-mcp/install-windows-task.mjs'),'repair','--surface','business-full'],90000);
    actions.push({action,status:repairActionStatus(result),exitCode:result.code});
    if(result.code!==0)break;
  }
  if(actions.some(item=>item.status==='DISPATCHED'))await new Promise(resolve=>setTimeout(resolve,3000));
  const after=actions.length?await windowsHealthDoctor(options):before;
  const ok=plan.allowed&&after.sandbox.provisioning==='complete'&&after.sandbox.readiness==='ready'&&after.workspace.state==='ready'&&after.native.auth==='ok'&&after.native.websocket==='ok'&&before.native.configSha256===after.native.configSha256;
  return {schemaVersion:1,ok,terminal:ok?'PASS':'HOLD',plan,actions,before,after,nativeConfigUnchanged:before.native.configSha256===after.native.configSha256,ocxStarted:false,historyModified:false};
}
export function printWindowsHealth(report,jsonOutput=false) {
  if(jsonOutput){console.log(JSON.stringify(report,null,2));return;}
  const current=report.after??report;
  console.log(`Codex CLI (${current.mode}): ${current.native.version} · ${current.native.provider} · 인증 ${current.native.auth} · 연결 ${current.native.websocket}`);
  console.log(`Windows sandbox: ${current.sandbox.backend} · ${current.sandbox.provisioning} · ${current.sandbox.readiness}`);
  console.log(`AICC hook: ${current.hooks?.enabled??0}개 활성 · ${current.hooks?.trust?.join(', ')??'미확인'}`);
  console.log(`AICC: ${current.workspace.state} · ${current.workspace.toolCount}개 도구 · 활성 작업 ${current.workspace.activeLeases??'미확인'}`);
  console.log('OCX: 자동 시작 없음 · 기존 로그인과 기록 보존');
  for(const warning of current.warnings)console.log(`참고: ${warning.id} · ${warning.summary}`);
  if(report.terminal)console.log(`복구 결과: ${report.terminal}`);
  if(report.actions?.some(action=>action.status==='NEEDS_FOREGROUND'))console.log('Windows 관리자 실행 필요: 관리자 PowerShell에서 codex-repair --sandbox');
}
