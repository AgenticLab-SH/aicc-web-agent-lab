// Read-only source inspection. Never imports or evaluates candidate modules.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = code => { throw Object.assign(Error(code), { code }); };
const relativePath = value => typeof value === 'string' && value.length > 0 && !/[\\:#?\x00-\x1f]/.test(value) && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
function regular(file, max = 8 * 1024 * 1024) {
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) invalid('candidate_link_denied');
    if (current === path.dirname(current)) break;
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) invalid('candidate_file_invalid');
  return fs.readFileSync(file);
}
function json(file) { return JSON.parse(regular(file, 16 * 1024 * 1024).toString('utf8').replace(/^\uFEFF/, '')); }

export function checkMobileRuntimeCandidate(input) {
  const report = { schemaVersion: 1, ok: false, mode: input?.mode, modulesParsed: 0, filesRead: 0, localEdges: 0, computedImports: 0, errors: [], candidateCodeExecuted: false, servicesStarted: 0, externalRequests: 0 };
  try {
    const pins = new Map(), roots = new Set(), parsed = new Set(), checked = new Map(), pending = [];
    function add(root, rows, replace = false) {
      if (!path.isAbsolute(root ?? '') || !Array.isArray(rows)) invalid('candidate_input_invalid');
      const seen = new Set();
      for (const pin of rows) {
        if (!relativePath(pin?.path) || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '') || !Number.isSafeInteger(pin.size) || pin.size < 0 || seen.has(pin.path.toLowerCase())) invalid('candidate_pin_invalid');
        seen.add(pin.path.toLowerCase());
        if (!replace && pins.has(pin.path)) invalid('candidate_pin_duplicate');
        pins.set(pin.path, { ...pin, root });
      }
    }
    let overlays;
    if (input.mode === 'projection') {
      add(input.baseRoot, input.baselinePins);
      add(input.sourceRoot, input.overlays, true);
      overlays = input.overlays;
    } else if (input.mode === 'sealed') {
      if (!/^[a-f0-9]{64}$/.test(input.expectedManifestSha256 ?? '')) invalid('candidate_manifest_pin_required');
      const manifestBytes = regular(path.join(input.candidateRoot, '.aicc-release.json'), 16 * 1024 * 1024);
      if (sha(manifestBytes) !== input.expectedManifestSha256) invalid('candidate_manifest_changed');
      const manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (manifest.schemaVersion !== 1 || manifest.component !== 'mobile-public-control') invalid('candidate_manifest_invalid');
      add(input.candidateRoot, manifest.files);
      overlays = manifest.overlays;
    } else invalid('candidate_mode_invalid');
    if (!Array.isArray(overlays)) invalid('candidate_overlay_invalid');
    for (const pin of overlays) if (/\.(?:mjs|js|html|css|webmanifest)$/.test(pin.path)) roots.add(pin.path);
    for (const name of ['src/server.mjs', 'src/mobile-control.mjs', 'public/mobile.html', 'public/supervise.html']) roots.add(name);
    pending.push(...roots);
    function bytes(relative) {
      if (checked.has(relative)) return checked.get(relative);
      const pin = pins.get(relative);
      if (!pin) invalid('candidate_dependency_missing');
      const value = regular(path.join(pin.root, relative));
      if (value.length !== pin.size || sha(value) !== pin.sha256) invalid('candidate_dependency_pin_mismatch');
      checked.set(relative, value); report.filesRead++;
      return value;
    }
    function edge(from, specifier, kind = 'asset') {
      if (typeof specifier !== 'string' || !specifier || specifier.startsWith('#') || /^(?:https?:|data:|blob:|mailto:|tel:|node:)/i.test(specifier)) return;
      if (kind === 'module' && !/^(?:\.|\/)/.test(specifier)) return; // Existing npm package resolution is outside this local-file gate.
      const clean = specifier.split(/[?#]/)[0];
      if (!clean) return;
      const target = clean.startsWith('/') && from.startsWith('public/') ? 'public' + clean : path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
      report.localEdges++;
      if (!relativePath(target) || (from.startsWith('public/') && !target.startsWith('public/'))) { report.errors.push({ code: 'candidate_dependency_escape', from, target }); return; }
      if (!pins.has(target)) { report.errors.push({ code: 'candidate_dependency_missing', from, target }); return; }
      // Every referenced asset is pinned, even if its format is not parsed.
      try { bytes(target); } catch (error) { report.errors.push({ code: error.code ?? 'candidate_read_failed', from, target }); return; }
      if (/\.(?:mjs|js|html|css|webmanifest)$/.test(target)) pending.push(target);
    }
    function visit(node, from) {
      if (!node || typeof node !== 'object') return;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) edge(from, node.source.value, 'module');
      if (node.type === 'ImportExpression') {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') edge(from, node.source.value, 'module');
        else report.computedImports++;
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'URL' && node.arguments[0]?.type === 'Literal' && node.arguments[1]?.type === 'MemberExpression' && node.arguments[1].object?.type === 'MetaProperty' && node.arguments[1].property?.name === 'url') edge(from, node.arguments[0].value);
      for (const [key, child] of Object.entries(node)) if (key !== 'source' && child && typeof child === 'object') {
        if (Array.isArray(child)) for (const part of child) visit(part, from);
        else visit(child, from);
      }
    }
    while (pending.length) {
      const relative = pending.shift();
      if (parsed.has(relative)) continue;
      parsed.add(relative);
      try {
        const content = bytes(relative).toString('utf8').replace(/^\uFEFF/, '');
        if (/\.(?:mjs|js)$/.test(relative)) {
          visit(parse(content, { ecmaVersion: 'latest', sourceType: 'module' }), relative); report.modulesParsed++;
        } else if (relative.endsWith('.html')) {
          for (const match of content.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) edge(relative, match[1] ?? match[2] ?? match[3]);
        } else if (relative.endsWith('.css')) {
          for (const match of content.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)|@import\s+["']([^"']+)["']/gi)) edge(relative, match[1] ?? match[2] ?? match[3] ?? match[4]);
        } else if (relative.endsWith('.webmanifest')) {
          const value = JSON.parse(content);
          for (const icon of value.icons ?? []) edge(relative, icon.src);
          for (const shortcut of value.shortcuts ?? []) for (const icon of shortcut.icons ?? []) edge(relative, icon.src);
        }
      } catch (error) { report.errors.push({ code: error.code ?? (error instanceof SyntaxError ? 'candidate_syntax_invalid' : 'candidate_read_failed'), from: relative }); }
    }
    report.ok = report.errors.length === 0;
    report.limits = ['Computed runtime helper imports and npm package compatibility need separate acceptance.', 'No candidate modules were imported or evaluated.'];
  } catch (error) { report.errors.push({ code: error.code ?? 'candidate_input_invalid' }); }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report;
  try { report = checkMobileRuntimeCandidate(json(process.argv[2])); }
  catch { report = { ok: false, errors: [{ code: 'candidate_input_unreadable' }], candidateCodeExecuted: false }; }
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
