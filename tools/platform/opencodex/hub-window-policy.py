"""A1-only software deployment. Account homes and original installation stay intact."""
import argparse, hashlib, json, os, pathlib, subprocess, time, urllib.request, sqlite3

HOME=pathlib.Path('/demo/owner')
BASE=HOME/'.local/share/ocx-window-policy'
REGISTRY=BASE/'active.json'
DROP=HOME/'.config/systemd/user/opencodex-proxy.service.d/60-aicc-windows.conf'
BUN=HOME/'.local/opt/bun-1.4.0/bun-linux-aarch64/bun'
STOCK=HOME/'.bun/install/global'
HASH='6d3bd9ade530a4f66f1cf20ff543d4c407d99b5ef34b3f39241c17c842a772f6'
ADMISSION_HASHES={
 'src/codex/routing/selection.ts':'f1418ce93256e1773195af3dd119934922e75637c63f6172f32c7c2e6e0a104d',
 'src/codex/auth-context.ts':'012a80c3eba6147b8883d797950e75392d41565fe0c63cdf3d000c7d0395f00a',
 'src/codex/routing/aicc-window-admission.ts':'6aa03fbb546eb1e37d1efa78ce8564eb4b28dbb7de4841f41b8d0ec3f7271c6c'}
PREVIOUS=BASE/'previous.json'
NEW_ADMISSION_HASHES={
 'src/codex/routing/selection.ts':'c3f2f5e29864aa667b4d5cb4d9eef0ad33df8dde63606914e6577e91e9fd8da5',
 'src/codex/auth-context.ts':'aeb0659c9297491b94686e2073928ab370563bfd1e49d82f88096db35d48304b',
 'src/codex/routing/aicc-window-admission.ts':ADMISSION_HASHES['src/codex/routing/aicc-window-admission.ts']}
DYNAMIC_VERSIONS=('2.77.0-aicc.windows.2','2.77.0-aicc.windows.3')
POLICY_VERSIONS=('2.76.0-aicc.windows.1','2.76.0-aicc.windows.2','2.76.0-aicc.windows.3','2.77.0-aicc.windows.1',*DYNAMIC_VERSIONS)
STRICT_VERSIONS=('2.76.0-aicc.windows.3','2.77.0-aicc.windows.1',*DYNAMIC_VERSIONS)
INFLIGHT_FILES={
 'src/codex/routing/selection.ts','src/codex/auth-context.ts',
 'src/codex/routing/aicc-window-admission.ts','src/codex/routing/aicc-window-settings.ts',
 'src/codex/routing/aicc-inflight-monitor.ts','src/codex/routing/aicc-inflight-runtime.ts',
 'src/server/responses/core.ts','src/server/responses/core-codex-account.ts',
 'src/server/responses/aicc-inflight-response.ts','src/lib/upstream-retry.ts',
}

def system(*args):
    return subprocess.run(['systemctl','--user',*args],check=True,capture_output=True,text=True,timeout=20).stdout.strip()

def health():
    try:
        with urllib.request.urlopen('http://127.0.0.1:10100/readyz',timeout=4) as reply:return json.load(reply)
    except Exception:return None

def activity(package=None):
    if package is None:package=checked(json.loads(REGISTRY.read_text()))
    code="import {apiJson} from './src/cli/account-api.ts'; const r=await apiJson({},'http://127.0.0.1:10100','GET','/api/system/memory'); if(r.status!==200)throw Error('management'); console.log(JSON.stringify(r.json));"
    env=dict(os.environ,OPENCODEX_HOME=str(HOME/'.opencodex-hub'),CODEX_HOME=str(HOME/'.opencodex-hub/codex-runtime'))
    r=subprocess.run([str(BUN),'-e',code],cwd=package,env=env,capture_output=True,text=True,timeout=20)
    if r.returncode:raise RuntimeError('idle_unconfirmed')
    value=json.loads(r.stdout)
    return {'terminal':'PASS','activeTurnCount':value.get('activeTurnCount'),'isDraining':value.get('isDraining')}

def idle(package):
    value=activity(package)
    if value.get('activeTurnCount')!=0 or value.get('isDraining') is not False:raise RuntimeError('hub_busy_preserved')

def checked(registry):
    root=pathlib.Path(registry['root']);package=root/'node_modules/@bitkyc08/opencodex'
    if not root.is_relative_to(BASE/'versions') or root.is_symlink():raise RuntimeError('registered_software_root_required')
    version=json.loads((package/'package.json').read_text())['version']
    if version not in POLICY_VERSIONS:raise RuntimeError('policy_version_changed')
    if version in DYNAMIC_VERSIONS:
        manifest_path=package/'aicc-policy-manifest.json'
        if manifest_path.is_symlink() or hashlib.sha256(manifest_path.read_bytes()).hexdigest()!=registry.get('policyManifestSha256'):raise RuntimeError('dynamic_manifest_changed')
        manifest=json.loads(manifest_path.read_text())
        if manifest.get('version')!=version or not manifest.get('dynamicSettings') or not registry.get('dynamicSettings'):raise RuntimeError('dynamic_registration_changed')
        if version=='2.77.0-aicc.windows.3':
            if manifest.get('inflightProtection') is not True or registry.get('inflightProtection') is not True:raise RuntimeError('inflight_registration_changed')
            if set(manifest['admissionSourceSha256'])!=INFLIGHT_FILES:raise RuntimeError('inflight_manifest_incomplete')
            if manifest.get('updateSourceSha256')!=registry.get('updateSourceSha256'):raise RuntimeError('inflight_update_guard_registry_changed')
        if manifest['admissionSourceSha256']!=registry.get('admissionSourceSha256') or manifest['policySourceSha256']!=registry.get('policySourceSha256'):raise RuntimeError('dynamic_source_registry_changed')
        if hashlib.sha256((package/'src/codex/routing/cooldown-math.ts').read_bytes()).hexdigest()!=manifest['policySourceSha256']:raise RuntimeError('dynamic_policy_source_changed')
        for relative,expected in manifest['admissionSourceSha256'].items():
            allowed=relative in INFLIGHT_FILES if version=='2.77.0-aicc.windows.3' else relative.startswith('src/codex/')
            if not allowed or '..' in pathlib.Path(relative).parts or hashlib.sha256((package/relative).read_bytes()).hexdigest()!=expected:raise RuntimeError('dynamic_admission_changed')
        if hashlib.sha256((package/'src/server/management/config-routes.ts').read_bytes()).hexdigest()!=registry.get('updateSourceSha256'):raise RuntimeError('dynamic_update_guard_changed')
        if hashlib.sha256(DROP.read_bytes()).hexdigest()!=registry['dropSha256']:raise RuntimeError('service_dropin_changed')
        return package
    expected_math='48d463044f25837b2eba65a785ea60e3c534619bf67c1b460c19ff3ac2f02b9c' if version=='2.77.0-aicc.windows.1' else HASH
    if hashlib.sha256((package/'src/codex/routing/cooldown-math.ts').read_bytes()).hexdigest()!=expected_math:raise RuntimeError('policy_source_changed')
    if version in ('2.76.0-aicc.windows.2',*STRICT_VERSIONS):
        update_hash=registry.get('updateSourceSha256')
        if not update_hash or hashlib.sha256((package/'src/server/management/config-routes.ts').read_bytes()).hexdigest()!=update_hash:raise RuntimeError('update_guard_source_changed')
    if version in STRICT_VERSIONS:
        admission_hashes=NEW_ADMISSION_HASHES if version=='2.77.0-aicc.windows.1' else ADMISSION_HASHES
        if registry.get('admissionSourceSha256')!=admission_hashes:raise RuntimeError('admission_registry_changed')
        for relative,expected in admission_hashes.items():
            if hashlib.sha256((package/relative).read_bytes()).hexdigest()!=expected:raise RuntimeError('admission_source_changed')
    if hashlib.sha256(DROP.read_bytes()).hexdigest()!=registry['dropSha256']:raise RuntimeError('service_dropin_changed')
    return package

def status():
    if not REGISTRY.exists():return {'terminal':'STOCK','version':(health() or {}).get('version'),'enabled':False}
    registry=json.loads(REGISTRY.read_text());package=checked(registry);ready=health()
    pid=int(system('show','opencodex-proxy.service','--property=MainPID','--value'))
    owns=False
    if ready and pid>0:
        args=(pathlib.Path('/proc')/str(ready['pid'])/'cmdline').read_bytes().split(b'\0')
        env=(pathlib.Path('/proc')/str(ready['pid'])/'environ').read_bytes().split(b'\0')
        owns=str(package/'src/cli/index.ts').encode() in args and b'AICC_OCX_WINDOW_THRESHOLDS=95,98' in env
    windows={'fiveHour':{'usedThreshold':95,'action':'switch'},'longWindow':{'usedThreshold':98,'action':'switch'}}
    settings_path=HOME/'.opencodex-hub/aicc-window-policy.json'
    if settings_path.exists():
        if settings_path.is_symlink() or registry.get('version') not in DYNAMIC_VERSIONS or registry.get('dynamicSettings') is not True:raise RuntimeError('policy_settings_runtime_mismatch')
        windows=json.loads(settings_path.read_text())
        if windows.get('schemaVersion')!=1:raise RuntimeError('invalid_policy_settings')
        for key in ('fiveHour','longWindow'):
            rule=windows.get(key,{})
            if type(rule.get('usedThreshold')) is not int or not 1<=rule['usedThreshold']<=100 or rule.get('action') not in ('switch','stop'):raise RuntimeError('invalid_policy_settings')
    return {'terminal':'PASS' if owns and ready.get('status')=='ready' else 'HOLD','enabled':True,
        'version':ready.get('version') if ready else None,'fiveHourUsedThreshold':windows['fiveHour']['usedThreshold'],'weeklyUsedThreshold':windows['longWindow']['usedThreshold'],
        'fiveHourAction':windows['fiveHour']['action'],'longWindowAction':windows['longWindow']['action'],'settingsSupported':registry.get('dynamicSettings') is True,
        'weeklyRemainingThreshold':100-windows['longWindow']['usedThreshold'],'root':registry['root'],'ownerVerified':owns,'accountStateChanged':False,
        'strictAdmission':registry['version'] in STRICT_VERSIONS,
        'freshQuotaRequired':registry['version'] in STRICT_VERSIONS,
        'inflightProtection':registry.get('inflightProtection') is True and registry['version']=='2.77.0-aicc.windows.3',
        'inflightPollMs':5000 if registry['version']=='2.77.0-aicc.windows.3' else None,
        'inflightFreshnessMs':15000 if registry['version']=='2.77.0-aicc.windows.3' else None,
        'inflightReplay':'never','providerCancellationAcknowledged':False,
        'upstreamVersion':registry.get('upstreamVersion'),
        'admissionFreshnessMs':60000 if registry['version'] in STRICT_VERSIONS else None}

def database_backup(destination):
    rows=[];owner=HOME/'.opencodex-hub'
    for source in owner.rglob('*.sqlite'):
        if source.is_symlink():raise RuntimeError('database_link_refused')
        target=destination/'databases'/source.relative_to(owner);target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=5) as current:
            if current.execute('pragma integrity_check').fetchone()!=('ok',):raise RuntimeError('database_integrity_failed')
            with sqlite3.connect(target) as saved:current.backup(saved)
        target.chmod(0o600)
        with sqlite3.connect(target.as_uri()+'?mode=ro',uri=True) as saved:
            if saved.execute('pragma integrity_check').fetchone()!=('ok',):raise RuntimeError('database_backup_integrity_failed')
        rows.append(str(source.relative_to(owner)))
    return {'count':len(rows),'integrity':'ok','backupIntegrity':'ok','accountStateRestored':False}

def restore_previous():
    if not PREVIOUS.exists():return rollback()
    previous=json.loads(PREVIOUS.read_text());current=json.loads(REGISTRY.read_text());package=checked(current)
    if health():idle(package)
    system('stop','opencodex-proxy.service')
    if int(system('show','opencodex-proxy.service','--property=MainPID','--value'))!=0:raise RuntimeError('restore_owner_stop_unconfirmed')
    DROP.write_text(previous['drop']);REGISTRY.write_text(json.dumps(previous['registry']));REGISTRY.chmod(0o600)
    checked(previous['registry']);system('daemon-reload');system('start','opencodex-proxy.service')
    for _ in range(20):
        state=status()
        if state['terminal']=='PASS' and state['version']==previous['registry']['version']:return {'terminal':'PASS_PREVIOUS_RESTORED','version':state['version'],'accountStateRestored':False}
        time.sleep(1)
    raise RuntimeError('previous_restart_unconfirmed')

def rollback():
    registry=json.loads(REGISTRY.read_text());package=checked(registry)
    if health():idle(package)
    system('stop','opencodex-proxy.service')
    if int(system('show','opencodex-proxy.service','--property=MainPID','--value'))!=0:raise RuntimeError('stop_unconfirmed')
    DROP.unlink();REGISTRY.rename(BASE/('inactive-'+str(time.time_ns())+'.json'))
    system('daemon-reload');system('start','opencodex-proxy.service')
    for _ in range(20):
        ready=health()
        if ready and ready.get('version')=='2.76.0':return {'terminal':'PASS_ROLLBACK','accountStateChanged':False}
        time.sleep(1)
    raise RuntimeError('stock_restart_unconfirmed')

def prepare(version):
    if version!='2.77.0':raise RuntimeError('reviewed_candidate_version_required')
    source=BASE/'candidates'/version/'.bun/install/global'
    package=source/'node_modules/@bitkyc08/opencodex'
    if not source.exists():
        source.mkdir(parents=True,mode=0o700)
        (source/'package.json').write_text(json.dumps({'private':True,'dependencies':{'@bitkyc08/opencodex':version}}))
        result=subprocess.run([str(BUN),'install','--cwd',str(source),'--ignore-scripts'],capture_output=True,timeout=180)
        if result.returncode:raise RuntimeError('candidate_dependency_install_failed_live_preserved')
    info=json.loads((package/'package.json').read_text())
    if info.get('version')!=version or source.is_symlink():raise RuntimeError('candidate_version_changed')
    return {'terminal':'PASS_PREPARED','version':version,'source':str(source),'liveRuntimeChanged':False}

def deploy(builder_bytes,fixture_bytes,target_version=None,stage_only=False):
    previous=None
    if REGISTRY.exists():
        old_registry=json.loads(REGISTRY.read_text());old_package=checked(old_registry)
        dynamic=os.environ.get('AICC_OCX_DYNAMIC_POLICY')=='1'
        inflight=os.environ.get('AICC_OCX_INFLIGHT_POLICY')=='1'
        desired='2.77.0-aicc.windows.3' if inflight else '2.77.0-aicc.windows.2'
        if old_registry['version']==desired and dynamic and target_version=='2.77.0':return status()
        allowed=old_registry['version'] in ('2.76.0-aicc.windows.2','2.76.0-aicc.windows.3') or (old_registry['version']=='2.77.0-aicc.windows.1' and dynamic and target_version=='2.77.0') or (old_registry['version']=='2.77.0-aicc.windows.2' and dynamic and inflight and target_version=='2.77.0')
        if not allowed:raise RuntimeError('only_reviewed_policy_upgrade_allowed')
        if old_registry['version']=='2.76.0-aicc.windows.3' and target_version!='2.77.0':raise RuntimeError('reviewed_next_version_required')
        previous={'registry':old_registry,'drop':DROP.read_text()}
    elif DROP.exists():raise RuntimeError('unregistered_policy_preserved')
    ready=health()
    expected=previous['registry']['version'] if previous else '2.76.0'
    if not ready or ready.get('version')!=expected or ready.get('status')!='ready':raise RuntimeError('running_attested_version_required_no_start_if_off')
    if not stage_only:idle(old_package if previous else STOCK/'node_modules/@bitkyc08/opencodex')
    BASE.mkdir(parents=True,exist_ok=True,mode=0o700)
    output=BASE/'versions'/str(time.time_ns())/'.bun/install/global'
    scope={'__name__':'window_policy_build'};exec(builder_bytes,scope)
    source=STOCK if target_version is None else BASE/'candidates'/target_version/'.bun/install/global'
    if target_version is not None and target_version!='2.77.0':raise RuntimeError('reviewed_candidate_version_required')
    build=scope['build'](source,output)
    package=output/'node_modules/@bitkyc08/opencodex'
    fixture=output/'aicc-quota-fixture.mjs';fixture.write_bytes(fixture_bytes)
    env=dict(os.environ,AICC_OCX_PACKAGE_ROOT=str(package),AICC_OCX_WINDOW_THRESHOLDS='95,98')
    result=subprocess.run([str(BUN),str(fixture)],env=env,capture_output=True,text=True,timeout=45)
    if result.returncode:raise RuntimeError('candidate_fixture_failed_original_preserved')
    evidence=json.loads(result.stdout)
    if evidence.get('terminal')!='PASS_SIMULATION' or len(evidence['checks'])!=24:raise RuntimeError('candidate_fixture_incomplete')
    import base64
    admission_fixture=output/'aicc-admission-fixture.mjs';admission_fixture.write_bytes(base64.b64decode(os.environ['AICC_POLICY_ADMISSION_FIXTURE']))
    result=subprocess.run([str(BUN),str(admission_fixture)],env=env,capture_output=True,text=True,timeout=45)
    if result.returncode:raise RuntimeError('candidate_admission_fixture_failed_original_preserved')
    admission_evidence=json.loads(result.stdout)
    if admission_evidence.get('terminal')!='PASS_ADMISSION' or len(admission_evidence['checks'])!=10 or admission_evidence.get('inferenceAttempts')!=0:raise RuntimeError('candidate_admission_fixture_incomplete')
    if build.get('dynamicSettings') and len(admission_evidence.get('dynamicChecks',[]))!=8:raise RuntimeError('candidate_dynamic_window_fixture_incomplete')
    inflight_evidence=None
    if build.get('inflightProtection'):
        if not os.environ.get('AICC_POLICY_INFLIGHT_FIXTURE'):raise RuntimeError('inflight_fixture_required')
        inflight_fixture=output/'aicc-inflight-fixture.mjs';inflight_fixture.write_bytes(base64.b64decode(os.environ['AICC_POLICY_INFLIGHT_FIXTURE']))
        result=subprocess.run([str(BUN),str(inflight_fixture)],env=env,capture_output=True,text=True,timeout=45)
        if result.returncode:raise RuntimeError('candidate_inflight_fixture_failed_original_preserved')
        inflight_evidence=json.loads(result.stdout)
        if inflight_evidence.get('terminal')!='PASS_INFLIGHT_SIMULATION' or len(inflight_evidence.get('checks',[]))!=14 or inflight_evidence.get('inferenceAttempts')!=0:raise RuntimeError('candidate_inflight_fixture_incomplete')
    if stage_only:return {'terminal':'PASS_STAGED','version':build['version'],'candidateRoot':str(output),'fixture':evidence,'admissionFixture':admission_evidence,'inflightFixture':inflight_evidence,'liveRuntimeChanged':False}
    for _ in range(5):
        idle(old_package if previous else STOCK/'node_modules/@bitkyc08/opencodex');time.sleep(.25)
    backup=BASE/'recovery'/str(time.time_ns());backup.mkdir(parents=True,mode=0o700)
    database_evidence=database_backup(backup)
    config_hash=hashlib.sha256((HOME/'.opencodex-hub/config.json').read_bytes()).hexdigest()
    policy_path=HOME/'.opencodex-hub/aicc-window-policy.json'
    policy_hash=hashlib.sha256(policy_path.read_bytes()).hexdigest() if policy_path.exists() else None
    if previous:
        PREVIOUS.write_text(json.dumps(previous));PREVIOUS.chmod(0o600)
        (backup/'previous.json').write_text(json.dumps(previous));(backup/'previous.json').chmod(0o600)
    idle(old_package if previous else STOCK/'node_modules/@bitkyc08/opencodex')
    DROP.parent.mkdir(parents=True,exist_ok=True)
    # Keep official base unit, credential injection, restart policy and owner homes.
    command=f"if [ -f '/demo/owner/.opencodex-hub/service-api-token' ]; then OPENCODEX_API_AUTH_TOKEN=\\\"$(cat '/demo/owner/.opencodex-hub/service-api-token')\\\"; export OPENCODEX_API_AUTH_TOKEN; fi; exec '{BUN}' '{package}/src/cli/index.ts' start --port 10100 >> '/demo/owner/.opencodex-hub/service.log' 2>&1"
    drop='[Service]\nEnvironment="AICC_OCX_WINDOW_THRESHOLDS=95,98"\nExecStart=\nExecStart="/bin/sh" -lc "'+command+'"\n'
    registry={'schemaVersion':1,'root':str(output),'dropSha256':hashlib.sha256(drop.encode()).hexdigest(),
        'version':build['version'],'policySourceSha256':build['policySourceSha256'],'updateSourceSha256':build['updateSourceSha256'],
        'admissionSourceSha256':build['admissionSourceSha256'],
        'upstreamVersion':build['upstreamVersion'],'thresholds':'95,98',
        'dynamicSettings':build.get('dynamicSettings',False),'inflightProtection':build.get('inflightProtection',False),'policyManifestSha256':build.get('policyManifestSha256')}
    system('stop','opencodex-proxy.service')
    if int(system('show','opencodex-proxy.service','--property=MainPID','--value'))!=0:raise RuntimeError('owner_stop_unconfirmed')
    DROP.write_text(drop);REGISTRY.write_text(json.dumps(registry));REGISTRY.chmod(0o600)
    watchdog='aicc-ocx-policy-rollback-'+str(time.time_ns())
    durable=BASE/'hub-window-policy.py'
    subprocess.run(['systemd-run','--user','--unit='+watchdog,'--on-active=120s','/usr/bin/python3',str(durable),'restore-previous' if previous else 'rollback'],check=True,capture_output=True,timeout=15)
    try:
        system('daemon-reload');system('start','opencodex-proxy.service')
        for _ in range(20):
            state=status()
            if state['terminal']=='PASS':
                idle(package)
                if hashlib.sha256((HOME/'.opencodex-hub/config.json').read_bytes()).hexdigest()!=config_hash:raise RuntimeError('config_changed_during_software_deploy')
                if (hashlib.sha256(policy_path.read_bytes()).hexdigest() if policy_path.exists() else None)!=policy_hash:raise RuntimeError('window_settings_changed_during_software_deploy')
                system('stop',watchdog+'.timer')
                return {**state,'fixture':evidence,'admissionFixture':admission_evidence,'inflightFixture':inflight_evidence,'database':database_evidence,'configUnchanged':True,'windowSettingsUnchanged':True,'strictAdmission':True,'stockSoftwarePreserved':True,'rollback':'aicc-ocx-policy -Action rollback'}
            time.sleep(1)
        raise RuntimeError('candidate_restart_unconfirmed')
    except Exception:
        recovery=restore_previous() if previous else rollback()
        return {'terminal':'ROLLED_BACK','recovery':recovery,'accountStateChanged':False}

def main():
    import base64
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=('status','activity','prepare','stage','deploy','rollback','restore-previous'));parser.add_argument('--target',choices=('2.77.0',));args=parser.parse_args()
    if args.action=='activity':result=activity()
    elif args.action=='status':result=status()
    elif args.action=='rollback':result=rollback()
    elif args.action=='restore-previous':result=restore_previous()
    elif args.action=='prepare':result=prepare(args.target)
    else:result=deploy(base64.b64decode(os.environ['AICC_POLICY_BUILDER']),base64.b64decode(os.environ['AICC_POLICY_FIXTURE']),args.target,args.action=='stage')
    print(json.dumps(result))
    if result['terminal'] in ('HOLD','ROLLED_BACK'):raise SystemExit(1)

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'terminal':'HOLD','reason':str(error) if isinstance(error,RuntimeError) else 'policy_operation_unconfirmed','accountStateChanged':False}));raise SystemExit(1)
