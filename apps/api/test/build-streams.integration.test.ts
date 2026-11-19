import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Module, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { and, eq } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { BUILD_QUEUE_NAME } from '@forgekit/contracts';
import { createDatabaseClient, requireDisposableTestDatabase, BuildRepository, BuildLogRepository, projects, users, externalIdentities, projectMemberships } from '@forgekit/db';
import { BuildStreamsController } from '../src/build-streams.controller';
import { BuildStreamsService } from '../src/build-streams.service';
import { BuildStreamTickets } from '../src/build-stream-tickets';
import { BuildsController } from '../src/builds.controller';
import { BuildsService } from '../src/builds.service';
import { BuildQueueService } from '../src/build-queue.service';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { IdentityAccountsService } from '../src/identity-accounts.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
import { startWorker } from '../../worker/src/worker';
import { resolveWorkerConfig } from '../../worker/src/config';
import type { BuildRunner } from '../../worker/src/runner';

/** Real persistence, Redis single-use tickets and two API instances; trusted auth stub only. */
describe.skipIf(process.env.FORGEKIT_WORKER_INTEGRATION !== '1')('B10 real MySQL + Redis SSE', () => {
  it('streams worker persistence across API instances, resumes and revokes membership', async () => {
    const url = new URL(process.env.REDIS_URL ?? '');
    if (url.protocol !== 'redis:' || url.hostname !== '127.0.0.1' || !['6379', '36379'].includes(url.port) || url.pathname !== '/15') throw new Error('B10 集成仅允许回环 Redis 专用 DB 15。');
    const databaseUrl = requireDisposableTestDatabase(process.env);
    const client = createDatabaseClient(databaseUrl);
    const projectId = randomUUID(), ownerId = randomUUID(), viewerId = randomUUID();
    const issuer = 'https://b10.example';
    vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OIDC_ISSUER', issuer); vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api'); vi.stubEnv('OIDC_JWKS_URL', `${issuer}/jwks`);
    const apps: INestApplication[] = [];
    const config = resolveWorkerConfig({ DATABASE_URL: databaseUrl, REDIS_URL: process.env.REDIS_URL, WORKER_HEARTBEAT_MS: '100' });
    const queue = new Queue(BUILD_QUEUE_NAME, { connection: config.connection });
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ids: string[] = [];
    @Module({ controllers: [BuildsController, BuildStreamsController], providers: [
      BuildsService, BuildQueueService, BuildStreamsService, BuildStreamTickets, ProjectsService, IdentityAccountsService, InvitationRateLimiter, ProjectApiGuard,
      { provide: DatabaseService, useValue: { db: client.db } },
      { provide: AuthService, useValue: { authenticate: async (header?: string) => {
        const subject = header?.replace('Bearer ', '');
        if (!subject || ![ownerId, viewerId].includes(subject)) throw new UnauthorizedException();
        return { issuer, subject };
      } } },
    ] }) class TestApp {}
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), '../../packages/db/drizzle') });
      for (const id of [ownerId, viewerId]) {
        await client.db.insert(users).values({ id, displayName: 'B10 integration' });
        await client.db.insert(externalIdentities).values({ userId: id, issuer, subject: id });
      }
      await client.db.insert(projects).values({ id: projectId, slug: `b10-${projectId}`, name: 'B10', features: [] });
      await client.db.insert(projectMemberships).values([{ projectId, userId: ownerId, role: 'owner' }, { projectId, userId: viewerId, role: 'viewer' }]);
      for (let i = 0; i < 2; ++i) {
        const app = await NestFactory.create(TestApp, { logger: false }); apps.push(app); await app.listen(0, '127.0.0.1');
      }
      const bases = await Promise.all(apps.map(async app => `${await app.getUrl()}/api/v1/projects/${projectId}/builds`));
      const first = bases[0]!, second = bases[1]!;
      const headers = (subject: string) => ({ authorization: `Bearer ${subject}`, 'content-type': 'application/json' });
      const trigger = await fetch(first, { method: 'POST', headers: headers(ownerId), body: JSON.stringify({ sourceRef: 'template:vue-web' }) });
      expect(trigger.status).toBe(201); const build = await trigger.json() as { id: string }; ids.push(build.id);
      expect((await fetch(first, { method: 'POST', headers: headers(viewerId), body: JSON.stringify({ sourceRef: 'template:vue-web' }) })).status).toBe(403);
      async function ticket(buildId: string, subject = viewerId) {
        const response = await fetch(`${first}/${buildId}/log-stream-ticket`, { method: 'POST', headers: headers(subject) });
        expect(response.status).toBe(201); return (await response.json() as { ticket: string }).ticket;
      }
      const credential = await ticket(build.id);
      const stream = await fetch(`${second}/${build.id}/logs/stream?ticket=${credential}&after=0`);
      expect(stream.status).toBe(200);
      const textPromise = stream.text();
      const runner: BuildRunner = { run: async (_build, sink, signal) => {
        await sink.write('stdout', 'first\n'); await gate; signal.throwIfAborted();
        await sink.write('stderr', '<script>literal</script>\n'); return { exitCode: 0 };
      } };
      worker = await startWorker(client, config, () => {}, runner);
      await vi.waitFor(async () => expect(await new BuildLogRepository(client.db).highestSeq(build.id)).toBe(1), { timeout: 8000 });
      // Let an API poll observe the running state before allowing terminal transition.
      await new Promise(resolve => setTimeout(resolve, 600)); release();
      const text = await textPromise;
      expect(text).toContain('"status":"running"'); expect(text).toContain('id: 1'); expect(text).toContain('id: 2');
      expect(text).toContain('"stream":"stderr"'); expect(text).toContain('event: end'); expect(text).toContain('"lastSeq":2');
      expect((await fetch(`${first}/${build.id}/logs/stream?ticket=${credential}`)).status).toBe(401);
      const resumed = await fetch(`${second}/${build.id}/logs/stream?ticket=${await ticket(build.id)}&after=0`, { headers: { 'Last-Event-ID': '1' } });
      const resumedText = await resumed.text(); expect(resumedText).not.toContain('id: 1\n'); expect(resumedText).toContain('id: 2\n');
      // A system chunk after terminal belongs to a subsequent snapshot.
      await new BuildLogRepository(client.db).append({ buildId: build.id, stream: 'system', content: 'late cleanup\n' });
      const refresh = await fetch(`${first}/${build.id}/logs/stream?ticket=${await ticket(build.id)}&after=2`);
      expect(await refresh.text()).toContain('"lastSeq":3');
      // Revoke a viewer on an active stream; polling must terminate it with access_revoked.
      const pending = await new BuildRepository(client.db).create({ projectId, triggeredBy: ownerId, template: 'vue-web', sourceRef: 'template:vue-web' }); ids.push(pending.id);
      const revocation = await fetch(`${second}/${pending.id}/logs/stream?ticket=${await ticket(pending.id)}`); const revokedText = revocation.text();
      await client.db.delete(projectMemberships).where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, viewerId)));
      expect(await revokedText).toContain('access_revoked');
      expect((await fetch(`${first}/${pending.id}/log-stream-ticket`, { method: 'POST', headers: headers(viewerId) })).status).toBe(404);
    } finally {
      release(); await worker?.close(); await Promise.all(apps.map(app => app.close()));
      for (const id of ids) await (await queue.getJob(id))?.remove(); await queue.close();
      await client.db.delete(projects).where(eq(projects.id, projectId));
      for (const id of [ownerId, viewerId]) await client.db.delete(users).where(eq(users.id, id));
      await client.close(); vi.unstubAllEnvs();
    }
  }, 20_000);
});
