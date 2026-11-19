import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { eq } from 'drizzle-orm';
import { BUILD_QUEUE_NAME } from '@forgekit/contracts';
import { createDatabaseClient, requireDisposableTestDatabase, BuildRepository, BuildLogRepository,
  projects, users, projectMemberships, externalIdentities, buildAudit } from '@forgekit/db';
import { startWorker } from '../../worker/src/worker';
import { resolveWorkerConfig } from '../../worker/src/config';
import type { BuildRunner } from '../../worker/src/runner';
import { BuildQueueService } from '../src/build-queue.service';
import { BuildsService } from '../src/builds.service';
import { ProjectsService } from '../src/projects.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import type { DatabaseService } from '../src/database.service';

// Never flush Redis. Only remove jobs created by this test, in reserved loopback DB 15.
function testRedisUrl(): string {
  const value = process.env.REDIS_URL;
  const url = new URL(value ?? '');
  if (url.protocol !== 'redis:' || !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !['6379', '36379'].includes(url.port) || url.pathname !== '/15' || url.search || url.hash) {
    throw new Error('Worker 集成测试要求回环 Redis 6379/36379 和专用 DB 15。');
  }
  return value!;
}

describe.skipIf(process.env.FORGEKIT_WORKER_INTEGRATION !== '1')('B08 real Redis + MySQL', () => {
  it('triggers via API service, processes to succeeded, persists logs/audit, recovers restart and queued enqueue gaps', async () => {
    const databaseUrl = requireDisposableTestDatabase(process.env);
    const redisUrl = testRedisUrl();
    const client = createDatabaseClient(databaseUrl);
    const config = resolveWorkerConfig({ DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, WORKER_HEARTBEAT_MS: '20' });
    const producer = new BuildQueueService();
    const queue = new Queue(BUILD_QUEUE_NAME, { connection: config.connection });
    const repository = new BuildRepository(client.db);
    const logs = new BuildLogRepository(client.db);
    const projectId = randomUUID(), userId = randomUUID();
    const ids: string[] = [];
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    const auth = { mode: 'oidc' as const, issuer: 'https://b08.example', subject: userId };
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), '../../packages/db/drizzle') });
      await client.db.insert(users).values({ id: userId, displayName: 'B08 integration' });
      await client.db.insert(externalIdentities).values({ userId, issuer: auth.issuer, subject: auth.subject });
      await client.db.insert(projects).values({ id: projectId, slug: `b08-${projectId}`, name: 'B08 test', features: [] });
      await client.db.insert(projectMemberships).values({ projectId, userId, role: 'owner' });
      const database = { db: client.db } as DatabaseService;
      const projectService = new ProjectsService(database);
      const api = new BuildsService(database, projectService, producer, new InvitationRateLimiter(database));
      const build = await api.trigger(projectId, 'snapshots/noop-test', auth);
      ids.push(build.id);
      const events: Record<string, unknown>[] = [];
      worker = await startWorker(client, config, (event) => events.push(event));
      await vi.waitFor(async () => expect((await repository.get(build.id))?.status).toBe('succeeded'), { timeout: 10000, interval: 20 });
      const chunks = await api.logs(projectId, build.id, 0, 100, auth);
      expect(chunks.map((chunk) => chunk.seq)).toEqual([1, 2, 3]);
      expect(chunks.map((chunk) => chunk.content).join('')).toContain('NoopRunner: done');
      const [audit] = await client.db.select().from(buildAudit).where(eq(buildAudit.buildId, build.id));
      expect(audit).toMatchObject({ action: 'triggered', actorUserId: userId });
      expect((await api.list(projectId, {}, auth)).map((row) => row.id)).toContain(build.id);
      expect((await queue.getJob(build.id))?.id).toBe(build.id);
      // Completed duplicate/retry cannot reopen the terminal DB record.
      await producer.enqueue(build.id);
      expect((await repository.get(build.id))?.status).toBe('succeeded');
      await worker.close(); worker = undefined;
      // Model a prior worker's lost execution and the post-commit/pre-enqueue crash window.
      const stale = await repository.create({ projectId, triggeredBy: userId, template: 'vue-web', sourceRef: 'snapshots/stale' });
      ids.push(stale.id);
      await repository.updateStatus(stale.id, 'queued', 'running');
      await producer.enqueue(stale.id);
      // A lost Redis job must also converge to failed after the recovery grace period.
      const lost = await repository.create({ projectId, triggeredBy: userId, template: 'vue-web', sourceRef: 'snapshots/lost' });
      ids.push(lost.id);
      await repository.updateStatus(lost.id, 'queued', 'running');
      const { builds } = await import('@forgekit/db');
      await client.db.update(builds).set({ startedAt: new Date(Date.now() - config.timeoutMs - 61000) }).where(eq(builds.id, lost.id));
      const gap = await repository.create({ projectId, triggeredBy: userId, template: 'vue-web', sourceRef: 'snapshots/gap' });
      ids.push(gap.id);
      // Test-only timestamp adjustment makes the reconciliation grace period elapse.
      await client.db.update(builds).set({ queuedAt: new Date(Date.now() - 60000) }).where(eq(builds.id, gap.id));
      const exhausted = await repository.create({ projectId, triggeredBy: userId, template: 'vue-web', sourceRef: 'snapshots/exhausted' });
      ids.push(exhausted.id);
      await client.db.update(builds).set({ queuedAt: new Date(Date.now() - 60000) }).where(eq(builds.id, exhausted.id));
      // Invalid external message models a permanently failed queue job before queued->running.
      await queue.add('build', { buildId: exhausted.id, unexpected: true }, { jobId: exhausted.id, attempts: 1 });
      worker = await startWorker(client, config, (event) => events.push(event));
      await vi.waitFor(async () => {
        expect((await repository.get(stale.id))?.status).toBe('failed');
        expect((await repository.get(lost.id))?.status).toBe('failed');
        expect((await repository.get(exhausted.id))?.status).toBe('failed');
        expect((await repository.get(gap.id))?.status).toBe('succeeded');
      }, { timeout: 10000, interval: 20 });
      expect(await logs.listSince(stale.id)).toEqual([]);
      await vi.waitFor(() => expect(events.some((event) => event.event === 'worker_heartbeat' && event.status === 'ok')).toBe(true));
      // Audited queued cancellation remains canceled after the consumer sees the job.
      await worker.close(); worker = undefined;
      const canceled = await api.trigger(projectId, 'snapshots/cancel', auth); ids.push(canceled.id);
      await api.cancel(projectId, canceled.id, auth);
      worker = await startWorker(client, config, () => {});
      await vi.waitFor(async () => expect(await (await queue.getJob(canceled.id))?.getState()).toBe('completed'));
      expect((await repository.get(canceled.id))?.status).toBe('canceled');
      const actions = await client.db.select().from(buildAudit).where(eq(buildAudit.buildId, canceled.id));
      expect(actions.map((row) => row.action)).toEqual(['triggered', 'canceled']);
    } finally {
      try {
        await worker?.close();
        await producer.onModuleDestroy();
        for (const id of ids) await (await queue.getJob(id))?.remove();
        await queue.close();
        await client.db.delete(projects).where(eq(projects.id, projectId));
        await client.db.delete(users).where(eq(users.id, userId));
      } finally { await client.close(); }
    }
  }, 40000);

  it('holds active work through runner cleanup and leaves queued jobs untouched while shutdown waits for a heartbeat', async () => {
    const client = createDatabaseClient(requireDisposableTestDatabase(process.env));
    const config = resolveWorkerConfig({ DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: testRedisUrl(),
      WORKER_CONCURRENCY: '1', WORKER_HEARTBEAT_MS: '20' });
    const queue = new Queue(BUILD_QUEUE_NAME, { connection: config.connection });
    const repository = new BuildRepository(client.db);
    const projectId = randomUUID(), userId = randomUUID();
    const ids: string[] = [];
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    let closing: Promise<void> | undefined;
    let releaseCleanup!: () => void;
    let releaseHeartbeat!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const heartbeat = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
    let signal: AbortSignal | undefined;
    const runner: BuildRunner = { run: vi.fn(async (_build, _logs, abortSignal) => {
      signal = abortSignal;
      try {
        return await new Promise<{ exitCode: number }>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        });
      } finally { await cleanup; }
    }) };
    const ping = vi.spyOn(client, 'ping');
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), '../../packages/db/drizzle') });
      await client.db.insert(users).values({ id: userId, displayName: 'B08 shutdown integration' });
      await client.db.insert(projects).values({ id: projectId, slug: `b08-${projectId}`, name: 'B08 shutdown', features: [] });
      const active = await repository.create({ projectId, triggeredBy: userId, template: 'vue-web', sourceRef: 'snapshots/active' });
      const waiting = await repository.create({ projectId, triggeredBy: userId, template: 'vue-web', sourceRef: 'snapshots/waiting' });
      ids.push(active.id, waiting.id);
      await queue.add('build', { buildId: active.id }, { jobId: active.id });
      await queue.add('build', { buildId: waiting.id }, { jobId: waiting.id, attempts: 1 });
      worker = await startWorker(client, config, () => {}, runner);
      let heartbeatStarted = false;
      ping.mockImplementationOnce(() => { heartbeatStarted = true; return heartbeat; });
      await vi.waitFor(() => {
        expect(signal).toBeDefined();
        expect(heartbeatStarted).toBe(true);
      });
      const closed = vi.fn();
      closing = worker.close().then(closed);
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      await vi.waitFor(async () => expect((await repository.get(active.id))?.status).toBe('failed'));
      // Give BullMQ time to complete the job if the processor incorrectly returned before cleanup.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await (await queue.getJob(active.id))?.getState()).toBe('active');
      expect(closed).not.toHaveBeenCalled();

      releaseCleanup();
      await vi.waitFor(async () => expect(await (await queue.getJob(active.id))?.getState()).toBe('completed'));
      expect(runner.run).toHaveBeenCalledOnce();
      const waitingJob = await queue.getJob(waiting.id);
      expect(await waitingJob?.getState()).toBe('waiting');
      expect(waitingJob?.attemptsMade).toBe(0);
      expect((await repository.get(waiting.id))?.status).toBe('queued');
      expect(closed).not.toHaveBeenCalled();

      releaseHeartbeat();
      await closing;
      worker = undefined;
      ping.mockRestore();
      worker = await startWorker(client, config, () => {});
      await vi.waitFor(async () => expect((await repository.get(waiting.id))?.status).toBe('succeeded'));
    } finally {
      releaseCleanup();
      releaseHeartbeat();
      ping.mockRestore();
      try {
        await closing;
        await worker?.close();
        for (const id of ids) await (await queue.getJob(id))?.remove();
        await queue.close();
        await client.db.delete(projects).where(eq(projects.id, projectId));
        await client.db.delete(users).where(eq(users.id, userId));
      } finally { await client.close(); }
    }
  }, 20000);
});
