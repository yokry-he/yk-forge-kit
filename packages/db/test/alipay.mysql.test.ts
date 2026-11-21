import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabaseClient, requireDisposableTestDatabase, projects, users, alipayAudit, alipayConfigs,
  AlipayRepository, AlipayLogRepository, AlipayConflictError, BuildRepository, encryptAlipayKey, decryptAlipayKey } from '../src';
import { AlipayJobInputSchema } from '@forgekit/contracts';
describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('B20 MySQL persistence', () => {
  it('enforces build prerequisites, write-only encrypted config, same-project scope, atomic audit, concurrency and ordered logs', async () => {
    const client = createDatabaseClient(requireDisposableTestDatabase(process.env)), repo = new AlipayRepository(client.db), buildRepo = new BuildRepository(client.db);
    const pid = randomUUID(), other = randomUUID(), actor = randomUUID(), key = randomBytes(32), secret = 'synthetic-b20-upload-key';
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      await client.db.insert(users).values({ id: actor, displayName: 'B20 test' });
      await client.db.insert(projects).values([pid, other].map(id => ({ id, slug: 'b20-' + id, name: 'B20', template: 'uniapp', features: [] })));
      const build = await buildRepo.create({ projectId: pid, template: 'uniapp', sourceRef: 'template:uniapp', triggeredBy: actor, target: 'mp-alipay' });
      const input = AlipayJobInputSchema.parse({ buildId: build.id, version: '1.0.0', action: 'upload_preview' });
      await expect(repo.create(pid, input, actor)).rejects.toBeInstanceOf(AlipayConflictError);
      await expect(repo.save(pid, { appId: '0000000000000000', toolId: 'synthetic-tool' }, undefined, actor)).rejects.toBeInstanceOf(AlipayConflictError);
      const encrypted = encryptAlipayKey(secret, key, pid);
      await repo.save(pid, { appId: '0000000000000000', toolId: 'synthetic-tool' }, encrypted, actor);
      expect(decryptAlipayKey((await repo.config(pid))!.encryptedPrivateKey, key, pid).toString()).toBe(secret);
      await repo.save(pid, { appId: '0000000000000000', toolId: 'synthetic-tool' }, undefined, actor);
      expect((await repo.config(pid))!.encryptedPrivateKey).toBe(encrypted);
      await expect(repo.save(pid, { appId: '1111111111111111', toolId: 'synthetic-tool' }, undefined, actor)).rejects.toBeInstanceOf(AlipayConflictError);
      await expect(repo.save(pid, { appId: '0000000000000000', toolId: 'changed-tool' }, undefined, actor)).rejects.toBeInstanceOf(AlipayConflictError);
      await expect(repo.create(pid, input, actor)).rejects.toBeInstanceOf(AlipayConflictError);
      await buildRepo.updateStatus(build.id, 'queued', 'running');
      await expect(repo.create(pid, input, actor)).rejects.toBeInstanceOf(AlipayConflictError);
      await buildRepo.updateStatus(build.id, 'running', 'succeeded', { artifactKey: 'key', artifactSha256: 'a'.repeat(64) });
      // H5 remains unusable even if succeeded with an artifact.
      const h5 = await buildRepo.create({ projectId: pid, template: 'uniapp', sourceRef: 'template:uniapp', triggeredBy: actor });
      await buildRepo.updateStatus(h5.id, 'queued', 'running'); await buildRepo.updateStatus(h5.id, 'running', 'succeeded', { artifactKey: 'key', artifactSha256: 'a'.repeat(64) });
      await expect(repo.create(pid, { ...input, buildId: h5.id }, actor)).rejects.toBeInstanceOf(AlipayConflictError);
      await repo.save(other, { appId: '0000000000000000', toolId: 'synthetic-tool' }, encryptAlipayKey(secret, key, other), actor);
      await expect(repo.create(other, input, actor)).rejects.toBeInstanceOf(AlipayConflictError);
      const results = await Promise.allSettled([repo.create(pid, input, actor), repo.create(pid, input, actor)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const job = (await repo.list(pid))[0]!;
      await repo.transition(job.id, 'queued', 'running');
      await expect(repo.transition(job.id, 'queued', 'running')).rejects.toBeInstanceOf(AlipayConflictError);
      const logs = new AlipayLogRepository(client.db);
      await Promise.all(['first\n', 'second\n', 'third\n'].map(content => logs.append({ jobId: job.id, stream: 'system', content })));
      expect((await logs.listSince(job.id)).map(row => row.seq)).toEqual([1, 2, 3]); expect(await logs.highestSeq(job.id)).toBe(3);
      await repo.transition(job.id, 'running', 'succeeded', null, 'qr-key');
      expect(await repo.get(job.id)).toMatchObject({ status: 'succeeded', qrArtifactKey: 'qr-key', startedAt: expect.any(Date), finishedAt: expect.any(Date) });
      await expect(repo.transition(job.id, 'running', 'failed')).rejects.toBeInstanceOf(AlipayConflictError);
      const audit = await client.db.select().from(alipayAudit).where(eq(alipayAudit.projectId, pid));
      expect(audit.filter(row => row.action === 'triggered')).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(secret); expect(JSON.stringify(audit)).not.toContain('v1.');
      expect(JSON.stringify(await client.db.select().from(alipayConfigs))).not.toContain(secret);
      await repo.remove(pid, actor); expect(await repo.config(pid)).toBeNull();
    } finally {
      key.fill(0);
      try { await client.db.delete(projects).where(inArray(projects.id, [pid, other])); await client.db.delete(users).where(eq(users.id, actor)); }
      finally { await client.close(); }
    }
  }, 30000);
});
