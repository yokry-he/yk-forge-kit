import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { describe, expect, it } from 'vitest';
import { RuntimeLogInputSchema, RUNTIME_LOG_LIMITS as limits } from '@forgekit/contracts';
import { createDatabaseClient, requireDisposableTestDatabase, projects, users, deployTargets, domains, runtimeLogSessions,
  RuntimeLogRepository, RuntimeLogLimitError, DeployConflictError, DeployNotFoundError } from '../src/index';

describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('B15 MySQL admission, leases, bounded buffer and retention', () => {
  it('enforces quotas atomically across replicas, prevents double attachment and retains only a short redacted buffer', async () => {
    const client = createDatabaseClient(requireDisposableTestDatabase(process.env));
    const pids = [randomUUID(), randomUUID()], tids = [randomUUID(), randomUUID()], dids = [randomUUID(), randomUUID()];
    const a = new RuntimeLogRepository(client.db), b = new RuntimeLogRepository(client.db), actor = randomUUID();
    const input = RuntimeLogInputSchema.parse({ domainId: dids[0]!.toUpperCase(), source: 'caddy-access' });
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      await client.db.insert(users).values({ id: actor, displayName: 'B15 fixture' });
      for (const [i, pid] of pids.entries()) {
        await client.db.insert(projects).values({ id: pid, slug: 'b15-' + pid, name: 'B15', features: [] });
        await client.db.insert(deployTargets).values({ id: tids[i]!, projectId: pid, kind: 'ssh', name: 'fixture', createdBy: actor, host: '127.0.0.1', port: 22,
          username: 'deploy', basePath: '/srv/forgekit', hostKey: 'ssh-ed25519 fixture', encryptedPrivateKey: 'unused-fixture', currentReleaseId: randomUUID() });
        const hostname = 'site-' + dids[i] + '.b15.test';
        await client.db.insert(domains).values({ id: dids[i]!, projectId: pid, deployTargetId: tids[i]!, hostname, claimedHostname: hostname,
          verificationToken: 'a'.repeat(64), status: 'active', verifiedAt: new Date(), tlsMode: 'internal' });
      }
      await expect(a.create(pids[1]!, actor, input)).rejects.toBeInstanceOf(DeployNotFoundError);
      // Same identity racing through different API replicas cannot bypass its quota of two.
      const admitted = await Promise.allSettled([a.create(pids[0]!, actor, input), b.create(pids[0]!, actor, input), a.create(pids[0]!, actor, input)]);
      expect(admitted.filter(r => r.status === 'fulfilled')).toHaveLength(2);
      expect(admitted.find(r => r.status === 'rejected')).toMatchObject({ reason: expect.any(RuntimeLogLimitError) });
      const rows = admitted.flatMap(r => r.status === 'fulfilled' ? [r.value] : []), row = rows[0]!;
      expect(row.input.domainId).toBe(dids[0]);
      expect(await a.start(row.id)).toBe(true); expect(await b.start(row.id)).toBe(false);
      const owner = randomUUID(), wrong = randomUUID();
      expect(await a.attach(row.id, owner)).toBe(true); expect(await b.attach(row.id, wrong)).toBe(false);
      await b.detach(row.id, wrong); expect((await a.get(row.id))?.status).toBe('running');
      await Promise.all([a.append(row.id, 'safe [REDACTED]\n'), b.append(row.id, 'follow [REDACTED]\n')]);
      expect((await a.listSince(row.id)).map(r => r.seq)).toEqual([1, 2]); expect(await a.highestSeq(row.id)).toBe(2);
      await client.db.update(runtimeLogSessions).set({ bytes: limits.bytes - 1 }).where(eq(runtimeLogSessions.id, row.id));
      await expect(a.append(row.id, 'too large\n')).rejects.toBeInstanceOf(RuntimeLogLimitError);
      expect(await a.highestSeq(row.id)).toBe(2);
      await expect(a.append(row.id, 'x'.repeat(16385))).rejects.toThrow();
      await a.detach(row.id, owner); expect((await a.get(row.id))?.status).toBe('canceled');
      await a.append(row.id, 'late'); expect(await a.highestSeq(row.id)).toBe(2);
      expect(await b.attach(row.id, wrong)).toBe(true);
      await b.touch(row.id, wrong); expect((await b.get(row.id))?.status).toBe('canceled');
      await b.detach(row.id, wrong);
      await a.finish(rows[1]!.id, 'ended');
      // Expired leases no longer reserve quota and must never be revived after replacements are admitted.
      const old = await Promise.all([a.create(pids[0]!, actor, input), b.create(pids[0]!, actor, input)]);
      const oldOwner = randomUUID(), expiredLease = new Date(Date.now() - 1000);
      expect(await a.start(old[1]!.id)).toBe(true);
      expect(await a.attach(old[1]!.id, oldOwner)).toBe(true);
      await client.db.update(runtimeLogSessions).set({ leaseUntil: expiredLease }).where(inArray(runtimeLogSessions.id, old.map(r => r.id)));
      const replacements = await Promise.all([a.create(pids[0]!, actor, input), b.create(pids[0]!, actor, input)]);
      expect(await b.attach(old[0]!.id, randomUUID())).toBe(false);
      expect(await b.attach(old[1]!.id, randomUUID())).toBe(false);
      await b.touch(old[1]!.id, oldOwner);
      const afterRenewal = await Promise.all([...old, ...replacements].map(r => a.get(r.id)));
      expect(afterRenewal.slice(0, 2).every(r => r!.leaseUntil.getTime() === expiredLease.getTime())).toBe(true);
      expect(afterRenewal.filter(r => r!.leaseUntil.getTime() > Date.now())).toHaveLength(2);
      await expect(a.create(pids[0]!, actor, input)).rejects.toBeInstanceOf(RuntimeLogLimitError);
      for (const session of [...old, ...replacements]) await a.finish(session.id, 'ended');
      // Project cap and endpoint cap are independent of the user cap.
      const perProject = await Promise.all([0, 1, 2, 3].map(() => a.create(pids[0]!, randomUUID(), input)));
      await expect(b.create(pids[0]!, randomUUID(), input)).rejects.toBeInstanceOf(RuntimeLogLimitError);
      await expect(b.create(pids[1]!, randomUUID(), { ...input, domainId: dids[1]! })).rejects.toBeInstanceOf(RuntimeLogLimitError);
      for (const session of perProject) await a.finish(session.id, 'ended');
      const expired = await a.create(pids[1]!, randomUUID(), { ...input, domainId: dids[1]! });
      await client.db.update(runtimeLogSessions).set({ expiresAt: new Date(Date.now() - limits.retentionMs - 2000) }).where(eq(runtimeLogSessions.id, expired.id));
      await a.reconcile(); expect(await a.get(expired.id)).toBeNull();
      const lost = await a.create(pids[0]!, randomUUID(), input);
      await client.db.update(runtimeLogSessions).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(runtimeLogSessions.id, lost.id));
      await a.reconcile(); expect((await a.get(lost.id))?.status).toBe('ended');
      await client.db.update(domains).set({ status: 'revoked' }).where(eq(domains.id, dids[0]!));
      await expect(a.create(pids[0]!, actor, input)).rejects.toBeInstanceOf(DeployConflictError);
    } finally {
      try { await client.db.delete(projects).where(inArray(projects.id, pids)); await client.db.delete(users).where(eq(users.id, actor)); }
      finally { await client.close(); }
    }
  }, 30000);
});
