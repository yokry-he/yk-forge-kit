import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  createDatabaseClient, requireDisposableTestDatabase, projects, users, builds, buildLogChunks,
  environments, deployTargets, deployments, previewLinks,
  BuildRepository, BuildLogRepository, PreviewLinkRepository, BuildTransitionError, BuildNotFoundError,
} from '../src/index';
import { BuildSchema, BuildLogEventSchema, PreviewLinkSchema, EnvironmentSchema, DeployTargetSchema, DeploymentSchema } from '@forgekit/contracts';

const digest = () => createHash('sha256').update(randomBytes(32)).digest('hex');
function wire<T>(value: T): unknown { return JSON.parse(JSON.stringify(value)); }

describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('B07 MySQL repositories', () => {
  it('does not deadlock on concurrent first writes across different projects and builds', async () => {
    const url = requireDisposableTestDatabase(process.env);
    const clients = [createDatabaseClient(url), createDatabaseClient(url)];
    const client = clients[0]!;
    const repositories = clients.map(({ db }) => new BuildRepository(db));
    const logRepositories = clients.map(({ db }) => new BuildLogRepository(db));
    const userId = randomUUID();
    const projectIds = Array.from({ length: 20 }, () => randomUUID());
    // Wait for every writer, including failures, before assertions or fixture cleanup.
    async function successful<T>(writes: Promise<T>[]): Promise<T[]> {
      const results = await Promise.allSettled(writes);
      expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
      return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    }
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      await client.db.insert(users).values({ id: userId, displayName: '跨父记录并发测试' });
      await client.db.insert(projects).values(projectIds.map((id) => ({
        id, slug: `b07-cross-parent-${id}`, name: 'Cross-parent concurrency', features: [],
      })));
      for (let number = 1; number <= 3; number++) {
        // All parents are different: parent-row locks alone cannot prevent shared gap deadlocks.
        const created = await successful(projectIds.map((projectId, index) => repositories[index % 2]!.create({
          projectId, triggeredBy: userId, template: 'vue-web', sourceRef: `sources/cross-parent-${number}.tar`,
        })));
        expect(created.map((build) => build.number)).toEqual(projectIds.map(() => number));
        for (let seq = 1; seq <= 2; seq++) {
          const chunks = await successful(created.map((build, index) => logRepositories[index % 2]!.append({
            buildId: build.id, stream: 'stdout', content: `chunk ${seq}`,
          })));
          expect(chunks.map((chunk) => chunk.seq)).toEqual(created.map(() => seq));
        }
        for (const build of created) {
          expect((await logRepositories[0]!.listSince(build.id)).map((chunk) => chunk.seq)).toEqual([1, 2]);
        }
      }
      for (const projectId of projectIds) {
        expect((await repositories[0]!.listByProject(projectId)).map((build) => build.number)).toEqual([3, 2, 1]);
      }
    } finally {
      try {
        await client.db.delete(projects).where(inArray(projects.id, projectIds));
        await client.db.delete(users).where(eq(users.id, userId));
      } finally { await Promise.all(clients.map((client) => client.close())); }
    }
  }, 60_000);

  it('serializes build numbers, status updates and logs; enforces preview lifecycle and project FKs', async () => {
    const url = requireDisposableTestDatabase(process.env);
    const client = createDatabaseClient(url);
    // A second pool proves numbering/state safety is in MySQL rather than a process-local mutex.
    const other = createDatabaseClient(url);
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const userId = randomUUID();
    const repository = new BuildRepository(client.db);
    const competing = new BuildRepository(other.db);
    const logs = new BuildLogRepository(client.db);
    const otherLogs = new BuildLogRepository(other.db);
    const links = new PreviewLinkRepository(client.db);
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      await client.db.insert(users).values({ id: userId, displayName: 'B07 测试用户' });
      await client.db.insert(projects).values([
        { id: projectId, slug: `b07-${projectId}`, name: 'B07', features: [] },
        { id: otherProjectId, slug: `b07-${otherProjectId}`, name: 'B07 other', features: [] },
      ]);
      const input = { projectId, template: 'vue-web', sourceRef: 'sources/snapshot-1.tar', triggeredBy: userId };
      const created = await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? repository : competing).create(input)));
      expect(created.map((b) => b.number).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, n) => n + 1));
      const first = created.find((b) => b.number === 1)!;
      const isolated = await repository.create({ ...input, projectId: otherProjectId });
      expect(isolated.number).toBe(1);
      expect(await repository.get(first.id)).toMatchObject({ number: 1, status: 'queued', startedAt: null, finishedAt: null });
      expect(BuildSchema.parse(wire(first)).id).toBe(first.id);
      expect(await repository.get(randomUUID())).toBeNull();
      expect((await repository.listByProject(projectId, { limit: 3 })).map((b) => b.number)).toEqual([12, 11, 10]);
      expect((await repository.listByProject(projectId, { beforeNumber: 10, limit: 2 })).map((b) => b.number)).toEqual([9, 8]);
      expect(await repository.listByProject(randomUUID())).toEqual([]);
      await expect(repository.create({ ...input, projectId: randomUUID() })).rejects.toBeInstanceOf(BuildNotFoundError);
      await expect(client.db.insert(builds).values({ ...first, id: randomUUID() })).rejects.toThrow();
      await expect(repository.create({ ...input, triggeredBy: randomUUID() })).rejects.toThrow();
      // A failed insert rolls back number allocation.
      expect((await repository.create(input)).number).toBe(13);

      await expect(repository.updateStatus(first.id, 'queued', 'succeeded')).rejects.toBeInstanceOf(BuildTransitionError);
      const raced = await Promise.allSettled([
        repository.updateStatus(first.id, 'queued', 'running', { runnerInfo: { runnerId: 'worker-1', image: 'runner:test' } }),
        competing.updateStatus(first.id, 'queued', 'canceled'),
      ]);
      expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(raced.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const racedRow = (await repository.get(first.id))!;
      expect(racedRow.status === 'running' ? racedRow.startedAt : racedRow.finishedAt).toBeInstanceOf(Date);
      const running = await repository.create(input);
      await repository.updateStatus(running.id, 'queued', 'running', { runnerInfo: { runnerId: 'worker-2', image: 'runner:test' } });
      const succeeded = await repository.updateStatus(running.id, 'running', 'succeeded', {
        runnerInfo: undefined, exitCode: 0, artifactKey: 'artifacts/site.tar', artifactSize: 42, artifactSha256: 'a'.repeat(64), logStorageKey: 'logs/archive.txt',
      });
      expect(succeeded.runnerInfo).toEqual({ runnerId: 'worker-2', image: 'runner:test' });
      expect(succeeded.startedAt).toBeInstanceOf(Date);
      expect(succeeded.finishedAt!.getTime()).toBeGreaterThanOrEqual(succeeded.startedAt!.getTime());
      expect(await repository.get(running.id)).toMatchObject({ status: 'succeeded', exitCode: 0, artifactSize: 42 });
      expect(BuildSchema.parse(wire(succeeded)).artifactSha256).toBe('a'.repeat(64));
      await expect(repository.updateStatus(running.id, 'succeeded', 'running')).rejects.toBeInstanceOf(BuildTransitionError);
      await expect(repository.updateStatus(randomUUID(), 'queued', 'running')).rejects.toBeInstanceOf(BuildNotFoundError);
      await expect(repository.updateStatus(first.id, 'queued', 'failed', { artifactSize: -1 })).rejects.toThrow();
      await expect(repository.updateStatus(first.id, 'queued', 'failed', { status: 'succeeded' } as never)).rejects.toThrow();
      const timedOut = await repository.create(input);
      await repository.updateStatus(timedOut.id, 'queued', 'running');
      await repository.updateStatus(timedOut.id, 'running', 'timed_out', { exitCode: 137, errorMessage: '超时' });
      expect(await repository.get(timedOut.id)).toMatchObject({ status: 'timed_out', exitCode: 137, errorMessage: '超时' });
      const failed = await repository.create(input);
      await repository.updateStatus(failed.id, 'queued', 'failed', { errorMessage: '调度失败' });
      expect(await repository.get(failed.id)).toMatchObject({ startedAt: null, status: 'failed', errorMessage: '调度失败' });

      const chunks = await Promise.all(Array.from({ length: 10 }, (_, n) => (n % 2 ? logs : otherLogs).append({
        buildId: running.id, stream: n % 3 === 0 ? 'stderr' : n % 3 === 1 ? 'stdout' : 'system', content: `输出 ${n}\n`,
      })));
      expect(chunks.map((c) => c.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(BuildLogEventSchema.parse(wire(chunks[0])).seq).toBeGreaterThan(0);
      const resumed = await logs.listSince(running.id, 4, 3);
      expect(resumed.map((c) => c.seq)).toEqual([5, 6, 7]);
      expect((await logs.listSince(running.id, 7)).map((c) => c.seq)).toEqual([8, 9, 10]);
      expect(await logs.listSince(isolated.id)).toEqual([]);
      await expect(logs.append({ buildId: randomUUID(), stream: 'system', content: 'missing' })).rejects.toBeInstanceOf(BuildNotFoundError);
      await expect(logs.append({ buildId: running.id, stream: 'stdout', content: '中'.repeat(6000) })).rejects.toThrow();
      await expect(logs.listSince(running.id, -1)).rejects.toThrow();
      await expect(repository.listByProject(projectId, { limit: 1001 })).rejects.toThrow();
      await expect(client.db.insert(buildLogChunks).values(chunks[0]!)).rejects.toThrow();

      for (const ttlSeconds of [300, 604800]) {
        const bounded = await links.create({ buildId: running.id, createdBy: userId, tokenHash: digest(), ttlSeconds });
        expect(bounded.expiresAt.getTime() - bounded.createdAt.getTime()).toBe(ttlSeconds * 1000);
      }
      const hash = digest();
      const link = await links.create({ buildId: running.id, createdBy: userId, tokenHash: hash });
      expect(PreviewLinkSchema.parse(wire(link)).id).toBe(link.id);
      expect(link.expiresAt.getTime() - link.createdAt.getTime()).toBe(86400000);
      expect(await links.findValidByHash(hash)).toEqual(link);
      expect(link).not.toHaveProperty('tokenHash');
      const [persisted] = await client.db.select().from(previewLinks).where(eq(previewLinks.id, link.id));
      expect(persisted!.tokenHash).toBe(hash);
      expect(persisted).not.toHaveProperty('token');
      await expect(links.create({ buildId: running.id, createdBy: userId, tokenHash: hash })).rejects.toThrow();
      await expect(links.create({ buildId: randomUUID(), createdBy: userId, tokenHash: digest() })).rejects.toThrow();
      for (const ttlSeconds of [299, 604801]) {
        await expect(links.create({ buildId: running.id, createdBy: userId, tokenHash: digest(), ttlSeconds })).rejects.toThrow();
      }
      await expect(links.findValidByHash('raw-token')).rejects.toThrow();
      expect(await links.recordAccess(link.id)).toBe(true);
      expect((await links.findValidByHash(hash))!.lastAccessedAt).toBeInstanceOf(Date);
      expect(await links.revoke(isolated.id, link.id)).toBe(false);
      expect(await links.revoke(running.id, link.id)).toBe(true);
      expect(await links.revoke(running.id, link.id)).toBe(false);
      expect(await links.findValidByHash(hash)).toBeNull();
      expect(await links.recordAccess(link.id)).toBe(false);
      const expiredHash = digest();
      const expiring = await links.create({ buildId: running.id, createdBy: userId, tokenHash: expiredHash, ttlSeconds: 300 });
      await client.db.update(previewLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(previewLinks.id, expiring.id));
      expect(await links.findValidByHash(expiredHash)).toBeNull();
      expect(await links.recordAccess(expiring.id)).toBe(false);
      expect(await links.findValidByHash(digest())).toBeNull();

      const environment = { id: randomUUID(), projectId, name: 'preview' };
      const target = { id: randomUUID(), projectId, name: 'web', createdBy: userId };
      const foreignEnvironment = { id: randomUUID(), projectId: otherProjectId, name: 'production' };
      const foreignTarget = { ...target, id: randomUUID(), projectId: otherProjectId };
      await client.db.insert(environments).values([environment, foreignEnvironment]);
      await client.db.insert(deployTargets).values([target, foreignTarget]);
      const [env] = await client.db.select().from(environments).where(eq(environments.id, environment.id));
      expect(EnvironmentSchema.parse(wire(env)).name).toBe('preview');
      const [host] = await client.db.select().from(deployTargets).where(eq(deployTargets.id, target.id));
      expect(DeployTargetSchema.parse(wire(host)).host).toBeNull();
      await expect(client.db.insert(environments).values({ ...environment, id: randomUUID() })).rejects.toThrow();
      const deployment = { id: randomUUID(), projectId, buildId: running.id, environmentId: environment.id, deployTargetId: target.id };
      await client.db.insert(deployments).values(deployment);
      const [dep] = await client.db.select().from(deployments).where(eq(deployments.id, deployment.id));
      expect(DeploymentSchema.parse(wire(dep)).status).toBe('pending');
      for (const patch of [{ buildId: isolated.id }, { environmentId: foreignEnvironment.id }, { deployTargetId: foreignTarget.id }]) {
        await expect(client.db.insert(deployments).values({ ...deployment, ...patch, id: randomUUID() })).rejects.toThrow();
      }
      // Replaying migrations preserves pre-existing build/log/link data.
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      expect(await repository.get(running.id)).toMatchObject({ status: 'succeeded', artifactSize: 42 });
      expect(await logs.listSince(running.id)).toHaveLength(10);
      // Project cascade removes all B07 children, including composite deployment relations.
      await client.db.delete(projects).where(eq(projects.id, projectId));
      expect(await repository.get(running.id)).toBeNull();
      expect(await logs.listSince(running.id)).toEqual([]);
      expect(await client.db.select().from(previewLinks).where(eq(previewLinks.id, link.id))).toEqual([]);
      expect(await client.db.select().from(deployments).where(eq(deployments.id, deployment.id))).toEqual([]);
    } finally {
      try {
        await client.db.delete(projects).where(inArray(projects.id, [projectId, otherProjectId]));
        await client.db.delete(users).where(eq(users.id, userId));
      } finally { await Promise.all([client.close(), other.close()]); }
    }
  }, 60_000);
});
