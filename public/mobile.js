import { createCoworkView } from '/ai-cowork.js';
import { createQuotaView } from '/mobile-quota.js';
import { createMobileToolsView } from '/mobile-tools.js';
const $ = id => document.getElementById(id);
let csrf = null, session = null, rows = [], web = null, preview = null, operationId = null;
let queueBusy = false, confirmBusy = false, sessionSync = null;
let refreshedOperationId = null;
let quotaView = null, toolsView = null;
let activityBusy = false, activityTimer = null;
let handoffBusy = false;
const errors = { csrf_required:'연결 정보가 바뀌었습니다. 다시 조회한 뒤 시도하세요. 이 요청은 실행되지 않았습니다.',session_changed:'연결이 갱신되어 이전 미리보기를 해제했습니다. 새 미리보기를 확인하세요. 변경 요청은 실행하지 않았습니다.',mobile_maintenance:'서비스를 교체하고 있습니다. 잠시 뒤 다시 조회하세요. 요청을 자동으로 반복하지 않습니다.', tray_tool_local_only:'이 기능은 PC에서 직접 사용해야 합니다. 트레이 도구의 안내를 확인하세요.',tray_tools_pin_mismatch:'설치된 트레이 도구가 변경되어 실행을 보류했습니다.', pair_required:'이 브라우저의 연결 정보가 없거나 해제되었습니다. 최초 한 번만 계속 허용으로 연결하세요. 같은 PC라도 브라우저마다 별도 등록이 필요합니다.',pair_expired:'연결 링크가 만료됐거나 이미 사용됐습니다.',host_not_allowed:'허용된 PC·휴대폰 주소로 접속해 주세요.',local_owner_required:'PC의 로컬 연결 화면에서만 할 수 있습니다.',continuity_pin_mismatch:'설치된 대화 감시기의 파일·버전이 맞지 않습니다. 변경하지 않았습니다.',tray_pin_mismatch:'트레이 설치 파일 신원이 달라 변경할 수 없습니다.',tray_not_installed:'등록된 트레이 설치를 확인하지 못했습니다.',previous_outcome_unknown:'원래 변경의 결과가 불명입니다. 재전송하지 말고 원래 결과를 확인하세요.',pending_delivery_preserved:'전달 중이거나 결과가 불명인 요청을 보존했습니다.',preview_stale:'미리보기 뒤 상태가 바뀌었습니다. 새로 조회하고 선택하세요.',confirmation_expired:'확인 토큰이 만료됐거나 이미 사용됐습니다. 요청을 반복하지 말고 현재 결과를 확인하세요.',displayed_terminal_changed:'보류 응답이 바뀌었습니다. 새 응답 해시를 확인한 뒤 재개하세요.',account_identity_unconfirmed:'실제 계정 신원·선택 상태를 확인하지 못했습니다.',account_not_admitted:'선택한 계정은 현재 한도·로그인 조건을 충족하지 않습니다.',peer_not_installed:'설치된 웹 타이머가 전달 승인을 지원하지 않습니다.',mutation_busy:'다른 변경 처리 중입니다. 원래 결과를 확인하세요.',web_revision_changed:'웹 설정이 바뀌었습니다. 다시 읽은 뒤 편집하세요.',goal_ledger_unavailable:'목표 원장을 읽을 수 없습니다. 원래 PC 원장과 서비스 연결을 확인해야 합니다.' };
const notice = message => { $('notice').textContent = message ?? ''; };
function el(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
function button(text, handler) { const b = el('button', text); b.type = 'button'; b.addEventListener('click', handler); return b; }
function field(parent, label, type = 'text', value = '') { const l = el('label', label); const n = document.createElement(type === 'textarea' ? 'textarea' : 'input'); if(type !== 'textarea') n.type=type; if(type==='checkbox') n.checked=!!value; else n.value=value??''; l.append(n); parent.append(l); return n; }
function select(parent, label, values, value) { const l=el('label',label), n=el('select'); for(const [key,text] of values){const o=el('option',text);o.value=key;n.append(o);}n.value=value;l.append(n);parent.append(l);return n; }
function date(value) { if(value == null || value === '')return '미확인'; const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+' KST' : '미확인'; }
const continuationReasons = {
  OFFICIAL_SENDER_REQUIRED:'공식 도구가 있는 별도 발신자가 필요합니다. 로컬 감시기는 자동 발신하지 못합니다.',
  SELECTION_DISABLED:'자동 재개 선택이 꺼져 있습니다.', QUEUE_TRACKING_COMPLETE:'이 큐의 추적이 종료됐습니다. 전체 업무 완료 증거와는 별개입니다.',
  USER_ACTION_HOLD:'사용자 조치가 필요한 보류입니다. 한도 회복으로 해제되지 않습니다.', USER_STOP_HOLD:'중지된 작업입니다. 기존 승인과 재개 조건을 다시 확인해야 합니다.',
  TARGET_ACTIVE_WAIT:'새 작업이 진행 중입니다. 후속 메시지를 보내지 않습니다.', TARGET_ACTIVITY_REQUIRES_APP_READ:'작업 중인 흔적이 있습니다. 공식 대화 상태를 확인하기 전에는 보내지 않습니다.',
  DELIVERY_UNCERTAIN_NO_REPLAY:'전달 시도 결과를 확인해야 합니다. 기존 attempt를 보존하고 다시 보내지 않습니다.',
  NEW_TURN_OBSERVATION_REQUIRED:'전송 접수 기록은 있으나 실제 새 작업 시작은 확인해야 합니다.',
  QUOTA_WAIT:'한도 대기 기록입니다. 회복 시각만으로 현재 여유를 판단하지 않습니다.',
  ROUTE_OR_QUOTA_UNCONFIRMED:'실행 경로나 한도 준비를 확인하지 못했습니다.'
};
function renderContinuation(card, p) {
  if(!p)return;
  card.append(el('p',continuationReasons[p.reason]??'실제 전달 조건을 확인해야 합니다.','warning'));
  const proof=v=>v==='RECORDED'?'기록 있음':v==='OBSERVED'?'관측됨':'근거 미확인';
  const steps=el('ol');
  for(const text of [
    '큐 등록: '+(p.queueRegistered?'등록됨':'미등록')+' · 재개 선택 '+(p.selected?'켜짐':'꺼짐'),
    '한도: '+(p.quota.state==='READY'?'과거 OCX 풀 준비 관측':p.quota.state==='QUOTA_WAIT'?'대기 기록':'미확인')+' · 관측 '+date(p.quota.observedAt)+(p.quota.targetRoute==='RECORDED_OCX_AT_CLAIM'?' · Claim 당시 대상 OCX 근거 기록 '+date(p.quota.targetRouteObservedAt)+' · 현재 준비는 별도 확인':' · 대상 대화의 OCX 경로 미입증'),
    'Claim: '+proof(p.claim.state), '공식 전송 ACK: '+proof(p.deliveryAck.state),
    '실제 새 turn: '+proof(p.newTurn.state)+(p.newTurn.turnStatus?' · '+p.newTurn.turnStatus:'')+' · '+date(p.newTurn.observedAt),
    '전체 goal 완료: 미확인 · 큐 추적 '+(p.goal.queueTrackingComplete?'종료':'유지')
  ])steps.append(el('li',text));
  card.append(steps,el('p','내장 goal 상태는 이 화면에서 읽거나 변경하지 않습니다. 일반 메시지 접수나 한 turn 종료는 전체 목표 완료 증거가 아닙니다.','meta'));
}
// Refresh only the session proof; never replay an uncertain mutation.
async function request(endpoint, value) {
  const headers = {}; if (value !== undefined) { headers['content-type']='application/json'; if(csrf)headers['x-aicc-csrf']=csrf; }
  const controller=value===undefined?new AbortController():null;
  const timeout=controller?setTimeout(()=>controller.abort(),endpoint==='session'?8000:15000):null;
  try{
    let response;
    try{response=await fetch('/api/mobile/'+endpoint,{method:value===undefined?'GET':'POST',headers,credentials:'same-origin',cache:'no-store',...(controller?{signal:controller.signal}:{}),...(value===undefined?{}:{body:JSON.stringify(value)})});}
    catch{
      const error=Error(controller?.signal.aborted?'조회 응답이 지연됩니다. 화면은 계속 사용할 수 있습니다. 잠시 뒤 다시 조회하세요.':value===undefined?'조회 연결이 끊겼습니다.':'응답 연결이 끊겼습니다. 요청을 다시 보내지 말고 원래 처리 결과를 확인하세요.');
      if(controller?.signal.aborted)error.code='read_timeout';throw error;
    }
    let data;try{data=await response.json();}catch{throw Error(value===undefined?'조회 응답을 읽지 못했습니다. 기존 표시값은 유지합니다.':'응답을 확인하지 못했습니다. 변경 요청을 자동으로 반복하지 않습니다.');}
    if(!response.ok||data.ok===false){const error=Error(errors[data.code]??'처리할 수 없습니다 · '+(data.code??'결과 미확인'));error.code=data.code;error.status=response.status;error.automaticReplay=data.automaticReplay;throw error;}
    return data;
  }finally{if(timeout!==null)clearTimeout(timeout);}
}
function connectionLabel(){
  if(!session)return;
  $('connection').classList.remove('offline');
  $('connection').textContent=(session.local?'PC 로컬 연결':'이 브라우저 연결')+(session.local?' · 시간 제한 없음':session.trustedDevice?' · 계속 허용됨 (직접 해제 전까지)':' · 만료 '+date(session.expiresAt));
}
function acceptSession(value){
  if(csrf&&csrf!==value.csrf){preview=null;$('confirmChange').disabled=true;if($('confirmDialog').open)$('confirmDialog').close();}
  session=value;csrf=value.csrf;connectionLabel();updateNextStep();window.dispatchEvent(new Event('aicc:session-ready'));return value;
}
async function syncSession(){
  if(sessionSync)return sessionSync;
  sessionSync=(async()=>{
    let value;
    try{value=await request('session');}
    catch(error){
      const loopback=location.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(location.hostname);
      if(error.code!=='pair_required'||!loopback)throw error;
      value=await request('local-session',{});
    }
    return acceptSession(value);
  })();
  try{return await sessionSync;}finally{sessionSync=null;}
}
async function api(endpoint,value){
  if(value===undefined||['exchange','local-session'].includes(endpoint))return request(endpoint,value);
  const previousCsrf=csrf;
  await syncSession();
  // A confirmation belongs to its original session and preview, not the new one.
  if(endpoint==='confirm'&&previousCsrf!==csrf)throw Error(errors.session_changed);
  try{return await request(endpoint,value);}
  catch(error){
    if(error.code!=='csrf_required'||error.status!==409||error.automaticReplay!==false)throw error;
    await syncSession();
    // This exact rejection occurs before body parsing or dispatch. Only harmless
    // refresh/preview requests may retry once; confirmations are never replayed.
    if(['quota/refresh','refresh-quota','preview'].includes(endpoint))return request(endpoint,value);
    throw Error(endpoint==='confirm'?errors.session_changed:errors.csrf_required);
  }
}
function storedOperation(){try{return sessionStorage.getItem('aiccMobileOperation');}catch{return null;}}
function rememberOperation(id){try{sessionStorage.setItem('aiccMobileOperation',id);}catch{/* The current page still retains the original operation ID. */}}
async function perform(fn){notice('');try{await fn();}catch(e){notice(e.message);if(e.code==='pair_required'){$('authPanel').hidden=false;$('authMessage').textContent=e.message;}}}
function enableSession(){document.dispatchEvent(new Event('aicc:session-ready'));for(const id of ['logout','refreshThreads','readTray','refreshQuota','readWeb','readGoals','readOrchestration'])$(id).disabled=false;$('pairPanel').hidden=!session.local;$('pair').disabled=!session.remoteConfigured;$('revoke').disabled=false;connectionLabel();if(session.local)void perform(loadDevices);}
async function loadGoals(){
  $('readGoals').disabled=true;$('goalStatus').textContent='목표 원장 조회 중…';$('goalRows').replaceChildren();
  try{
    const value=await api('goals'),counts=value.summary;
    const names={ACTIVE:'진행 중',HOLD:'보류',REVIEW_READY:'검토 대기',USER_MANAGED_READY:'사용자 관리 준비',COMPLETE:'완료 기록',UNASSIGNED:'담당 미지정',UNKNOWN:'미확인'};
    $('goalStatus').textContent=`전체 ${counts.goalCount}개 · 완료 기록 ${counts.completedCount}개 · 원장 갱신 ${date(value.sourceUpdatedAt)} · 조회 ${date(value.observedAt)}`;
    if(counts.truncated)$('goalRows').append(el('p',`${counts.goalCount}개 중 ${counts.shownCount}개만 표시합니다. PC 전체 목표 원장에서 나머지를 확인하세요.`,'warning'));
    if(!value.goals.length)$('goalRows').append(el('p','목표 원장에 등록된 항목이 없습니다.'));
    for(const goal of value.goals){
      const card=el('article',null,'card');card.append(el('h3',goal.title??'제목 미확인'),el('p',goal.id,'meta'),el('span',names[goal.status]??names.UNKNOWN,'badge'));
      if(goal.checked)card.append(el('p','소유자 확인 표시 · '+date(goal.checkedAt)+' · 완료 증거와 별개','meta'));
      $('goalRows').append(card);
    }
  }catch(error){$('goalStatus').textContent='목표 조회 실패 · '+error.message;}
  finally{$('readGoals').disabled=false;}
}
async function readThreads(){
  const selectedIds=new Set([...$('threads').querySelectorAll('input:checked')].map(x=>x.value));
  $('refreshThreads').disabled=true;$('threadStatus').textContent='대화 등록과 감시기 확인 중…';
  try{const s=await api('state');rows=s.rows;$('threads').replaceChildren();
    for(const r of rows){const c=el('article',null,'card'),l=el('label'),check=document.createElement('input');check.type='checkbox';check.value=r.threadId;check.checked=selectedIds.has(r.threadId);check.addEventListener('change',updateQueueButtons);l.append(check,el('strong',r.title??r.threadId));c.append(l,el('p',r.threadId,'meta'),el('span',r.executionSurface,'badge'),el('span',r.enabled?'켜짐':r.registered?'꺼짐':'미등록','badge'),el('p',r.state??'미등록'));
      if(r.holdReason)c.append(el('p','보류 사유: '+r.holdReason,'warning'));
      if(r.pendingAttempt)c.append(el('p','전달 결과 확인 전 · 재전송 금지','warning'));
      renderContinuation(c,r.progress);
      if(r.terminalSha256){c.append(el('span','현재 표시된 마지막 응답 SHA-256','meta'),el('code',r.terminalSha256,'terminal'));}
      c.append(el('p','다음 확인 '+date(r.nextCheckAt)+' · 기록된 한도 회복 예정 '+date(r.nextResetAt)+' (현재 준비 보장 아님)','meta'));$('threads').append(c);
    }
    const cliStates={STOPPED_FOR_MAINTENANCE:'자동재개 중지 · 실행기 정비 중',PENDING_DELIVERY_RECONCILIATION:'자동재개 보류 · 원래 전달 결과 확인 필요',ORIGINAL_ISSUER_SUPPORT_UNPROVEN:'자동재개 미확인 · 원 발신 경로 검증 필요'};
    const cliText=cliStates[s.cliRuntime?.state]??'자동재개 상태 미확인';
    $('threadStatus').textContent=`${rows.length}개 대화 · ${cliText} · 마지막 보고 ${date(s.worker.heartbeatAt)}`;
    if(s.unresolved.length){operationId=s.unresolved[0].operationId;$('operationPanel').hidden=false;$('operationState').textContent='원래 변경 '+operationId+' · '+s.unresolved[0].state+' · 자동 재전송하지 않습니다.';}
  }finally{$('refreshThreads').disabled=false;updateQueueButtons();}
}
function selected(){return [...$('threads').querySelectorAll('input:checked')].map(x=>rows.find(r=>r.threadId===x.value));}
function updateQueueButtons(){const s=selected();for(const b of $('threadActions').querySelectorAll('button')){const action=b.dataset.action;b.disabled=queueBusy||!s.length||(action==='Register'?s.some(r=>r.registered):s.some(r=>!r.registered))||(action==='Resume'&&s.some(r=>!r.holdReason||!r.terminalSha256))||(['Enable','Resume','Complete'].includes(action)&&s.some(r=>r.pendingAttempt));}}
async function showPreview(request){
  if(queueBusy||confirmBusy||$('confirmDialog').open)throw Error(errors.mutation_busy);
  preview=null;queueBusy=true;updateQueueButtons();
  try{const p=await api('preview',request);preview=p;$('previewSummary').replaceChildren(...p.summary.map(x=>el('li',x)));$('previewExpiry').textContent='확인 유효 시각 '+date(p.expiresAt);$('confirmChange').disabled=false;$('confirmDialog').showModal();}
  finally{queueBusy=false;updateQueueButtons();}
}
async function readOperation(){
  if(!operationId)return;
  const id=operationId,r=await api('operation?id='+encodeURIComponent(id));
  $('operationPanel').hidden=false;$('operationState').textContent=`${id} · ${r.state} · 설정 처리 대상 ${(r.completed??[]).length}개${r.ownerTerminal?' · 기존 실행기 '+r.ownerTerminal:''} · 작업 재개·전체 목표 완료와 별개`;
  if(r.state==='COMPLETED'&&refreshedOperationId!==id){
    if(r.kind==='tray-tool'&&toolsView){toolsView.showResult(r.toolResult);await toolsView.load();}
    else if(['account','account-order','quota-policy','quota-warning'].includes(r.kind)&&quotaView)await quotaView.applied(r.kind);
    else if(r.kind==='web')await loadWeb();else await readThreads();refreshedOperationId=id;
  }
  if(r.state==='READ_FAILED'){toolsView?.showResult(r.toolResult);$('operationState').textContent+=' · 조회 실패, 변경 요청은 발신하지 않았습니다.';}
  return r;
}
async function confirmChange(){
  if(!preview||confirmBusy)return;const p=preview;preview=null;confirmBusy=true;$('confirmChange').disabled=true;$('confirmDialog').close();
  try{
    const result=await api('confirm',{confirmationToken:p.confirmationToken});operationId=result.operationId;rememberOperation(operationId);$('operationPanel').hidden=false;const status=await readOperation();
    notice(status?.state==='COMPLETED'?'요청이 완료되어 화면을 갱신했습니다.':status?.state==='READ_FAILED'?'조회하지 못했습니다. 변경 요청은 발신하지 않았습니다.':'요청을 한 번 전달했습니다. 원래 결과 조회로 완료 여부를 확인하세요.');
  }finally{confirmBusy=false;updateQueueButtons();}
}
function renderTray(s){
  $('quotaStatus').textContent=(s.quotaStatus??'한도 미확인')+' · 조회 '+date(s.observedAt)+(s.quotaFresh?' · 새 조회 응답':' · 캐시이며 현재 여유를 보장하지 않음');
  $('quotaPolicy').textContent=s.effectivePolicy?`소유자 정책: 5시간 ${s.effectivePolicy.fiveHourUsedThreshold??'?'}% 사용 시 ${s.effectivePolicy.fiveHourAction??'?'} / 장기 ${s.effectivePolicy.longWindowUsedThreshold??'?'}% 사용 시 ${s.effectivePolicy.longWindowAction??'?'}`:'차단 정책 미확인';
  $('accountRows').replaceChildren();
  for(const a of s.accounts){const c=el('article',null,'card');c.append(el('h3',a.name??a.selector),el('p',`${a.active?'현재 선택 · ':''}${a.status}`),el('p',`5시간 남음 ${a.shortRemaining??'?'}% · 회복 ${a.shortReset??'?'} / 장기 남음 ${a.longRemaining??'?'}% · 회복 ${a.longReset??'?'}`),el('p','한도 관찰 '+date(a.quotaObservedAt),'meta'));
    const actions=el('div',null,'actions');for(const [action,label] of [['use','이 계정 사용'],[a.paused?'resume':'pause',a.paused?'계정 재개':'일시중지'],['unpin','자동 선택']]){const b=button(label,()=>perform(()=>showPreview({kind:'account',action,selector:a.selector,identityHash:a.identityHash})));b.disabled=s.controlNeedsReconcile||!s.selectionVerified||(action==='use'&&(a.active||a.paused||['한도 차단','로그인 필요','확인 필요','선택 미확인'].includes(a.status)));actions.append(b);}c.append(actions);
    const pri=field(c,'우선순위 (-100~100)','number',a.priority??0);pri.min=-100;pri.max=100;const save=button('우선순위 미리보기',()=>perform(()=>showPreview({kind:'account',action:'priority',selector:a.selector,identityHash:a.identityHash,priority:Number(pri.value)})));save.disabled=s.controlNeedsReconcile||!s.selectionVerified;c.append(save);$('accountRows').append(c);
  }
}
async function loadTray(refresh=false){$('readTray').disabled=$('refreshQuota').disabled=true;try{renderTray(await api(refresh?'refresh-quota':'tray',refresh?{}:undefined));}finally{$('readTray').disabled=$('refreshQuota').disabled=false;}}
function targetCard(t={id:'chat-'+crypto.randomUUID().slice(0,8),enabled:false,role:'default',conversationUrl:'',autoResume:false,autoResumeMode:'response-only'}){
  const c=el('article',null,'card');c.dataset.target='true';c._fields={};const f=c._fields;
  f.id=field(c,'대상 이름','text',t.id);f.id.maxLength=96;
  f.enabled=field(c,'이 대화 정체 감시','checkbox',t.enabled);f.role=select(c,'등록 계정',[['default','기본 등록 계정'],['secondary','보조 등록 계정']],t.role);f.url=field(c,'원래 대화 URL','url',t.conversationUrl);
  f.auto=field(c,'정체 응답 중지 후 고정 문구로 재개','checkbox',t.autoResume);f.mode=select(c,'재개 조건',[['response-only','응답만 재개 · 외부 결과 UNKNOWN'],['strict-external','기존 외부 작업 영수증 확인 후 재개']],t.autoResumeMode);
  if(t.hasExternalReceipt)c.append(el('p','PC에 결속된 기존 외부 영수증을 보존합니다.','meta'));c.append(button('대상 제거',()=>c.remove()));$('webTargets').append(c);
}
function grantCard(g={id:'grant-'+crypto.randomUUID().slice(0,8),enabled:false,sourceTargetId:'',recipientIds:[],purpose:'',templateText:'',inputFields:[],expiresAt:new Date(Date.now()+86400000).toISOString()}){
  const c=el('article',null,'card');c.dataset.grant='true';const f=c._fields={};f.id=field(c,'승인 이름','text',g.id);f.enabled=field(c,'이 정확한 전달 범위 승인','checkbox',g.enabled);f.enabled.disabled=!web.runner.peerDispatchSupported;
  const choices=[['','대상 선택'],...[...$('webTargets').querySelectorAll('[data-target]')].map(c=>[c._fields.id.value,c._fields.id.value])];f.source=select(c,'발신 대상',choices,g.sourceTargetId);f.recipients=field(c,'수신 대상 이름 (쉼표 구분)','text',g.recipientIds.join(','));f.purpose=field(c,'전달 목적','text',g.purpose);f.purpose.maxLength=200;f.template=field(c,'정확한 전달 틀 · 입력 위치는 {{field}}','textarea',g.templateText);f.template.maxLength=2000;f.fields=field(c,'허용 입력 · 한 줄에 이름:최대길이 (예: task:300)','textarea',g.inputFields.map(x=>x.name+':'+x.maxLength).join('\n'));f.expiry=field(c,'만료 시각 (ISO 8601)','text',g.expiresAt);c.append(button('승인 제거',()=>c.remove()));$('grants').append(c);
}
async function loadWeb(){
  $('readWeb').disabled=true;$('webFields').disabled=true;$('webStatus').textContent='설정과 등록 계정 확인 중…';
  try{web=await api('web');$('webEnabled').checked=web.config.enabled;$('webInterval').value=web.config.intervalSeconds;$('webTargets').replaceChildren();$('grants').replaceChildren();web.config.targets.forEach(targetCard);web.config.peerGrants.forEach(grantCard);$('webStatus').textContent=`타이머 ${web.runner.reportedState??web.runner.liveStatus} · ${web.runner.receiptFresh?'최근 보고 있음':'최근 보고 미확인'} · 실제 프로세스 생존 ${web.runner.processLivenessVerified?'확인':'별도 확인 필요'} · 전달 기능 ${web.runner.peerDispatchSupported?'설치 지원':'미지원'}`;$('webFields').disabled=false;}
  finally{$('readWeb').disabled=false;}
}
function webRequest(){
  const targets=[...$('webTargets').querySelectorAll('[data-target]')].map(c=>{const f=c._fields;return{id:f.id.value.trim(),enabled:f.enabled.checked,role:f.role.value,conversationUrl:f.url.value.trim(),autoResume:f.auto.checked,autoResumeMode:f.mode.value};});
  const peerGrants=[...$('grants').querySelectorAll('[data-grant]')].map(c=>{const f=c._fields;return{id:f.id.value.trim(),enabled:f.enabled.checked,sourceTargetId:f.source.value,recipientIds:f.recipients.value.split(',').map(x=>x.trim()).filter(Boolean),purpose:f.purpose.value,templateText:f.template.value,inputFields:f.fields.value.split('\n').map(x=>x.trim()).filter(Boolean).map(line=>{const [name,size]=line.split(':');return{name,maxLength:Number(size)};}),expiresAt:f.expiry.value};});
  return {kind:'web',config:{schemaVersion:1,expectedRevision:web.revision,enabled:$('webEnabled').checked,intervalSeconds:Number($('webInterval').value),targets,peerGrants}};
}
$('refreshThreads').onclick=()=>perform(readThreads);$('readTray').onclick=()=>perform(()=>loadTray());$('refreshQuota').onclick=()=>perform(()=>loadTray(true));$('readWeb').onclick=()=>perform(loadWeb);$('readGoals').onclick=()=>perform(loadGoals);
for(const b of $('threadActions').querySelectorAll('button'))b.onclick=()=>perform(()=>showPreview({kind:'continuity',action:b.dataset.action,targets:selected().map(r=>({threadId:r.threadId,terminalSha256:r.terminalSha256}))}));
$('confirmChange').onclick=()=>perform(confirmChange);$('cancelConfirm').onclick=()=>{preview=null;$('confirmDialog').close();};$('confirmDialog').addEventListener('cancel',()=>{preview=null;});
$('readOperation').onclick=()=>perform(readOperation);$('addWeb').onclick=()=>targetCard();$('addGrant').onclick=()=>grantCard();$('saveWeb').onclick=()=>perform(()=>showPreview(webRequest()));
async function loadDevices(){
  const value=await api('devices');$('devices').replaceChildren();
  if(!value.devices.length){$('devices').append(el('p','계속 허용한 기기가 없습니다.'));return;}
  for(const d of value.devices){const card=el('article',null,'card');card.append(el('strong',d.label),el('p','등록 '+date(d.createdAt),'meta'),button('이 기기 허용 해제',()=>perform(async()=>{if(!window.confirm(d.label+' 기기의 계속 허용을 해제할까요?'))return;await api('revoke-device',{deviceId:d.id});await loadDevices();})));$('devices').append(card);}
}
$('readDevices').onclick=()=>perform(loadDevices);
$('pair').onclick=()=>perform(async()=>{const p=await api('pair',{remember:$('remember').checked,deviceName:$('deviceName').value});$('pairUrl').value=p.url;$('pairLink').hidden=false;$('pairExpiry').textContent='한 번만 사용 · '+date(p.expiresAt)+'까지';setTimeout(()=>{$('pairUrl').value='';$('pairLink').hidden=true;},120000);});
$('copyPair').onclick=()=>perform(async()=>{await navigator.clipboard.writeText($('pairUrl').value);notice('휴대폰 연결 링크를 복사했습니다. 링크를 받은 기기만 연결할 수 있게 보관하세요.');});
$('logout').onclick=()=>perform(async()=>{await api('logout',{});location.reload();});$('revoke').onclick=()=>perform(async()=>{if(!window.confirm('모든 휴대폰 연결과 아직 사용하지 않은 링크를 철회할까요?'))return;await api('revoke',{});location.reload();});
const coworkView=createCoworkView();
const panels=['overview','apps','accounts','tools','conversations','web','goals','orchestration','cowork','settings'];
let appSnapshot=null,appsBusy=false;
const appStates={WEB:'웹에서 열기',PC_ONLY:'PC 전용',UNAVAILABLE:'주소 미등록',RETIRED:'사용 종료'};
const appHelp={
  PC_ONLY:'이 앱은 PC에서 직접 사용하세요.',
  UNAVAILABLE:'휴대폰에서 열 수 있는 주소가 등록되면 여기에서 열 수 있습니다.',
  RETIRED:'사용을 종료했거나 다른 앱에 통합되었습니다. 기존 기록은 보존합니다.'
};
const appDetail=$('appDetail');
const recentAppsKey='aicc.mobile.recentApps';
let recentApps=[];
try {
  const saved=JSON.parse(localStorage.getItem(recentAppsKey));
  if(Array.isArray(saved))recentApps=[...new Set(saved.filter(id=>typeof id==='string'))].slice(0,3);
}catch{}
function registeredAppUrl(app){
  if(!app.registered||app.state!=='WEB'||!app.url)return null;
  if(app.id==='aicc'&&app.url==='/mobile.html#ai-reports')return new URL(app.url,location.origin);
  try{
    const url=new URL(app.url);
    if(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash)return url;
  }catch{}
  return null;
}
function appOpenLink(app,url,label='열기'){
  const open=el('a',label,'app-open');open.href=url.href;open.setAttribute('aria-label',app.title+' 열기');
  if(url.origin!==location.origin){open.target='_blank';open.rel='noopener noreferrer';}
  const remember=()=>{
    recentApps=[app.id,...recentApps.filter(id=>id!==app.id)].slice(0,3);
    try{localStorage.setItem(recentAppsKey,JSON.stringify(recentApps));}catch{}
    if(!open.closest('#appQuick'))renderQuickApps();
  };
  open.addEventListener('click',remember);
  open.addEventListener('auxclick',event=>{if(event.button===1)remember();});
  return open;
}
function updateNextStep(){
  const link=$('nextStepLink'), text=$('nextStepText');
  const openable=appSnapshot?.apps.filter(app=>registeredAppUrl(app)).length??0;
  if(openable){
    text.textContent=`마지막으로 읽은 목록에 웹 주소가 등록된 앱이 ${openable}개 있습니다.`;
    link.href='#apps';
    link.textContent='내 앱 열기';
  }else if(appSnapshot?.status==='AVAILABLE'){
    text.textContent='웹에서 열 수 있는 등록 앱이 없습니다. 공통 도구에서 PC 전용 작업도 확인할 수 있습니다.';
    link.href='#tools';
    link.textContent='도구 안내 보기';
  }else{
    text.textContent='내 앱에서 등록 목록을 조회하고 사용할 수 있는 화면을 확인하세요.';
    link.href='#apps';
    link.textContent='내 앱 불러오기';
  }
}
function renderQuickApps(){
  const apps=appSnapshot?.apps??[];
  const items=[];
  for(const id of new Set([...recentApps,'aicc'])){
    if(id==='aicc'&&items.length&&!recentApps.includes(id))break;
    const app=apps.find(row=>row.id===id);
    const url=app&&registeredAppUrl(app);
    if(url){const item=el('li');item.append(appOpenLink(app,url,app.title));items.push(item);}
    if(items.length===3)break;
  }
  $('appQuickRows').replaceChildren(...items);
  $('appQuick').hidden=!items.length;
  $('appQuickHint').textContent=recentApps.length?'여기서 최근에 연 앱을 이 브라우저에 표시합니다.':'이 화면에서 앱을 열면 빠른 실행에 표시합니다.';
}
function showAppDetail(app,url,state){
  $('appDetailTitle').textContent=app.title;
  $('appDetailState').textContent=appStates[state]??'확인 필요';
  $('appDetailState').dataset.state=state;
  $('appDetailDescription').textContent=app.description;
  $('appDetailDescription').hidden=!app.description;
  const actions=$('appDetailActions');actions.replaceChildren();
  if(url){
    const install=el('a','설치·업데이트 안내','app-secondary');
    install.href=app.id==='aicc'?'/install.html':'/install.html#app='+encodeURIComponent(app.id);
    actions.append(appOpenLink(app,url),install);
  }
  $('appDetailHelp').textContent=url
    ? app.id==='aicc'
      ? 'AICC는 웹앱 설치와 Android 다운로드를 지원합니다. 이 브라우저에서 설치 안내와 업데이트 방법을 확인하세요.'
      : '등록된 웹 주소에서 열 수 있습니다. 휴대폰 설치 지원, 현재 설치 상태와 새 버전은 각 앱에서 확인하세요.'
    : appHelp[state]??'등록 상태를 확인한 뒤 다시 조회하세요.';
  appDetail.showModal();
}
function renderApps(){
  if(!appSnapshot)return;
  const search=$('appSearch').value.trim().toLocaleLowerCase('ko-KR'),filter=$('appFilter').value;
  const all=appSnapshot.apps;
  const fragment=document.createDocumentFragment();
  let shown=0,webCount=0;
  for(const app of all){
    const url=registeredAppUrl(app);
    const state=app.state==='WEB'&&!url?'UNAVAILABLE':app.state;
    if(url)webCount++;
    const matchingState=filter==='all'||(filter==='active'?state!=='RETIRED':state===(filter==='web'?'WEB':filter));
    if(!matchingState||!`${app.title} ${app.description} ${app.id}`.toLocaleLowerCase('ko-KR').includes(search))continue;
    shown++;
    const card=el('article',null,'app-card');
    const badge=el('p',appStates[state]??'확인 필요','app-badge');badge.dataset.state=state;
    card.append(badge,el('h4',app.title));
    if(app.description)card.append(el('p',app.description,'app-description'));
    if(appHelp[state])card.append(el('p',appHelp[state],'meta'));
    const actions=el('div',null,'app-card-actions');
    if(url)actions.append(appOpenLink(app,url));
    const detail=button(url?'설치·업데이트':'자세히',()=>showAppDetail(app,url,state));
    detail.setAttribute('aria-label',app.title+(url?' 설치·업데이트':' 자세히'));
    actions.append(detail);
    card.append(actions);fragment.append(card);
  }
  if(!shown){
    const empty=el('div',null,'app-empty');
    empty.append(el('p',all.length?'조건에 맞는 앱이 없습니다.':'등록된 앱이 없습니다.'));
    if(all.length)empty.append(button('검색·필터 초기화',()=>{
      $('appSearch').value='';$('appFilter').value='all';renderApps();$('appSearch').focus();
    }));
    fragment.append(empty);
  }
  $('appRows').replaceChildren(fragment);
  $('appResultCount').textContent=`등록 ${all.length}개 · 표시 ${shown}개 · 웹 ${webCount}개`;
}
async function loadApps(){
  if(appsBusy||!session)return;appsBusy=true;$('readApps').disabled=true;$('appsStatus').textContent='등록된 앱을 읽고 있습니다…';$('appRows').setAttribute('aria-busy','true');
  try{
    const value=await api('apps');
    if(!Array.isArray(value.apps))throw Error('앱 목록 응답을 확인할 수 없습니다.');
    if(value.status==='PARTIAL'&&appSnapshot?.status==='AVAILABLE'){
      $('appsStatus').textContent='일부 등록 자료를 읽지 못했습니다. 마지막 전체 목록을 유지했습니다. 다시 조회하세요.';
      return;
    }
    appSnapshot=value;renderApps();renderQuickApps();updateNextStep();
    $('appsStatus').textContent=value.status==='PARTIAL'
      ? '확인된 앱만 표시합니다. 전체 목록은 다시 조회하세요.'
      : '목록 확인 '+date(value.observedAt);
  }
  catch(error){$('appsStatus').textContent='앱 목록 조회 실패 · '+error.message+(appSnapshot?' 마지막 목록은 유지했습니다.':' 연결 후 다시 조회하세요.');}
  finally{appsBusy=false;$('readApps').disabled=!session;$('appRows').setAttribute('aria-busy','false');}
}
$('readApps').onclick=()=>void loadApps();$('appSearch').oninput=renderApps;$('appFilter').onchange=renderApps;
const mobileNavigation=document.querySelector('nav[aria-label="관리 항목"]');
if(mobileNavigation&&'ResizeObserver' in window)new ResizeObserver(()=>{
  document.documentElement.style.setProperty('--mobile-nav-height',Math.ceil(mobileNavigation.getBoundingClientRect().height)+'px');
}).observe(mobileNavigation);
let viewSettings={text:100,quota:'both',refreshSeconds:30};
try{const v=JSON.parse(localStorage.getItem('aiccMobileView')??'null');if(v){if([100,110,125].includes(v.text))viewSettings.text=v.text;if(['both','used','remaining'].includes(v.quota))viewSettings.quota=v.quota;if([30,60,120].includes(v.refreshSeconds))viewSettings.refreshSeconds=v.refreshSeconds;}}catch{}
function applyViewSettings(){window.aiccMobileView={...viewSettings};document.documentElement.style.fontSize=viewSettings.text+'%';document.documentElement.dataset.quotaDisplay=viewSettings.quota;$('viewText').value=viewSettings.text;$('viewQuota').value=viewSettings.quota;$('viewRefresh').value=viewSettings.refreshSeconds;window.dispatchEvent(new Event('aicc:view-settings'));}
for(const id of ['viewText','viewQuota','viewRefresh'])$(id).onchange=()=>{viewSettings={text:Number($('viewText').value),quota:$('viewQuota').value,refreshSeconds:Number($('viewRefresh').value)};applyViewSettings();try{localStorage.setItem('aiccMobileView',JSON.stringify(viewSettings));$('viewSaved').textContent='이 브라우저의 화면 설정을 저장했습니다.';}catch{$('viewSaved').textContent='이번 화면에 적용했습니다. 브라우저 저장은 허용되지 않았습니다.';}};
applyViewSettings();$('settings').append($('pairPanel'),$('help'));
const panelNames={overview:'전체 개발 현황',apps:'내 앱',accounts:'계정·한도',tools:'도구',conversations:'작업·대화',web:'웹 감독',goals:'목표',orchestration:'협업 실행',cowork:'AICC 관리기',settings:'설정'};
function openPanel(id,load=true){
  id=id||'overview';
  if(id!=='apps'&&appDetail.open)appDetail.close();
  const primary=['overview','apps','ai-reports','ai-queue','settings'];
  for(const a of document.querySelectorAll('nav[aria-label="관리 항목"] a')){a.hidden=!primary.includes(a.hash.slice(1));if(a.hash==='#'+id)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
  if(['ai-reports','ai-work','ai-queue'].includes(id)){
    for(const name of panels)$(name).hidden=true;
    document.title='AI 통합 대시보드 · AICC';return id || 'ai-reports';
  }
  if(!panels.includes(id))id='accounts';
  for(const name of panels)$(name).hidden=name!==id;
  for(const a of document.querySelectorAll('nav[aria-label="관리 항목"] a')){
    if(a.hash==='#'+id)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
  }
  document.title=panelNames[id]+' · AICC';
  if(id==='cowork')void coworkView.load();
  $('readApps').disabled=!session;
  if(!session)return id;
  if(load){if(id==='apps')void loadApps();else if(id==='accounts'&&quotaView)void perform(()=>quotaView.load());else if(id==='tools'&&toolsView)void perform(()=>toolsView.load());else if(id==='orchestration')void perform(loadOrchestration);else if(id==='goals')void loadGoals();else if(id==='conversations')void perform(readThreads);else if(id==='web')void perform(loadWeb);}
  return id;
}
function navigatePanel(id,load=true){
  if(location.hash!=='#'+id)history.pushState(null,'',location.pathname+'#'+id);
  openPanel(id,load);window.dispatchEvent(new Event('aicc:panel-change'));window.scrollTo({top:0,behavior:'instant'});
  const heading=$(['ai-reports','ai-work','ai-queue'].includes(id)?'aiWorkspace':id)?.querySelector('h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
}
for(const a of document.querySelectorAll('nav[aria-label="관리 항목"] a[href^="#"], #nextStepLink'))a.onclick=e=>{
  if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
  e.preventDefault();navigatePanel(a.hash.slice(1));
};
window.addEventListener('popstate',()=>openPanel(location.hash.slice(1)));
window.addEventListener('hashchange',()=>{
  // A newly opened pairing link may only change this document's fragment.
  // Load it once so connect() consumes the original one-use token normally.
  if(new URLSearchParams(location.hash.slice(1)).has('pair')){location.reload();return;}
  openPanel(location.hash.slice(1));
});
window.addEventListener('offline',()=>{$('connection').classList.add('offline');$('connection').textContent='네트워크 연결 없음 · 표시된 값은 마지막 조회입니다.';});
window.addEventListener('online',()=>{if(session&&!connecting)void perform(syncSession);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&session&&!connecting)void perform(syncSession);});
const toolRoutes={
  account:['accounts'], 'quota-policy':['accounts','quotaPolicyForm'], 'quota-warnings':['accounts','quotaWarningForm'],
  devices:['settings','pairPanel'],view:['settings','viewText'],help:['settings','help'],
  queue:['conversations','threads'],'queue-message':['conversations','threadActions'],'web-config':['web'],
  overview:['overview'],'ai-reports':['ai-reports'],'ai-queue':['ai-queue'],goals:['goals']
};
async function openToolTarget(item){
  if(item.route==='install'){location.assign('/install.html');return;}
  if(item.route==='supervise'){location.assign('/supervise.html');return;}
  const destination=Object.hasOwn(toolRoutes,item.route)&&toolRoutes[item.route];
  if(!destination)throw Error('이 도구의 연결을 확인할 수 없습니다. 목록을 다시 조회하세요.');
  const [panel,targetId]=destination;
  navigatePanel(panel,item.action!=='refresh');
  if(item.action==='refresh'){await quotaView.load(true);return;}
  if(item.route==='queue-message')notice('대화 큐에서 정확한 대상을 선택하세요. Desktop 메시지 전달은 공식 도구를 가진 별도 발신자가 필요합니다.');
  if(item.route==='devices'&&!session.local){notice('기기 연결과 철회는 PC에서 AICC 앱을 열어 진행하세요.');return;}
  const actionTarget={ 'quota-display':'viewQuota','refresh-interval':'viewRefresh','find-thread':'refreshThreads' };
  const target=$(actionTarget[item.action]??targetId);
  if(!target)return;
  const detail=target.closest('details');
  if(detail)detail.open=true;
  const focus=detail?.querySelector('summary')??target;
  if(focus.tabIndex<0)focus.tabIndex=-1;
  focus.focus({preventScroll:true});target.scrollIntoView({block:'start'});
}
const initialFragment=new URLSearchParams(location.hash.slice(1));
let pairToken=initialFragment.get('pair'),connecting=false;
openPanel(pairToken?'accounts':location.hash.slice(1),false);
async function connect(){
  if(connecting)return;connecting=true;let authenticated=false;$('retrySession').disabled=true;
  try{
    if(pairToken){const token=pairToken;pairToken=null;history.replaceState(null,'',location.pathname+'#accounts');acceptSession(await request('exchange',{token}));}
    else{await syncSession();}
    authenticated=true;enableSession();$('localHelp').hidden=!session.local;
    $('authPanel').hidden=true;document.body.classList.remove('auth-required','connecting');
    quotaView??=createQuotaView({api,perform,showPreview,onToolAction:async(action,account)=>{navigatePanel('tools',false);if(action==='order')return toolsView.openOrder();return toolsView.openAction(action,account);}});
    toolsView??=createMobileToolsView({api,perform,showPreview,onRootAction:openToolTarget});
    operationId=operationId??storedOperation();
    if(operationId){$('operationPanel').hidden=false;$('operationState').textContent='이전 변경 '+operationId+' · 원래 결과를 조회하세요.';}
    openPanel(location.hash.slice(1)||'overview');window.dispatchEvent(new Event('aicc:panel-change'));
  }catch(error){
    if(authenticated){notice(error.message);return;}
    session=null;csrf=null;$('readOrchestration').disabled=true;document.body.classList.remove('connecting');document.body.classList.add('auth-required');
    $('connection').textContent=error.code==='pair_required'?'연결 필요 · 기존 PC 작업은 유지됩니다.':'연결 응답 대기 · 기존 PC 작업은 유지됩니다.';
    $('authTitle').textContent=error.code==='pair_required'?'이 브라우저를 연결해 주세요':'연결 상태를 확인해 주세요';
    $('authPanel').hidden=false;$('authMessage').textContent=error.message;
    notice('');
  }finally{connecting=false;$('retrySession').disabled=false;}
}
$('retrySession').onclick=()=>void connect();
async function loadOrchestration(){
  const button=$('readOrchestration'), status=$('orchestrationStatus'), container=$('orchestrationRows');
  button.disabled=true;status.textContent='협업 실행 원장 조회 중…';
  const queueRead=Promise.all([loadWebQueue(),loadWorkActivity(),loadPendingWork()]);
  const states={PLANNED:'계획됨',QUEUED:'대기',LEASED:'접수됨',RUNNING:'실행 기록',VERIFYING:'검증 중',COMPLETED:'종료 기록',FAILED:'실패 기록',CANCELLED:'취소 기록',PAUSED:'일시 정지',UNKNOWN:'미확인'};
  const kinds={coordinator:'관제',researcher:'조사',critic:'검토',solver:'개발',merger:'통합',writer:'작성',verifier:'검증'};
  try{
    const result=await api('orchestration');
    if(!Array.isArray(result.runs))throw Error('응답을 확인할 수 없습니다.');
    if(result.status==='UNKNOWN')throw Error('원장 상태를 확인할 수 없습니다.');
    const rows=document.createDocumentFragment();
    status.textContent=result.status==='UNKNOWN'?'협업 원장 확인 필요':result.status==='NOT_INITIALIZED'||result.status==='EMPTY'?'저장된 협업 실행이 없습니다.':`${result.total}개 중 ${result.shown}개 · 조회 ${date(result.observedAt)}`;
    for(const run of result.runs){
      const card=el('article',null,'card');card.append(el('h3','협업 실행 · '+(states[run.state]??'미확인')),el('p','원장 갱신 '+date(run.updatedAt),'meta'));
      for(const role of run.roles)card.append(el('p',`${role.label} · ${kinds[role.kind]??'종류 미확인'} · ${states[role.state]??'미확인'}${role.resultRecorded?' · 결과 기록 있음':''}`));
      card.append(el('p',run.parentGoalLinked?'목표 연결 기록 있음 · 내장 goal 권한 미확인':'목표 연결 기록 없음','meta'));rows.append(card);
    }
    rows.append(el('p',result.nextAction,'muted'));container.replaceChildren(rows);
  }catch(error){status.textContent='협업 조회 실패 · '+error.message+(container.childElementCount?' 표시된 내용은 마지막 조회 기록입니다.':' 다시 조회해 주세요.');}
  finally{await queueRead;button.disabled=!session;}
}
async function loadWorkActivity(){
  if(activityBusy || !session)return;
  activityBusy=true;
  const status=$('workActivityStatus'),container=$('workActivityRows');
  status.textContent='작업 관측 조회 중…';
  try{
    const result=await api('work-activity');
    if(result.status==='UNKNOWN'||!Array.isArray(result.items))throw Error('원장 관측을 확인할 수 없습니다.');
    const states={RECENT_EXECUTION:'최근 실행 관측',RECENT_EXECUTION_EVENT:'최근 코덱스 실행 기록',TURN_ENDED:'차례 종료 기록',INTERRUPTED:'차례 중단 기록',RECENT_TOOL_ADMISSION:'최근 도구 요청 접수',STALE_OR_WAITING:'대기 또는 관측 오래됨',PAUSED:'일시 정지 기록',UNKNOWN:'확인 불가'};
    const actors={CODEX_CLI:'등록된 로컬 코덱스',WEB_ROUTE:'웹 경로 · 에이전트 종류 미확인',LOCAL_AGENT:'로컬 에이전트 경로',REMOTE_AGENT:'원격 에이전트 · 종류 미확인',UNKNOWN:'실행 주체 미확인'};
    const rows=document.createDocumentFragment();
    for(const item of result.items){
      const card=el('article',null,'card');
      const name=item.actor==='CODEX_CLI'&&typeof item.displayName==='string'&&item.displayName.trim()&&item.displayName.length<=160&&!/[\x00-\x1f\x7f]/.test(item.displayName)?item.displayName.trim():null;
      card.append(el('h4',name??(actors[item.actor]??actors.UNKNOWN)));
      if(name)card.append(el('p','등록된 코덱스 대화 이름 · 현재 담당·작성권과 별개','meta'));
      card.append(el('p',states[item.state]??states.UNKNOWN),el('p','마지막 관측 '+date(item.lastObservedAt),'meta'));rows.append(card);
    }
    if(!result.items.length)rows.append(el('p','관측 가능한 등록 작업이 없습니다. 다른 에이전트가 멈췄다는 뜻은 아닙니다.'));
    rows.append(el('p',result.nextAction,'muted'));
    if(result.partial)rows.append(el('p','일부 관측을 확인하지 못했습니다. 확인된 기록만 표시합니다.','muted'));
    if(result.truncated)rows.append(el('p','최근 24건만 표시합니다.','meta'));
    container.replaceChildren(rows);
    status.textContent=`조회 ${date(result.observedAt)} · 최근 ${result.freshnessSeconds}초 기준`;
  }catch(error){status.textContent='작업 관측 조회 실패 · '+error.message+(container.childElementCount?' 표시된 내용은 마지막 조회 기록입니다.':'');}
  finally{activityBusy=false;}
}
async function loadPendingWork(){
  if(handoffBusy || !session)return;
  handoffBusy=true;
  const status=$('pendingWorkStatus'),container=$('pendingWorkRows');
  status.textContent='인계함 조회 중…';
  try{
    const result=await api('pending-work');
    if(result.status==='UNKNOWN'||!Array.isArray(result.items))throw Error('인계 문서를 확인하지 못했습니다. PC의 원 인계함을 확인하세요.');
    const states={PENDING:'인수 대기',CLAIMED:'담당자가 인수함',MERGED:'정본에 통합됨 · 개발 완료와 별개'};
    const rows=document.createDocumentFragment();
    for(const item of result.items){
      const card=el('article',null,'card');
      card.append(el('h4',item.priority+' · '+item.title),el('p','보낸 지피티: '+item.displayName),el('p',states[item.state]??'상태 미확인'));
      if(item.conversationUrl){
        const url=new URL(item.conversationUrl);
        if(url.origin!=='https://chatgpt.com'||url.username||url.password||url.search||url.hash||!/^\/(?:g\/[^/]+\/)?c\/[a-f0-9-]{36}$/.test(url.pathname))throw Error('원 대화 링크를 확인하지 못했습니다.');
        const link=el('a','원 지피티 대화 열기');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';card.append(link);
      }else card.append(el('p','원 대화 링크 미확인','muted'));
      card.append(el('p','등록 '+date(item.createdAt),'meta'));rows.append(card);
    }
    if(!result.items.length)rows.append(el('p',result.partial?'확인된 새 형식 인계 문서가 없습니다. 이전 문서는 PC의 원 인계함에서 확인하세요.':'대기 중인 인계 문서가 없습니다. 통합된 작업은 해당 프로젝트에서 계속 관리합니다.'));
    rows.append(el('p',result.nextAction,'muted'));
    if(result.partial)rows.append(el('p',result.status==='LEGACY_ONLY'?`이전 형식 문서 ${result.legacyCount}건을 보존했습니다. 담당자가 원문을 인수한 뒤 정본에 통합합니다.`:'이전 형식 또는 확인하지 못한 문서가 있습니다. 원문은 보존했습니다.','warning'));
    if(result.truncated)rows.append(el('p','우선순위가 높은 24건만 표시합니다.','meta'));
    container.replaceChildren(rows);status.textContent=(result.status==='LEGACY_ONLY'?'이전 형식 문서 확인 필요 · ':'조회 ')+date(result.observedAt);
  }catch(error){status.textContent='인계함 조회 실패 · '+error.message+(container.childElementCount?' 표시된 내용은 마지막 조회 기록입니다.':'');}
  finally{handoffBusy=false;}
}
function scheduleWorkActivity(){
  clearTimeout(activityTimer);
  activityTimer=setTimeout(async()=>{
    if(!document.hidden&&!$('orchestration').hidden&&session)await loadWorkActivity();
    scheduleWorkActivity();
  },viewSettings.refreshSeconds*1000);
}
window.addEventListener('aicc:view-settings',scheduleWorkActivity);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('orchestration').hidden&&session)void loadWorkActivity();});
scheduleWorkActivity();
async function loadWebQueue(){
  const status=$('webQueueStatus'),container=$('webQueueRows');status.textContent='GPT 큐 조회 중…';
  const states={RUNNING:'진행 기록',PAUSED:'일시 정지',COMPLETED:'종료 기록',FAILED:'실패 기록',CANCELLED:'취소 기록',UNKNOWN:'결과 불명 · 재전송 금지'};
  const reasons={SUBMISSION_UNCERTAIN:'원래 전송 결과를 확인해야 합니다.',ROLE_FAILED:'실패한 역할의 원 결과를 확인하세요.',RUN_FAILED:'실패한 실행의 원 결과를 확인하세요.',PAUSED:'기존 큐가 일시 정지되어 있습니다.',NONE:'상태는 저장된 기록이며 실제 업무 완료와 별개입니다.'};
  try{
    const value=await api('web-queue');if(value.status!=='AVAILABLE'||!value.counts||!Array.isArray(value.items))throw Error('기존 큐 연결을 확인해 주세요.');
    const c=value.counts,rows=document.createDocumentFragment();
    status.textContent=`전체 ${c.runs}개 · 진행 ${c.active} · 정지 ${c.paused} · 실패 ${c.failed} · 원장 조회 ${date(value.sourceObservedAt)}`;
    const uncertain=value.items.filter(item=>item.state==='UNKNOWN').length;
    if(uncertain)rows.append(el('p',`표시된 큐 중 결과 불명 ${uncertain}건 · 원래 요청을 확인하세요.`,'warning'));
    if(!c.runs)rows.append(el('p','저장된 GPT 큐가 없습니다.'));
    for(const item of value.items){const card=el('article',null,'card');card.append(el('h4',item.label+' · '+(states[item.state]??states.UNKNOWN)),el('p',`역할 ${item.roles}개 · `+(reasons[item.reason]??reasons.SUBMISSION_UNCERTAIN)));rows.append(card);}
    if(value.itemsTruncated)rows.append(el('p','최근 5건을 표시합니다. 나머지는 PC Chrome 큐 확장에서 확인하세요.','meta'));
    container.replaceChildren(rows);
  }catch(error){status.textContent='GPT 큐 조회 실패 · '+error.message+(container.childElementCount?' 표시된 내용은 마지막 조회 기록입니다.':'');}
}
$('readOrchestration').onclick=()=>perform(loadOrchestration);
void connect().then(()=>{$('readOrchestration').disabled=!session;});
