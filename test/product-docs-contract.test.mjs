import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const ROOT_DOCS = ['AGENTS.md', 'PRODUCT.md', 'DESIGN.md', 'IA.md', 'MOTION.md', 'SECURITY.md', 'TESTING.md'];

test('product operating documents keep separate responsibilities', () => {
  for (const file of ROOT_DOCS) assert.equal(fs.existsSync(file), true, `${file} must exist`);
  assert.equal(fs.existsSync('docs/architecture.md'), true, 'architecture remains in its existing canonical document');

  const motion = fs.readFileSync('MOTION.md', 'utf8');
  assert.match(motion, /prefers-reduced-motion/);
  assert.match(motion, /100–180ms/);
  assert.match(motion, /180–260ms/);
  assert.match(motion, /browser-visible PASS/);

  const reportingDirective = fs.readFileSync('guidance/directives/fragments/common.md', 'utf8');
  assert.match(reportingDirective, /쉬운 한국어.*결과·(?:필요 )?근거·남은 일/s);
  assert.match(reportingDirective, /작성·배포·설치·실제 작동과 미실행을 구분/);
  assert.match(reportingDirective, /화면의 한도 안내만으로 작업을 멈추지 않는다/);
  assert.match(reportingDirective, /실제 요청 거절과 연결 오류를 구분/);
  assert.match(reportingDirective, /불명 전송은 먼저 조정/);
  assert.match(reportingDirective, /보안 거절은 우회하지 않는다/);
  assert.match(reportingDirective, /검사 범위는 현재 모델 정책과 명시 요청/);
  assert.equal(fs.existsSync('guidance/skills/notify-user/SKILL.md'), true);
});

test('directive authoring guide keeps rules concise, layered, and testable', () => {
  const guide = fs.readFileSync('guidance/directives/README.md', 'utf8');
  assert.match(guide, /전역 포함 조건/);
  assert.match(guide, /가장 가까운 프로젝트 `AGENTS\.md`/);
  assert.match(guide, /같은 규칙은 한 정본에만 둔다/);
  assert.match(guide, /한 항목에는 한 가지 핵심 행동.*같은 뜻은 한 번만 말한다/);
  assert.match(guide, /수치는 측정값이나 실제 계약일 때만 고정한다/);
  assert.match(guide, /결론·필수 근거·중요 위험·다음 행동/);
  assert.match(guide, /코드·스크립트와\s+테스트/);
  assert.match(guide, /명시적 권한.*녹화 기반\s+skill/s);
  assert.match(guide, /완료에 필요한 검증은 common\.md의 검증 계약을 따른다/);
  assert.match(guide, /모델 이름만으로 생략하지 않으며/);
  assert.match(guide, /배포기의 파일 복사 응답과 실제 사용 성공을 구분한다/);
  assert.match(guide, /기존 deploy_directives\.ps1\/deploy_active_skills\.ps1에 exact 대상과 스킬/);
});

test('product documentation does not make optional visual dependencies mandatory', () => {
  const productContract = ['PRODUCT.md', 'DESIGN.md', 'IA.md', 'MOTION.md', 'TESTING.md']
    .map(file => fs.readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(productContract, /(?:must|required|필수).{0,60}(?:Lottie|Three\.js|GSAP|Rive|Vue|Nuxt)/i);
});

test('repository exposes OS-native final verification gates without external skill paths', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const testing = fs.readFileSync('TESTING.md', 'utf8');
  const windowsGate = fs.readFileSync('scripts/verify-windows.ps1', 'utf8');
  assert.equal(packageJson.scripts['verify:windows'], 'pwsh -NoProfile -File scripts/verify-windows.ps1');
  assert.match(testing, /npm run verify:windows/);
  assert.doesNotMatch(testing, /product-design-engineering/);
  assert.match(windowsGate, /\[switch\]\$DryRun/);
  assert.match(windowsGate, /git'.+diff.+--check/s);
});
