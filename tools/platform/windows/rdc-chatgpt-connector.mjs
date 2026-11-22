import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),target=cfg.accounts.find(a=>a.profile===process.argv[3]);
if(!target)throw Error('Unknown target');
// Quota reads use the official read-only MCP metadata endpoint and the existing
// owner-local session. Do not initialize Playwright or change a browser login.
if(process.argv[5]==='usage'){
 try{const {runQuota}=await import('./rdc-quota-client.mjs');await runQuota(cfg,target);}
 catch(error){process.stdout.write(JSON.stringify({phase:error.phase||'HOLD',reason:error.phase?'Official quota unavailable; existing session and exclusion preserved.':'Quota reader failed; inspect locally.',profile:target.profile})+'\n');process.exitCode=1;}
}else{
const require=createRequire(import.meta.url),{chromium}=require(cfg.playwright);
const {sessionIdentityHashExpression}=await import(pathToFileURL(cfg.identityAudit).href);
const owner='rdc-rotation-'+process.argv[4];let lease,browser,page;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function helper(args){return JSON.parse(execFileSync(cfg.powershell,['-NoProfile','-File',cfg.leaseHelper,...args,'-AsJson'],{encoding:'utf8',windowsHide:true,timeout:45000,stdio:['pipe','pipe','pipe']}));}
function result(phase,reason){process.stdout.write(JSON.stringify({phase,reason,profile:target.profile})+'\n');}
function linked(){return page.locator('button[aria-label$="의 액션"]');}
async function emails(){return linked().evaluateAll(es=>es.map(e=>e.getAttribute('aria-label').replace(/의 액션$/,'').trim().toLowerCase()));}
async function settings(){await page.goto(cfg.settingsUrl+'?aicc_task_target='+lease.task_target_nonce,{waitUntil:'domcontentloaded',timeout:45000});await page.getByRole('button',{name:'다른 계정 연결',exact:true}).waitFor({timeout:45000});}
function loginNeeded(message){const error=Error(message);error.phase='NEEDS_GOOGLE_LOGIN';throw error;}
async function dashboardIdentity(){
 const labels=await page.locator('a[href="/settings"]').allTextContents();
 const profileLabel=labels.find(t=>t.includes('@'));
 if(!profileLabel)return null;
 const matches=cfg.accounts.filter(a=>profileLabel.toLowerCase().includes(a.email.toLowerCase()));
 if(matches.length!==1)throw Error('Foreign RDC browser login preserved');
 return matches[0];
}
async function quotaDashboard(){
 await page.goto('https://mcp.desktopcommander.app/settings',{waitUntil:'domcontentloaded',timeout:40000});
 const deadline=Date.now()+150000; // Usage observation must never change browser authentication.
 while(Date.now()<deadline){
  const u=new URL(page.url());
  if(u.origin==='https://mcp.desktopcommander.app'){
   const account=await dashboardIdentity();
   if(account?.profile===target.profile){
    await page.goto('https://mcp.desktopcommander.app/usage',{waitUntil:'domcontentloaded',timeout:40000});
    await page.getByText(/of [\d,]+ this month/).first().waitFor({timeout:20000});
    if((await dashboardIdentity())?.profile!==target.profile)throw Error('Usage identity changed');
    let usage=null;
    try{
     usage=await page.evaluate(async()=>{
      const response=await fetch('https://auth.desktopcommander.app/auth/billing/usage',{credentials:'include'});
      if(!response.ok||new URL(response.url).origin!=='https://auth.desktopcommander.app')return null;
      const data=await response.json();const u=data.usage;
      return u?{callsUsed:u.callsUsed,callsIncluded:u.callsIncluded,resetsAt:u.resetsAt}:null;
     });
    }catch{}
    if((await dashboardIdentity())?.profile!==target.profile)throw Error('Usage identity changed');
    let used=usage?.callsUsed,limit=usage?.callsIncluded;
    if(typeof used!=='number'||typeof limit!=='number'||!Number.isFinite(used)||!Number.isFinite(limit)||used<0||limit<=0){
     const body=await page.locator('body').innerText(),m=body.match(/([\d,]+)\s+of\s+([\d,]+)\s+this month/i);
     if(!m)throw Error('Official quota unknown');used=Number(m[1].replaceAll(',',''));limit=Number(m[2].replaceAll(',',''));
    }
    if(!Number.isFinite(used)||!Number.isFinite(limit)||used<0||limit<=0)throw Error('Official quota invalid');
    const reset=typeof usage?.resetsAt==='string'&&Number.isFinite(Date.parse(usage.resetsAt))?new Date(usage.resetsAt).toISOString():null;
    process.stdout.write(JSON.stringify({phase:'USAGE_OBSERVED',profile:target.profile,remainingPercent:Math.max(0,100*(limit-used)/limit),callsUsed:used,callsIncluded:limit,resetAt:reset,observedAt:new Date().toISOString(),source:'rdc-official-dashboard',usageRejected:false})+'\n');return;
   }
   if(account){
    const error=Error('Quota belongs to a different existing dashboard session; login unchanged. Explicit account connection is separate from usage refresh.');
    error.phase='QUOTA_SESSION_MISMATCH';throw error;
   }
  }else if(u.origin==='https://auth.desktopcommander.app'||u.origin==='https://accounts.google.com'){
   if(u.origin==='https://accounts.google.com'){
    const body=await page.locator('body').innerText();
    if(/차단|액세스 거부|access blocked|couldn.t sign you in|이 브라우저.*안전/i.test(body))throw Error('SECURITY_REFUSED');
   }
   loginNeeded('Usage checks never sign in, sign out, choose a Google account, or continue OAuth. Existing connections and exclusions preserved.');
  }else if(u.origin!=='about:blank')throw Error('Unexpected usage observation origin');
  await delay(500);
 }
 throw Error('Official account quota timed out; exclusion preserved');
}
try{
 lease=helper(['-Action','Acquire','-OwnerId',owner,'-AccountAlias',cfg.chatgpt.alias,'-Workspace',cfg.chatgpt.workspace,'-Url',cfg.settingsUrl,'-TtlSec','600','-AllowBrowserStart']).lease;
 if(!lease?.task_target_nonce)throw Error('Exact lease missing');
 browser=await chromium.connectOverCDP(lease.endpoint);
 const matches=[];
 for(const candidate of browser.contexts().flatMap(c=>c.pages())){
  const cdp=await candidate.context().newCDPSession(candidate);
  try{if((await cdp.send('Target.getTargetInfo')).targetInfo.targetId===lease.target_id)matches.push(candidate);}finally{await cdp.detach();}
 }
 if(matches.length!==1)throw Error('Exact task target unavailable');page=matches[0];page.setDefaultTimeout(20000);
 // Usage does not depend on the mutable connector-management button text.
 if(process.argv[5]==='usage')await page.goto(cfg.settingsUrl+'?aicc_task_target='+lease.task_target_nonce,{waitUntil:'domcontentloaded',timeout:45000});
 else await settings();
 const id=await page.evaluate(sessionIdentityHashExpression());
 if(id.accountName!==cfg.chatgpt.alias||!id.identityHash|| (cfg.chatgpt.identityHash && id.identityHash!==cfg.chatgpt.identityHash))throw Error('ChatGPT identity mismatch');
 if(process.argv[5]==='usage'){
  await quotaDashboard();
 }else{
 let accounts=await emails();if(accounts.some(e=>!cfg.accounts.some(a=>a.email===e)))throw Error('Unknown connected account preserved');
 if(!accounts.includes(target.email)){
  await page.goto('https://mcp.desktopcommander.app/settings',{waitUntil:'domcontentloaded',timeout:40000});
  const signOut=page.getByRole('button',{name:'Sign out',exact:true});
  await signOut.waitFor({timeout:20000}).catch(()=>{});
  if(await signOut.count()){
   const text=await page.locator('body').innerText();
   if(!text.includes(target.email)){
    if(!cfg.accounts.some(a=>text.includes(a.email)))throw Error('Foreign RDC browser login preserved');
    await signOut.click();await signOut.waitFor({state:'detached',timeout:20000});
   }
  }
  await settings();
  await page.getByRole('button',{name:'다른 계정 연결',exact:true}).click();
  const consent=page.getByRole('button',{name:'Remote Desktop Commander(으)로 계속',exact:true});
  await consent.waitFor({timeout:3000}).catch(()=>{});
  if(await consent.isVisible().catch(()=>false))await consent.click();
  const deadline=Date.now()+150000;let clickedGoogle=false,selectedGoogle=false,continuedGoogle=false;
  while(Date.now()<deadline){
   const u=new URL(page.url());
   if(u.origin==='https://chatgpt.com'){
    const entries=await emails();if(entries.includes(target.email))break;
   }else if(u.origin==='https://auth.desktopcommander.app'){
    if(!clickedGoogle){const b=page.getByRole('button',{name:/Continue with Google/});if(await b.count()){clickedGoogle=true;await b.click();}}
   }else if(u.origin==='https://accounts.google.com'){
    const body=await page.locator('body').innerText();
    if(/차단|액세스 거부|access blocked|couldn.t sign you in|이 브라우저.*안전/i.test(body))throw Error('SECURITY_REFUSED');
    if(!selectedGoogle&&u.pathname.includes('accountchooser')){
     const choice=page.getByRole('link',{name:new RegExp(target.email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i')});
     if(await choice.count()){selectedGoogle=true;await choice.click();}
     else{result('NEEDS_GOOGLE_LOGIN','Target Google account is not signed in; existing connections preserved');process.exitCode=2;break;}
    }else if(!continuedGoogle&&body.includes(target.email)&&/다시 로그인|signing.*back/i.test(body)){
     continuedGoogle=true;await page.getByRole('button',{name:/^(계속|Continue)$/}).click();
    }else if(!u.pathname.includes('oauth')&&!u.pathname.includes('accountchooser')){
     result('NEEDS_GOOGLE_LOGIN','Initial sign-in or MFA required; credentials are not stored by this tool');process.exitCode=2;break;
    }
   }else if(u.origin!=='about:blank')throw Error('Unexpected authorization origin');
   await delay(500);
  }
  if(process.exitCode!==2){await settings();if(!(await emails()).includes(target.email))throw Error('OAuth outcome uncertain; do not retry');}
 }
 if(process.exitCode!==2){
  if(!(await emails()).includes(target.email))throw Error('Requested account is not connected');
  result('CONNECTOR_REGISTERED','Account connected; use the link_id exposed by the actual tool schema. Existing accounts preserved.');
 }
}
}catch(error){result(error.phase||'HOLD',String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[url]').slice(0,200));process.exitCode=1;}
finally{
 if(browser)await browser.close();
 if(lease){try{helper(['-Action','Release','-OwnerId',owner,'-LeaseToken',lease.lease_token]);}
 catch{result('HOLD','Lease cleanup uncertain');process.exitCode=1;}}
}

}
