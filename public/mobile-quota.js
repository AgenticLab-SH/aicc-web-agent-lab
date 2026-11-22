const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const n=document.createElement(tag); if(text!=null)n.textContent=text; if(cls)n.className=cls; return n; };
const percent = value => Number.isFinite(value) && value>=0 && value<=100 ? value : null;
const number = value => percent(value)==null?'미확인':`${Math.round(value*10)/10}%`;
const when = value => { if(!value)return '미확인'; const time=Date.parse(value); return Number.isFinite(time)?new Date(time).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'미확인'; };
function remaining(value){const time=Date.parse(value);if(!Number.isFinite(time)||time<=0)return '미확인';const minutes=Math.ceil((time-Date.now())/60000);if(minutes<=0)return '예정 시각 지남 · 새 관측 필요';const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),mins=minutes%60;return `${days?days+'일 ':''}${hours?hours+'시간 ':''}${mins}분 남음`;}
const resetText=value=>value&&Number.isFinite(Date.parse(value))?`${remaining(value)} · ${when(value)} KST`:'초기화 시각을 제공하지 않았습니다';
export function createQuotaView({api,perform,showPreview,onToolAction}){
  let snapshot=null,busy=false,timer=null,warningFormRevision=null,disposed=false,detailsTimer=null,pendingRounds=0;
  const dirty={policy:false,warning:false}, submitted={},priorityDrafts=new Map();
  const formValue=form=>JSON.stringify([...$(form).querySelectorAll('input,select,textarea')].map(n=>[n.id,n.type==='checkbox'?n.checked:n.value]));
  const root=$('accounts');
  root.classList.add('quota-dashboard');

  root.innerHTML=`<div class="quota-title"><div><p class="eyebrow">OCX · 사용량</p><h2>계정과 사용한도</h2></div><div class="actions"><button id="readTray" disabled>화면 갱신</button><button id="refreshQuota" disabled>사용량 새로 조회</button></div></div>
  <p id="quotaStatus" role="status">연결 후 사용량을 읽습니다.</p><div id="quotaSummary" class="quota-summary"></div><div id="quotaShortcuts" class="quota-shortcuts" aria-label="자주 쓰는 기능"></div><div class="list-toolbar quota-toolbar"><label>계정 찾기<input id="accountSearch" type="search" autocomplete="off" placeholder="이름 검색"></label><label>상태<select id="accountFilter"><option value="all">모든 계정</option><option value="active">현재 선택</option><option value="available">사용 가능</option><option value="paused">일시중지</option><option value="blocked">한도 차단</option></select></label><label>정렬<select id="accountSort"><option value="selected">현재 선택 먼저</option><option value="priority">우선순위 높은 순</option><option value="remaining">5시간 잔여량 순</option><option value="reset">5시간 초기화 순</option></select></label></div><p id="quotaFilterCount" class="meta" role="status"></p><div id="accountRows" class="quota-grid"></div><p id="accountEmpty" class="empty-state" hidden>일치하는 계정이 없습니다. 검색어나 상태 필터를 바꿔 보세요.</p>
  <details class="quota-settings"><summary>한도에 도달했을 때</summary><p id="quotaPolicy"></p><form id="quotaPolicyForm"><fieldset id="quotaPolicyFields" disabled><div class="quota-fields"><label>5시간 차단 사용률 (%)<input id="quotaShortLimit" type="number" min="1" max="100" step="1" required></label><label>주간 차단 사용률 (%)<input id="quotaLongLimit" type="number" min="1" max="100" step="1" required></label><label>5시간 도달 시<select id="quotaShortAction"><option value="switch">다른 계정으로 전환</option><option value="stop">새 요청 중지</option></select></label><label>주간 도달 시<select id="quotaLongAction"><option value="switch">다른 계정으로 전환</option><option value="stop">새 요청 중지</option></select></label></div><p class="muted">사용률 100%를 기준으로 합니다. 트레이와 같은 정책에 저장하며, 진행 중인 응답을 강제로 끊지 않습니다. 적용 대기 상태가 있으면 아래 결과에 표시합니다.</p><p id="policyDirty" class="dirty-note" hidden>수정한 값이 아직 저장되지 않았습니다. 미리보기 후 실행해 주세요.</p><button type="submit">한도 변경 미리보기</button></fieldset></form></details>
  <details class="quota-settings"><summary>사전 경고와 Slack 알림</summary><p>사전 경고는 남은 비율로 설정합니다. 5시간은 일반·긴급, 주간은 긴급만 보냅니다. Slack 전체 현황 알림은 위의 차단 사용률에 도달했을 때 별도로 보냅니다.</p><p id="quotaSlackStatus" role="status"></p><form id="quotaWarningForm"><fieldset id="quotaWarningFields" disabled><div class="quota-toggles"><label><input id="quotaWarningEnabled" type="checkbox"> 사전 경고 전체 켜기</label><label><input id="quotaNormalEnabled" type="checkbox"> 일반 경고 켜기 · 5시간</label><label><input id="quotaUrgentEnabled" type="checkbox"> 긴급 경고 켜기 · 5시간·주간</label><label><input id="quotaSlackEnabled" type="checkbox"> 한도 도달 시 Slack 전체 현황 보내기</label></div><div class="quota-fields"><label>일반 경고 · 남은 비율 (%)<input id="quotaNormalMargin" type="number" min="2" max="100" step="1" required></label><label>긴급 경고 · 남은 비율 (%)<input id="quotaUrgentMargin" type="number" min="1" max="99" step="1" required></label></div><p class="muted">기본 일반 10%·긴급 6%입니다. 차단선과 독립된 값이며 일반 기준은 긴급 기준보다 커야 합니다.</p><label>5시간 일반 경고 문구<textarea id="quotaMessageNormal" maxlength="240" required></textarea></label><label>5시간 긴급 경고 문구<textarea id="quotaMessageUrgent" maxlength="240" required></textarea></label><label>주간 긴급 경고 문구<textarea id="quotaMessageWeekly" maxlength="240" required></textarea></label><p class="muted">문구에서 {account}, {window}, {remaining}을 사용할 수 있습니다. 기존 트레이 설정과 같은 파일에 저장합니다.</p><p id="warningDirty" class="dirty-note" hidden>수정한 알림이 아직 저장되지 않았습니다. 미리보기 후 실행해 주세요.</p><button type="submit">알림 변경 미리보기</button></fieldset></form></details><p class="muted">PC의 독립 웹 실행기와 OCX가 켜져 있으면 AICC 트레이를 꺼도 계정 조회·조작과 한도 도달 Slack 알림이 이어집니다. 휴대폰 탭은 닫아도 됩니다. 초기화권·RDC·복구와 전체 기능은 트레이 도구 탭에서 찾을 수 있습니다. PC 전용 항목은 사용 위치를 표시합니다.</p>`;
  const run=fn=>()=>perform(fn);
  for(const [action,label] of [['order','계정 순서'],['policy','차단 정책'],['warnings','경고·Slack'],['rdc','RDC'],['all-tools','전체 도구']]){
    const b=node('button',label);b.type='button';b.onclick=run(async()=>{
      if(action==='policy'||action==='warnings'){
        const form=$(action==='policy'?'quotaPolicyForm':'quotaWarningForm');form.closest('details').open=true;form.closest('details').scrollIntoView({block:'start'});return;
      }
      await onToolAction?.(action);
    });$('quotaShortcuts').append(b);
  }
  function sortAccounts(){
    if(!snapshot||$('accountRows').contains(document.activeElement))return;
    const accounts=snapshot.accounts??snapshot.tray?.accounts??[],bySelector=new Map(accounts.map(a=>[a.selector,a]));
    const value=(a,key,fallback)=>Number.isFinite(a[key])?a[key]:fallback;
    const reset=a=>Number.isFinite(Date.parse(a.shortResetAt??''))?Date.parse(a.shortResetAt):Infinity;
    const compare=(a,b)=>$('accountSort').value==='priority'?value(b,'priority',0)-value(a,'priority',0):$('accountSort').value==='remaining'?value(b,'shortRemaining',-1)-value(a,'shortRemaining',-1):$('accountSort').value==='reset'?reset(a)-reset(b):Number(b.active)-Number(a.active)||value(b,'priority',0)-value(a,'priority',0);
    const cards=[...$('accountRows').querySelectorAll('article[data-selector]')];cards.sort((a,b)=>compare(bySelector.get(a.dataset.selector)??{},bySelector.get(b.dataset.selector)??{}));for(const card of cards)$('accountRows').append(card);
  }
  function filterAccounts(){
    const query=$('accountSearch').value.trim().toLocaleLowerCase(),filter=$('accountFilter').value;
    let shown=0;
    for(const card of $('accountRows').querySelectorAll('article[data-selector]')){
      const a=(snapshot?.accounts??snapshot?.tray?.accounts??[]).find(a=>a.selector===card.dataset.selector);
      const matches=a&&(!query||String(a.name??a.selector).toLocaleLowerCase().includes(query))&&(filter==='all'||filter==='active'&&a.active||filter==='paused'&&a.paused||filter==='blocked'&&a.status==='한도 차단'||filter==='available'&&!a.paused&&!!a.identityHash&&!['한도 차단','로그인 필요','확인 필요','선택 미확인'].includes(a.status));
      card.hidden=!matches;if(matches)shown++;
    }
    const total=(snapshot?.accounts??snapshot?.tray?.accounts??[]).length;
    $('quotaFilterCount').textContent=total+'개 중 '+shown+'개 표시 · 모든 시각 KST';
    $('accountEmpty').hidden=!total||shown>0;
  }
  $('accountSearch').oninput=filterAccounts;$('accountFilter').onchange=filterAccounts;$('accountSort').onchange=sortAccounts;
  function bar(label,used,reset,limit){
    const box=node('div',null,'quota-window');const heading=node('div',null,'quota-window-title');const value=node('span',null,'quota-window-value');value.append(node('span',`${number(used)} 사용`,'quota-used'),node('span',' · ','quota-separator'),node('span',`${number(used==null?null:100-used)} 남음`,'quota-remaining'));heading.append(node('strong',label),value);box.append(heading);
    const track=node('div',null,'quota-track');if(used!=null){const fill=node('span',null,used>=limit?'blocked':used>=90?'near':'');fill.style.width=used+'%';track.append(fill);track.setAttribute('role','progressbar');track.setAttribute('aria-label',label+' 사용률');track.setAttribute('aria-valuenow',String(used));track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');}else track.append(node('span',null,'unknown'));
    box.append(track);const resetLine=node('p',null,'quota-reset');resetLine.dataset.quotaReset=reset??'';resetLine.textContent=resetText(reset);box.append(resetLine);return box;
  }
  function render(data){
    snapshot=data;const s=data.tray??{},accounts=data.accounts??s.accounts??[],p=data.policy??s.effectivePolicy;
    $('quotaStatus').textContent=`${s.quotaStatus??'한도 상태 미확인'} · 화면 조회 ${when(s.observedAt)} KST`;
    $('quotaSummary').replaceChildren();for(const [title,value] of [['등록 계정',accounts.length],['현재 선택',accounts.find(a=>a.active)?.name??'미확인'],['일시중지',accounts.filter(a=>a.paused).length],['한도 차단',accounts.filter(a=>a.status==='한도 차단').length]]){const c=node('div',null,'quota-stat');c.append(node('span',title),node('strong',String(value)));$('quotaSummary').append(c);}
    const openControls=new Set([...$('accountRows').querySelectorAll('article[data-selector]')].filter(c=>c.querySelector('details')?.open).map(c=>c.dataset.selector));
    const accountFocused=$('accountRows').contains(document.activeElement);
    if(!accountFocused){
    $('accountRows').replaceChildren();
    if(!accounts.length)$('accountRows').append(node('p','계정 정보를 가져오지 못했습니다. 기존 연결과 설정은 유지됩니다.','warning'));
    for(const a of accounts){
      const c=node('article',null,'quota-account'+(a.active?' active':''));c.dataset.selector=a.selector;c.dataset.state=a.paused?'paused':a.status==='한도 차단'?'blocked':'ready';const head=node('div',null,'quota-account-head');head.append(node('h3',a.name??a.selector??'이름 미확인'),node('span',a.active?'현재 선택':a.paused?'일시중지':a.status??'상태 미확인','quota-badge'));c.append(head);
      const short=percent(a.shortUsedPercent)??(percent(a.shortRemaining)==null?null:100-a.shortRemaining),long=percent(a.longUsedPercent)??(percent(a.longRemaining)==null?null:100-a.longRemaining);
      const windows=node('div',null,'quota-windows');windows.append(bar('5시간',short,a.shortResetAt,p?.fiveHourUsedThreshold??100),bar(a.longLabel??'주간',long,a.longResetAt,p?.longWindowUsedThreshold??100));c.append(windows);
      c.append(node('p',`${a.quotaFresh?'최근 관측':'현재 값 확인 필요'} · ${when(a.quotaObservedAt)} KST · 우선순위 ${a.priority??0}`,'meta'));
      if(a.recoveryHint)c.append(node('p',a.recoveryHint,'warning'));
      const controls=node('details',null,'quota-controls');controls.open=openControls.has(a.selector);controls.append(node('summary','사용·일시중지·우선순위·초기화권'));
      const actions=node('div',null,'actions');for(const [action,label] of [['use','이 계정 사용'],[a.paused?'resume':'pause',a.paused?'계정 재개':'일시중지'],['unpin','자동 선택']]){const b=node('button',label);b.type='button';b.disabled=s.controlNeedsReconcile||!s.selectionVerified||!a.identityHash||(action==='use'&&(a.active||a.paused||['한도 차단','로그인 필요','확인 필요','선택 미확인'].includes(a.status)));b.title=action==='pause'?'다음 계정 선택에서 제외합니다. 현재 응답은 강제 종료하지 않습니다.':label;b.onclick=run(()=>showPreview({kind:'account',action,selector:a.selector,identityHash:a.identityHash}));actions.append(b);}controls.append(actions);controls.append(node('p',s.controlNeedsReconcile?'이전 변경의 원래 결과 확인 후 조작할 수 있습니다.':!s.selectionVerified||!a.identityHash?'실제 계정 신원이 확인되어야 조작할 수 있습니다.':a.paused?'일시중지 상태입니다. 재개하면 자동 선택에 다시 포함됩니다.':a.active?'현재 선택된 계정입니다. 중지는 다음 선택에서 제외하며 현재 응답을 강제로 끊지 않습니다.':['한도 차단','로그인 필요','확인 필요','선택 미확인'].includes(a.status)?'한도·로그인·관측 상태를 해결한 뒤 이 계정을 선택할 수 있습니다.':'사용은 이 계정을 선택하고, 자동 선택은 수동 고정을 해제합니다.','muted'));
      const priority=node('label','우선순위 (-100~100)'),input=node('input');input.type='number';input.min='-100';input.max='100';input.step='1';const priorityKey=a.selector+':'+a.identityHash;if(String(a.priority??0)===priorityDrafts.get(priorityKey))priorityDrafts.delete(priorityKey);input.value=priorityDrafts.get(priorityKey)??a.priority??0;input.oninput=()=>priorityDrafts.set(priorityKey,input.value);priority.append(input);const save=node('button','우선순위 변경');save.disabled=s.controlNeedsReconcile||!s.selectionVerified||!a.identityHash;save.onclick=run(()=>showPreview({kind:'account',action:'priority',selector:a.selector,identityHash:a.identityHash,priority:Number(input.value)}));const row=node('div',null,'quota-priority');row.append(priority,save);controls.append(row);
      const credits=node('div',null,'actions');for(const [action,label] of [['credits','초기화권 조회'],['reset','초기화권 사용']]){const b=node('button',label);b.type='button';b.disabled=!a.identityHash;b.onclick=run(()=>onToolAction?.(action,{selector:a.selector,identityHash:a.identityHash}));credits.append(b);}controls.append(node('p',`초기화권 ${Number.isInteger(a.resetCredits)?a.resetCredits+'장 관측':'목록 조회 필요'} · 사용 전 실제 목록과 계정을 다시 확인합니다.`,'muted'),credits);c.append(controls);$('accountRows').append(c);
    }
    }
    sortAccounts();filterAccounts();
    $('quotaPolicy').textContent=p?`현재 정책 · 5시간 ${p.fiveHourUsedThreshold}% / ${accounts.find(a=>a.longLabel)?.longLabel??'주간'} ${p.longWindowUsedThreshold}% 사용 시 차단`:'차단 정책을 확인하지 못했습니다.';
    if(!dirty.policy&&p){$('quotaShortLimit').value=p.fiveHourUsedThreshold;$('quotaLongLimit').value=p.longWindowUsedThreshold;$('quotaShortAction').value=p.fiveHourAction??'switch';$('quotaLongAction').value=p.longWindowAction??'switch';}
      const w=data.warningSettings;if(!dirty.warning&&w){warningFormRevision=data.warningRevision;$('quotaWarningEnabled').checked=w.enabled;$('quotaNormalEnabled').checked=w.warningEnabled;$('quotaUrgentEnabled').checked=w.urgentEnabled;$('quotaSlackEnabled').checked=w.slackEnabled!==false;$('quotaNormalMargin').value=w.warningMargin;$('quotaUrgentMargin').value=w.urgentMargin;$('quotaMessageNormal').value=w.messages.fiveHourWarning;$('quotaMessageUrgent').value=w.messages.fiveHourUrgent;$('quotaMessageWeekly').value=w.messages.weeklyUrgent;}
    $('quotaPolicyFields').disabled=!p||s.controlNeedsReconcile||data.diagnosticsPending;$('quotaWarningFields').disabled=!data.warningRevision;
    const slack=data.slack??{};$('quotaSlackStatus').textContent=`Slack ${data.warningSettings?.slackEnabled!==false?'알림 켜짐':'알림 꺼짐'} · ${slack.configured===false?'기존 Slack 연결 설정 확인 필요':'기존 AICC 알림 연결 사용'} · 같은 계정·한도·초기화 주기는 중복 발송을 억제합니다.`;
  }
  async function load(refresh=false){
    if(busy||disposed)return;busy=true;clearTimeout(detailsTimer);
    $('readTray').disabled=$('refreshQuota').disabled=true;
    $('quotaStatus').setAttribute('aria-busy','true');
    $('quotaStatus').textContent=refresh?'사용량 새로 조회 중… 기존 관측값은 아래에 유지합니다.':snapshot?'화면 갱신 중… 기존 관측값은 아래에 유지합니다.':'계정 정보를 불러오는 중… 다른 탭과 설정은 사용할 수 있습니다.';
    try{
      const data=await api(refresh?'quota/refresh':'quota?view=accounts',refresh?{}:undefined);
      if(!disposed){
        render(data);
        if(data.diagnosticsPending&&pendingRounds<10){pendingRounds++;detailsTimer=setTimeout(()=>{if(!disposed&&!document.hidden&&!root.hidden)void perform(()=>load());},2000);}
        else if(!data.diagnosticsPending)pendingRounds=0;
      }
    }catch(error){$('quotaStatus').textContent='조회 지연 또는 실패 · '+error.message+(snapshot?' · 아래 값은 마지막 조회 결과입니다.':'');throw error;}
    finally{busy=false;$('quotaStatus').removeAttribute('aria-busy');$('readTray').disabled=$('refreshQuota').disabled=false;}
  }
  $('readTray').onclick=run(()=>load());$('refreshQuota').onclick=run(()=>load(true));
  for(const [form,note,key] of [['quotaPolicyForm','policyDirty','policy'],['quotaWarningForm','warningDirty','warning']])$(form).addEventListener('input',()=>{dirty[key]=true;$(note).hidden=false;});
  $('quotaPolicyForm').onsubmit=event=>{event.preventDefault();submitted.policy=formValue('quotaPolicyForm');void perform(()=>showPreview({kind:'quota-policy',config:{shortThreshold:Number($('quotaShortLimit').value),longThreshold:Number($('quotaLongLimit').value),shortAction:$('quotaShortAction').value,longAction:$('quotaLongAction').value}}));};
  $('quotaWarningForm').onsubmit=event=>{event.preventDefault();submitted.warning=formValue('quotaWarningForm');void perform(async()=>{if(!snapshot?.warningRevision)throw Error('설정을 먼저 읽으세요.');if(Number($('quotaNormalMargin').value)<=Number($('quotaUrgentMargin').value))throw Error('일반 경고의 잔여 비율을 긴급 경고보다 크게 설정하세요.');await showPreview({kind:'quota-warning',config:{expectedRevision:warningFormRevision,settings:{enabled:$('quotaWarningEnabled').checked,warningEnabled:$('quotaNormalEnabled').checked,urgentEnabled:$('quotaUrgentEnabled').checked,slackEnabled:$('quotaSlackEnabled').checked,warningMargin:Number($('quotaNormalMargin').value),urgentMargin:Number($('quotaUrgentMargin').value),messages:{fiveHourWarning:$('quotaMessageNormal').value,fiveHourUrgent:$('quotaMessageUrgent').value,weeklyUrgent:$('quotaMessageWeekly').value}}}});});};
  function schedule(){clearTimeout(timer);if(disposed)return;timer=setTimeout(async()=>{if(!document.hidden&&!root.hidden){for(const p of root.querySelectorAll('[data-quota-reset]'))p.textContent=resetText(p.dataset.quotaReset);await perform(()=>load());}schedule();},(window.aiccMobileView?.refreshSeconds??30)*1000);}
  window.addEventListener('aicc:view-settings',schedule);
  schedule();return {load,applied:async kind=>{const key=kind==='quota-policy'?'policy':kind==='quota-warning'?'warning':null;if(key&&submitted[key]===formValue(key==='policy'?'quotaPolicyForm':'quotaWarningForm')){dirty[key]=false;$(key==='policy'?'policyDirty':'warningDirty').hidden=true;}await load();},dispose:()=>{disposed=true;clearTimeout(timer);clearTimeout(detailsTimer);window.removeEventListener('aicc:view-settings',schedule);}};
}
