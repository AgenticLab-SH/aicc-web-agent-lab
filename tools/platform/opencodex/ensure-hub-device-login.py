#!/usr/bin/env python3
"""Default the existing hub dashboard Codex login to its native device flow.
Static GUI only: no service restart, auth/config/token writes or new login.
Use --apply after --root attestation; default is read-only. Exact-byte CAS backup.
"""
import argparse, hashlib, json, os, re, tempfile
from pathlib import Path

OLD = 'v=m?.device===!0,S=()=>fetch(`${e}/api/codex-auth/login`'
NEW = 'v=m?.device!==!1,S=()=>fetch(`${e}/api/codex-auth/login`'

def transform(data):
    old, new = OLD.encode(), NEW.encode()
    if data.count(new) == 1 and data.count(old) == 0:
        return data, 'already-applied'
    if data.count(old) != 1 or new in data:
        raise ValueError('unsupported_gui_layout_no_change')
    return data.replace(old, new, 1), 'prepared'

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', required=True)
    ap.add_argument('--apply', action='store_true')
    args=ap.parse_args()
    root=Path(args.root).resolve(strict=True)
    assets=root/'gui/dist/assets'
    matches=[]
    for p in assets.glob('*.js'):
        data=p.read_bytes()
        if OLD.encode() in data or NEW.encode() in data: matches.append((p,data))
    if len(matches)!=1: raise ValueError('exact_gui_consumer_required')
    p,before=matches[0]
    if p.is_symlink(): raise ValueError('symlink_not_allowed')
    after,state=transform(before)
    sha=lambda b:hashlib.sha256(b).hexdigest()
    backup=None
    if args.apply and before!=after:
        backup=Path.home()/'.local/state/aicc-ocx-patches/backups/device-login'/sha(before)
        backup.mkdir(parents=True,exist_ok=True)
        saved=backup/p.name
        if saved.exists() and saved.read_bytes()!=before: raise ValueError('backup_conflict')
        if not saved.exists(): saved.write_bytes(before)
        if p.read_bytes()!=before: raise ValueError('gui_cas_conflict')
        fd,tmp=tempfile.mkstemp(prefix='.device-login-',dir=p.parent)
        try:
            with os.fdopen(fd,'wb') as f: f.write(after);f.flush();os.fsync(f.fileno())
            os.chmod(tmp,p.stat().st_mode & 0o777)
            os.replace(tmp,p)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
        state='applied'
    # The vendor asset is immutable-cached. Remap its module URL before the
    # entry script runs so existing browsers cannot reuse the browser-login code.
    html=root/'gui/dist/index.html'
    original=html.read_bytes()
    tag=('<script type="importmap" id="aicc-device-login">'+json.dumps({'imports':{
      '/assets/'+p.name:'/assets/'+p.name+'?aicc-device='+sha(after)[:16]}})+'</script>')
    page=original.decode('utf-8')
    if 'id="aicc-device-login"' in page:
        page=re.sub(r'<script type="importmap" id="aicc-device-login">.*?</script>',tag,page,count=1)
    else:
        anchor='<script type="module"'
        if page.count(anchor)!=1: raise ValueError('exact_html_entry_required')
        page=page.replace(anchor,tag+'\n    '+anchor,1)
    updated=page.encode('utf-8')
    if args.apply and updated!=original:
        state_dir=Path.home()/'.local/state/aicc-ocx-patches/backups/device-login'
        state_dir.mkdir(parents=True,exist_ok=True)
        saved=state_dir/('index.'+sha(original)+'.html')
        if not saved.exists(): saved.write_bytes(original)
        if html.read_bytes()!=original: raise ValueError('html_cas_conflict')
        fd,tmp=tempfile.mkstemp(prefix='.device-html-',dir=html.parent)
        try:
            with os.fdopen(fd,'wb') as f:f.write(updated);f.flush();os.fsync(f.fileno())
            os.chmod(tmp,html.stat().st_mode & 0o777);os.replace(tmp,html)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
    print(json.dumps({'cacheBypass':True,'htmlChanged':args.apply and updated!=original}))
    print(json.dumps(dict(status=state,changed=args.apply and before!=after,asset=p.name,
      beforeSha256=sha(before),afterSha256=sha(after),backup=str(backup) if backup else None,
      serviceRestarts=0,loginRequests=0,credentialWrites=0)))
if __name__=='__main__': main()