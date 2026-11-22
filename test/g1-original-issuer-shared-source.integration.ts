// One isolated real Bun/Native handshake. No installed service, model, token,
// synthetic native ready, repeated request or per-conversation OCX launcher.
import {randomUUID} from 'node:crypto';
import {createNativeOriginalIssuerBridge} from '../tools/platform/opencodex/external-original-issuer-bridge';
import {startRegisteredOriginalIssuerListener} from '../tools/platform/opencodex/external-original-issuer-listener';

const [socketPath, runtimeId] = process.argv.slice(2);
if(!socketPath || !/^[a-f0-9-]{36}$/i.test(runtimeId ?? '')) throw Error('isolated_native_runtime_required');
const bridge = createNativeOriginalIssuerBridge({timeoutMs:3000});
const listener = startRegisteredOriginalIssuerListener(bridge, socketPath);
let done = false;
const deadline = setTimeout(() => {
  if(!done) { console.error('NO_NATIVE_BOUND_PEER'); process.exit(2); }
},15000);
console.log('SOCKET_LISTENING');
const gate = setInterval(async () => {
  if(done || !bridge.authority.supported()) return;
  done = true;
  clearInterval(gate);
  const grant = {
    runtimeId, epoch:1,goalId:randomUUID(),threadId:randomUUID(),
    originalTurnId:randomUUID(),originalRequestId:randomUUID(),
    ownerRequestId:randomUUID(),refusalSha256:'a'.repeat(64),
    attestationSha256:'b'.repeat(64),nextTurnId:randomUUID(),
    nextRequestId:randomUUID(),continuationFingerprint:'c'.repeat(64),
    nativeProof:'n'.repeat(43),
  };
  try {
    await bridge.authority.acquire(grant,new AbortController().signal);
    console.error('UNAUTHORIZED_ISSUER_ACQUIRED');
    process.exit(2);
  } catch(error) {
    if(!String(error).includes('unconfirmed_acquire_no_retry')) {
      console.error('UNEXPECTED_NATIVE_REFUSAL:' + String(error));
      process.exit(2);
    }
    if(bridge.authority.supported()) {
      console.error('NATIVE_RETIRED_BUT_CARRIER_STILL_SUPPORTED');
      process.exit(2);
    }
    clearTimeout(deadline);
    console.log('NATIVE_REFUSED_SHARED_ALIVE');
    // Keep the real listener alive: the Rust owner must prove exact source
    // conversation release does not terminate the shared Bun lifetime.
  }
},25);
process.on('SIGTERM',()=>{clearInterval(gate);clearTimeout(deadline);listener.stop(true);});
