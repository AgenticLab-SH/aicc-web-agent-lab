// Executed through the existing authenticated SSH path. Never handles inference.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=process.env.AICC_OCX_PACKAGE_ROOT;
const load=relative=>import(pathToFileURL(path.join(root,relative)).href);
const request=JSON.parse(await Bun.stdin.text());
const {loadConfig}=await load('src/config.ts');
const store=await load('src/codex/account-store.ts');
const config=loadConfig();
const accounts=(config.codexAccounts??[]).filter(row=>!row.isMain);
if(request.action==='snapshot'){
  const allowed=['defaultProvider','fastRows','openaiProviderTierVersion','subagentModelsVersion','subagentModels','pausedCodexAccountIds','showCodexCredits','codexAccountNamespaces','codexAccountPriorities','codexAccountPriorityFailback','activeCodexAccountPinned','codexAccountPickerEnabled','autoSwitchThreshold','accountPoolStrategy','accountPoolStickyLimit','multiAgentMode'];
  const safe=Object.fromEntries(allowed.filter(key=>Object.hasOwn(config,key)).map(key=>[key,config[key]]));
  // Clearing the last pause/priority must clear the local mirror as well.
  safe.pausedCodexAccountIds=config.pausedCodexAccountIds??[];
  safe.codexAccountPriorities=config.codexAccountPriorities??{};
  safe.codexAccountPriorityFailback=config.codexAccountPriorityFailback===true;
  // Only the already registered first-party forward provider is transferred.
  const provider=config.providers?.openai;
  if(provider?.baseUrl!=='https://chatgpt.com/backend-api/codex'||provider.authMode!=='forward'||provider.adapter!=='openai-responses')throw Error('unexpected_provider');
  safe.providers={openai:{adapter:provider.adapter,baseUrl:provider.baseUrl,authMode:'forward',codexAccountMode:'pool'}};
  safe.codexAccounts=accounts;
  const records={};
  for(const account of accounts){
    const record=store.readCodexAccountRecord(account.id);
    if(!record||record.deletedAt!=null||!record.credential)continue;
    records[account.id]={generation:record.generation,quotaHistoryIdentity:record.quotaHistoryIdentity,
      lastCodexValidatedAt:record.lastCodexValidatedAt,lastCodexValidationStatus:record.lastCodexValidationStatus,
      codexValidationPending:record.codexValidationPending,lastCodexValidationTerminal:record.lastCodexValidationTerminal,
      credential:{accessToken:'',refreshToken:'',expiresAt:0,chatgptAccountId:record.credential.chatgptAccountId}};
  }
  const settings=JSON.parse(fs.readFileSync(path.join(process.env.OPENCODEX_HOME,'aicc-window-policy.json'),'utf8'));
  console.log(JSON.stringify({ok:true,observedAt:Date.now(),config:safe,records,settings}));
}else{
  const id=request.id;
  if(typeof id!=='string'||!accounts.some(account=>account.id===id))throw Error('unknown_account');
  if(request.action==='recover'){
    const record=store.readCodexAccountRecord(id);
    if(!record?.credential)throw Error('credential_missing');
    if(record.generation===request.generation&&createHash('sha256').update(record.credential.accessToken).digest('hex')===request.rejectedHash){
      await store.forceRefreshCodexPoolToken(id,{rejectedGeneration:record.generation,rejectedAccessToken:record.credential.accessToken});
    }
  }
  const token=await store.getValidCodexToken(id);
  const record=store.readCodexAccountRecord(id);
  if(record?.generation!==token.generation||record.credential?.accessToken!==token.accessToken)throw Error('credential_changed');
  console.log(JSON.stringify({ok:true,...token,expiresAt:record.credential.expiresAt,leasedAt:Date.now()}));
}
