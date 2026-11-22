// Host-only bridge over an ALREADY authenticated original AppServer/IPC session.
// This module does not dial, spawn, listen, read a proof file, or authenticate an
// owner from JSON. Native must implement owner-held-dispatch/v1 before binding.
import {createHash} from 'node:crypto';
import {parseOriginalIssuerGrant, type OriginalIssuerGrant,
  type NativeOriginalIssuerAuthority, type NativeIssuerGuard} from './external-original-issuer-admission';

export const OWNER_DISPATCH_CONTRACT='owner-held-dispatch/v1' as const;
export type OwnerBridgeMethod='acquire'|'begin'|'finish';
export type OwnerBridgeRequest={contract:typeof OWNER_DISPATCH_CONTRACT;method:OwnerBridgeMethod;
  runtimeId:string;epoch:number;binding:string;grant?:Readonly<OriginalIssuerGrant>;
  ticket?:string;permit?:string;outcome?:'invoked'|'notSubmitted'|'unknown'};
export type OriginalOwnerSession={
  // Installed by the original host after OS peer/owner and experimental
  // capability negotiation on its existing connection, never by an HTTP body.
  contract:typeof OWNER_DISPATCH_CONTRACT;runtimeId:string;
  connected:()=>boolean;
  request:(request:Readonly<OwnerBridgeRequest>,signal:AbortSignal)=>Promise<unknown>;
  onInvalidated:(listener:(epoch?:number)=>void)=>(()=>void);
};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const opaque=/^[A-Za-z0-9_-]{32,256}$/;
const fail=(reason:string):never=>{throw Error('original_issuer_bridge_'+reason+'_no_retry');};

export function createNativeOriginalIssuerBridge(options:{timeoutMs?:number}={}) {
  const timeoutMs=options.timeoutMs??3000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)fail('invalid_timeout');
  const sessions=new Map<string,OriginalOwnerSession>();
  const burned=new Set<string>();
  const live=(session:OriginalOwnerSession)=>sessions.get(session.runtimeId)===session&&session.connected();
  const authority:NativeOriginalIssuerAuthority={
    supported:()=>[...sessions.values()].some(live),
    async acquire(input,signal):Promise<NativeIssuerGuard> {
      const grant=parseOriginalIssuerGrant(input),session=sessions.get(grant.runtimeId);
      if(!session||!live(session))fail('original_owner_not_connected');
      const owner=session!;
      const key=JSON.stringify([grant.runtimeId,grant.epoch]);
      if(burned.has(key))fail('epoch_consumed');
      if(burned.size>=4096)fail('capacity');
      burned.add(key); // including failed/ambiguous IPC; no reacquire or reconnect
      const canonical=Object.fromEntries(['runtimeId','epoch','goalId','threadId','originalTurnId',
        'originalRequestId','ownerRequestId','refusalSha256','attestationSha256','nextTurnId',
        'nextRequestId','continuationFingerprint','nativeProof'].map(k=>[k,grant[k as keyof OriginalIssuerGrant]]));
      const binding=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      let valid=true,closed=false,dispatched=false,ticket:string|undefined;
      const invalidated=()=>{valid=false;};
      const unsubscribe=owner.onInvalidated(epoch=>{if(epoch===undefined||epoch!==grant.epoch)invalidated();});
      signal.addEventListener('abort',invalidated,{once:true});
      const current=()=>valid&&!closed&&!signal.aborted&&live(owner);
      const base={contract:OWNER_DISPATCH_CONTRACT,runtimeId:grant.runtimeId,epoch:grant.epoch,binding};
      async function requestOnce(request:Readonly<OwnerBridgeRequest>,requestSignal:AbortSignal) {
        if(Buffer.byteLength(JSON.stringify(request),'utf8')>16384)fail('request_bounds');
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {
          return await Promise.race([owner.request(request,requestSignal),new Promise<never>((_,reject)=>{
            timer=setTimeout(()=>reject(Error('unconfirmed_owner_operation')),timeoutMs);
          })]);
        }finally{clearTimeout(timer);}
      }
      function validateResponse(r:any,method:OwnerBridgeMethod,extra:string) {
        const keys=['contract','method','runtimeId','epoch','binding','state',extra].sort().join(',');
        if(!r||Array.isArray(r)||Object.keys(r).sort().join(',')!==keys||
          Buffer.byteLength(JSON.stringify(r),'utf8')>16384||
          r.contract!==base.contract||r.runtimeId!==base.runtimeId||r.epoch!==base.epoch||
          r.binding!==binding||r.method!==method||r.state!==({acquire:'acquired',begin:'held',
            finish:'finished'} as const)[method])fail('unconfirmed_'+method);
        return r;
      }
      async function rpc(method:OwnerBridgeMethod,extra:Partial<OwnerBridgeRequest>={}) {
        // Each mutation is sent once. An error or malformed response poisons the
        // session grant. Transport timeouts must not retry nor unlock the owner.
        try {
          const r=await requestOnce(Object.freeze({...base,method,...extra}),signal);
          return validateResponse(r,method,method==='acquire'?'ticket':'permit');
        }catch {invalidated();return fail('unconfirmed_'+method);}
      }
      function close() {
        if(closed)return;closed=true;unsubscribe();signal.removeEventListener('abort',invalidated);
        // No implicit IPC release on abort/disconnect. In particular no finally
        // unlock for an ambiguous begin/finish. Native keeps an unsettled fence.
      }
      try {
        if(!current())fail('revoked');
        const acquired=await rpc('acquire',{grant});
        if(!opaque.test(acquired.ticket??''))fail('invalid_ticket');
        ticket=acquired.ticket;
        if(!current())fail('revoked');
      }catch(error){close();throw error;}
      return {
        isCurrent:current,close,
        async dispatchIfCurrent(invoke) {
          if(dispatched||!current())fail('revoked_or_consumed');
          dispatched=true;
          const held=await rpc('begin',{ticket});
          if(!opaque.test(held.permit??''))fail('invalid_permit');
          // Native retains the SAME owner fence across this await and through
          // finish. No TTL auto-unlock. Stop linearizes before begin (refusal)
          // or after invocation+finish. Loss is UNKNOWN, never NotSubmitted.
          let outcome:'invoked'|'notSubmitted'|'unknown'='notSubmitted';
          let failure:unknown;
          try {
            if(!current())fail('revoked');
            outcome='unknown'; // callback may have entered fetch before throwing
            invoke();outcome='invoked';
          }catch(error){failure=error;}
          // Use the same connection even if cancellation was requested. The
          // transport must allow settlement without a cancelled request signal.
          const finishSignal=new AbortController().signal;
          try {
            const result:any=await requestOnce(Object.freeze({...base,method:'finish',ticket,
              permit:held.permit,outcome}),finishSignal);
            validateResponse(result,'finish','outcome');
            if(result.outcome!==outcome)fail('unconfirmed_finish');
          }catch {invalidated();fail('unconfirmed_finish');}
          if(failure)throw failure;
          return outcome==='invoked';
        },
      };
    },
  };
  return {authority,
    // This is deliberately a function/capability, not a wire registration API.
    bindOriginalOwner(session:OriginalOwnerSession) {
      if(session.contract!==OWNER_DISPATCH_CONTRACT||!uuid.test(session.runtimeId)||
        !['connected','request','onInvalidated'].every(k=>typeof (session as any)[k]==='function')||!session.connected()||
        sessions.has(session.runtimeId))fail('host_connection_required');
      sessions.set(session.runtimeId,session);
      return ()=>{if(sessions.get(session.runtimeId)===session)sessions.delete(session.runtimeId);};
    },
  };
}
