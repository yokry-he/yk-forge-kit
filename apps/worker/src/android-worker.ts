import { isAbsolute } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { ANDROID_JOB_NAME, ANDROID_QUEUE_NAME, type AndroidJobPayload } from '@forgekit/contracts';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { AndroidConflictError, AndroidLogRepository, AndroidRepository, deployEncryptionKey, type DatabaseClient } from '@forgekit/db';
import { AndroidProcessor } from './android-processor';
import { DockerAndroidRunner, androidDockerArgs } from './android-runner';
import { resolveDockerConfig, type resolveWorkerConfig } from './config';
export function resolveAndroidConfig(env: NodeJS.ProcessEnv) {
  if (!env.FORGEKIT_ANDROID_IMAGE) return null;
  const options = { image: env.FORGEKIT_ANDROID_IMAGE, build: resolveDockerConfig(env, 600000) };
  androidDockerArgs(options, '/tmp/validate', 'validate', 'native', 1000, 1000);
  if (!env.FORGEKIT_ARTIFACT_DIR || !isAbsolute(env.FORGEKIT_ARTIFACT_DIR) || (options.build.workspaceRoot && !isAbsolute(options.build.workspaceRoot))) throw new Error('android_artifact_dir_required');
  return { ...options, artifactDir: env.FORGEKIT_ARTIFACT_DIR };
}
export async function startAndroidWorker(client: DatabaseClient, config: ReturnType<typeof resolveWorkerConfig>, env = process.env,
  log: (event: Record<string, unknown>) => void = event => console.log(JSON.stringify(event))) {
  const options = resolveAndroidConfig(env);
  if (!options) return { close: async () => {} };
  const key = deployEncryptionKey(env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
  const store = new LocalFsArtifactStore(options.artifactDir, 268435456);
  const jobs = new AndroidRepository(client.db);
  const processor = new AndroidProcessor(jobs, new AndroidLogRepository(client.db),
    new DockerAndroidRunner(store, options), key, artifact => store.remove(artifact));
  const queue = new Queue<AndroidJobPayload>(ANDROID_QUEUE_NAME, { connection: { ...config.connection, maxRetriesPerRequest: 1 } });
  const worker = new Worker<AndroidJobPayload>(ANDROID_QUEUE_NAME, job => processor.process(job.data, job.id), {
    connection: { ...config.connection, maxRetriesPerRequest: null }, concurrency: config.concurrency, autorun: false, maxStalledCount: 1,
  });
  worker.on('error', () => log({ event: 'android_worker_error' })); queue.on('error', () => log({ event: 'android_queue_error' }));
  worker.on('failed', job => log({ event: 'android_job_failed', jobId: job?.id }));
  let closing = false, timer: ReturnType<typeof setTimeout> | undefined, task: Promise<void> | undefined;
  const fail = async (id: string, from: 'queued' | 'running', code: string) => {
    try { await jobs.transition(id, from, 'failed', code); }
    catch (error) { if (!(error instanceof AndroidConflictError)) throw error; }
  };
  const reconcile = async () => {
    for (const row of await jobs.stale('queued', new Date(Date.now() - 30000))) {
      const job = await queue.getJob(row.id), state = await job?.getState();
      if (state === 'failed' || state === 'completed') await fail(row.id, 'queued', 'android_queue_ended');
      else if (!job) await queue.add(ANDROID_JOB_NAME, { jobId: row.id }, { jobId: row.id, attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    }
    for (const row of await jobs.stale('running', new Date(Date.now() - 1860000))) {
      const state = await (await queue.getJob(row.id))?.getState();
      if (!state || state === 'failed' || state === 'completed') await fail(row.id, 'running', 'android_worker_lost');
    }
  };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => { await queue.waitUntilReady(); await worker.waitUntilReady(); await reconcile(); })(),
      new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error('android_worker_startup_timeout')), 10000); })]);
  } catch (error) { await Promise.allSettled([worker.close(true), queue.close()]); key.fill(0); throw error; }
  finally { clearTimeout(startupTimer); }
  const running = worker.run().catch(() => log({ event: 'android_worker_run_error' }));
  const schedule = () => { task = reconcile().catch(() => log({ event: 'android_reconcile_failed' })).finally(() => {
    if (!closing) timer = setTimeout(schedule, config.heartbeatMs);
  }); };
  timer = setTimeout(schedule, config.heartbeatMs); log({ event: 'android_worker_ready' });
  return { async close() {
    closing = true; clearTimeout(timer); await worker.pause(true); processor.shutdown(); await task;
    await worker.close(); await running; await queue.close(); key.fill(0);
  } };
}
