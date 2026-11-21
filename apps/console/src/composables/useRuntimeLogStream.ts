import { ref, watch, onScopeDispose, type Ref } from 'vue';
import { BuildLogChunkSchema, RuntimeStreamStatusSchema, RuntimeStreamEndSchema, BuildStreamErrorSchema,
  type RuntimeLogSession, type BuildLogChunk, type RuntimeStreamEnd } from '@forgekit/contracts';
import { listRuntimeLogs, createRuntimeStreamTicket, runtimeLogStreamUrl, cancelRuntimeSession } from '../api/runtime-logs';
import { ProjectApiError } from '../api/projects';
import { createBuildLogTextSanitizer } from '../utils/build-log-text';

export type RuntimeLogConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error' | 'closed';
const delays = [1000, 2000, 4000, 8000, 15000];
export function useRuntimeLogStream(projectId: Readonly<Ref<string>>, sessionId: Readonly<Ref<string>>) {
  const chunks = ref<BuildLogChunk[]>([]), lastSeq = ref(0), truncated = ref(false);
  const state = ref<RuntimeLogConnectionState>('connecting'), error = ref('');
  const session = ref<RuntimeLogSession | null>(null), end = ref<RuntimeStreamEnd | null>(null);
  const accessError = ref<401 | 403 | 404 | null>(null);
  const sanitizers = {
    stdout: createBuildLogTextSanitizer(),
    stderr: createBuildLogTextSanitizer(),
    system: createBuildLogTextSanitizer(),
  };
  let generation = 0, retries = 0, bytes = 0, stopped = false;
  let source: EventSource | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  const encoder = new TextEncoder();
  function close() { source?.close(); source = null; clearTimeout(timer); timer = undefined; }
  function invalidate() { ++generation; close(); }
  function protocol(message = '日志协议错误。') { invalidate(); state.value = 'error'; error.value = message; }
  function append(chunk: BuildLogChunk) {
    lastSeq.value = chunk.seq;
    // Sanitize once per stream before eviction so split ANSI state survives truncation.
    const clean = { ...chunk, content: sanitizers[chunk.stream].push(chunk.content) };
    chunks.value.push(clean); bytes += encoder.encode(clean.content).length;
    while (chunks.value.length > 5000 || bytes > 2 * 1024 * 1024) {
      bytes -= encoder.encode(chunks.value.shift()!.content).length; truncated.value = true;
    }
  }
  function failure(reason: unknown) {
    if (reason instanceof ProjectApiError && [401, 403, 404].includes(reason.status)) {
      invalidate(); accessError.value = reason.status as 401 | 403 | 404;
      chunks.value = []; bytes = 0; session.value = null; state.value = 'error'; error.value = reason.message;
    } else { error.value = reason instanceof ProjectApiError ? reason.message : '日志连接失败，请重试。'; retry(); }
  }
  function retry() {
    invalidate();
    const delay = delays[retries++];
    if (delay === undefined) { state.value = 'error'; error.value ||= '日志连接失败，请手动重新连接。'; return; }
    state.value = 'reconnecting';
    const gen = generation;
    timer = setTimeout(() => { if (gen === generation && !stopped) void connect(); }, delay);
  }
  async function fill(target: number, gen: number) {
    while (lastSeq.value < target) {
      const batch = await listRuntimeLogs(projectId.value, sessionId.value, { seq: lastSeq.value, limit: 500 });
      if (gen !== generation) return false;
      if (!batch.length) throw new Error('日志补齐未达到目标序号。');
      for (const event of batch) {
        if (event.sessionId !== sessionId.value) throw new Error('日志操作不匹配。');
        const { sessionId: _id, ...raw } = event;
        const chunk = BuildLogChunkSchema.parse(raw);
        if (chunk.seq <= lastSeq.value) continue;
        if (chunk.seq !== lastSeq.value + 1) throw new Error('日志补齐存在缺口。');
        append(chunk);
        if (lastSeq.value === target) return true;
      }
    }
    return true;
  }
  async function recover(target: number, pending?: BuildLogChunk, terminal?: RuntimeStreamEnd) {
    invalidate(); const gen = generation; state.value = 'reconnecting';
    try {
      if (!await fill(target, gen) || gen !== generation) return;
      if (pending) append(pending);
      if (terminal) { end.value = terminal; state.value = 'ended'; error.value = ''; }
      else await connect();
    } catch (reason) {
      if (gen !== generation) return;
      if (reason instanceof ProjectApiError) failure(reason);
      else protocol('日志协议错误：无法完整补齐日志。');
    }
  }
  async function connect() {
    if (stopped) return;
    invalidate(); const gen = generation;
    state.value = 'connecting'; error.value = ''; accessError.value = null; end.value = null;
    try {
      const ticket = (await createRuntimeStreamTicket(projectId.value, sessionId.value)).ticket;
      if (gen !== generation) return;
      const es = new EventSource(runtimeLogStreamUrl(projectId.value, sessionId.value, { after: lastSeq.value, ...(ticket ? { ticket } : {}) }));
      source = es;
      const listen = (name: string, handler: (event: MessageEvent<string>) => void) => {
        es.addEventListener(name, (event) => {
          if (gen !== generation || es !== source) return;
          try { handler(event as MessageEvent<string>); } catch { protocol(); }
        });
      };
      listen('open', () => { state.value = 'connected'; error.value = ''; });
      listen('log', (event) => {
        const chunk = BuildLogChunkSchema.parse(JSON.parse(event.data));
        if (event.lastEventId !== String(chunk.seq)) throw new Error('id');
        retries = 0;
        if (chunk.seq <= lastSeq.value) return;
        if (chunk.seq > lastSeq.value + 1) { void recover(chunk.seq - 1, chunk); return; }
        append(chunk);
      });
      listen('status', (event) => {
        const next = RuntimeStreamStatusSchema.parse(JSON.parse(event.data)).session;
        if (next.id !== sessionId.value || next.projectId !== projectId.value) throw new Error('identity');
        session.value = next; retries = 0;
      });
      listen('end', (event) => {
        const value = RuntimeStreamEndSchema.parse(JSON.parse(event.data));
        if (value.sessionId !== sessionId.value || value.lastSeq < lastSeq.value ||
          (session.value && session.value.status !== value.status)) throw new Error('end');
        retries = 0;
        if (value.lastSeq > lastSeq.value) { void recover(value.lastSeq, undefined, value); return; }
        invalidate(); end.value = value; state.value = 'ended';
      });
      listen('stream-error', (event) => {
        const value = BuildStreamErrorSchema.parse(JSON.parse(event.data));
        if (value.code === 'ticket_expired') { retries = 0; void connect(); }
        else if (value.code === 'access_revoked') failure(new ProjectApiError(value.message, 403));
        else { error.value = value.message; retry(); }
      });
      es.onerror = () => { if (gen === generation && es === source) retry(); };
    } catch (reason) { if (gen === generation) failure(reason); }
  }
  async function reconnect() { stopped = false; retries = 0; await connect(); }
  function stop() { stopped = true; invalidate(); state.value = 'closed'; void cancelRuntimeSession(projectId.value, sessionId.value).catch(() => { /* SSE disconnect/lease also cancels the host reader. */ }); }
  watch([projectId, sessionId], () => {
    invalidate(); chunks.value = []; lastSeq.value = 0; bytes = 0;
    Object.values(sanitizers).forEach((sanitizer) => sanitizer.reset());
    session.value = null; end.value = null; truncated.value = false; retries = 0; stopped = false;
    void connect();
  }, { immediate: true, flush: 'sync' });
  onScopeDispose(stop);
  return { chunks, lastSeq, state, error, truncated, session, end, accessError, reconnect, stop };
}
