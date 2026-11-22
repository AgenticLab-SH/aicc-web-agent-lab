#!/usr/bin/env python3
"""Bounded A1 account management; output never contains credentials or emails."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import socket
import fcntl
import uuid
import urllib.request

CONFIG = Path('/demo/owner/.opencodex-hub/config.json')
CLI = '/demo/owner/.local/bin/ocx-hub'
PACKAGE = Path.home() / '.bun/install/global/node_modules/@bitkyc08/opencodex'
BUN = '/demo/owner/.local/opt/bun-1.4.0/bun-linux-aarch64/bun'
WATCHER = '/demo/owner/.local/share/aicc-ocx-cycle-watch/hub_cycle_watch.py'
STATE = '/demo/owner/.local/state/aicc-ocx-cycle-watch'
POLICY_REGISTRY = Path.home() / '.local/share/ocx-window-policy/active.json'
ADMISSION_HASHES={
 'src/codex/routing/selection.ts':'f1418ce93256e1773195af3dd119934922e75637c63f6172f32c7c2e6e0a104d',
 'src/codex/auth-context.ts':'012a80c3eba6147b8883d797950e75392d41565fe0c63cdf3d000c7d0395f00a',
 'src/codex/routing/aicc-window-admission.ts':'6aa03fbb546eb1e37d1efa78ce8564eb4b28dbb7de4841f41b8d0ec3f7271c6c'}
NEW_ADMISSION_HASHES={
 'src/codex/routing/selection.ts':'c3f2f5e29864aa667b4d5cb4d9eef0ad33df8dde63606914e6577e91e9fd8da5',
 'src/codex/auth-context.ts':'aeb0659c9297491b94686e2073928ab370563bfd1e49d82f88096db35d48304b',
 'src/codex/routing/aicc-window-admission.ts':ADMISSION_HASHES['src/codex/routing/aicc-window-admission.ts']}
DYNAMIC_VERSIONS=('2.77.0-aicc.windows.2','2.77.0-aicc.windows.3')
STRICT_VERSIONS=('2.76.0-aicc.windows.3','2.77.0-aicc.windows.1',*DYNAMIC_VERSIONS)
INFLIGHT_FILES={
 'src/codex/routing/selection.ts','src/codex/auth-context.ts',
 'src/codex/routing/aicc-window-admission.ts','src/codex/routing/aicc-window-settings.ts',
 'src/codex/routing/aicc-inflight-monitor.ts','src/codex/routing/aicc-inflight-runtime.ts',
 'src/server/responses/core.ts','src/server/responses/core-codex-account.ts',
 'src/server/responses/aicc-inflight-response.ts','src/lib/upstream-retry.ts',
}


def registered_package():
    """Only an attested source-owned fork may override the original software path."""
    if not POLICY_REGISTRY.exists():
        return PACKAGE
    data = json.loads(POLICY_REGISTRY.read_text())
    root = Path(data['root'])
    allowed = Path.home() / '.local/share/ocx-window-policy/versions'
    if not root.is_relative_to(allowed) or root.is_symlink():
        raise RuntimeError('registered_policy_root_required')
    package = root / 'node_modules/@bitkyc08/opencodex'
    source = package / 'src/codex/routing/cooldown-math.ts'
    drop = Path.home() / '.config/systemd/user/opencodex-proxy.service.d/60-aicc-windows.conf'
    if data.get('version') in DYNAMIC_VERSIONS:
        manifest_path=package/'aicc-policy-manifest.json'
        if manifest_path.is_symlink() or hashlib.sha256(manifest_path.read_bytes()).hexdigest()!=data.get('policyManifestSha256'):raise RuntimeError('dynamic_policy_manifest_changed')
        manifest=json.loads(manifest_path.read_text())
        if manifest.get('dynamicSettings') is not True or data.get('dynamicSettings') is not True or manifest.get('version')!=data['version']:raise RuntimeError('dynamic_policy_registration_invalid')
        if data['version']=='2.77.0-aicc.windows.3':
            if manifest.get('inflightProtection') is not True or data.get('inflightProtection') is not True or set(manifest['admissionSourceSha256'])!=INFLIGHT_FILES:raise RuntimeError('inflight_policy_registration_invalid')
            if manifest.get('updateSourceSha256')!=data.get('updateSourceSha256'):raise RuntimeError('inflight_policy_update_registry_changed')
        if hashlib.sha256(source.read_bytes()).hexdigest()!=manifest['policySourceSha256'] or manifest['policySourceSha256']!=data.get('policySourceSha256'):raise RuntimeError('dynamic_policy_source_changed')
        if manifest['admissionSourceSha256']!=data.get('admissionSourceSha256'):raise RuntimeError('dynamic_admission_registry_changed')
        for relative,expected in manifest['admissionSourceSha256'].items():
            permitted=relative in INFLIGHT_FILES if data['version']=='2.77.0-aicc.windows.3' else relative.startswith('src/codex/')
            if not permitted or '..' in Path(relative).parts or hashlib.sha256((package/relative).read_bytes()).hexdigest()!=expected:raise RuntimeError('dynamic_admission_changed')
        if hashlib.sha256((package/'src/server/management/config-routes.ts').read_bytes()).hexdigest()!=data.get('updateSourceSha256'):raise RuntimeError('dynamic_policy_update_guard_changed')
        if hashlib.sha256(drop.read_bytes()).hexdigest()!=data.get('dropSha256'):raise RuntimeError('dynamic_policy_drop_changed')
        return package
    expected_hash='48d463044f25837b2eba65a785ea60e3c534619bf67c1b460c19ff3ac2f02b9c' if data.get('version')=='2.77.0-aicc.windows.1' else '6d3bd9ade530a4f66f1cf20ff543d4c407d99b5ef34b3f39241c17c842a772f6'
    if (hashlib.sha256(source.read_bytes()).hexdigest() != data.get('policySourceSha256')
            or data.get('policySourceSha256') != expected_hash
            or hashlib.sha256(drop.read_bytes()).hexdigest() != data.get('dropSha256')):
        raise RuntimeError('registered_policy_changed')
    if data.get('version') in STRICT_VERSIONS:
        expected_admission=NEW_ADMISSION_HASHES if data['version']=='2.77.0-aicc.windows.1' else ADMISSION_HASHES
        if data.get('admissionSourceSha256')!=expected_admission:raise RuntimeError('registered_admission_changed')
        for relative,expected in expected_admission.items():
            if hashlib.sha256((package/relative).read_bytes()).hexdigest()!=expected:raise RuntimeError('registered_admission_changed')
    return package

def effective_policy():
    package=registered_package()
    version=json.loads((package/'package.json').read_text())['version']
    settings=read_window_settings()
    return {'version':version,'fiveHourUsedThreshold':settings['fiveHour']['usedThreshold'],'longWindowUsedThreshold':settings['longWindow']['usedThreshold'],
      'fiveHourAction':settings['fiveHour']['action'],'longWindowAction':settings['longWindow']['action'],
      'settingsSupported':dynamic_policy_supported(),
      'strictAdmission':version in STRICT_VERSIONS,'freshQuotaRequired':version in STRICT_VERSIONS,
      'freshnessMs':60000 if version in STRICT_VERSIONS else None,'scope':'A1 pool requests only',
      'alreadyDispatchedResponseInterrupted':version=='2.77.0-aicc.windows.3',
      'inflightProtection':version=='2.77.0-aicc.windows.3',
      'inflightPollMs':5000 if version=='2.77.0-aicc.windows.3' else None,
      'inflightFreshnessMs':15000 if version=='2.77.0-aicc.windows.3' else None,
      'providerCancellationAcknowledged':False,'inflightReplay':'never','directRequestsProtected':False}

def project_admission(row,policy):
    quota=row.get('quota') or {}
    valid=lambda value:isinstance(value,(int,float)) and not isinstance(value,bool) and 0<=value<=100
    long=[quota[key] for key in ('weeklyPercent','monthlyPercent') if valid(quota.get(key))]
    if row.get('paused'):reason='paused'
    elif row.get('needsReauth'):reason='needs_reauth'
    elif valid(quota.get('shortPercent')) and quota['shortPercent']>=policy['fiveHourUsedThreshold']:reason='five_hour_threshold'
    elif any(value>=policy['longWindowUsedThreshold'] for value in long):reason='long_window_threshold'
    elif (not valid(quota.get('shortPercent')) and not (quota.get('shortWindowApplicable') is False and quota.get('shortPercent') is None)) or not long:reason='quota_incomplete'
    else:reason='fresh_request_quota_required'
    # Cheap/list projections omit timestamps. Never represent them as the current
    # process's request-owned positive admission proof, even after explicit refresh.
    return {'eligible':False if reason!='fresh_request_quota_required' else None,
      'state':'blocked' if reason in ('paused','needs_reauth','five_hour_threshold','long_window_threshold') else 'unverified' if reason=='quota_incomplete' else 'conditional',
      'reason':reason,'strictEnforcementActive':policy['strictAdmission']}


def run_json(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=55, **kwargs)
    if result.returncode or len(result.stdout) > 1024 * 1024:
        raise RuntimeError('hub_command_failed')
    return json.loads(result.stdout)


def native_cli(*args):
    env = dict(os.environ, OPENCODEX_HOME=str(CONFIG.parent),
               CODEX_HOME=str(CONFIG.parent / 'codex-runtime'))
    package = registered_package()
    if package != PACKAGE:
        env['AICC_OCX_WINDOW_THRESHOLDS'] = '95,98'
    return run_json([BUN, str(package / 'src/cli/index.ts'), *args], env=env)


def owns_runtime_pid(pid, main_pid):
    """Stock Node launcher may hand off to Bun; both must belong to this unit."""
    if not isinstance(pid, int) or pid <= 0 or main_pid <= 0:
        return False
    try:
        group = (Path('/proc') / str(main_pid) / 'cgroup').read_text()
        runtime = Path('/proc') / str(pid)
        args = (runtime / 'cmdline').read_bytes().split(b'\0')
        return (group.endswith('/opencodex-proxy.service\n')
                and (runtime / 'cgroup').read_text() == group
                and str(registered_package() / 'src/cli/index.ts').encode() in args
                and b'start' in args and b'10100' in args)
    except OSError:
        return False


def recover_hub(commit=False):
    """Start only an absent, attested existing owner; never restart a live hub."""
    unit = Path.home() / '.config/systemd/user/opencodex-proxy.service'
    if unit.is_symlink() or not unit.is_file():
        raise RuntimeError('registered_hub_unit_required')
    before = unit.read_bytes()
    text = before.decode('utf-8')
    if str(Path.home() / '.bun/bin/ocx') not in text or str(CONFIG.parent) not in text:
        raise RuntimeError('hub_unit_owner_mismatch')
    def service_pid():
        r = subprocess.run(['systemctl', '--user', 'show', 'opencodex-proxy.service', '--property=MainPID', '--value'], capture_output=True, text=True, timeout=10)
        if r.returncode or not r.stdout.strip().isdigit():
            raise RuntimeError('hub_owner_unknown')
        return int(r.stdout.strip())
    def ready():
        try:
            with urllib.request.urlopen('http://localhost:10100/readyz', timeout=3) as response:
                return json.load(response)
        except Exception:
            return None
    pid = service_pid()
    health = ready()
    if health:
        if health.get('service') != 'opencodex' or health.get('status') != 'ready' or health.get('port') != 10100 or not owns_runtime_pid(health.get('pid'), pid):
            raise RuntimeError('hub_live_owner_unknown')
        return {'terminal': 'PASS', 'changed': False, 'version': health.get('version')}
    if pid != 0:
        raise RuntimeError('hub_live_or_starting_do_not_restart')
    for _ in range(5):
        with socket.socket() as connection:
            connection.settimeout(2)
            if connection.connect_ex(('127.0.0.1', 10100)) != 111:
                raise RuntimeError('hub_listener_unknown')
        time.sleep(.2)
    if not commit:
        return {'terminal': 'DRY_RUN', 'changed': False, 'action': 'start-existing-hub'}
    if service_pid() != 0 or unit.read_bytes() != before:
        raise RuntimeError('hub_preimage_changed')
    with socket.socket() as connection:
        connection.settimeout(2)
        if connection.connect_ex(('127.0.0.1', 10100)) != 111:
            raise RuntimeError('hub_listener_changed_before_start')
    subprocess.run(['systemctl', '--user', 'start', 'opencodex-proxy.service'], check=True, capture_output=True, timeout=15)
    for _ in range(20):
        health = ready()
        pid = service_pid()
        if health and health.get('service') == 'opencodex' and health.get('status') == 'ready' and health.get('port') == 10100 and owns_runtime_pid(health.get('pid'), pid):
            return {'terminal': 'PASS', 'changed': True, 'version': health.get('version')}
        time.sleep(1)
    raise RuntimeError('hub_start_unconfirmed_do_not_retry')


def project_accounts(payload, config):
    selectors = {v: k for k, v in config['codexAccountNamespaces'].items() if k != 'main'}
    allowed_quota = ('weeklyPercent', 'weeklyResetAt', 'shortPercent', 'shortResetAt',
                     'shortWindowSeconds', 'shortWindowApplicable', 'monthlyPercent', 'monthlyResetAt', 'resetCredits')
    rows = []
    for row in payload['accounts']:
        selector = selectors.get(row.get('id'))
        if selector is None:
            continue
        quota = row.get('quota') or {}
        rows.append({
            'selector': selector,
            'identityHash': hashlib.sha256(row['id'].encode()).hexdigest(),
            'plan': row.get('plan'),
            **{k: row.get(k) for k in ('active', 'paused', 'needsReauth', 'priority')},
            'quota': {k: quota[k] for k in allowed_quota if k in quota},
            'quotaKnown': any(isinstance(quota.get(k), (int, float))
                              and not isinstance(quota.get(k), bool)
                              and 0 <= quota[k] <= 100
                              for k in ('weeklyPercent', 'monthlyPercent')),
            'quotaFreshness': 'unreported',  # Stock CLI omits observation timestamps.
            'thresholdOverride': row.get('autoSwitchThresholdOverride'),
        })
    return rows


def read_account_inventory(action):
    if action == 'refresh':
        return native_cli('account', 'refresh', 'openai', '--json')
    # 2.76's cheap list deliberately omits quota, even when the hub knows it.
    # Opt in to the official projection; never invent 0% for an absent window.
    return native_cli('account', 'list', 'openai', '--quota', '--json')


def project_identities(payload, config):
    """Join by credential identity, never by account-list position."""
    rows = project_accounts(payload, config)
    by_hash = {hashlib.sha256(row['id'].encode()).hexdigest(): row
               for row in payload['accounts'] if isinstance(row.get('id'), str)}
    registered = {row['id']: row for row in config.get('codexAccounts', [])
                  if isinstance(row, dict) and isinstance(row.get('id'), str)}
    for row in rows:
        source = by_hash[row['identityHash']]
        # Public CLI masks emails; read only the matching owner-local metadata.
        email = registered.get(source['id'], {}).get('email', source.get('email'))
        email = email.strip().lower() if isinstance(email, str) else ''
        if '*' in email or 'redact' in email or '@' not in email:
            email = ''
        name = email.split('@')[0] if '@' in email else ''
        row['emailHash'] = hashlib.sha256(email.encode()).hexdigest() if email else None
        row['accountName'] = name if re.fullmatch(r'[A-Za-z0-9._+-]{1,80}', name) else None
        # A selector is a stable OCX target; its list index is not a user account number.
        row['accountNumber'] = None
    return rows


def change_pause(config, selector, expected_identity, paused, commit):
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', selector or '') or selector == 'main':
        raise RuntimeError('exact_pool_selector_required')
    account_id = config['codexAccountNamespaces'].get(selector)
    if not isinstance(account_id, str) or not re.fullmatch(r'[a-f0-9]{64}', expected_identity or ''):
        raise RuntimeError('exact_identity_required')
    if hashlib.sha256(account_id.encode()).hexdigest() != expected_identity:
        raise RuntimeError('identity_changed')
    if not commit:
        return {'terminal': 'DRY_RUN', 'selector': selector, 'paused': paused, 'remoteMutation': False}
    # Use the hub's own authenticated management client. No secret leaves A1.
    code = """import {apiJson} from './src/cli/account-api.ts';
const [id, paused]=JSON.parse(process.env.AICC_PAUSE_BODY);
const r=await apiJson({},'http://127.0.0.1:10100','PUT','/api/codex-auth/accounts/pause',{id,paused});
console.log(JSON.stringify({http:r.status,ok:r.json.ok,paused:r.json.paused}));
"""
    env = dict(os.environ, OPENCODEX_HOME=str(CONFIG.parent),
               CODEX_HOME=str(CONFIG.parent / 'codex-runtime'),
               AICC_PAUSE_BODY=json.dumps([account_id, paused]))
    result = run_json([BUN, '-e', code], cwd=PACKAGE, env=env)
    if result.get('http') != 200 or result.get('ok') is not True or result.get('paused') is not paused:
        raise RuntimeError('mutation_unconfirmed_do_not_retry')
    # Independent readback is required; a PUT acknowledgement alone is insufficient.
    rows = project_accounts(native_cli('account', 'list', 'openai', '--json'), config)
    if not any(r['selector'] == selector and r['paused'] is paused for r in rows):
        raise RuntimeError('readback_unconfirmed_do_not_retry')
    return {'terminal': 'PASS', 'selector': selector, 'paused': paused, 'remoteMutation': True}


WINDOW_SETTINGS=CONFIG.parent/'aicc-window-policy.json'
MANAGEMENT=CONFIG.parent/'aicc-management'

def dynamic_policy_supported():
    if not POLICY_REGISTRY.exists():return False
    registry=json.loads(POLICY_REGISTRY.read_text())
    return registry.get('version') in DYNAMIC_VERSIONS and registry.get('dynamicSettings') is True

def validate_window_settings(value):
    if not isinstance(value,dict) or value.get('schemaVersion')!=1:raise RuntimeError('invalid_window_settings')
    for key in ('fiveHour','longWindow'):
        row=value.get(key)
        if (not isinstance(row,dict) or type(row.get('usedThreshold')) is not int
                or not 1<=row['usedThreshold']<=100 or row.get('action') not in ('switch','stop')):
            raise RuntimeError('invalid_window_settings')
    return value

def read_window_settings():
    defaults={'schemaVersion':1,'fiveHour':{'usedThreshold':95,'action':'switch'},'longWindow':{'usedThreshold':98,'action':'switch'}}
    if not WINDOW_SETTINGS.exists():return defaults
    if WINDOW_SETTINGS.is_symlink() or not dynamic_policy_supported():raise RuntimeError('policy_runtime_upgrade_required')
    return validate_window_settings(json.loads(WINDOW_SETTINGS.read_text()))

def management_api(method,route,body=None):
    # Reuse the hub-owned capability client; never export its credential.
    code="""import {apiJson} from './src/cli/account-api.ts';
const [method,route,body]=JSON.parse(process.env.AICC_MANAGEMENT_BODY);
const r=await apiJson({},'http://127.0.0.1:10100',method,route,body);
console.log(JSON.stringify({http:r.status,ok:r.json?.ok!==false}));"""
    env=dict(os.environ,OPENCODEX_HOME=str(CONFIG.parent),CODEX_HOME=str(CONFIG.parent/'codex-runtime'),AICC_MANAGEMENT_BODY=json.dumps([method,route,body]))
    result=run_json([BUN,'-e',code],cwd=registered_package(),env=env)
    if result.get('http')!=200 or result.get('ok') is not True:raise RuntimeError('mutation_unconfirmed_do_not_retry')

def management_fingerprint():
    return hashlib.sha256(CONFIG.read_bytes()+b'\0'+(WINDOW_SETTINGS.read_bytes() if WINDOW_SETTINGS.exists() else b'')).hexdigest()

def validate_account_order(value,config):
    if not isinstance(value,list) or not 1<=len(value)<=16:raise RuntimeError('invalid_account_order')
    current=project_accounts(read_account_inventory('status'),config)
    expected={r['selector'] for r in current}
    seen=set()
    for index,entry in enumerate(value):
        if not isinstance(entry,dict) or set(entry)!={'selector','identityHash','priority'}:raise RuntimeError('invalid_order_entry')
        selector=entry['selector'];identity=entry['identityHash']
        if not isinstance(selector,str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}',selector) or selector=='main' or selector in seen:raise RuntimeError('invalid_order_selector')
        account_id=config.get('codexAccountNamespaces',{}).get(selector)
        if not isinstance(identity,str) or not re.fullmatch(r'[a-f0-9]{64}',identity) or not isinstance(account_id,str) or hashlib.sha256(account_id.encode()).hexdigest()!=identity:raise RuntimeError('identity_changed')
        if type(entry['priority']) is not int or entry['priority']!=len(value)-index:raise RuntimeError('invalid_order_rank')
        seen.add(selector)
    if seen!=expected:raise RuntimeError('account_set_changed_reload_order')
    return {entry['selector']:config.get('codexAccountPriorities',{}).get(config['codexAccountNamespaces'][entry['selector']],0) for entry in value}

def order_confirmed(value,config):
    try:
        current=validate_account_order(value,config)
        return all(current[e['selector']]==e['priority'] for e in value)
    except Exception:return False

def validate_reset_credit_guard(credits, guard):
    # Upstream consume accepts no credit selector. Multiple credits must HOLD:
    # a local oldest-expiry guess cannot constrain the provider's choice.
    if guard is None:return
    if not isinstance(guard,dict) or set(guard)!={'grantedAt','expiresAt','notBefore','notAfter'}:
        raise RuntimeError('reset_credit_guard_invalid')
    if any(not isinstance(guard[k],str) or len(guard[k])>64 for k in ('grantedAt','expiresAt')):
        raise RuntimeError('reset_credit_guard_invalid')
    if any(type(guard[k]) not in (int,float) for k in ('notBefore','notAfter')):
        raise RuntimeError('reset_credit_guard_invalid')
    now=time.time()
    if not guard['notBefore']<=now<guard['notAfter'] or not 0<guard['notAfter']-guard['notBefore']<=120:
        raise RuntimeError('reset_credit_exact_window_closed')
    rows=credits.get('credits')
    if credits.get('available_count')!=1 or not isinstance(rows,list) or len(rows)!=1:
        raise RuntimeError('reset_credit_exact_selection_unsupported_multiple_credits')
    if rows[0].get('granted_at')!=guard['grantedAt'] or rows[0].get('expires_at')!=guard['expiresAt']:
        raise RuntimeError('reset_credit_target_missing_no_substitution')

def change_managed(action,selector,expected_identity,value,commit,preview_token,credit_guard=None):
    if MANAGEMENT.is_symlink():raise RuntimeError('linked_management_directory_refused')
    MANAGEMENT.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (MANAGEMENT/'writer.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('management_busy_no_dispatch')
        config=json.loads(CONFIG.read_text())
        policy=read_window_settings()
        row=None;account_id=None
        if action not in ('policy','order'):
            if not re.fullmatch(r'[A-Za-z0-9._-]{1,64}',selector or '') or selector=='main':raise RuntimeError('exact_pool_selector_required')
            account_id=config.get('codexAccountNamespaces',{}).get(selector)
            if not isinstance(account_id,str) or hashlib.sha256(account_id.encode()).hexdigest()!=expected_identity:raise RuntimeError('identity_changed')
            rows=project_accounts(read_account_inventory('refresh'),config)
            row=next((r for r in rows if r['selector']==selector),None)
            if row is None:raise RuntimeError('account_missing')
            if action=='priority' and (type(value) is not int or not -100<=value<=100):raise RuntimeError('invalid_priority')
            if action=='use':
                admission=project_admission(row,effective_policy())
                if admission['state'] in ('blocked','unverified'):raise RuntimeError('account_not_eligible')
            if action=='reset':
                credits=native_cli('account','reset-credits',account_id,'--json')
                validate_reset_credit_guard(credits,credit_guard)
                count=credits.get('available_count')
                if type(count) is not int or count<=0:raise RuntimeError('no_confirmed_reset_credits')
                value={'availableCount':count}
        elif action=='order':
            validate_account_order(value,config)
        else:
            validate_window_settings(value)
            if not dynamic_policy_supported():raise RuntimeError('policy_runtime_upgrade_required')
        requested={'action':action,'selector':selector,'identityHash':expected_identity,'value':value}
        if credit_guard is not None:requested['creditGuard']=credit_guard
        if not commit:
            nonce=uuid.uuid4().hex
            record={**requested,'fingerprint':management_fingerprint(),'expires':time.time()+60}
            if action=='order':record['beforePriorities']=validate_account_order(value,config)
            pending=MANAGEMENT/(nonce+'.json')
            with pending.open('x') as file:json.dump(record,file)
            pending.chmod(0o600)
            return {'terminal':'DRY_RUN','previewToken':nonce,'selector':selector,'action':action,'value':value,'remoteMutation':False}
        if not re.fullmatch(r'[a-f0-9]{32}',preview_token or ''):raise RuntimeError('fresh_one_use_preview_required')
        pending=MANAGEMENT/(preview_token+'.json')
        if not pending.is_file() or pending.is_symlink():raise RuntimeError('preview_missing_or_consumed')
        record=json.loads(pending.read_text())
        if any(record.get(k)!=v for k,v in requested.items()) or record['expires']<time.time() or record['fingerprint']!=management_fingerprint():raise RuntimeError('preview_stale_no_dispatch')
        claimed=MANAGEMENT/(preview_token+'.claimed.json');pending.rename(claimed)
        # A claimed request is never automatically retried, including transport failures.
        reset_result=None
        if action=='reset':
            # One stable UUID reaches OCX's existing physical-account spend ledger.
            reset_result=native_cli('account','reset-credits',account_id,'--consume','--yes','--operation-id',str(uuid.UUID(hex=preview_token)),'--json')
            if reset_result.get('code') not in ('reset','already_redeemed','nothing_to_reset','no_credit'):raise RuntimeError('reset_outcome_unconfirmed_do_not_retry')
        elif action in ('pause','resume'):management_api('PUT','/api/codex-auth/accounts/pause',{'id':account_id,'paused':action=='pause'})
        elif action=='priority':management_api('PUT','/api/codex-auth/accounts/priority',{'id':account_id,'priority':value})
        elif action=='order':
            # Several official narrow updates under one durable operation.
            # Partial/unknown results retain their claimed ledger; no replay.
            expected=dict(record['beforePriorities'])
            record['appliedSelectors']=[]
            for entry in value:
                current_config=json.loads(CONFIG.read_text())
                if validate_account_order(value,current_config)!=expected:raise RuntimeError('order_concurrent_change_no_retry')
                if expected[entry['selector']]==entry['priority']:continue
                record['dispatchingSelector']=entry['selector']
                claimed.write_text(json.dumps(record))
                management_api('PUT','/api/codex-auth/accounts/priority',{'id':current_config['codexAccountNamespaces'][entry['selector']],'priority':entry['priority']})
                expected[entry['selector']]=entry['priority']
                after=json.loads(CONFIG.read_text())
                if validate_account_order(value,after)!=expected:raise RuntimeError('order_step_unconfirmed_do_not_retry')
                record['appliedSelectors'].append(entry['selector'])
                record['dispatchingSelector']=None
                claimed.write_text(json.dumps(record))
        elif action in ('use','unpin'):management_api('PUT','/api/codex-auth/active',{'accountId':account_id if action=='use' else None})
        else:
            if WINDOW_SETTINGS.exists():
                backup=MANAGEMENT/(preview_token+'.policy-before.json');backup.write_bytes(WINDOW_SETTINGS.read_bytes());backup.chmod(0o600)
            updated={**value,'revision':uuid.uuid4().hex}
            temporary=WINDOW_SETTINGS.with_suffix('.'+preview_token+'.tmp');temporary.write_text(json.dumps(updated)+'\n');temporary.chmod(0o600);temporary.replace(WINDOW_SETTINGS)
        fresh_config=json.loads(CONFIG.read_text())
        if action=='reset':confirmed=reset_result is not None
        elif action=='policy':confirmed=read_window_settings()['fiveHour']==value['fiveHour'] and read_window_settings()['longWindow']==value['longWindow']
        elif action=='order':confirmed=order_confirmed(value,fresh_config)
        elif action=='unpin':confirmed=not fresh_config.get('activeCodexAccountPinned')
        else:
            fresh=project_accounts(read_account_inventory('status'),fresh_config)
            item=next((r for r in fresh if r['selector']==selector),None)
            confirmed=item is not None and (item.get('paused') is (action=='pause') if action in ('pause','resume') else item.get('priority')==value if action=='priority' else item.get('active') is True)
        if not confirmed:raise RuntimeError('readback_unconfirmed_do_not_retry')
        result={'terminal':'PASS','action':action,'selector':selector,'value':value,'remoteMutation':True,'requestId':preview_token}
        if reset_result is not None:
            result['resetCode']=reset_result['code']
            if type(reset_result.get('remaining')) is int:result['resetRemaining']=reset_result['remaining']
        complete=MANAGEMENT/(preview_token+'.complete.json');complete.write_text(json.dumps(result));complete.chmod(0o600)
        return result

def reconcile_managed(preview_token):
    if not re.fullmatch(r'[a-f0-9]{32}',preview_token or '') or MANAGEMENT.is_symlink():raise RuntimeError('invalid_reconciliation_request')
    MANAGEMENT.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (MANAGEMENT/'writer.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'terminal':'HOLD','reason':'mutation_still_running','requestId':preview_token}
        registered_package()
        complete=MANAGEMENT/(preview_token+'.complete.json')
        claimed=MANAGEMENT/(preview_token+'.claimed.json')
        pending=MANAGEMENT/(preview_token+'.json')
        if any(p.is_symlink() for p in (complete,claimed,pending)):raise RuntimeError('linked_receipt_refused')
        if complete.is_file():
            receipt=json.loads(complete.read_text())
            if receipt.get('terminal')!='PASS' or receipt.get('requestId')!=preview_token:raise RuntimeError('invalid_completion_receipt')
            return {'terminal':'PASS','reconciled':'completed_receipt','requestId':preview_token,'remoteMutation':False}
        if not claimed.is_file():
            if pending.is_file():return {'terminal':'PASS','reconciled':'not_dispatched','requestId':preview_token,'remoteMutation':False}
            return {'terminal':'HOLD','reason':'receipt_missing','requestId':preview_token}
        record=json.loads(claimed.read_text());action=record.get('action');value=record.get('value')
        if action=='reset':
            # A changed quota/count alone cannot prove that this particular spend completed.
            return {'terminal':'HOLD','reason':'reset_receipt_unconfirmed_no_retry','requestId':preview_token,'remoteMutation':False}
        config=json.loads(CONFIG.read_text())
        if action=='order':
            confirmed=order_confirmed(value,config)
        elif action=='policy':
            policy=read_window_settings()
            confirmed=policy['fiveHour']==value['fiveHour'] and policy['longWindow']==value['longWindow']
        else:
            account_id=config.get('codexAccountNamespaces',{}).get(record.get('selector'))
            if not isinstance(account_id,str) or hashlib.sha256(account_id.encode()).hexdigest()!=record.get('identityHash'):raise RuntimeError('identity_changed')
            rows=project_accounts(read_account_inventory('status'),config)
            item=next((r for r in rows if r['selector']==record['selector']),None)
            confirmed=(not config.get('activeCodexAccountPinned')) if action=='unpin' else item is not None and (item.get('paused') is (action=='pause') if action in ('pause','resume') else item.get('priority')==value if action=='priority' else item.get('active') is True if action=='use' else False)
        return {'terminal':'PASS' if confirmed else 'HOLD','reconciled':'current_postcondition' if confirmed else None,'reason':None if confirmed else 'postcondition_unconfirmed_no_retry','requestId':preview_token,'remoteMutation':False}

def inspect_managed_credits(selector,expected_identity,config):
    # Explicitly read-only: owner CLI uses no --consume/--yes options.
    if not isinstance(selector,str) or selector=='main' or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}',selector):
        raise RuntimeError('exact_pool_selector_required')
    if not isinstance(expected_identity,str) or not re.fullmatch(r'[a-f0-9]{64}',expected_identity):
        raise RuntimeError('exact_pool_identity_required')
    account_id=config.get('codexAccountNamespaces',{}).get(selector)
    if not isinstance(account_id,str) or hashlib.sha256(account_id.encode()).hexdigest()!=expected_identity:
        raise RuntimeError('identity_changed')
    response=native_cli('account','reset-credits',account_id,'--json')
    if not isinstance(response,dict):
        raise RuntimeError('credit_inventory_invalid')
    original=response.get('credits')
    if not isinstance(original,list) or len(original)>48:
        raise RuntimeError('credit_inventory_invalid')
    credits=[]
    for value in original:
        if not isinstance(value,dict):
            raise RuntimeError('credit_inventory_invalid')
        granted=value.get('granted_at')
        expires=value.get('expires_at')
        if not isinstance(granted,str) or not isinstance(expires,str) or len(granted)>64 or len(expires)>64:
            raise RuntimeError('credit_inventory_invalid')
        credits.append({'granted_at':granted,'expires_at':expires})
    available=response.get('available_count')
    if available is not None and (type(available) is not int or not 0<=available<=1000):
        raise RuntimeError('credit_count_invalid')
    return {'terminal':'PASS','selector':selector,'identityHash':expected_identity,
            'credits':credits,'available_count':available,'remoteMutation':False}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('status', 'refresh', 'identity', 'pair', 'recover', 'pause', 'resume','priority','use','unpin','reset','policy','order','reconcile','credits'))
    parser.add_argument('--selector')
    parser.add_argument('--expected-identity')
    parser.add_argument('--commit', action='store_true')
    parser.add_argument('--priority',type=int)
    parser.add_argument('--short-threshold',type=int)
    parser.add_argument('--long-threshold',type=int)
    parser.add_argument('--short-action',choices=('switch','stop'))
    parser.add_argument('--long-action',choices=('switch','stop'))
    parser.add_argument('--order-base64')
    parser.add_argument('--preview-token')
    parser.add_argument('--reset-credit-guard-base64')
    args = parser.parse_args()
    credit_guard=None
    if args.reset_credit_guard_base64:
        if args.action!='reset' or len(args.reset_credit_guard_base64)>2048:raise RuntimeError('reset_credit_guard_scope_invalid')
        credit_guard=json.loads(base64.b64decode(args.reset_credit_guard_base64,validate=True).decode('utf-8'))
    config = json.loads(CONFIG.read_text())
    if args.action == 'pair':
        if args.commit or args.selector or args.expected_identity:
            raise RuntimeError('unexpected_pairing_arguments')
        # Intentionally print only a freshly issued, one-use GUI grant for the owner to paste.
        # This command must not be redirected into evidence logs or called by health probes.
        result = native_cli('gui', 'pair', '--origin', 'http://localhost:10100', '--json')
    elif args.action == 'recover':
        if args.selector or args.expected_identity:
            raise RuntimeError('unexpected_recovery_arguments')
        result = recover_hub(args.commit)
    elif args.action=='credits':
        if args.commit or args.preview_token or args.priority is not None or args.short_threshold or args.long_threshold or args.short_action or args.long_action:
            raise RuntimeError('readonly_credits_only')
        result=inspect_managed_credits(args.selector,args.expected_identity,config)
    elif args.action=='reconcile':
        if args.commit or args.selector or args.expected_identity:raise RuntimeError('readonly_reconciliation_only')
        result=reconcile_managed(args.preview_token)
    elif args.action=='order':
        if args.selector or args.expected_identity or not args.order_base64 or len(args.order_base64)>8192:raise RuntimeError('exact_order_required')
        value=json.loads(base64.b64decode(args.order_base64,validate=True).decode('utf-8'))
        result=change_managed('order',None,None,value,args.commit,args.preview_token)
    elif args.action in ('pause','resume','priority','use','unpin','reset','policy'):
        value=args.priority if args.action=='priority' else {'schemaVersion':1,'fiveHour':{'usedThreshold':args.short_threshold,'action':args.short_action},'longWindow':{'usedThreshold':args.long_threshold,'action':args.long_action}} if args.action=='policy' else None
        result=change_managed(args.action,args.selector,args.expected_identity,value,args.commit,args.preview_token,credit_guard)
    else:
        if args.commit or args.selector or args.expected_identity:
            raise RuntimeError('unexpected_read_arguments')
        payload = read_account_inventory(args.action)
        watcher = run_json(['python3', '-B', WATCHER, 'status', '--root', STATE])
        rows = (project_identities if args.action in ('identity','refresh') else project_accounts)(payload, config)
        policy=effective_policy()
        for row in rows:row['admission']=project_admission(row,policy)
        live_selectors = {row['selector'] for row in rows}
        for row in watcher.get('accounts', []):
            row['presentInPool'] = row.get('selector') in live_selectors
            observed = row.get('lastObservationAt')
            row['observationAgeSeconds'] = round(max(0, time.time() - observed)) if isinstance(observed, (int, float)) else None
        result = {'terminal': 'PASS', 'observedAt': time.time(), 'source': 'a1-ocx-hub',
                  'threshold': config.get('autoSwitchThreshold'),
                  'cacheAffinity': config.get('pool', {}).get('cacheAffinity'),
                  'quotaSource': 'live-refresh' if args.action == 'refresh' else 'cached-list',
                  'accounts': rows, 'watcher': watcher,'effectivePolicy':policy}
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        safe = str(error) if isinstance(error, RuntimeError) else 'hub_management_failed'
        print(json.dumps({'terminal': 'HOLD', 'failureCode': safe, 'retryAllowed': False}))
        sys.exit(1)
