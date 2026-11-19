import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@forgekit/db';
import { resolveWorkerConfig } from '../src/config';
import { startWorker } from '../src/worker';

const adapters = vi.hoisted(() => ({
  worker: {
    on: vi.fn(), waitUntilReady: vi.fn(async () => {}), run: vi.fn(async () => {}),
    isRunning: vi.fn(() => true), pause: vi.fn(async (_doNotWaitActive: boolean) => {}), close: vi.fn(async () => {}),
  },
  queue: {
    on: vi.fn(), waitUntilReady: vi.fn(async () => {}), getJobCounts: vi.fn(async () => ({})), close: vi.fn(async () => {}),
  },
  builds: { listRunningBefore: vi.fn(async () => []), listQueuedBefore: vi.fn(async () => []) },
  processor: { process: vi.fn(async () => {}), shutdown: vi.fn() },
}));
vi.mock('bullmq', () => ({
  Worker: vi.fn(function () { return adapters.worker; }),
  Queue: vi.fn(function () { return adapters.queue; }),
}));
vi.mock('@forgekit/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@forgekit/db')>(),
  BuildRepository: vi.fn(function () { return adapters.builds; }),
  BuildLogRepository: vi.fn(function () { return {}; }),
}));
vi.mock('../src/processor', () => ({ BuildProcessor: vi.fn(function () { return adapters.processor; }) }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('worker shutdown', () => {
  it('pauses intake without waiting for active jobs before stopping the processor during a delayed heartbeat', async () => {
    vi.useFakeTimers();
    let finishHeartbeat!: () => void;
    const heartbeat = new Promise<void>((resolve) => { finishHeartbeat = resolve; });
    const client = { ping: vi.fn(async () => {}), db: {}, close: vi.fn() } as unknown as DatabaseClient;
    const log = vi.fn();
    const worker = await startWorker(client, resolveWorkerConfig({
      DATABASE_URL: 'mysql://u:p@localhost/test', REDIS_URL: 'redis://localhost:6379/15', WORKER_HEARTBEAT_MS: '10',
    }), log);
    vi.mocked(client.ping).mockImplementationOnce(() => heartbeat);
    await vi.advanceTimersByTimeAsync(10);
    expect(client.ping).toHaveBeenCalledTimes(2);

    const closed = vi.fn();
    const closing = worker.close().then(closed);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(adapters.worker.pause).toHaveBeenCalledExactlyOnceWith(true);
      expect(adapters.processor.shutdown).toHaveBeenCalledOnce();
      expect(adapters.worker.pause.mock.invocationCallOrder[0]).toBeLessThan(adapters.processor.shutdown.mock.invocationCallOrder[0]!);
      expect(adapters.worker.close).not.toHaveBeenCalled();
      expect(adapters.queue.close).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
    } finally {
      finishHeartbeat();
      await closing;
    }
    expect(adapters.worker.close).toHaveBeenCalledExactlyOnceWith();
    expect(adapters.queue.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.ping).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.filter(([event]) => event.event === 'worker_heartbeat')).toHaveLength(1);
  });
});
