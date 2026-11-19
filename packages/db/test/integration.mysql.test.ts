import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabaseClient, projects } from '../src/index';
import { requireDisposableTestDatabase } from '../src/integration-guard';

// Explicit opt-in. The guard runs before opening any connection or applying DDL.
describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('MySQL 8.0 integration', () => {
  it('migrates a disposable database and verifies persistent CRUD and transactional rollback', async () => {
    const url = requireDisposableTestDatabase(process.env);
    const connection = await createConnection(url);
    const client = createDatabaseClient(url);
    const id = randomUUID();
    const slug = `test-${id}`;
    const rolledBackId = randomUUID();
    let inserted = false;
    try {
      const [versions] = await connection.query<Array<RowDataPacket & { version: string }>>('SELECT VERSION() AS version');
      expect(versions[0]?.version).toMatch(/^8\.0\./);

      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
      expect(tables.length).toBeGreaterThanOrEqual(9);

      await client.db.insert(projects).values({ id, slug, name: 'MySQL 集成测试', template: 'vue-web', features: [] });
      inserted = true;
      const [created] = await client.db.select().from(projects).where(eq(projects.id, id)).limit(1);
      expect(created).toMatchObject({ id, slug, features: [] });

      await expect(client.db.transaction(async (tx) => {
        await tx.insert(projects).values({ id: rolledBackId, slug: `test-${rolledBackId}`, name: '应回滚', features: [] });
        throw new Error('intentional rollback');
      })).rejects.toThrow('intentional rollback');
      const rolledBack = await client.db.select().from(projects).where(eq(projects.id, rolledBackId));
      expect(rolledBack).toHaveLength(0);
    } finally {
      try {
        // Only UUID-tagged fixture records in the explicitly guarded test database.
        if (inserted) await client.db.delete(projects).where(eq(projects.id, id));
      } finally {
        await client.close();
        await connection.end();
      }
    }
  }, 30_000);
});
