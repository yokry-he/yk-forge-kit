import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@forgekit/db';
import { resolveWorkerConfig } from '../src/config';
import { startWorker } from '../src/worker';
import { BuildProcessor } from '../src/processor';
import { DockerBuildRunner } from '../src/docker-runner';

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
vi.mock('../src/domain-worker', () => ({ startDomainWorker: vi.fn(async () => ({ close: async () => {} })) }));
vi.mock('../src/runtime-log-worker', () => ({ startRuntimeLogWorker: vi.fn(async () => ({ close: async () => {} })) }));
vi.mock('../src/weapp-worker', () => ({ startWeappWorker: vi.fn(async () => ({ close: async () => {} })) }));
vi.mock('../src/android-worker', () => ({ startAndroidWorker: vi.fn(async () => ({ close: async () => {} })) }));
vi.mock('../src/alipay-worker', () => ({ startAlipayWorker: vi.fn(async () => ({ close: async () => {} })) }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('worker shutdown', () => {
  it('starts builds in development when the API key exists but deployment storage is unconfigured', async () => {
    vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', 'a'.repeat(64));
    vi.stubEnv('FORGEKIT_ARTIFACT_DIR', undefined);
    const client = { ping: vi.fn(async () => {}), db: {}, close: vi.fn() } as unknown as DatabaseClient;
    const config = resolveWorkerConfig({ DATABASE_URL: 'mysql://u:p@localhost/test', REDIS_URL: 'redis://localhost/15' });
    const log = vi.fn();
    const worker = await startWorker(client, config, log, undefined, { development: true });
    try {
      expect(log).toHaveBeenCalledWith({ event: 'deploy_worker_disabled', reason: 'dev requires FORGEKIT_ARTIFACT_DIR' });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'worker_ready' }));
      expect(client.ping).toHaveBeenCalled();
    } finally { await worker.close(); }
    // The production entry still fails on the same incomplete configuration.
    await expect(startWorker(client, config, log)).rejects.toThrow('deploy_artifact_dir_required');
    // Explicitly invalid development configuration must also fail.
    vi.stubEnv('FORGEKIT_ARTIFACT_DIR', 'relative/path');
    await expect(startWorker(client, config, log, undefined, { development: true })).rejects.toThrow('deploy_artifact_dir_required');
  });
  it('selects Docker from startup config while keeping process creation deferred until a build', async () => {
    const client = { ping: vi.fn(async () => {}), db: {}, close: vi.fn() } as unknown as DatabaseClient;
    const log = vi.fn();
    const worker = await startWorker(client, resolveWorkerConfig({ DATABASE_URL: 'mysql://u:p@localhost/test',
      REDIS_URL: 'redis://localhost/15', FORGEKIT_BUILD_RUNNER: 'docker', FORGEKIT_ARTIFACT_DIR: '/tmp/forgekit-test-artifacts' }), log);
    try {
      expect(vi.mocked(BuildProcessor).mock.calls.at(-1)?.[2]).toBeInstanceOf(DockerBuildRunner);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'worker_ready', runner: 'docker' }));
    } finally { await worker.close(); }
  });
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
