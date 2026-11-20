import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@forgekit/db';
import { resolveWorkerConfig } from '../src/config';
import { startDomainWorker } from '../src/domain-worker';

const adapters = vi.hoisted(() => ({
  worker: { on: vi.fn(), waitUntilReady: vi.fn(), run: vi.fn(), pause: vi.fn(), close: vi.fn() },
  queue: { on: vi.fn(), waitUntilReady: vi.fn(), getJob: vi.fn(), add: vi.fn(), close: vi.fn() },
  domains: { stale: vi.fn(), due: vi.fn(), request: vi.fn(), finish: vi.fn() },
  logs: { append: vi.fn() }, processor: { process: vi.fn(), shutdown: vi.fn() },
}));
vi.mock('bullmq', () => ({
  Worker: vi.fn(function () { return adapters.worker; }),
  Queue: vi.fn(function () { return adapters.queue; }),
}));
vi.mock('@forgekit/db', async original => ({
  ...await original<typeof import('@forgekit/db')>(),
  DomainRepository: vi.fn(function () { return adapters.domains; }),
  DomainLogRepository: vi.fn(function () { return adapters.logs; }),
}));
vi.mock('../src/domain-processor', () => ({ DomainProcessor: vi.fn(function () { return adapters.processor; }) }));

beforeEach(() => {
  vi.resetAllMocks();
  adapters.worker.run.mockResolvedValue(undefined);
  adapters.domains.stale.mockResolvedValue([]);
  adapters.domains.due.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); });
const client = { db: {} } as unknown as DatabaseClient;
const config = resolveWorkerConfig({ DATABASE_URL: 'mysql://test:test@127.0.0.1/forgekit_test', REDIS_URL: 'redis://127.0.0.1/15', WORKER_HEARTBEAT_MS: '1000' });
const env = { FORGEKIT_DEPLOY_ENCRYPTION_KEY: 'a'.repeat(64) };

describe('domain worker recovery and certificate observations', () => {
  it('recovers pending outbox rows and fails only lost running operations', async () => {
    adapters.domains.stale.mockImplementation(async status => status === 'pending'
      ? [{ id: 'missing' }, { id: 'waiting' }, { id: 'ended' }]
      : [{ id: 'lost' }, { id: 'active' }]);
    adapters.queue.getJob.mockImplementation(async id => id === 'missing' || id === 'lost' ? undefined : {
      getState: async () => id === 'ended' ? 'completed' : id === 'waiting' ? 'waiting' : 'active',
    });
    const worker = await startDomainWorker(client, config, env);
    try {
      expect(adapters.queue.add).toHaveBeenCalledExactlyOnceWith('domain', { operationId: 'missing' }, expect.objectContaining({ jobId: 'missing' }));
      expect(adapters.domains.finish).toHaveBeenCalledWith('ended', 'failed', expect.anything(), 'domain_queue_ended', 'pending');
      expect(adapters.domains.finish).toHaveBeenCalledWith('lost', 'failed', expect.objectContaining({ status: 'failed', lastCheckedAt: expect.any(Date) }), 'domain_worker_lost_check_remote', 'running');
      expect(adapters.domains.finish).toHaveBeenCalledTimes(2);
    } finally { await worker.close(); }
  });
  it('enqueues a daily certificate observation without forcing issuance', async () => {
    adapters.domains.due.mockResolvedValue([{ projectId: 'project', id: 'domain' }]);
    adapters.domains.request.mockResolvedValue({ id: 'observation' });
    const worker = await startDomainWorker(client, config, env);
    try {
      expect(adapters.domains.request).toHaveBeenCalledWith('project', 'domain', 'refresh', 'system:certificate-check');
      expect(adapters.queue.add).toHaveBeenCalledWith('domain', { operationId: 'observation' }, expect.objectContaining({ jobId: 'observation' }));
    } finally { await worker.close(); }
  });
  it('schedules another observation after a lost worker failure and the daily retry delay', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    let failedAt: Date | undefined;
    adapters.domains.stale.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'lost' }]);
    adapters.domains.finish.mockImplementation(async () => { failedAt = new Date(); });
    adapters.domains.due.mockImplementation(async (before: Date) => failedAt && failedAt < before
      ? [{ projectId: 'project', id: 'domain', status: 'failed' }] : []);
    adapters.domains.request.mockResolvedValue({ id: 'recovery' });
    const worker = await startDomainWorker(client, config, env);
    try {
      expect(failedAt).toEqual(new Date());
      await vi.advanceTimersByTimeAsync(1000);
      expect(adapters.domains.request).not.toHaveBeenCalled();
      vi.setSystemTime(new Date('2026-11-21T00:00:01Z'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(adapters.domains.request).toHaveBeenCalledExactlyOnceWith('project', 'domain', 'refresh', 'system:certificate-check');
      expect(adapters.queue.add).toHaveBeenCalledWith('domain', { operationId: 'recovery' }, expect.objectContaining({ jobId: 'recovery' }));
    } finally { await worker.close(); }
  });
  it('pauses intake and aborts the processor before closing connections', async () => {
    const worker = await startDomainWorker(client, config, env);
    await worker.close();
    expect(adapters.worker.pause).toHaveBeenCalledWith(true);
    expect(adapters.processor.shutdown).toHaveBeenCalledOnce();
    expect(adapters.worker.pause.mock.invocationCallOrder[0]).toBeLessThan(adapters.processor.shutdown.mock.invocationCallOrder[0]!);
    expect(adapters.processor.shutdown.mock.invocationCallOrder[0]).toBeLessThan(adapters.worker.close.mock.invocationCallOrder[0]!);
    expect(adapters.queue.close).toHaveBeenCalledOnce();
  });
});
