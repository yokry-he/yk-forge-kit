import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    const oldMigrations = await mkdtemp(resolve(tmpdir(), 'forgekit-b07-upgrade-'));
    try {
      const [versions] = await connection.query<Array<RowDataPacket & { version: string }>>('SELECT VERSION() AS version');
      expect(versions[0]?.version).toMatch(/^8\.0\./);

      // Stage the pre-B07 journal to exercise upgrading a populated 0000–0007 database.
      const migrationsFolder = resolve(process.cwd(), 'drizzle');
      const journal = JSON.parse(await readFile(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 8);
      await mkdir(resolve(oldMigrations, 'meta'));
      await writeFile(resolve(oldMigrations, 'meta/_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries as Array<{ tag: string }>) {
        await copyFile(resolve(migrationsFolder, `${entry.tag}.sql`), resolve(oldMigrations, `${entry.tag}.sql`));
      }
      await migrate(client.db, { migrationsFolder: oldMigrations });
      const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
      expect(tables.length).toBeGreaterThanOrEqual(9);

      await client.db.insert(projects).values({ id, slug, name: 'MySQL 集成测试', template: 'vue-web', features: [] });
      inserted = true;
      await migrate(client.db, { migrationsFolder });
      await migrate(client.db, { migrationsFolder });
      const [upgradedTables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
      expect(upgradedTables.length).toBeGreaterThanOrEqual(15);
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
        await rm(oldMigrations, { recursive: true, force: true });
        await client.close();
        await connection.end();
      }
    }
  }, 30_000);
});
