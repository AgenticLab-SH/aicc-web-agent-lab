import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { SlackCaptchaBrowserLeaseGuard } from '../src/notifications/slack-captcha-browser-guard.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-captcha-browser-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let now=Date.parse('2026-09-26T00:00:00Z');
  const store=new DurableJobStore({root:path.join(root,'jobs'),now:()=>now});
  store.transaction('seed',state=>{
    state.resourceLeases['res-1']={leaseId:'res-1',resourceType:'browser-slot',resourceId:'cdp:9223',ownerTaskId:'codex-task-42',ownerActorId:'attempt-1',accessMode:'write',state:'leased',expiresAt:new Date(now+60000).toISOString()};
    state.browserLeases['browser-lease-42']={leaseId:'browser-lease-42',ownerTaskId:'codex-task-42',ownerAttemptId:'attempt-1',targetId:'target-42',accessMode:'interact',capabilities:['inspect','type'],permittedOrigins:['https://example.com'],state:'leased',expiresAt:new Date(now+60000).toISOString(),resourceLeaseId:'res-1',resourceId:'cdp:9223'};
  });
  return {root,store,guard:new SlackCaptchaBrowserLeaseGuard({store,now:()=>now}),advance:ms=>{now+=ms}};
}

const request={taskId:'codex-task-42',browserLeaseId:'browser-lease-42',browserTargetId:'target-42',browserOrigin:'https://example.com'};

test('CAPTCHA value access requires the exact active interactive browser lease and write resource lease',t=>{
  const f=fixture(t);
  const result=f.guard.authorize(request);
  assert.deepEqual(result,{ok:true,taskId:'codex-task-42',leaseId:'browser-lease-42',targetId:'target-42',origin:'https://example.com',capability:'type'});
});

test('wrong task, target and origin fail before a CAPTCHA value can be consumed',t=>{
  const f=fixture(t);
  assert.throws(()=>f.guard.authorize({...request,taskId:'other-task'}),e=>e.code==='captcha_browser_task_mismatch');
  assert.throws(()=>f.guard.authorize({...request,browserTargetId:'other-target'}),e=>e.code==='captcha_browser_target_mismatch');
  assert.throws(()=>f.guard.authorize({...request,browserOrigin:'https://other.example'}),e=>e.code==='captcha_browser_origin_denied');
});

test('observe-only, expired, and resource-lease drift all fail closed',t=>{
  const f=fixture(t);
  f.store.transaction('observe',state=>{state.browserLeases['browser-lease-42'].accessMode='observe';});
  assert.throws(()=>f.guard.authorize(request),e=>e.code==='captcha_browser_type_denied');
  f.store.transaction('restore',state=>{state.browserLeases['browser-lease-42'].accessMode='interact';state.resourceLeases['res-1'].resourceId='cdp:9999';});
  assert.throws(()=>f.guard.authorize(request),e=>e.code==='captcha_browser_resource_lease_invalid');
  f.store.transaction('resource-restore',state=>{state.resourceLeases['res-1'].resourceId='cdp:9223';});
  f.advance(61000);
  assert.throws(()=>f.guard.authorize(request),e=>e.code==='captcha_browser_lease_inactive');
});