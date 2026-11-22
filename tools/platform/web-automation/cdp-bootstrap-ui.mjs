export function installIdentityObserver() {
  if (location.origin !== 'https://chatgpt.com') return;
  const originalFetch = globalThis.fetch;
  const pending = new Set();
  const evidence = { me: null, accounts: [], active_account_id_sha256: null, observed: [], errors: [] };
  const hash = async value => typeof value === 'string' && value.length > 0
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('') : null;
  const observe = async (response, input, init) => {
    const url = new URL(response.url);
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (url.origin !== 'https://chatgpt.com' || method !== 'GET') return;
    const source = url.pathname === '/backend-api/me' ? 'me'
      : ['/backend-api/accounts/optimized/check', '/backend-api/accounts/check/v4-2023-04-27'].includes(url.pathname) ? 'accounts' : null;
    const selected = url.pathname.match(/^\/backend-api\/accounts\/([^/]+)\/(settings|remaining_balance)$/);
    if (selected && response.ok) evidence.active_account_id_sha256 = await hash(selected[1]);
    if (!source) return;
    if (evidence.observed.length < 32) evidence.observed.push({ source, status: response.status });
    if (!response.ok) return;
    const headers = new Headers(init?.headers ?? input?.headers);
    const headerAccount = headers.get('chatgpt-account-id');
    if (headerAccount) evidence.active_account_id_sha256 = await hash(headerAccount);
    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (declaredSize > 1048576) { evidence.errors.push('response_too_large'); return; }
    const reader = response.clone().body?.getReader();
    if (!reader) { evidence.errors.push('response_body_unavailable'); return; }
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1048576) {
          void reader.cancel().catch(() => {});
          evidence.errors.push('response_too_large');
          return;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== 'object') return;
    if (source === 'me') {
      const user = body.user ?? body;
      const userHash = await hash(user.id);
      const emailHash = await hash(typeof user.email === 'string' ? user.email.trim().toLowerCase() : null);
      if (userHash && emailHash) evidence.me = { user_id_sha256: userHash, email_sha256: emailHash,
        email_local_part_sha256: await hash(user.email.trim().toLowerCase().split('@')[0]) };
      else evidence.errors.push('me_identity_incomplete');
      return;
    }
    const entries = body.accounts;
    if (!entries || typeof entries !== 'object') { evidence.errors.push('accounts_shape_unknown'); return; }
    for (const [key, entry] of Object.entries(entries).slice(0, 32)) {
      const account = entry?.account ?? entry;
      if (!account || typeof account !== 'object') continue;
      const accountId = account.account_id ?? account.id ?? (/^[a-f0-9-]{36}$/i.test(key) ? key : null);
      const accountHash = await hash(accountId);
      if (!accountHash) continue;
      const type = account.structure ?? account.account_type ?? account.plan_type;
      const record = { account_id_sha256: accountHash, workspace_id_sha256: await hash(account.workspace_id),
        account_structure: ['workspace', 'personal'].includes(account.structure) ? account.structure : null,
        plan_type: ['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'education'].includes(account.plan_type) ? account.plan_type : null,
        account_type: ['personal', 'team', 'business', 'enterprise', 'education'].includes(type) ? type : null };
      const previous = evidence.accounts.findIndex(item => item.account_id_sha256 === accountHash);
      if (previous >= 0) evidence.accounts[previous] = record;
      else if (evidence.accounts.length < 32) evidence.accounts.push(record);
    }
  };
  globalThis.fetch = function (...args) {
    const request = Reflect.apply(originalFetch, this, args);
    let requestedUrl;
    try { requestedUrl = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0]?.url, location.origin); }
    catch { return request; }
    if (requestedUrl.origin !== 'https://chatgpt.com' ||
        !/^\/backend-api\/(me$|accounts\/)/.test(requestedUrl.pathname) || pending.size >= 32) return request;
    const reading = request.then(response => observe(response, args[0], args[1])).catch(() => evidence.errors.push('observation_failed'));
    pending.add(reading);
    reading.finally(() => pending.delete(reading));
    return request;
  };
  Object.defineProperty(globalThis, '__aiccIdentityBootstrapRead', { configurable: true, value: async () => {
    let timer;
    await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    const controls = [...document.querySelectorAll('button,a')];
    const visible = element => element.getClientRects().length > 0;
    const login = controls.some(element => visible(element) && /^(log in|login|sign in|로그인)$/i.test((element.textContent ?? '').trim()));
    const composer = [...document.querySelectorAll('#prompt-textarea,[data-testid="composer-text-input"],[contenteditable="true"]')].some(visible);
    const profile = controls.some(element => visible(element) && /profile|프로필/i.test(element.getAttribute('aria-label') ?? element.getAttribute('data-testid') ?? ''));
    const challenge = !!document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[src*="recaptcha"]');
    return { ...evidence, observed: evidence.observed.slice(0, 32), errors: [...new Set(evidence.errors)],
      ui: { login_visible: login, composer_visible: composer, profile_visible: profile, challenge_visible: challenge, ready: document.readyState === 'complete' } };
  } });
}

export const identityObserverScript = `(${installIdentityObserver.toString()})()`;
export const readUiIdentityExpression = '(async () => typeof globalThis.__aiccIdentityBootstrapRead === "function" ? await globalThis.__aiccIdentityBootstrapRead() : null)()';

export function classifyUiIdentity(evidence) {
  const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const ui = evidence?.ui;
  const observed = evidence?.observed;
  if (!ui || !Array.isArray(observed) || !Array.isArray(evidence.accounts)) throw new Error('invalid_ui_evidence');
  const authenticated = observed.some(item => item.source === 'me' && item.status === 200) &&
    isHash(evidence.me?.user_id_sha256) && isHash(evidence.me?.email_sha256);
  const accounts = evidence.accounts.filter(item => isHash(item.account_id_sha256)).map(item => ({
    account_id_sha256: item.account_id_sha256,
    workspace_id_sha256: isHash(item.workspace_id_sha256) ? item.workspace_id_sha256 : null,
    account_structure: ['workspace', 'personal'].includes(item.account_structure) ? item.account_structure : null,
    plan_type: ['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'education'].includes(item.plan_type) ? item.plan_type : null,
    account_type: ['personal', 'team', 'business', 'enterprise', 'education'].includes(item.account_type) ? item.account_type : null,
  }));
  const activeHash = isHash(evidence.active_account_id_sha256) ? evidence.active_account_id_sha256 : null;
  const active = accounts.find(item => item.account_id_sha256 === activeHash);
  const signedOut = !authenticated && ui.ready === true && ui.login_visible === true && ui.composer_visible === false && ui.challenge_visible === false;
  return { status: authenticated ? 'signed_in' : signedOut ? 'signed_out' : 'unknown', login_required: authenticated ? false : signedOut ? true : null,
    reason: authenticated ? 'observed_authenticated_me' : signedOut ? 'login_ui_without_composer' : 'ui_identity_unverified',
    user_id_sha256: authenticated ? evidence.me.user_id_sha256 : null,
    email_sha256: authenticated ? evidence.me.email_sha256 : null,
    email_local_part_sha256: authenticated && isHash(evidence.me.email_local_part_sha256) ? evidence.me.email_local_part_sha256 : null,
    account_id_sha256: authenticated && active ? activeHash : null,
    workspace_id_sha256: authenticated && active ? active.workspace_id_sha256 : null,
    account_type: authenticated && active ? active.account_type : null,
    account_structure: authenticated && active ? active.account_structure : null,
    plan_type: authenticated && active ? active.plan_type : null,
    account_memberships: authenticated ? accounts : [],
    read_evidence: observed.filter(item => ['me', 'accounts'].includes(item.source) && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599)
      .slice(0, 32).map(item => ({ source: item.source, status: item.status })),
    ui: { login_visible: ui.login_visible === true, composer_visible: ui.composer_visible === true, profile_visible: ui.profile_visible === true, challenge_visible: ui.challenge_visible === true },
  };
}
