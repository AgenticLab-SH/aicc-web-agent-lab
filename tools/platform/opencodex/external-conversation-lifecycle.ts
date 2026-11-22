// Active-request exclusion plus unresolved-attempt evidence. No credentials or request bodies.
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExternalSafeFault } from './external-safe-fault';
// completed: model terminal success. failed: model terminal failure after delivery
// (response.failed/incomplete/error). rejected: complete upstream 4xx answer; no
// output exists. abandoned: the client aborted while zero response body bytes had been
// delivered to it (G1-23); no issuer binding. Unknown is retained as evidence, never
// a veto on the next caller request. This module never dispatches or replays requests.
export type RequestSettlement = 'not_sent' | 'completed' | 'failed' | 'rejected' | 'abandoned' | 'unknown';
type Entry = { key:string; operationId:string; accountId:string; at:number; state:'reserved'|'dispatching'|'unknown'; requestFingerprint?:string };
export function createConversationFence(home:string) {
  const path=join(home,'external-request-lifecycle.json');
  const historyPath=join(home,'external-request-history.jsonl');
  const entries=new Map<string,Entry>();
  const retiredRequests=new Map<string,Set<string>>();
  const requests=new WeakMap<Request,Entry>();
  let archivedUnknownCount=0;
  try {
    const saved=JSON.parse(readFileSync(path,'utf8'));
    if(saved.schemaVersion!==1 || !Array.isArray(saved.rows) || saved.rows.length>10_000) throw Error('invalid');
    if(saved.archivedUnknownCount!==undefined && (!Number.isSafeInteger(saved.archivedUnknownCount) || saved.archivedUnknownCount<0)) throw Error('invalid');
    archivedUnknownCount=saved.archivedUnknownCount??0;
    if(saved.retiredRequests!==undefined && !Array.isArray(saved.retiredRequests)) throw Error('invalid');
    for(const row of saved.retiredRequests??[]) {
      if(!/^[a-f0-9]{32}$/.test(row.key) || !/^[a-f0-9]{64}$/.test(row.fingerprint)) throw Error('invalid');
      const fingerprints=retiredRequests.get(row.key)??new Set<string>();
      fingerprints.add(row.fingerprint);retiredRequests.set(row.key,fingerprints);
    }
    for(const row of saved.rows) {
      if(!/^[a-f0-9]{32}$/.test(row.key) || entries.has(row.key) || typeof row.accountId!=='string'
        || typeof row.operationId!=='string' || !Number.isFinite(row.at)
        || !['reserved','dispatching','unknown'].includes(row.state)
        || (row.requestFingerprint!==undefined && !/^[a-f0-9]{64}$/.test(row.requestFingerprint))) throw Error('invalid');
      // A restart leaves an unresolved attempt, not a permanently unusable conversation.
      entries.set(row.key,{...row,state:'unknown'});
    }
  } catch(error:any) {if(error.code!=='ENOENT') throw Error('conversation_lifecycle_invalid_preserve_existing');}
  function persist() {
    const temp=path+'.'+crypto.randomUUID()+'.tmp';
    const retired=[...retiredRequests].flatMap(([key,fingerprints])=>[...fingerprints].map(fingerprint=>({key,fingerprint})));
    writeFileSync(temp,JSON.stringify({schemaVersion:1,archivedUnknownCount,retiredRequests:retired,rows:[...entries.values()]})+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
    renameSync(temp,path);
  }
  function assertIdle(key:string,requestFingerprint?:string) {
    const entry=entries.get(key);
    if(entry && entry.state!=='unknown') throw new ExternalSafeFault('conversation_request_active');
    if(requestFingerprint && retiredRequests.get(key)?.has(requestFingerprint)) throw new ExternalSafeFault('request_outcome_unknown');
    if(entry?.state==='unknown' && requestFingerprint && entry.requestFingerprint===requestFingerprint) throw new ExternalSafeFault('request_outcome_unknown');
  }
  function archiveUnknown(entry:Entry) {
    appendFileSync(historyPath,JSON.stringify({schemaVersion:1,kind:'unresolved-attempt',...entry,
      archivedAt:Date.now(),originalRequestReplayed:false})+'\n',{encoding:'utf8',mode:0o600});
    archivedUnknownCount++;
    if(entry.requestFingerprint) {
      const fingerprints=retiredRequests.get(entry.key)??new Set<string>();
      fingerprints.add(entry.requestFingerprint);retiredRequests.set(entry.key,fingerprints);
    }
    entries.delete(entry.key);
  }
  return {
    assertIdle,
    unresolved(key:string) {const entry=entries.get(key);return entry?.state==='unknown'?{...entry}:undefined;},
    reserve(request:Request,key:string,accountId:string,requestFingerprint?:string) {
      assertIdle(key,requestFingerprint);
      // Preserve the old operation as evidence. This is a new caller request, never a replay.
      const previous=entries.get(key);
      if(previous) archiveUnknown(previous);
      // Historical failures must not exhaust admission capacity for unrelated conversations.
      if(entries.size>=10_000) for(const entry of entries.values()) if(entry.state==='unknown') archiveUnknown(entry);
      if(entries.size>=10_000) throw new ExternalSafeFault('conversation_binding_capacity');
      const entry:Entry={key,accountId,operationId:crypto.randomUUID(),at:Date.now(),state:'reserved',...(requestFingerprint?{requestFingerprint}:{})};
      entries.set(key,entry); // Failed persistence leaves a conservative in-process fence.
      persist(); requests.set(request,entry);
    },
    beforeDispatch(request:Request) {
      const entry=requests.get(request); if(!entry) return;
      entry.state='dispatching'; persist();
    },
    settle(request:Request,outcome:RequestSettlement,commit:()=>void) {
      const entry=requests.get(request); if(!entry) return;
      if(entries.get(entry.key)?.operationId!==entry.operationId) {requests.delete(request);return;}
      if(outcome==='unknown') {entry.state='unknown';persist();requests.delete(request);return;}
      try {
        // A failed terminal was delivered to this account; bind its issuer like a
        // completion so later account changes still scrub its ciphertext.
        if(outcome==='completed' || outcome==='failed') commit();
        entries.delete(entry.key); persist(); requests.delete(request);
      } catch(error) {entry.state='unknown';entries.set(entry.key,entry);throw error;}
    },
    unknownCount:()=>archivedUnknownCount+[...entries.values()].filter(row=>row.state==='unknown').length,
    // G1-07: only reserved/dispatching rows are live work a restart could turn into
    // a new UNKNOWN. Settled UNKNOWN rows are durable, reload unchanged and stay
    // recorded against their own conversation; they do not block later instructions or maintenance.
    inflightCount:()=>[...entries.values()].filter(row=>row.state!=='unknown').length,
  };
}

// Inspect only bounded terminal records while forwarding unchanged bytes.
// EOF, HTTP 200 and [DONE] alone never establish model completion.
export function createCompletionObservation(contentType:string,compact:boolean) {
  const sse=contentType.includes('text/event-stream');
  const decoder=new TextDecoder();
  let buffer='',oversized=false,terminal=false,failed=false;
  const limit=2*1024*1024;
  function accept(text:string) {
    try {
      const value=JSON.parse(text);
      if(sse) {
        if(value.type==='error' || value.type==='response.failed' || value.type==='response.incomplete') failed=true;
        if(value.type==='response.completed' && value.response?.status==='completed') terminal=true;
      } else {
        terminal=value.status==='completed' || (compact && value.object==='response.compaction' && Array.isArray(value.output));
      }
    } catch { /* Not a completion receipt. */ }
  }
  function drain() {
    let end:number;
    while((end=buffer.indexOf('\n\n'))>=0) {
      const event=buffer.slice(0,end);buffer=buffer.slice(end+2);
      const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(data) accept(data);
    }
  }
  return {
    push(bytes:Uint8Array) {
      if(oversized) return;
      buffer+=decoder.decode(bytes,{stream:true}).replace(/\r/g,'');
      if(sse) drain();
      if(buffer.length>limit) {oversized=true;buffer='';}
    },
    // A complete SSE terminal event is evidence even if the transport stays open.
    completed() { return sse && terminal && !failed && !oversized; },
    // A complete SSE terminal failure event is also a known outcome.
    failed() { return sse && failed && !oversized; },
    complete() {
      if(oversized) return false;
      buffer+=decoder.decode().replace(/\r/g,'');
      if(sse) drain();else accept(buffer);
      return terminal && !failed;
    },
  };
}
