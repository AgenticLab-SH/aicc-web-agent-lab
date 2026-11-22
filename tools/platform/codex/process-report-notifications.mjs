import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const stateRoot=path.join(os.homedir(),'.ai-control-center');
const configFile=path.join(stateRoot,'notifications','control-report-bridge.json');
const scheduler=JSON.parse(fs.readFileSync(path.join(stateRoot,'notifications','process-due-scheduler.json'),'utf8'));
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try{
 if(digest(scheduler.node)!==scheduler.nodeSha256||digest(scheduler.cli)!==scheduler.cliSha256)throw Error('registered_sender_changed');
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 if(scheduler.controlReportBridge?.releaseRoot!==path.resolve(root)||digest(path.join(root,'report-bridge-manifest.json'))!==scheduler.controlReportBridge.manifestSha256)throw Error('registered_report_bridge_changed');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'report-bridge-manifest.json'),'utf8'));
 for(const [relative,sha] of Object.entries(manifest.files)){
  const file=path.resolve(root,relative);
  if(!file.startsWith(root)||digest(file)!==sha)throw Error('report_bridge_release_changed');
 }
 const {collectControlReportNotifications,readControlReportBridgeConfig}=await import('../../../src/notifications/control-report-bridge.mjs');
 const collected=collectControlReportNotifications(readControlReportBridgeConfig(configFile),{stateRoot});
 fs.writeFileSync(path.join(stateRoot,'notifications','control-report-bridge-last.json'),JSON.stringify({...collected,observedAt:new Date().toISOString()}));
}catch{
 // Reporting intake failure must not interrupt previously armed notifications.
 fs.writeFileSync(path.join(stateRoot,'notifications','control-report-bridge-last.json'),JSON.stringify({state:'HOLD',reason:'report_collection_failed',observedAt:new Date().toISOString()}));
}
// Keep the exact registered sender, identity verification, retry/UNKNOWN policy
// and outbox. No extra scheduler, model call, prompt replay or direct Slack send.
if(digest(scheduler.node)!==scheduler.nodeSha256||digest(scheduler.cli)!==scheduler.cliSha256)throw Error('registered_sender_changed');
const child=spawnSync(scheduler.node,[scheduler.cli,'notify','process-due','--json'],{windowsHide:true,encoding:'utf8',timeout:45000});
process.exitCode=child.status??1;
