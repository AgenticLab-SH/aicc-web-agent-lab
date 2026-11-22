export function evaluateExtensionPostcondition({ match, entry, action, storedMatches, badgeMatches, titleMatches }) {
  const checks = [];
  const add = (field, expected, actual, checked = true) => {
    checks.push({ field, checked, expected: checked ? expected : null, actual: checked ? actual : null, matches: checked ? actual === expected : null });
  };
  add('enabled', entry.options?.enabled ?? true, match?.state === 'ENABLED');
  add('pinned', entry.pin_to_toolbar, match?.pinned, typeof entry.pin_to_toolbar === 'boolean');
  const optionFields = ['incognito_access', 'file_access', 'error_collection', 'host_access', 'show_access_requests_in_toolbar'];
  for (const field of optionFields) {
    add(`options.${field}`, entry.options?.[field], match?.[field], entry.options?.[field] !== undefined);
  }
  const normalizeHosts = values => [...(values ?? [])]
    .map(value => String(value).trim().toLowerCase().replace(/\/\*$/, '').replace(/\/$/, ''))
    .sort();
  if (entry.options?.host_access === 'ON_SPECIFIC_SITES') {
    const expected = normalizeHosts(entry.allowed_host_permissions);
    const actual = normalizeHosts(match?.runtime_hosts);
    checks.push({ field: 'runtime_hosts', checked: true, expected, actual, matches: JSON.stringify(actual) === JSON.stringify(expected) });
  }
  add('storage', true, storedMatches, action !== 'status');
  add('badge', true, badgeMatches, action !== 'status' && entry.verify?.badge_from_slot_suffix === true);
  add('title', true, titleMatches, action !== 'status' && entry.verify?.title_contains_slot === true);
  const mismatches = checks.filter(check => check.checked && check.matches === false);
  return { ok: mismatches.length === 0, checks, mismatches };
}
