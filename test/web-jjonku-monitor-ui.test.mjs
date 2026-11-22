import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
test('selection controls explain scope and do not hardcode former chat IDs or automatic scheduler creation', () => {
  const section = html.slice(html.indexOf('class="web-jjonku-config panel"'), html.indexOf('class="project-service-control panel"'));
  assert.match(section, /webJjonkuTargets/); assert.match(section, /대화 추가/);
  assert.match(section, /외부 도구의 완료/); assert.match(section, /설치된 로컬 타이머/);
  assert.match(section, /id="addWebJjonkuTarget" type="button" disabled/);
  assert.doesNotMatch(section, /7개|해커톤 분석 정리/);
  const logic = script.slice(script.indexOf('function selectedWebTargets'), script.indexOf('webJjonkuConfigForm?.addEventListener'));
  assert.match(logic, /expectedRevision/); assert.match(logic, /autoResume: false/);
  assert.doesNotMatch(logic, /tabConversationIds|heartbeat가 활성화/);
});
