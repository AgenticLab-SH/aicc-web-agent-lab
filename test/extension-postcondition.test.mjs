import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateExtensionPostcondition } from '../tools/platform/web-automation/extension-postcondition.mjs';

const entry = {
  allowed_host_permissions: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  pin_to_toolbar: true,
  options: {
    enabled: true,
    incognito_access: false,
    file_access: false,
    error_collection: false,
    host_access: 'ON_SPECIFIC_SITES',
    show_access_requests_in_toolbar: false
  },
  verify: {}
};

test('postcondition reports the exact safe option mismatch', () => {
  const result = evaluateExtensionPostcondition({
    entry,
    action: 'status',
    match: {
      state: 'ENABLED', pinned: true, incognito_access: false, file_access: false,
      error_collection: false, host_access: 'ON_ALL_SITES', runtime_hosts: [], show_access_requests_in_toolbar: false
    }
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map(item => item.field), ['options.host_access', 'runtime_hosts']);
  assert.equal(result.checks.find(check => check.field === 'storage').checked, false);
});

test('postcondition passes exact options, pin, and mutation checks', () => {
  const result = evaluateExtensionPostcondition({
    entry,
    action: 'ensure',
    storedMatches: true,
    badgeMatches: true,
    titleMatches: true,
    match: {
      state: 'ENABLED', pinned: true, incognito_access: false, file_access: false,
      error_collection: false, host_access: 'ON_SPECIFIC_SITES',
      runtime_hosts: ['https://chat.openai.com/*', 'https://chatgpt.com/*'], show_access_requests_in_toolbar: false
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test('postcondition reports a missing specific-site grant without page data', () => {
  const result = evaluateExtensionPostcondition({
    entry,
    action: 'status',
    match: {
      state: 'ENABLED', pinned: true, incognito_access: false, file_access: false,
      error_collection: false, host_access: 'ON_SPECIFIC_SITES',
      runtime_hosts: ['https://chatgpt.com/*'], show_access_requests_in_toolbar: false
    }
  });
  assert.deepEqual(result.mismatches.map(item => item.field), ['runtime_hosts']);
});
