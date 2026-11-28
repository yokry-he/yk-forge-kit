import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useBuildLogStream } from '../src/composables/useBuildLogStream';
import type { Build, BuildLogChunk, BuildStreamEnd, BuildStreamTicket } from '@forgekit/contracts';
import { createBuildStreamTicket, listBuildLogs, buildLogStreamUrl } from '../src/api/builds';
import { ProjectApiError } from '../src/api/projects';
import { oidcEnabled } from '../src/auth/session';

const oidcEnabledState = vi.hoisted(() => ({ enabled: true }));

vi.mock('../src/api/builds', () => ({
  createBuildStreamTicket: vi.fn(),
  listBuildLogs: vi.fn(),
  buildLogStreamUrl: vi.fn(),
}));

vi.mock('../src/auth/session', () => ({
  get oidcEnabled() { return oidcEnabledState.enabled; },
}));

interface FakeEvent { type: string; data?: string; lastEventId?: string }
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  readyState: number = 0;
  onopen: ((event: FakeEvent) => void) | null = null;
  onerror: ((event: FakeEvent) => void) | null = null;
  close = vi.fn(() => { this.readyState = 2; });

  private listeners: Record<string, Array<(event: FakeEvent) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  static get last(): FakeEventSource | undefined {
    return this.instances[this.instances.length - 1];
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter(l => l !== listener);
    }
  }

  dispatchEvent(event: FakeEvent): boolean {
    if (event.type === 'open' && this.onopen) this.onopen(event);
    if (event.type === 'error' && this.onerror) this.onerror(event);
    const listeners = this.listeners[event.type] || [];
    for (const listener of listeners) listener(event);
    return true;
  }

  emitOpen() {
    this.readyState = 1;
    this.dispatchEvent({ type: 'open' });
  }

  emitLog(chunk: BuildLogChunk) {
    this.dispatchEvent({ type: 'log', data: JSON.stringify(chunk), lastEventId: String(chunk.seq) });
  }

  emitStatus(build: Build) {
    this.dispatchEvent({ type: 'status', data: JSON.stringify({ build }) });
  }

  emitEnd(end: BuildStreamEnd) {
    this.dispatchEvent({ type: 'end', data: JSON.stringify(end) });
  }

  emitError(code: string, message: string) {
    this.dispatchEvent({ type: 'stream-error', data: JSON.stringify({ code, message }) });
  }

  emitNetworkError() {
    this.dispatchEvent({ type: 'error' });
  }
}

function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    projectId: '11111111-1111-4111-8111-111111111111',
    number: 1,
    template: 'vue',
    sourceRef: 'main',
    status: 'running',
    triggeredBy: '33333333-3333-4333-8333-333333333333',
    queuedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    exitCode: null,
    errorMessage: null,
    artifactKey: null,
    artifactSize: null,
    artifactSha256: null,
    logStorageKey: null,
    runnerInfo: null, diagnosis: null,
    ...overrides,
  };
}

function makeChunk(seq: number, stream: 'stdout' | 'stderr' | 'system' = 'stdout', content = 'line\n'): BuildLogChunk {
  return { seq, stream, content, ts: '2026-01-01T00:00:00.000Z' };
}

function makeEnd(overrides: Partial<BuildStreamEnd> = {}): BuildStreamEnd {
  return { buildId: '22222222-2222-4222-8222-222222222222', status: 'succeeded', lastSeq: 0, ...overrides };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
}

const scopes: ReturnType<typeof effectScope>[] = [];
function scopedStream(...args: Parameters<typeof useBuildLogStream>) {
  const scope = effectScope(); scopes.push(scope);
  return scope.run(() => useBuildLogStream(...args))!;
}
beforeEach(() => {
  vi.useFakeTimers();
  oidcEnabledState.enabled = true;

  vi.mocked(createBuildStreamTicket).mockReset();
  vi.mocked(listBuildLogs).mockReset();
  vi.mocked(buildLogStreamUrl).mockReset();

  vi.mocked(createBuildStreamTicket).mockResolvedValue({ ticket: 'ticket-test', expiresAt: '2026-01-01T00:00:00.000Z' });
  vi.mocked(listBuildLogs).mockResolvedValue([]);
  vi.mocked(buildLogStreamUrl).mockImplementation((projectId: string, buildId: string, options?: { after?: number; ticket?: string }) => {
    const params = new URLSearchParams();
    if (options?.after !== undefined) params.set('after', String(options.after));
    if (options?.ticket) params.set('ticket', options.ticket);
    return `https://example.com/api/v1/projects/${projectId}/builds/${buildId}/logs/stream?${params.toString()}`;
  });

  FakeEventSource.instances.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useBuildLogStream', () => {
  it('connects with ticket in OIDC mode', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();

    expect(createBuildStreamTicket).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(buildLogStreamUrl).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', { after: 0, ticket: 'ticket-test' });

    const es = FakeEventSource.last;
    expect(es).toBeTruthy();
    expect(es!.url).toContain('ticket=ticket-test');
    expect(es!.url).toContain('after=0');
    expect(stream.state.value).toBe('connecting');

    es!.emitOpen();
    await flush();
    expect(stream.state.value).toBe('connected');
  });

  it('connects without ticket in local mode', async () => {
    oidcEnabledState.enabled = false;
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();

    expect(createBuildStreamTicket).not.toHaveBeenCalled();
    expect(buildLogStreamUrl).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', { after: 0 });

    const es = FakeEventSource.last;
    expect(es).toBeTruthy();
    expect(es!.url).toContain('after=0');
    expect(es!.url).not.toContain('ticket=');
  });

  it('processes log events, deduplicates and updates lastSeq', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    const es = FakeEventSource.last!;
    es.emitOpen();
    await flush();

    es.emitLog(makeChunk(1, 'stdout', 'line1\n'));
    es.emitLog(makeChunk(2, 'stderr', 'line2\n'));
    es.emitLog(makeChunk(1, 'stdout', 'dup\n')); // duplicate
    es.emitLog(makeChunk(3, 'system', 'line3\n'));
    await flush();

    expect(stream.chunks.value).toEqual([
      makeChunk(1, 'stdout', 'line1\n'),
      makeChunk(2, 'stderr', 'line2\n'),
      makeChunk(3, 'system', 'line3\n'),
    ]);
    expect(stream.lastSeq.value).toBe(3);
  });

  it('handles status event and updates build', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    const es = FakeEventSource.last!;
    es.emitOpen();
    await flush();

    const build = makeBuild({ status: 'succeeded', finishedAt: '2026-01-01T01:00:00.000Z' });
    es.emitStatus(build);
    await flush();
    expect(stream.build.value).toEqual(build);
  });

  it('handles end event, sets end and closes EventSource', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    const es = FakeEventSource.last!;
    es.emitOpen();
    await flush();

    const end = makeEnd({ buildId: '22222222-2222-4222-8222-222222222222', status: 'succeeded', lastSeq: 0 });
    es.emitEnd(end);
    await flush();

    expect(stream.end.value).toEqual(end);
    expect(stream.state.value).toBe('ended');
    expect(es.close).toHaveBeenCalled();
  });

  it('fills gap via REST when missing chunks detected', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    vi.mocked(listBuildLogs).mockResolvedValue([
      { ...makeChunk(2, 'stdout', 'line2\n'), buildId: '22222222-2222-4222-8222-222222222222' },
      { ...makeChunk(3, 'stdout', 'line3\n'), buildId: '22222222-2222-4222-8222-222222222222' },
    ]);
    const stream = scopedStream(projectId, buildId);
    await flush();
    const es1 = FakeEventSource.last!;
    es1.emitOpen();
    await flush();

    es1.emitLog(makeChunk(1, 'stdout', 'line1\n'));
    es1.emitLog(makeChunk(4, 'stdout', 'line4\n')); // gap (2,3 missing)
    await flush();

    expect(listBuildLogs).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', { seq: 1, limit: 500 });

    const es2 = FakeEventSource.last!;
    expect(es2).not.toBe(es1);
    expect(es2.url).toContain('after=4'); // after fill and buffered chunk 4
    expect(es1.close).toHaveBeenCalled();
    expect(stream.chunks.value.map(c => c.seq)).toEqual([1, 2, 3, 4]);
    expect(stream.lastSeq.value).toBe(4);
  });

  it('renews ticket on stream-error ticket_expired', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    const es1 = FakeEventSource.last!;
    es1.emitOpen();
    await flush();

    es1.emitLog(makeChunk(1, 'stdout', 'line1\n'));
    await flush();
    expect(stream.lastSeq.value).toBe(1);

    vi.mocked(createBuildStreamTicket).mockResolvedValueOnce({ ticket: 'ticket-new', expiresAt: '2026-01-01T00:00:00.000Z' });
    es1.emitError('ticket_expired', '凭证已过期');
    await flush();

    expect(createBuildStreamTicket).toHaveBeenCalledTimes(2);
    const es2 = FakeEventSource.last!;
    expect(es2).not.toBe(es1);
    expect(es2.url).toContain('after=1');
    expect(es2.url).toContain('ticket=ticket-new');
    expect(es1.close).toHaveBeenCalled();
    expect(stream.state.value).toBe('connecting');

    es2.emitOpen();
    await flush();
    expect(stream.state.value).toBe('connected');
  });

  it('stops retries on access_revoked', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    const es = FakeEventSource.last!;
    es.emitOpen();
    await flush();

    es.emitError('access_revoked', '权限已撤销');
    await flush();

    expect(stream.accessError.value).toBe(403);
    expect(stream.state.value).toBe('error');
    expect(createBuildStreamTicket).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances.length).toBe(1);
  });

  it('retries on network error with exponential backoff up to 5 times', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    let es = FakeEventSource.last!;
    es.emitOpen();
    await flush();

    // First network error
    es.emitNetworkError();
    await flush();
    expect(stream.state.value).toBe('reconnecting');
    expect(es.close).toHaveBeenCalled();

    // Retry 1 after 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    es = FakeEventSource.last!;
    expect(es).toBeTruthy();
    es.emitOpen();
    await flush();
    expect(stream.state.value).toBe('connected');
    es.emitNetworkError();
    await flush();
    expect(stream.state.value).toBe('reconnecting');

    // Retry 2 after 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    es = FakeEventSource.last!;
    es.emitOpen();
    await flush();
    es.emitNetworkError();
    await flush();

    // Retry 3 after 4000ms
    await vi.advanceTimersByTimeAsync(4000);
    await flush();
    es = FakeEventSource.last!;
    es.emitOpen();
    await flush();
    es.emitNetworkError();
    await flush();

    // Retry 4 after 8000ms
    await vi.advanceTimersByTimeAsync(8000);
    await flush();
    es = FakeEventSource.last!;
    es.emitOpen();
    await flush();
    es.emitNetworkError();
    await flush();

    // Retry 5 after 15000ms
    await vi.advanceTimersByTimeAsync(15000);
    await flush();
    es = FakeEventSource.last!;
    es.emitOpen();
    await flush();
    es.emitNetworkError();
    await flush();

    // No more automatic retries
    expect(stream.state.value).toBe('error');
    const instanceCountAfterFinalError = FakeEventSource.instances.length;
    await vi.advanceTimersByTimeAsync(30000);
    await flush();
    expect(FakeEventSource.instances.length).toBe(instanceCountAfterFinalError);
  });

  it('reconnect() manually starts new connection with current cursor', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    let es = FakeEventSource.last!;
    es.emitOpen();
    await flush();

    es.emitLog(makeChunk(1, 'stdout', 'line1\n'));
    await flush();
    expect(stream.lastSeq.value).toBe(1);

    // Simulate network error and exhaust retries
    for (let i = 0; i < 5; i++) {
      es.emitNetworkError();
      await flush();
      const delay = [1000, 2000, 4000, 8000, 15000][i]!;
      await vi.advanceTimersByTimeAsync(delay);
      await flush();
      es = FakeEventSource.last!;
      es.emitOpen();
      await flush();
    }
    es.emitNetworkError();
    await flush();
    expect(stream.state.value).toBe('error');

    // Manual reconnect
    await stream.reconnect();
    await flush();
    expect(stream.state.value).toBe('connecting');
    expect(createBuildStreamTicket).toHaveBeenCalledTimes(7); // initial + five retries + manual
    es = FakeEventSource.last!;
    expect(es.url).toContain('after=1');
    es.emitOpen();
    await flush();
    expect(stream.state.value).toBe('connected');
  });

  it('resets when buildId changes', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    let es = FakeEventSource.last!;
    es.emitOpen();
    await flush();
    es.emitLog(makeChunk(1, 'stdout', 'line1\n'));
    await flush();
    expect(stream.lastSeq.value).toBe(1);

    buildId.value = '44444444-4444-4444-8444-444444444444';
    await flush();

    expect(stream.lastSeq.value).toBe(0);
    expect(stream.chunks.value).toEqual([]);
    expect(stream.end.value).toBeNull();
    expect(stream.build.value).toBeNull();
    expect(es.close).toHaveBeenCalled();

    const es2 = FakeEventSource.last!;
    expect(es2).not.toBe(es);
    expect(createBuildStreamTicket).toHaveBeenCalledTimes(2);
    expect(createBuildStreamTicket).toHaveBeenLastCalledWith('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444');
    expect(es2.url).toContain('after=0');
  });

  it('ignores late ticket resolve after ID change', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    let resolveTicket: (value: BuildStreamTicket) => void = () => {};
    vi.mocked(createBuildStreamTicket).mockImplementationOnce(() => new Promise(resolve => {
      resolveTicket = resolve;
    }));
    const stream = scopedStream(projectId, buildId);
    await flush();
    expect(FakeEventSource.instances.length).toBe(0);

    buildId.value = '44444444-4444-4444-8444-444444444444';
    await flush();
    // New connection for 44444444-4444-4444-8444-444444444444 should be created with default ticket
    expect(createBuildStreamTicket).toHaveBeenCalledTimes(2);
    const esForBuild2 = FakeEventSource.last!;
    expect(esForBuild2).toBeTruthy();
    expect(esForBuild2.url).toContain('ticket=ticket-test');
    expect(esForBuild2.url).toContain('after=0');

    // Resolve old ticket
    resolveTicket({ ticket: 'old-ticket', expiresAt: '2026-01-01T00:00:00.000Z' });
    await flush();

    // Old ticket should be ignored, no new EventSource with old ticket
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.last!.url).not.toContain('old-ticket');
  });

  it('truncates buffer when exceeding chunk limit', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    const es = FakeEventSource.last!;
    es.emitOpen();
    await flush();

    for (let i = 1; i <= 5001; i++) {
      es.emitLog(makeChunk(i, 'stdout', `line${i}\n`));
    }
    await flush();

    expect(stream.chunks.value.length).toBeLessThanOrEqual(5000);
    expect(stream.truncated.value).toBe(true);
    expect(stream.lastSeq.value).toBe(5001);
    expect(stream.chunks.value[0]!.seq).toBeGreaterThan(1);
  });

  it('handles invalid log event data as protocol error', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    const es = FakeEventSource.last!;
    es.emitOpen();
    await flush();

    es.dispatchEvent({ type: 'log', data: 'invalid json', lastEventId: '1' });
    await flush();

    expect(stream.error.value).toContain('协议错误');
    expect(stream.lastSeq.value).toBe(0);
    expect(stream.state.value).toBe('error');
  });

  it('stop() closes stream and clears resources', async () => {
    const projectId = ref('11111111-1111-4111-8111-111111111111');
    const buildId = ref('22222222-2222-4222-8222-222222222222');
    const stream = scopedStream(projectId, buildId);
    await flush();
    const es = FakeEventSource.last!;
    es.emitOpen();
    await flush();

    stream.stop();
    await flush();

    expect(es.close).toHaveBeenCalled();
    const count = FakeEventSource.instances.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeEventSource.instances.length).toBe(count);
  });
});

describe('stream protocol and lifecycle regressions', () => {
  const pid = '11111111-1111-4111-8111-111111111111';
  const bid = '22222222-2222-4222-8222-222222222222';
  it.each([
    ['stdout', 'stderr', 'system'],
    ['stderr', 'system', 'stdout'],
    ['system', 'stdout', 'stderr'],
  ] as const)('isolates split OSC on %s, CSI on %s and plain text on %s', async (osc, csi, plain) => {
    const stream = scopedStream(ref(pid), ref(bid)); await flush();
    const es = FakeEventSource.last!;
    const input = [
      makeChunk(1, osc, '\x1b]0;hidden'),
      makeChunk(2, csi, '\x1b[3'),
      makeChunk(3, plain, 'visible\n'),
      makeChunk(4, csi, '1mBUILD FAILED\x1b[0m\n'),
      makeChunk(5, osc, '\x1b'),
      makeChunk(6, plain, 'still visible\n'),
      makeChunk(7, osc, '\\OSC closed\n'),
      makeChunk(8, csi, '\x1b['),
      makeChunk(9, osc, 'normal output\n'),
      makeChunk(10, csi, '0mCSI closed\n'),
    ];
    input.forEach((chunk) => es.emitLog(chunk));
    expect(stream.chunks.value).toEqual(input.map((chunk, i) => ({
      ...chunk,
      content: ['', '', 'visible\n', 'BUILD FAILED\n', '', 'still visible\n',
        'OSC closed\n', '', 'normal output\n', 'CSI closed\n'][i],
    })));
    expect(stream.lastSeq.value).toBe(10);
    expect(stream.state.value).not.toBe('error');
  });
  it('resets every stream parser when the build changes', async () => {
    const id = ref(bid); const stream = scopedStream(ref(pid), id); await flush();
    const streams = ['stdout', 'stderr', 'system'] as const;
    streams.forEach((name, i) => FakeEventSource.last!.emitLog(makeChunk(i + 1, name, '\x1b]0;hidden')));
    id.value = '44444444-4444-4444-8444-444444444444'; await flush();
    streams.forEach((name, i) => FakeEventSource.last!.emitLog(makeChunk(i + 1, name, name)));
    expect(stream.chunks.value.map((chunk) => chunk.content)).toEqual(streams);
    expect(stream.lastSeq.value).toBe(3);
  });
  it('closes old generations and ignores late log/status/end/open callbacks', async () => {
    const id = ref(bid); const stream = scopedStream(ref(pid), id); await flush();
    const old = FakeEventSource.last!; old.emitLog(makeChunk(1));
    id.value = '44444444-4444-4444-8444-444444444444'; await flush();
    old.emitLog(makeChunk(2)); old.emitStatus(makeBuild()); old.emitEnd(makeEnd({ lastSeq: 2 })); old.emitOpen();
    expect(stream.lastSeq.value).toBe(0); expect(stream.build.value).toBeNull(); expect(stream.end.value).toBeNull();
    expect(stream.state.value).toBe('connecting');
  });
  it('validates required log event ids without advancing cursor', async () => {
    const stream = scopedStream(ref(pid), ref(bid)); await flush();
    FakeEventSource.last!.dispatchEvent({ type: 'log', data: JSON.stringify(makeChunk(1)), lastEventId: '' });
    expect(stream.state.value).toBe('error'); expect(stream.lastSeq.value).toBe(0);
  });
  it('rejects cross-project status and invalid strict envelopes', async () => {
    const stream = scopedStream(ref(pid), ref(bid)); await flush();
    FakeEventSource.last!.emitStatus(makeBuild({ projectId: '44444444-4444-4444-8444-444444444444' }));
    expect(stream.state.value).toBe('error'); expect(stream.build.value).toBeNull();
  });
  it('does not close on terminal status, fills end cursor from REST and then closes', async () => {
    const stream = scopedStream(ref(pid), ref(bid)); await flush(); const es = FakeEventSource.last!;
    es.emitStatus(makeBuild({ status: 'succeeded' })); expect(es.close).not.toHaveBeenCalled();
    vi.mocked(listBuildLogs).mockResolvedValue([{ ...makeChunk(1), buildId: bid }, { ...makeChunk(2), buildId: bid }]);
    es.emitEnd(makeEnd({ lastSeq: 2 })); await flush();
    expect(stream.state.value).toBe('ended'); expect(stream.lastSeq.value).toBe(2); expect(es.close).toHaveBeenCalled();
    await stream.reconnect(); expect(FakeEventSource.last!.url).toContain('after=2');
  });
  it('refuses to skip a gap in persisted logs', async () => {
    const stream = scopedStream(ref(pid), ref(bid)); await flush();
    vi.mocked(listBuildLogs).mockResolvedValue([{ ...makeChunk(2), buildId: bid }]);
    FakeEventSource.last!.emitLog(makeChunk(3)); await flush();
    expect(stream.lastSeq.value).toBe(0); expect(stream.chunks.value).toEqual([]);
    expect(stream.state.value).toBe('error'); expect(stream.error.value).toContain('协议错误');
  });
  it.each([401, 403, 404] as const)('stops on ticket HTTP %s and does not retry', async (status) => {
    vi.mocked(createBuildStreamTicket).mockRejectedValueOnce(new ProjectApiError('denied', status));
    const stream = scopedStream(ref(pid), ref(bid)); await flush(); await vi.advanceTimersByTimeAsync(40_000);
    expect(stream.accessError.value).toBe(status); expect(FakeEventSource.instances).toHaveLength(0);
    expect(createBuildStreamTicket).toHaveBeenCalledOnce();
  });
  it('keeps cursor and escape parser across byte truncation', async () => {
    const stream = scopedStream(ref(pid), ref(bid)); await flush(); const es = FakeEventSource.last!;
    es.emitLog(makeChunk(1, 'stdout', 'a'.repeat(16380) + '\x1b['));
    es.emitLog(makeChunk(2, 'stdout', '31mred'));
    for (let seq = 3; seq <= 140; seq++) es.emitLog(makeChunk(seq, 'stderr', 'b'.repeat(16384)));
    expect(stream.truncated.value).toBe(true); expect(stream.lastSeq.value).toBe(140);
    const size = stream.chunks.value.reduce((n, chunk) => n + new TextEncoder().encode(chunk.content).length, 0);
    expect(size).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(stream.chunks.value[0]!.seq).toBeGreaterThan(2);
    es.emitLog(makeChunk(141, 'stdout', '\x1b]8;;url'));
    es.emitLog(makeChunk(142, 'stdout', '\x1b\\safe'));
    expect(stream.chunks.value.at(-1)?.content).toBe('safe');
  });
  it('scope disposal cancels pending retry and closes the source', async () => {
    scopedStream(ref(pid), ref(bid)); await flush(); const es = FakeEventSource.last!;
    es.emitNetworkError(); scopes.at(-1)!.stop(); await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeEventSource.instances).toHaveLength(1); expect(es.close).toHaveBeenCalled();
  });
});
