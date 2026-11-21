import { isAbsolute } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { WEAPP_JOB_NAME, WEAPP_QUEUE_NAME, type WeappJobPayload } from '@forgekit/contracts';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { BuildRepository, WeappConflictError, WeappLogRepository, WeappRepository, deployEncryptionKey, type DatabaseClient } from '@forgekit/db';
import { WeappProcessor } from './weapp-processor';
import { DockerWeappRunner, weappDockerArgs } from './weapp-runner';
import type { resolveWorkerConfig } from './config';
export function resolveWeappConfig(env: NodeJS.ProcessEnv) {
  if (!env.FORGEKIT_WEAPP_IMAGE) return null;
  const options = { image: env.FORGEKIT_WEAPP_IMAGE, network: env.FORGEKIT_WEAPP_NETWORK ?? '', workspaceRoot: env.FORGEKIT_BUILD_WORKSPACE_DIR };
  weappDockerArgs(options, '/tmp/validate', 'validate', 1000, 1000);
  if (!env.FORGEKIT_ARTIFACT_DIR || !isAbsolute(env.FORGEKIT_ARTIFACT_DIR) || (options.workspaceRoot && !isAbsolute(options.workspaceRoot))) throw new Error('weapp_artifact_dir_required');
  return { ...options, artifactDir: env.FORGEKIT_ARTIFACT_DIR };
}
export async function startWeappWorker(client: DatabaseClient, config: ReturnType<typeof resolveWorkerConfig>, env = process.env,
  log: (event: Record<string, unknown>) => void = event => console.log(JSON.stringify(event))) {
  const options = resolveWeappConfig(env);
  if (!options) return { close: async () => {} };
  const key = deployEncryptionKey(env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
  const store = new LocalFsArtifactStore(options.artifactDir);
  const jobs = new WeappRepository(client.db);
  const processor = new WeappProcessor(jobs, new BuildRepository(client.db), new WeappLogRepository(client.db),
    new DockerWeappRunner(store, options), key, artifact => store.remove(artifact));
  const queue = new Queue<WeappJobPayload>(WEAPP_QUEUE_NAME, { connection: { ...config.connection, maxRetriesPerRequest: 1 } });
  const worker = new Worker<WeappJobPayload>(WEAPP_QUEUE_NAME, job => processor.process(job.data, job.id), {
    connection: { ...config.connection, maxRetriesPerRequest: null }, concurrency: config.concurrency, autorun: false, maxStalledCount: 1,
  });
  worker.on('error', () => log({ event: 'weapp_worker_error' })); queue.on('error', () => log({ event: 'weapp_queue_error' }));
  worker.on('failed', job => log({ event: 'weapp_job_failed', jobId: job?.id }));
  let closing = false, timer: ReturnType<typeof setTimeout> | undefined, task: Promise<void> | undefined;
  const fail = async (id: string, from: 'queued' | 'running', code: string) => {
    try { await jobs.transition(id, from, 'failed', code); }
    catch (error) { if (!(error instanceof WeappConflictError)) throw error; }
  };
  const reconcile = async () => {
    for (const row of await jobs.stale('queued', new Date(Date.now() - 30000))) {
      const job = await queue.getJob(row.id), state = await job?.getState();
      if (state === 'failed' || state === 'completed') await fail(row.id, 'queued', 'weapp_queue_ended');
      else if (!job) await queue.add(WEAPP_JOB_NAME, { jobId: row.id }, { jobId: row.id, attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    }
    for (const row of await jobs.stale('running', new Date(Date.now() - 390000))) {
      const state = await (await queue.getJob(row.id))?.getState();
      if (!state || state === 'failed' || state === 'completed') await fail(row.id, 'running', 'weapp_worker_lost_check_mp');
    }
  };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => { await queue.waitUntilReady(); await worker.waitUntilReady(); await reconcile(); })(),
      new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error('weapp_worker_startup_timeout')), 10000); })]);
  } catch (error) { await Promise.allSettled([worker.close(true), queue.close()]); key.fill(0); throw error; }
  finally { clearTimeout(startupTimer); }
  const running = worker.run().catch(() => log({ event: 'weapp_worker_run_error' }));
  const schedule = () => { task = reconcile().catch(() => log({ event: 'weapp_reconcile_failed' })).finally(() => {
    if (!closing) timer = setTimeout(schedule, config.heartbeatMs);
  }); };
  timer = setTimeout(schedule, config.heartbeatMs); log({ event: 'weapp_worker_ready' });
  return { async close() {
    closing = true; clearTimeout(timer); await worker.pause(true); processor.shutdown(); await task;
    await worker.close(); await running; await queue.close(); key.fill(0);
  } };
}
