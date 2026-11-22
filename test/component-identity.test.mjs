import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AICC_COMPONENT_IDENTITIES,
  ComponentIdentityError,
  canonicalComponentId,
  componentDisplayName,
  resolveComponentIdentity,
  validateComponentIdentities
} from '../src/control-plane/component-identity.mjs';

test('canonical component identities are unique and upstream names stay provenance-only', () => {
  const ids = AICC_COMPONENT_IDENTITIES.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.some(id => /agentdock|nexusdock|cccc/i.test(id)), false);
  assert.equal(resolveComponentIdentity('agentdock'), null);
  assert.equal(resolveComponentIdentity('nexusdock'), null);
  assert.equal(resolveComponentIdentity('session-broker'), null);
});

test('legacy machine names resolve to durable AICC canonical names', () => {
  assert.equal(canonicalComponentId('remote-gateway'), 'aicc-relay');
  assert.equal(canonicalComponentId('device-agent'), 'aicc-endpoint');
  assert.equal(canonicalComponentId('workspace-mcp'), 'aicc-workspace');
  assert.equal(canonicalComponentId('WebGPT'), 'aicc-web-bridge');
  assert.equal(componentDisplayName('web-gpt'), 'AICC Web Bridge');
  assert.equal(canonicalComponentId('rdc'), 'rdc-recovery-path');
});

test('duplicate aliases fail closed instead of silently selecting a component', () => {
  assert.throws(() => validateComponentIdentities([
    { id: 'aicc-one', displayName: 'AICC One', aliases: ['shared'] },
    { id: 'aicc-two', displayName: 'AICC Two', aliases: ['shared'] }
  ]), error => error instanceof ComponentIdentityError && error.code === 'duplicate_component_alias');
});

test('upstream project names cannot become production canonical IDs', () => {
  assert.throws(() => validateComponentIdentities([
    { id: 'agentdock-runtime', displayName: 'Runtime', aliases: [] }
  ]), error => error instanceof ComponentIdentityError && error.code === 'upstream_name_in_canonical_id');
});

test('unknown names are not guessed', () => {
  assert.equal(resolveComponentIdentity('maybe-relay'), null);
  assert.throws(() => canonicalComponentId('maybe-relay'), error => error.code === 'unknown_component_identity');
});