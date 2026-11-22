import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjectServiceAllowlist, ProjectServiceLinkError, resolveProjectServiceLink } from '../src/projects/project-service-link.mjs';

const manifest = {
  schemaVersion: 1,
  policy: {
    requiredCoreLabels: ['com.example.aicc-dashboard', 'com.example.workspace-tunnel']
  },
  projects: [
    { id: 'demo-service', label: 'Demo Service', healthUrl: 'http://127.0.0.1:43123/healthz', listenPort: 43123 },
    { id: 'second-service', label: 'Second Service', healthUrl: null, listenPort: null }
  ]
};

test('service link exposes only an exact explicitly allowlisted profile and no command surface', () => {
  const link = resolveProjectServiceLink({ id: 'demo', serviceProfileId: 'demo-service' }, { manifest });
  assert.equal(link.linked, true);
  assert.equal(link.serviceProfileId, 'demo-service');
  assert.equal(link.actionContract.exactProfileMatch, true);
  assert.equal(link.actionContract.previewRequired, true);
  assert.equal(link.actionContract.confirmationRequired, true);
  assert.equal(link.actionContract.arbitraryCommandAllowed, false);
  assert.equal(Object.hasOwn(link, 'command'), false);
});

test('service link rejects unknown, fuzzy, and core route matches', () => {
  assert.throws(
    () => resolveProjectServiceLink({ serviceProfileId: 'demo' }, { manifest }),
    error => error instanceof ProjectServiceLinkError && error.code === 'unknown_service_profile'
  );
  assert.throws(
    () => resolveProjectServiceLink({ serviceProfileId: 'demo-service-extra' }, { manifest }),
    error => error instanceof ProjectServiceLinkError && error.code === 'unknown_service_profile'
  );
  assert.throws(
    () => resolveProjectServiceLink({ serviceProfileId: 'workspace-tunnel' }, { manifest }),
    error => error instanceof ProjectServiceLinkError && error.code === 'core_service_forbidden'
  );
});

test('missing serviceProfileId is a non-linked project and core profiles cannot enter the allowlist', () => {
  assert.deepEqual(resolveProjectServiceLink({ serviceProfileId: null }, { manifest }), {
    linked: false,
    serviceProfileId: null,
    reason: 'not-configured'
  });
  assert.throws(
    () => buildProjectServiceAllowlist({ ...manifest, projects: [{ id: 'ocx', label: 'Not a project' }] }),
    error => error instanceof ProjectServiceLinkError && error.code === 'core_service_in_allowlist'
  );
});
