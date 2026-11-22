import {expect,test} from 'bun:test';
import {connect} from 'node:net';
import {once} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startRegisteredOriginalIssuerListener} from '../tools/platform/opencodex/external-original-issuer-listener';

// A syntactically valid ready frame is NOT proof of an OS-authenticated peer.
test('an unverified native-ready frame cannot publish original issuer support',async()=>{
 const socketPath=join(mkdtempSync(join(tmpdir(),'oi-auth-')),'issuer.sock');
 let binds=0;
 let listener;
 try{listener=startRegisteredOriginalIssuerListener({bindOriginalOwner(){binds++;return()=>{};}},socketPath);}
 catch(error){expect(String(error)).toContain('original_issuer_os_peer_authority_required');return;}
 const client=connect(socketPath);client.on('error',()=>{});
 try{
  await once(client,'connect');
  const body=Buffer.from(JSON.stringify({kind:'original-issuer-ready/v1',contract:'owner-held-dispatch/v1',runtimeId:'11111111-1111-4111-8111-111111111111'}));
  const header=Buffer.alloc(4);header.writeUInt32BE(body.length);
  client.write(Buffer.concat([header,body]));
  await new Promise(resolve=>setTimeout(resolve,80));
  expect(binds).toBe(0);
 }finally{client.destroy();listener.stop(true);}
});
