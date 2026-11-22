// Bounded read/attachment validation in the existing owner-local backup area.
// This contract cannot dispatch inference or mutate the operating registry.
import {isAbsolute,join,relative} from 'node:path';
import {lstatSync} from 'node:fs';
import {dirname} from 'node:path';

export function assertPlainStagePaths(paths:string[]) {
  for(const target of paths)for(let p=target;;p=dirname(p)){
    if(lstatSync(p).isSymbolicLink())throw Error('original_owner_stage_alias_refused');
    if(dirname(p)===p)break;
  }
}

export function resolveOwnerStage(registry:any,profile:string,osHome:string,now=Date.now()) {
  const stage=registry.originalOwnerStage;
  if(stage===undefined)return undefined;
  const deny=()=>{throw Error('original_owner_stage_contract_required');};
  if(!stage||typeof stage!=='object'||Array.isArray(stage)||
    Object.keys(stage).sort().join(',')!=='dataPort,expiresAt,id,managementPort,mode,schemaVersion'||
    stage.schemaVersion!==1||stage.mode!=='identity-and-attachment-only'||
    !/^[a-f0-9]{32}$/.test(stage.id)||!isAbsolute(profile)||!isAbsolute(osHome))deny();
  const expected=join(osHome,'.ai-control-center','backups','ocx-original-owner-staging',stage.id);
  // Compare complete paths, not string prefixes; real owner HOME is never a stage.
  if(relative(expected,profile)!==''||relative(osHome,profile)==='')deny();
  const home=join(profile,'.ai-control-center','runtime','ocx-local','home');
  if(typeof registry.opencodexHome!=='string'||typeof registry.tokenFile!=='string'||
    relative(home,registry.opencodexHome)!==''||
    relative(home,registry.tokenFile)!=='api-auth-token')deny();
  const expires=Date.parse(stage.expiresAt);
  if(!Number.isFinite(expires)||new Date(expires).toISOString()!==stage.expiresAt||
    expires<=now||expires-now>15*60_000)deny();
  const ports=[stage.dataPort,stage.managementPort];
  if(ports.some(p=>!Number.isInteger(p)||p<49152||p>65535)||ports[0]===ports[1])deny();
  return Object.freeze({home,ports:Object.freeze(ports),expiresAt:expires,
    managementPort:stage.managementPort,id:stage.id});
}

export function stageRequestAllowed(stage:ReturnType<typeof resolveOwnerStage>,method:string,path:string,now=Date.now()) {
  if(!stage)return true;
  if(now>=stage.expiresAt||method!=='GET')return false;
  return ['/healthz','/readyz','/livez','/api/aicc-local/original-issuer/identity'].includes(path);
}

export function stageCandidatePolicyMatches(
  stage:ReturnType<typeof resolveOwnerStage>,manifestPolicy:any,acceptancePolicy:any,
) {
  return Boolean(stage && [manifestPolicy,acceptancePolicy].every(policy =>
    policy?.protocol==='retained-child-bootstrap/v1' &&
    policy.artifactContract==='shipping-cli-appserver/v1' &&
    policy.originalTuiAttachment==='SHIPPING_BUILD_CANDIDATE_ONLY' &&
    policy.canActivate===false && /^[a-f0-9]{64}$/.test(policy.bunSha256) &&
    /^[a-f0-9]{64}$/.test(policy.shippingBuildSha256)) &&
    manifestPolicy.bunSha256===acceptancePolicy.bunSha256 &&
    manifestPolicy.shippingBuildSha256===acceptancePolicy.shippingBuildSha256);
}
