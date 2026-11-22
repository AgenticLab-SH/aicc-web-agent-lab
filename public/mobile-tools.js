const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
export function createMobileToolsView({api,perform,showPreview,onRootAction}){
  const root=document.getElementById('tools'),groups=document.getElementById('toolGroups'),status=document.getElementById('toolsStatus');
  let snapshot=null,accounts=[],loadPending=null,order=[],selectedAccount=null;
  const groupOpen=new Map();
  const categoryLabel=el('label','기능 분류'),category=el('select');category.id='toolCategory';category.append(new Option('모든 분류','all'));categoryLabel.append(category);categoryLabel.className='tool-category';groups.before(categoryLabel);
  const orderBox=el('details'),orderTitle=el('summary','계정 선택 순서 조절');orderBox.id='accountOrder';orderBox.append(orderTitle,el('p','위쪽 계정부터 자동 선택합니다. 진행 중인 응답은 강제 전환하지 않습니다.'));
  const orderRows=el('div',null,'cards'),orderRead=el('button','현재 계정 순서 읽기'),orderSave=el('button','계정 순서 변경 미리보기');orderRead.type=orderSave.type='button';orderBox.append(orderRead,orderRows,orderSave);root.insertBefore(orderBox,groups);
  function renderOrder(){orderRows.replaceChildren();order.forEach((a,i)=>{const row=el('div',null,'actions');row.append(el('strong',`${i+1}. ${a.name??a.selector}`));for(const [offset,label] of [[-1,'위로'],[1,'아래로']]){const b=el('button',label);b.type='button';b.disabled=i+offset<0||i+offset>=order.length;b.setAttribute('aria-label',`${a.name??a.selector} ${label}`);b.onclick=()=>{[order[i],order[i+offset]]=[order[i+offset],order[i]];renderOrder();};row.append(b);}orderRows.append(row);});orderSave.disabled=!order.length;}
  async function loadOrder(){const d=await api('tray');order=(d.accounts??[]).filter(a=>a.selector!=='main'&&a.identityHash).sort((a,b)=>(b.priority??0)-(a.priority??0));renderOrder();}
  orderRead.onclick=()=>perform(loadOrder);orderSave.onclick=()=>perform(()=>showPreview({kind:'account-order',config:{order:order.map(a=>({selector:a.selector,identityHash:a.identityHash}))}}));orderSave.disabled=true;
  async function rootAction(item){if(item.action==='order'){orderBox.open=true;await loadOrder();orderBox.scrollIntoView({block:'start'});return;}await onRootAction(item);}
  const pendingBox=el('div');pendingBox.id='toolPending';root.insertBefore(pendingBox,groups);
  function renderPending(){pendingBox.replaceChildren();for(const u of snapshot?.unresolved??[]){const card=el('article',null,'card');card.append(el('h3','원래 결과 확인 필요'),el('p',`${u.action} · ${u.operationId}`,'meta'));const config=u.action?.startsWith('rdc-')&&u.originalOperationId?{action:'rdc-reconcile',operationRef:u.originalOperationId}:u.action==='reset'&&u.originalRequestId?{action:'reconcile',requestId:u.originalRequestId}:null;card.append(el('p',config?'원 요청의 상태만 조정합니다. 같은 작업을 다시 실행하지 않습니다.':'원 실행 ID 연결 증거가 없어 PC에서 원 결과를 확인해야 합니다.'));const b=el('button','원 결과 조정 내용 확인');b.type='button';b.disabled=!config;b.onclick=()=>perform(()=>showPreview({kind:'tray-tool',config}));card.append(b);pendingBox.append(card);}}
  function render(){
    renderPending();if(!snapshot)return;
    for(const group of groups.querySelectorAll('details[data-group]'))groupOpen.set(group.dataset.group,group.open);
    const query=document.getElementById('toolSearch').value.trim().toLocaleLowerCase(),scope=document.getElementById('toolScope').value,byGroup=new Map();groups.replaceChildren();
    for(const item of snapshot.catalog??[]){
      if(scope==='web'&&(item.localOnly||item.pcWindow)||scope==='pc'&&!item.localOnly&&!item.pcWindow)continue;
      if(category.value!=='all'&&category.value!==item.group)continue;
      if(query&&!`${item.label} ${item.description} ${item.action} ${item.group}`.toLocaleLowerCase().includes(query))continue;
      const name=item.group??'기타';if(!byGroup.has(name))byGroup.set(name,[]);byGroup.get(name).push(item);
    }
    for(const [name,items]of byGroup){
      const group=el('details',null,'tool-group');group.dataset.group=name;group.open=!!query||category.value!=='all'||scope!=='all'||groupOpen.get(name)===true;group.append(el('summary',`${name} · ${items.length}개`));
      const grid=el('div',null,'tool-grid');
      for(const item of items){
        const card=el('article',null,'card tool-card');card.id='tool-'+item.action;card.tabIndex=-1;card.append(el('h3',item.label),el('p',item.description??'', 'meta'));
        const availability=item.localOnly?'Windows에서 직접 사용':item.pcWindow?'Windows에서 창 열기 · 화면에서 접수 확인':item.capability==='root'?'AICC 화면에서 사용':item.mutates?'기존 PC 실행기에 변경 요청':'기존 PC 실행기로 조회';
        card.append(el('p',availability,'tool-availability'+(item.localOnly||item.pcWindow?' pc-only':'')));
        let profile,account;
        if(item.requiresProfile){const label=el('label',item.action==='rdc-save'?'저장 이름 · 영문/숫자/_/-':'저장된 RDC 계정');profile=document.createElement(item.action==='rdc-save'?'input':'select');if(item.action==='rdc-save'){profile.maxLength=40;profile.placeholder='예: account-main';profile.autocomplete='off';}else{profile.append(new Option('저장 계정 선택',''));for(const p of snapshot.profiles??[])profile.append(new Option(typeof p==='string'?p:p.name,typeof p==='string'?p:p.name));}label.append(profile);card.append(label);}
        if(item.requiresAccount){const label=el('label','적용할 OCX 계정');account=el('select');account.append(new Option('계정 선택',''));for(const a of accounts)if(a.identityHash)account.append(new Option(a.name??a.selector,a.selector));if(selectedAccount&&accounts.some(a=>a.selector===selectedAccount.selector&&a.identityHash===selectedAccount.identityHash))account.value=selectedAccount.selector;label.append(account);card.append(label);}
        const b=el('button',item.capability==='root'?'기능 열기':item.localOnly?'PC에서 직접 사용':item.pcWindow?'PC 창 열기 요청':item.mutates?'변경 내용 확인':'조회 내용 확인');b.type='button';b.disabled=!!item.localOnly;b.title=item.localOnly?(item.description??'PC 전용 기능입니다.'):item.label;
        b.onclick=()=>perform(async()=>{
          if(item.capability==='root')return rootAction(item);
          const input={action:item.action};
          if(['reconcile','rdc-reconcile'].includes(item.action)){const u=(snapshot.unresolved??[]).find(u=>item.action==='reconcile'?u.action==='reset'&&u.originalRequestId:u.action?.startsWith('rdc-')&&u.originalOperationId);if(!u)throw Error('연결된 원 요청이 없습니다. 원 결과 확인 필요 목록을 확인하세요.');if(item.action==='reconcile')input.requestId=u.originalRequestId;else input.operationRef=u.originalOperationId;}
          if(profile){input.profile=profile.value.trim();if(!input.profile)throw Error('RDC 저장 이름을 선택하거나 입력하세요.');}
          if(account){const a=accounts.find(a=>a.selector===account.value);if(!a)throw Error('정확한 계정을 선택하세요.');input.selector=a.selector;input.identityHash=a.identityHash;}
          await showPreview({kind:'tray-tool',config:input});
        });card.append(b);grid.append(card);
      }
      group.append(grid);groups.append(group);
    }
    document.getElementById('toolCount').textContent=[...byGroup.values()].reduce((sum,items)=>sum+items.length,0)+'개 표시 · 분류를 펼쳐 사용하세요.';
    if(!byGroup.size)groups.append(el('p','일치하는 도구가 없습니다. 검색어나 분류를 바꿔 보세요.'));
  }
  function load(){
    if(loadPending)return loadPending;
    document.getElementById('readTools').disabled=true;status.textContent='공통 도구와 기존 PC 실행기 연결을 확인하는 중…';
    loadPending=(async()=>{
      const [s,a]=await Promise.all([api('tools'),api('tray').catch(()=>({accounts:[]}))]);snapshot=s;accounts=a.accounts??[];
      const previous=category.value;category.replaceChildren(new Option('모든 분류','all'));for(const name of new Set((s.catalog??[]).map(i=>i.group)))category.append(new Option(name,name));category.value=[...category.options].some(o=>o.value===previous)?previous:'all';
      const all=s.catalog??[];status.textContent=`전체 ${all.length}개 · 이 웹 ${all.filter(i=>!i.localOnly&&!i.pcWindow).length}개 · PC 창 ${all.filter(i=>i.pcWindow).length}개 · PC 직접 사용 ${all.filter(i=>i.localOnly).length}개${s.pinError?' · 설치 연결 확인 필요':''}`;render();
    })().catch(e=>{status.textContent='도구 조회 실패 · '+e.message+(snapshot?' 마지막 목록을 유지했습니다.':' 연결을 확인한 뒤 다시 조회하세요.');throw e;}).finally(()=>{loadPending=null;document.getElementById('readTools').disabled=false;});return loadPending;
  }
  const resultTools=el('div',null,'actions'),copy=el('button','결과 복사');copy.type='button';copy.onclick=()=>perform(async()=>{await navigator.clipboard.writeText(document.getElementById('toolResult').textContent);copy.textContent='복사 완료';});resultTools.append(copy);document.getElementById('toolResult').after(resultTools);
  function showResult(result){const target=document.getElementById('toolResult');let text;try{text=JSON.stringify(result,null,2);}catch{text='결과를 표시하지 못했습니다.';}target.textContent=(text??'표시할 결과 없음').slice(0,16000);copy.textContent='결과 복사';document.getElementById('toolResultSummary').textContent=(text?.length??0)>16000?'긴 결과의 앞부분 16,000자를 표시합니다.':'원 실행기가 반환한 결과입니다. PC 창 열기 접수와 실제 화면 표시는 별개입니다.';target.closest('details').open=true;target.closest('details').scrollIntoView({block:'start'});}
  async function openAction(action,account){selectedAccount=account??null;await load();document.getElementById('toolSearch').value=action==='all-tools'?'':action;document.getElementById('toolScope').value='all';category.value='all';render();if(action!=='all-tools'){const card=document.getElementById('tool-'+action);if(card){card.closest('details').open=true;card.focus({preventScroll:true});card.scrollIntoView({block:'start'});}}else root.scrollIntoView({block:'start'});}
  document.getElementById('readTools').onclick=()=>perform(load);document.getElementById('toolSearch').oninput=render;document.getElementById('toolScope').onchange=render;category.onchange=render;
  return {load,showResult,openAction,openOrder:async()=>{orderBox.open=true;await loadOrder();orderBox.scrollIntoView({block:'start'});}};
}
