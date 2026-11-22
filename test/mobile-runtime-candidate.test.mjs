import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { checkMobileRuntimeCandidate } from '../scripts/check-mobile-runtime-candidate.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-static-candidate-'));
  const baseRoot = path.join(root, 'base'), sourceRoot = path.join(root, 'source');
  function write(root, name, value) {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
    const bytes = fs.readFileSync(file);
    return { path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const base = [write(baseRoot, 'src/dep.mjs', 'export const value=1;')];
  const sources = {
    'src/server.mjs': 'throw Error("CANDIDATE_MUST_NEVER_EXECUTE");\nexport {value} from "./dep.mjs";',
    'src/mobile-control.mjs': 'export async function helper(){return import("./dep.mjs");}',
    'public/mobile.html': '<link href="/mobile.css"><script src=\'/dashboard-workspace.js\'></script>',
    'public/supervise.html': '<script src=/dashboard-workspace.js></script>',
    'public/dashboard-workspace.js': 'import "/dependency.js"; throw Error("NO_BROWSER_EXECUTION");',
    'public/dependency.js': 'export const x=1;',
    'public/mobile.css': '@import "./extra.css"; .x{background:url("/favicon.svg");}',
    'public/extra.css': '.x{color:green}',
    'public/aicc.webmanifest': '{"icons":[{"src":"/favicon.svg"}]}',
    'public/favicon.svg': '<svg></svg>'
  };
  const overlays = Object.entries(sources).map(([name, value]) => write(sourceRoot, name, value));
  return { root, baseRoot, sourceRoot, sources, overlays, base, write, input: () => ({ mode: 'projection', baseRoot, sourceRoot, baselinePins: base, overlays }) };
}

test('preflight traverses transitive exports, literal dynamic imports, browser assets and icons without execution', () => {
  const f = fixture(); const report = checkMobileRuntimeCandidate(f.input());
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.candidateCodeExecuted, false); assert.equal(report.servicesStarted, 0); assert.equal(report.externalRequests, 0);
  assert.ok(report.modulesParsed >= 5); assert.ok(report.localEdges >= 8);
});

test('missing imports, HTML/CSS/icon assets and new URL worker dependencies block the candidate', () => {
  for (const [file, content, target] of [
    ['src/mobile-control.mjs', 'const loader=()=>import("./missing.mjs");', 'src/missing.mjs'],
    ['src/server.mjs', 'const worker=new URL("./worker.mjs",import.meta.url);', 'src/worker.mjs'],
    ['public/mobile.html', '<script src="/missing.js"></script>', 'public/missing.js'],
    ['public/mobile.css', '.x{background:url(/missing.svg)}', 'public/missing.svg'],
    ['public/aicc.webmanifest', '{"icons":[{"src":"/missing.png"}]}', 'public/missing.png']
  ]) {
    const f = fixture(); f.overlays[f.overlays.findIndex(pin => pin.path === file)] = f.write(f.sourceRoot, file, content);
    const report = checkMobileRuntimeCandidate(f.input());
    assert.equal(report.ok, false); assert.ok(report.errors.some(error => error.target === target), JSON.stringify(report.errors));
  }
});

test('changed pins, duplicate/path-escaping pins, invalid syntax and public-to-private references fail closed', () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.sourceRoot, 'src/server.mjs'), '// concurrent change');
  assert.equal(checkMobileRuntimeCandidate(f.input()).ok, false);
  const duplicate = fixture(); duplicate.base.push(duplicate.base[0]);
  assert.equal(checkMobileRuntimeCandidate(duplicate.input()).errors[0].code, 'candidate_pin_invalid');
  const escape = fixture(); escape.base.push({ path: '../escape.mjs', size: 0, sha256: 'a'.repeat(64) });
  assert.equal(checkMobileRuntimeCandidate(escape.input()).ok, false);
  const syntax = fixture(); syntax.overlays[0] = syntax.write(syntax.sourceRoot, 'src/server.mjs', 'const = ;');
  assert.ok(checkMobileRuntimeCandidate(syntax.input()).errors.some(e => e.code === 'candidate_syntax_invalid'));
  const privateRef = fixture(); privateRef.overlays.push(privateRef.write(privateRef.sourceRoot, 'public/escape.js', 'import "../src/dep.mjs";'));
  assert.ok(checkMobileRuntimeCandidate(privateRef.input()).errors.some(e => e.code === 'candidate_dependency_escape'));
});

test('sealed mode checks the exact manifest and reads modules without importing the entrypoint', () => {
  const f = fixture();
  const files = [...f.base, ...f.overlays];
  for (const pin of f.base) {
    const target = path.join(f.sourceRoot, pin.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(f.baseRoot, pin.path), target);
  }
  const bytes = JSON.stringify({ schemaVersion: 1, component: 'mobile-public-control', files, overlays: f.overlays });
  fs.writeFileSync(path.join(f.sourceRoot, '.aicc-release.json'), bytes);
  const input = { mode: 'sealed', candidateRoot: f.sourceRoot, expectedManifestSha256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal(checkMobileRuntimeCandidate(input).ok, true);
  assert.equal(checkMobileRuntimeCandidate({ ...input, expectedManifestSha256: 'f'.repeat(64) }).errors[0].code, 'candidate_manifest_changed');
  fs.appendFileSync(path.join(f.sourceRoot, 'public/favicon.svg'), 'changed');
  assert.equal(checkMobileRuntimeCandidate(input).ok, false);
});
