import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canTransition, type BuildStatus } from '@forgekit/contracts';
import { BuildTransitionError } from '@forgekit/db';
import { BuildProcessor } from '../src/processor';
import { NoopRunner, type BuildRecord, type BuildRunner } from '../src/runner';
import { resolveWorkerConfig } from '../src/config';

function fixture(status: BuildStatus = 'queued', runner: BuildRunner = new NoopRunner()) {
  const now = new Date();
  const row: BuildRecord = { id: randomUUID(), projectId: randomUUID(), number: 1, template: 'vue-web', sourceRef: 'snapshot/key',
    triggeredBy: randomUUID(), status, queuedAt: now, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now,
    exitCode: null, errorMessage: null, artifactKey: null, artifactSize: null, artifactSha256: null, logStorageKey: null, runnerInfo: null, diagnosis: null };
  const changes: BuildStatus[] = [];
  const repository = {
    get: vi.fn(async () => ({ ...row })),
    updateStatus: vi.fn(async (_id: string, from: BuildStatus, to: BuildStatus, patch = {}) => {
      if (row.status !== from || !canTransition(from, to)) throw new BuildTransitionError();
      row.status = to;
      Object.assign(row, patch);
      changes.push(to);
      return { ...row };
    }),
  };
  const lines: Array<{ seq: number; content: string }> = [];
  const logs = { append: vi.fn(async (input: { buildId: string; stream: 'stdout' | 'stderr' | 'system'; content: string }) => {
    const result = { ...input, seq: lines.length + 1, ts: new Date() };
    lines.push(result);
    return result;
  }) };
  const processor = new BuildProcessor(repository, logs, runner, 100, 5);
  return { row, changes, lines, logs, repository, processor, run: () => processor.process({ buildId: row.id }, row.id) };
}
const hanging: BuildRunner = { run: vi.fn((_build, _logs, signal) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
})) };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('build processor with guarded repository', () => {
  it('succeeds and persists ordered log chunks', async () => {
    const f = fixture(); await f.run();
    expect(f.changes).toEqual(['running', 'succeeded']);
    expect(f.row.exitCode).toBe(0);
    expect(f.lines.map((line) => line.seq)).toEqual([1, 2, 3]);
  });
  it('maps a nonzero exit code to failed', async () => {
    const f = fixture('queued', { run: async () => ({ exitCode: 17 }) }); await f.run();
    expect(f.row).toMatchObject({ status: 'failed', exitCode: 17 });
  });
  it('persists safe diagnosis with the actual stored sequence on failure', async () => {
    const f = fixture('queued', { run: async (_build, logs) => {
      await logs.write('stdout', 'starting\n');
      await logs.write('stderr', 'src/App.vue error TS2322: token=PLACEHOLDER_TOKEN\n');
      return { exitCode: 2, failureSignals: { phase: 'build' } };
    } });
    await f.run();
    expect(f.row.diagnosis).toEqual({ category: 'compile_error', matchedLogSeqs: [2],
      excerpt: ['src/App.vue error TS2322: token=[REDACTED]'] });
    expect(JSON.stringify(f.lines)).not.toContain('PLACEHOLDER_TOKEN');
    expect(f.repository.updateStatus).toHaveBeenLastCalledWith(f.row.id, 'running', 'failed',
      expect.objectContaining({ diagnosis: f.row.diagnosis }));
  });
  it('uses structured Docker failure codes instead of leaking exception details', async () => {
    const f = fixture('queued', { run: async () => { throw new Error('docker_cli_error'); } });
    await f.run();
    expect(f.row.diagnosis?.category).toBe('runner_unavailable');
  });
  it('persists artifact metadata and runner info with the B07 success transition', async () => {
    const artifact = { key: 'build/artifact', size: 123, sha256: 'a'.repeat(64) };
    const runnerInfo = { runnerId: 'docker-cli', image: 'node:22' };
    const f = fixture('queued', { run: async () => ({ exitCode: 0, artifact, runnerInfo }) });
    await f.run();
    expect(f.repository.updateStatus).toHaveBeenLastCalledWith(f.row.id, 'running', 'succeeded', {
      exitCode: 0, artifactKey: artifact.key, artifactSize: artifact.size, artifactSha256: artifact.sha256, runnerInfo,
    });
  });
  it('records thrown runner failures without leaking the exception', async () => {
    const f = fixture('queued', { run: async () => { throw new Error('secret'); } }); await f.run();
    expect(f.row.errorMessage).toBe('runner_or_control_failure');
    expect(f.row.status).toBe('failed');
    expect(f.row.diagnosis).toEqual({ category: 'unknown', matchedLogSeqs: [], excerpt: [] });
  });
  it('times out and aborts the runner', async () => {
    vi.useFakeTimers(); const f = fixture('queued', hanging); const pending = f.run();
    await vi.advanceTimersByTimeAsync(101); await pending;
    expect(f.changes).toEqual(['running', 'timed_out']);
    expect(f.row.diagnosis?.category).toBe('timeout');
    expect(hanging.run).toHaveBeenCalledOnce();
  });
  it('never runs a canceled queued build', async () => {
    const f = fixture('queued', hanging);
    await f.repository.updateStatus(f.row.id, 'queued', 'canceled'); await f.run();
    expect(f.changes).toEqual(['canceled']); expect(hanging.run).not.toHaveBeenCalled();
  });
  it('aborts a running build when the API persists cancellation', async () => {
    vi.useFakeTimers(); const f = fixture('queued', hanging); const pending = f.run();
    await vi.advanceTimersByTimeAsync(1);
    await f.repository.updateStatus(f.row.id, 'running', 'canceled');
    await vi.advanceTimersByTimeAsync(6); await pending;
    expect(f.changes).toEqual(['running', 'canceled']);
  });
  it.each(['succeeded', 'failed', 'timed_out', 'canceled'] as const)('terminal %s duplicate is a no-op', async (status) => {
    const f = fixture(status, hanging); await f.run(); await f.run();
    expect(f.changes).toEqual([]); expect(hanging.run).not.toHaveBeenCalled();
  });
  it('redelivered running job after restart fails without invoking the runner', async () => {
    const f = fixture('running', hanging); await f.run();
    expect(f.changes).toEqual(['failed']); expect(f.row.errorMessage).toContain('worker_lost');
    expect(hanging.run).not.toHaveBeenCalled();
  });
  it('handles cancellation winning the dequeue race', async () => {
    const f = fixture('queued', hanging);
    f.repository.updateStatus.mockImplementationOnce(async () => { f.row.status = 'canceled'; throw new BuildTransitionError(); });
    await f.run(); expect(hanging.run).not.toHaveBeenCalled();
  });
  it('shutdown aborts active work and marks failed', async () => {
    vi.useFakeTimers(); const f = fixture('queued', hanging); const pending = f.run();
    await vi.advanceTimersByTimeAsync(1); f.processor.shutdown(); await pending;
    expect(f.row.status).toBe('failed');
  });
  it.each(['cancellation', 'timeout', 'shutdown', 'control failure'] as const)(
    'holds the job until runner cleanup settles after %s', async (reason) => {
      vi.useFakeTimers();
      let releaseCleanup!: () => void;
      const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      let signal!: AbortSignal;
      const runner: BuildRunner = { run: vi.fn(async (_build, _logs, abortSignal) => {
        signal = abortSignal;
        try {
          return await new Promise<{ exitCode: number }>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        } finally { await cleanup; }
      }) };
      const f = fixture('queued', runner);
      const released = vi.fn();
      const pending = f.run().then(released);
      try {
        await vi.advanceTimersByTimeAsync(1);
        expect(runner.run).toHaveBeenCalledOnce();
        if (reason === 'cancellation') await f.repository.updateStatus(f.row.id, 'running', 'canceled');
        if (reason === 'shutdown') f.processor.shutdown();
        if (reason === 'control failure') f.repository.get.mockRejectedValueOnce(new Error('database unavailable'));
        await vi.advanceTimersByTimeAsync(reason === 'timeout' ? 100 : 6);
        expect(signal.aborted).toBe(true);
        expect(released).not.toHaveBeenCalled();
      } finally {
        releaseCleanup();
        await pending;
      }
      expect(released).toHaveBeenCalledOnce();
      expect(f.row.status).toBe(reason === 'cancellation' ? 'canceled' : reason === 'timeout' ? 'timed_out' : 'failed');
    });
  it('rejects invalid or mismatched queue messages', async () => {
    const f = fixture();
    await expect(f.processor.process({ buildId: f.row.id, command: 'sh' }, f.row.id)).rejects.toThrow();
    await expect(f.processor.process({ buildId: f.row.id }, randomUUID())).rejects.toThrow('job id');
    expect(f.changes).toEqual([]);
  });
});

describe('worker configuration', () => {
  const env = { DATABASE_URL: 'mysql://u:p@localhost/test', REDIS_URL: 'redis://localhost:6379/15' };
  it('parses defaults and TLS', () => {
    expect(resolveWorkerConfig(env)).toMatchObject({ concurrency: 2, timeoutMs: 600000, connection: { db: 15 } });
    expect(resolveWorkerConfig({ ...env, REDIS_URL: 'rediss://user:pass@localhost/1' }).connection).toMatchObject({ tls: {}, username: 'user' });
  });
  it.each([{ REDIS_URL: '' }, { DATABASE_URL: '' }, { WORKER_CONCURRENCY: '0' }, { BUILD_TIMEOUT_MS: 'NaN' },
    { REDIS_URL: 'http://localhost' }, { REDIS_URL: 'redis://localhost/foo' }])('rejects invalid values %s', (patch) => {
    expect(() => resolveWorkerConfig({ ...env, ...patch })).toThrow();
  });
});
