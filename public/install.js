const $=id=>document.getElementById(id);
const panel=$('selectedApp'),status=$('installStatus'),open=$('selectedAppOpen');
const options={credentials:'same-origin',cache:'no-store'};
let selectedRequest;

async function loadSelectedApp(){
  selectedRequest?.abort();
  panel.hidden=true;open.hidden=true;open.removeAttribute('href');status.textContent='';
  const id=new URLSearchParams(location.hash.slice(1)).get('app');
  if(!id||id==='aicc')return;
  const request=new AbortController();selectedRequest=request;
  status.textContent='등록된 앱을 확인하는 중입니다…';
  try{
    const response=await fetch('/api/mobile/apps',{...options,signal:AbortSignal.any([request.signal,AbortSignal.timeout(15000)])});
    if(response.status===401||response.status===403)throw Error('내 앱에서 브라우저를 연결한 뒤 다시 선택하세요.');
    if(!response.ok)throw Error('앱 정보를 읽지 못했습니다. 연결을 확인하고 내 앱에서 다시 선택하세요.');
    const data=await response.json();
    if(request.signal.aborted)return;
    const app=Array.isArray(data.apps)&&data.apps.find(row=>row.id===id&&row.registered);
    if(!app)throw Error('선택한 앱을 확인하지 못했습니다. 내 앱 목록을 다시 조회하세요.');
    $('selectedAppTitle').textContent=app.title+' 설치·업데이트';
    panel.hidden=false;status.textContent='';
    let url;
    if(app.state==='WEB'&&app.url){try{url=new URL(app.url);}catch{}}
    if(!url||url.protocol!=='https:'||url.username||url.password||url.search||url.hash){
      $('selectedAppStatus').textContent=app.state==='PC_ONLY'?'이 앱은 PC에서 직접 사용하세요.':app.state==='RETIRED'?'사용을 종료했거나 다른 앱에 통합되었습니다.':'휴대폰에서 열 수 있는 주소가 등록되면 설치 방법을 확인할 수 있습니다.';
      return;
    }
    open.href=url.href;open.hidden=false;
    $('selectedAppStatus').textContent='앱 사이트에서 설치 지원과 새 버전을 확인하세요. Chrome에서 홈 화면에 추가하거나, 설치가 지원되면 앱으로 설치할 수 있습니다.';
  }catch(error){
    if(request.signal.aborted)return;
    status.textContent=error.name==='TimeoutError'?'응답이 늦습니다. 내 앱에서 다시 확인하세요.':error.message;
  }
}
void loadSelectedApp();
window.addEventListener('hashchange',loadSelectedApp);

$('apkHelp').addEventListener('toggle',async()=>{
  const label=$('apkVersion');
  if(!$('apkHelp').open||label.dataset.state)return;
  label.dataset.state='loading';label.textContent='다운로드 버전을 확인 중입니다…';
  try{
    const response=await fetch('/downloads/aicc-mobile.json',{...options,signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error();
    const version=await response.json();
    if(version.signed!==true||typeof version.versionName!=='string'||!version.versionName)throw Error();
    label.textContent=`다운로드 버전 ${version.versionName} · 폰에 설치된 버전은 Android 설정에서 확인하세요.`;
    label.dataset.state='loaded';
  }catch{
    label.textContent='다운로드 버전을 확인하지 못했습니다. 연결을 확인한 뒤 안내를 다시 펼쳐 주세요.';
    delete label.dataset.state;
  }
});
