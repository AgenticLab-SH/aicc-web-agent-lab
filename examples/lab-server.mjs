import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const staticRoot = fileURLToPath(new URL('../public/', import.meta.url));
const mediaTypes = new Map([
  ['.html','text/html'], ['.js','text/javascript'], ['.css','text/css'],
  ['.svg','image/svg+xml'], ['.png','image/png'], ['.json','application/json'],
  ['.webmanifest','application/manifest+json']
]);
const observedAt = '2026-11-22T00:00:00.000Z';
const readOnly = { ok: true, readOnly: true, mock: true };
const apps = [
  { id: 'aicc', title: 'AICC', state: 'WEB', url: '/mobile.html#ai-reports', description: '합성 보고와 도구를 확인합니다.' },
  { id: 'demo-notes', title: '예시 노트', state: 'WEB', url: 'https://notes.example.invalid/', description: '가상 등록 주소입니다.' },
  { id: 'demo-pc', title: '예시 데스크톱', state: 'PC_ONLY', description: 'Windows 전용 상태 예시입니다.' },
  { id: 'demo-pending', title: '예시 준비 중', state: 'UNAVAILABLE', description: '등록 주소가 없는 상태입니다.' },
  { id: 'demo-retired', title: '예시 종료', state: 'RETIRED', description: '사용 종료 이력입니다.' }
].map(app => ({ registered: true, url: null, ...app }));

const tools = [
  ['status','계정과 한도','상태','root','account'],
  ['portfolio','전체 개발 현황','상태','root','overview'],
  ['reports','AI 보고','보고','root','ai-reports'],
  ['instructions','지시·목표','대화','root','ai-queue'],
  ['policy','차단 정책','계정','root','quota-policy'],
  ['phone','기기 관리','설정','root','devices'],
  ['app-install','AICC 설치·업데이트','설정','root','install'],
  ['diagnostics','연결 진단 (모의)','도구','remote',null],
  ['open-thread','기존 대화 열기','대화','localOnly',null]
].map(([action,label,group,capability,route]) => ({
  action,label,group,capability,route,localOnly:capability==='localOnly',
  description: capability==='localOnly'?'실제 Windows 작업은 운영 PC에서 수행합니다.':'합성 데이터로 확인하는 예시입니다.'
}));
const sampleAccount = {
  selector:'demo-account', name:'예시 계정', status:'사용 가능', active:true, priority:10,
  quotaFresh:true, quotaObservedAt:observedAt, shortRemaining:62, longRemaining:74
};
const policy = { fiveHourUsedThreshold:97, longWindowUsedThreshold:98 };
const tray = { ...readOnly, accounts:[sampleAccount], effectivePolicy:policy, selectionVerified:false };
const goals = { ...readOnly, summary:{ total:0, truncated:false, statusCounts:{} }, goals:[] };
const dashboard = {
  ...readOnly, revision:'demo-r1', observedAt, agents:[], nodes:[], queue:[], paused:{}, registeredQueue:[],
  coverage:{available:true,groupCount:0,projectCount:0,featureCount:0,issues:[]}
};
const overview = {
  ...readOnly, status:'AVAILABLE', reviewedAt:observedAt,
  summary:'공개 개발 연습용 합성 데이터입니다.',
  order:['예시 그룹'], timeline:['예시 화면 준비'], scope:'이 기록은 운영 상태를 반영하지 않습니다.',
  groups:[{id:'demo',name:'예시 그룹',state:'PARTIAL',purpose:'앱과 도구 화면 개발',
    current:'합성 화면 사용 가능',stages:['소스 예시'],completed:['읽기 확인'],
    remaining:['화면 검토'],next:'내 앱에서 상태별 카드를 확인하세요.',
    initial:'제품 탐색',products:['예시 AICC'],milestones:['샘플 정리'],evidence:['합성 API 응답']}]
};
const reads = new Map([
  ['apps',{...readOnly,status:'AVAILABLE',apps,observedAt}],
  ['tools',{...readOnly,catalog:tools,unresolved:[],profiles:[],pinError:null}],
  ['tray',tray], ['quota',{...readOnly,tray,accounts:tray.accounts,policy}],
  ['portfolio-overview',overview], ['goals',goals], ['dashboard',dashboard],
  ['devices',{...readOnly,devices:[]}], ['state',{...readOnly,rows:[]}],
  ['web',{...readOnly,config:{enabled:false,intervalSeconds:60,targets:[],peerGrants:[]},runner:{reportedState:'예시'}}],
  ['web-queue',{...readOnly,status:'AVAILABLE',counts:{},items:[]}]
]);

function reply(res,status,body,type='application/json; charset=utf-8') {
  res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'content-security-policy':"default-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"});
  res.end(type.startsWith('application/json')?JSON.stringify(body):body);
}
const deny = (res,status,code) => reply(res,status,{ok:false,code,automaticReplay:false,mock:true});

async function jsonBody(req) {
  if(!String(req.headers['content-type']).startsWith('application/json'))throw Error('content_type_required');
  const chunks=[];let total=0;
  for await(const chunk of req){
    total+=chunk.length;
    if(total>4096)throw Error('body_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}

export function createLabServer() {
  const sessions = new Map();
  const server = http.createServer(async (req,res) => {
    const host = '127.0.0.1:'+req.socket.localPort;
    if(req.headers.host!==host)return deny(res,403,'loopback_only');
    let url;
    try{url=new URL(req.url,'http://'+host);}catch{return deny(res,400,'invalid_url');}
    const endpoint=url.pathname.slice('/api/mobile/'.length);
    if(url.pathname.startsWith('/api/mobile/')){
      const id=req.headers.cookie?.match(/(?:^|; *)aicc_lab=([a-f0-9-]+)/)?.[1];
      const session=sessions.get(id);
      if(req.method==='POST'){
        if(req.headers.origin!=='http://'+host)return deny(res,403,'same_origin_required');
        let input;
        try{input=await jsonBody(req);}catch{return deny(res,400,'invalid_mock_request');}
        if(endpoint==='local-session'){
          if(sessions.size>=128)return deny(res,429,'lab_session_limit');
          const key=randomUUID(),csrf=randomUUID();
          sessions.set(key,{csrf,preview:null,operations:new Map()});
          res.setHeader('set-cookie','aicc_lab='+key+'; HttpOnly; SameSite=Strict; Path=/');
          return reply(res,200,{ok:true,csrf,local:true,remoteConfigured:false,mock:true});
        }
        if(!session)return deny(res,409,'pair_required');
        if(req.headers['x-aicc-csrf']!==session.csrf)return deny(res,403,'csrf_required');
        if(endpoint==='logout'){
          sessions.delete(id);res.setHeader('set-cookie','aicc_lab=; Max-Age=0; Path=/');
          return reply(res,200,{ok:true,mock:true});
        }
        if(endpoint==='preview'&&input?.kind==='tray-tool'&&input.config?.action==='diagnostics'){
          const confirmationToken=randomUUID(),expiresAt=new Date(Date.now()+60000).toISOString();
          session.preview={confirmationToken,expiresAt};
          return reply(res,200,{ok:true,mock:true,summary:['합성 진단만 실행합니다.'],confirmationToken,expiresAt});
        }
        if(endpoint==='confirm'){
          if(!session.preview||session.preview.confirmationToken!==input?.confirmationToken||Date.parse(session.preview.expiresAt)<=Date.now())return deny(res,409,'confirmation_expired');
          session.preview=null;
          if(session.operations.size>=100)return deny(res,429,'lab_operation_limit');
          const operationId=randomUUID();
          session.operations.set(operationId,{ok:true,mock:true,state:'COMPLETED',kind:'tray-tool',operationId,toolResult:{terminal:'MOCK',dispatched:false}});
          return reply(res,200,{ok:true,mock:true,operationId});
        }
        return deny(res,403,'mock_only_external_integration');
      }
      if(req.method!=='GET')return deny(res,405,'method_not_allowed');
      if(!session)return deny(res,409,'pair_required');
      if(req.headers.origin&&req.headers.origin!=='http://'+host)return deny(res,403,'same_origin_required');
      if(endpoint==='session')return reply(res,200,{ok:true,csrf:session.csrf,local:true,remoteConfigured:false,mock:true});
      if(endpoint==='operation'){
        const operationId=url.searchParams.get('id');
        const operation=session.operations.get(operationId);
        if(operation)return reply(res,200,operation);
        if(operationId==='demo-unconfirmed')return reply(res,200,{ok:true,mock:true,operationId,state:'UNKNOWN',automaticReplay:false});
        return deny(res,404,'operation_unconfirmed');
      }
      const body=reads.get(endpoint);
      return body?reply(res,200,body):deny(res,404,'mock_route_unavailable');
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return deny(res,405,'method_not_allowed');
    if(url.pathname==='/'){res.writeHead(302,{location:'/mobile.html#overview'});return res.end();}
    const relative=url.pathname.slice(1);
    if(!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:html|css|js|json|png|svg|webmanifest)$/.test(relative))return deny(res,404,'asset_not_available');
    const type=mediaTypes.get(path.extname(relative));
    try{
      const body=req.method==='HEAD'?null:await fs.readFile(path.join(staticRoot,relative));
      if(req.method==='HEAD'){await fs.access(path.join(staticRoot,relative));res.writeHead(200,{'content-type':type});return res.end();}
      if(type==='application/json')return reply(res,200,JSON.parse(body.toString('utf8')));
      return reply(res,200,body,type);
    }catch{return deny(res,404,'asset_not_available');}
  });
  return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const host='127.0.0.1',port=Number(process.argv[2]??4173);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid_lab_port');
  const server=createLabServer();
  server.listen(port,host,()=>console.log('AICC lab (synthetic data): http://'+host+':'+port+'/mobile.html#overview'));
}
