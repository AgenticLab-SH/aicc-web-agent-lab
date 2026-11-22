import {readFileSync,existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

export type AiccWindowRule={usedThreshold:number;action:'switch'|'stop'};
export type AiccWindowSettings={schemaVersion:1;fiveHour:AiccWindowRule;longWindow:AiccWindowRule;revision?:string};
const ownerHome=()=>process.env.OPENCODEX_HOME||join(homedir(),'.opencodex');
export function readAiccWindowSettings():AiccWindowSettings {
  const file=join(ownerHome(),'aicc-window-policy.json');
  if(!existsSync(file))return {schemaVersion:1,fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:97,action:'switch'}};
  if(lstatSync(file).isSymbolicLink())throw Error('Linked AICC window policy refused');
  const value=JSON.parse(readFileSync(file,'utf8'));
  if(value?.schemaVersion!==1||!['fiveHour','longWindow'].every(key=>Number.isInteger(value[key]?.usedThreshold)&&value[key].usedThreshold>=1&&value[key].usedThreshold<=100&&['switch','stop'].includes(value[key]?.action)))throw Error('Invalid AICC window policy; request blocked');
  return {...value,fiveHour:{...value.fiveHour,usedThreshold:Math.min(97,value.fiveHour.usedThreshold)},longWindow:{...value.longWindow,usedThreshold:Math.min(98,value.longWindow.usedThreshold)}};
}
// Capture before pool selection can rotate the active account. No secret is returned.
export function captureAiccPolicyAccount():string|undefined {
  const value=JSON.parse(readFileSync(join(ownerHome(),'config.json'),'utf8')).activeCodexAccountId;
  return typeof value==='string'?value:undefined;
}
