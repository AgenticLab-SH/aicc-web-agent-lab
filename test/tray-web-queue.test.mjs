import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readWebQueueStatus} from '../tools/platform/windows/tray-status.mjs';
test('tray consumes only validated queue aggregate and keeps missing owner unavailable',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'tray-queue-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  assert.equal((await readWebQueueStatus({localAppData:base})).state,'unavailable');
  const config=path.join(base,'AICC/native-hosts/webgpt-queue/native-host.config.json');
  const script=path.join(base,'source/scripts/aicc-status.mjs');
  fs.mkdirSync(path.dirname(config),{recursive:true});fs.mkdirSync(path.dirname(script),{recursive:true});
  fs.writeFileSync(script,'');fs.writeFileSync(config,JSON.stringify({sourceDirectory:path.join(base,'source')}));
  const counts={runs:3,active:1,paused:1,completed:1,failed:0,cancelled:0,unknown:0,readyRoles:0,runningRoles:1};
  const result=await readWebQueueStatus({localAppData:base,runner:async()=>({schemaVersion:1,state:'ready',counts,prompt:'SECRET',claimToken:'SECRET'})});
  assert.equal(result.state,'ready');assert.deepEqual(result.counts,counts);assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal((await readWebQueueStatus({localAppData:base,runner:async()=>({schemaVersion:1,state:'ready',counts:{...counts,active:-1}})})).state,'unavailable');
});

test('G1 tray accepts bounded opaque queue targets and refuses unsafe detail fields',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'tray-detail-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const config=path.join(base,'AICC/native-hosts/webgpt-queue/native-host.config.json');
  const script=path.join(base,'source/scripts/aicc-status.mjs');
  fs.mkdirSync(path.dirname(config),{recursive:true});fs.mkdirSync(path.dirname(script),{recursive:true});
  fs.writeFileSync(script,'');fs.writeFileSync(config,JSON.stringify({sourceDirectory:path.join(base,'source')}));
  const counts={runs:1,active:0,paused:1,completed:0,failed:0,cancelled:0,unknown:0,readyRoles:0,runningRoles:0};
  const entry={runRef:'a'.repeat(12),status:'paused',targetRef:'b'.repeat(12),targetState:'RECORDED_UNVERIFIED',roles:2,reason:'SUBMISSION_UNCERTAIN',control:'CHROME_QUEUE_EXTENSION_ONLY'};
  let called=false;
  const data=await readWebQueueStatus({localAppData:base,runner:async (_cmd,args)=>{called=args.includes('--tray-details');return {schemaVersion:1,state:'ready',counts,items:[entry],itemsTruncated:false,raw:'SECRET'};}});
  assert.equal(called,true);assert.equal(data.state,'ready');
  assert.deepEqual(data.items,[entry]);assert.equal(data.controls,'CHROME_QUEUE_EXTENSION_ONLY');
  assert.equal(JSON.stringify(data).includes('SECRET'),false);
  const rogue=await readWebQueueStatus({localAppData:base,runner:async()=>({schemaVersion:1,state:'ready',counts,items:[{...entry,prompt:'PRIVATE'}],itemsTruncated:false})});
  assert.equal(rogue.state,'unavailable');assert.equal(rogue.reason,'details_invalid');
  const replaced=await readWebQueueStatus({localAppData:base,runner:async()=>({schemaVersion:1,state:'ready',counts,items:[{...entry,control:'ARBITRARY_EXEC'}],itemsTruncated:false})});
  assert.equal(replaced.state,'unavailable');
});
