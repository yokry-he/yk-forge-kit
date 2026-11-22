import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { BeginnerRepository, BeginnerKeyRequiredError, createDatabaseClient, requireDisposableTestDatabase,
  users, projects, beginnerAiConfigs, encryptBeginnerKey, decryptBeginnerKey } from '../src';

// Opt-in only; the shared guard rejects databases without explicit disposable-test authorization.
describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('B21 MySQL migration and user configuration', () => {
  it('persists project platforms, isolates user keys, keeps/replaces/deletes atomically and cascades user deletion', async () => {
    const client = createDatabaseClient(requireDisposableTestDatabase(process.env));
    const repo = new BeginnerRepository(client.db), actor = randomUUID(), other = randomUUID(), pid = randomUUID();
    const key = randomBytes(32), secret = 'synthetic-b21-key';
    const settings = { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' };
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      await client.db.insert(users).values([actor, other].map(id => ({ id, displayName: 'B21 test' })));
      await client.db.insert(projects).values({ id: pid, slug: 'b21-' + pid, name: 'B21', template: 'uniapp', features: [], platforms: ['weapp', 'alipay'] });
      const [project] = await client.db.select().from(projects).where(eq(projects.id, pid));
      expect(project!.platforms).toEqual(['weapp', 'alipay']);
      expect(await repo.config(actor)).toBeNull();
      await expect(repo.save(actor, settings)).rejects.toBeInstanceOf(BeginnerKeyRequiredError);
      const first = encryptBeginnerKey(secret, key, actor, settings);
      await repo.save(actor, settings, first);
      expect((await repo.config(actor))!.encryptedApiKey).toBe(first);
      expect(await repo.config(other)).toBeNull();
      const replacement = encryptBeginnerKey(secret, key, actor, settings);
      await Promise.all([repo.save(actor, settings, replacement), repo.save(actor, settings)]);
      const saved = (await repo.config(actor))!;
      expect(saved.encryptedApiKey).toBe(replacement);
      expect(decryptBeginnerKey(saved.encryptedApiKey, key, actor, saved).toString()).toBe(secret);
      expect(() => decryptBeginnerKey(saved.encryptedApiKey, key, other, saved)).toThrow();
      const changed = { ...settings, baseUrl: 'https://other.example.com/v1' };
      await expect(repo.save(actor, changed)).rejects.toBeInstanceOf(BeginnerKeyRequiredError);
      expect((await repo.config(actor))!.encryptedApiKey).toBe(replacement);
      const next = encryptBeginnerKey('replacement-test-key', key, actor, changed);
      await repo.save(actor, changed, next);
      expect(decryptBeginnerKey((await repo.config(actor))!.encryptedApiKey, key, actor, changed).toString()).toBe('replacement-test-key');
      // Keep/delete are serialized by the same owning-user row lock.
      const concurrent = await Promise.allSettled([repo.remove(actor), repo.save(actor, settings)]);
      expect(concurrent[0]!.status).toBe('fulfilled'); expect(await repo.config(actor)).toBeNull();
      await repo.save(other, settings, encryptBeginnerKey(secret, key, other, settings));
      expect(JSON.stringify(await client.db.select().from(beginnerAiConfigs).where(eq(beginnerAiConfigs.userId, other)))).not.toContain(secret);
      await client.db.delete(users).where(eq(users.id, other)); expect(await repo.config(other)).toBeNull();
    } finally {
      key.fill(0);
      try { await client.db.delete(projects).where(eq(projects.id, pid)); await client.db.delete(users).where(inArray(users.id, [actor, other])); }
      finally { await client.close(); }
    }
  }, 30_000);
});
