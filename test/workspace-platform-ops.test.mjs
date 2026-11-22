import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyUnifiedPatch } from '../components/workspace-mcp/platform-ops.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-patch-parent-'));
  // Only this test's exact temporary directory is removed.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resolvePath = relative => {
    const target = path.resolve(root, relative);
    const rel = path.relative(root, target);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('outside');
    return target;
  };
  return { root, resolvePath };
}
const create = (name, text = '한글 검증') => `--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${text}\n`;

test('nested UTF-8 create, edit and delete preserve the actual file content', t => {
  const { root, resolvePath } = fixture(t);
  const name = 'parent/새 폴더/한글.txt';
  applyUnifiedPatch(root, create(name), { resolvePath });
  assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), '한글 검증\n');
  applyUnifiedPatch(root, `--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-한글 검증\n+수정 완료\n`, { resolvePath });
  assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), '수정 완료\n');
  applyUnifiedPatch(root, `--- a/${name}\n+++ /dev/null\n@@ -1 +0,0 @@\n-수정 완료\n`, { resolvePath });
  assert.equal(fs.existsSync(path.join(root, name)), false);
});
test('invalid later hunk creates no directories or earlier files', t => {
  const { root, resolvePath } = fixture(t);
  fs.writeFileSync(path.join(root, 'existing.txt'), 'original\n');
  assert.throws(() => applyUnifiedPatch(root, create('new/deep/file.txt') + '--- a/existing.txt\n+++ b/existing.txt\n@@ -1 +1 @@\n-wrong\n+changed\n', { resolvePath }));
  assert.equal(fs.existsSync(path.join(root, 'new')), false);
  assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'original\n');
});
test('linked existing parent cannot redirect a nested create', t => {
  const { root, resolvePath } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-patch-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => applyUnifiedPatch(root, create('redirect/new/file.txt'), { resolvePath }));
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('regular file parent failure rolls back only newly created empty parents', t => {
  const { root, resolvePath } = fixture(t);
  fs.writeFileSync(path.join(root, 'blocked'), 'keep');
  assert.throws(() => applyUnifiedPatch(root, create('new/deep/file.txt') + create('blocked/file.txt'), { resolvePath }));
  assert.equal(fs.existsSync(path.join(root, 'new')), false);
  assert.equal(fs.readFileSync(path.join(root, 'blocked'), 'utf8'), 'keep');
});
