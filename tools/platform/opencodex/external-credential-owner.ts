// Volatile A1 access leases. The caller supplies the existing registered broker
// transport; this module creates no SSH profile, credential store or model route.
import { createHash } from 'node:crypto';
export type BrokerTransport = { request: (data: object) => Promise<any> };
export function createExternalCredentialOwner(transport: BrokerTransport) {
  let snapshot: any;
  let snapshotAt = 0;
  let snapshotFlight: Promise<any> | undefined;
  const leases = new Map<string,{at:number;value:any}>();
  const flights = new Map<string,{recovering:boolean;promise:Promise<any>}>();
  async function refreshSnapshot(force = false) {
    if (!force && snapshot && Date.now()-snapshotAt < 30_000) return snapshot;
    if (snapshotFlight) return snapshotFlight;
    snapshotFlight=(async()=>{
      const value=await transport.request({action:'snapshot'});
      if (value?.ok !== true || !value.config || !value.records || value.settings?.schemaVersion !== 1) throw Error('credential_owner_snapshot_unverified');
      const accounts=value.config.codexAccounts;
      if (!Array.isArray(accounts) || accounts.some((a:any)=>a.isMain || a.id==='__main__')) throw Error('native_identity_outside_pool');
      for(const [id,row] of Object.entries(value.records) as [string,any][]) {
        if(!accounts.some((a:any)=>a.id===id) || !Number.isInteger(row.generation)
          || row.credential?.refreshToken || row.credential?.accessToken) throw Error('credential_owner_snapshot_contract');
      }
      snapshot=value; snapshotAt=Date.now();
      for(const [id,lease] of leases) {
        if(!value.records[id] || value.records[id].generation!==lease.value.generation) leases.delete(id);
      }
      return snapshot;
    })().finally(()=>{snapshotFlight=undefined;});
    return snapshotFlight;
  }
  function awaitSignal<T>(flight:Promise<T>,signal?:AbortSignal):Promise<T> {
    if(!signal) return flight;
    if(signal.aborted) return Promise.reject(Error('request_cancelled'));
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(Error('request_cancelled'));
      signal.addEventListener('abort',abort,{once:true});
      flight.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},()=>{signal.removeEventListener('abort',abort);reject(Error('credential_owner_unavailable'));});
      if(signal.aborted) abort();
    });
  }
  async function lease(id:string,options:{signal?:AbortSignal;rejectedGeneration?:number;rejectedAccessToken?:string}={}):Promise<any> {
    if(options.signal?.aborted) throw Error('request_cancelled');
    if(!snapshot?.records?.[id] || id==='__main__') throw Error('unknown_pool_account');
    const cached=leases.get(id);
    const recovering=options.rejectedAccessToken!==undefined;
    if(!recovering && cached && cached.value.generation===snapshot.records[id].generation
      && Date.now()-cached.at<60_000 && cached.value.expiresAt-Date.now()>60_000) return cached.value;
    const pending=flights.get(id);
    if(recovering && pending && !pending.recovering) {
      const current=await awaitSignal(pending.promise,options.signal);
      if(current.generation!==options.rejectedGeneration || current.accessToken!==options.rejectedAccessToken) return current;
      return lease(id,options);
    }
    let flight=pending?.promise;
    if(!flight) {
      if(recovering && !Number.isInteger(options.rejectedGeneration)) throw Error('rejected_generation_required');
      const request=recovering ? {action:'recover',id,generation:options.rejectedGeneration,
        rejectedHash:createHash('sha256').update(options.rejectedAccessToken!).digest('hex')} : {action:'lease',id};
      flight=transport.request(request).then(value=>{
        if(value?.ok!==true || value.refreshToken || !value.accessToken || !value.chatgptAccountId
          || !Number.isInteger(value.generation) || !Number.isFinite(value.expiresAt)
          || value.expiresAt-Date.now()<=60_000 || !snapshot.records[id]) throw Error('credential_owner_lease_contract');
        const result={accountId:id,accessToken:value.accessToken,chatgptAccountId:value.chatgptAccountId,
          generation:value.generation,expiresAt:value.expiresAt};
        snapshot.records[id].generation=value.generation;
        leases.set(id,{at:Date.now(),value:result});
        return result;
      }).finally(()=>{if(flights.get(id)?.promise===flight) flights.delete(id);});
      flights.set(id,{recovering,promise:flight});
    }
    return awaitSignal(flight,options.signal);
  }
  return {refreshSnapshot,lease,
    generationLive:(id:string,generation:number)=>snapshot?.records?.[id]?.generation===generation,
    // Metadata is for the trusted local adapter only, never a public status body.
    currentSnapshot:()=>snapshot,
    clearVolatileLeases:()=>leases.clear()};
}
