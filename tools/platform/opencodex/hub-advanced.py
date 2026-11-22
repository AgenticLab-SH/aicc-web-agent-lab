"""Owner-approved OCX advanced settings via the official local management API."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

CONFIG = Path('/demo/owner/.opencodex-hub/config.json')
PACKAGE = Path('/demo/owner/.bun/install/global/node_modules/@bitkyc08/opencodex')
BUN = '/demo/owner/.local/opt/bun-1.4.0/bun-linux-aarch64/bun'

def call(method, endpoint, body=None):
    code = """import {apiJson} from './src/cli/account-api.ts';
const [method,path,body]=JSON.parse(process.env.AICC_ADVANCED_REQUEST);
const r=await apiJson({},'http://127.0.0.1:10100',method,path,method==='GET'?undefined:body);
console.log(JSON.stringify({status:r.status,body:r.json}));"""
    env = dict(os.environ, OPENCODEX_HOME=str(CONFIG.parent), CODEX_HOME=str(CONFIG.parent/'codex-runtime'),
               AICC_ADVANCED_REQUEST=json.dumps([method,endpoint,body]))
    result = subprocess.run([BUN,'-e',code],cwd=PACKAGE,env=env,capture_output=True,text=True,timeout=30)
    if result.returncode: raise RuntimeError('official_management_failed')
    payload=json.loads(result.stdout)
    if payload['status'] != 200:
        reason=payload.get('body',{}).get('error','')
        safe=''.join(c for c in str(reason) if c.isalnum() or c in ' /_:.-')[:180]
        raise RuntimeError('official_management_http_'+str(payload['status'])+' '+endpoint+' '+safe)
    return payload['body']

def projection(config):
    result = {key:config.get(key) for key in ('autoSwitchThreshold','accountPoolStrategy','codexAccountPickerEnabled',
      'codexMainAccountHardLock','codexMainAccountHardLockThresholds','ultraFastTier','codexAccountPriorityFailback')} | {
      'cacheAffinity':config.get('pool',{}).get('cacheAffinity'),
      'fiveHourActivationEnabled':sum(row.get('fiveHour') is True for row in config.get('codexQuotaAutoRefresh',{}).values()),
      'weeklyActivationEnabled':sum(row.get('weekly') is True for row in config.get('codexQuotaAutoRefresh',{}).values())}
    result['ultraFastTier'] = config.get('ultraFastTier') is True
    result['codexMainAccountHardLock'] = config.get('codexMainAccountHardLock') is not False
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=('status','apply'));args=parser.parse_args()
    config=json.loads(CONFIG.read_text());before=projection(config)
    if args.action=='status': print(json.dumps({'terminal':'PASS','settings':before}));return
    status=call('GET','/api/system/memory')
    if status.get('activeTurnCount') != 0 or status.get('isDraining') is not False:raise RuntimeError('hub_not_idle')
    backup=CONFIG.parent/'recovery'/('advanced-'+str(time.time_ns()));backup.mkdir(parents=True,mode=0o700)
    (backup/'config.before.json').write_bytes(CONFIG.read_bytes());(backup/'config.before.json').chmod(0o600)
    # Independent long-window watcher remains the single weekly activation owner.
    call('PUT','/api/settings',{'codexAccountPickerEnabled':False,'codexMainAccountHardLock':True,
      'codexMainAccountHardLockThresholds':{'short':90,'long':98},'ultraFastTier':False})
    call('PUT','/api/codex-auth/auto-switch',{'threshold':95})
    if config.get('pool',{}).get('cacheAffinity') is not False: raise RuntimeError('capacity_first_precondition_required')
    call('PUT','/api/pool/settings',{'provider':'openai','strategy':'reset-first','autoSwitchThreshold':95})
    feature_warning = None
    try: call('PUT','/api/codex-auth/features/default-mode-request-user-input',{'enabled':True})
    except RuntimeError as error: feature_warning = str(error)
    for row in config.get('codexAccounts',[]):
        for window,enabled in (('fiveHour',True),('weekly',False)):
            call('PUT','/api/settings',{'codexQuotaAutoRefresh':{'id':row['id'],'window':window,'enabled':enabled}})
    after=projection(json.loads(CONFIG.read_text()))
    expected={'autoSwitchThreshold':95,'accountPoolStrategy':'reset-first','codexAccountPickerEnabled':False,
      'codexMainAccountHardLock':True,'codexMainAccountHardLockThresholds':{'short':90,'long':98},'ultraFastTier':False,'cacheAffinity':False}
    if any(after.get(key)!=value for key,value in expected.items()):raise RuntimeError('advanced_readback_failed_do_not_retry')
    print(json.dumps({'terminal':'PASS','before':before,'after':after,'backup':str(backup),
      'weeklyActivationOwner':'existing AICC hub cycle watcher','poolSeparateWindowThresholds':'stock threshold is shared; verify effective window policy with aicc-ocx-policy -Action status',
      'featureWarning':feature_warning,'accountLoginChanged':False,'nativeConfigChanged':False}))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'terminal':'HOLD','reason':str(error) if isinstance(error,RuntimeError) else 'advanced_mutation_unconfirmed','automaticRetry':False}));raise SystemExit(1)
