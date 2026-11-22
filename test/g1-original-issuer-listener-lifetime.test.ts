import {expect,test} from 'bun:test';
import {existsSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeOriginalIssuerBridge} from '../tools/platform/opencodex/external-original-issuer-bridge';
import {startRegisteredOriginalIssuerListener} from '../tools/platform/opencodex/external-original-issuer-listener';

test('unsupported OS peer acceptor creates no socket or owner and preserves shared host',()=>{
 const socketPath=join(mkdtempSync(join(tmpdir(),'oi-lifetime-')),'issuer.sock');
 const host=createNativeOriginalIssuerBridge();
 expect(()=>startRegisteredOriginalIssuerListener(host,socketPath)).toThrow('original_issuer_os_peer_authority_required');
 expect(existsSync(socketPath)).toBe(false);
 expect(host.authority.supported()).toBe(false);
 // Exactly the existing external-runtime startup catch, not a fallback bind.
 let caught=false;
 try{startRegisteredOriginalIssuerListener(host,socketPath);}catch{caught=true;}
 expect(caught).toBe(true);
 expect(host.authority.supported()).toBe(false);
});
