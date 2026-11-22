// Volatile selection-owner capability, separate from immutable quota evidence.
// This interface MUST be implemented by the original live native transport:
// acquire authenticates nativeProof against the live runtime (not a signature
// or epoch JSON), exact UsageLimited goal and original typed refusal, and the
// newly allocated continuation turn/request/fingerprint. Issuer is resolved by
// the selection owner, never by grant caller input. runIfCurrent (or the
// formally negotiated owner-held dispatch equivalent) holds that runtime's fence
// through the synchronous callback, ordered with input/stop/cancel/goal/route/
// runtime replacement. It must not queue the callback or await inside it.
// There is deliberately no HTTP/provider/JSON fallback implementation here.
import {randomBytes} from 'node:crypto';

export type OriginalIssuerGrant = {
  runtimeId:string; epoch:number; goalId:string; threadId:string;
  originalTurnId:string; originalRequestId:string;
  ownerRequestId:string; refusalSha256:string; attestationSha256:string;
  nextTurnId:string; nextRequestId:string; continuationFingerprint:string;
  nativeProof:string;
};
export type NativeIssuerGuard = {
  isCurrent:()=>boolean;
  runIfCurrent?:(callback:()=>void)=>boolean;
  // Equivalent cross-process owner-held gate. The owner MUST retain its
  // revocation lock until the physical invocation is acknowledged. A current
  // query, expiring lease or disconnect that silently releases it is invalid.
  dispatchIfCurrent?:(callback:()=>void)=>Promise<boolean>;
  close:()=>void;
};
export type NativeOriginalIssuerAuthority = {
  supported?:()=>boolean;
  acquire:(grant:Readonly<OriginalIssuerGrant>,signal:AbortSignal)=>Promise<NativeIssuerGuard>;
};
export const ORIGINAL_ISSUER_HEADERS = [
  'x-aicc-original-issuer-reservation','x-aicc-native-runtime-id',
  'x-aicc-native-epoch','x-aicc-native-goal-id','x-aicc-native-proof',
] as const;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha=/^[a-f0-9]{64}$/;
const correlation=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const opaque=/^[A-Za-z0-9_-]{32,256}$/;
const hold=(code:string):never=>{throw Error('original_issuer_'+code);};
export function parseOriginalIssuerGrant(value:any):Readonly<OriginalIssuerGrant> {
  const keys=['runtimeId','epoch','goalId','threadId','originalTurnId','originalRequestId',
    'ownerRequestId','refusalSha256','attestationSha256','nextTurnId','nextRequestId',
    'continuationFingerprint','nativeProof'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||
    keys.some(k=>!Object.hasOwn(value,k))||
    !['runtimeId','goalId','threadId','originalTurnId','ownerRequestId','nextTurnId'].every(k=>uuid.test(value[k]))||
    !['refusalSha256','attestationSha256','continuationFingerprint'].every(k=>sha.test(value[k]))||
    !Number.isSafeInteger(value.epoch)||value.epoch<0||
    !correlation.test(value.originalRequestId)||!correlation.test(value.nextRequestId)||
    value.originalRequestId===value.nextRequestId||value.originalTurnId===value.nextTurnId||
    !opaque.test(value.nativeProof))hold('exact_native_grant_required');
  return Object.freeze({...value});
}
export function hasOriginalIssuerHeaders(request:Request) {
  return ORIGINAL_ISSUER_HEADERS.some(h=>request.headers.has(h));
}
export function createOriginalIssuerAdmission(options:{authority?:NativeOriginalIssuerAuthority;now?:()=>number}) {
  const now=options.now??Date.now;
  type Row={grant:Readonly<OriginalIssuerGrant>;accountId:string;generation:number;
    guard:NativeIssuerGuard;expiresAt:number;claimed?:Request;spent:boolean;closed?:boolean;signal:AbortSignal};
  const rows=new Map<string,Row>(), requests=new WeakMap<Request,Row>();
  // One opportunity per native runtime epoch, even after not_sent,
  // timeout, expiry or UNKNOWN. Re-arming requires the owner to advance epoch.
  const used=new Set<string>();
  const key=(g:Readonly<OriginalIssuerGrant>)=>JSON.stringify([g.runtimeId,g.epoch]);
  function current(row:Row) {
    const time=now();
    if(row.spent||row.signal.aborted||!Number.isFinite(time)||time>=row.expiresAt||
      time<row.expiresAt-15000||!row.guard.isCurrent())hold('revoked_or_expired');
  }
  function retire(row:Row) {
    row.spent=true;if(row.closed)return;row.closed=true;
    try{row.guard.close();}catch{/* fail closed */}
  }
  return {
    supported:()=>!!options.authority && (options.authority.supported?.()??true),
    async reserve(input:Readonly<OriginalIssuerGrant>,resolve:()=>Promise<{accountId:string;generation:number}>,signal:AbortSignal) {
      const grant=parseOriginalIssuerGrant(input);
      if(!options.authority || options.authority.supported?.()===false)hold('native_dispatch_fence_unavailable');
      if(signal.aborted)hold('cancelled');
      for(const [token,row] of rows)if(row.spent||now()>=row.expiresAt){retire(row);rows.delete(token);}
      if(used.has(key(grant)))hold('already_reserved');
      if(used.size>=4096||rows.size>=256)hold('capacity');
      used.add(key(grant)); // burn before the first await, including failed acquisition
      const issuedAt=now(),expiresAt=issuedAt+15000;
      const guard=await options.authority!.acquire(grant,signal);
      const row:Row={grant,accountId:'',generation:-1,guard,expiresAt,spent:false,signal};
      try {
        current(row);
        const exact=await resolve();
        current(row);
        if(!exact.accountId||!Number.isSafeInteger(exact.generation)||exact.generation<0)hold('issuer_unverified');
        Object.assign(row,exact);
        const reservation=randomBytes(32).toString('base64url');rows.set(reservation,row);
        return {schemaVersion:1,kind:'aicc-original-issuer-reservation/v1',reservation,expiresAt,
          runtimeId:grant.runtimeId,epoch:grant.epoch,goalId:grant.goalId,threadId:grant.threadId,
          nextTurnId:grant.nextTurnId,nextRequestId:grant.nextRequestId,
          originalRequestReplayed:false,modelRequests:0,newTurns:0};
      }catch(error){retire(row);throw error;}
    },
    claim(request:Request,fingerprint:string) {
      if(!hasOriginalIssuerHeaders(request))return undefined;
      const token=request.headers.get(ORIGINAL_ISSUER_HEADERS[0])??'';
      const row=rows.get(token);
      if(!row||row.claimed)hold('reservation_unknown_or_used');
      // A failed attempt also consumes the capability; no retry on a new Request.
      row!.claimed=request;requests.set(request,row!);
      try {
        current(row!);const g=row!.grant,h=request.headers;
        const exact=(names:string[],expected:string)=>names.every(n=>!h.has(n)||h.get(n)===expected)&&names.some(n=>h.has(n));
        if(request.method!=='POST'||!/^\/(?:v1\/)?responses$/.test(new URL(request.url).pathname)||
          h.get('x-aicc-native-runtime-id')!==g.runtimeId||h.get('x-aicc-native-epoch')!==String(g.epoch)||
          h.get('x-aicc-native-goal-id')!==g.goalId||h.get('x-aicc-native-proof')!==g.nativeProof||
          !exact(['thread-id','session_id','session-id'],g.threadId)||
          !exact(['x-codex-turn-id','turn-id'],g.nextTurnId)||
          !exact(['x-request-id','x-codex-request-id','x-client-request-id'],g.nextRequestId)||
          fingerprint!==g.continuationFingerprint)hold('continuation_identity_mismatch');
        return {accountId:row!.accountId,generation:row!.generation};
      }catch(error){retire(row!);throw error;}
    },
    assertCurrent(request:Request) {const row=requests.get(request);if(row)current(row);},
    hasClaim:(request:Request)=>requests.has(request),
    async dispatch(request:Request,send:()=>Promise<Response>,check:()=>void):Promise<Response> {
      const row=requests.get(request);if(!row)hold('claim_required');
      current(row!);let pending:Promise<Response>|undefined,called=false;
      try {
        const invoke=()=>{
          if(called)hold('dispatch_once');called=true;
          current(row!);check();row!.spent=true;
          pending=send(); // physical fetch invocation, not supplier async handoff
          // A cross-process finish ACK may still be in flight when the network
          // rejects. Observe now; propagate the original rejection on return.
          void pending.catch(()=>{});
        };
        const accepted=row!.guard.dispatchIfCurrent
          ? await row!.guard.dispatchIfCurrent(invoke)
          : row!.guard.runIfCurrent?.(invoke);
        if(accepted!==true||!called||!pending)hold('native_dispatch_fence_refused');
        return pending!;
      }finally{retire(row!);}
    },
    settle(request:Request) {const row=requests.get(request);if(row){retire(row);requests.delete(request);}},
  };
}
