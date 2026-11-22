import test from 'node:test';
import assert from 'node:assert/strict';
import {projectTrayAccounts,isOcxReady,activeCount,connectionObservation,browserObservation,browserConnectionStatus} from '../tools/platform/windows/tray-status.mjs';
import {probeTunnelOwner} from '../tools/platform/workspace-mcp/windows-tunnel-secret.mjs';

test('missing quotas stay unknown, used percentages become remaining, and reset time is KST',()=>{
  const rows=projectTrayAccounts({terminal:'PASS',quotaSource:'live-refresh',accounts:[{selector:'one',active:true,quota:{shortPercent:95,weeklyPercent:98,shortResetAt:1791108000}},{selector:'two',quota:{}}]});
  assert.equal(rows[0].shortRemaining,5);assert.equal(rows[0].longRemaining,2);
  assert.equal(rows[0].fresh,true);assert.equal(rows[1].shortRemaining,null);assert.equal(rows[1].longReset,'미확인');
  assert.equal(projectTrayAccounts({terminal:'HOLD',accounts:[]}).length,0);
});
test('EPERM and reused unrelated PID is stale; same-name or unverified owners remain protected',()=>{
  // The owner probe reports an absolute executable path as JSON; a bare process name is not identity.
  const binary=fixturePath.resolve('fixtures/tunnel-client.exe');
  const owner=value=>()=>({status:0,stdout:JSON.stringify(value)});
  const options={platform:'win32',signalProcess(){throw Object.assign(new Error('protected'),{code:'EPERM'});},ownerProbe:owner({state:'present',executablePath:fixturePath.resolve('fixtures/dllhost.exe')})};
  assert.throws(()=>probeTunnelOwner(123,{binary},options),e=>e.code==='ESRCH');
  assert.throws(()=>probeTunnelOwner(123,{binary},{...options,ownerProbe:owner({state:'present',executablePath:binary})}),e=>e.code==='EPERM');
  assert.throws(()=>probeTunnelOwner(123,{binary},{...options,ownerProbe:owner({state:'present',executablePath:'tunnel-client.exe'})}),e=>e.code==='EPERM');
  assert.throws(()=>probeTunnelOwner(123,{binary},{...options,ownerProbe(){return {status:0,stdout:'tunnel-client.exe'};}}),e=>e.code==='EPERM');
  assert.throws(()=>probeTunnelOwner(123,{binary},{...options,ownerProbe(){return {status:1,stdout:''};}}),e=>e.code==='EPERM');
});
test('a blocked active account never appears usable, and unverifiable admission is visible',()=>{
  const rows=projectTrayAccounts({terminal:'PASS',accounts:[
    {selector:'blocked',active:true,admission:{state:'blocked'},quota:{shortPercent:95}},
    {selector:'unknown',active:true,admission:{state:'unverified'},quota:{}},
    {selector:'conditional',active:true,admission:{state:'conditional'},quota:{shortPercent:3}}
  ]});
  assert.equal(rows[0].status,'한도 차단');
  assert.equal(rows[1].status,'확인 필요');
  assert.equal(rows[2].status,'사용 중');
});

test('modern and legacy OCX readiness contracts preserve false/unknown',()=>{
  assert.equal(isOcxReady({status:'ok',ready:true}),true);
  assert.equal(isOcxReady({status:'ok',ready:false}),false);
  assert.equal(isOcxReady({status:'ready'}),true);
  assert.equal(isOcxReady({status:'ready',ready:false}),false);
  assert.equal(isOcxReady({status:'error',ready:true}),false);
  assert.equal(isOcxReady(null),false);
});

test('active counters stay unknown when not supplied',()=>{assert.equal(activeCount(undefined),null);assert.equal(activeCount(-1),null);assert.equal(activeCount('0'),null);assert.equal(activeCount(0),0);assert.equal(activeCount(3),3);});

test('queued refresh survives debounce and coalesces repeated clicks', async()=>{
  const {createRefreshSchedule}=await import('../tools/platform/windows/tray-status.mjs');
  let now=0;const schedule=createRefreshSchedule(()=>now);
  assert.equal(schedule.take().refresh,true);
  now=1000;schedule.request();schedule.request();
  assert.deepEqual(schedule.take(),{refresh:false,refreshState:'deferred',refreshRetryAfterSeconds:29});
  now=29999;assert.equal(schedule.take().refresh,false);
  now=30000;assert.equal(schedule.take().refresh,true);
  assert.equal(schedule.take().refreshState,'cached');
  assert.equal(schedule.retryMs(),null);
});

test('failed cache reads preserve actual quota time, report failure and recover',async()=>{
  const {createStatusMemo,quotaObservation}=await import('../tools/platform/windows/tray-status.mjs');
  let now=200000,reads=0;
  const memo=createStatusMemo(()=>now),value={accounts:[{quota:{updatedAt:170000}}]};
  assert.equal(await memo.read('pool:fixture',1000,async()=>{reads++;return value;}),value);
  now+=500;await memo.read('pool:fixture',1000,async()=>{reads++;return null;});assert.equal(reads,1);
  await memo.read('pool:fixture',1000,async()=>{reads++;throw Error('timeout');},true);
  assert.equal(memo.get('pool:fixture').failed,true);
  assert.equal(quotaObservation(memo.get('pool:fixture').value.accounts,now).quotaObservedAt,new Date(170000).toISOString());
  now+=1000;await memo.read('pool:fixture',1000,async()=>({accounts:[{quota:{updatedAt:now}}]}));
  assert.equal(memo.get('pool:fixture').failed,false);
  assert.equal(quotaObservation(memo.get('pool:fixture').value.accounts,now).quotaAgeSeconds,0);
  await memo.read('workspace:fixture',1000,async()=>({ready:true}));
  assert.equal(await memo.read('workspace:fixture',1000,async()=>null,true),null);
});

test('latest and oldest real quota reads stay separate from collector time',async()=>{
  const {quotaObservation}=await import('../tools/platform/windows/tray-status.mjs');
  assert.deepEqual(quotaObservation([{quota:{updatedAt:100000}},{quota:{updatedAt:190000}},{quota:{updatedAt:200001}},{quota:{updatedAt:null}}],200000),{
    quotaObservedAt:new Date(190000).toISOString(),quotaOldestObservedAt:new Date(100000).toISOString(),quotaAgeSeconds:100
  });
  assert.deepEqual(quotaObservation([],200000),{quotaObservedAt:null,quotaOldestObservedAt:null,quotaAgeSeconds:null});
});
import vm from 'node:vm';
import fixtureFs from 'node:fs';
import fixturePath from 'node:path';


// Evaluate the real dispatcher with in-memory files and fake runner imports.
// No account endpoint, PowerShell wrapper, registry or real receipt is used.
async function fakeTrayControl(scenario={}){
  const stateRoot=fixturePath.resolve('fixture-tray-state');
  const requests=fixturePath.join(stateRoot,'status-tray','requests');
  const file=fixturePath.join(requests,'a'.repeat(32)+'.json');
  const request={action:scenario.action??'pause',selector:'fixture',identityHash:'a'.repeat(64),priority:7,shortThreshold:94,longThreshold:97,shortAction:'switch',longAction:'stop'};
  const files=new Map([[file,JSON.stringify(request)]]);
  const calls=[];
  const fakeFs={
    existsSync:f=>files.has(f),
    lstatSync:f=>({isSymbolicLink:()=>false,isFile:()=>f!==requests}),
    statSync:f=>({size:Buffer.byteLength(files.get(f)??'')}),
    readFileSync:f=>{if(!files.has(f))throw Error('missing fixture');return files.get(f);},
    readdirSync:dir=>[...files.keys()].filter(f=>fixturePath.dirname(f)===dir).map(f=>fixturePath.basename(f)),
    writeFileSync:(f,text,options)=>{if(options?.flag==='wx'&&files.has(f))throw Error('duplicate receipt');files.set(f,text);}
  };
  const runHidden=async(command,args)=>{
    calls.push({command,args});
    if(args.includes('reconcile'))return scenario.reconciled??{terminal:'PASS',reconciled:'completed_receipt'};
    if(args.includes('-Commit'))return 'committed' in scenario?scenario.committed:{terminal:'PASS',remoteMutation:true};
    return 'preview' in scenario?scenario.preview:{terminal:'DRY_RUN',previewToken:'b'.repeat(32)};
  };
  const controlUrl=new URL('../tools/platform/windows/tray-control.mjs',import.meta.url);
  const context=vm.createContext({process,console});
  const module=new vm.SourceTextModule(fixtureFs.readFileSync(controlUrl,'utf8'),{
    context,identifier:controlUrl.href,initializeImportMeta:meta=>{meta.url=controlUrl.href;}
  });
  const imports={
    'node:fs':{default:fakeFs},'node:path':{default:fixturePath},
    'node:url':{fileURLToPath:url=>fixturePath.resolve(new URL(url).pathname.replace(/^\/([A-Za-z]:)/,'$1'))},
    '../../../src/runtime-layout.mjs':{resolveRuntimeLayout:()=>({root:stateRoot}),insideDirectory:(root,file)=>file.startsWith(root+fixturePath.sep)},
    './tray-status.mjs':{runHidden,collectTrayStatus:async()=>{if(scenario.statusFails)throw Error('status read failed');return {schemaVersion:1,accounts:[],aiccReady:false};}}
  };
  await module.link(specifier=>{
    const values=imports[specifier];if(!values)throw Error('Unexpected dependency '+specifier);
    return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});
  });
  await module.evaluate();
  return {apply:()=>module.namespace.applyTrayRequest(file),failure:()=>module.namespace.failureOutcome(file),files,file,requests,calls,request};
}

test('S-TRAY a failure after a committed receipt reports the PASS receipt, never "not executed"',{skip:!vm.SourceTextModule},async()=>{
  const fixture=await fakeTrayControl({action:'use',statusFails:true});
  await assert.rejects(fixture.apply(),/status read failed/);
  assert.equal(JSON.parse(fixture.files.get(fixture.file+'.result.json')).terminal,'PASS');
  const outcome=fixture.failure();
  assert.equal(outcome.terminal,'PASS');assert.equal(outcome.action,'use');assert.equal(outcome.mutationDispatched,true);assert.equal(outcome.stateUnavailable,true);
  assert.equal(fixture.calls.filter(call=>call.args.includes('-Commit')).length,1);
  // Pending receipts stay uncertain and a missing receipt stays an undispatched refusal.
  const plain=value=>JSON.parse(JSON.stringify(value));
  fixture.files.set(fixture.file+'.result.json',JSON.stringify({terminal:'DISPATCHING',requestId:'b'.repeat(32)}));
  assert.deepEqual(plain(fixture.failure()),{terminal:'UNCERTAIN',reason:'mutation_result_requires_readonly_reconciliation',mutationDispatched:true});
  fixture.files.delete(fixture.file+'.result.json');
  assert.deepEqual(plain(fixture.failure()),{terminal:'HOLD',reason:'tray_request_refused',mutationDispatched:false});
  fixture.files.set(fixture.file+'.result.json','{broken');
  assert.equal(fixture.failure().terminal,'UNCERTAIN');
});
test('S-TRAY status memo expire forces a re-read but keeps the pool fallback value',async()=>{
  const {createStatusMemo}=await import('../tools/platform/windows/tray-status.mjs');
  let now=1000,reads=0;const memo=createStatusMemo(()=>now);
  await memo.read('active:x',15000,async()=>{reads++;return {accountId:'old'};});
  assert.deepEqual(await memo.read('active:x',15000,async()=>{reads++;return {accountId:'new'};}),{accountId:'old'});
  memo.expire('active:');
  assert.deepEqual(await memo.read('active:x',15000,async()=>{reads++;return {accountId:'new'};}),{accountId:'new'});
  assert.equal(reads,2);
  await memo.read('pool:x',60000,async()=>({accounts:[1]}));memo.expire('pool:');
  assert.deepEqual(await memo.read('pool:x',60000,async()=>null),{accounts:[1]});
  assert.equal(memo.get('pool:x').failed,true);
});

test('real tray dispatcher uses exact preview/confirm once for every account and policy action',{skip:!vm.SourceTextModule},async()=>{
  for(const action of ['use','pause','resume','unpin','priority','policy','reset']){
    const fixture=await fakeTrayControl({action});
    const result=await fixture.apply();
    assert.equal(result.terminal,'PASS',action);
    assert.equal(fixture.calls.length,2,action);
    const [preview,commit]=fixture.calls;
    assert.ok(!preview.args.includes('-Commit'));
    assert.equal(commit.args.at(-1),'b'.repeat(32));
    assert.ok(commit.args.includes('-Commit'));
    if(action!=='policy')assert.ok(commit.args.includes('a'.repeat(64)));
    if(action==='priority')assert.equal(commit.args[commit.args.indexOf('-Priority')+1],'7');
    if(action==='policy')assert.equal(commit.args[commit.args.indexOf('-ShortThreshold')+1],'94');
    const receipt=JSON.parse(fixture.files.get(fixture.file+'.result.json'));
    assert.equal(receipt.terminal,'PASS');
    await assert.rejects(fixture.apply(),/already dispatched/);
    assert.equal(fixture.calls.length,2,'duplicate must not call runner');
  }
});

test('preview failure/cancel cannot dispatch and commit failure/timeout stays fenced',{skip:!vm.SourceTextModule},async()=>{
  for(const preview of [null,{terminal:'HOLD',failureCode:'cancelled'},{terminal:'DRY_RUN',previewToken:'invalid'}]){
    const fixture=await fakeTrayControl({preview});
    const result=await fixture.apply();
    assert.equal(result.terminal,'HOLD');assert.equal(result.mutationDispatched,false);
    assert.equal(fixture.calls.length,1);
    assert.equal(fixture.files.has(fixture.file+'.result.json'),false);
  }
  for(const committed of [null,{terminal:'FAIL',failureCode:'owner_failed'},{terminal:'HOLD',failureCode:'timeout'}]){
    const fixture=await fakeTrayControl({committed});
    assert.equal((await fixture.apply()).terminal,'UNCERTAIN');
    assert.equal(JSON.parse(fixture.files.get(fixture.file+'.result.json')).terminal,'UNCERTAIN');
    await assert.rejects(fixture.apply(),/already dispatched/);
    const next=fixturePath.join(fixture.requests,'c'.repeat(32)+'.json');
    fixture.files.set(next,JSON.stringify({...fixture.request,action:'resume'}));
    // Reuse the same module entry path after removing only the request, keeping its receipt fence.
    fixture.files.set(fixture.file,fixture.files.get(next));
    fixture.files.delete(fixture.file+'.result.json');
    fixture.files.set(next+'.result.json',JSON.stringify({terminal:'UNCERTAIN',requestId:'b'.repeat(32)}));
    assert.equal((await fixture.apply()).terminal,'UNCERTAIN');
    assert.equal(fixture.calls.length,2);
  }
});

test('reset no-op and read-only reconciliation keep original transaction identity',{skip:!vm.SourceTextModule},async()=>{
  for(const resetCode of ['reset','already_redeemed','nothing_to_reset','no_credit']){
    const fixture=await fakeTrayControl({action:'reset',committed:{terminal:'PASS',resetCode}});
    const result=await fixture.apply();
    assert.equal(result.resetCode,resetCode);
    assert.equal(fixture.calls.length,2);
  }
  for(const reconciled of [{terminal:'PASS',reconciled:'completed_receipt'},{terminal:'HOLD',reason:'receipt_missing'}]){
    const fixture=await fakeTrayControl({action:'reconcile',reconciled});
    const receipt=fixturePath.join(fixture.requests,'d'.repeat(32)+'.json.result.json');
    fixture.files.set(receipt,JSON.stringify({terminal:'UNCERTAIN',requestId:'b'.repeat(32),action:'reset'}));
    const result=await fixture.apply();
    assert.equal(result.terminal,reconciled.terminal==='PASS'?'PASS':'UNCERTAIN');
    assert.equal(fixture.calls.length,1);
    assert.ok(fixture.calls[0].args.includes('reconcile'));
    assert.ok(!fixture.calls[0].args.includes('-Commit'));
    assert.equal(fixture.calls[0].args.at(-1),'b'.repeat(32));
  }
});
test('a failed health read remains unconfirmed instead of reporting a disconnected service',()=>{
  assert.deepEqual(connectionObservation(null),{ready:false,readOk:false,status:'조회 실패 · 연결 미확인'});
  assert.equal(connectionObservation({}).readOk,false);
  assert.deepEqual(connectionObservation({status:'ok'}),{ready:true,readOk:true,status:'연결됨'});
  assert.equal(connectionObservation({status:'error'}).status,'점검 필요');
  assert.equal(connectionObservation({status:'ready',ready:true},true).ready,true);
  assert.equal(connectionObservation({status:'ok',ready:false},true).ready,false);
});

test('failed CDP observations stay unknown and do not claim that a browser is closed',()=>{
  const missing=browserObservation(9222,null);
  assert.equal(missing.connected,null);
  assert.equal(browserConnectionStatus([missing]),'연결 조회 실패 · 상태 미확인');
  const ready=browserObservation(9223,{Browser:'Chrome/fixture'});
  assert.equal(browserConnectionStatus([ready,missing]),'9223 실행 중 · 일부 연결 미확인');
  assert.equal(browserConnectionStatus([{port:9222,connected:false}]),'꺼짐 · 웹 작업 전에 실행 필요');
});

// Targeted resume tests: JSON/exit handling and current CLI selection, all fake I/O.
test('tray resume preserves only scoped Workspace attention JSON on exit one',async()=>{
  const {parseHiddenJson,isWorkspaceStatus,workspaceConnectionObservation}=await import('../tools/platform/windows/tray-status.mjs');
  const attention={id:'workspace-mcp',state:'attention',serverReady:false,tunnel:{ready:false}};
  const accept=value=>isWorkspaceStatus(value)&&value.state!=='ready';
  assert.deepEqual(parseHiddenJson(JSON.stringify(attention),1,false,accept),attention);
  assert.equal(parseHiddenJson(JSON.stringify(attention),1),null,'control runners retain exit-zero contract');
  for(const [text,code,overflow] of [['{',1,false],[JSON.stringify(attention),2,false],[JSON.stringify(attention),null,false],[JSON.stringify(attention),1,true],[JSON.stringify({terminal:'PASS'}),1,false],[JSON.stringify({...attention,state:'ready'}),1,false]])
    assert.equal(parseHiddenJson(text,code,overflow,accept),null);
  assert.deepEqual(workspaceConnectionObservation(attention,{phase:'ready'}),{ready:false,readFailed:false,status:'점검 필요'});
  assert.deepEqual(workspaceConnectionObservation(null,{phase:'ready'}),{ready:false,readFailed:true,status:'상태 조회 실패 · 연결 미확인'});
  assert.equal(workspaceConnectionObservation({...attention,state:'ready',serverReady:true,tunnel:{ready:true},remoteAuthority:{runtimeReady:false}}).ready,false);
  assert.equal(workspaceConnectionObservation({...attention,state:'ready',serverReady:true,tunnel:{ready:true},remoteAuthority:{runtimeReady:true}}).ready,true);
});

test('tray resume selects registered CLI independently of pinned backend and refuses unknown registry',async()=>{
  const {resolveTrayStatusCli}=await import('../tools/platform/windows/tray-status.mjs');
  const root=fixturePath.resolve('fixture-resume-home');
  const layout={root,releases:fixturePath.join(root,'releases'),legacyReleaseRoot:fixturePath.resolve('fixture-legacy')};
  const cli={entry:fixturePath.join(layout.releases,'cli','current','bin','aicc'),runtime:fixturePath.resolve('fixture-node.exe'),location:'managed'};
  const registry={schemaVersion:1,root,components:{cli}};
  assert.deepEqual(resolveTrayStatusCli(layout,registry),{entry:cli.entry,runtime:cli.runtime});
  const workspace={...cli,entry:fixturePath.join(layout.releases,'workspace','current','bin','aicc')};
  assert.deepEqual(resolveTrayStatusCli(layout,{...registry,components:{cli,workspace}}),{entry:workspace.entry,runtime:workspace.runtime});
  assert.equal(resolveTrayStatusCli(layout,{...registry,components:{cli,workspace:{...workspace,entry:fixturePath.resolve('outside','bin','aicc')}}}),null);
  for(const invalid of [{...registry,root:root+'-other'},{...registry,schemaVersion:2},{...registry,components:{cli:{...cli,entry:fixturePath.resolve('outside','bin','aicc')}}},{...registry,components:{cli:{...cli,runtime:'node'}}},{...registry,components:{cli:{...cli,location:'unknown'}}}])
    assert.equal(resolveTrayStatusCli(layout,invalid),null);
  const legacy={...cli,entry:fixturePath.join(layout.legacyReleaseRoot,'old','bin','aicc'),location:'legacy-frozen'};
  assert.equal(resolveTrayStatusCli(layout,{...registry,components:{cli:legacy}}).entry,legacy.entry);
});

test('tray latency collector uses narrow current reader and retains attention without live probes',{skip:!vm.SourceTextModule},async()=>{
  const {EventEmitter}=await import('node:events');
  const {fileURLToPath,pathToFileURL}=await import('node:url');
  const {insideDirectory}=await import('../src/runtime-layout.mjs');
  const root=fixturePath.resolve('fixture-resume-collector');
  const layout={root,releases:fixturePath.join(root,'releases'),legacyReleaseRoot:fixturePath.resolve('fixture-legacy'),registry:fixturePath.join(root,'runtime','components.json')};
  const cli={entry:fixturePath.join(layout.releases,'cli','current','bin','aicc'),runtime:fixturePath.resolve('fixture-node.exe'),location:'managed'};
  const pinned=fixturePath.join(layout.releases,'workspace','old','package-lock.json');
  const files=new Map([[layout.registry,JSON.stringify({schemaVersion:1,root,components:{cli}})],[fixturePath.join(root,'workspace-mcp/runtime/remote-authority-status.json'),JSON.stringify({phase:'ready',instanceId:'fixture',installedIdentity:{lockfileRealpath:pinned}})]]);
  const calls=[];
  let failed=false;
  const fakeFs={existsSync:file=>files.has(file),lstatSync:()=>({isSymbolicLink:()=>false,isFile:()=>true}),readdirSync:()=>[],readFileSync:file=>{if(!files.has(file))throw Error('missing fixture');return files.get(file);}};
  const fakeSpawn=(command,args,options)=>{
    calls.push({command,args,options});
    const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{throw Error('unexpected fixture kill');};
    queueMicrotask(()=>{
      if(args.includes('--input-type=module')&&failed){child.emit('error',Error('fixture read failed'));return;}
      child.stdout.emit('data',JSON.stringify(args.includes('--input-type=module')?{id:'workspace-mcp',state:'attention',serverReady:false,tunnel:{ready:false}}:{terminal:'FAIL'}));
      child.emit('close',args.includes('--input-type=module')?1:0);
    });
    return child;
  };
  const url=new URL('../tools/platform/windows/tray-status.mjs',import.meta.url);
  const context=vm.createContext({process,console,setTimeout,clearTimeout,AbortSignal,fetch:async()=>({ok:false})});
  const module=new vm.SourceTextModule(fixtureFs.readFileSync(url,'utf8'),{context,identifier:url.href,initializeImportMeta:meta=>{meta.url=url.href;}});
  const imports={'node:fs':{default:fakeFs},'node:path':{default:fixturePath},'node:os':{default:{}},'node:child_process':{spawn:fakeSpawn},'node:url':{fileURLToPath,pathToFileURL},'node:crypto':{createHash:()=>{throw Error('unexpected secret projection');}},'../../../src/runtime-layout.mjs':{resolveRuntimeLayout:()=>layout,insideDirectory}};
  await module.link(specifier=>{const values=imports[specifier];assert.ok(values,specifier);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});});
  await module.evaluate();
  const first=await module.namespace.collectTrayStatus();
  assert.equal(first.aiccStatus,'점검 필요');assert.equal(first.aiccReady,false);assert.equal(first.aiccReadFailed,false);
  const statusCalls=()=>calls.filter(call=>call.args.includes('--input-type=module'));
  assert.equal(statusCalls().length,1);assert.equal(statusCalls()[0].command,cli.runtime);assert.equal(statusCalls()[0].args[0],'--input-type=module');assert.equal(statusCalls()[0].args[3],pathToFileURL(fixturePath.join(fixturePath.dirname(fixturePath.dirname(cli.entry)),'src','workspace-mcp.mjs')).href);assert.equal(statusCalls()[0].options.windowsHide,true);
  await module.namespace.collectTrayStatus();assert.equal(statusCalls().length,1,'cached display does not repeat Workspace CLI');
  failed=true;
  const failure=await module.namespace.collectTrayStatus({refresh:true});
  assert.equal(failure.aiccReady,false);assert.equal(failure.aiccReadFailed,true);assert.equal(failure.aiccStatus,'상태 조회 실패 · 연결 미확인');
  assert.equal(failure.webReady,false);assert.equal(failure.ocxReady,false);
});

// Only new latency behavior: fake reads, fake status module and fake runner.
test('tray latency Web failure backoff deduplicates, expires and permits manual retry',async()=>{
  const {createFailureBackoff}=await import('../tools/platform/windows/tray-status.mjs');
  let now=0,calls=0,release;
  const backoff=createFailureBackoff(()=>now);
  const pending=backoff.read('web',15000,()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  const duplicate=backoff.read('web',15000,()=>{calls++;return {status:'ok'};},true);
  await Promise.resolve();assert.equal(calls,1);release(null);
  assert.equal(await pending,null);assert.equal(await duplicate,null);
  now=14999;assert.equal(await backoff.read('web',15000,()=>{calls++;return {status:'ok'};}),null);assert.equal(calls,1);
  assert.deepEqual(await backoff.read('web',15000,()=>{calls++;return {status:'ok'};},true),{status:'ok'});
  assert.equal(await backoff.read('web',15000,()=>{calls++;throw Error('fixture only');}),null,'success must not hide next failure');
  assert.equal(calls,3);now+=15000;
  assert.equal(await backoff.read('web',15000,()=>{calls++;return null;}),null);assert.equal(calls,4);
});

test('tray latency Workspace worker returns negative Tunnel evidence before identity work',{skip:!vm.SourceTextModule},async()=>{
  const {workspaceStatusReaderSource}=await import('../tools/platform/windows/tray-status.mjs');
  let fullReads=0,tunnelReads=0;
  async function execute(tunnel,result,throwProbe=false,nextTunnel){
    const lines=[],fakeProcess={argv:['fixture','fixture://current-workspace'],exitCode:0};
    let attempts=0;
    const context=vm.createContext({process:fakeProcess,console:{log:line=>lines.push(line)}});
    const dependency=new vm.SyntheticModule(['probeWorkspaceTunnel','workspaceMcpStatus'],function(){
      this.setExport('probeWorkspaceTunnel',async options=>{tunnelReads++;attempts++;assert.equal(options.timeoutMs,6000);if(throwProbe)throw Error('private error never projected');return attempts>1&&nextTunnel?nextTunnel:tunnel;});
      this.setExport('workspaceMcpStatus',async options=>{fullReads++;assert.equal(await options.tunnelProbe(),attempts>1&&nextTunnel?nextTunnel:tunnel,'reuse observed Tunnel result');return result;});
    },{context});
    await dependency.link(()=>{});await dependency.evaluate();
    const module=new vm.SourceTextModule(workspaceStatusReaderSource,{context,importModuleDynamically:async specifier=>{assert.equal(specifier,'fixture://current-workspace');return dependency;}});
    await module.link(()=>{throw Error('unexpected static dependency');});await module.evaluate();
    return {value:JSON.parse(lines[0]),exit:fakeProcess.exitCode,lines,attempts};
  }
  const negative=await execute({ready:false,healthy:true},{state:'ready'});
  assert.equal(fullReads,0);assert.equal(tunnelReads,1);assert.equal(negative.value.serverReady,false);assert.equal(negative.value.state,'attention');assert.equal(negative.exit,1);
  const ready=await execute({ready:true},{id:'workspace-mcp',state:'ready',serverReady:true,tunnel:{ready:true},remoteAuthority:{runtimeReady:true},detail:'private text',command:{args:['private args']}});
  assert.equal(fullReads,1);assert.equal(tunnelReads,2);assert.equal(ready.exit,0);assert.equal(ready.value.remoteAuthority.runtimeReady,true);assert.equal('detail' in ready.value,false);assert.equal('command' in ready.value,false);
  const unhealthy=await execute({ready:true},{id:'workspace-mcp',state:'attention',serverReady:false,tunnel:{ready:true},remoteAuthority:{runtimeReady:false}});
  assert.equal(unhealthy.exit,1);assert.equal(unhealthy.value.remoteAuthority.runtimeReady,false);
  const failure=await execute(null,null,true);assert.equal(failure.value,null);assert.equal(failure.exit,1);assert.ok(!failure.lines.join('').includes('private error'));
  const recovered=await execute({registered:true,running:true,ready:false},
    {id:'workspace-mcp',state:'ready',serverReady:true,tunnel:{ready:true},remoteAuthority:{runtimeReady:true}},false,{registered:true,running:true,ready:true});
  assert.equal(recovered.attempts,2);assert.equal(recovered.exit,0);
  const stopped=await execute({registered:true,running:false,ready:false},null);
  assert.equal(stopped.attempts,1);assert.equal(stopped.exit,1);
});

test('tray latency narrow runner keeps bounded identity budget and Workspace attention contract',async()=>{
  const {readWorkspaceTrayStatus,workspaceStatusReaderSource}=await import('../tools/platform/windows/tray-status.mjs');
  const {pathToFileURL}=await import('node:url');
  const cli={entry:fixturePath.resolve('fixture-current','bin','aicc'),runtime:fixturePath.resolve('fixture-node.exe')};
  let calls=0;
  const value=await readWorkspaceTrayStatus(cli,async(runtime,args,timeout,kill,accept)=>{
    calls++;assert.equal(runtime,cli.runtime);assert.equal(timeout,20000);assert.equal(kill,true);
    assert.deepEqual(args,['--input-type=module','-e',workspaceStatusReaderSource,pathToFileURL(fixturePath.resolve('fixture-current','src','workspace-mcp.mjs')).href]);
    assert.equal(accept({id:'workspace-mcp',state:'attention'}),true);assert.equal(accept({id:'workspace-mcp',state:'ready'}),false);
    return null;
  });
  assert.equal(calls,1);assert.equal(value,null);
});

test('tray Workspace reader accepts healthy identity checks beyond the former five second deadline',async()=>{
  const {readWorkspaceTrayStatus,workspaceConnectionObservation,runHidden}=await import('../tools/platform/windows/tray-status.mjs');
  // Use an actual child and a data-URL module; no live service or fixture files.
  const fixture=`export async function probeWorkspaceTunnel(){await new Promise(resolve=>setTimeout(resolve,5500));return {ready:true};}
    export async function workspaceMcpStatus(){return {id:'workspace-mcp',state:'ready',serverReady:true,tunnel:{ready:true},remoteAuthority:{runtimeReady:true}};}`;
  const value=await readWorkspaceTrayStatus({runtime:process.execPath,entry:fixturePath.resolve('fixture-current','bin','aicc')},
    (runtime,args,...options)=>runHidden(runtime,[...args.slice(0,-1),'data:text/javascript,'+encodeURIComponent(fixture)],...options));
  assert.equal(workspaceConnectionObservation(value).ready,true);
  assert.equal(workspaceConnectionObservation(value).readFailed,false);
});
