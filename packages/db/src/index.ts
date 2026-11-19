import { createPool, type Pool } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import * as schema from './schema';
import { validateDatabaseUrl } from './config';

export { validateDatabaseUrl } from './config';
export { requireDisposableTestDatabase } from './integration-guard';
export * from './schema';

export interface DatabaseClient {
  db: ReturnType<typeof createDrizzle>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

function createDrizzle(pool: Pool) {
  return drizzle({ client: pool, schema, mode: 'default' });
}

/** Pool creation is lazy; no network connection is attempted until ping/query. */
export function createDatabaseClient(connectionString: string): DatabaseClient {
  const url = validateDatabaseUrl(connectionString);
  const pool = createPool({ uri: url, connectionLimit: 5, waitForConnections: true, queueLimit: 50, connectTimeout: 3000 });
  return {
    db: createDrizzle(pool),
    async ping() {
      const connection = await pool.getConnection();
      try { await connection.ping(); }
      finally { connection.release(); }
    },
    async close() { await pool.end(); },
  };
}

export * from './build-repository';
