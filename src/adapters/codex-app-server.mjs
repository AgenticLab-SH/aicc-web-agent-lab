import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024 * 1024;

export class AppServerError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

const OWNER_SHA=/^[a-f0-9]{64}$/;
function originalSenderContext(context,threadId){
  if(context?.kind!=='aicc-original-cli-owner-context/v1' ||
    context.threadId!==threadId || !path.isAbsolute(context.projectRoot??'') ||
    !OWNER_SHA.test(context.goalSnapshotSha256??'') ||
    !OWNER_SHA.test(context.ownerRevision??'') ||
    !OWNER_SHA.test(context.issuerReceiptSha256??'') ||
    !Number.isSafeInteger(context.stopEpoch) || context.stopEpoch<0 ||
    context.route!=='official-codex-to-17841-to-nonweb-OCX10101' ||
    !['codex','codex_other'].includes(context.quotaLimitId))
    throw new AppServerError('original_sender_context_unverified','exact original owner identity inputs required');
  const allowed=['kind','threadId','projectRoot','goalSnapshotSha256','ownerRevision',
    'stopEpoch','issuerReceiptSha256','route','quotaLimitId'];
  if(Object.keys(context).some(k=>!allowed.includes(k)))
    throw new AppServerError('original_sender_context_extra_fields','unreviewed owner context fields');
  return JSON.parse(JSON.stringify(context));
}
function ownedFiveHourWindow(snapshot,limitId){
  const buckets=snapshot?.rateLimitsByLimitId;
  const bucket=buckets&&typeof buckets==='object'&&!Array.isArray(buckets)
    ?buckets[limitId]:snapshot?.rateLimits;
  if(!bucket || bucket.limitId!==limitId)
    throw new AppServerError('original_quota_bucket_unproven','exact metered account quota missing');
  const windows=['primary','secondary'].filter(k=>bucket[k]?.windowDurationMins===300);
  if(windows.length!==1)
    throw new AppServerError('original_quota_window_ambiguous','one exact five-hour window required');
  const q=bucket[windows[0]];
  if(!Number.isFinite(q.usedPercent)||q.usedPercent<0||q.usedPercent>100||
    !Number.isSafeInteger(q.resetsAt)||q.resetsAt<=0)
    throw new AppServerError('original_quota_window_invalid','invalid five-hour quota window');
  if(typeof snapshot.accountId!=='string'||!snapshot.accountId.trim())
    throw new AppServerError('original_quota_account_unproven','backend account identity missing');
  return {limitId,window:windows[0],usedPercent:q.usedPercent,resetsAt:q.resetsAt,
    rateLimitReachedType:bucket.rateLimitReachedType??null,
    spendControlReached:bucket.spendControlReached??null,
    ordinaryUsageAllowed:snapshot.ordinaryUsageAllowed,
    accountIdSha256:createHash('sha256').update(snapshot.accountId).digest('hex')};
}

// A real owner can call this on its *already connected* App Server. The
// receipt is source evidence only: a separate App Server cannot prove TUI/OCX
// identity or create a transferable sender capability.
function ownerPrivateQuotaPath(file) {
  if(typeof file!=='string'||!path.isAbsolute(file)||!file.endsWith('.json'))
    throw new AppServerError('quota_receipt_path_required','absolute owner-private .json output required');
  const full=path.resolve(file),parent=path.dirname(full);
  const compare=value=>process.platform==='win32'?value.toLowerCase():value;
  if(compare(fs.realpathSync(parent))!==compare(parent)||!fs.statSync(parent).isDirectory())
    throw new AppServerError('quota_receipt_parent_alias','owner receipt parent must exist without aliases');
  for(let current=parent;;current=path.dirname(current)){
    if(fs.lstatSync(current).isSymbolicLink())
      throw new AppServerError('quota_receipt_path_alias','linked owner receipt path refused');
    if(current===path.dirname(current))break;
  }
  return full;
}
function sealOwnedSourceQuotaReceipt(file,receipt) {
  if(!['aicc-app-server-owned-five-hour-failure/v1',
        'aicc-app-server-owned-five-hour-admission/v1'].includes(receipt?.kind)||
     receipt.originalOcxIssuerVerified!==false||receipt.dispatchable!==false||
     receipt.modelRequests!==0||receipt.newTurns!==0)
    throw new AppServerError('quota_receipt_not_source_only','non-authoritative owned receipt required');
  const output=ownerPrivateQuotaPath(file),bytes=Buffer.from(JSON.stringify(receipt),'utf8');
  if(!bytes.length||bytes.length>65536)
    throw new AppServerError('quota_receipt_size_invalid','bounded quota receipt required');
  const stream=fs.openSync(output,'wx',0o600);
  try{fs.writeSync(stream,bytes);fs.fsyncSync(stream);}finally{fs.closeSync(stream);}
  return {status:'OWNED_APP_SERVER_SOURCE_SEALED_NOT_ORIGINAL_ISSUER',
    outputFile:output,outputSha256:createHash('sha256').update(bytes).digest('hex'),
    originalOcxIssuerVerified:false,dispatchable:false,modelRequests:0,newTurns:0};
}
function loadPinnedOwnedQuotaFailure(file,sha256) {
  if(!OWNER_SHA.test(sha256??''))
    throw new AppServerError('quota_failure_file_pin_required','exact failure receipt SHA required');
  const full=ownerPrivateQuotaPath(file),stat=fs.lstatSync(full);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>65536)
    throw new AppServerError('quota_failure_file_untrusted','bounded original file required');
  const bytes=fs.readFileSync(full);
  if(createHash('sha256').update(bytes).digest('hex')!==sha256)
    throw new AppServerError('quota_failure_sha_changed','sealed failure receipt changed');
  let failure;
  try{failure=JSON.parse(bytes.toString('utf8'));}
  catch{throw new AppServerError('quota_failure_file_invalid','sealed failure receipt is not JSON');}
  if(failure?.kind!=='aicc-app-server-owned-five-hour-failure/v1'||
     JSON.stringify(failure)!==bytes.toString('utf8')||
     failure.originalOcxIssuerVerified!==false||failure.dispatchable!==false)
    throw new AppServerError('quota_failure_file_untrusted','canonical owned failure required');
  return failure;
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    executable = 'codex',
    args = ['app-server', '--listen', 'stdio://'],
    cwd,
    env = process.env,
    manifest,
    spawnProcess = spawn,
    timeoutMs = 30_000,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    now = () => new Date().toISOString()
  } = {}) {
    super();
    this.executable = executable; this.args = args; this.cwd = cwd; this.env = env; this.manifest = manifest;
    this.spawnProcess = spawnProcess; this.timeoutMs = timeoutMs; this.nextId = 1; this.pending = new Map(); this.terminalTurns = new Set(); this.completedTurns = new Map(); this.process = null; this.disconnectEmitted = false;
    this.maxFrameBytes = maxFrameBytes; this.now = now; this.frameParts = []; this.frameBytes = 0;
    this.frameHash = createHash('sha256'); this.frameSequence = 0; this.protocolFailed = false;
    this.startedTurns=new Map(); this.ambiguousStartedTurns=new Set();
    this.eventOrdinal = 0; this.writerIdentity = null; this.processExit = null; this.stdoutEnd = null; this.stderrEnd = null; this.processClose = null;
    this.stderrBytes = 0; this.stderrHash = createHash('sha256');
  }

  assertCompatible() {
    if (!this.manifest?.codexVersion || !Array.isArray(this.manifest.productionStableAllowlist)) throw new AppServerError('schema_manifest_invalid', 'installed schema manifest is required');
    const binaryVersion = this.env.AICC_CODEX_VERSION;
    if (binaryVersion && binaryVersion !== this.manifest.codexVersion) throw new AppServerError('schema_version_mismatch', `expected ${this.manifest.codexVersion}, observed ${binaryVersion}`);
  }

  async connect() {
    this.assertCompatible();
    this.disconnectEmitted = false;
    this.protocolFailed = false;
    this.frameParts = [];
    this.frameBytes = 0;
    this.frameHash = createHash('sha256');
    this.frameSequence = 0;
    this.eventOrdinal = 0;
    this.startedTurns.clear(); this.ambiguousStartedTurns.clear();
    this.processExit = null;
    this.stdoutEnd = null;
    this.stderrEnd = null;
    this.processClose = null;
    this.stderrBytes = 0;
    this.stderrHash = createHash('sha256');
    this.process = this.spawnProcess(this.executable, this.args, { cwd: this.cwd, env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const startedAt = this.now();
    const childPid = Number.isInteger(this.process.pid) ? this.process.pid : null;
    this.writerIdentity = {
      childPid,
      parentPid: process.pid,
      childStartedAt: startedAt,
      processStartIdentityHash: createHash('sha256')
        .update(JSON.stringify({ childPid, parentPid: process.pid, startedAt, executable: this.executable, args: this.args }))
        .digest('hex')
    };
    this.process.stdout.on('data', chunk => this.#consumeStdout(chunk));
    this.process.stdout.once('end', () => {
      this.stdoutEnd = { at: this.now(), order: ++this.eventOrdinal };
    });
    this.process.stderr.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.stderrBytes += bytes.length;
      this.stderrHash.update(bytes);
    });
    this.process.stderr.once('end', () => {
      this.stderrEnd = { at: this.now(), order: ++this.eventOrdinal };
    });
    this.process.once('exit', (code, signal) => {
      this.processExit = { code, signal, at: this.now(), order: ++this.eventOrdinal };
    });
    this.process.once('close', (code, signal) => {
      this.processClose = { code, signal, at: this.now(), order: ++this.eventOrdinal };
      const framingError = this.#finalizeStdout();
      if (!framingError) this.#disconnect(new AppServerError('disconnected', `app-server closed code=${code} signal=${signal}`));
    });
    this.process.once('error', error => {
      this.#disconnect(new AppServerError('spawn_failed', 'app-server process failed before a clean transport terminal', {
        errorName: error?.name ?? 'Error',
        errorCode: error?.code ?? null,
        rawPayloadIncluded: false,
        writer: this.#writerMetadata()
      }));
    });
    // Queue reads are experimental in the installed protocol. Opt in only
    // through a separately pinned read-only schema, never for all clients.
    const queueRead=this.manifest?.originalQueueInspection;
    const experimentalApi=queueRead?.method==='thread/queue/list'&&queueRead.readOnly===true&&
      queueRead.senderAllowed===false&&OWNER_SHA.test(queueRead.paramsSchemaSha256??'')&&
      OWNER_SHA.test(queueRead.responseSchemaSha256??'')&&
      this.manifest.productionStableAllowlist.includes('thread/queue/list');
    const initialized = await this.#rawRequest('initialize', { clientInfo: { name: 'aicc', title: 'open-AICC', version: '0.1.0' }, capabilities: { experimentalApi } });
    this.#send({ method: 'initialized', params: {} });
    return { userAgent: initialized.userAgent ?? null, platformFamily: initialized.platformFamily ?? null, platformOs: initialized.platformOs ?? null };
  }

  request(method, params = {}) {
    if (!this.manifest.productionStableAllowlist.includes(method)) throw new AppServerError('method_not_allowlisted', `production method not allowlisted: ${method}`);
    return this.#rawRequest(method, params);
  }

  modelList(params = {}) { return this.request('model/list', params); }
  providerCapabilities(params = {}) { return this.request('modelProvider/capabilities/read', params); }
  skillsList(params = {}) { return this.request('skills/list', params); }
  hooksList(params = {}) { return this.request('hooks/list', params); }
  appsInstalled(params = {}) { return this.request('app/installed', params); }
  threadList(params = {}) { return this.request('thread/list', params); }
  threadRead(params) { return this.request('thread/read', params); }
  threadQueueListForInspection(params) {
    const proof=this.manifest?.originalQueueInspection;
    if(proof?.method!=='thread/queue/list'||proof.readOnly!==true||proof.senderAllowed!==false||
      !OWNER_SHA.test(proof.paramsSchemaSha256??'')||!OWNER_SHA.test(proof.responseSchemaSha256??'')||
      !this.manifest.productionStableAllowlist.includes('thread/queue/list')||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(params?.threadId??'')||
      Object.keys(params).some(k=>!['threadId','limit','cursor'].includes(k))||
      (params.limit!=null&&(!Number.isInteger(params.limit)||params.limit<1||params.limit>100))||
      (params.cursor!=null&&(typeof params.cursor!=='string'||!params.cursor||params.cursor.length>8192)))
      throw new AppServerError('original_queue_read_contract_required','pinned exact read-only queue contract required');
    return this.request('thread/queue/list',params);
  }
  // Exact-thread read only. This response is not a trusted parent revision/stop epoch.
  threadGoalGet(params) { return this.request('thread/goal/get', params); }
  // Read-only, same connected App Server account. This is NOT the original CLI/OCX
  // sender's quota, lease, claim, callback or authority to resume a turn.
  rateLimitsReadForInspection() {
    const proof=this.manifest?.officialQuotaRead;
    if(proof?.method!=='account/rateLimits/read' || proof.readOnly!==true ||
      proof.originalCliIssuerBound!==false || proof.quotaRecoveryAuthority!==false ||
      proof.senderAllowed!==false ||
      !/^[a-f0-9]{64}$/.test(proof.generatedClientRequestSha256??'') ||
      !this.manifest.productionStableAllowlist?.includes('account/rateLimits/read'))
      throw new AppServerError('quota_read_contract_required',
        'pinned installed read-only rate limits contract required');
    return this.request('account/rateLimits/read', {});
  }
  // Called only inside the already connected ORIGINAL sender process. A separate
  // observer's App Server account is not an OCX issuer or a transferable writer.
  async captureOwnedFiveHourFailure({threadId,turnId,ownerContext}={}){
    const context=originalSenderContext(ownerContext,threadId);
    const started=this.startedTurns.get(turnId);
    const terminal=this.completedTurns.get(turnId);
    if(!this.process || this.disconnectEmitted || !this.writerIdentity?.processStartIdentityHash ||
      this.ambiguousStartedTurns.has(turnId) || started?.threadId!==threadId ||
      terminal?.threadId!==threadId || terminal?.turn?.id!==turnId ||
      terminal?.turn?.status!=='failed' ||
      terminal?.turn?.error?.codexErrorInfo!=='usageLimitExceeded')
      throw new AppServerError('original_failed_turn_unproven','exact same-transport typed failed turn required');
    const observedAt=this.now(),time=Date.parse(observedAt);
    if(!Number.isFinite(time))throw new AppServerError('original_time_invalid','invalid failure time');
    const raw=await this.rateLimitsReadForInspection();
    const quota=ownedFiveHourWindow(raw,context.quotaLimitId);
    if(quota.usedPercent<100 || quota.rateLimitReachedType!=='rate_limit_reached' ||
      quota.ordinaryUsageAllowed!==false || quota.resetsAt*1000<=time ||
      quota.resetsAt*1000>time+6*3600000)
      throw new AppServerError('original_five_hour_failure_not_proven',
        'typed failure and exact reached five-hour backend quota required');
    return {schemaVersion:1,kind:'aicc-app-server-owned-five-hour-failure/v1',
      source:'owned-original-sender-connected-app-server',ownerContext:context,
      ownerContextSha256:createHash('sha256').update(JSON.stringify(context)).digest('hex'),
      threadId,failedTurnId:turnId,terminalType:'turn/completed',
      errorInfo:'usageLimitExceeded',
      terminalSha256:createHash('sha256').update(JSON.stringify(terminal)).digest('hex'),
      writerProcessIdentitySha256:this.writerIdentity.processStartIdentityHash,
      codexVersion:this.manifest.codexVersion,observedAt,quota,
      originalOcxIssuerVerified:false,originalWriterReturned:false,dispatchable:false,
      modelRequests:0,newTurns:0,automaticReplay:false};
  }
  async captureOwnedFreshQuotaAdmission({failureReceipt}={}){
    const context=failureReceipt?.ownerContext;
    originalSenderContext(context,failureReceipt?.threadId);
    if(!this.process || this.disconnectEmitted ||
      failureReceipt?.kind!=='aicc-app-server-owned-five-hour-failure/v1' ||
      failureReceipt?.writerProcessIdentitySha256!==this.writerIdentity?.processStartIdentityHash ||
      failureReceipt?.ownerContextSha256!==createHash('sha256').update(JSON.stringify(context)).digest('hex') ||
      !OWNER_SHA.test(failureReceipt?.terminalSha256??'') ||
      failureReceipt?.errorInfo!=='usageLimitExceeded')
      throw new AppServerError('original_sender_connection_changed','same original failed sender required');
    const observedAt=this.now(),at=Date.parse(observedAt);
    if(!Number.isFinite(at)||at < failureReceipt.quota.resetsAt*1000)
      throw new AppServerError('original_quota_reset_not_elapsed','original window reset not observed');
    // Updated notifications are sparse; always take a fresh official read.
    const raw=await this.rateLimitsReadForInspection();
    const quota=ownedFiveHourWindow(raw,context.quotaLimitId);
    if(quota.accountIdSha256!==failureReceipt.quota.accountIdSha256 ||
      quota.usedPercent>=100 || quota.rateLimitReachedType!==null ||
      quota.spendControlReached===true || quota.ordinaryUsageAllowed!==true)
      throw new AppServerError('original_fresh_quota_not_admitted','backend fresh same-account admission required');
    return {schemaVersion:1,kind:'aicc-app-server-owned-five-hour-admission/v1',
      source:'owned-original-sender-connected-app-server',
      failureReceiptSha256:createHash('sha256').update(JSON.stringify(failureReceipt)).digest('hex'),
      ownerContextSha256:failureReceipt.ownerContextSha256,
      writerProcessIdentitySha256:this.writerIdentity.processStartIdentityHash,
      observedAt,quota,readOnly:true,
      originalOcxIssuerVerified:false,originalWriterReturned:false,dispatchable:false,
      modelRequests:0,newTurns:0,automaticReplay:false};
  }
  // These methods seal the same-connection producer outputs into an existing
  // owner-private directory. They never infer the original TUI/OCX issuer
  // from a separate App Server or start a turn.
  async sealOwnedFiveHourFailure({threadId,turnId,ownerContext,outputFile}={}) {
    const receipt=await this.captureOwnedFiveHourFailure({threadId,turnId,ownerContext});
    return sealOwnedSourceQuotaReceipt(outputFile,receipt);
  }
  async sealOwnedFreshQuotaAdmission({failureFile,expectedFailureFileSha256,outputFile}={}) {
    const failureReceipt=loadPinnedOwnedQuotaFailure(failureFile,expectedFailureFileSha256);
    const receipt=await this.captureOwnedFreshQuotaAdmission({failureReceipt});
    if(receipt.failureReceiptSha256!==expectedFailureFileSha256)
      throw new AppServerError('quota_admission_failure_chain_drift',
        'fresh admission does not bind exact sealed failure file');
    return sealOwnedSourceQuotaReceipt(outputFile,receipt);
  }
  threadGoalResumeForUser({threadId}, authorization) {
    if (this.manifest?.userGoalResume?.method !== 'thread/goal/set' ||
      this.manifest.userGoalResume.provenanceField !== 'origin' ||
      !/^[a-f0-9]{64}$/.test(this.manifest.userGoalResume.paramsSchemaSha256 ?? '') ||
      authorization?.kind !== 'explicit-user-goal-resume' || authorization.threadId !== threadId ||
      typeof authorization.reference !== 'string' || !authorization.reference.trim() ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId ?? ''))
      throw new AppServerError('goal_resume_contract_required', 'explicit user goal resume requires the pinned provenance contract');
    return this.#rawRequest('thread/goal/set', {threadId, status:'active', origin:'user'});
  }
  threadStart(params) { return this.request('thread/start', params); }
  threadResume(params) { return this.request('thread/resume', params); }
  turnStart(params) { return this.request('turn/start', params); }
  turnSteer(params) { return this.request('turn/steer', params); }
  turnInterrupt(params) { return this.request('turn/interrupt', params); }

  waitFor(method, predicate = () => true, timeoutMs = this.timeoutMs) {
    if (method === 'turn/completed') {
      for (const params of this.completedTurns.values()) if (predicate(params)) return Promise.resolve(params);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off('notification', listener); reject(new AppServerError('notification_timeout', `timed out waiting for ${method}`)); }, timeoutMs);
      const listener = notification => {
        if (notification.method !== method || !predicate(notification.params)) return;
        clearTimeout(timer); this.off('notification', listener); resolve(notification.params);
      };
      this.on('notification', listener);
    });
  }

  close() {
    if (this.process && !this.process.killed) this.process.kill('SIGTERM');
  }

  #send(message) { this.process.stdin.write(`${JSON.stringify(message)}\n`); }
  #rawRequest(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppServerError('request_timeout', `timed out: ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#send({ method, id, params });
    });
  }
  #writerMetadata() {
    return {
      ...this.writerIdentity,
      processExit: this.processExit,
      stdoutEnd: this.stdoutEnd,
      stderrEnd: this.stderrEnd,
      processClose: this.processClose,
      stderrBytes: this.stderrBytes,
      stderrSha256: this.stderrHash.copy().digest('hex'),
      exitBeforeStdoutEnd: this.processExit && this.stdoutEnd
        ? this.processExit.order < this.stdoutEnd.order
        : null,
      parentChildOrderingCaptured: true
    };
  }
  #resetFrame() {
    this.frameParts = [];
    this.frameBytes = 0;
    this.frameHash = createHash('sha256');
  }
  #protocolFailure(code, message, data) {
    if (this.protocolFailed) return null;
    this.protocolFailed = true;
    const error = new AppServerError(code, message, {
      ...data,
      rawPayloadIncluded: false,
      writer: this.#writerMetadata()
    });
    this.emit('protocolError', error);
    this.#disconnect(error);
    this.close();
    return error;
  }
  #appendFrameBytes(segment) {
    if (segment.length === 0) return true;
    this.frameHash.update(segment);
    this.frameBytes += segment.length;
    if (this.frameBytes > this.maxFrameBytes) {
      this.#protocolFailure('protocol_frame_too_large', 'app-server JSONL frame exceeded the bounded transport limit', {
        frameSequence: this.frameSequence + 1,
        lineBytes: this.frameBytes,
        newlineComplete: false,
        sha256: this.frameHash.digest('hex'),
        maxFrameBytes: this.maxFrameBytes,
        partialWriteSuspected: false
      });
      return false;
    }
    this.frameParts.push(segment);
    return true;
  }
  #consumeStdout(chunk) {
    if (this.protocolFailed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && !this.protocolFailed) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline === -1) {
        this.#appendFrameBytes(bytes.subarray(offset));
        return;
      }
      if (!this.#appendFrameBytes(bytes.subarray(offset, newline))) return;
      const frame = Buffer.concat(this.frameParts, this.frameBytes);
      const frameHash = this.frameHash.digest('hex');
      const frameBytes = this.frameBytes;
      this.#resetFrame();
      this.frameSequence += 1;
      let line;
      try { line = new TextDecoder('utf-8', { fatal: true }).decode(frame); }
      catch (cause) {
        this.#protocolFailure('protocol_invalid_utf8', 'invalid UTF-8 JSONL frame from app-server', {
          frameSequence: this.frameSequence,
          lineBytes: frameBytes + 1,
          newlineComplete: true,
          sha256: frameHash,
          parseErrorName: cause?.name ?? 'TypeError',
          partialWriteSuspected: false
        });
        return;
      }
      this.#receive(line, {
        frameSequence: this.frameSequence,
        lineBytes: frameBytes + 1,
        newlineComplete: true,
        sha256: frameHash,
        partialWriteSuspected: false
      });
      offset = newline + 1;
    }
  }
  #finalizeStdout() {
    if (this.protocolFailed || this.frameBytes === 0) return null;
    this.frameSequence += 1;
    const error = this.#protocolFailure('protocol_incomplete_jsonl', 'app-server closed with an unterminated JSONL frame', {
      frameSequence: this.frameSequence,
      lineBytes: this.frameBytes,
      newlineComplete: false,
      sha256: this.frameHash.digest('hex'),
      partialWriteSuspected: true
    });
    this.#resetFrame();
    return error;
  }
  #receive(line, frameMetadata) {
    let message;
    try { message = JSON.parse(line); } catch (cause) {
      this.#protocolFailure('protocol_invalid_json', 'invalid JSONL from app-server; owned connection closed to prevent stale request slots', {
        ...frameMetadata,
        parseErrorName: cause?.name ?? 'SyntaxError',
        partialWriteSuspected: false
      });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new AppServerError(message.error.code, message.error.message, message.error.data)); else pending.resolve(message.result);
      return;
    }
    if (message.method === 'turn/started') {
      const id=message.params?.turn?.id,threadId=message.params?.threadId;
      if(typeof id==='string' && typeof threadId==='string') {
        if(this.startedTurns.has(id))this.ambiguousStartedTurns.add(id);
        else {
          this.startedTurns.set(id,{threadId,at:this.now()});
          if(this.startedTurns.size>128)this.startedTurns.delete(this.startedTurns.keys().next().value);
        }
      }
    }
    if (message.method === 'turn/completed') {
      const id = message.params?.turn?.id; if (id && this.terminalTurns.has(id)) return; if (id) {
        this.terminalTurns.add(id);
        this.completedTurns.set(id, message.params);
        if (this.completedTurns.size > 128) this.completedTurns.delete(this.completedTurns.keys().next().value);
      }
    }
    this.emit('notification', message);
    // `error` is a reserved EventEmitter event and throws when no listener is
    // attached. App Server legitimately uses `error` as a notification method,
    // so expose it under a non-reserved event name while retaining the complete
    // message on the generic notification stream.
    this.emit(message.method === 'error' ? 'serverError' : message.method, message.params);
  }
  #disconnect(error) {
    if (this.disconnectEmitted) return;
    this.disconnectEmitted = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('disconnect', error);
  }
}

export function loadAppServerManifest(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

export function summarizeReadState({ models, capabilities, skills, hooks, apps, threads }) {
  return {
    modelCount: models?.data?.length ?? models?.models?.length ?? null,
    providerCount: capabilities?.providers?.length ?? null,
    skillCount: skills?.data?.length ?? skills?.skills?.length ?? null,
    hookCount: hooks?.data?.length ?? hooks?.hooks?.length ?? null,
    appCount: apps?.data?.length ?? apps?.apps?.length ?? null,
    threadCount: threads?.data?.length ?? threads?.threads?.length ?? null,
    conversationBodiesIncluded: false,
    authMaterialIncluded: false
  };
}
