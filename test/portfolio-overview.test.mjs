import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPortfolioOverview } from '../src/portfolio-overview.mjs';

test('overview preserves group scope, hides raw records and detects changed canon', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-overview-'));
  // Preserve this exact bounded fixture for failure diagnosis; no recursive cleanup.
  const op=path.join(root,'ops','web-group-tray-20261106');fs.mkdirSync(op,{recursive:true});fs.mkdirSync(path.join(root,'context'));
  const current=path.join(root,'context','PROJECT.md'),remaining=path.join(op,'G1-G4-REMAINING-20261110.md');
  fs.writeFileSync(current,'private owner prompt');fs.writeFileSync(remaining,'original UNKNOWN');
  const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const row=id=>({id,name:id,state:'HOLD',purpose:'목적',initial:'시작',current:'아직 미완료',products:['앱'],completed:['확인'],remaining:['잔여'],next:'다음',milestones:['이력'],evidence:['근거'],stages:['구현 부분']});
  const record={privatePrompt:'must not leak',userFacingOverview:{schemaVersion:1,reviewedAt:'2026-11-20T12:00:00+09:00',summary:'요약',order:['G1','G3','G2','G4'],scope:'대조 범위',timeline:['시작'],sourcePins:{project:hash(current),remaining:hash(remaining)},groups:['G1','G3','G2','G4','G-DOC','G5','G6','G7','G8','G9'].map(row)}};
  const file=path.join(op,'execution.json'),save=()=>fs.writeFileSync(file,JSON.stringify(record));save();
  const read=()=>readPortfolioOverview({codexRoot:root});
  assert.equal(read().groups.find(g=>g.id==='G-DOC').displayId,'G10');
  assert.equal(read().status,'AVAILABLE');assert.equal(read().groups.length,10);assert.equal(read().runtimeVerified,false);
  assert.ok(!JSON.stringify(read()).includes('private'));assert.ok(!JSON.stringify(read()).includes(root));
  const before=fs.readFileSync(file);fs.writeFileSync(current,'changed');assert.equal(read().status,'STALE');assert.deepEqual(fs.readFileSync(file),before);
  record.userFacingOverview.groups[0].next='C:\\demo\\owner';save();assert.equal(read().status,'UNAVAILABLE');
  record.userFacingOverview.groups[0]=row('G3');save();assert.equal(read().status,'UNAVAILABLE');
  fs.writeFileSync(file,'{');assert.equal(read().status,'UNAVAILABLE');assert.deepEqual(read().groups,[]);
});
