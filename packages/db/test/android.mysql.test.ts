import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabaseClient, requireDisposableTestDatabase, projects, users, androidAudit,
  AndroidRepository, AndroidLogRepository, AndroidConflictError, encryptAndroidSigning, decryptAndroidSigning } from '../src';
describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('B18 MySQL persistence', () => {
  it('serializes jobs/config, stores large signing envelopes, preserves audit/metadata and honors cancellation CAS', async () => {
    const client = createDatabaseClient(requireDisposableTestDatabase(process.env)), repo = new AndroidRepository(client.db);
    const pid = randomUUID(), actor = randomUUID(), key = randomBytes(32);
    const settings = { packageName: 'com.example.demo', appId: '__UNI__TEST123', appKey: 'synthetic-appkey', versionName: '1.0.0', versionCode: 1 };
    const debug = { buildType: 'debug' as const, kind: 'apk' as const }, release = { buildType: 'release' as const, kind: 'aab' as const };
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      await client.db.insert(users).values({ id: actor, displayName: 'B18 test' });
      await client.db.insert(projects).values({ id: pid, slug: 'b18-' + pid, name: 'B18', template: 'uniapp', features: [] });
      await expect(repo.create(pid, debug, actor)).rejects.toBeInstanceOf(AndroidConflictError);
      await repo.save(pid, settings, undefined, actor);
      await expect(repo.create(pid, release, actor)).rejects.toBeInstanceOf(AndroidConflictError);
      // 64 KiB binary -> Base64 JSON -> authenticated ciphertext exceeds MySQL TEXT's limit.
      const secret = JSON.stringify({ keystore: randomBytes(65536).toString('base64'), alias: 'release', storePassword: 'synthetic-password', keyPassword: 'synthetic-password' });
      const encrypted = encryptAndroidSigning(secret, key, pid);
      expect(encrypted.length).toBeGreaterThan(65535);
      await repo.save(pid, settings, encrypted, actor);
      expect(decryptAndroidSigning((await repo.config(pid))!.encryptedSigning!, key, pid).toString()).toBe(secret);
      await repo.save(pid, { ...settings, versionCode: 2 }, undefined, actor);
      expect((await repo.config(pid))!.encryptedSigning).toBe(encrypted);
      const results = await Promise.allSettled([repo.create(pid, debug, actor), repo.create(pid, debug, actor)]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const job = (await repo.list(pid))[0]!;
      await expect(repo.save(pid, settings, undefined, actor)).rejects.toBeInstanceOf(AndroidConflictError);
      await expect(repo.remove(pid, actor)).rejects.toBeInstanceOf(AndroidConflictError);
      await repo.transition(job.id, 'queued', 'running');
      const logs = new AndroidLogRepository(client.db);
      await Promise.all(['one', 'two', 'three'].map(content => logs.append({ jobId: job.id, stream: 'system', content })));
      expect((await logs.listSince(job.id)).map(r => r.seq)).toEqual([1, 2, 3]);
      await repo.cancel(pid, job.id, actor); expect((await repo.get(job.id))?.status).toBe('running');
      await expect(repo.transition(job.id, 'running', 'succeeded')).rejects.toBeInstanceOf(AndroidConflictError);
      await expect(repo.create(pid, debug, actor)).rejects.toBeInstanceOf(AndroidConflictError);
      await repo.transition(job.id, 'running', 'failed', 'android_aborted');
      const queued = await repo.create(pid, release, actor); await repo.cancel(pid, queued.id, actor);
      await expect(repo.transition(queued.id, 'queued', 'running')).rejects.toBeInstanceOf(AndroidConflictError);
      const success = await repo.create(pid, release, actor); await repo.transition(success.id, 'queued', 'running');
      const artifact = { kind: 'aab' as const, sha256: 'a'.repeat(64), size: 99 };
      await repo.transition(success.id, 'running', 'succeeded', null, 'internal-key', artifact);
      expect(await repo.get(success.id)).toMatchObject({ settings: { ...settings, versionCode: 2 }, input: release, status: 'succeeded', artifact, artifactKey: 'internal-key' });
      const audit = await client.db.select().from(androidAudit).where(eq(androidAudit.projectId, pid));
      expect(audit.filter(r => r.action === 'triggered')).toHaveLength(3);
      expect(JSON.stringify(audit)).not.toMatch(/keystore|synthetic-password|v1\./);
      await repo.save(pid, { ...settings, packageName: 'com.other.demo' }, undefined, actor);
      expect((await repo.config(pid))!.encryptedSigning).toBeNull();
      await repo.remove(pid, actor); expect(await repo.config(pid)).toBeNull();
    } finally {
      key.fill(0);
      try { await client.db.delete(projects).where(eq(projects.id, pid)); await client.db.delete(users).where(eq(users.id, actor)); }
      finally { await client.close(); }
    }
  }, 30000);
});
