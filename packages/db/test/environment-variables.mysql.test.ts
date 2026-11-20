import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createDatabaseClient, requireDisposableTestDatabase, projects, users, environments, environmentVariables, variableAudit,
  builds, buildEnvironments, BuildRepository, EnvironmentVariableRepository, encryptVariable, decryptVariable } from '../src/index';

describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('B14 MySQL variables and audit', () => {
  it('serializes concurrent upserts, scopes environment keys, encrypts at rest and atomically audits metadata only', async () => {
    const client = createDatabaseClient(requireDisposableTestDatabase(process.env)), repo = new EnvironmentVariableRepository(client.db);
    const pid = randomUUID(), other = randomUUID(), actor = randomUUID(), key = randomBytes(32), secret = 'b14-mysql-test-secret';
    vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', key.toString('hex'));
    const encrypt = (name: string, projectId = pid) => (value: string, eid: string) => encryptVariable(value, key, projectId, eid, name);
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      await client.db.insert(users).values({ id: actor, displayName: 'B14 test' });
      await client.db.insert(projects).values([pid, other].map(id => ({ id, slug: 'b14-' + id, name: 'B14', features: [] })));
      await Promise.all(Array.from({ length: 4 }, () => repo.save(pid, 'preview', 'TOKEN', { kind: 'secret', value: secret }, actor, encrypt('TOKEN'))));
      expect(await repo.list(pid, 'preview')).toHaveLength(1);
      const [row] = await repo.list(pid, 'preview');
      expect(row!.plainValue).toBeNull(); expect(row!.encryptedValue).not.toContain(secret);
      expect(decryptVariable(row!.encryptedValue!, key, pid, row!.environmentId, 'TOKEN').toString()).toBe(secret);
      await repo.save(pid, 'production', 'TOKEN', { kind: 'plain', value: 'visible-production' }, actor, encrypt('TOKEN'));
      await repo.save(other, 'preview', 'TOKEN', { kind: 'plain', value: 'other-project' }, actor, encrypt('TOKEN', other));
      expect((await repo.list(pid, 'production'))[0]!.plainValue).toBe('visible-production');
      expect(await repo.list(pid, 'empty')).toEqual([]);
      // The database independently enforces unique environment/name and project/environment ownership.
      await expect(client.db.insert(environmentVariables).values(row!)).rejects.toThrow();
      await expect(client.db.insert(environmentVariables).values({ ...row!, projectId: other, name: 'CROSS_PROJECT' })).rejects.toThrow();
      await expect(repo.save(pid, 'preview', 'TOKEN', { kind: 'plain' } as never, actor, encrypt('TOKEN'))).rejects.toThrow();
      expect((await repo.list(pid, 'preview'))[0]!.kind).toBe('secret');
      // Failure after preparing a write rolls back both row and audit.
      const before = await client.db.select().from(variableAudit).where(eq(variableAudit.projectId, pid));
      await expect(repo.save(pid, 'preview', 'TOKEN', { kind: 'secret', value: secret }, actor, () => { throw new Error('encryption_failed'); })).rejects.toThrow();
      expect(await client.db.select().from(variableAudit).where(eq(variableAudit.projectId, pid))).toHaveLength(before.length);
      await repo.save(pid, 'preview', 'TOKEN', { kind: 'plain', value: 'new-visible' }, actor, encrypt('TOKEN'));
      expect((await repo.list(pid, 'preview'))[0]).toMatchObject({ kind: 'plain', plainValue: 'new-visible', encryptedValue: null });
      await repo.save(pid, 'preview', 'TOKEN', { kind: 'secret', value: secret }, actor, encrypt('TOKEN'));
      expect((await repo.list(pid, 'preview'))[0]!.plainValue).toBeNull();
      const buildRepo = new BuildRepository(client.db);
      const build = await buildRepo.create({ projectId: pid, template: 'vue-web', sourceRef: 'template:vue-web', triggeredBy: actor });
      expect(await repo.forBuild(pid, build.id)).toEqual({ values: { TOKEN: secret }, secrets: [secret] });
      const productionBuild = await buildRepo.create({ projectId: pid, template: 'vue-web', sourceRef: 'template:vue-web', triggeredBy: actor }, false, 'production');
      expect((await repo.forBuild(pid, productionBuild.id)).values.TOKEN).toBe('visible-production');
      // Simulate an old build; its preview fallback is recorded and stable.
      await client.db.delete(buildEnvironments).where(eq(buildEnvironments.buildId, build.id));
      await repo.forBuild(pid, build.id);
      expect(await client.db.select().from(buildEnvironments).where(eq(buildEnvironments.buildId, build.id))).toHaveLength(1);
      await repo.remove(pid, 'preview', 'TOKEN', actor);
      expect(await repo.list(pid, 'preview')).toEqual([]);
      const audit = await client.db.select().from(variableAudit).where(eq(variableAudit.projectId, pid)).orderBy(asc(variableAudit.id));
      expect(audit.filter(row => row.action === 'create')).toHaveLength(2);
      expect(audit.some(row => row.action === 'update')).toBe(true); expect(audit.at(-1)!.action).toBe('delete');
      for (const entry of audit) expect(Object.keys(entry).sort()).toEqual(['id', 'projectId', 'environmentId', 'name', 'kind', 'actorUserId', 'action', 'createdAt'].sort());
      expect(JSON.stringify(audit)).not.toContain(secret); expect(JSON.stringify(audit)).not.toContain('v1.');
      expect(audit.every(row => row.actorUserId === actor && row.projectId === pid && row.name === 'TOKEN')).toBe(true);
      expect(await client.db.select().from(environments).where(eq(environments.projectId, pid))).toHaveLength(2);
      expect(await client.db.select().from(builds).where(eq(builds.projectId, pid))).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs(); key.fill(0);
      try { await client.db.delete(projects).where(inArray(projects.id, [pid, other])); await client.db.delete(users).where(eq(users.id, actor)); }
      finally { await client.close(); }
    }
  }, 30000);
});
