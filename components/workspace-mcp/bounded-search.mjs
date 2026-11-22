import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const activeWorkers = new Set();

// Filesystem probes run off the MCP event loop. The parent owns rg's actual
// ChildProcess handle, the whole-request deadline, and cancellation cleanup.
export async function boundedWorkspaceSearch(options) {
  if (activeWorkers.size >= 4) throw new Error('동시 검색 4개가 실행 또는 정리 중입니다. 진행 중인 검색이 끝난 뒤 다시 요청하세요.');
  const { signal, timeoutMs = 20_000, ...data } = options;
  const worker = new Worker(new URL('./bounded-search.mjs', import.meta.url), { workerData: { aiccSearch: true, ...data }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
  activeWorkers.add(worker);
  let child, timer, forceTimer, closed = false, settled = false, sequence = 0;
  const pending = new Map();
  const cleanup = async () => {
    clearTimeout(timer); if (closed) clearTimeout(forceTimer);
    signal?.removeEventListener('abort', abort);
    for (const item of pending.values()) item.reject(new Error('검색이 종료되었습니다.'));
    pending.clear();
    const termination = worker.terminate().finally(() => activeWorkers.delete(worker));
    let releaseTimer;
    await Promise.race([termination, new Promise(resolve => { releaseTimer = setTimeout(resolve, 250); })]);
    clearTimeout(releaseTimer);
  };
  const rpc = (type, payload) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload });
  });
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const stop = error => {
    if (settled) return;
    // Never wait on a pipe/close event to return the bounded error. Keep an
    // exact-handle kill retry until the OS confirms this owned child exited.
    if (child && !closed) {
      child.kill('SIGKILL');
      forceTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1_000);
      forceTimer.unref?.();
    }
    rejectDeadline(error);
  };
  const abort = () => stop(new Error('검색이 취소되었습니다.'));
  timer = setTimeout(() => stop(new Error(`검색 전체 시간이 ${timeoutMs / 1000}초를 초과했습니다. 경로나 검색어를 좁혀 주세요.`)), timeoutMs);
  worker.on('message', message => {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    message.error ? item.reject(new Error(message.error)) : item.resolve(message.value);
  });
  worker.on('error', error => stop(error));
  worker.on('exit', code => { if (!settled) stop(new Error(`검색 작업자가 종료되었습니다 (${code}).`)); });
  signal?.addEventListener('abort', abort, { once: true });
  const run = async () => {
    if (signal?.aborted) throw new Error('검색이 취소되었습니다.');
    const prepared = await rpc('prepare', {});
    child = spawn(data.executable, prepared.args, { cwd: prepared.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const childClosed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => { closed = true; clearTimeout(forceTimer); resolve(code); });
    });
    // Attach immediately so an early spawn error cannot become unhandled.
    childClosed.catch(() => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, Math.min(data.maxOutputBytes, 16_384)); });
    child.stdout.setEncoding('utf8');
    let limited = false;
    for await (const chunk of child.stdout) {
      const state = await rpc('chunk', { chunk });
      if (state.stop) { limited = true; child.kill('SIGKILL'); break; }
    }
    const code = await childClosed;
    const result = await rpc('finish', {});
    if (!limited && ![0, 1].includes(code)) throw new Error((stderr || `검색 실행이 상태 ${code}로 종료되었습니다.`).trim());
    return result;
  };
  try { return await Promise.race([run(), deadline]); }
  finally {
    settled = true;
    // On rejection, stop our exact owned handle before releasing the worker.
    if (child && !closed) child.kill('SIGKILL');
    await cleanup();
  }
}

if (!isMainThread && workerData?.aiccSearch) {
  const o = workerData;
  const blockedNames = new Set(o.blockedNames), blockedExtensions = new Set(o.blockedExtensions);
  let root, pending = '', acceptedBytes = 0, linesSeen = 0, parsedCandidates = 0, limitReason = null;
  const results = [];
  const inside = candidate => { const rel = path.relative(root, candidate); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  const safe = relative => {
    const parts = relative.split(/[\\/]/).filter(Boolean).map(part => part.toLocaleLowerCase('en-US'));
    const name = parts.at(-1) ?? '';
    if (parts.some(part => blockedNames.has(part) || part === '.git') || name.startsWith('.env.') || blockedExtensions.has(path.extname(name))) throw new Error('민감 파일 경로는 검색할 수 없습니다.');
  };
  const consume = line => {
    if (!line || limitReason) return;
    linesSeen++;
    try {
      let candidate, event;
      if (o.filesOnly) candidate = path.resolve(root, line);
      else {
        event = JSON.parse(line);
        if (event?.type !== 'match' || typeof event.data?.path?.text !== 'string') return;
        candidate = path.resolve(root, event.data.path.text);
      }
      const absolute = fs.realpathSync(candidate);
      if (!inside(absolute)) return;
      const relative = path.relative(root, absolute); safe(relative);
      let parsed;
      if (o.filesOnly) {
        if (!relative.toLocaleLowerCase('en-US').includes(o.query.toLocaleLowerCase('en-US'))) return;
        parsed = relative;
      } else {
        const lineNumber = Number(event.data.line_number);
        parsed = `${relative}:${Number.isInteger(lineNumber) ? lineNumber : 0}:${String(event.data.lines?.text ?? '').replace(/\r?\n/g, ' ').slice(0, 2_000)}`;
      }
      parsedCandidates++;
      const bytes = Buffer.byteLength(parsed);
      if (results.length >= o.maxResults) { limitReason = 'max_results'; return; }
      if (acceptedBytes + bytes > o.maxOutputBytes) { limitReason = 'max_output_bytes'; return; }
      results.push(parsed); acceptedBytes += bytes;
    } catch { /* Missing, inaccessible, sensitive, or escaped candidates fail closed. */ }
  };
  parentPort.on('message', message => {
    try {
      let value;
      if (message.type === 'prepare') {
        root = fs.realpathSync(o.root);
        const relative = o.relativePath;
        if (!relative || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('워크스페이스 기준 상대 경로가 필요합니다.');
        const normalized = path.normalize(relative); safe(normalized);
        const target = path.resolve(root, normalized);
        if (!inside(target)) throw new Error('검색 경로가 워크스페이스 밖입니다.');
        if (fs.lstatSync(target).isSymbolicLink()) throw new Error('심볼릭 링크 자체는 검색할 수 없습니다.');
        const searchRoot = fs.realpathSync(target);
        if (!inside(searchRoot)) throw new Error('검색 경로가 워크스페이스 밖으로 해석됩니다.');
        const globs = o.globs.flatMap(glob => ['--glob', glob]);
        value = { root, args: o.filesOnly ? ['--files', '--hidden', '--no-messages', ...globs, searchRoot]
          : ['--json', '--hidden', '--no-messages', '--fixed-strings', ...globs, '--', o.query, searchRoot] };
      } else if (message.type === 'chunk') {
        pending += message.chunk;
        let index;
        while (!limitReason && (index = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, index); pending = pending.slice(index + 1); consume(line); }
        if (!limitReason && Buffer.byteLength(pending) > o.maxOutputBytes) limitReason = 'single_line_output_limit';
        if (limitReason) pending = '';
        value = { stop: Boolean(limitReason) };
      } else if (message.type === 'finish') {
        if (pending && !limitReason) consume(pending);
        value = { results, truncated: limitReason !== null, limitReason, acceptedBytes, linesSeen, parsedCandidates };
      } else throw new Error('Unknown search worker request');
      parentPort.postMessage({ id: message.id, value });
    } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
  });
}