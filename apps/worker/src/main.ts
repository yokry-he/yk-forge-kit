import { createDatabaseClient } from '@forgekit/db';
import { resolveWorkerConfig } from './config';
import { startWorker } from './worker';
import { reportWorkerStartFailure, workerErrorDetails } from './diagnostics';

export async function main(options: { development?: boolean } = {}) {
  const config = resolveWorkerConfig(process.env);
  const client = createDatabaseClient(config.databaseUrl);
  try {
    const worker = await startWorker(client, config, undefined, undefined, options);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void worker.close().finally(() => client.close()).catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'worker_shutdown_failed', ...workerErrorDetails(error) })); process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    try { await client.close(); }
    catch (closeError) { console.error(JSON.stringify({ event: 'worker_shutdown_failed', ...workerErrorDetails(closeError) })); }
    throw error;
  }
}
if (require.main === module) void main().catch(reportWorkerStartFailure);
