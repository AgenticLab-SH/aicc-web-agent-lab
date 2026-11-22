import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function read(file) {
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) throw Error('linked_app_registry');
    if (path.dirname(p) === p) break;
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error('invalid_app_registry');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) : '';
// Links are owner-registered destinations, never fetched by this server.
function webUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /^(localhost|127\.|\[::1\])/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

// Resolve aliases only through the existing source-ID inventory and exact root.
// Shared parent projects and titles are not evidence that two apps are identical.
function rootKey(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(base, value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}
function registeredAliases(services, products, inventory, webRoot) {
  const rootsById = new Map();
  for (const entry of Array.isArray(inventory?.local) ? inventory.local : []) {
    if (!entry?.id || !entry.path || !path.isAbsolute(entry.path)) continue;
    const roots = rootsById.get(entry.id) ?? new Set();
    roots.add(rootKey(entry.path, webRoot)); rootsById.set(entry.id, roots);
  }
  const candidates = new Map();
  const serviceKeys = new Set(services.map(service => service.key));
  for (const service of services) {
    if (service.merged_into || !service.canonical_path) continue;
    const root = rootKey(service.canonical_path, webRoot);
    const matches = products.filter(product => Array.isArray(product.sourceIds) && product.sourceIds.some(id => rootsById.get(id)?.size === 1 && rootsById.get(id).has(root)));
    if (matches.length === 1 && (matches[0].key === service.key || !serviceKeys.has(matches[0].key))) candidates.set(service.key, matches[0].key);
  }
  const counts = new Map();
  for (const key of candidates.values()) counts.set(key, (counts.get(key) ?? 0) + 1);
  return new Map([...candidates].filter(([, key]) => counts.get(key) === 1));
}

export function readMobileAppCatalog(options = {}) {
  const owner = options.ownerRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center');
  const codex = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const issues = [];
  const source = (file, kind) => { try { return read(file); } catch { issues.push(kind); return null; } };
  let projectsRoot = options.projectsRoot ?? process.env.AICC_PROJECTS_ROOT ?? process.env.AICC_WORKSPACE_PROJECTS_ROOT;
  if (!projectsRoot) projectsRoot = source(path.join(owner, 'workspace-mcp', 'config.json'), 'projects-root')?.projectsRoot;
  const registry = projectsRoot && path.isAbsolute(projectsRoot) ? source(path.join(projectsRoot, 'web', 'website-workspace.json'), 'web-apps') : null;
  const portfolio = source(options.portfolioFile ?? path.join(codex, 'specs', 'ai-work-system-upgrade', 'portfolio', 'execution.json'), 'portfolio');
  if (!Array.isArray(registry?.services)) issues.push('web-apps-unavailable');
  if (!Array.isArray(portfolio?.userApprovedClassification?.products)) issues.push('portfolio-unavailable');
  const services = (Array.isArray(registry?.services) ? registry.services : []).slice(0, 250).filter(item => /^[a-z0-9][a-z0-9-]{0,99}$/.test(item?.key ?? ''));
  const products = (Array.isArray(portfolio?.userApprovedClassification?.products) ? portfolio.userApprovedClassification.products : []).slice(0, 250).filter(item => /^[a-z0-9][a-z0-9-]{0,99}$/.test(item?.key ?? ''));
  const inventory = source(options.inventoryFile ?? path.join(codex, 'specs', 'ai-work-system-upgrade', 'portfolio', 'index.json'), 'app-identity');
  const aliases = registeredAliases(services, products, inventory, path.join(projectsRoot ?? owner, 'web'));
  const rows = new Map();
  rows.set('aicc', { id: 'aicc', title: 'AICC', description: '내 앱과 AI 작업을 한곳에서 관리합니다.', url: '/mobile.html#ai-reports', state: 'WEB', update: 'AICC_WEB', registered: true });
  for (const item of services) {
    const retired = !!item.merged_into || /deprecated|retired/.test(item.kind ?? '') || /deprecated|retired/.test(item.repository_status ?? '');
    const url = retired ? null : webUrl(item.production_url);
    rows.set(item.key, { id: item.key, title: text(item.title) || item.key, description: retired ? '통합되거나 사용이 종료된 앱입니다.' : url ? '등록된 웹 앱을 엽니다. 앱에서 사용하는 로그인은 그대로 유지됩니다.' : '휴대폰에서 열 수 있는 주소가 아직 등록되지 않았습니다.', url, state: retired ? 'RETIRED' : url ? 'WEB' : item.local_url ? 'PC_ONLY' : 'UNAVAILABLE', update: url ? 'WEB' : 'UNAVAILABLE', registered: true });
  }
  for (const item of products) {
    const alias = [...aliases].find(([, key]) => key === item.key)?.[0];
    const previous = rows.get(item.key) ?? (alias ? rows.get(alias) : null);
    if (previous) { previous.description = text(item.functions) || previous.description; previous.title = text(item.name) || previous.title; continue; }
    rows.set(item.key, { id: item.key, title: text(item.name) || item.key, description: text(item.functions), url: null, state: 'UNAVAILABLE', update: 'UNAVAILABLE', registered: true });
  }
  return { ok: true, readOnly: true, observedAt: new Date().toISOString(), status: issues.length ? 'PARTIAL' : 'AVAILABLE', issues: [...new Set(issues)], apps: [...rows.values()], aliasCount: [...aliases].filter(([service, product]) => service !== product).length, availabilityVerified: false };
}
