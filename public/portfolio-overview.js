const root = document.getElementById('overview');
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
const labels = { PRIORITY:'최우선', PARTIAL:'일부 사용 가능', HOLD:'조건 해결 필요', WAITING:'개발 대기', ARCHIVED:'사용 종료', PARALLEL:'독립 병행' };
let snapshot, busy = false;
const status = root.querySelector('[role="status"]'), rows = root.querySelector('.overview-groups');
const search = root.querySelector('input'), filter = root.querySelector('select'), refresh = root.querySelector('button');
function items(title, values, parent, cls = '') {
  const section = el('div', null, cls); section.append(el('h4', title));
  const ul = el('ul'); for (const value of values) ul.append(el('li', value)); section.append(ul); parent.append(section);
}
function render() {
  if (!snapshot) return;
  rows.replaceChildren();
  const selected = snapshot.groups.filter(g => (filter.value === 'all' || filter.value === 'active' && !['WAITING','ARCHIVED'].includes(g.state) || filter.value === 'waiting' && ['WAITING','ARCHIVED'].includes(g.state)) && [g.id,g.displayId,g.name,g.purpose,...g.products,...g.remaining].join(' ').toLowerCase().includes(search.value.trim().toLowerCase()));
  for (const g of selected) {
    const card = el('article', null, 'overview-group'); card.dataset.state = g.state;
    const heading = el('div', null, 'overview-group-heading'); heading.append(el('span', g.displayId ?? g.id, 'overview-id'),el('span',labels[g.state],'overview-badge')); card.append(heading,el('h3',g.name),el('p',g.purpose,'overview-purpose'),el('p',g.current,'overview-current'));
    const stages = el('div',null,'overview-stages'); stages.setAttribute('aria-label','구현·설치·실사용 구분'); for(const s of g.stages)stages.append(el('span',s));card.append(stages);
    items('확인된 결과', g.completed, card,'overview-done'); items('남은 일',g.remaining,card,'overview-left');
    const next=el('p',null,'overview-next'); next.append(el('strong','다음 행동 '),document.createTextNode(g.next));card.append(next);
    const detail=el('details');detail.append(el('summary','처음 목표·개발 이력·근거 보기'),el('h4','처음 시작한 이유'),el('p',g.initial));
    items('포함된 제품',g.products,detail);items('지금까지의 흐름',g.milestones,detail);items('근거와 확인 범위',g.evidence,detail);card.append(detail); rows.append(card);
  }
  if(!selected.length) rows.append(el('p','조건에 맞는 그룹이 없습니다. 검색어나 보기를 바꿔 주세요.','overview-empty'));
  root.querySelector('.overview-count').textContent=`전체 ${snapshot.groups.length}개 그룹 중 ${selected.length}개 표시`;
}
async function load() {
  if(busy)return;busy=true;refresh.disabled=true;root.setAttribute('aria-busy','true');status.textContent='기존 개발 기록을 읽고 있습니다…';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{
    const response=await fetch('/api/mobile/portfolio-overview',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
    const value=await response.json();
    if(!response.ok)throw Error(value.code==='pair_required'?'앱 연결 후 다시 조회해 주세요.':'연결을 확인한 뒤 다시 조회해 주세요.');
    if(value.status==='UNAVAILABLE'||!Array.isArray(value.groups)||!value.groups.length)throw Error('정리된 현황을 아직 읽을 수 없습니다. 기존 기록은 보존됩니다.');
    snapshot=value;
    status.textContent=(value.status==='STALE'?'기록이 변경되었습니다. 아래는 마지막 정리본입니다. ':'기록 기준 ')+new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'medium',timeStyle:'short'}).format(new Date(value.reviewedAt))+' KST · 실행 상태의 실시간 확인과 구분합니다.';
    root.querySelector('.overview-conclusion').textContent=value.summary;
    root.querySelector('.overview-order').textContent=value.order.join(' → ');
    const timeline=root.querySelector('.overview-timeline');timeline.replaceChildren();for(const t of value.timeline)timeline.append(el('li',t));
    root.querySelector('.overview-scope').textContent=value.scope;render();
  }catch(error){status.textContent='조회 실패 · '+(error.name==='AbortError'?'응답이 늦습니다. 다시 조회해 주세요.':error.message)+(snapshot?' 마지막 현황은 유지했습니다.':'');}
  finally{clearTimeout(timer);busy=false;refresh.disabled=false;root.setAttribute('aria-busy','false');}
}
refresh.onclick=load;search.oninput=render;filter.onchange=render;
function onPanel(){if(!root.hidden&&!snapshot)void load();}
window.addEventListener('hashchange',onPanel);window.addEventListener('aicc:panel-change',onPanel);
// Authentication completes in mobile.js. Loading once here can race its local-session creation.
document.addEventListener('aicc:session-ready',onPanel);
onPanel();
