import { createDatabaseClient } from '@forgekit/db';
import { resolveWorkerConfig } from './config';
import { startWorker } from './worker';

async function main() {
  const config = resolveWorkerConfig(process.env);
  const client = createDatabaseClient(config.databaseUrl);
  try {
    const worker = await startWorker(client, config);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void worker.close().finally(() => client.close()).catch(() => {
        console.error('worker_shutdown_failed'); process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) { await client.close(); throw error; }
}
void main().catch(() => { console.error('worker_start_failed: check DATABASE_URL / REDIS_URL and services'); process.exitCode = 1; });
