import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectLocalProjects, collectProjectCatalog, ProjectCatalogError } from '../src/projects/project-collector.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(root, 'test', 'fixtures', 'project-catalog');
const projectsRoot = path.join(fixtureRoot, 'projects');
const notionSnapshot = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'notion-snapshot.json'), 'utf8'));

function collectOptions() {
  return {
    projectsRoot,
    structureReadmePath: path.join(projectsRoot, 'README.md'),
    projectRoots: [
      path.join(projectsRoot, 'tools', 'local-only'),
      path.join(projectsRoot, 'web', 'apps', 'web-demo')
    ],
    websiteWorkspacePaths: [path.join(projectsRoot, 'web', 'website-workspace.json')],
    websiteProfilePaths: [path.join(projectsRoot, 'web', 'apps', 'web-demo', '.openai', 'website-profile.json')],
    notionSnapshot,
    now: () => Date.parse('2026-03-04T00:00:00Z')
  };
}

test('collector merges actual top-level website services with exact local and Notion source ownership', () => {
  const catalog = collectProjectCatalog(collectOptions());
  assert.deepEqual(catalog.sourcePolicy, {
    notionAuthoritative: ['lifecycle', 'priority', 'nextAction'],
    localAuthoritative: ['canonicalRoot', 'source', 'runtime', 'release'],
    silentOverwrite: false
  });
  assert.deepEqual(catalog.summary, { total: 3, inSync: 0, localOnly: 1, notionOnly: 1, drift: 1 });
  assert.deepEqual(catalog.sourceSnapshots.notion, {
    version: 'fixture-notion-v3',
    capturedAt: '2026-03-03T00:00:00Z',
    projects: 1,
    projectsActive: 1,
    projectsArchived: 0,
    ideas: 1,
    ideasActive: 1,
    ideasArchived: 0
  });

  const web = catalog.projects.find(project => project.id === 'web-demo');
  assert.equal(web.sourceState, 'DRIFT');
  assert.equal(web.lifecycle, 'building');
  assert.equal(web.priority.rank, 2);
  assert.equal(web.nextAction, 'Verify the current build');
  assert.equal(web.canonicalRoot, fs.realpathSync(path.join(projectsRoot, 'web', 'apps', 'web-demo')));
  assert.equal(web.runtime.hostingProvider, 'fixture-pages');
  assert.equal(web.release.lastVerificationStatus, 'active');
  assert.deepEqual(new Set(web.origins.local.sourceRefs.map(ref => ref.type)), new Set(['project-manifest', 'website-workspace', 'website-profile']));
  assert.ok(web.drift.some(item => item.field === 'lifecycle' && item.authoritativeSource === 'notion'));
  assert.ok(web.drift.some(item => item.field === 'priority' && item.authoritativeSource === 'notion'));
  assert.ok(web.drift.some(item => item.field === 'nextAction' && item.authoritativeSource === 'notion'));

  const localOnly = catalog.projects.find(project => project.id === 'local-only');
  assert.equal(localOnly.sourceState, 'LOCAL_ONLY');
  assert.equal(localOnly.lifecycle, null);
  assert.equal(localOnly.priority, null);
  assert.equal(localOnly.nextAction, null);
  assert.equal(localOnly.canonicalRoot, fs.realpathSync(path.join(projectsRoot, 'tools', 'local-only')));

  const notionOnly = catalog.projects.find(project => project.title === 'Unmapped Notion Idea');
  assert.equal(notionOnly.id, 'notion-22222222222222222222222222222222');
  assert.equal(notionOnly.origins.notion.identitySource, 'notion-page-id');
  assert.equal(notionOnly.sourceState, 'NOTION_ONLY');
  assert.equal(notionOnly.canonicalRoot, null);
  assert.equal(notionOnly.lifecycle, 'idea');
});

test('collector records the canonical structure README and never derives identity from a Notion title', () => {
  const local = collectLocalProjects(collectOptions());
  assert.equal(local.structureReadme.path, fs.realpathSync(path.join(projectsRoot, 'README.md')));
  assert.match(local.structureReadme.sha256, /^[a-f0-9]{64}$/);
  const catalog = collectProjectCatalog({
    ...collectOptions(),
    notionSnapshot: {
      version: 'title-not-identity',
      capturedAt: '2026-01-01T00:00:00Z',
      projects: [{ pageId: '33333333-3333-3333-3333-333333333333', title: 'Local Only Tool', lifecycle: 'design', priority: { rank: 1, updatedAt: '2026-01-01T00:00:00Z' }, nextAction: 'Review mapping' }],
      ideas: []
    }
  });
  assert.ok(catalog.projects.some(project => project.id === 'local-only' && project.sourceState === 'LOCAL_ONLY'));
  assert.ok(catalog.projects.some(project => project.id === 'notion-33333333333333333333333333333333' && project.sourceState === 'NOTION_ONLY'));
});

test('collector rejects parent traversal, outside roots, symlink escapes, and native sensitive paths', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-project-catalog-security-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const approved = path.join(temporary, 'projects');
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(path.join(approved, 'safe'), { recursive: true });
  fs.mkdirSync(path.join(approved, '.ssh', 'secret-project'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(approved, 'README.md'), '# Synthetic\n');
  fs.symlinkSync(outside, path.join(approved, 'escape'));
  const base = { projectsRoot: approved, structureReadmePath: path.join(approved, 'README.md') };
  assert.throws(
    () => collectLocalProjects({ ...base, projectRoots: ['../outside'] }),
    error => error instanceof ProjectCatalogError && error.code === 'path_traversal_rejected'
  );
  assert.throws(
    () => collectLocalProjects({ ...base, projectRoots: [outside] }),
    error => error instanceof ProjectCatalogError && error.code === 'path_outside_projects_root'
  );
  assert.throws(
    () => collectLocalProjects({ ...base, projectRoots: [path.join(approved, 'escape')] }),
    error => error instanceof ProjectCatalogError && error.code === 'symlink_escape_rejected'
  );
  assert.throws(
    () => collectLocalProjects({ ...base, projectRoots: [path.join(approved, '.ssh', 'secret-project')] }),
    error => error instanceof ProjectCatalogError && error.code === 'sensitive_path_rejected'
  );
});

test('collector rejects command-bearing manifests and unbound injected website profiles', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-project-catalog-manifest-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, 'projects', 'tools', 'unsafe');
  const profile = path.join(temporary, 'projects', 'web', 'profile.json');
  fs.mkdirSync(path.join(project, '.aicc'), { recursive: true });
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(path.join(temporary, 'projects', 'README.md'), '# Synthetic\n');
  fs.writeFileSync(path.join(project, '.aicc', 'project.json'), JSON.stringify({ schemaVersion: 1, id: 'unsafe', command: 'echo prohibited' }));
  fs.writeFileSync(profile, JSON.stringify({ schema_version: 1 }));
  const base = { projectsRoot: path.join(temporary, 'projects'), structureReadmePath: path.join(temporary, 'projects', 'README.md') };
  assert.throws(
    () => collectLocalProjects({ ...base, projectRoots: [project] }),
    error => error instanceof ProjectCatalogError && error.code === 'project_command_forbidden'
  );
  assert.throws(
    () => collectLocalProjects({ ...base, websiteProfilePaths: [profile] }),
    error => error instanceof ProjectCatalogError && error.code === 'unbound_website_profile'
  );
});

test('collector accepts a sibling website repository while keeping the configured projects boundary', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-project-catalog-sibling-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const projects = path.join(temporary, 'projects');
  const web = path.join(projects, 'web');
  const sibling = path.join(projects, 'apps', 'sibling-site');
  fs.mkdirSync(path.join(web, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(sibling, '.openai'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'README.md'), '# Synthetic\n');
  fs.writeFileSync(path.join(sibling, '.openai', 'website-profile.json'), JSON.stringify({ schema_version: 1, source_visibility: 'private' }));
  fs.writeFileSync(path.join(web, 'website-workspace.json'), JSON.stringify({
    schema_version: 2,
    services: [{ key: 'sibling-site', title: 'Sibling site', canonical_path: '../apps/sibling-site', profile_path: '../apps/sibling-site/.openai/website-profile.json' }]
  }));
  const local = collectLocalProjects({
    projectsRoot: projects,
    structureReadmePath: path.join(projects, 'README.md'),
    websiteWorkspacePaths: [path.join(web, 'website-workspace.json')],
    websiteProfilePaths: [path.join(sibling, '.openai', 'website-profile.json')]
  });
  assert.equal(local.projects.length, 1);
  assert.equal(local.projects[0].id, 'sibling-site');
  assert.equal(local.projects[0].canonicalRoot, fs.realpathSync(sibling));
});

test('project catalog schemas are portable draft 2020-12 contracts with explicit no-overwrite policy', () => {
  for (const name of ['project', 'catalog', 'priority-outbox']) {
    const file = path.join(root, 'contracts', 'projects', `${name}.schema.json`);
    const text = fs.readFileSync(file, 'utf8');
    const schema = JSON.parse(text);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, true);
    assert.doesNotMatch(text, /\/(?:Users|home)\/[A-Za-z0-9._-]+/);
  }
  const catalogSchema = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'projects', 'catalog.schema.json'), 'utf8'));
  assert.equal(catalogSchema.properties.sourcePolicy.properties.silentOverwrite.const, false);
});
