import { Queue, Worker } from 'bullmq';
import { RUNTIME_LOG_QUEUE_NAME, RUNTIME_LOG_JOB_NAME, type RuntimeLogJob } from '@forgekit/contracts';
import { RuntimeLogRepository, DeployRepository, DomainRepository, EnvironmentVariableRepository, deployEncryptionKey, type DatabaseClient, type ResolvedVariables } from '@forgekit/db';
import { RuntimeLogProcessor } from './runtime-log-processor';
import { SshRuntimeLogHost } from './runtime-log-ssh';
import type { resolveWorkerConfig } from './config';
/** Trusted worker only: current plaintext secrets and their stored ciphertext are both log redactions. */
export async function resolveRuntimeRedactions(variables: Pick<EnvironmentVariableRepository, 'environments' | 'resolve' | 'list'>,
  projectId: string): Promise<ResolvedVariables> {
  const secrets: string[] = [];
  for (const environment of await variables.environments(projectId)) {
    const resolved = await variables.resolve(projectId, environment.id);
    secrets.push(...resolved.secrets);
    for (const row of await variables.list(projectId, environment.name)) {
      if (row.kind === 'secret' && row.encryptedValue) secrets.push(row.encryptedValue);
    }
  }
  return { values: {}, secrets };
}
export async function startRuntimeLogWorker(client: DatabaseClient, config: ReturnType<typeof resolveWorkerConfig>, env = process.env,
  log: (event: Record<string, unknown>) => void = event => console.log(JSON.stringify(event))) {
  if (!env.FORGEKIT_DEPLOY_ENCRYPTION_KEY) return { close: async () => {} };
  const key = deployEncryptionKey(env.FORGEKIT_DEPLOY_ENCRYPTION_KEY), sessions = new RuntimeLogRepository(client.db);
  const variables = new EnvironmentVariableRepository(client.db);
  const processor = new RuntimeLogProcessor(sessions, new DeployRepository(client.db), new DomainRepository(client.db), new SshRuntimeLogHost(key), projectId => resolveRuntimeRedactions(variables, projectId));
  const queue = new Queue<RuntimeLogJob>(RUNTIME_LOG_QUEUE_NAME, { connection: { ...config.connection, maxRetriesPerRequest: 1 } });
  const worker = new Worker<RuntimeLogJob>(RUNTIME_LOG_QUEUE_NAME, job => processor.process(job.data, job.id), {
    connection: { ...config.connection, maxRetriesPerRequest: null }, concurrency: Math.min(config.concurrency, 4), autorun: false, maxStalledCount: 0,
  });
  worker.on('error', () => log({ event: 'runtime_worker_error' })); queue.on('error', () => log({ event: 'runtime_queue_error' }));
  worker.on('failed', () => log({ event: 'runtime_job_failed' }));
  let closing = false, timer: ReturnType<typeof setTimeout> | undefined, task: Promise<void> | undefined;
  const reconcile = async () => {
    for (const row of await sessions.reconcile()) {
      if (!await queue.getJob(row.id)) await queue.add(RUNTIME_LOG_JOB_NAME, { sessionId: row.id }, { jobId: row.id, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
    }
  };
  let startup: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => { await queue.waitUntilReady(); await worker.waitUntilReady(); await reconcile(); })(),
      new Promise<never>((_, reject) => { startup = setTimeout(() => reject(new Error('runtime_worker_startup_timeout')), 10000); })]);
  } catch (error) { await Promise.allSettled([worker.close(true), queue.close()]); key.fill(0); throw error; }
  finally { clearTimeout(startup); }
  const running = worker.run().catch(() => log({ event: 'runtime_worker_run_error' }));
  const schedule = () => { task = reconcile().catch(() => log({ event: 'runtime_reconcile_failed' })).finally(() => {
    if (!closing) timer = setTimeout(schedule, 1000);
  }); };
  timer = setTimeout(schedule, 1000);
  return { async close() {
    closing = true; clearTimeout(timer); await worker.pause(true); processor.shutdown(); await task;
    await worker.close(); await running; await queue.close(); key.fill(0);
  } };
}
