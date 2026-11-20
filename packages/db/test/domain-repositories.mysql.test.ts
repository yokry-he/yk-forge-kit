import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { describe, expect, it } from 'vitest';
import { createDatabaseClient, requireDisposableTestDatabase, users, projects, deployTargets,
  DomainRepository, DomainClaimError, DeployRepository, DeployConflictError, DomainLogRepository } from '../src/index';

describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('B13 MySQL domain claims and target serialization', () => {
  it('allows unverified duplicates, resolves competing claims atomically, and releases only after remote removal succeeds', async () => {
    const client = createDatabaseClient(requireDisposableTestDatabase(process.env));
    const projectIds = [randomUUID(), randomUUID()], targetIds = [randomUUID(), randomUUID()];
    const hostname = `site-${randomUUID()}.b13.test`;
    const actor = randomUUID();
    const repo = new DomainRepository(client.db), deploys = new DeployRepository(client.db), logs = new DomainLogRepository(client.db);
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      await client.db.insert(users).values({ id: actor, displayName: 'B13 fixture' });
      for (const [index, projectId] of projectIds.entries()) {
        await client.db.insert(projects).values({ id: projectId, slug: 'b13-' + projectId, name: 'B13', features: [] });
        await client.db.insert(deployTargets).values({ id: targetIds[index]!, projectId, kind: 'ssh', name: 'fixture',
          host: '127.0.0.1', username: 'deploy', basePath: '/srv/forgekit', hostKey: 'ssh-ed25519 fixture',
          encryptedPrivateKey: 'unused-test-ciphertext', currentReleaseId: randomUUID(), createdBy: actor });
      }
      const records = await Promise.all(projectIds.map((pid, i) => repo.create(pid, targetIds[i]!, hostname, randomUUID(), 'internal')));
      expect(records.every(row => row.claimedHostname === null)).toBe(true);
      const claims = await Promise.allSettled(records.map(row => repo.claim(row)));
      expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const failure = claims.find(result => result.status === 'rejected');
      expect(failure?.status === 'rejected' && failure.reason).toBeInstanceOf(DomainClaimError);
      const winner = records[claims.findIndex(result => result.status === 'fulfilled')]!;
      const loser = records.find(row => row.id !== winner.id)!;
      const op = await repo.request(winner.projectId, winner.id, 'verify', randomUUID());
      await expect(repo.request(winner.projectId, winner.id, 'remove', randomUUID())).rejects.toBeInstanceOf(DeployConflictError);
      await expect(deploys.removeTarget(winner.projectId, winner.deployTargetId, randomUUID())).rejects.toBeInstanceOf(DeployConflictError);
      expect(await repo.start(op.id)).toBe(true);
      expect(await repo.start(op.id)).toBe(false);
      await Promise.all(['step one\n', 'step two\n'].map(content => logs.append({ operationId: op.id, stream: 'system', content })));
      expect((await logs.listSince(op.id)).map(row => row.seq)).toEqual([1, 2]);
      await repo.finish(op.id, 'failed', { status: 'failed' }, 'domain_reload_failed');
      await expect(repo.claim(loser)).rejects.toBeInstanceOf(DomainClaimError);
      // A failed operation cannot later release its hostname through a stale completion.
      await repo.finish(op.id, 'succeeded', { status: 'revoked' });
      expect((await repo.get(winner.id))?.claimedHostname).toBe(hostname);
      // A temporary observation failure retains eligibility, but must wait a full day.
      const certificateExpiresAt = new Date('2099-12-20T00:00:00Z');
      const certificateFingerprint = 'c'.repeat(64);
      await repo.update(winner.id, { status: 'active', certificateExpiresAt, certificateFingerprint, lastCheckedAt: new Date() });
      const refresh = await repo.request(winner.projectId, winner.id, 'refresh', actor);
      expect(await repo.start(refresh.id)).toBe(true);
      await repo.finish(refresh.id, 'failed', { status: 'failed', lastCheckedAt: new Date() }, 'ssh_command_failed');
      const failed = (await repo.get(winner.id))!;
      expect(failed).toMatchObject({ status: 'failed', claimedHostname: hostname, certificateExpiresAt, certificateFingerprint });
      const day = 86400000;
      expect((await repo.due(new Date(failed.updatedAt.getTime() - day))).map(row => row.id)).not.toContain(winner.id);
      // Even an old lastCheckedAt cannot bypass the failure retry delay.
      await repo.update(winner.id, { lastCheckedAt: new Date(failed.updatedAt.getTime() - 2 * day) });
      expect((await repo.due(new Date(failed.updatedAt.getTime() - day))).map(row => row.id)).not.toContain(winner.id);
      const afterRetry = new Date(Date.now() + 1000);
      expect((await repo.due(afterRetry)).map(row => row.id)).toContain(winner.id);
      const recovery = await repo.request(winner.projectId, winner.id, 'refresh', 'system:certificate-check');
      expect(await repo.start(recovery.id)).toBe(true);
      await repo.finish(recovery.id, 'succeeded', { status: 'active', lastCheckedAt: new Date(), errorCode: null });
      expect((await repo.get(winner.id))?.status).toBe('active');
      const remove = await repo.request(winner.projectId, winner.id, 'remove', randomUUID());
      expect(await repo.start(remove.id)).toBe(true);
      await repo.finish(remove.id, 'succeeded', { status: 'revoked' });
      await repo.claim(loser);
      expect((await repo.get(loser.id))?.claimedHostname).toBe(hostname);
      expect((await repo.due(afterRetry)).map(row => row.id)).not.toContain(winner.id);
      await deploys.removeTarget(winner.projectId, winner.deployTargetId, randomUUID());
      expect((await deploys.target(winner.projectId, winner.deployTargetId))?.disabledAt).not.toBeNull();
    } finally {
      try {
        await client.db.delete(projects).where(inArray(projects.id, projectIds));
        await client.db.delete(users).where(inArray(users.id, [actor]));
      }
      finally { await client.close(); }
    }
  }, 30000);
});
