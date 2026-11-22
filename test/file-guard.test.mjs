import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { ResourceLeaseManager } from '../src/control-plane/resource-lease.mjs';
import { FileGuard } from '../src/control-plane/file-guard.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-file-guard-root-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-file-guard-state-'));
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-file-guard-store-'));
  t.after(() => { fs.rmSync(root,{recursive:true,force:true}); fs.rmSync(stateRoot,{recursive:true,force:true}); fs.rmSync(storeRoot,{recursive:true,force:true}); });
  fs.mkdirSync(path.join(root,'docs'));
  fs.writeFileSync(path.join(root,'docs','a.txt'),'before');
  const leases = new ResourceLeaseManager({ store: new DurableJobStore({ root: storeRoot }) });
  const guard = new FileGuard({ root, stateRoot, resourceLeases: leases, now: () => 1_800_000_000_000 });
  return { root, stateRoot, leases, guard };
}

test('replace requires exact preimage, preserves backup, verifies post-read, and rejects replay', t => {
  const f=fixture(t);
  const before=hash('before');
  const result=f.guard.replace({requestId:'replace-001',relativePath:'docs/a.txt',content:'after',expectedSha256:before,ownerTaskId:'task-a',ownerActorId:'agent-a'});
  assert.equal(fs.readFileSync(path.join(f.root,'docs','a.txt'),'utf8'),'after');
  assert.equal(result.receipt.preSha256,before);
  assert.equal(result.receipt.postSha256,hash('after'));
  assert.equal(fs.readFileSync(path.join(f.stateRoot,result.receipt.backupPath),'utf8'),'before');
  assert.throws(()=>f.guard.replace({requestId:'replace-001',relativePath:'docs/a.txt',content:'again',expectedSha256:hash('after'),ownerTaskId:'task-a',ownerActorId:'agent-a'}),e=>e.code==='file_mutation_replay');
});

test('wrong preimage and path traversal fail before mutation', t => {
  const f=fixture(t);
  assert.throws(()=>f.guard.replace({requestId:'replace-002',relativePath:'docs/a.txt',content:'bad',expectedSha256:'0'.repeat(64),ownerTaskId:'task-a',ownerActorId:'agent-a'}),e=>e.code==='preimage_mismatch');
  assert.equal(fs.readFileSync(path.join(f.root,'docs','a.txt'),'utf8'),'before');
  assert.throws(()=>f.guard.replace({requestId:'replace-003',relativePath:'../escape.txt',content:'bad',ownerTaskId:'task-a',ownerActorId:'agent-a'}),e=>e.code==='file_target_escape');
});

test('quarantine moves instead of deleting and writes a recovery receipt', t => {
  const f=fixture(t);
  const result=f.guard.quarantine({requestId:'quarantine-001',relativePath:'docs/a.txt',expectedSha256:hash('before'),ownerTaskId:'task-a',ownerActorId:'agent-a'});
  assert.equal(fs.existsSync(path.join(f.root,'docs','a.txt')),false);
  const q=path.join(f.stateRoot,result.receipt.quarantinePath);
  assert.equal(fs.readFileSync(q,'utf8'),'before');
  assert.equal(result.receipt.preSha256,hash('before'));
});

test('shared file-mutation lease blocks concurrent mutation ownership', t => {
  const f=fixture(t);
  const resourceId='file:'+hash('docs/a.txt');
  const held=f.leases.acquire({resourceType:'file-mutation',resourceId,ownerTaskId:'task-x',ownerActorId:'agent-x'});
  assert.throws(()=>f.guard.replace({requestId:'replace-004',relativePath:'docs/a.txt',content:'after',expectedSha256:hash('before'),ownerTaskId:'task-a',ownerActorId:'agent-a'}),e=>e.code==='resource_busy');
  f.leases.release(held.leaseId,{ownerTaskId:'task-x',ownerActorId:'agent-x'});
});

test('rollback restores an overwritten preimage and quarantines the displaced postimage', t => {
  const f=fixture(t);
  const original=f.guard.replace({requestId:'replace-rb-001',relativePath:'docs/a.txt',content:'after',expectedSha256:hash('before'),ownerTaskId:'task-a',ownerActorId:'agent-a'});
  const rolled=f.guard.rollback({requestId:'rollback-001',originalRequestId:'replace-rb-001',ownerTaskId:'task-a',ownerActorId:'agent-a'});
  assert.equal(fs.readFileSync(path.join(f.root,'docs','a.txt'),'utf8'),'before');
  assert.equal(rolled.receipt.restoredSha256,hash('before'));
  assert.equal(fs.readFileSync(path.join(f.stateRoot,rolled.receipt.displacedPath),'utf8'),'after');
  assert.equal(original.receipt.postSha256,hash('after'));
});

test('rollback of a newly created file removes it by quarantine instead of deleting it', t => {
  const f=fixture(t);
  const created=f.guard.replace({requestId:'replace-new-001',relativePath:'docs/new.txt',content:'new',ownerTaskId:'task-a',ownerActorId:'agent-a'});
  assert.equal(created.receipt.preimageExisted,false);
  const rolled=f.guard.rollback({requestId:'rollback-new-001',originalRequestId:'replace-new-001',ownerTaskId:'task-a',ownerActorId:'agent-a'});
  assert.equal(fs.existsSync(path.join(f.root,'docs','new.txt')),false);
  assert.equal(fs.readFileSync(path.join(f.stateRoot,rolled.receipt.displacedPath),'utf8'),'new');
  assert.equal(rolled.receipt.targetPresent,false);
});

test('rollback restores a quarantined file and refuses to overwrite an occupied target', t => {
  const f=fixture(t);
  f.guard.quarantine({requestId:'quarantine-rb-001',relativePath:'docs/a.txt',expectedSha256:hash('before'),ownerTaskId:'task-a',ownerActorId:'agent-a'});
  const rolled=f.guard.rollback({requestId:'rollback-q-001',originalRequestId:'quarantine-rb-001',ownerTaskId:'task-a',ownerActorId:'agent-a'});
  assert.equal(fs.readFileSync(path.join(f.root,'docs','a.txt'),'utf8'),'before');
  assert.equal(rolled.receipt.originalOperation,'quarantine');
});

test('rollback refuses postimage drift instead of overwriting unrelated edits', t => {
  const f=fixture(t);
  f.guard.replace({requestId:'replace-drift-001',relativePath:'docs/a.txt',content:'after',expectedSha256:hash('before'),ownerTaskId:'task-a',ownerActorId:'agent-a'});
  fs.writeFileSync(path.join(f.root,'docs','a.txt'),'someone-else');
  assert.throws(()=>f.guard.rollback({requestId:'rollback-drift-001',originalRequestId:'replace-drift-001',ownerTaskId:'task-a',ownerActorId:'agent-a'}),e=>e.code==='rollback_target_drift');
  assert.equal(fs.readFileSync(path.join(f.root,'docs','a.txt'),'utf8'),'someone-else');
});
